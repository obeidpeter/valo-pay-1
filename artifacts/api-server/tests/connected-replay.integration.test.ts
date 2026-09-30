/** Real HTTP + PostgreSQL regression: a saved outcome is not reusable authority.
 * Declined replay retains its original completed journal/receipt and never reruns
 * the action. GET /v1/connected withholds a saved VAT schedule or forecast whose
 * grants or evidence changed, as replay does. A Cash Desk total beyond the
 * supported range is a money refusal (422), on the read and on a keyed action,
 * whose journal entry closes. A signed-in staff member retries their own lost
 * answer, and a colleague with the same key never receives it. All records,
 * identities, grants and external outcomes are synthetic. */
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { requireLoopback } from "./throwaway-database.js";

if (process.env.VALOPAY_RUN_INTEGRATION !== "1") {
  console.log("Set VALOPAY_RUN_INTEGRATION=1 to test connected receipt authority on disposable loopback PostgreSQL.");
  process.exit(0);
}
requireLoopback("Connected receipt authority", new URL(process.env.DATABASE_URL!));
process.env.CLERK_SECRET_KEY ??= "sk_test_placeholder";
process.env.CLERK_TELEMETRY_DISABLED = "1";
const staffSettings = { VALOPAY_STAFF_ACCESS: "staging", VALOPAY_STAFF_ISSUER: "https://identity.example", VALOPAY_STAFF_ORIGINS: "https://pilot.example" };
const savedSettings = Object.fromEntries(Object.keys(staffSettings).map((name) => [name, process.env[name]]));
const { pool } = await import("@workspace/db");
const { default: router } = await import("../src/routes/index.js");
const { errorHandler } = await import("../src/lib/error-handler.js");
const store = await import("../src/lib/valopay-store.js");
const { touch } = await import("../src/domain/records.js");
const { connectedActionSchema, connectedRevision } = await import("../src/domain/connected.js");
const { requestFingerprint } = await import("../src/lib/digests.js");
/** The warnings the service logs, where a money refusal is looked for. */
const warnings: Array<Record<string, unknown>> = [];
const quiet = { info() {}, warn(entry: Record<string, unknown>) { warnings.push(entry); }, error() {} };
/** Verified staff sessions by name, sent as X-Test-Identity; without one a request is the anonymous sandbox's. */
const identities = new Map<string, unknown>();
const auth = (who?: string) => Object.assign(() => (who && identities.get(who)) || { userId: null }, { [Symbol.for("@clerk/express.auth")]: true });
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((req, _res, next) => { (req as any).auth = auth(req.header("X-Test-Identity")); (req as any).log = quiet; next(); });
app.use("/api", router);
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const cookie = `valopay_sandbox=${randomBytes(32).toString("hex")}`;
let lender = "", workspaceId = "", staffWorkspace = "", checks = 0;
type Answer = { status: number; data: any; operation: string | null };
async function call(path: string, body?: unknown, key?: string, who?: string): Promise<Answer> {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, ...(key ? { "Idempotency-Key": key } : {}), ...(who ? { "X-Test-Identity": who } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json(), operation: response.headers.get("X-Valopay-Operation") };
}
const ok = (answer: Answer) => { assert.equal(answer.status, 200, JSON.stringify(answer.data)); return answer.data; };
const request = () => ({ headers: { cookie }, query: { merchantId: lender }, secure: false, log: quiet, auth: auth() }) as any;
const response = () => ({ cookie() {} }) as any;
const role = (value: string) => store.inWorkspace(request(), response(), (ctx) => store.changeRole(ctx, value), "persona");
/** One lender's connected desk, as the sandbox or a named staff member uses it. */
function desk(merchantId: () => string, who?: string) {
  const q = (path: string) => `${path}?merchantId=${merchantId()}`;
  const view = async () => ok(await call(q("/v1/connected"), undefined, undefined, who));
  const fresh = async (action: string, data: Record<string, unknown> = {}, recordId?: string) => {
    const body = { action, data, ...(recordId ? { recordId } : {}), expectedRevision: (await view()).revision, reason: "Verify historical response access without repeating the command" };
    const key = randomUUID(), answer = await call(q("/v1/connected/actions"), body, key, who);
    ok(answer);
    return { body, key, answer };
  };
  const snapshot = async () => JSON.stringify([
    (await pool.query("SELECT id, kind, status, data, updated_at FROM valopay_records WHERE merchant_id=$1 ORDER BY id", [merchantId()])).rows,
    (await pool.query("SELECT * FROM valopay_idempotency WHERE merchant_id=$1 ORDER BY id", [merchantId()])).rows,
  ]);
  const replay = async (receipt: Receipt, status: number) => {
    const before = await snapshot();
    const answer = await call(q("/v1/connected/actions"), receipt.body, receipt.key, who);
    assert.equal(answer.status, status, JSON.stringify(answer.data));
    assert.equal(await snapshot(), before, "replay never rewrites records, audits or the original idempotency receipt");
    assert.equal(answer.operation, receipt.answer.operation);
    assert.equal((await pool.query("SELECT status FROM valopay_operations WHERE id=$1", [answer.operation])).rows[0].status, "completed");
    assert.notEqual(answer.data.committed, false, "an unavailable historical response must not claim the original action saved nothing");
    if (status === 200) assert.deepEqual(answer.data, receipt.answer.data);
    else {
      assert.match(answer.data.error, /already completed/);
      assert.equal(answer.data.operation, "completed");
      assert.equal("record" in answer.data, false, "no retained score or manifest is disclosed");
    }
    checks += status === 200 ? 6 : 8;
  };
  return { q, view, fresh, replay };
}
type Receipt = { body: Record<string, unknown>; key: string; answer: Answer };
const sandbox = desk(() => lender);
const { fresh, replay } = sandbox;
/** A synthetic change to one of the lender's records, as another tab or colleague would make it, with its audit entry. */
async function change(find: (record: any) => boolean, edit: (record: any) => void, action: string) {
  await store.inWorkspace(request(), response(), async (ctx) => {
    const state = await store.loadState(ctx, lender, "update");
    const record = state.records.find(find)!;
    edit(record);
    touch(record, ctx.now);
    store.appendAudit(state, ctx, action, record.id, "Change a synthetic record to verify saved responses check current authority and evidence.");
    await store.saveState(ctx, state);
  });
}
const reviseGrant = (id: string, status: string) => change((r) => r.id === id && r.kind === "connected-consents", (grant) => {
  grant.status = status;
  grant.data.version++;
}, "test.permission.revision");
const editWorkspace = (edit: (workspace: any) => void) => change((r) => r.kind === "connected-cash-workspace", (record) => edit(record.data.workspace), "test.cash.source");
const cash = async () => (await sandbox.view()).cash;
const vatListed = async () => (await cash()).vatExports.map((item: any) => [item.id, item.state, item.schedule === undefined ? "withheld" : "shown"]);
const savedOf = (receipt: Receipt) => receipt.answer.data.record.record;
try {
  lender = ok(await call("/v1/workspace")).merchants[0].id;
  workspaceId = (await pool.query("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [lender])).rows[0].workspace_id;
  await role("Operations");
  const readGrant = (await fresh("consent.grant", { subjectId: "sme", purpose: "merchant_account_read" })).answer.data.record;
  const erpGrant = (await fresh("consent.grant", { subjectId: "sme", purpose: "erp_draft" })).answer.data.record;
  await fresh("cash.initialize");
  const forecast = await fresh("cash.forecast");
  assert.ok(forecast.answer.data.record.record.data.replayAuthority.length, "new forecast response and stored record retain original authority");
  await replay(forecast, 200);
  const prepared = (await fresh("cash.erp.prepare")).answer.data.record.record;
  await role("Finance");
  await fresh("cash.erp.review", {}, prepared.id);
  const exported = await fresh("cash.erp.export", {}, prepared.id);
  await replay(exported, 200);
  const vat = await fresh("cash.vat.export");
  assert.equal(vat.answer.data.record.record.data.replayAuthority.length, 2);
  await replay(vat, 200);
  // The desk shows what replay would disclose: the saved schedule and forecast, while their grants are current.
  assert.deepEqual(await vatListed(), [[savedOf(vat).id, "current", "shown"]]);
  assert.deepEqual((await cash()).savedForecast, { id: savedOf(forecast).id, createdAt: savedOf(forecast).createdAt, state: "current" });
  checks += 2;
  await reviseGrant(erpGrant.id, "revoked");
  await replay(exported, 403);
  await replay(vat, 403);
  assert.deepEqual(await vatListed(), [], "a revoked grant lists no saved schedule, as it lists no accounting draft");
  await reviseGrant(erpGrant.id, "active");
  await replay(exported, 409);
  await replay(vat, 409);
  assert.deepEqual(await vatListed(), [[savedOf(vat).id, "prepare_again", "withheld"]], "a regranted permission is not the one the schedule was saved under");
  checks += 2;
  await role("Operations");
  await reviseGrant(readGrant.id, "revoked");
  await replay(forecast, 403);
  assert.deepEqual([(await cash()).forecast, (await cash()).savedForecast], [null, null]);
  await reviseGrant(readGrant.id, "active");
  await replay(forecast, 409);
  assert.deepEqual([(await cash()).forecast, (await cash()).savedForecast], [null, { id: savedOf(forecast).id, createdAt: savedOf(forecast).createdAt, state: "prepare_again" }]);
  checks += 2;
  // A changed source: the grants are current, but the evidence is not what the figures were made from.
  await role("Finance");
  const currentForecast = await fresh("cash.forecast"), currentVat = await fresh("cash.vat.export");
  assert.deepEqual([(await cash()).forecast, (await cash()).savedForecast?.state, (await vatListed()).at(-1)], [savedOf(currentForecast).data.forecast, "current", [savedOf(currentVat).id, "current", "shown"]]);
  await editWorkspace((workspace) => {
    workspace.commitments[0].amountMinor += 100;
    workspace.vatInvoices[0].vatMinor += 100;
  });
  assert.deepEqual([(await cash()).forecast, (await cash()).savedForecast?.state, (await vatListed()).at(-1)], [null, "prepare_again", [savedOf(currentVat).id, "prepare_again", "withheld"]]);
  await replay(currentForecast, 409);
  await replay(currentVat, 409);
  checks += 2;

  await role("Operations");
  const customerId = ok(await call(sandbox.q("/v1/connected"))).customers[0].id;
  const blocked = await fresh("credit.assess", { customerId, scenario: "ready" });
  assert.equal(blocked.answer.data.record.data.result.score, null);
  await replay(blocked, 200);
  await fresh("consent.grant", { subjectId: customerId, purpose: "account_read" });
  const creditGrant = (await fresh("consent.grant", { subjectId: customerId, purpose: "credit_assessment" })).answer.data.record;
  const assessed = await fresh("credit.assess", { customerId, scenario: "ready" });
  assert.ok(assessed.answer.data.record.data.result.score);
  await replay(assessed, 200);
  await reviseGrant(creditGrant.id, "revoked");
  await replay(assessed, 403);
  await replay(blocked, 200);
  checks += 4;

  // A Cash Desk total beyond the supported range is a money refusal (422 naming its code, logged as
  // money.calculation_refused), on the read and on a keyed action, never 400 or 500. The action's journal entry is
  // closed as refused, so nothing waits in Operations and its key cannot run again.
  await editWorkspace((workspace) => {
    workspace.accounts[0].bookedMinor = Number.MAX_SAFE_INTEGER;
    workspace.accounts[1].bookedMinor = 1;
  });
  warnings.length = 0;
  const read = await call(sandbox.q("/v1/connected"));
  assert.equal(read.status, 422, JSON.stringify(read.data));
  assert.deepEqual([read.data.code, read.data.operation], ["MONEY_OUT_OF_RANGE", undefined], "a read has no journal entry to name");
  assert.match(read.data.error, /^This calculation cannot be completed within the supported amount or rate limits\./);
  assert.deepEqual(warnings.filter((entry) => entry.event === "money.calculation_refused"), [{ event: "money.calculation_refused", code: "MONEY_OUT_OF_RANGE" }], "logged once, with its code and no amount");
  const revision = await store.inWorkspace(request(), response(), async (ctx) => connectedRevision(await store.loadState(ctx, lender, "share")), "read");
  const forecasts = async () => Number((await pool.query("SELECT count(*)::int AS n FROM valopay_records WHERE merchant_id=$1 AND kind='connected-cash-forecasts'", [lender])).rows[0].n);
  const before = await forecasts(), key = randomUUID();
  const body = { action: "cash.forecast", data: {}, expectedRevision: revision, reason: "Save a forecast of balances beyond the supported range" };
  const refused = await call(sandbox.q("/v1/connected/actions"), body, key);
  assert.equal(refused.status, 422, JSON.stringify(refused.data));
  assert.deepEqual([refused.data.code, refused.data.operation], ["MONEY_OUT_OF_RANGE", "cancelled"]);
  assert.equal((await pool.query("SELECT status FROM valopay_operations WHERE id=$1", [refused.operation])).rows[0].status, "cancelled");
  assert.equal(ok(await call(`/v1/operations/pending?merchantId=${lender}`)).pending, 0);
  const listed = ok(await call(`/v1/operations?merchantId=${lender}`)).items.find((item: { id: string }) => item.id === refused.operation);
  assert.match(listed.message, /^Valo Pay refused this request: This calculation cannot be completed/);
  const again = await call(sandbox.q("/v1/connected/actions"), body, key);
  assert.deepEqual([again.status, again.data.operation], [409, "cancelled"]);
  assert.equal(await forecasts(), before);
  checks += 12;

  // ---- A signed-in staff member retries their own lost answer; a colleague with the same key never receives it ----
  Object.assign(process.env, staffSettings);
  for (const name of ["003_pilot_workflow.sql", "004_staff_lender_access.sql"]) await pool.query(await readFile(new URL(`../../../lib/db/migrations/${name}`, import.meta.url), "utf8"));
  const organisation = `org_${randomUUID().replaceAll("-", "")}`, person = () => `user_${randomUUID().replaceAll("-", "")}`;
  const staffAuth = (userId: string) => {
    const now = Math.floor(Date.now() / 1000);
    return { userId, orgId: organisation, sessionId: `sess_${userId}`, tokenType: "session_token", sessionStatus: "active", factorVerificationAge: [0, 0],
      sessionClaims: { sub: userId, sid: `sess_${userId}`, iss: staffSettings.VALOPAY_STAFF_ISSUER, azp: staffSettings.VALOPAY_STAFF_ORIGINS, iat: now - 1, exp: now + 3600 } };
  };
  const first = person(), second = person();
  identities.set("first", staffAuth(first));
  identities.set("second", staffAuth(second));
  staffWorkspace = (await store.provisionStaffWorkspace(organisation, first, "Connected replay rehearsal")).workspaceId;
  await store.addStaffAdministrator(organisation, second, "Second administrator");
  const staffLender = ok(await call("/v1/pilot/lenders", { name: "Connected replay pilot", segment: "Business finance" }, randomUUID(), "first")).id as string;
  assert.equal((await pool.query("SELECT settings->>'environment' AS environment FROM valopay_merchants WHERE id=$1", [staffLender])).rows[0].environment, "sandbox", "a staff pilot's lender is a synthetic sandbox");
  const mine = desk(() => staffLender, "first");
  await mine.fresh("consent.grant", { subjectId: "sme", purpose: "merchant_account_read" });
  const setUp = await mine.fresh("cash.initialize");
  const lost = await mine.fresh("cash.forecast");
  assert.equal(lost.answer.data.record.record.data.actor, `Clerk:${first}`);
  await mine.replay(setUp, 200);
  await mine.replay(lost, 200);
  // The colleague sends the same key and body: their own request, under their own journal entry, refused as stale.
  const other = await call(mine.q("/v1/connected/actions"), lost.body, lost.key, "second");
  assert.deepEqual([other.status, other.data.error, other.data.operation, "record" in other.data], [409, "Connected banking changed after you opened it. Reload the page and try again.", "cancelled", false]);
  assert.notEqual(other.operation, lost.answer.operation, "a key is its sender's: the colleague's request has an entry of its own");
  assert.deepEqual((await pool.query("SELECT id,actor,status FROM valopay_operations WHERE id=ANY($1::text[]) ORDER BY actor", [[lost.answer.operation, other.operation]])).rows.map((row) => [row.id, row.actor, row.status]).sort(),
    [[lost.answer.operation, `Clerk:${first}`, "completed"], [other.operation, `Clerk:${second}`, "cancelled"]].sort());
  await mine.replay(lost, 200);
  // An answer an earlier build kept under the key alone, with its sender's fingerprint: the sender recovers it, and the
  // colleague sending the same key and body is refused as a different request.
  const legacyKey = randomUUID();
  await pool.query("INSERT INTO valopay_idempotency(id,merchant_id,request_hash,response) VALUES($1,$2,$3,$4)", [store.digest(`connected:${staffLender}:${legacyKey}`), staffLender,
    requestFingerprint({ input: connectedActionSchema.parse(lost.body), actor: `Clerk:${first}` }), lost.answer.data]);
  const refusedColleague = await call(mine.q("/v1/connected/actions"), lost.body, legacyKey, "second");
  assert.deepEqual([refusedColleague.status, refusedColleague.data.error, "record" in refusedColleague.data], [409, "This request was already sent with different details. Reload the page and try again.", false]);
  const recovered = await call(mine.q("/v1/connected/actions"), lost.body, legacyKey, "first");
  assert.deepEqual([recovered.status, recovered.data], [200, lost.answer.data]);
  checks += 7;
} finally {
  server.close();
  await once(server, "close");
  if (workspaceId) {
    for (const table of ["valopay_idempotency", "valopay_operations", "valopay_records"])
      await pool.query(`DELETE FROM ${table} WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)`, [workspaceId]);
    await pool.query("DELETE FROM valopay_merchants WHERE workspace_id=$1", [workspaceId]);
    await pool.query("DELETE FROM valopay_workspaces WHERE id=$1", [workspaceId]);
  }
  if (staffWorkspace) {
    await pool.query("DELETE FROM valopay_staff_lender_access WHERE membership_id IN (SELECT id FROM valopay_staff_memberships WHERE workspace_id=$1)", [staffWorkspace]);
    for (const table of ["valopay_staff_events", "valopay_staff_invitations", "valopay_staff_memberships", "valopay_teams"]) await pool.query(`DELETE FROM ${table} WHERE workspace_id=$1`, [staffWorkspace]);
    for (const table of ["valopay_operations", "valopay_idempotency", "valopay_records"]) await pool.query(`DELETE FROM ${table} WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)`, [staffWorkspace]);
    await pool.query("DELETE FROM valopay_merchants WHERE workspace_id=$1", [staffWorkspace]);
    await pool.query("DELETE FROM valopay_workspaces WHERE id=$1", [staffWorkspace]);
  }
  for (const [name, value] of Object.entries(savedSettings)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  await pool.end();
}
console.log(`Connected replay PostgreSQL/HTTP: ${checks} checks passed; revoked/replaced authority or changed evidence cannot replay or show scores, schedules, forecasts or exports, original receipts/journals remain completed and commands never rerun, a Cash Desk money refusal closes its request, and a staff member retries only their own answers.`);
