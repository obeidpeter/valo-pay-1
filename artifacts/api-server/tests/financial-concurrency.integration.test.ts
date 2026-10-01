/** PC02: actual PostgreSQL transactions, with 100 simultaneous contenders.
 * Uses the same workspace gate, lender lock, domain guards, save, audit and
 * idempotency APIs as the application. No financial/provider call is made.
 * This establishes app-path serialisation, not protection from a privileged
 * SQL bypass or external exactly-once execution. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { MoneyArithmeticError } from "@workspace/valopay-schema";
import { requireLoopback } from "./throwaway-database.js";

if (process.env.VALOPAY_RUN_INTEGRATION !== "1") {
  console.log("Set VALOPAY_RUN_INTEGRATION=1 to run 100-way financial races against a disposable loopback PostgreSQL database.");
  process.exit(0);
}
requireLoopback("Financial concurrency", new URL(process.env.DATABASE_URL!));

const { pool } = await import("@workspace/db");
const store = await import("../src/lib/valopay-store.js");
const { DatabaseLimitError } = await import("../src/lib/database-limits.js");
const { wasRolledBack } = await import("../src/lib/transaction-outcome.js");
const { connectedRevision, runConnectedAction } = await import("../src/domain/connected.js");
const { allocatePayment } = await import("../src/domain/reconciliation.js");
const { makeRecord, recordsOf } = await import("../src/domain/records.js");
const { requestFingerprint, verifyAuditChain } = await import("../src/lib/digests.js");
type State = Parameters<typeof store.saveState>[1];
type Context = Parameters<typeof store.saveState>[0];

const token = randomBytes(32).toString("hex");
const request = (merchantId?: string) => ({
  headers: { cookie: `valopay_sandbox=${token}` }, query: merchantId ? { merchantId } : {}, secure: false,
  auth: Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true }),
}) as any;
const response = () => ({ cookie() {} }) as any;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const pending: Promise<unknown>[] = [];
let capacityRetries = 0;
let merchantId = "";

/** Retry only a bounded-capacity failure that the transaction owner explicitly
 * confirms rolled back. Never retry an unknown commit outcome. */
async function write<T>(fn: (state: State, ctx: Context) => Promise<T> | T): Promise<T> {
  for (let retry = 0; ; retry++) {
    try {
      return await store.inWorkspace(request(merchantId), response(), async (ctx) => {
        const state = await store.loadState(ctx, merchantId, "update");
        return fn(state, ctx);
      });
    } catch (error) {
      if (!(error instanceof DatabaseLimitError) || !wasRolledBack(error) || retry >= 4) throw error;
      capacityRetries++;
      await sleep(error.retryAfterSeconds * 1_000);
    }
  }
}
const read = <T>(fn: (state: State) => T) => store.inWorkspace(request(merchantId), response(), async (ctx) => fn(await store.loadState(ctx, merchantId, "share")), "read");

/** Hold the database lender row while every contender is launched. Confirm
 * that requests reached PostgreSQL before releasing the barrier. The normal
 * application connection caps stay active; this is 100 concurrent callers,
 * not a claim that 100 database connections hold the same lock at once. */
async function race<T>(fn: (index: number) => Promise<T>): Promise<PromiseSettledResult<T>[]> {
  const holder = await pool.connect();
  let outcomes!: Promise<PromiseSettledResult<T>[]>;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM valopay_merchants WHERE id=$1 FOR UPDATE", [merchantId]);
    const contenders = Array.from({ length: 100 }, (_, index) => fn(index));
    outcomes = Promise.allSettled(contenders);
    pending.push(outcomes);
    let waiting = 0;
    for (let attempt = 0; attempt < 100 && waiting < Math.min(2, store.lenderConnections); attempt++) {
      await holder.query("SELECT pg_stat_clear_snapshot()");
      waiting = Number((await holder.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()")).rows[0].n);
      if (waiting < Math.min(2, store.lenderConnections)) await sleep(10);
    }
    assert.ok(waiting >= 1, "real PostgreSQL contenders wait behind the lender-row barrier");
    await holder.query("COMMIT");
    return await outcomes;
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
    if (outcomes) await outcomes;
  }
}
async function persisted() {
  return (await pool.query("SELECT id,kind,status,amount_kobo,customer_id,data,updated_at FROM valopay_records WHERE merchant_id=$1 ORDER BY id", [merchantId])).rows;
}
const reason = "Synthetic 100-way architecture concurrency test";

try {
  const merchants = await store.inWorkspace(request(), response(), store.listMerchants);
  merchantId = merchants[0]!.id;
  let customerId = "", allocationDueId = "", paymentId = "", checkoutDueId = "", intentId = "", replayDueId = "";
  await write(async (state, ctx) => {
    assert.equal(ctx.accessMode, "sandbox");
    assert.equal(state.merchant.mode, "observation");
    customerId = recordsOf(state, "customers")[0]!.id;
    const due = (label: string) => makeRecord(state, "due-items", {
      name: label, customerId, amountKobo: 500_000, reference: `SYN-RACE-${randomUUID()}`, status: "scheduled", createdAt: ctx.now,
      data: { owner: "valopay", dueDate: ctx.now.slice(0, 10), outstandingKobo: 500_000 },
    });
    allocationDueId = due("Concurrent allocation").id;
    checkoutDueId = due("Concurrent payment authorisation").id;
    replayDueId = due("Concurrent idempotent checkout").id;
    paymentId = makeRecord(state, "payments", {
      name: "Synthetic receipt", reference: `SYN-RECEIPT-${randomUUID()}`, customerId, amountKobo: 500_000, status: "received", createdAt: ctx.now,
      data: { channel: "transfer", collectionStatus: "succeeded", settlementStatus: "settled", allocatedKobo: 0, reversalStatus: "none", refundStatus: "none", currency: "NGN" },
    }).id;
    const result = runConnectedAction(state, ctx, { action: "payment.create", data: { dueItemId: checkoutDueId, amountKobo: 500_000 }, expectedRevision: connectedRevision(state), reason });
    intentId = (result as any).id;
    assert.ok(intentId);
    store.appendAudit(state, ctx, "test.financial.fixture", merchantId, reason);
    await store.saveState(ctx, state);
  });

  // 100 competing allocations of 20,000 can consume this 500,000 receipt only
  // 25 times. Both receipt and obligation must conserve exactly, including SQL.
  const allocations = await race(() => write(async (state, ctx) => {
    const payment = recordsOf(state, "payments").find((record) => record.id === paymentId)!;
    const due = recordsOf(state, "due-items").find((record) => record.id === allocationDueId)!;
    const allocation = allocatePayment(state, ctx, payment, due, 20_000, "MANUAL", "manual", false, reason);
    store.appendAudit(state, ctx, "test.financial.allocate", allocation.id, reason);
    await store.saveState(ctx, state);
    return allocation.id;
  }));
  assert.equal(allocations.filter((result) => result.status === "fulfilled").length, 25);
  for (const result of allocations) if (result.status === "rejected") {
    assert.ok(!(result.reason instanceof DatabaseLimitError), "every contender reached a financial decision after bounded capacity retries");
    assert.match(result.reason.message, /left to allocate|outstanding|already|paid|closed/);
  }
  await read((state) => {
    const applied = recordsOf(state, "allocations").filter((record) => record.status === "confirmed" && record.data.paymentId === paymentId);
    assert.equal(applied.length, 25);
    assert.equal(applied.reduce((total, record) => total + BigInt(record.amountKobo), 0n), 500_000n);
    assert.equal(recordsOf(state, "payments").find((record) => record.id === paymentId)!.data.allocatedKobo, 500_000);
    assert.equal(recordsOf(state, "due-items").find((record) => record.id === allocationDueId)!.data.outstandingKobo, 0);
  });
  const sqlAllocation = (await pool.query("SELECT count(*) AS n, sum(amount_kobo)::text AS total FROM valopay_records WHERE merchant_id=$1 AND kind='allocations' AND status='confirmed' AND data->>'paymentId'=$2", [merchantId, paymentId])).rows[0];
  assert.deepEqual([Number(sqlAllocation.n), sqlAllocation.total], [25, "500000"]);

  // Refresh the connected revision inside each locked transaction, so stale
  // revisions cannot hide a broken current-state exclusion check. Half the
  // contenders authorise the checkout; half record a competing synthetic
  // external instruction. Only one durable in-flight claim may survive.
  const authorisations = await race((index) => write(async (state, ctx) => {
    if (index % 2 === 0) {
      runConnectedAction(state, ctx, { action: "payment.authorise", recordId: intentId, data: {}, expectedRevision: connectedRevision(state), reason });
    } else {
      makeRecord(state, "attempts", { name: "Synthetic external attempt", customerId, amountKobo: 500_000, status: "sent", createdAt: ctx.now, data: { dueItemId: checkoutDueId, source: "external", owner: "lms" } });
    }
    store.appendAudit(state, ctx, "test.financial.authorise", checkoutDueId, reason);
    await store.saveState(ctx, state);
    return index % 2 === 0 ? "checkout" : "external_evidence";
  }));
  assert.equal(authorisations.filter((result) => result.status === "fulfilled").length, 1);
  for (const result of authorisations) if (result.status === "rejected") assert.equal(result.reason.status, 409);
  await read((state) => {
    const active = state.records.filter((record) => record.data.dueItemId === checkoutDueId && (
      (record.kind === "connected-intents" && ["authorised", "pending", "unknown"].includes(record.status)) ||
      (record.kind === "attempts" && ["scheduled", "sent", "unknown"].includes(record.status))));
    assert.equal(active.length, 1);
  });

  // 100 identical request replays must return one ID and persist one receipt,
  // one checkout and one audit event, with the normal idempotency API.
  const key = store.digest(`financial-concurrency:${merchantId}:${randomUUID()}`);
  const input = { action: "payment.create", data: { dueItemId: replayDueId, amountKobo: 500_000 }, expectedRevision: await read(connectedRevision), reason };
  const replays = await race(() => write(async (state, ctx) => {
    const fingerprint = requestFingerprint({ input, actor: ctx.actor });
    const prior = await store.findIdempotency(ctx, key);
    if (prior) {
      assert.equal(prior.request_hash, fingerprint);
      return prior.response;
    }
    const record = runConnectedAction(state, ctx, input) as any;
    store.appendAudit(state, ctx, "test.financial.replay", replayDueId, reason);
    await store.saveState(ctx, state);
    const answer = { recordId: record.id };
    await store.saveIdempotency(ctx, key, fingerprint, answer);
    return answer;
  }));
  assert.equal(replays.filter((result) => result.status === "fulfilled").length, 100);
  const ids = new Set(replays.map((result) => (result as PromiseFulfilledResult<any>).value.recordId));
  assert.equal(ids.size, 1);
  assert.ok(!ids.has(undefined));
  assert.equal(await read((state) => recordsOf(state, "connected-intents").filter((record) => record.data.dueItemId === replayDueId).length), 1);
  assert.equal(Number((await pool.query("SELECT count(*) AS n FROM valopay_records WHERE merchant_id=$1 AND kind='audit' AND data->>'action'='test.financial.replay'", [merchantId])).rows[0].n), 1);

  // A caller bypassing the allocation domain still cannot commit an
  // over-allocation through saveState. No partial row/audit survives rollback.
  const before = await persisted();
  await assert.rejects(() => write(async (state, ctx) => {
    makeRecord(state, "allocations", { name: "Synthetic bypass attempt", status: "confirmed", customerId, amountKobo: 1, createdAt: ctx.now, data: { paymentId, dueItemId: allocationDueId, rule: "MANUAL", confidence: "manual", automatic: false } });
    store.appendAudit(state, ctx, "test.financial.invalid", allocationDueId, reason);
    await store.saveState(ctx, state);
  }), /More has been allocated than the payment’s amount/);
  assert.deepEqual(await persisted(), before);

  // SQL NUMERIC SUM can exceed the v1 number contract even when every row is
  // safe. Both naira obligations and foreign-currency credit must fail closed
  // at the read-model boundary, before Number can round the aggregate.
  for (const kind of ["due-items", "payments"] as const) {
    const overflowCustomer = await write(async (state, ctx) => {
      const customer = makeRecord(state, "customers", { name: `Synthetic ${kind} overflow`, reference: `SYN-OVERFLOW-${randomUUID()}`, createdAt: ctx.now, data: { consentProvenance: "Synthetic fixture only" } });
      for (let index = 0; index < 2; index++) {
        if (kind === "due-items") makeRecord(state, kind, { name: "Synthetic high obligation", reference: `SYN-HIGH-${randomUUID()}`, status: "scheduled", customerId: customer.id, amountKobo: Number.MAX_SAFE_INTEGER, createdAt: ctx.now, data: { owner: "lms", dueDate: ctx.now.slice(0, 10), outstandingKobo: Number.MAX_SAFE_INTEGER } });
        else makeRecord(state, kind, { name: "Synthetic foreign credit", reference: `SYN-HIGH-${randomUUID()}`, status: "received", customerId: customer.id, amountKobo: Number.MAX_SAFE_INTEGER, createdAt: ctx.now, data: { channel: "transfer", currency: "USD", allocatedKobo: 0, collectionStatus: "succeeded", settlementStatus: "settled", refundStatus: "none", reversalStatus: "none" } });
      }
      store.appendAudit(state, ctx, "test.financial.overflow", customer.id, reason);
      await store.saveState(ctx, state);
      return customer.id;
    });
    await assert.rejects(() => store.inWorkspace(request(merchantId), response(), (ctx) => store.getCustomerHistory(ctx, merchantId, overflowCustomer, {}), "read"), (error: unknown) => error instanceof MoneyArithmeticError && error.code === "MONEY_OUT_OF_RANGE");
  }
  const audit = (await pool.query("SELECT data FROM valopay_records WHERE merchant_id=$1 AND kind='audit' ORDER BY (data->>'sequence')::integer", [merchantId])).rows;
  assert.equal(verifyAuditChain(audit).valid, true);
  console.log(`Financial PostgreSQL concurrency passed: 100 allocation contenders (25 accepted), 100 checkout/instruction contenders (1 accepted), 100 idempotent replays (1 checkout), rollback conservation, SQL money overflow and audit. Capacity retries: ${capacityRetries}. No external effect was attempted.`);
} finally {
  await Promise.allSettled(pending);
  const principalHash = store.digest(`demo:${token}`);
  for (const table of ["valopay_idempotency", "valopay_records"] as const) {
    await pool.query(`DELETE FROM ${table} WHERE merchant_id IN (SELECT m.id FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id WHERE w.principal_hash=$1)`, [principalHash]);
  }
  await pool.query("DELETE FROM valopay_merchants WHERE workspace_id IN (SELECT id FROM valopay_workspaces WHERE principal_hash=$1)", [principalHash]);
  await pool.query("DELETE FROM valopay_workspaces WHERE principal_hash=$1", [principalHash]);
  await pool.end();
}
