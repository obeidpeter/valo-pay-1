// The saved-event verification against PostgreSQL: the mapped lender's lock, the store's final-state guard
// and the audit trail, with Paystack's answers faked in this process as the offline tests fake them. No
// request leaves the process, and nothing but synthetic records is written.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
if (process.env.VALOPAY_RUN_INTEGRATION !== "1") {
  console.log("Set VALOPAY_RUN_INTEGRATION=1 to run the Paystack verification against a disposable PostgreSQL database.");
  process.exit(0);
}
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL || "").hostname), "Refuse a non-local integration database.");
const names = ["VALOPAY_STAFF_ACCESS", "VALOPAY_RUNTIME_ISOLATION", "VALOPAY_PAYSTACK_INGRESS", "VALOPAY_PAYSTACK_CONNECTIONS", "PAYSTACK_TEST_SECRET_KEY"] as const;
const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
process.env.VALOPAY_STAFF_ACCESS = "off";
process.env.VALOPAY_RUNTIME_ISOLATION = "off";
const { pool } = await import("@workspace/db");
const { inWorkspace, inMerchantAsSystem, listMerchants, loadState, saveState, appendAudit, digest, SYSTEM_ACTOR_PREFIX } = await import("../src/lib/valopay-store");
const { makeRecord, touch } = await import("../src/domain/records");
const { parsePaystackTestWebhook } = await import("../src/providers/paystack");
const { receivePaystackEvent } = await import("../src/providers/paystack-inbox");
const { paystackTestConnectionIdentity } = await import("../src/providers/paystack-verification");
const { verifyStoredPaystackTestEvent, paystackVerificationReport } = await import("../src/lib/paystack-verification");

const token = randomBytes(32).toString("hex"), connectionId = randomBytes(32).toString("hex");
const key = ["sk", "test", "OFFLINE", "INTEGRATION", "0".repeat(20)].join("_");
const request = { headers: { cookie: `valopay_sandbox=${token}` }, secure: false, auth: Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true }) } as any;
const response = { cookie() {} } as any;
const realFetch = globalThis.fetch;
let reply: (payment: Record<string, unknown>) => Response = () => { throw new Error("No Paystack answer was arranged."); };
const payments = new Map<string, Record<string, unknown>>();
let lookups = 0;
// The adapter takes the global fetch when it is made: only Paystack's fixed origin is answered, from this process.
globalThis.fetch = (async (url: string | URL | Request) => {
  const address = String(url);
  assert.ok(address.startsWith("https://api.paystack.co/transaction/verify/"), "only the fixed-origin verification is requested");
  lookups++;
  return reply(payments.get(decodeURIComponent(address.slice(address.lastIndexOf("/") + 1)))!);
}) as typeof fetch;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const stored = async (id: string) => (await pool.query("SELECT status, data FROM valopay_records WHERE id=$1", [id])).rows[0] as { status: string; data: Record<string, any> };
const audits = async (merchantId: string) => (await pool.query("SELECT data FROM valopay_records WHERE merchant_id=$1 AND kind='audit' AND name='paystack.test_verification' ORDER BY created_at", [merchantId])).rows.map((row) => String(row.data.summary));
const run = async (eventId: string) => {
  try { return paystackVerificationReport(await verifyStoredPaystackTestEvent(connectionId, eventId)); }
  catch (error) { return paystackVerificationReport(error); }
};
try {
  const lender = (await inWorkspace(request, response, listMerchants))[0]!.id;
  const workspaceId = (await pool.query("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [lender])).rows[0].workspace_id as string;
  await pool.query("UPDATE valopay_merchants SET info=jsonb_set(jsonb_set(info,'{killSwitch}','true'::jsonb),'{mode}','\"observation\"'::jsonb) WHERE id=$1", [lender]);
  Object.assign(process.env, { VALOPAY_PAYSTACK_INGRESS: "test", PAYSTACK_TEST_SECRET_KEY: key, VALOPAY_PAYSTACK_CONNECTIONS: JSON.stringify({ [connectionId]: { workspaceId, merchantId: lender } }) });
  // Two saved expectations and their signed test events, received under the lender lock as the ingress saves them.
  const [refused, earlier, disagreeing] = (await inMerchantAsSystem(lender, `${SYSTEM_ACTOR_PREFIX}Paystack verification rehearsal`, async (ctx) => {
    const state = await loadState(ctx, lender, "update");
    const ids = ["DEMO-LOAN-1005", "DEMO-LOAN-1006", "DEMO-LOAN-1007"].map((loan, index) => {
      const due = state.records.find((record) => record.kind === "due-items" && record.reference === loan)!;
      const reference = `SYNTHETIC-VERIFY-${index + 1}`;
      makeRecord(state, "attempts", { name: "Saved test collection expectation", status: "unknown", reference, customerId: due.customerId, amountKobo: due.amountKobo, createdAt: ctx.now,
        data: { source: "external", dueItemId: due.id, currency: "NGN", providerConnection: paystackTestConnectionIdentity(connectionId), providerReference: reference, failureCode: "TIMEOUT_UNKNOWN" } });
      const payment = { id: `99900${index + 1}`, domain: "test", status: "success", reference, amount: due.amountKobo, currency: "NGN", channel: "direct_debit" };
      payments.set(reference, payment);
      const raw = Buffer.from(JSON.stringify({ event: "charge.success", data: payment }));
      return receivePaystackEvent(state, ctx, parsePaystackTestWebhook(raw, createHmac("sha512", key).update(raw).digest("hex"), key), { connectionId, mode: "test" }).event.id;
    });
    appendAudit(state, ctx, "paystack.test_event", ids[0]!, "Synthetic signed test events for the verification rehearsal.");
    await saveState(ctx, state);
    return ids;
  }))!;

  // A refused key leaves the event awaiting verification, names the outcome in its history and the audit trail,
  // and the same event verifies once the key is put right.
  reply = () => json({ status: false, message: `Invalid key ${key}` }, 401);
  let report = await run(refused!);
  assert.deepEqual([report.result, report.exitCode, report.eventStatus], ["credentials_refused", 1, "awaiting_verification"]);
  let event = await stored(refused!);
  assert.equal(event.status, "awaiting_verification");
  assert.equal(event.data.replayHistory.at(-1).check, "credentials_refused");
  assert.match((await audits(lender)).at(-1)!, /\(credentials refused\)/);
  reply = (payment) => json({ status: true, data: payment });
  report = await run(refused!);
  assert.deepEqual([report.result, report.exitCode, report.observationCreated], ["verified", 0, true]);
  assert.equal((await stored(refused!)).status, "verified");
  assert.equal(Number((await pool.query("SELECT count(*) AS n FROM valopay_records WHERE merchant_id=$1 AND kind='observations' AND data->>'providerEventId'=$2", [lender, refused])).rows[0].n), 1);
  report = await run(refused!);
  assert.deepEqual([report.result, report.exitCode, report.observationCreated], ["verified", 0, false], "a verified event is not checked again");

  // An earlier build quarantined an event after a refused key. The store keeps that write; the event can be verified again.
  await inMerchantAsSystem(lender, `${SYSTEM_ACTOR_PREFIX}Paystack verification rehearsal`, async (ctx) => {
    const state = await loadState(ctx, lender, "update");
    const record = state.records.find((item) => item.id === earlier)!;
    record.status = "quarantined";
    record.data.message = "Independent verification could not validate this evidence. The recorded reason requires operator review; no observation was created.";
    record.data.replayHistory = [...record.data.replayHistory, { at: ctx.now, actor: ctx.actor, reason: "Explicit operator read-only test verification", result: "quarantined", kind: "independent_transaction_check", outcome: { outcome: "unknown", reason: "authentication", nextAction: "manual_review", reissue: false } }];
    touch(record, ctx.now);
    appendAudit(state, ctx, "paystack.test_verification", earlier!, "An earlier build's check.");
    await saveState(ctx, state);
  });
  report = await run(earlier!);
  assert.deepEqual([report.result, report.exitCode, report.observationCreated], ["verified", 0, true]);
  event = await stored(earlier!);
  assert.equal(event.status, "verified");
  assert.equal(event.data.replayHistory.length, 2, "the earlier check stays in the history");
  // A real disagreement quarantines an event for good.
  reply = (payment) => json({ status: true, data: { ...payment, amount: Number(payment.amount) + 1 } });
  report = await run(disagreeing!);
  assert.deepEqual([report.result, report.exitCode, report.eventStatus], ["mismatch", 1, "quarantined"]);
  const before = lookups;
  reply = (payment) => json({ status: true, data: payment });
  report = await run(disagreeing!);
  assert.deepEqual([report.result, report.exitCode], ["held_for_review", 1]);
  assert.equal(lookups, before, "an event held for a disagreement is not looked up again");
  assert.ok(!JSON.stringify(await pool.query("SELECT data FROM valopay_records WHERE merchant_id=$1", [lender]).then((result) => result.rows)).includes(key), "the key is never stored");
  console.log("Paystack verification PostgreSQL checks passed: a refused key leaves the event awaiting verification with its outcome in its history and audit trail, the same event then verifies once, an earlier build's quarantine after a refused key verifies again, and a real disagreement stays held without another lookup.");
} finally {
  globalThis.fetch = realFetch;
  for (const name of names) { const value = previous[name]; if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  const hash = digest(`demo:${token}`);
  for (const table of ["valopay_idempotency", "valopay_records"])
    await pool.query(`DELETE FROM ${table} WHERE merchant_id IN (SELECT m.id FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id WHERE w.principal_hash=$1)`, [hash]);
  await pool.query("DELETE FROM valopay_merchants WHERE workspace_id IN (SELECT id FROM valopay_workspaces WHERE principal_hash=$1)", [hash]);
  await pool.query("DELETE FROM valopay_workspaces WHERE principal_hash=$1", [hash]);
  await pool.end();
}
