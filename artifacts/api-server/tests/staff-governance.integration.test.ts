// The governance decisions of the 23 September 2026 audit, on PostgreSQL through the real routes, in staff mode:
// a second administrator approves every grant of Admin, Finance or Compliance reviewer (invitations and role
// changes), and the operator adds that second administrator to a pilot that has one; the team directory shows a
// person who is not an administrator only the colleagues who share a lender with them; dispute packs, customer
// records and the audit trail are queued and downloaded only by Admin, Finance and Compliance reviewer; turning
// the emergency stop off needs a second administrator; a retention run's preparer cannot approve it and a policy
// keeps the staff minimums; a fortnightly review names the person who records it, at the service's time, and only
// Admin and Operations maintain the business calendar.
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

if (process.env.VALOPAY_RUN_INTEGRATION !== "1") { console.log("Opt in on a disposable PostgreSQL database to test staff governance."); process.exit(0); }
// Only Clerk's verified-email lookup is replaced below; no external call is made.
const saved = Object.fromEntries(["CLERK_SECRET_KEY", "VALOPAY_STAFF_ACCESS", "VALOPAY_STAFF_ISSUER", "VALOPAY_STAFF_ORIGINS", "PRIVATE_OBJECT_DIR"].map(name => [name, process.env[name]]));
Object.assign(process.env, { CLERK_SECRET_KEY: "sk_test_placeholder", VALOPAY_STAFF_ACCESS: "staging", VALOPAY_STAFF_ISSUER: "https://identity.example", VALOPAY_STAFF_ORIGINS: "https://pilot.example", PRIVATE_OBJECT_DIR: "/private-bucket/valopay" });
const { pool } = await import("@workspace/db"), store = await import("../src/lib/valopay-store"), { default: router } = await import("../src/routes/index"), { errorHandler } = await import("../src/lib/error-handler");
const { clerkClient } = await import("@clerk/express"), savedGetUser = clerkClient.users.getUser;
const identities = new Map<string, any>(), app = express();
app.use(express.json());
app.use((req, _res, next) => { (req as any).auth = Object.assign(() => identities.get(String(req.header("X-Test-Identity"))) || { userId: null }, { [Symbol.for("@clerk/express.auth")]: true }); (req as any).log = { info() {}, error() {}, warn() {} }; next(); });
app.use("/api", router); app.use(errorHandler);
const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as any).port}/api`, owned: string[] = [];
async function call(path: string, who: string, method = "GET", body?: unknown, key = randomUUID()) { const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-Test-Identity": who, "Idempotency-Key": key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() as any }; }
function ok(result: { status: number; data: any }) { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; }
function refused(result: { status: number; data: any }, status: number, message: RegExp) { assert.equal(result.status, status, JSON.stringify(result.data)); assert.match(String(result.data.error), message); checks += 1; }
const user = () => `user_${randomUUID().replaceAll("-", "")}`;
let checks = 0;
try {
  for (const name of ["003_pilot_workflow.sql", "004_staff_lender_access.sql"]) await pool.query(await readFile(new URL(`../../../lib/db/migrations/${name}`, import.meta.url), "utf8"));
  const org = `org_${randomUUID().replaceAll("-", "")}`;
  const people = { adminA: user(), adminB: user(), finance: user(), operations: user(), compliance: user(), reader: user(), idle: user() };
  const auth = (userId: string) => ({ userId, orgId: org, sessionId: `sess_${userId}`, tokenType: "session_token", sessionStatus: "active", factorVerificationAge: [0, 0], sessionClaims: { sub: userId, sid: `sess_${userId}`, iss: "https://identity.example", azp: "https://pilot.example", iat: Math.floor(Date.now() / 1000) - 1, exp: Math.floor(Date.now() / 1000) + 3600 } });
  for (const [name, userId] of Object.entries(people)) identities.set(name, auth(userId));
  const workspace = await store.provisionStaffWorkspace(org, people.adminA, "Governance rehearsal"); owned.push(workspace.workspaceId);
  const verified = (email: string) => { (clerkClient.users as any).getUser = async () => ({ emailAddresses: [{ emailAddress: email, verification: { status: "verified" } }] }); };
  const team = async (who = "adminA") => ok(await call("/v1/team", who));
  const events = async () => (await pool.query<{ actor: string; action: string; subject: string; detail: any }>("SELECT actor,action,subject,detail FROM valopay_staff_events WHERE workspace_id=$1 ORDER BY created_at,id", [workspace.workspaceId])).rows;

  // ---- 1. A grant of Admin, Finance or Compliance reviewer waits for a second administrator ----
  // One administrator alone: the invitation is created, waits, and says how to get a second administrator.
  const financeInvite = ok(await call("/v1/team/invitations", "adminA", "POST", { email: "finance@example.test", role: "Finance" }));
  assert.equal(financeInvite.approval, "awaiting"); checks += 1;
  assert.match(financeInvite.message, /waits for a second administrator's approval/); assert.match(financeInvite.message, /one active administrator: ask the operator to add a second with the provisioning command's --add-administrator mode/); checks += 2;
  verified("finance@example.test");
  refused(await call("/v1/team/accept", "finance", "POST", { token: financeInvite.token }), 403, /waiting for a second administrator's approval/);
  refused(await call(`/v1/team/invitations/${financeInvite.id}/approve`, "adminA", "POST"), 403, /A different administrator must approve this invitation.*--add-administrator/);
  let directory = await team();
  assert.deepEqual(pick(directory.invitations.find((item: any) => item.id === financeInvite.id), ["approval", "invitedBy", "approvedBy"]), { approval: "awaiting", invitedBy: `Clerk:${people.adminA}`, approvedBy: null }); checks += 1;
  // The operator adds the second administrator (provision-pilot --add-administrator), who approves.
  await store.addStaffAdministrator(org, people.adminB, "Second administrator");
  ok(await call(`/v1/team/invitations/${financeInvite.id}/approve`, "adminB", "POST"));
  refused(await call(`/v1/team/invitations/${financeInvite.id}/approve`, "adminB", "POST"), 409, /already approved/);
  directory = await team();
  assert.deepEqual(pick(directory.invitations.find((item: any) => item.id === financeInvite.id), ["approval", "approvedBy"]), { approval: "approved", approvedBy: `Clerk:${people.adminB}` }); checks += 1;
  assert.equal(ok(await call("/v1/team/accept", "finance", "POST", { token: financeInvite.token })).role, "Finance"); checks += 1;
  const accepted = (await events()).find(event => event.action === "staff.accepted" && event.subject === financeInvite.id)!;
  assert.equal(accepted.detail.approvedBy, `Clerk:${people.adminB}`, "the acceptance names the approving administrator"); checks += 1;
  assert.ok((await events()).some(event => event.action === "staff.invitation_approved" && event.actor === `Clerk:${people.adminB}` && event.subject === financeInvite.id)); checks += 1;
  // Operations and Read-only need no second administrator.
  for (const [who, role] of [["operations", "Operations"], ["reader", "Read-only"], ["idle", "Operations"]] as const) {
    const invite = ok(await call("/v1/team/invitations", "adminA", "POST", { email: `${who}@example.test`, role }));
    assert.equal(invite.approval, "not_required"); checks += 1;
    verified(`${who}@example.test`); assert.equal(ok(await call("/v1/team/accept", who, "POST", { token: invite.token })).role, role); checks += 1;
  }
  // A role change that grants Compliance reviewer waits; the membership is unchanged until another administrator approves it.
  const memberOf = (dir: any, who: keyof typeof people) => dir.members.find((row: any) => row.actor === `Clerk:${people[who]}`);
  let member = memberOf(await team(), "operations");
  const request = ok(await call(`/v1/team/members/${member.id}`, "adminA", "PATCH", { role: "Compliance reviewer", status: "active", expectedUpdatedAt: member.updatedAt, reason: "Move to compliance reviews." }));
  assert.deepEqual([request.role, request.updatedAt, request.pendingChange?.to], ["Operations", member.updatedAt, { role: "Compliance reviewer", status: "active" }]); checks += 1;
  assert.match(request.message, /waits for a second administrator/); checks += 1;
  assert.equal((await pool.query("SELECT role FROM valopay_staff_memberships WHERE id=$1", [member.id])).rows[0].role, "Operations"); checks += 1;
  directory = await team();
  assert.deepEqual(directory.changes.map((change: any) => [change.id, change.memberId, change.requestedBy]), [[request.pendingChange.id, member.id, `Clerk:${people.adminA}`]]); checks += 1;
  refused(await call(`/v1/team/changes/${request.pendingChange.id}/approve`, "adminA", "POST"), 403, /A different administrator must approve this change/);
  refused(await call(`/v1/team/changes/${request.pendingChange.id}/approve`, "finance", "POST"), 403, /administrator/);
  const approved = ok(await call(`/v1/team/changes/${request.pendingChange.id}/approve`, "adminB", "POST"));
  assert.deepEqual([approved.role, approved.status, approved.pendingChange], ["Compliance reviewer", "active", null]); checks += 1;
  assert.equal((await team()).changes.length, 0); checks += 1;
  const approval = (await events()).find(event => event.action === "staff.change_approved")!;
  assert.deepEqual([approval.actor, approval.detail.requestedBy, approval.detail.requestId, approval.detail.after.role], [`Clerk:${people.adminB}`, `Clerk:${people.adminA}`, request.pendingChange.id, "Compliance reviewer"]); checks += 1;
  // Taking a role away is immediate; reactivating a membership that holds such a role is a grant again, and may be declined.
  member = memberOf(await team(), "operations");
  const suspended = ok(await call(`/v1/team/members/${member.id}`, "adminA", "PATCH", { role: "Compliance reviewer", status: "suspended", expectedUpdatedAt: member.updatedAt, reason: "Leave of absence." }));
  assert.deepEqual([suspended.status, suspended.pendingChange], ["suspended", null]); checks += 1;
  const reactivation = ok(await call(`/v1/team/members/${member.id}`, "adminA", "PATCH", { role: "Compliance reviewer", status: "active", expectedUpdatedAt: suspended.updatedAt, reason: "Back from leave." }));
  assert.equal(reactivation.status, "suspended"); assert.ok(reactivation.pendingChange); checks += 2;
  // The same request again is the same waiting request, not a second one.
  const again = ok(await call(`/v1/team/members/${member.id}`, "adminA", "PATCH", { role: "Compliance reviewer", status: "active", expectedUpdatedAt: suspended.updatedAt, reason: "Back from leave." }));
  assert.equal(again.pendingChange.id, reactivation.pendingChange.id); checks += 1;
  ok(await call(`/v1/team/changes/${reactivation.pendingChange.id}/decline`, "adminB", "POST"));
  refused(await call(`/v1/team/changes/${reactivation.pendingChange.id}/approve`, "adminB", "POST"), 409, /already approved or declined/);
  assert.equal((await pool.query("SELECT status FROM valopay_staff_memberships WHERE id=$1", [member.id])).rows[0].status, "suspended"); checks += 1;
  // A request goes out of date when the membership changes after it: it is no longer listed, and approving it is refused.
  const stale = ok(await call(`/v1/team/members/${member.id}`, "adminA", "PATCH", { role: "Finance", status: "active", expectedUpdatedAt: suspended.updatedAt, reason: "Cover Finance reviews." }));
  ok(await call(`/v1/team/members/${member.id}`, "adminA", "PATCH", { role: "Operations", status: "suspended", expectedUpdatedAt: suspended.updatedAt, reason: "Leave extended." }));
  assert.equal((await team()).changes.length, 0); checks += 1;
  refused(await call(`/v1/team/changes/${stale.pendingChange.id}/approve`, "adminB", "POST"), 409, /changed after the change was requested/);
  // Nobody approves or declines a change to their own membership: the second administrator's own move is refused either
  // way (declining it would keep them Admin), and it still waits for the asker to withdraw it.
  const adminBMember = memberOf(await team(), "adminB");
  const demotion = ok(await call(`/v1/team/members/${adminBMember.id}`, "adminA", "PATCH", { role: "Finance", status: "active", expectedUpdatedAt: adminBMember.updatedAt, reason: "Move to Finance reviews." }));
  refused(await call(`/v1/team/changes/${demotion.pendingChange.id}/approve`, "adminB", "POST"), 403, /your own membership/);
  refused(await call(`/v1/team/changes/${demotion.pendingChange.id}/decline`, "adminB", "POST"), 403, /Ask another administrator to decline a change to your own membership/);
  assert.deepEqual([(await team()).changes.map((change: any) => change.id), (await events()).filter(event => event.action === "staff.change_declined" && event.detail.requestId === demotion.pendingChange.id).length], [[demotion.pendingChange.id], 0], "the refused decline recorded nothing"); checks += 1;
  ok(await call(`/v1/team/changes/${demotion.pendingChange.id}/decline`, "adminA", "POST"));

  // ---- 5. The directory: administrators see everyone; others see colleagues on their lenders, and no one else's expiry ----
  const [first, second] = [ok(await call("/v1/pilot/lenders", "adminA", "POST", { name: "First governance lender", segment: "Consumer lending" })), ok(await call("/v1/pilot/lenders", "adminA", "POST", { name: "Second governance lender", segment: "Consumer lending" }))];
  const grant = async (who: keyof typeof people, lenderIds: string[]) => { const row = memberOf(await team(), who); ok(await call(`/v1/team/members/${row.id}/lenders`, "adminA", "PATCH", { expectedUpdatedAt: row.updatedAt, lenderIds, reason: "Assign the governance rehearsal lenders." })); };
  await grant("finance", [first.id]); await grant("reader", [first.id, second.id]);
  const financeView = await team("finance");
  assert.deepEqual(financeView.members.map((row: any) => row.actor).sort(), [people.adminA, people.adminB, people.finance, people.reader].map(id => `Clerk:${id}`).sort(), "colleagues who share a lender, administrators included; not the others"); checks += 1;
  assert.deepEqual(memberOf(financeView, "reader").lenderIds, [first.id], "only the lenders they share"); checks += 1;
  assert.equal(memberOf(financeView, "reader").expiresAt, null); assert.equal(memberOf(financeView, "adminA").expiresAt, null); assert.ok(memberOf(financeView, "finance").expiresAt); checks += 3;
  assert.deepEqual([financeView.invitations, financeView.changes, financeView.events, financeView.lenders], [[], [], [], []]); checks += 1;
  // Without a lender, a person sees only themselves; an administrator sees everyone, with their expiry.
  assert.deepEqual((await team("idle")).members.map((row: any) => row.actor), [`Clerk:${people.idle}`]); checks += 1;
  const adminView = await team();
  assert.ok(adminView.members.length >= 6 && adminView.members.every((row: any) => typeof row.expiresAt === "string")); checks += 1;

  // ---- 4. Dispute packs, customer records and the audit trail: Admin, Finance and Compliance reviewer only ----
  await grant("idle", [first.id]);
  const lender = `?merchantId=${first.id}`;
  const customer = ok(await call(`/v1/records/customers${lender}`, "adminA", "POST", { name: "Governance customer", reference: `GOV-${randomUUID()}`, data: { consentProvenance: "Synthetic consent" } }));
  for (const [kind, extra] of [["dispute-pack", { customerId: customer.id }], ["customers", {}], ["audit", {}]] as const) refused(await call(`/v1/exports${lender}`, "idle", "POST", { kind, format: "json", ...extra }), 403, /Only an Admin, Finance or Compliance reviewer can export or download/);
  const pack = ok(await call(`/v1/exports${lender}`, "finance", "POST", { kind: "dispute-pack", format: "pdf", customerId: customer.id }));
  const gatePack = ok(await call(`/v1/exports${lender}`, "idle", "POST", { kind: "gate-pack", format: "pdf" }));
  refused(await call(`/v1/exports/${pack.id}/download${lender}`, "idle", "GET"), 403, /Only Admin, Finance or Compliance reviewer/);
  refused(await call(`/v1/exports/${pack.id}/download${lender}`, "reader", "GET"), 403, /Only Admin, Finance or Compliance reviewer/);
  // Finance passes the check and is told the file is not ready yet; a Read-only person may still download other exports.
  assert.equal((await call(`/v1/exports/${pack.id}/download${lender}`, "finance", "GET")).status, 409); checks += 1;
  assert.equal((await call(`/v1/exports/${gatePack.id}/download${lender}`, "reader", "GET")).status, 409); checks += 1;
  // Status reads stay open: the job's progress is not its contents.
  assert.equal(ok(await call(`/v1/exports/${pack.id}${lender}`, "idle", "GET")).id, pack.id); checks += 1;
  await pool.query("UPDATE valopay_records SET status='failed',data=data||'{\"lastError\":\"Synthetic failure.\"}'::jsonb WHERE id=$1 AND merchant_id=$2", [pack.id, first.id]);
  refused(await call(`/v1/exports/${pack.id}/retry${lender}`, "idle", "POST", {}), 403, /Only Admin, Finance or Compliance reviewer/);

  // ---- 3. The emergency stop: on at once; off only with a second administrator ----
  ok(await call(`/v1/actions${lender}`, "adminA", "POST", { action: "kill_switch", reason: "Suspected duplicate debit instructions.", data: { enabled: true } }));
  const asked = ok(await call(`/v1/actions${lender}`, "adminA", "POST", { action: "kill_switch", reason: "The duplicates were explained.", data: { enabled: false } }));
  assert.equal(asked.data.releaseRequested, true); checks += 1;
  let settings = ok(await call(`/v1/settings${lender}`, "adminB"));
  assert.deepEqual([settings.merchant.killSwitch, settings.settings.emergencyStopReleases.lender.requestedBy], [true, `Clerk:${people.adminA}`]); checks += 1;
  refused(await call(`/v1/actions${lender}`, "adminA", "POST", { action: "approve_kill_switch_off", reason: "Approving my own request.", data: {} }), 403, /^A different Admin must approve turning off the emergency stop\. If your pilot has only one Admin, ask the Valo Pay team to add a second\.$/);
  ok(await call(`/v1/actions${lender}`, "adminB", "POST", { action: "approve_kill_switch_off", reason: "Checked the incident notes.", data: {} }));
  settings = ok(await call(`/v1/settings${lender}`, "adminA"));
  assert.deepEqual([settings.merchant.killSwitch, settings.settings.emergencyStopReleases], [false, undefined]); checks += 1;
  const audit = (await pool.query("SELECT data FROM valopay_records WHERE merchant_id=$1 AND kind='audit' ORDER BY (data->>'sequence')::int DESC LIMIT 1", [first.id])).rows[0].data;
  assert.equal(audit.actor, `Clerk:${people.adminB}`); assert.match(audit.summary, /Checked the incident notes\. Approved the request by Clerk:user_\w+ at .*: The duplicates were explained\./); checks += 2;

  // ---- 2. Retention: the staff minimums, and a different administrator approves the preparer's run ----
  const csv = "source_row_id,name,reference,consentProvenance\nrow-1,Retention customer,RET-" + randomUUID().slice(0, 8) + ",Synthetic consent";
  let batch = ok(await call(`/v1/pilot/batches${lender}`, "adminA", "POST", { name: "Old synthetic source", kind: "customers", source: "governance", sourceBatchId: randomUUID(), csv, mapping: {}, identityColumn: "source_row_id", amountUnit: "naira", syntheticOnly: true }));
  batch = ok(await call(`/v1/pilot/batches/${batch.id}/commit${lender}`, "adminA", "POST", { expectedUpdatedAt: batch.updatedAt }));
  await pool.query("UPDATE valopay_records SET data=jsonb_set(data,'{committedAt}',to_jsonb($3::text)) WHERE id=$1 AND merchant_id=$2", [batch.id, first.id, new Date(Date.now() - 7 * 366 * 86400000).toISOString()]);
  let lifecycle = ok(await call(`/v1/lifecycle${lender}`, "adminA"));
  assert.deepEqual([lifecycle.secondApprover, lifecycle.minimumDays], [true, { rawCsvDays: 2192, journalPayloadDays: 366, exportFileDays: 2192 }]); checks += 1;
  refused(await call(`/v1/lifecycle/policy${lender}`, "adminA", "POST", { policy: { rawCsvDays: 30, journalPayloadDays: null, exportFileDays: null, auditTrail: "retain" }, expectedRevision: lifecycle.policyRevision, reason: "Delete source files after a month." }), 400, /at least 2,192 days \(six years\)/);
  lifecycle = ok(await call(`/v1/lifecycle/policy${lender}`, "adminA", "POST", { policy: { rawCsvDays: 2192, journalPayloadDays: null, exportFileDays: null, auditTrail: "retain" }, expectedRevision: lifecycle.policyRevision, reason: "Keep source files for the six-year evidence period." }));
  const run = ok(await call(`/v1/lifecycle/runs${lender}`, "adminA", "POST", { expectedPolicyRevision: lifecycle.policyRevision }));
  assert.deepEqual([run.preparedBy, run.candidates.map((item: any) => item.sourceId)], [`Clerk:${people.adminA}`, [batch.id]]); checks += 1;
  const approveRun = { expectedUpdatedAt: run.updatedAt, previewDigest: run.previewDigest, reason: "Reviewed the exact eligible source file." };
  refused(await call(`/v1/lifecycle/runs/${run.id}/approve${lender}`, "adminA", "POST", approveRun), 403, /A different Admin must approve this deletion run/);
  const approvedRun = ok(await call(`/v1/lifecycle/runs/${run.id}/approve${lender}`, "adminB", "POST", approveRun));
  assert.equal(approvedRun.approvedBy, `Clerk:${people.adminB}`); checks += 1;
  assert.equal(ok(await call(`/v1/lifecycle/runs/${run.id}/execute${lender}`, "adminA", "POST", { previewDigest: run.previewDigest })).status, "completed", "either administrator executes the approved run"); checks += 1;

  // ---- 6. Fortnightly reviews name their reviewer at the service's time; the calendar is Admin and Operations' ----
  refused(await call(`/v1/records/reviews${lender}`, "finance", "POST", { name: "Fortnightly review", data: { reviewer: "Someone else", confirmedJobs: ["mandates", "retries", "reconciliation", "audit"], note: "Checked." } }), 400, /Valo Pay records you as the reviewer\. Leave the reviewer blank\./);
  refused(await call(`/v1/records/reviews${lender}`, "finance", "POST", { name: "Fortnightly review", data: { reviewedAt: "2026-01-01", confirmedJobs: ["audit"], note: "Checked." } }), 400, /Valo Pay records the review time when you save\. Leave the review date blank\./);
  const before = Date.now();
  const review = ok(await call(`/v1/records/reviews${lender}`, "finance", "POST", { name: "Fortnightly review", data: { confirmedJobs: ["mandates", "retries", "reconciliation", "audit"], note: "Checked the four tasks." } }));
  assert.equal(review.data.reviewer, `Clerk:${people.finance}`); assert.ok(Math.abs(Date.parse(review.data.reviewedAt) - before) < 60_000); checks += 2;
  refused(await call(`/v1/records/calendar${lender}`, "finance", "POST", { name: "Public holiday", status: "active", data: { date: "2027-12-24" } }), 403, /Only Admin or Operations can add or edit calendar days\./);
  assert.equal(ok(await call(`/v1/records/calendar${lender}`, "idle", "POST", { name: "Public holiday", status: "active", data: { date: "2027-12-24" } })).data.date, "2027-12-24"); checks += 1;
  console.log(`Staff governance API/PostgreSQL checks passed (${checks} checks): second-administrator approval of Admin, Finance and Compliance reviewer grants (invitations, role changes and reactivations, with the operator's second administrator), directory scoping, sensitive exports, the emergency stop, retention approval and minimums, reviewer-bound reviews and the calendar's roles.`);
} finally {
  server.close(); await once(server, "close");
  for (const id of owned) { await pool.query("DELETE FROM valopay_staff_lender_access WHERE membership_id IN (SELECT id FROM valopay_staff_memberships WHERE workspace_id=$1)", [id]); for (const table of ["valopay_staff_events", "valopay_staff_invitations", "valopay_staff_memberships", "valopay_teams"]) await pool.query(`DELETE FROM ${table} WHERE workspace_id=$1`, [id]); for (const table of ["valopay_operations", "valopay_idempotency", "valopay_records"]) await pool.query(`DELETE FROM ${table} WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)`, [id]); await pool.query("DELETE FROM valopay_merchants WHERE workspace_id=$1", [id]); await pool.query("DELETE FROM valopay_workspaces WHERE id=$1", [id]); }
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  (clerkClient.users as any).getUser = savedGetUser;
  await pool.end();
}
function pick(value: any, keys: string[]) { return Object.fromEntries(keys.map(key => [key, value?.[key]])); }
