// Pilot administrators on PostgreSQL, as the operator's provision-pilot
// command manages them: the first administrator with the workspace, and
// running that again (unchanged, never a duplicate-key failure, also when two
// runs race); another administrator; renewal of an administrator whose access
// is active or has ended, each with its staff event; and the refusals: another
// person as a "first" administrator, a non-administrator, a suspended or
// revoked membership (never restored this way) and an organisation not yet
// provisioned. The command itself runs twice against the same organisation.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";

if (process.env.VALO_PAY_1_RUN_INTEGRATION !== "1") {
  console.log("Set VALO_PAY_1_RUN_INTEGRATION=1 to run the pilot administrator integration test.");
  process.exit(0);
}
process.env.VALO_PAY_1_STAFF_ACCESS = "staging";
const { pool } = await import("@workspace/valo-pay-1-db");
const { provisionStaffWorkspace, addStaffAdministrator, renewStaffAdministrator } = await import("../src/lib/valo-pay-1-store.js");

const id = () => randomBytes(6).toString("hex");
const organisation = `org_Synthetic${id()}`, first = `user_First${id()}`, second = `user_Second${id()}`;
const DAY = 24 * 60 * 60 * 1000;
const databaseNow = async () => Date.parse((await pool.query<{ now: Date }>("SELECT now() AS now")).rows[0]!.now.toISOString());
const membership = async (userId: string) => (await pool.query<{ id: string; role: string; status: string; expires_at: Date; updated_at: Date }>("SELECT m.id,m.role,m.status,m.expires_at,m.updated_at FROM valopay_staff_memberships m JOIN valopay_teams t ON t.workspace_id=m.workspace_id WHERE t.organization_id=$1 AND m.user_id=$2", [organisation, userId])).rows[0];
const events = async () => (await pool.query<{ action: string; actor: string; subject: string; detail: Record<string, any> }>("SELECT e.action,e.actor,e.subject,e.detail FROM valopay_staff_events e JOIN valopay_teams t ON t.workspace_id=e.workspace_id WHERE t.organization_id=$1 ORDER BY e.created_at,e.id", [organisation])).rows;
const refused = async (change: () => Promise<unknown>, status: number, message: RegExp) => {
  await assert.rejects(change, (error: { status?: number; message: string; code?: string }) => {
    assert.equal(error.status, status, error.message);
    assert.match(error.message, message);
    assert.equal(error.code, undefined, "a refusal, never a database error");
    return true;
  });
};
let checks = 0;

try {
  // The first administrator, for 90 days, and the command run again: nothing changes and it says so.
  const provisioned = await provisionStaffWorkspace(organisation, first, "Synthetic pilot workspace");
  assert.equal(provisioned.outcome, "provisioned");
  const now = await databaseNow();
  assert.ok(Math.abs(Date.parse(provisioned.expiresAt) - (now + 90 * DAY)) < 60_000, "the first administrator lasts 90 days");
  const again = await provisionStaffWorkspace(organisation, first, "Synthetic pilot workspace");
  assert.deepEqual([again.outcome, again.workspaceId, again.expiresAt], ["unchanged", provisioned.workspaceId, provisioned.expiresAt]);
  assert.match(again.message, /^Already provisioned, so nothing changed: this person is an administrator until /);
  assert.equal((await pool.query("SELECT 1 FROM valopay_teams WHERE organization_id=$1", [organisation])).rowCount, 1);
  checks += 5;
  // Another person cannot be a second "first" administrator: that is what --add-administrator is for.
  await refused(() => provisionStaffWorkspace(organisation, second, "Synthetic pilot workspace"), 409, /already provisioned, with another first administrator\. Add this person with --add-administrator/);
  checks += 1;

  // A second administrator, and running that again.
  const added = await addStaffAdministrator(organisation, second, "Second synthetic administrator");
  assert.equal(added.outcome, "added");
  assert.equal((await membership(second))?.role, "Admin");
  assert.equal((await addStaffAdministrator(organisation, second, "Second synthetic administrator")).outcome, "unchanged");
  checks += 3;

  // Renewal of an active administrator: 90 days from now, a new version, and a staff event.
  const firstBefore = (await membership(first))!;
  await pool.query("UPDATE valopay_staff_memberships SET expires_at = now() + interval '5 days' WHERE id=$1", [firstBefore.id]);
  const renewed = await renewStaffAdministrator(organisation, first);
  assert.equal(renewed.outcome, "renewed");
  assert.ok(Date.parse(renewed.expiresAt) - (await databaseNow()) > 89 * DAY);
  assert.match(renewed.message, /^Renewed: this administrator's access now lasts until /);
  assert.ok((await membership(first))!.updated_at > firstBefore.updated_at, "the membership's version moves, so an open edit of it is refused as stale");
  checks += 4;
  // Renewal after the access has ended restores it; nobody else could have.
  await pool.query("UPDATE valopay_staff_memberships SET expires_at = now() - interval '1 day' WHERE id=$1", [(await membership(second))!.id]);
  await refused(() => addStaffAdministrator(organisation, second, "Second synthetic administrator"), 409, /access ended on .* Renew it with --renew\./);
  const restored = await renewStaffAdministrator(organisation, second);
  assert.match(restored.message, /^Renewed: this administrator's access is restored and lasts until /);
  assert.ok(Date.parse(restored.expiresAt) - (await databaseNow()) > 89 * DAY);
  assert.ok(Date.parse(restored.previousExpiresAt!) < (await databaseNow()));
  checks += 4;

  // The refusals: a non-administrator, a suspended or revoked administrator (never restored this way), an unknown person or organisation.
  const worker = `user_Worker${id()}`;
  await pool.query("INSERT INTO valopay_staff_memberships(id,workspace_id,user_id,display_name,role,expires_at) VALUES($1,$2,$3,'Synthetic worker','Finance',now()+interval '30 days')", [`member-${id()}`, provisioned.workspaceId, worker]);
  await refused(() => renewStaffAdministrator(organisation, worker), 409, /^Renewal is for administrators, and this membership is Finance\./);
  await refused(() => addStaffAdministrator(organisation, worker, "Synthetic worker"), 409, /^This person is already a Finance member\./);
  for (const status of ["suspended", "revoked"]) {
    await pool.query("UPDATE valopay_staff_memberships SET status=$2 WHERE id=$1", [(await membership(second))!.id, status]);
    await refused(() => renewStaffAdministrator(organisation, second), 409, new RegExp(`membership is ${status}, and renewal never restores it`));
    await refused(() => addStaffAdministrator(organisation, second, "Second synthetic administrator"), 409, new RegExp(`membership is ${status}, and adding an administrator never restores it`));
    assert.equal((await membership(second))!.status, status, "nothing changed");
  }
  await refused(() => renewStaffAdministrator(organisation, `user_Nobody${id()}`), 404, /has no membership/);
  await refused(() => renewStaffAdministrator(`org_Nobody${id()}`, first), 404, /has not been provisioned yet/);
  await refused(() => addStaffAdministrator(`org_Nobody${id()}`, second, "Anyone"), 404, /has not been provisioned yet/);
  checks += 11;

  // Every change is in the access history, by the operator.
  const history = await events();
  assert.deepEqual(history.map((event) => event.action), ["staff.provisioned", "staff.administrator_added", "staff.renewed", "staff.renewed"]);
  assert.ok(history.every((event) => event.actor === "System · operator provisioning"));
  assert.deepEqual([history[2]!.detail.userId, history[2]!.detail.ended, history[3]!.detail.userId, history[3]!.detail.ended], [first, false, second, true]);
  checks += 3;

  // Two runs for a new organisation at once: one provisions, the other waits and reports it unchanged.
  const racing = `org_Race${id()}`, racer = `user_Race${id()}`;
  const outcomes = (await Promise.all([0, 1].map(() => provisionStaffWorkspace(racing, racer, "Racing workspace")))).map((result) => result.outcome).sort();
  assert.deepEqual(outcomes, ["provisioned", "unchanged"]);
  checks += 1;

  // The command, as an operator runs it, twice: the second run says where things stand and exits 0, with no stack.
  const root = path.resolve(import.meta.dirname, "..", "..", "..");
  const commandOrganisation = `org_Command${id()}`, commandUser = `user_Command${id()}`;
  const provision = () => spawnSync(process.execPath, [path.join(root, "scripts", "node_modules", "tsx", "dist", "cli.mjs"), "scripts/provision-pilot.ts", "--synthetic-staging", commandOrganisation, commandUser, "Command workspace"], { cwd: root, env: { ...process.env, VALO_PAY_1_STAFF_ACCESS: "staging" }, encoding: "utf8", timeout: 60_000 });
  for (const outcome of ["provisioned", "unchanged"]) {
    const run = provision();
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).outcome, outcome);
    assert.doesNotMatch(run.stderr, /duplicate key|\n\s+at /);
    checks += 3;
  }
  console.log(`Pilot administrator integration passed (${checks} checks): provisioning run again is unchanged (also when two runs race), a second administrator, renewal of active and ended administrators with their staff events, and refusals for other roles, suspended or revoked memberships and unknown people or organisations.`);
} finally {
  await pool.end();
}
