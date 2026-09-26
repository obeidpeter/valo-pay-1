// FIN-02/03: persisted earlier shapes, explicit authority, provider-scoped payouts and repeat passes.
// These are offline domain/store-invariant tests: no database or provider calls.
import assert from "node:assert/strict";
import { addAttempt, addObservation, ctxAt, liveFixture, outstandingOf, wat } from "./helpers.js";
import { allocatePayment, applyConfirmedAllocation, raiseException, reconcile, releaseDispute, reversePayment, supersedeAllocation } from "../src/domain/reconciliation.js";
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
function legacyReversal(disposition: "waiting" | "aside" | "allocated" | "reversed", code = "provider_state_adopted", history?: (fixture: { state: DomainState; due: TypedRecord<"due-items">; payment: TypedRecord<"payments"> }) => void) {
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
  history?.({ state, due, payment });
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
    // The hold never changed the paid instalment and gives the paused one its status back, with no release: only an adopted
    // reversal of money applied to it puts it in dispute, and a confirmed receipt then pays the one it collects.
    const expected = decision === "provider_state_adopted" ? [disposition === "allocated" ? "in_dispute" : "scheduled", due.amountKobo, 0] : ["paid", 0, due.amountKobo];
    assert.deepEqual([due.status, outstandingOf(due), payment.data.allocatedKobo, due.data.legacyReversalReviewPause, due.data.disputeRelease], [...expected, undefined, undefined], `${disposition}, ${decision}`);
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

// Review fix: the provider identity quarantine holds only a genuinely ambiguous batch. PR #60's golden case "evidence held
// for its connection alone" as that build saved it: the debit came through Sandbox Rail, Finance joined its settlement line
// through Sandbox Rail Settlements to it, the bank's statement credit, which names no connection, matched the batch by its
// reference, and the batch recorded its line's provider and its payment's connection but no identity.
const IDENTITY_HOLD = "Historical settlement evidence mixes or conflicts with provider connections. Totals and prior links are preserved for Finance review and cannot certify a reconciled payout. An operator-reviewed repair using verified provider-scoped evidence is required; rerunning reconciliation or reimporting the same batch does not clear this hold.";
function heldForItsConnection(merchantId: string, creditNames?: string) {
  const { state, due } = liveFixture({ withFailure: false, merchantId });
  addAttempt(state, due, { status: "succeeded", occurredAt: wat("2027-07-01T07:00:00"), providerReference: "PSK-SET-1" });
  addObservation(state, { reference: "PSK-SET-1", amountKobo: 2_500_000, source: "webhook", customerId: due.customerId, eventId: "w1", occurredAt: wat("2027-07-01T07:00:00") });
  run(state);
  const line = addObservation(state, { reference: "PSK-SET-1", amountKobo: 2_487_500, grossAmountKobo: 2_500_000, feeKobo: 12_500, batchReference: "B-1", source: "settlement", customerId: due.customerId, eventId: "s1", occurredAt: wat("2027-07-01T08:00:00"), provider: "Sandbox Rail Settlements" } as any);
  const credit = addObservation(state, { reference: "STMT-B-1", amountKobo: 2_487_500, batchReference: "B-1", source: "statement", eventId: "st1", occurredAt: wat("2027-07-01T09:00:00") });
  if (creditNames) credit.data.provider = creditNames; else delete credit.data.provider; // A bank statement import names no provider.
  run(state);
  resolve(state, recordsOf(state, "exceptions").find((item) => item.data.linkedRecordId === line.id)!, "same_payment");
  run(state);
  const payment = recordsOf(state, "payments").find((item) => item.reference === "PSK-SET-1")!;
  const batch = recordsOf(state, "settlement-batches").find((item) => item.reference === "B-1")!;
  delete batch.data.providerIdentityKey;
  Object.assign(batch.data, { provider: "Sandbox Rail Settlements", providerConnection: payment.data.providerConnection, statementObservationId: credit.id, statementNetKobo: 2_487_500, explanation: "Statement credit matched the settlement batch net total; it was not allocated to a customer." });
  batch.status = "reconciled";
  Object.assign(credit, { status: "resolved" }); Object.assign(credit.data, { resolvedTo: `batch:${batch.id}`, resolutionKey: "settlement_batch_net_credit" });
  return { state, due, line, credit, payment, batch };
}
/** What PR #61's build wrote at its first reconciliation of such a batch: the snapshot, the variance and its exception. */
function quarantineAsPr61(state: DomainState, batch: TypedRecord<"settlement-batches">, identities: string[], at: string) {
  const observationIds = recordsOf(state, "observations").filter((item) => item.data.settlementBatchId === batch.id || item.data.resolvedTo === `batch:${batch.id}`).map((item) => item.id).sort();
  batch.data.providerIdentityReview = { detectedAt: at, identities: identities.map((connection) => JSON.stringify([connection, batch.reference])).sort(), observationIds, previous: { status: batch.status, grossKobo: batch.data.grossKobo, feeKobo: batch.data.feeKobo, netKobo: batch.data.netKobo, currency: "NGN", statementObservationId: batch.data.statementObservationId ?? null, statementNetKobo: batch.data.statementNetKobo ?? null } };
  Object.assign(batch, { status: "variance" }); batch.data.explanation = IDENTITY_HOLD;
  return raiseException(state, ctxAt(at, "Finance"), "settlement_variance", { linkedRecordId: batch.id, notes: IDENTITY_HOLD, condition: `settlement_variance:${batch.id}:provider_identity` });
}
/** A settlement line PR #61's build attached to a quarantined batch without counting it, with the payment it made. */
function heldLine(state: DomainState, batch: TypedRecord<"settlement-batches">, customerId: string, reference: string, provider: string) {
  const at = wat("2027-07-02T08:00:00");
  const payment = makeRecord(state, "payments", { name: "Canonical payment", status: "unallocated", reference, customerId, amountKobo: 1_000_000, createdAt: at, data: { providerReference: reference, providerConnection: provider, currency: "NGN", channel: "direct_debit", observedAt: at, collectionStatus: "succeeded", settlementStatus: "settled", reversalStatus: "none", refundStatus: "none", allocatedKobo: 0, canonical: true, settledAt: at } });
  const line = addObservation(state, { reference, amountKobo: 995_000, grossAmountKobo: 1_000_000, feeKobo: 5_000, batchReference: batch.reference, source: "settlement", customerId, eventId: `held-${reference}`, occurredAt: at, provider } as any);
  Object.assign(line, { status: "resolved" }); Object.assign(line.data, { settlementBatchId: batch.id, providerIdentityHeld: true, paymentId: payment.id, resolutionKey: "new_canonical_provider_reference" });
  return { line, payment };
}
{
  // A legacy batch whose evidence names one connection is never held: it keeps its statement credit and reconciles as before.
  const legacy = heldForItsConnection("golden-held-connection");
  const totals = [legacy.batch.data.grossKobo, legacy.batch.data.feeKobo, legacy.batch.data.netKobo, legacy.batch.data.expectedFeeKobo];
  const answer = run(legacy.state);
  assert.deepEqual([legacy.batch.status, legacy.batch.data.providerIdentityReview, legacy.batch.data.providerIdentityKey, legacy.batch.data.statementObservationId, legacy.batch.data.statementNetKobo, legacy.credit.data.resolvedTo], ["reconciled", undefined, JSON.stringify(["sandbox rail settlements", "B-1"]), legacy.credit.id, 2_487_500, `batch:${legacy.batch.id}`], "its identity is its line's connection, and its statement credit, which names none, stays linked");
  assert.deepEqual([answer.data.settlementProviderIdentityHolds, recordsOf(legacy.state, "exceptions").filter((item) => item.data.linkedRecordId === legacy.batch.id).length], [undefined, 0], "nothing is held and no exception is raised");
  assert.deepEqual([legacy.batch.data.grossKobo, legacy.batch.data.feeKobo, legacy.batch.data.netKobo, legacy.batch.data.expectedFeeKobo], totals);
  const saved = JSON.stringify(legacy.batch);
  run(legacy.state);
  assert.equal(JSON.stringify(legacy.batch), saved, "a later reconciliation changes nothing");
  // A later line of its own connection counts in it, as before; one naming the payment's connection goes to that connection's batch.
  addObservation(legacy.state, { reference: "PSK-SET-2", amountKobo: 995_000, grossAmountKobo: 1_000_000, feeKobo: 5_000, batchReference: "B-1", source: "settlement", customerId: legacy.due.customerId, eventId: "s2", occurredAt: wat("2027-07-02T08:00:00"), provider: "Sandbox Rail Settlements" } as any);
  addObservation(legacy.state, { reference: "STMT-B-1-2", amountKobo: 995_000, batchReference: "B-1", source: "statement", eventId: "st2", occurredAt: wat("2027-07-02T09:00:00"), provider: "Sandbox Rail Settlements" } as any);
  run(legacy.state);
  assert.deepEqual([legacy.batch.status, legacy.batch.data.grossKobo, legacy.batch.data.statementNetKobo, recordsOf(legacy.state, "settlement-batches").length], ["reconciled", 3_500_000, 3_482_500, 1], "its own connection's later line and credit reconcile it");
}
{
  // The same batch as PR #61's build quarantined it, with two lines it attached but held meanwhile, and the credit for one.
  const legacy = heldForItsConnection("golden-quarantined");
  const { state, batch, due } = legacy;
  const hold = quarantineAsPr61(state, batch, ["sandbox rail", "sandbox rail settlements"], wat("2027-07-02T07:00:00"));
  const snapshot = structuredClone(batch.data.providerIdentityReview);
  const other = recordsOf(state, "customers").find((item) => item.id !== due.customerId)!;
  const own = heldLine(state, batch, due.customerId, "PSK-SET-2", "Sandbox Rail Settlements");
  const elsewhere = heldLine(state, batch, other.id, "PSK-SET-3", "Sandbox Rail");
  addObservation(state, { reference: "STMT-B-1-2", amountKobo: 995_000, batchReference: "B-1", source: "statement", eventId: "st2", occurredAt: wat("2027-07-02T09:00:00"), provider: "Sandbox Rail Settlements" } as any);
  const answer = run(state);
  const release = batch.data.providerIdentityRelease as { releasedAt: string; identity: string; heldLineIds: string[] } | undefined;
  assert.deepEqual([release?.releasedAt, release?.identity, release?.heldLineIds], [now, JSON.stringify(["sandbox rail settlements", "B-1"]), [own.line.id, elsewhere.line.id].sort()], "the next reconciliation releases it once, recording why and which held lines it read again");
  assert.deepEqual(batch.data.providerIdentityReview, snapshot, "the earlier snapshot is kept as it was recorded");
  assert.deepEqual([batch.status, batch.data.providerIdentityKey, batch.data.lineObservationIds, batch.data.grossKobo, batch.data.netKobo, batch.data.statementNetKobo], ["reconciled", JSON.stringify(["sandbox rail settlements", "B-1"]), [legacy.line.id, own.line.id], 3_500_000, 3_482_500, 3_482_500], "its state and totals are restored, the held line of its own connection is counted and the credit for it links");
  const theirs = recordsOf(state, "settlement-batches").find((item) => item.id !== batch.id && item.reference === "B-1");
  assert.deepEqual([own.line.data.providerIdentityHeld, elsewhere.line.data.providerIdentityHeld, elsewhere.line.data.settlementBatchId, theirs?.data.providerIdentityKey, theirs?.data.lineObservationIds], [undefined, undefined, theirs?.id, JSON.stringify(["sandbox rail", "B-1"]), [elsewhere.line.id]], "a held line of another connection is counted in that connection's own batch");
  assert.deepEqual([hold.status, hold.data.resolutionCode], ["closed", "condition_cleared"], "the hold's exception closes as its condition cleared");
  assert.equal(answer.data.settlementProviderIdentityReleases, 1);
  assert.match(String(answer.data.auditNote), /Released settlement batch B-1 from the provider identity hold/);
  const saved = JSON.stringify(state.records.filter((item) => item.kind === "settlement-batches" || item.kind === "observations"));
  const again = run(state);
  assert.equal(JSON.stringify(state.records.filter((item) => item.kind === "settlement-batches" || item.kind === "observations")), saved, "the release happens once");
  assert.equal(again.data.settlementProviderIdentityReleases, undefined);
}
{
  // Genuinely ambiguous batches stay held: lines through two named connections, and the golden batch whose credit names the
  // payment's connection (by FIN-03 a credit of another connection's payout).
  const mixed = heldForItsConnection("golden-mixed");
  const second = addObservation(mixed.state, { reference: "PSK-SET-9", amountKobo: 995_000, grossAmountKobo: 1_000_000, feeKobo: 5_000, batchReference: "B-1", source: "settlement", customerId: mixed.due.customerId, eventId: "s9", occurredAt: wat("2027-07-01T08:00:00"), provider: "Other Rail" } as any);
  Object.assign(second, { status: "resolved" }); Object.assign(second.data, { settlementBatchId: mixed.batch.id });
  const named = heldForItsConnection("golden-named-credit", "Sandbox Rail");
  for (const { state, batch } of [mixed, named]) {
    const answer = run(state); run(state);
    assert.deepEqual([batch.status, batch.data.providerIdentityReview !== undefined, batch.data.providerIdentityRelease, batch.data.providerIdentityKey, answer.data.settlementProviderIdentityHolds], ["variance", true, undefined, undefined, 1]);
  }
  assert.deepEqual((mixed.batch.data.providerIdentityReview as { identities: string[] }).identities, [JSON.stringify(["other rail", "B-1"]), JSON.stringify(["sandbox rail settlements", "B-1"])], "the hold names the connections its evidence names, not the one copied from its payment");
}

// Review fix: the renewed reversal review's holds never change a paid instalment or one unpaid after its final attempt;
// one still collectable is paused in dispute with the status it had, which it gets back exactly when the hold clears. A
// hold reaches only what the reversal names through its own connection and live allocations.
const reviewOf = (state: DomainState) => recordsOf(state, "exceptions").find((item) => item.data.legacyResolutionReview)!;
const pauseOf = (due: TypedRecord<"due-items">) => due.data.legacyReversalReviewPause as { status?: string; inferred?: boolean } | undefined;
const holdsOf = (record: TypedRecord<"payments"> | TypedRecord<"due-items">) => record.data.legacyReversalReviewIds as string[] | undefined;
/** Another instalment of the fixture's customer, and a debit attempt of it with the reversal's reference when `debited`. */
function instalment(state: DomainState, due: TypedRecord<"due-items">, reference: string, status: string, debited = false) {
  const added = makeRecord(state, "due-items", { name: reference, reference, status, customerId: due.customerId, amountKobo: 1_500_000, data: { ...structuredClone(due.data), outstandingKobo: 1_500_000 } }) as TypedRecord<"due-items">;
  if (debited) addAttempt(state, added, { status: status === "unpaid_final" ? "failed" : "sent", failureCode: status === "unpaid_final" ? "ACCOUNT_CLOSED" : undefined, occurredAt: wat("2027-06-30T07:00:00"), providerReference: "OLD-REVERSAL" });
  if (status === "unpaid_final") added.data.giveUpRule = "never_retry";
  return added;
}
/** Another customer's instalment, paid by a payment with the reversal's reference that came through another connection. */
function paidElsewhere(state: DomainState) {
  const other = recordsOf(state, "due-items").find((item) => item.reference === "DEMO-LOAN-1003")!;
  const foreign = makeRecord(state, "payments", { name: "Other connection's receipt", status: "unallocated", reference: "OLD-REVERSAL", customerId: other.customerId, amountKobo: other.amountKobo, data: { providerReference: "OLD-REVERSAL", providerConnection: "Other Rail", currency: "NGN", channel: "direct_debit", collectionStatus: "succeeded", settlementStatus: "settled", reversalStatus: "none", refundStatus: "none", allocatedKobo: 0 } });
  allocatePayment(state, finance, foreign, other, other.amountKobo, "R1", "certain", true);
  return { other, foreign };
}
/** What PR #61's build wrote for a hold: every instalment it reached in dispute, whatever its status, and the review's id on each. */
function holdAsPr61(review: TypedRecord<"exceptions">, dues: TypedRecord<"due-items">[], payments: TypedRecord<"payments">[]) {
  for (const due of dues) { if (!["cancelled", "closed", "in_dispute"].includes(due.status)) due.status = "in_dispute"; due.data.legacyReversalReviewIds = [review.id]; delete due.data.legacyReversalReviewPause; }
  for (const payment of payments) payment.data.legacyReversalReviewIds = [review.id];
}
{
  // Paid, unpaid after its final attempt and still collectable, while the review is open and once it is resolved.
  let final!: TypedRecord<"due-items">, collectable!: TypedRecord<"due-items">;
  const held = legacyReversal("allocated", "provider_state_adopted", ({ state, due }) => { final = instalment(state, due, "LOAN-FINAL", "unpaid_final", true); collectable = instalment(state, due, "LOAN-OPEN", "in_collection", true); });
  run(held.state); run(held.state);
  assert.deepEqual([held.due.status, final.status, collectable.status, pauseOf(collectable)?.status], ["paid", "unpaid_final", "in_dispute", "in_collection"], "a paid or finally unpaid instalment keeps its status; a collectable one is paused with the status it had");
  assert.deepEqual([held.due, final, collectable].map((due) => due.data.legacyReversalReviewIds), [[reviewOf(held.state).id], [reviewOf(held.state).id], [reviewOf(held.state).id]], "each is still held");
  for (const due of [held.due, final, collectable]) assert.throws(() => releaseDispute(structuredClone(held.state), finance, structuredClone(due), { via: "finance_release", reason: "Bypass" }), /renewed reversal review/);
  resolve(held.state, reviewOf(held.state), "provider_state_adopted");
  const answer = run(held.state); run(held.state); run(held.state);
  assert.deepEqual([collectable.status, pauseOf(collectable), collectable.data.legacyReversalReviewIds, collectable.data.disputeRelease], ["in_collection", undefined, undefined, undefined], "the collectable instalment gets exactly its status back, with no release");
  assert.deepEqual([final.status, recordsOf(held.state, "exceptions").filter((item) => item.data.linkedRecordId === final.id).length], ["unpaid_final", 0], "the final one stays final, with no new final-attempt exception");
  assert.deepEqual([held.payment.data.reversalStatus, held.due.status, outstandingOf(held.due), recordsOf(held.state, "exceptions").filter((item) => item.data.linkedRecordId === held.due.id && item.data.type === "customer_dispute").length], ["reversed", "in_dispute", held.due.amountKobo, 1], "the adopted reversal puts the paid instalment in dispute of its own accord");
  assert.match(String(answer.data.auditNote), /Returned 1 instalment/);
}
{
  // Not across connections, and not through an allocation no longer in use.
  let foreign!: TypedRecord<"payments">, other!: TypedRecord<"due-items">, superseded!: TypedRecord<"due-items">;
  const scoped = legacyReversal("waiting", "provider_state_adopted", ({ state, due, payment }) => {
    ({ foreign, other } = paidElsewhere(state));
    superseded = instalment(state, due, "LOAN-WRONG", "scheduled");
    supersedeAllocation(state, finance, allocatePayment(state, finance, payment, superseded, superseded.amountKobo, "R5", "certain", true), "Precision audit marked this allocation wrong: another customer's debit.");
  });
  run(scoped.state);
  assert.deepEqual([holdsOf(scoped.payment)?.length, holdsOf(scoped.due)?.length], [1, 1], "the reversal's own payment and debit's instalment are held");
  assert.deepEqual([foreign.data.legacyReversalReviewIds, other.status, other.data.legacyReversalReviewIds, superseded.status, superseded.data.legacyReversalReviewIds], [undefined, "paid", undefined, "scheduled", undefined], "another connection's payment, its instalment and an instalment of a superseded allocation are not");
}
{
  // What the deployed build already did while the review is open: the next reconciliation gives back the status the records
  // establish, keeps a collectable instalment paused with it, and releases what it reached across connections, once.
  let final!: TypedRecord<"due-items">, collectable!: TypedRecord<"due-items">, foreign!: TypedRecord<"payments">, other!: TypedRecord<"due-items">;
  const earlier = legacyReversal("allocated", "provider_state_adopted", ({ state, due }) => {
    final = instalment(state, due, "LOAN-FINAL", "unpaid_final", true); collectable = instalment(state, due, "LOAN-OPEN", "in_collection", true);
    ({ foreign, other } = paidElsewhere(state));
  });
  run(earlier.state);
  holdAsPr61(reviewOf(earlier.state), [earlier.due, final, collectable, other], [earlier.payment, foreign]);
  const answer = run(earlier.state);
  assert.deepEqual([earlier.due.status, final.status, collectable.status, other.status], ["paid", "unpaid_final", "in_dispute", "paid"], "paid, finally unpaid and another connection's instalment get their status back");
  assert.deepEqual([pauseOf(collectable), holdsOf(collectable)?.length, holdsOf(other), holdsOf(foreign)], [{ status: "in_collection", pausedAt: now, inferred: true }, 1, undefined, undefined], "the collectable one stays paused with the status its records establish");
  assert.match(String(answer.data.auditNote), /Returned 3 instalments/);
  const saved = JSON.stringify(recordsOf(earlier.state, "due-items"));
  run(earlier.state);
  assert.equal(JSON.stringify(recordsOf(earlier.state, "due-items")), saved, "once");
  resolve(earlier.state, reviewOf(earlier.state), "provider_state_adopted");
  run(earlier.state);
  assert.deepEqual([collectable.status, final.status, earlier.due.status], ["in_collection", "unpaid_final", "in_dispute"], "when the review is resolved the collectable one resumes, and the reversal disputes the instalment it paid");
}
{
  // The deployed build cleared its hold when the review was resolved and left the instalments in dispute for an explicit
  // release: releasing one returns it to the status it had before the hold, and the next reconciliation restores the rest.
  let final!: TypedRecord<"due-items">;
  const cleared = legacyReversal("waiting", "platform_state_confirmed", ({ state, due }) => { final = instalment(state, due, "LOAN-FINAL", "unpaid_final", true); });
  run(cleared.state);
  holdAsPr61(reviewOf(cleared.state), [cleared.due, final], [cleared.payment]);
  resolve(cleared.state, reviewOf(cleared.state), "platform_state_confirmed");
  for (const record of [cleared.due, final, cleared.payment]) delete record.data.legacyReversalReviewIds;
  transaction(cleared.state, () => releaseDispute(cleared.state, finance, final, { via: "finance_release", reason: "Reviewed after the renewed decision." }));
  assert.deepEqual([final.status, (final.data.disputeRelease as { status?: string }).status], ["unpaid_final", "unpaid_final"], "the release returns it to unpaid after its final attempt, not to collection");
  const answer = run(cleared.state);
  assert.deepEqual([cleared.due.data.disputeRelease, cleared.due.status, outstandingOf(cleared.due), cleared.payment.status], [undefined, "paid", 0, "allocated"], "the next reconciliation gives the other its status back, and its receipt then pays it");
  assert.match(String(answer.data.auditNote), /Returned 1 instalment/);
}
console.log("Financial migration regressions passed: unversioned reversal authority, renewed Finance review, prior allocations/dispositions, replay, provider-scoped settlement and legacy quarantine, one fee schedule per settlement line, the quarantine kept to genuinely ambiguous batches and released otherwise, and reversal review holds that keep instalment statuses and reach only the reversal's own connection.");
