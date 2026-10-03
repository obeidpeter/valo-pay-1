import { SANDBOX_COOKIE } from "../src/lib/sandbox-cookie";
// Allocation decisions against a real database (UX-B01 and UX-B01-PG): a
// decision names the proposal it was made on, by proposalId and
// proposalUpdatedAt. Two decisions for one payment sent at the same time, with
// different Idempotency-Keys, are taken one after the other under the lender's
// lock: exactly one is applied, the other is refused, and the payment is
// applied once. A decision quoting a proposal that was superseded meanwhile
// (rejected, then replaced when reconciliation ran again) is 409, and one
// without the pair is refused, naming what it lacks: neither saves anything,
// and each closes its journal entry as cancelled. An edit without the version
// it was made on (UX-B01-GEN) is refused in the same way. Both are refused once
// a keyed repeat has been answered and the lender is loaded, so a repeat of an
// edit an earlier build saved without its version gets its stored result.
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";

if (process.env.VALO_PAY_1_RUN_INTEGRATION !== "1") {
  console.log("Set VALO_PAY_1_RUN_INTEGRATION=1 to check allocation decisions against a disposable PostgreSQL database.");
  process.exit(0);
}
// A placeholder identity key: nothing here reaches the identity provider.
process.env.CLERK_SECRET_KEY ??= "sk_test_placeholder";
const { pool } = await import("@workspace/valo-pay-1-db");
const { default: router } = await import("../src/routes/index");
const { errorHandler } = await import("../src/lib/error-handler");
const store = await import("../src/lib/valo-pay-1-store");
const { requestFingerprint } = await import("../src/lib/digests");
const { buildConsoleSettings } = await import("../src/lib/valo-pay-1-close-views");
const { schedulerStatus } = await import("../src/lib/close-scheduler");

const quiet = { info() {}, warn() {}, error() {} };
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((req, _res, next) => {
  (req as any).auth = Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true });
  (req as any).log = quiet;
  next();
});
app.use("/api", router);
app.use("/api", (_req, res) => { res.status(404).json({ error: "Unknown resource.", requestId: "allocation-decisions" }); });
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const cookie = `${SANDBOX_COOKIE}=${randomBytes(32).toString("hex")}`;
type Answer = { status: number; data: any; operation: string | null };
/** A request as the console sends a write: with its own Idempotency-Key, so the journal records it. */
async function call(path: string, method = "GET", body?: unknown, key = method === "GET" ? undefined : randomUUID()): Promise<Answer> {
  const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie, ...(key ? { "Idempotency-Key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json(), operation: response.headers.get("X-Valopay-Operation") };
}
const ok = (result: Answer) => { assert.equal(result.status, 200, JSON.stringify(result.data).slice(0, 800)); return result.data; };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** A request as a route makes it, for work the test runs in the store directly. */
const sandboxRequest = (merchantId: string) => ({ headers: { cookie }, query: { merchantId }, secure: false, log: quiet, auth: Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true }) }) as any;
const sandboxResponse = { cookie() {} } as any;
let workspaceId: string | undefined;
let checks = 0;
try {
  const workspace = ok(await call("/v1/workspace"));
  const lender = workspace.merchants[0].id as string;
  workspaceId = (await pool.query("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [lender])).rows[0].workspace_id;
  const q = (path: string) => `${path}${path.includes("?") ? "&" : "?"}merchantId=${lender}`;
  const run = randomUUID().slice(0, 8);
  /** Everything the lender holds, its audit trail included: a refused request leaves it exactly as it was. */
  const saved = async () => JSON.stringify([
    (await pool.query("SELECT info, settings FROM valopay_merchants WHERE id=$1", [lender])).rows,
    (await pool.query("SELECT id, kind, status, amount_kobo, customer_id, data, updated_at FROM valopay_records WHERE merchant_id=$1 ORDER BY id", [lender])).rows,
  ]);
  /** The state of a request's journal entry, by the id its answer names. */
  const journal = async (answer: Answer) => {
    assert.ok(answer.operation, `a keyed request names its journal entry: ${JSON.stringify(answer.data).slice(0, 300)}`);
    return (await pool.query("SELECT status FROM valopay_operations WHERE id=$1", [answer.operation])).rows[0]?.status as string;
  };
  /** A refusal that saved nothing: the lender unchanged, and its journal entry cancelled, never completed. */
  const refusedUnsaved = async (answer: Answer, before: string, label: string) => {
    assert.equal(await saved(), before, `${label}: nothing is saved`);
    assert.equal(await journal(answer), "cancelled", `${label}: the journal entry is cancelled`);
    assert.equal(answer.data.operation, "cancelled", `${label}: and the answer says so`);
    checks += 3;
  };
  const record = async (kind: string, id: string) => ok(await call(q(`/v1/records/${kind}?id=${encodeURIComponent(id)}`))).items[0];
  const allocationsOf = async (paymentId: string) => (ok(await call(q("/v1/records/allocations"))).items as any[]).filter((item) => item.data.paymentId === paymentId);
  const proposalOf = async (paymentId: string) => (await allocationsOf(paymentId)).find((item) => item.status === "proposed");
  const reconcile = async () => ok(await call(q("/v1/actions"), "POST", { action: "run_reconciliation", reason: "Match the fixture's transfer." }));
  /**
   * A payer with two instalments and a transfer to their dedicated virtual account of a different amount: rule R3
   * proposes it against the older instalment, and, once that match is rejected, against the next one.
   */
  const proposedPayment = async (label: string) => {
    const reference = `DECISION-${label}-${run}`;
    const customer = ok(await call(q("/v1/records/customers"), "POST", { name: `Decision customer ${label}`, reference, data: { consentProvenance: "Synthetic fixture" } }));
    const dues = [];
    for (const [index, dueDate] of ["2026-10-01", "2026-11-01"].entries()) dues.push(ok(await call(q("/v1/records/due-items"), "POST", { name: `Decision instalment ${label} ${index + 1}`, reference: `${reference}-DUE-${index + 1}`, customerId: customer.id, amountKobo: 1_000_000, data: { dueDate, owner: "lms" } })));
    ok(await call(q("/v1/records/observations"), "POST", { name: `Transfer ${label}`, status: "unresolved", reference: `${reference}-TRF`, customerId: customer.id, amountKobo: 600_000, data: { source: "transfer", provider: "Sandbox Rail", eventId: `${reference}-event`, virtualAccountCustomerId: customer.id } }));
    await reconcile();
    const payment = (ok(await call(q(`/v1/records/payments?search=${encodeURIComponent(`${reference}-TRF`)}`))).items as any[]).find((item) => item.reference === `${reference}-TRF`);
    assert.ok(payment, `${label}: reconciliation made the transfer a payment`);
    const proposal = await proposalOf(payment.id);
    assert.deepEqual([payment.status, proposal?.data.rule, proposal?.data.dueItemId, proposal?.amountKobo], ["proposed", "R3", dues[0].id, 600_000], `${label}: R3 proposes the transfer against the older instalment`);
    checks += 2;
    return { payment, proposal, dues };
  };
  const decide = (action: string, paymentId: string, data?: Record<string, unknown>) => call(q("/v1/actions"), "POST", { action, recordId: paymentId, reason: "Finance checked the evidence.", ...(data ? { data } : {}) });
  const pair = (proposal: { id: string; updatedAt: string }) => ({ proposalId: proposal.id, proposalUpdatedAt: proposal.updatedAt });
  const refusedAsDecided = (answer: Answer) => answer.status === 409 || (answer.status === 400 && /This payment has no proposed match to review\. Reload the page to see its current status\./.test(answer.data.error));

  // ---- 1. Two decisions sent together: exactly one is applied, and the payment once ----
  // Both are sent while another transaction holds the lender's lock, so both are waiting when it is released.
  const monitor = await pool.connect();
  const lockWaiters = async () => Number((await monitor.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0].n);
  const together = async (send: () => Promise<Answer>[]) => {
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM valopay_merchants WHERE id=$1 FOR UPDATE", [lender]);
      const answers = Promise.all(send());
      const expected = Math.min(2, store.lenderConnections);
      for (let attempt = 0; attempt < 150 && await lockWaiters() < expected; attempt++) await sleep(20);
      assert.ok(await lockWaiters() >= expected, "both decisions reached the lender before either ran");
      await sleep(100);
      await holder.query("COMMIT");
      return await answers;
    } finally { holder.release(); }
  };
  try { for (const [label, actions] of [["confirm-reject", ["confirm_allocation", "reject_allocation"]], ["confirm-confirm", ["confirm_allocation", "confirm_allocation"]]] as const) {
    const { payment, proposal, dues } = await proposedPayment(label);
    const answers = await together(() => actions.map((action) => decide(action, payment.id, pair(proposal))));
    const winners = answers.filter((answer) => answer.status === 200), losers = answers.filter((answer) => answer.status !== 200);
    assert.deepEqual([winners.length, losers.length], [1, 1], `${label}: exactly one decision is applied: ${JSON.stringify(answers.map((answer) => [answer.status, answer.data.error ?? answer.data.message]))}`);
    assert.ok(refusedAsDecided(losers[0]!), `${label}: the other is refused as already decided: ${JSON.stringify(losers[0]!.data)}`);
    assert.deepEqual([await journal(winners[0]!), await journal(losers[0]!)], ["completed", "cancelled"], `${label}: the journal records one completed decision and one cancelled`);
    const confirmed = winners[0]!.data.record.status === "confirmed";
    const decided = await allocationsOf(payment.id), applied = decided.filter((item) => item.status === "confirmed");
    assert.deepEqual(decided.map((item) => [item.id, item.status]), [[proposal.id, confirmed ? "confirmed" : "superseded"]], `${label}: the one proposal is decided once, and no other allocation is made`);
    const [paymentNow, dueNow] = [await record("payments", payment.id), await record("due-items", dues[0].id)];
    assert.equal(applied.reduce((sum, item) => sum + item.amountKobo, 0), confirmed ? 600_000 : 0, `${label}: the payment is applied once`);
    assert.deepEqual([paymentNow.data.allocatedKobo ?? 0, dueNow.data.outstandingKobo], confirmed ? [600_000, 400_000] : [0, 1_000_000], `${label}: the payment and the instalment carry one decision`);
    checks += 7;
  } } finally { monitor.release(); }

  // ---- 2. A decision quoting a proposal superseded meanwhile is 409, and one without the pair is refused ----
  {
    const { payment, proposal: first, dues } = await proposedPayment("superseded");
    // Another Finance user rejects the proposal this screen shows, and reconciliation proposes the next instalment.
    ok(await decide("reject_allocation", payment.id, pair(first)));
    await reconcile();
    const second = await proposalOf(payment.id);
    assert.deepEqual([second?.data.dueItemId, second?.data.rule], [dues[1].id, "R3"], "the rejected match is not proposed again: the next instalment is");
    for (const action of ["confirm_allocation", "reject_allocation"]) {
      const before = await saved();
      const stale = await decide(action, payment.id, pair(first));
      assert.equal(stale.status, 409, `${action} quoting the superseded proposal: ${JSON.stringify(stale.data)}`);
      assert.match(stale.data.error, /^This proposed match changed after you opened it\. Reload the page and try again\.$/);
      await refusedUnsaved(stale, before, `${action} quoting the superseded proposal`);
      // The current proposal's id with the superseded one's version is stale too.
      const mixed = await decide(action, payment.id, { proposalId: second.id, proposalUpdatedAt: first.updatedAt });
      assert.equal(mixed.status, 409, JSON.stringify(mixed.data));
      await refusedUnsaved(mixed, before, `${action} with an outdated version`);
      checks += 3;
    }
    // Without the pair, or half of it, a decision is refused by name before anything is read.
    const fields = (answer: Answer) => (answer.data.details ?? []).map((detail: { field: string }) => detail.field);
    for (const [data, missing] of [[undefined, ["data.proposalId", "data.proposalUpdatedAt"]], [{ proposalId: second.id }, ["data.proposalUpdatedAt"]], [{ proposalUpdatedAt: second.updatedAt }, ["data.proposalId"]]] as const) {
      const before = await saved();
      const refused = await decide("confirm_allocation", payment.id, data);
      assert.deepEqual([refused.status, fields(refused)], [400, missing], `a decision with ${JSON.stringify(data)} names ${missing.join(" and ")}: ${JSON.stringify(refused.data)}`);
      await refusedUnsaved(refused, before, `a decision without ${missing.join(" and ")}`);
      checks += 1;
    }
    // The pair is checked once the lender is loaded, before the payment or its proposal is read: a decision without it
    // waits behind another writer to the lender, as any decision does, and is then refused by name.
    {
      const before = await saved(), holder = await pool.connect();
      let refused: Answer | undefined;
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM valopay_merchants WHERE id=$1 FOR UPDATE", [lender]);
        const waiting = decide("reject_allocation", payment.id).then((answer) => { refused = answer; return answer; });
        const lockWaiters = async () => Number((await pool.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0].n);
        for (let attempt = 0; attempt < 150 && await lockWaiters() < 1; attempt++) await sleep(20);
        await sleep(100);
        assert.deepEqual([await lockWaiters() > 0, refused?.status], [true, undefined], `a decision without the pair waits for the lender: ${JSON.stringify(refused?.data)}`);
        await holder.query("COMMIT");
        await waiting;
      } finally { await holder.query("ROLLBACK").catch(() => undefined); holder.release(); }
      assert.deepEqual([refused!.status, fields(refused!)], [400, ["data.proposalId", "data.proposalUpdatedAt"]], `then it is refused by name: ${JSON.stringify(refused!.data)}`);
      await refusedUnsaved(refused!, before, "a decision without the pair sent while the lender was busy");
      checks += 2;
    }
    // The current proposal, its version written as the same instant with an offset, is confirmed once.
    const offset = new Date(Date.parse(second.updatedAt) + 3_600_000).toISOString().replace("Z", "+01:00");
    const confirmed = ok(await decide("confirm_allocation", payment.id, { proposalId: second.id, proposalUpdatedAt: offset }));
    assert.deepEqual([confirmed.record.id, confirmed.record.status, (await record("payments", payment.id)).data.allocatedKobo, (await record("due-items", dues[1].id)).data.outstandingKobo], [second.id, "confirmed", 600_000, 400_000], "the current proposal is applied, its version compared as an instant");
    checks += 2;
  }

  // ---- 3. An edit without the version it was made on, or with an empty one, is refused by name, and saves nothing ----
  {
    const customer = ok(await call(q("/v1/records/customers"), "POST", { name: "Versioned edit customer", reference: `DECISION-EDIT-${run}`, data: { consentProvenance: "Synthetic fixture" } }));
    const settings = ok(await call(q("/v1/settings")));
    const fields = (answer: Answer) => (answer.data.details ?? []).map((detail: { field: string }) => detail.field);
    for (const [path, body, field, version] of [[`/v1/records/customers/${customer.id}`, { name: "Renamed without a version" }, "expectedUpdatedAt", customer.updatedAt], ["/v1/settings", { contactRoute: "Changed without a revision" }, "expectedRevision", settings.revision]] as const) {
      for (const [label, sent] of [["without", body], ["with an empty", { ...body, [field]: "" }]] as const) {
        const before = await saved();
        const refused = await call(q(path), "PATCH", sent);
        assert.deepEqual([refused.status, fields(refused)], [400, [field]], `PATCH ${path} ${label} ${field}: ${JSON.stringify(refused.data)}`);
        await refusedUnsaved(refused, before, `PATCH ${path} ${label} ${field}`);
        checks += 1;
      }
      ok(await call(q(path), "PATCH", { ...body, [field]: version }));
      checks += 1;
    }
  }

  // ---- 4. An edit an earlier build saved without its version: a keyed repeat, or a retry from Operations, gets its result ----
  {
    /**
     * A keyed PATCH as an earlier build, which did not require the version, ran it: journaled, applied with no version
     * check, audited, and its answer kept for its repeats. Resolves to its journal entry and its answer.
     */
    const savedByEarlierBuild = async (path: string, body: Record<string, unknown>, key: string, objectId: string, apply: (state: any, ctx: any) => unknown) => {
      const earlier = sandboxRequest(lender);
      const { id } = await store.inWorkspace(earlier, sandboxResponse, (ctx) => store.prepareOperation(ctx, lender, key, { method: "PATCH", path, body }));
      store.bindOperation(earlier, id, lender, true);
      const answer = await store.inWorkspace(earlier, sandboxResponse, async (ctx) => {
        const state = await store.loadState(ctx, lender, "update");
        const result = apply(state, ctx), changes = store.settleChanges(ctx, state), stored = JSON.parse(JSON.stringify(result));
        store.appendAudit(state, ctx, `patch.${path.split("/").slice(2).join(".")}`, objectId, "Synthetic workspace operation", changes);
        await store.saveState(ctx, state);
        await store.saveIdempotency(ctx, store.receiptOf(earlier, lender, key, "workspace").id, requestFingerprint({ path, method: "PATCH", body, actor: ctx.actor }), stored);
        return stored;
      });
      return { id, answer };
    };
    const customer = ok(await call(q("/v1/records/customers"), "POST", { name: "Edited by an earlier build", reference: `DECISION-EARLIER-${run}`, data: { consentProvenance: "Synthetic fixture" } }));
    const edits: Array<[string, Record<string, unknown>, string, (state: any, ctx: any) => unknown]> = [
      [`/v1/records/customers/${customer.id}`, { name: "Renamed by an earlier build" }, customer.id, (state) => Object.assign(state.records.find((item: any) => item.id === customer.id), { name: "Renamed by an earlier build" })],
      ["/v1/settings", { contactRoute: "Changed by an earlier build" }, "workspace", (state, ctx) => { Object.assign(state.settings, { contactRoute: "Changed by an earlier build" }); return buildConsoleSettings(state, ctx.role, ctx.now, schedulerStatus()); }],
    ];
    for (const [path, body, objectId, apply] of edits) {
      const key = randomUUID(), { id, answer } = await savedByEarlierBuild(path, body, key, objectId, apply);
      const before = await saved();
      for (const [label, repeat] of [["a repeat with its key", () => call(q(path), "PATCH", body, key)], ["a retry from Operations", () => call(q(`/v1/operations/${id}/retry`), "POST")]] as const) {
        const answered = await repeat();
        assert.equal(answered.status, 200, `${label} of PATCH ${path} saved without a version gets its stored result: ${JSON.stringify(answered.data)}`);
        assert.deepEqual([answered.data, answered.operation], [answer, id], `${label} of PATCH ${path}: the stored result, under its journal entry`);
        assert.equal(await saved(), before, `${label} of PATCH ${path} saves nothing again`);
        assert.equal(await journal(answered), "completed", `${label} of PATCH ${path}: its journal entry stays completed`);
        checks += 4;
      }
    }
  }
} finally {
  server.close();
  await once(server, "close");
  if (workspaceId) {
    for (const table of ["valopay_idempotency", "valopay_operations", "valopay_records"]) await pool.query(`DELETE FROM ${table} WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)`, [workspaceId]);
    await pool.query("DELETE FROM valopay_merchants WHERE workspace_id=$1", [workspaceId]);
    await pool.query("DELETE FROM valopay_workspaces WHERE id=$1", [workspaceId]);
  }
  await pool.end();
}
console.log(`Allocation decision checks passed (${checks} checks): two decisions for one payment sent together apply exactly one, and the payment once; a decision quoting a superseded proposal is 409 and one without proposalId and proposalUpdatedAt is refused by name, both saving nothing and cancelling their journal entries; the version is compared as an instant, and the pair is checked once the lender is loaded; an edit without its version, or with an empty one, is refused by name, and a keyed repeat of one an earlier build saved without it gets its stored result.`);
