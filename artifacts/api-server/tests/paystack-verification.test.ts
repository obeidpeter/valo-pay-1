import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { seedMerchant } from "../src/lib/valopay-seed";
import { makeRecord } from "../src/domain/records";
import { reconcile } from "../src/domain/reconciliation";
import {
  createPaystackTestAdapter,
  parsePaystackTestWebhook,
} from "../src/providers/paystack";
import {
  receivePaystackEvent,
  assertProviderEventChange,
  quarantinedWithoutDisagreement,
  replayProviderEvent,
} from "../src/providers/paystack-inbox";
import {
  paystackTestConnectionIdentity,
  verifyQueuedPaystackEvent,
  type PaystackVerificationTransaction,
} from "../src/providers/paystack-verification";
import type { DomainState } from "../src/domain/types";

process.env.DATABASE_URL ||= "postgres://unused:unused@127.0.0.1:1/unused";
const { assertFinalState } = await import("../src/lib/valopay-store");
const key = ["sk", "test", "OFFLINE", "FIXTURE", "0".repeat(20)].join("_");
const connectionId = "a".repeat(64);
const ctx = {
  now: "2026-09-26T10:00:00.000Z",
  actor: "System · Paystack test verification",
  role: "Operations",
};
const reference = "SYNTHETIC-VERIFICATION-001";
let checks = 0;
async function check(run: () => Promise<void> | void) {
  await run();
  checks++;
}
function fixture(mode: "test" | "fixture" = "test") {
  let state = seedMerchant("verification-lender");
  state.merchant.mode = "observation";
  state.merchant.killSwitch = true;
  const due = state.records.find(
    (r) => r.kind === "due-items" && r.reference === "DEMO-LOAN-1005",
  )!;
  const attempt = makeRecord(state, "attempts", {
    name: "Saved test collection expectation",
    status: "unknown",
    reference,
    customerId: due.customerId,
    amountKobo: due.amountKobo,
    createdAt: ctx.now,
    data: {
      source: "external",
      dueItemId: due.id,
      currency: "NGN",
      providerConnection: paystackTestConnectionIdentity(connectionId),
      providerReference: reference,
      failureCode: "TIMEOUT_UNKNOWN",
    },
  });
  const payment = {
    id: "9990001",
    domain: "test",
    status: "success",
    reference,
    amount: due.amountKobo,
    currency: "NGN",
    channel: "direct_debit",
  };
  const raw = Buffer.from(
    JSON.stringify({ event: "charge.success", data: payment }),
  );
  const signed = parsePaystackTestWebhook(
    raw,
    createHmac("sha512", key).update(raw).digest("hex"),
    key,
  );
  const event = receivePaystackEvent(state, ctx, signed, {
    connectionId,
    mode,
  }).event;
  let calls = 0,
    locked = false,
    beforeReply = () => {},
    failCommit = false,
    loseReply = false;
  const adapter = createPaystackTestAdapter({
    secretKey: key,
    fetch: async (url, init) => {
      assert.equal(
        locked,
        false,
        "provider lookup must occur outside the lender transaction",
      );
      assert.equal(
        String(url),
        `https://api.paystack.co/transaction/verify/${reference}`,
      );
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "error");
      calls++;
      beforeReply();
      return new Response(JSON.stringify({ status: true, data: payment }));
    },
  });
  const transact: PaystackVerificationTransaction = async (
    id,
    write,
    apply,
  ) => {
    assert.equal(id, connectionId);
    locked = true;
    try {
      const copy = structuredClone(state);
      const result = apply(copy, ctx);
      if (write) {
        assertFinalState(state, copy, state.merchant.id);
        if (failCommit) throw new Error("Synthetic failed commit");
        state = copy;
        if (loseReply) {
          loseReply = false;
          throw new Error("Synthetic response loss after commit");
        }
      }
      return result;
    } finally {
      locked = false;
    }
  };
  const run = () =>
    verifyQueuedPaystackEvent({
      connectionId,
      eventId: event.id,
      transact,
      adapter,
    });
  return {
    run,
    adapter,
    transact,
    payment,
    eventId: event.id,
    attemptId: attempt.id,
    state: () => state,
    calls: () => calls,
    onReply: (fn: () => void) => {
      beforeReply = fn;
    },
    failCommit: () => {
      failCommit = true;
    },
    loseReply: () => {
      loseReply = true;
    },
  };
}

await check(async () => {
  const f = fixture(),
    before = structuredClone(f.state());
  const result = await f.run();
  assert.equal(result.status, "verified");
  assert.equal(result.observationCreated, true);
  assert.equal(result.financialRecordsCreated, 0);
  const event = f.state().records.find((r) => r.id === f.eventId)!;
  assertProviderEventChange(
    before.records.find((r) => r.id === f.eventId)!,
    event,
  );
  assert.equal(
    f.state().records.filter((r) => r.kind === "payments").length,
    before.records.filter((r) => r.kind === "payments").length,
  );
  assert.equal(
    f
      .state()
      .records.filter(
        (r) => r.kind === "observations" && r.data.providerEventId === event.id,
      ).length,
    1,
  );
  assert.throws(
    () =>
      replayProviderEvent(
        f.state(),
        { ...ctx, role: "Finance" },
        event.id,
        event.updatedAt,
        "Review verified sample evidence",
      ),
    /already has an independently verified/,
  );
  assert.equal((await f.run()).observationCreated, false);
  assert.equal(
    f.calls(),
    1,
    "a completed event never performs a second lookup or creates another observation",
  );
  reconcile(f.state(), ctx);
  const canonical = f
    .state()
    .records.filter((r) => r.kind === "payments" && r.reference === reference);
  assert.equal(canonical.length, 1);
  assert.equal(canonical[0]!.data.collectionStatus, "succeeded");
  assert.equal(
    canonical[0]!.data.settlementStatus,
    "unsettled",
    "transaction success never fabricates settlement",
  );
  reconcile(f.state(), ctx);
  assert.equal(
    f
      .state()
      .records.filter((r) => r.kind === "payments" && r.reference === reference)
      .length,
    1,
  );
});
await check(async () => {
  const f = fixture("fixture");
  await assert.rejects(f.run, /fixtures cannot be promoted/);
  assert.equal(f.calls(), 0);
});
for (const change of [
  "live",
  "stop_released",
  "wrong_connection",
  "wrong_subject",
  "wrong_amount",
] as const)
  await check(async () => {
    const f = fixture(),
      attempt = f.state().records.find((r) => r.id === f.attemptId)!;
    if (change === "live") f.state().settings.environment = "production";
    if (change === "stop_released") f.state().merchant.killSwitch = false;
    if (change === "wrong_connection")
      attempt.data.providerConnection = "another-provider";
    if (change === "wrong_subject") attempt.customerId = "another-customer";
    if (change === "wrong_amount") attempt.amountKobo++;
    await assert.rejects(f.run);
    assert.equal(f.calls(), 0);
  });
for (const change of ["attempt", "signed", "authority"] as const)
  await check(async () => {
    const f = fixture();
    f.onReply(() => {
      if (change === "attempt")
        f.state().records.find((r) => r.id === f.attemptId)!.data.version = 2;
      if (change === "signed")
        f.state().records.find((r) => r.id === f.eventId)!.data.payloadDigest =
          "b".repeat(64);
      if (change === "authority") f.state().settings.environment = "production";
    });
    await assert.rejects(
      f.run,
      /changed during verification|synthetic workspace/,
    );
    assert.equal(
      f
        .state()
        .records.filter(
          (r) =>
            r.kind === "observations" && r.data.providerEventId === f.eventId,
        ).length,
      0,
    );
  });
await check(async () => {
  const f = fixture();
  f.onReply(() => {
    const event = f.state().records.find((record) => record.id === f.eventId)!;
    event.data.replayHistory = Array.from({ length: 100 }, () => ({ at: ctx.now, actor: ctx.actor, reason: "Concurrent synthetic check", result: "awaiting_verification" }));
  });
  await assert.rejects(f.run, /check limit/);
  assert.equal(f.state().records.filter((r) => r.kind === "observations" && r.data.providerEventId === f.eventId).length, 0);
});
await check(async () => {
  const f = fixture();
  f.payment.id = "9990002";
  assert.equal((await f.run()).status, "quarantined");
  assert.equal(
    f
      .state()
      .records.filter(
        (r) =>
          r.kind === "observations" && r.data.providerEventId === f.eventId,
      ).length,
    0,
  );
});
await check(async () => {
  const f = fixture();
  f.payment.status = "ongoing";
  assert.equal((await f.run()).status, "awaiting_verification");
  assert.equal(
    f
      .state()
      .records.filter(
        (r) =>
          r.kind === "observations" && r.data.providerEventId === f.eventId,
      ).length,
    0,
  );
});
await check(async () => {
  const f = fixture();
  const adapter = createPaystackTestAdapter({
    secretKey: key,
    fetch: async () => new Response("{}", { status: 404 }),
  });
  const result = await verifyQueuedPaystackEvent({
    connectionId,
    eventId: f.eventId,
    transact: f.transact,
    adapter,
  });
  assert.equal(
    result.status,
    "awaiting_verification",
    "not found does not establish no payment or permit a replacement",
  );
  assert.equal(result.observationCreated, false);
});
await check(async () => {
  const f = fixture(),
    before = structuredClone(f.state());
  f.failCommit();
  await assert.rejects(f.run, /failed commit/);
  assert.deepEqual(f.state(), before);
});
await check(async () => {
  const f = fixture();
  f.loseReply();
  await assert.rejects(f.run, /response loss/);
  assert.equal((await f.run()).observationCreated, false);
  assert.equal(f.calls(), 1);
});
await check(async () => {
  const f = fixture();
  await f.run();
  f.state().records = f
    .state()
    .records.filter(
      (r) =>
        !(r.kind === "observations" && r.data.providerEventId === f.eventId),
    );
  await assert.rejects(f.run, /missing its retained observation/);
  assert.equal(
    f.calls(),
    1,
    "an incomplete restore must not silently recreate evidence",
  );
});
// Only a real disagreement quarantines a test event. A refused key, an unreadable or
// live-mode answer, a timeout or another transport failure leaves it awaiting
// verification, with a history entry naming the outcome, so a later check verifies it.
const eventOf = (f: ReturnType<typeof fixture>) =>
  f.state().records.find((r) => r.id === f.eventId)!;
const observationsOf = (f: ReturnType<typeof fixture>) =>
  f
    .state()
    .records.filter(
      (r) => r.kind === "observations" && r.data.providerEventId === f.eventId,
    ).length;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const answering = (
  reply: () => Response | Promise<Response>,
  timeoutMs?: number,
) =>
  createPaystackTestAdapter({
    secretKey: key,
    ...(timeoutMs ? { timeoutMs } : {}),
    fetch: async () => reply(),
  });
for (const [name, reply, outcome] of [
  ["A 401", () => json({ status: false, message: `Invalid key ${key}` }, 401), "credentials_refused"],
  ["An unreadable body", () => new Response("<html>Gateway page</html>"), "invalid_response"],
  ["A live-mode answer", (payment) => json({ status: true, data: { ...payment, domain: "live" } }), "live_mode"],
  ["A timeout", () => new Promise<Response>(() => {}), "provider_unavailable"],
] as Array<[string, (payment: Record<string, unknown>) => Response | Promise<Response>, string]>)
  await check(async () => {
    const f = fixture(),
      before = structuredClone(eventOf(f));
    const result = await verifyQueuedPaystackEvent({
      connectionId,
      eventId: f.eventId,
      transact: f.transact,
      adapter: answering(() => reply(f.payment), name === "A timeout" ? 5 : undefined),
    });
    assert.equal(result.status, "awaiting_verification", `${name} leaves the event awaiting verification`);
    assert.equal(result.outcome, outcome, `${name} is named ${outcome}`);
    assert.equal(result.observationCreated, false);
    const event = eventOf(f);
    assertProviderEventChange(before, event);
    assert.equal(event.status, "awaiting_verification");
    assert.equal(event.data.replayHistory.at(-1).check, outcome);
    assert.equal(event.data.replayHistory.at(-1).result, "awaiting_verification");
    assert.ok(!JSON.stringify(event).includes(key), "the key is never recorded");
    assert.equal(observationsOf(f), 0);
    // Once the key or the provider is put right, the same event verifies.
    assert.equal((await f.run()).status, "verified");
    assert.equal(observationsOf(f), 1);
  });
for (const [name, change] of [
  ["amount", {}],
  ["currency", { currency: "USD" }],
  ["channel", { channel: "card" }],
  ["identity", { id: "9990002" }],
  ["failure", { status: "failed" }],
  ["reversal", { status: "reversed" }],
] as Array<[string, Record<string, unknown>]>)
  await check(async () => {
    const f = fixture();
    const payment = { ...f.payment, ...change, ...(name === "amount" ? { amount: f.payment.amount + 1 } : {}) };
    const result = await verifyQueuedPaystackEvent({
      connectionId,
      eventId: f.eventId,
      transact: f.transact,
      adapter: answering(() => json({ status: true, data: payment })),
    });
    assert.equal(result.status, "quarantined", `a conflicting ${name} quarantines the event`);
    assert.equal(result.outcome, "mismatch");
    assert.equal(eventOf(f).data.replayHistory.at(-1).check, "mismatch");
    assert.equal(observationsOf(f), 0);
    await assert.rejects(f.run, (error: any) => error.outcome === "held_for_review");
    assert.equal(f.calls(), 0, "a real disagreement is not checked again");
  });
// An earlier build quarantined events after a refused key or an unreadable or live-mode answer,
// and reported a test transaction in another currency as unreadable too, so an earlier
// invalid_response may be a real disagreement. Such an event can be checked again, but only a
// conclusive answer changes it: an inconclusive check is recorded and leaves it quarantined, still
// checkable, while a matching answer verifies it, a pending one awaits and another currency
// quarantines it for good. An event quarantined for a disagreement stays held.
const quarantineEarlier = (f: ReturnType<typeof fixture>, reason: string) => {
  const event = eventOf(f);
  event.status = "quarantined";
  event.data.message = "Independent verification could not validate this evidence. The recorded reason requires operator review; no observation was created.";
  event.data.replayHistory = [{ at: ctx.now, actor: ctx.actor, reason: "Explicit operator read-only test verification", result: "quarantined", kind: "independent_transaction_check", outcome: { outcome: "unknown", reason, nextAction: "manual_review", reissue: false } }];
};
for (const [reason, answer] of [
  ["authentication", "matching"],
  ["invalid_response", "matching"],
  ["invalid_response", "another currency"],
  ["live_mode", "matching"],
  ["authentication", "pending"],
] as const)
  await check(async () => {
    const f = fixture();
    quarantineEarlier(f, reason);
    for (const [reply, timeoutMs, outcome] of [
      [() => json({ status: false, message: `Invalid key ${key}` }, 401), undefined, "credentials_refused"],
      [() => new Promise<Response>(() => {}), 5, "provider_unavailable"],
    ] as Array<[() => Response | Promise<Response>, number | undefined, string]>) {
      const before = structuredClone(eventOf(f));
      const result = await verifyQueuedPaystackEvent({ connectionId, eventId: f.eventId, transact: f.transact, adapter: answering(reply, timeoutMs) });
      assert.deepEqual([result.status, result.outcome], ["quarantined", outcome], `an inconclusive check leaves an earlier ${reason} quarantine held`);
      const event = eventOf(f);
      assertProviderEventChange(before, event);
      assert.equal(event.data.replayHistory.at(-1).check, outcome);
      assert.equal(quarantinedWithoutDisagreement(event), true, "and it can still be checked again");
      assert.throws(() => replayProviderEvent(structuredClone(f.state()), { ...ctx, role: "Finance" }, event.id, event.updatedAt, "Recheck the held receipt"), /cannot be replayed/);
    }
    const payment = answer === "another currency" ? { ...f.payment, currency: "USD" } : answer === "pending" ? { ...f.payment, status: "ongoing" } : f.payment;
    const result = await verifyQueuedPaystackEvent({ connectionId, eventId: f.eventId, transact: f.transact, adapter: answering(() => json({ status: true, data: payment })) });
    const expected = { matching: ["verified", "verified"], pending: ["awaiting_verification", "pending"], "another currency": ["quarantined", "mismatch"] }[answer];
    assert.deepEqual([result.status, result.outcome], expected, `${answer} decides an earlier ${reason} quarantine`);
    assert.equal(eventOf(f).data.replayHistory.length, 4, "every check stays in its history");
    assert.equal(observationsOf(f), answer === "matching" ? 1 : 0);
    if (answer === "another currency") await assert.rejects(f.run, (error: any) => error.outcome === "held_for_review");
    assert.equal(f.calls(), 0, "a disagreement is not looked up again");
  });
await check(async () => {
  const f = fixture();
  quarantineEarlier(f, "mismatch");
  await assert.rejects(f.run, (error: any) => error.outcome === "held_for_review");
  assert.equal(f.calls(), 0);
});
// Each refusal names its own outcome.
for (const [change, outcome] of [
  ["fixture", "not_a_test_payment"],
  ["live", "lender_not_eligible"],
  ["stop_released", "lender_not_eligible"],
  ["wrong_amount", "expectation_mismatch"],
  ["missing_event", "event_not_found"],
] as const)
  await check(async () => {
    const f = fixture(change === "fixture" ? "fixture" : "test");
    if (change === "live") f.state().settings.environment = "production";
    if (change === "stop_released") f.state().merchant.killSwitch = false;
    if (change === "wrong_amount") f.state().records.find((r) => r.id === f.attemptId)!.amountKobo++;
    const eventId = change === "missing_event" ? "missing-event" : f.eventId;
    await assert.rejects(verifyQueuedPaystackEvent({ connectionId, eventId, transact: f.transact, adapter: f.adapter }), (error: any) => error.outcome === outcome);
    assert.equal(f.calls(), 0);
  });
await check(async () => {
  const f = fixture();
  f.onReply(() => { f.state().records.find((r) => r.id === f.attemptId)!.data.version = 2; });
  await assert.rejects(f.run, (error: any) => error.outcome === "evidence_changed");
});
// The command's report: one named outcome, its exit status and a fixed message without secrets.
await check(async () => {
  const { paystackVerificationReport } = await import("../src/lib/paystack-verification");
  const exits = {
    verified: 0, pending: 2, reference_not_found: 2, provider_unavailable: 2, invalid_response: 2, lender_unavailable: 2, database_unavailable: 2,
    credentials_refused: 1, live_mode: 1, mismatch: 1, evidence_changed: 1, held_for_review: 1, not_configured: 1, usage: 1, failed: 1,
  } as const;
  for (const [outcome, exitCode] of Object.entries(exits)) {
    const report = paystackVerificationReport(Object.assign(new Error("Refused."), { outcome }));
    assert.equal(report.result, outcome);
    assert.equal(report.exitCode, exitCode, `${outcome} exits ${exitCode}`);
    assert.ok(report.message);
  }
  const unexpected = paystackVerificationReport(new Error(`postgres://user:${key}@db.invalid/valopay`));
  assert.deepEqual([unexpected.result, unexpected.exitCode], ["failed", 1]);
  assert.ok(!unexpected.message.includes(key), "an unexpected error's own words are never printed");
  const awaiting = paystackVerificationReport({ status: "awaiting_verification", outcome: "credentials_refused", message: "Kept.", observationCreated: false, financialRecordsCreated: 0, instructions: "disabled" });
  assert.deepEqual([awaiting.result, awaiting.exitCode, awaiting.eventStatus], ["credentials_refused", 1, "awaiting_verification"]);
  // A database the settings name wrongly is put right, not waited for: a database that does not exist, or a login
  // or a right it refuses, exits 1; a connection refused, lost or timed out, or a busy lender, is checked again later.
  const { DatabaseLimitError } = await import("../src/lib/database-limits");
  const connect = (code: string) => new DatabaseLimitError("database_unavailable", { write: true, cause: Object.assign(new Error(`connect failed for ${key}`), { code }) });
  for (const [error, outcome, exitCode] of [
    [connect("3D000"), "not_configured", 1],
    [connect("28P01"), "not_configured", 1],
    [connect("28000"), "not_configured", 1],
    [connect("42501"), "not_configured", 1],
    [Object.assign(new Error("permission denied"), { code: "42501" }), "not_configured", 1],
    [connect("ECONNREFUSED"), "database_unavailable", 2],
    [connect("57P03"), "database_unavailable", 2],
    [new DatabaseLimitError("pool_timeout", { write: true }), "database_unavailable", 2],
    [Object.assign(new Error("Refused."), { outcome: "lender_not_found" }), "lender_not_found", 1],
    [Object.assign(new Error("Refused."), { outcome: "lender_unavailable" }), "lender_unavailable", 2],
  ] as Array<[Error, string, number]>) {
    const report = paystackVerificationReport(error);
    assert.deepEqual([report.result, report.exitCode], [outcome, exitCode], `${(error.cause as { code?: string } | undefined)?.code ?? error.message} is ${outcome}`);
    assert.ok(!report.message.includes(key));
  }
});
console.log(
  `Paystack verification: ${checks} offline fixed-origin, current-authority, immutable-evidence, rollback and reconciliation checks passed.`,
);
