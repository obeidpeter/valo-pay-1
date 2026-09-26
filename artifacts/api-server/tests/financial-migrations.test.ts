// FIN-02/03: persisted earlier shapes, explicit authority, provider-scoped payouts and repeat passes.
// These are offline domain/store-invariant tests: no database or provider calls.
import assert from "node:assert/strict";
import { addAttempt, addObservation, ctxAt, liveFixture, outstandingOf, wat } from "./helpers.js";
import { allocatePayment, applyConfirmedAllocation, reconcile, releaseDispute, reversePayment } from "../src/domain/reconciliation.js";
import { executeAction } from "../src/domain/actions.js";
import { evaluateRetry } from "../src/domain/policy-engine.js";
import { connectedRevision, runConnectedAction } from "../src/domain/connected.js";
import { makeRecord, recordsOf } from "../src/domain/records.js";
import type { DomainState, TypedRecord } from "../src/domain/types.js";
const { assertFinalState } = await import("../src/lib/valopay-store.js");
const now = wat("2027-07-03T10:00:00"), finance = ctxAt(now, "Finance");
function transaction<T>(state: DomainState, run: () => T): T {
  const before = structuredClone(state);
  const value = run();
  assertFinalState(before, state, state.merchant.id, now);
  return value;
}
const run = (state: DomainState) => transaction(state, () => reconcile(state, finance));
const resolve = (state: DomainState, review: TypedRecord<"exceptions">, code: string) => transaction(state, () => executeAction(state, finance, { action: "resolve_exception", recordId: review.id, reason: "Provider evidence checked for the renewed review.", data: { resolutionCode: code } }));
function legacyReversal(disposition: "waiting" | "aside" | "allocated" | "reversed", code = "provider_state_adopted") {
  const { state, due } = liveFixture({ withFailure: false, merchantId: `legacy-${disposition}-${code}` });
  addAttempt(state, due, { status: "succeeded", occurredAt: wat("2027-07-01T07:00:00"), providerReference: "OLD-REVERSAL" });
  const reversal = addObservation(state, { reference: "OLD-REVERSAL", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: "old-reversal", reversed: true, occurredAt: wat("2027-07-01T08:00:00") });
  reconcile(state, ctxAt(wat("2027-07-02T09:00:00"), "Finance"));
  const old = recordsOf(state, "exceptions").find((item) => item.data.linkedRecordId === reversal.id)!;
  Object.assign(old, { status: "resolved", updatedAt: wat("2027-07-02T09:30:00") });
  Object.assign(old.data, { resolutionCode: code, resolvedAt: old.updatedAt, resolvedBy: "Earlier Finance", notes: "Original provider review." });
  old.data.resolutionRuleVersion = 1; // Build historical financial effects before restoring the actual unversioned snapshot below.
  if (disposition !== "waiting") Object.assign(reversal, { status: "resolved", data: { ...reversal.data, resolutionKey: "reversal_set_aside_after_review", resolvedTo: `exception:${old.id}` } });
  const payment = makeRecord(state, "payments", { name: "Earlier receipt", status: "unallocated", reference: "OLD-REVERSAL", customerId: due.customerId, amountKobo: due.amountKobo, createdAt: wat("2027-07-02T10:00:00"), data: { providerReference: "OLD-REVERSAL", providerConnection: "Sandbox Rail", currency: "NGN", channel: "direct_debit", collectionStatus: "succeeded", settlementStatus: "settled", reversalStatus: "none", refundStatus: "none", allocatedKobo: 0, dueItemId: due.id } });
  if (disposition === "allocated" || disposition === "reversed") allocatePayment(state, finance, payment, due, due.amountKobo, "R1", "certain", true);
  if (disposition === "reversed") {
    reversePayment(state, finance, payment);
    Object.assign(reversal.data, { paymentId: payment.id, resolutionKey: "canonical_provider_reference" });
    delete reversal.data.resolvedTo;
  }
  delete old.data.resolutionRuleVersion; // Actual earlier persisted shape, including PR59.
  return { state, due, reversal, old, payment };
}

// Direct actions must hold immediately after loading an earlier snapshot, before a migration reconciliation ran.
for (const link of ["attempt", "allocation", "observation", "payment"] as const) {
  const { state, due, reversal, old, payment } = legacyReversal("waiting");
  if (link !== "attempt") state.records = state.records.filter((record) => record.kind !== "attempts" || record.data.dueItemId !== due.id);
  if (link !== "payment") delete payment.data.dueItemId;
  if (link === "observation") reversal.data.dueItemId = due.id;
  const proposal = makeRecord(state, "allocations", { name: "Earlier proposal", status: "proposed", customerId: due.customerId, amountKobo: due.amountKobo, data: { paymentId: payment.id, dueItemId: link === "allocation" ? due.id : "unrelated", rule: "R5", confidence: "probable", automatic: true } });
  const snapshot = structuredClone(state);
  assert.throws(() => allocatePayment(state, finance, payment, due, due.amountKobo, "manual", "manual", false), /renewed Finance review/);
  assert.deepEqual(state, snapshot, "refusal does not first rewrite historical state");
  proposal.data.dueItemId = due.id;
  assert.throws(() => applyConfirmedAllocation(state, finance, proposal), /renewed Finance review/);
  proposal.data.dueItemId = link === "allocation" ? due.id : "unrelated";
  const policy = recordsOf(state, "policies")[0]!;
  assert.equal(evaluateRetry(state, finance, due, policy).rule, "reversal_review");
  due.status = "in_dispute";
  assert.throws(() => releaseDispute(state, finance, due, { via: "not_upheld", reason: "Ordinary dispute release" }), /renewed reversal review/);
  due.status = "scheduled";
  assert.throws(() => runConnectedAction(state, finance, { action: "payment.create", reason: "New checkout", recordId: "", data: { dueItemId: due.id, amountKobo: due.amountKobo }, expectedRevision: connectedRevision(state) }), /renewed Finance review/);
  const intent = makeRecord(state, "connected-intents", { name: "Earlier checkout", status: "created", customerId: due.customerId, amountKobo: due.amountKobo, data: { dueItemId: due.id, expiresAt: wat("2027-07-03T10:10:00"), events: [] } });
  assert.throws(() => runConnectedAction(state, finance, { action: "payment.authorise", reason: "Continue checkout", recordId: intent.id, data: {}, expectedRevision: connectedRevision(state) }), /renewed Finance review/);
  intent.status = "pending"; // An earlier authorised checkout can still deliver evidence while the hold exists.
  runConnectedAction(state, finance, { action: "payment.outcome", reason: "Existing checkout receipt", recordId: intent.id, data: { outcome: "confirmed" }, expectedRevision: connectedRevision(state) });
  const receipt = recordsOf(state, "payments").find((record) => record.id === intent.data.paymentId)!;
  assert.equal(intent.status, "confirmed");
  assert.equal(receipt.data.allocatedKobo, 0, "late receipt is retained without applying money to the held instalment");
  assert.equal(old.data.resolutionRuleVersion, undefined);
}

for (const code of ["provider_state_adopted", "platform_state_confirmed", "escalated_to_provider"]) {
  const { state, due, reversal, old, payment } = legacyReversal("waiting", code);
  const oldSnapshot = structuredClone(old), evidenceSnapshot = structuredClone(reversal);
  run(state); run(state);
  const reviews = recordsOf(state, "exceptions").filter((item) => item.data.legacyResolutionReview);
  assert.equal(reviews.length, 1);
  const review = reviews[0]!;
  assert.deepEqual(old, oldSnapshot);
  assert.deepEqual(reversal, evidenceSnapshot);
  assert.equal(review.status, "open");
  assert.equal(payment.data.allocatedKobo, 0);
  assert.equal(due.status, "in_dispute");
  assert.throws(() => allocatePayment(state, finance, payment, due, due.amountKobo, "manual", "manual", false), /dispute|renewed Finance review/);
  assert.throws(() => releaseDispute(state, finance, due, { via: "finance_release", reason: "Attempt to bypass review" }), /renewed reversal review/);
  assert.throws(() => executeAction(structuredClone(state), ctxAt(now, "Operations"), { action: "resolve_exception", recordId: review.id, reason: "Attempt to bypass Finance", data: { resolutionCode: "provider_state_adopted" } }), (error: any) => error.status === 403);
  resolve(state, review, "provider_state_adopted");
  run(state); run(state);
  assert.deepEqual(old, oldSnapshot);
  assert.equal(payment.data.reversalStatus, "reversed");
  assert.equal(payment.data.allocatedKobo, 0);
  assert.equal(payment.data.legacyReversalReviewIds, undefined);
  assert.equal(outstandingOf(due), due.amountKobo);
  assert.equal(recordsOf(state, "exceptions").filter((item) => item.data.legacyResolutionReview).length, 1);
}
for (const disposition of ["aside", "allocated"] as const) {
  for (const decision of ["provider_state_adopted", "platform_state_confirmed"]) {
    const { state, due, reversal, old, payment } = legacyReversal(disposition);
    const oldSnapshot = structuredClone(old), reversalSnapshot = structuredClone(reversal);
    const allocations = structuredClone(recordsOf(state, "allocations").filter((item) => item.data.paymentId === payment.id));
    run(state);
    const review = recordsOf(state, "exceptions").find((item) => item.data.legacyResolutionReview)!;
    assert.deepEqual(old, oldSnapshot);
    assert.deepEqual(reversal, reversalSnapshot);
    assert.deepEqual(recordsOf(state, "allocations").filter((item) => item.data.paymentId === payment.id), allocations);
    assert.equal((review.data.legacyResolutionReview as { priorObservation: { resolvedTo: string } }).priorObservation.resolvedTo, `exception:${old.id}`);
    resolve(state, review, decision);
    run(state); run(state);
    assert.deepEqual(old, oldSnapshot);
    assert.equal(payment.data.reversalStatus, decision === "provider_state_adopted" ? "reversed" : "none");
    assert.equal(outstandingOf(due), decision === "platform_state_confirmed" && disposition === "allocated" ? 0 : due.amountKobo);
    assert.equal(due.status, "in_dispute", "the earlier collection pause requires an explicit release after reviewing the result");
    if (decision === "platform_state_confirmed") {
      transaction(state, () => releaseDispute(state, finance, due, { via: "finance_release", reason: "Provider confirmed no reversal; historical allocations checked." }));
      run(state);
      assert.equal(payment.data.allocatedKobo, due.amountKobo);
      assert.equal(outstandingOf(due), 0);
    }
  }
}
{
  const { state, old, payment } = legacyReversal("waiting");
  old.data.resolvedAt = wat("2027-07-04T10:00:00"); // Earlier host clock was ahead of the current reviewer.
  run(state);
  const review = recordsOf(state, "exceptions").find((item) => item.data.legacyResolutionReview)!;
  resolve(state, review, "provider_state_adopted");
  run(state);
  assert.equal(payment.data.reversalStatus, "reversed", "explicit renewal supersedes its named prior decision even across clock skew");
}
{
  const { state, old, payment } = legacyReversal("reversed");
  const oldSnapshot = structuredClone(old), allocations = structuredClone(recordsOf(state, "allocations").filter((item) => item.data.paymentId === payment.id));
  run(state);
  const review = recordsOf(state, "exceptions").find((item) => item.data.legacyResolutionReview)!;
  resolve(state, review, "platform_state_confirmed");
  run(state);
  assert.deepEqual(old, oldSnapshot);
  assert.equal(payment.data.reversalStatus, "reversed", "renewed review never invents money by undoing an applied historical reversal");
  assert.deepEqual(recordsOf(state, "allocations").filter((item) => item.data.paymentId === payment.id), allocations);
}

function settlementState() {
  const { state } = liveFixture({ withFailure: false, merchantId: "provider-payouts" });
  return state;
}
function line(state: DomainState, provider: string, currency = "NGN", reference = `PAY-${provider}`, batchReference = "SHARED") {
  return addObservation(state, { reference, amountKobo: 99_500, grossAmountKobo: 100_000, feeKobo: 500, batchReference, source: "settlement", eventId: `line-${provider}-${reference}`, occurredAt: wat("2027-07-01T08:00:00"), provider: "Same vendor", providerConnection: provider, currency } as any);
}
function credit(state: DomainState, provider: string, amountKobo = 99_500, currency = "NGN") {
  return addObservation(state, { reference: `STMT-${provider}`, amountKobo, batchReference: "SHARED", source: "statement", eventId: `credit-${provider}`, occurredAt: wat("2027-07-01T09:00:00"), provider: "Same vendor", providerConnection: provider, currency } as any);
}
for (const order of [["connection-a", "connection-b"], ["connection-b", "connection-a"]]) {
  for (const statementFirst of [true, false]) {
    for (const secondCurrency of ["NGN", "USD"]) {
      const state = settlementState();
      if (statementFirst) { credit(state, "connection-a"); run(state); }
      for (const provider of order) line(state, provider, provider === "connection-b" ? secondCurrency : "NGN");
      if (!statementFirst) credit(state, "connection-a");
      run(state); run(state);
      const batches = recordsOf(state, "settlement-batches").filter((item) => item.reference === "SHARED");
      assert.equal(batches.length, 2);
      const a = batches.find((item) => item.data.providerConnection === "connection-a")!, b = batches.find((item) => item.data.providerConnection === "connection-b")!;
      assert.deepEqual([a.status, a.data.grossKobo, a.data.netKobo, a.data.statementNetKobo], ["reconciled", 100_000, 99_500, 99_500]);
      assert.deepEqual([b.status, b.data.grossKobo, b.data.netKobo, b.data.statementNetKobo, b.data.currency], ["pending", 100_000, 99_500, undefined, secondCurrency]);
      credit(state, "connection-b", 99_500, secondCurrency);
      run(state);
      assert.equal(b.status, "reconciled");
      assert.equal(b.data.statementNetKobo, 99_500);
    }
  }
}
{
  const state = settlementState();
  line(state, " Connection-A ");
  credit(state, "connection-a");
  run(state);
  assert.equal(recordsOf(state, "settlement-batches").find((item) => item.reference === "SHARED")!.status, "reconciled", "provider identity uses the shared deterministic normalisation");
}
{
  const state = settlementState(), aLine = line(state, "connection-a"), bLine = line(state, "connection-b");
  const aCredit = credit(state, "connection-a", 199_000);
  run(state);
  const batches = recordsOf(state, "settlement-batches").filter((item) => item.reference === "SHARED"), a = batches.find((item) => item.data.providerConnection === "connection-a")!, b = batches.find((item) => item !== a)!;
  // Exact pre-fix collision shape: a reference-only lookup counted both providers and matched A's combined credit.
  state.records = state.records.filter((item) => item.id !== b.id && !(item.kind === "exceptions" && [a.id, b.id].includes(String(item.data.linkedRecordId))));
  Object.assign(a.data, { lineObservationIds: [aLine.id, bLine.id], linePaymentIds: [aLine.data.paymentId, bLine.data.paymentId], grossKobo: 200_000, feeKobo: 1_000, expectedFeeKobo: 1_000, netKobo: 199_000, statementNetKobo: 199_000 });
  delete a.data.providerIdentityKey;
  a.status = "reconciled";
  bLine.data.settlementBatchId = a.id;
  const totals = [a.data.grossKobo, a.data.feeKobo, a.data.netKobo, a.data.statementNetKobo], links = structuredClone([aLine.data, bLine.data, aCredit.data]);
  run(state); run(state);
  assert.equal(a.status, "variance");
  assert.deepEqual([a.data.grossKobo, a.data.feeKobo, a.data.netKobo, a.data.statementNetKobo], totals, "legacy totals are preserved, never guessed or silently redistributed");
  assert.deepEqual([aLine.data, bLine.data, aCredit.data], links, "historical evidence links stay intact for review");
  const identityReview = a.data.providerIdentityReview as { previous: { status: string }; identities: string[] };
  assert.equal(identityReview.previous.status, "reconciled");
  assert.equal(identityReview.identities.length, 2);
  assert.equal(recordsOf(state, "exceptions").filter((item) => item.data.condition === `settlement_variance:${a.id}:provider_identity`).length, 1);
  const later = line(state, "connection-b", "NGN", "LATER-B");
  run(state);
  assert.equal(later.data.providerIdentityHeld, true);
  assert.equal(recordsOf(state, "settlement-batches").filter((item) => item.reference === "SHARED").length, 1);
  assert.deepEqual([a.data.grossKobo, a.data.feeKobo, a.data.netKobo, a.data.statementNetKobo], totals);
}
{
  const state = settlementState();
  line(state, "connection-a");
  const foreign = credit(state, "connection-b");
  run(state);
  const batch = recordsOf(state, "settlement-batches").find((item) => item.reference === "SHARED")!;
  assert.equal(foreign.status, "unresolved");
  // Another actual legacy shape: a foreign provider's credit was linked to an otherwise single-provider batch.
  Object.assign(foreign, { status: "resolved" }); Object.assign(foreign.data, { resolvedTo: `batch:${batch.id}`, resolutionKey: "settlement_batch_net_credit" });
  Object.assign(batch.data, { statementObservationId: foreign.id, statementNetKobo: 99_500 }); batch.status = "reconciled";
  run(state);
  assert.equal(batch.status, "variance");
  assert.ok(batch.data.providerIdentityReview);
  assert.equal(foreign.data.resolvedTo, `batch:${batch.id}`);
}

// Review fix: a settlement line naming a provider and another connection is checked against one fee schedule, its
// provider's, at its first count and when its debit's gross completes it later, in either arrival order.
{
  const GROSS = 2_500_000, FEE = 25_000; // Provider P charges 1%; connection C's schedule would charge 2%.
  const settle = (order: "line first" | "debit first") => {
    const { state, due } = liveFixture({ withFailure: false, merchantId: `line-schedule-${order.split(" ")[0]}` });
    state.settings.providerFeeSchedule = { ...state.settings.providerFeeSchedule, "Provider P": { bps: 100 }, "Connection C": { bps: 200 } };
    addAttempt(state, due, { status: "succeeded", occurredAt: wat("2027-07-01T06:00:00"), providerReference: "PSK-FEE-1" });
    const through = { provider: "Provider P", providerConnection: "Connection C" };
    const debit = () => addObservation(state, { reference: "PSK-FEE-1", amountKobo: GROSS, source: "webhook", customerId: due.customerId, eventId: "fee-debit", occurredAt: wat("2027-07-01T06:30:00"), ...through } as any);
    // A net line: it states what it paid out and its fee, not its gross.
    const line = () => addObservation(state, { reference: "PSK-FEE-1", amountKobo: GROSS - FEE, feeKobo: FEE, batchReference: "B-FEE", source: "settlement", customerId: due.customerId, eventId: "fee-line", occurredAt: wat("2027-07-01T08:00:00"), ...through } as any);
    const first = order === "line first" ? line() : debit();
    run(state);
    const second = order === "line first" ? debit() : line();
    const counted = order === "line first" ? first : second;
    const batch = () => recordsOf(state, "settlement-batches").find((item) => item.reference === "B-FEE")!;
    const atFirstCount = order === "line first" ? [batch().status, counted.data.expectedFeeKobo] : undefined;
    run(state);
    addObservation(state, { reference: "STMT-FEE", amountKobo: GROSS - FEE, batchReference: "B-FEE", source: "statement", eventId: "fee-credit", occurredAt: wat("2027-07-01T09:00:00"), ...through } as any);
    run(state); run(state);
    const payments = recordsOf(state, "payments").filter((item) => item.reference === "PSK-FEE-1");
    return { atFirstCount, payments: payments.map((item) => [item.amountKobo, item.data.grossUnstated ?? false]), line: [counted.data.countedGrossKobo, counted.data.assumedFeeKobo, counted.data.expectedFeeKobo, counted.data.feeVarianceKobo], batch: [batch().status, batch().data.grossKobo, batch().data.feeKobo, batch().data.expectedFeeKobo, batch().data.feeVarianceKobo, (batch().data.feeSchedule as { bps?: number } | undefined)?.bps] };
  };
  const lineFirst = settle("line first"), debitFirst = settle("debit first");
  assert.deepEqual(lineFirst.atFirstCount, ["pending", FEE], "the first count checks the net line's fee against its provider's schedule, so it is not a variance");
  assert.deepEqual(lineFirst.payments, [[GROSS, false]], "the debit's gross completes the payment the net line made");
  assert.deepEqual(lineFirst.line, [GROSS, FEE, FEE, undefined], "completing the gross keeps the expected fee the line was counted with");
  assert.deepEqual(lineFirst.batch, ["reconciled", GROSS, FEE, FEE, 0, 100], "the batch reconciles with its provider's schedule");
  assert.deepEqual([debitFirst.line, debitFirst.batch], [lineFirst.line, lineFirst.batch], "the order the line and its debit arrive in changes nothing");
}
console.log("Financial migration regressions passed: unversioned reversal authority, renewed Finance review, prior allocations/dispositions, replay, provider-scoped settlement and legacy quarantine.");
