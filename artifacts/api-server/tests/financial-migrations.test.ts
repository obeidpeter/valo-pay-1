// FIN-02/03: persisted earlier shapes, explicit authority, provider-scoped payouts and repeat passes.
// These are offline domain/store-invariant tests: no database or provider calls.
import assert from "node:assert/strict";
import { addAttempt, addObservation, ctxAt, liveFixture, outstandingOf, wat } from "./helpers.js";
import { allocatePayment, applyConfirmedAllocation, raiseException, reconcile, releaseDispute, reversePayment, supersedeAllocation } from "../src/domain/reconciliation.js";
import { executeAction } from "../src/domain/actions.js";
import { evaluateRetry } from "../src/domain/policy-engine.js";
import { connectedRevision, runConnectedAction } from "../src/domain/connected.js";
import { makeRecord, recordsOf } from "../src/domain/records.js";
import { validateRecord } from "../src/domain/validation.js";
import type { DomainState, TypedRecord } from "../src/domain/types.js";
import { resolutionCodesForException } from "@workspace/valopay-schema";
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

// Review fix: a settlement line that names no provider is checked against the schedule of the connection it names, else of
// the lender's provider: the line alone decides it, never its payment's connection, which is that of whichever evidence
// arrived first, so a line whose debit came through another connection gets the same result in both arrival orders.
{
  const GROSS = 2_500_000, FEE = 25_000; // Connection L, which the line names, charges 1%; connection D, the debit's, 2%.
  const settle = (order: "line first" | "debit first", names: "its connection" | "nothing") => {
    const { state, due } = liveFixture({ withFailure: false, merchantId: `line-alone-${order.split(" ")[0]}-${names.split(" ")[0]}` });
    state.settings.providerFeeSchedule = { ...state.settings.providerFeeSchedule, "Connection L": { bps: 100 }, "Connection D": { bps: 200 } };
    const labels = names === "its connection" ? { providerConnection: "Connection L" } : {};
    const debit = () => addObservation(state, { reference: "PSK-ALONE-1", amountKobo: GROSS, source: "webhook", customerId: due.customerId, eventId: "alone-debit", occurredAt: wat("2027-07-01T06:30:00"), provider: "Connection D", providerConnection: "Connection D" } as any);
    // A settlement file with no provider column.
    const line = () => { const made = addObservation(state, { reference: "PSK-ALONE-1", amountKobo: GROSS - FEE, grossAmountKobo: GROSS, feeKobo: FEE, batchReference: "B-ALONE", source: "settlement", customerId: due.customerId, eventId: "alone-line", occurredAt: wat("2027-07-01T08:00:00"), ...labels } as any); delete made.data.provider; return made; };
    const first = order === "line first" ? line() : debit();
    run(state);
    const second = order === "line first" ? debit() : line();
    run(state);
    // The second came through another connection, so it is held for Finance, who joins it to the payment (same_payment).
    resolve(state, recordsOf(state, "exceptions").find((item) => item.data.linkedRecordId === second.id && item.status === "open")!, "same_payment");
    run(state);
    const counted = order === "line first" ? first : second;
    const credit = addObservation(state, { reference: "STMT-ALONE", amountKobo: GROSS - FEE, batchReference: "B-ALONE", source: "statement", eventId: "alone-credit", occurredAt: wat("2027-07-01T09:00:00"), ...labels } as any);
    delete credit.data.provider;
    run(state); run(state);
    const batch = recordsOf(state, "settlement-batches").find((item) => item.reference === "B-ALONE")!;
    return [counted.data.expectedFeeKobo, batch.status, batch.data.expectedFeeKobo, batch.data.feeVarianceKobo, (batch.data.feeSchedule as { bps?: number } | undefined)?.bps];
  };
  for (const names of ["its connection", "nothing"] as const) {
    const lineFirst = settle("line first", names), debitFirst = settle("debit first", names);
    assert.deepEqual(lineFirst, names === "its connection" ? [FEE, "reconciled", FEE, 0, 100] : [12_500, "variance", 12_500, 12_500, 50], `a line naming ${names} is checked against ${names === "its connection" ? "that connection's" : "the lender's provider's"} schedule`);
    assert.deepEqual(debitFirst, lineFirst, `a line naming ${names}: the order it and its debit arrive in changes nothing`);
  }
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
  assert.match(String(answer.data.auditNote), /Released settlement batch B-1 from its provider identity hold: all its evidence now comes from Sandbox Rail Settlements, and no other batch claims it; 2 settlement lines held meanwhile are now counted as new lines\./);
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

// Review fix: a genuinely ambiguous batch has a reviewed way out. Admin or Finance resolves its hold's exception as
// provider_identity_confirmed, naming one of the identities it was held for; the next reconciliation releases it as that
// identity and moves the evidence of the others: their lines to their own connection's batch, their credits to link there.
/** An earlier build's batch that counted two connections' lines under one reference, with both statement credits. */
function mixedBatch(merchantId: string, beforeHold?: (state: DomainState, batch: TypedRecord<"settlement-batches">) => void) {
  const { state } = liveFixture({ withFailure: false, merchantId });
  const aLine = line(state, "connection-a"), bLine = line(state, "connection-b"), aCredit = credit(state, "connection-a"), bCredit = credit(state, "connection-b");
  run(state);
  const batches = recordsOf(state, "settlement-batches").filter((item) => item.reference === "SHARED");
  const batch = batches.find((item) => item.data.providerConnection === "connection-a")!, other = batches.find((item) => item !== batch)!;
  state.records = state.records.filter((item) => item.id !== other.id && !(item.kind === "exceptions" && [batch.id, other.id].includes(String(item.data.linkedRecordId))));
  Object.assign(batch.data, { lineObservationIds: [aLine.id, bLine.id], linePaymentIds: [aLine.data.paymentId, bLine.data.paymentId], grossKobo: 200_000, feeKobo: 1_000, expectedFeeKobo: 1_000, feeVarianceKobo: 0, netKobo: 199_000, statementNetKobo: 199_000 });
  delete batch.data.providerIdentityKey;
  batch.status = "reconciled";
  bLine.data.settlementBatchId = batch.id; bCredit.data.resolvedTo = `batch:${batch.id}`;
  beforeHold?.(state, batch);
  run(state);
  const hold = recordsOf(state, "exceptions").find((item) => item.data.condition === `settlement_variance:${batch.id}:provider_identity`)!;
  return { state, batch, aLine, bLine, aCredit, bCredit, hold };
}
/** The data owner's repair of a mixed batch: connection-b's line and credit are that connection's own payout, recorded in its own batch. */
function repairMixed({ state, batch, aLine, bLine, aCredit, bCredit }: ReturnType<typeof mixedBatch>) {
  const own = makeRecord(state, "settlement-batches", { name: "Settlement batch SHARED", status: "pending", reference: "SHARED", data: { batchReference: "SHARED", provider: "connection-b", providerConnection: "connection-b", providerIdentityKey: JSON.stringify(["connection-b", "SHARED"]), currency: "NGN", lineObservationIds: [bLine.id], linePaymentIds: [String(bLine.data.paymentId)], grossKobo: 100_000, feeKobo: 500, expectedFeeKobo: 500, feeVarianceKobo: 0, netKobo: 99_500 } });
  bLine.data.settlementBatchId = own.id; bCredit.data.resolvedTo = `batch:${own.id}`;
  Object.assign(batch.data, { lineObservationIds: [aLine.id], linePaymentIds: [aLine.data.paymentId], grossKobo: 100_000, feeKobo: 500, expectedFeeKobo: 500, feeVarianceKobo: 0, netKobo: 99_500, statementObservationId: aCredit.id, statementNetKobo: 99_500 });
  return own;
}
const exceptionsOf = (state: DomainState, batch: TypedRecord<"settlement-batches">) => recordsOf(state, "exceptions").filter((item) => item.data.linkedRecordId === batch.id);
const identityHeldOf = (batch: TypedRecord<"settlement-batches">) => !!batch.data.providerIdentityReview && !batch.data.providerIdentityRelease;
const kinds = (state: DomainState) => JSON.stringify(state.records.filter((item) => ["settlement-batches", "observations", "exceptions"].includes(item.kind)));
const identityOf = (connection: string) => JSON.stringify([connection, "SHARED"]);
const confirm = (state: DomainState, exception: TypedRecord<"exceptions">, role: string, data: Record<string, unknown>, at = now) =>
  transaction(state, () => executeAction(state, ctxAt(at, role), { action: "resolve_exception", recordId: exception.id, reason: "Both providers confirmed whose payout this batch is.", data: { resolutionCode: "provider_identity_confirmed", ...data } }));
const runAt = (state: DomainState, at: string) => transaction(state, () => reconcile(state, ctxAt(at, "Finance")));
/** Whether a resolution is refused, and with what status and message. */
function refusal(state: DomainState, exception: TypedRecord<"exceptions">, role: string, data: Record<string, unknown>, at = now): [number, string] {
  try { confirm(structuredClone(state), structuredClone(exception), role, data, at); } catch (error) { return [(error as { status?: number }).status ?? 400, (error as Error).message]; }
  return [200, ""];
}
const onlyConfirmation = /^Choose ‘Provider identity confirmed’: this settlement batch stays held until Finance or an Admin confirms whose payout it is\. If the providers cannot say which connection it belongs to, leave this exception open until the data owner corrects the evidence\./;
{
  // Decision: the hold's exception offers and accepts only provider_identity_confirmed, the one code that decides it. The
  // settlement codes would close it while the batch stays held with its evidence uncounted, with no way out.
  const { state, batch, hold } = mixedBatch("confirm-refusals");
  assert.deepEqual([batch.status, (batch.data.providerIdentityReview as { identities: string[] }).identities, hold.status], ["variance", [identityOf("connection-a"), identityOf("connection-b")], "open"], "the mixed batch is held with its exception");
  assert.deepEqual(resolutionCodesForException(hold), ["provider_identity_confirmed"], "the hold's exception offers only the confirmation");
  assert.deepEqual(resolutionCodesForException({ data: { type: "settlement_variance", condition: `settlement_variance:${batch.id}:statement:1:2:3` } }), ["fee_schedule_updated", "provider_corrected", "accepted_variance"], "no other settlement variance offers it");
  assert.deepEqual(resolutionCodesForException(hold, { identityHeld: false }), ["fee_schedule_updated", "provider_corrected", "accepted_variance"], "once its batch is not held, the hold's exception offers the other codes instead");
  for (const code of ["fee_schedule_updated", "provider_corrected", "accepted_variance"]) {
    const [status, message] = refusal(state, hold, "Finance", { resolutionCode: code });
    assert.equal(status, 400, `${code} is refused`);
    assert.match(message, onlyConfirmation, `${code}: the refusal names the one code allowed`);
  }
  for (const data of [{ confirmedProviderIdentity: identityOf("connection-a") }, { resolutionCode: "accepted_variance" }]) assert.equal(refusal(state, hold, "Operations", data)[0], 403, "only Admin or Finance resolves the hold");
  assert.deepEqual(refusal(state, hold, "Finance", { confirmedProviderIdentity: identityOf("connection-c") }), [400, "Choose one of the connections settlement batch SHARED was held for: connection-a or connection-b."], "an identity the batch was not held for is refused");
  assert.equal(refusal(state, hold, "Finance", {})[0], 400, "the identity is required");
  assert.equal(refusal(state, hold, "Admin", { confirmedProviderIdentity: identityOf("connection-a") })[0], 200, "an administrator may confirm it");
}
{
  // Where the providers cannot attribute the payout to one connection, the hold's exception stays open until the data owner
  // repairs the evidence; the next reconciliation then releases the batch and closes the exception as its condition cleared.
  const mixed = mixedBatch("owner-repair"), { state, batch, hold } = mixed;
  run(state); run(state);
  assert.deepEqual([hold.status, batch.status, batch.data.providerIdentityRelease, exceptionsOf(state, batch).map((item) => item.id)], ["open", "variance", undefined, [hold.id]], "nothing releases the batch while its evidence names two connections, and no other exception is raised");
  const own = repairMixed(mixed);
  const answer = run(state);
  const release = batch.data.providerIdentityRelease as Record<string, unknown>;
  assert.deepEqual([release.identity, release.confirmedBy, batch.data.providerIdentityKey, batch.status, own.status], [identityOf("connection-a"), undefined, identityOf("connection-a"), "reconciled", "reconciled"], "the repaired batch is released as the one connection its evidence names, and both payouts reconcile");
  assert.deepEqual([hold.status, hold.data.resolutionCode, answer.data.settlementProviderIdentityReleases], ["closed", "condition_cleared", 1], "the hold's exception closes as its condition cleared");
  assert.match(String((hold.data.conditionCleared as { reason: string }).reason), /all the evidence of settlement batch SHARED now comes from connection-a, and no other batch claims it/);
  assert.match(String(answer.data.auditNote), /Released settlement batch SHARED from its provider identity hold: all its evidence now comes from connection-a, and no other batch claims it\./);
  const saved = kinds(state);
  run(state);
  assert.equal(kinds(state), saved, "reconciling again changes nothing");
}
{
  // A hold's exception an earlier build made carry a report of a collection counted in two batches: once the batch is
  // released, the exception stays open for that report and offers the codes that mean something for it, never the
  // confirmation; resolving it settles the report.
  const mixed = mixedBatch("owner-repair-carried"), { state, batch, aLine, hold } = mixed;
  const counting = makeRecord(state, "settlement-batches", { name: "Settlement batch EARLIER", status: "pending", reference: "EARLIER", data: { batchReference: "EARLIER", provider: "connection-a", providerConnection: "connection-a", providerIdentityKey: JSON.stringify(["connection-a", "EARLIER"]), currency: "NGN", lineObservationIds: [], linePaymentIds: [], grossKobo: 0, feeKobo: 0, netKobo: 0 } });
  const again = line(state, "connection-a", "NGN", "PAY-connection-a-again");
  Object.assign(again, { status: "resolved" }); Object.assign(again.data, { paymentId: aLine.data.paymentId, settlementBatchId: batch.id, countedInBatchId: counting.id, duplicateSettlementLine: true });
  const report = `settlement_variance:${batch.id}:line:${again.id}`;
  hold.data.countedTwice = [report];
  repairMixed(mixed);
  run(state);
  assert.deepEqual([batch.status, batch.data.providerIdentityRelease !== undefined, hold.status], ["reconciled", true, "open"], "the batch is released, and the exception stays open for the report it carries");
  assert.match(String(hold.data.notes), /so its provider identity hold is released\. It stays open for the collection the provider reports in two batches/);
  assert.deepEqual(refusal(state, hold, "Finance", { confirmedProviderIdentity: identityOf("connection-a") }), [409, "This settlement batch is no longer on hold for its provider identity. Reload the page to see where it stands."], "a confirmation, as from a dialog open while the batch was released, is told to refresh");
  assert.deepEqual(resolutionCodesForException(hold, { identityHeld: false }), ["fee_schedule_updated", "provider_corrected", "accepted_variance"], "the codes it offers now are the settlement codes");
  transaction(state, () => executeAction(state, finance, { action: "resolve_exception", recordId: hold.id, reason: "Both payouts checked with the provider.", data: { resolutionCode: "accepted_variance" } }));
  run(state); run(state);
  assert.deepEqual([hold.status, exceptionsOf(state, batch).filter((item) => item.data.condition === report).length], ["resolved", 0], "its resolution settles the report, which is not raised again");
}
{
  // Decision: a hold's exception concerns only the hold. A batch held while another settlement_variance was open for it,
  // which an earlier build left carrying the hold, gets its own; a report raised while it is held goes to the batch's other
  // exception, never onto the hold's.
  let earlier!: TypedRecord<"exceptions">;
  const mixed = mixedBatch("hold-beside-variance", (state, batch) => {
    earlier = raiseException(state, finance, "settlement_variance", { linkedRecordId: batch.id, notes: "Statement credit differs from gross settlement lines less recorded fees.", condition: `settlement_variance:${batch.id}:statement:150000:199000:1000` });
  });
  const { state, batch, aLine, hold } = mixed;
  assert.ok(hold, "the batch has an exception with the hold's condition beside the one already open");
  assert.deepEqual([earlier.status, hold.status, resolutionCodesForException(earlier), resolutionCodesForException(hold)], ["open", "open", ["fee_schedule_updated", "provider_corrected", "accepted_variance"], ["provider_identity_confirmed"]]);
  // A batch that counts the same collection comes first, so this batch reports the collection counted twice while it is held.
  makeRecord(state, "settlement-batches", { name: "Settlement batch FIRST", status: "pending", reference: "FIRST", data: { batchReference: "FIRST", provider: "connection-a", providerConnection: "connection-a", providerIdentityKey: JSON.stringify(["connection-a", "FIRST"]), currency: "NGN", lineObservationIds: [], linePaymentIds: [String(aLine.data.paymentId)], grossKobo: 0, feeKobo: 0, netKobo: 0 } });
  state.records.unshift(state.records.pop()!);
  run(state);
  const counted = `settlement_variance:${batch.id}:counted:${aLine.data.paymentId}`;
  assert.deepEqual([(earlier.data.countedTwice as string[] | undefined) ?? [], hold.data.countedTwice ?? []], [[counted], []], "the report goes to the batch's other exception, never onto the hold's");
  confirm(state, hold, "Finance", { confirmedProviderIdentity: identityOf("connection-a") });
  run(state);
  assert.deepEqual([batch.data.providerIdentityRelease !== undefined, hold.status], [true, "resolved"], "the confirmation on the hold's own exception releases it");
}
{
  // Decision on batches still held whose hold's exception an earlier build closed with another code, or in any way without a
  // confirmed identity: the earlier resolution keeps its meaning, and a renewed review is raised once, whose only code is the
  // confirmation. Confirming it releases the batch; reconciling again changes nothing.
  const earlierDecisions: Record<string, (hold: TypedRecord<"exceptions">) => void> = {
    resolved: (hold) => { Object.assign(hold, { status: "resolved" }); Object.assign(hold.data, { resolutionCode: "accepted_variance", resolvedBy: "Earlier Finance", resolvedAt: now, notes: "Accepted the provider's figures." }); },
    closed: (hold) => { Object.assign(hold, { status: "closed" }); Object.assign(hold.data, { resolutionCode: "provider_corrected", resolvedBy: "Earlier Finance", resolvedAt: now, notes: "The provider corrected its file." }); },
  };
  for (const [shape, decide] of Object.entries(earlierDecisions)) {
    const { state, batch, hold: earlier } = mixedBatch(`identity-review-${shape}`);
    decide(earlier);
    const decided = structuredClone(earlier);
    const reviewsOf = () => exceptionsOf(state, batch).filter((item) => item.id !== earlier.id);
    const answer = run(state);
    assert.equal(reviewsOf().length, 1, `${shape}: one renewed review is raised`);
    const [review] = reviewsOf();
    assert.deepEqual([review!.status, review!.name, review!.data.type, review!.data.owner, review!.data.condition], ["open", "Review earlier settlement identity decision", "settlement_variance", "Finance", `settlement_variance:${batch.id}:provider_identity:review:${earlier.id}`], `${shape}: a Finance-owned settlement variance names the earlier exception`);
    assert.deepEqual(review!.data.legacyIdentityReview, { priorExceptionId: earlier.id, priorStatus: earlier.status, priorResolutionCode: earlier.data.resolutionCode, priorResolvedBy: "Earlier Finance", priorResolvedAt: earlier.data.resolvedAt }, `${shape}: it records the earlier decision`);
    assert.match(String(review!.data.notes), /That decision stands, but the batch stays on hold until Finance or an Admin confirms whose payout it is\./, `${shape}: its notes say what the earlier resolution means now`);
    assert.deepEqual([resolutionCodesForException(review), answer.data.settlementProviderIdentityReviews], [["provider_identity_confirmed"], 1], `${shape}: its only code is the confirmation`);
    assert.match(String(answer.data.auditNote), /Raised a renewed Finance review for 1 settlement batch still on hold for its provider identity/);
    assert.deepEqual(earlier, decided, `${shape}: the earlier resolution is kept as it was recorded`);
    run(state); run(state);
    assert.equal(reviewsOf().length, 1, `${shape}: no second review while one is open`);
    assert.equal(refusal(state, review!, "Operations", { confirmedProviderIdentity: identityOf("connection-b") })[0], 403, `${shape}: only Admin or Finance resolves the review`);
    assert.match(refusal(state, review!, "Finance", { resolutionCode: "accepted_variance" })[1], onlyConfirmation, `${shape}: another code is refused`);
    const confirmed = confirm(state, review!, "Finance", { confirmedProviderIdentity: identityOf("connection-b") });
    assert.match(confirmed.message, /The next reconciliation releases settlement batch SHARED as the payout of connection-b/);
    const released = run(state);
    const release = batch.data.providerIdentityRelease as Record<string, unknown>;
    assert.deepEqual([release.identity, release.confirmedBy, release.exceptionId, batch.data.providerIdentityKey, batch.status, released.data.settlementProviderIdentityReleases], [identityOf("connection-b"), "Sandbox Finance", review!.id, identityOf("connection-b"), "reconciled", 1], `${shape}: the confirmation on the review releases the batch`);
    assert.deepEqual([earlier, reviewsOf().length], [decided, 1], `${shape}: the earlier resolution is unchanged, and no other review is raised`);
    const saved = kinds(state);
    run(state);
    assert.equal(kinds(state), saved, `${shape}: reconciling again changes nothing`);
  }
  // An older resolution with no condition settled the hold's under the one-open-exception rule, so no exception with the
  // hold's condition was ever raised: the batch now gets its own hold exception, not a review.
  const { state, batch, hold } = mixedBatch("identity-review-unconditioned");
  state.records = state.records.filter((item) => item.id !== hold.id);
  makeRecord(state, "exceptions", { name: "Settlement variance", status: "resolved", createdAt: wat("2027-06-30T12:00:00"), data: { type: "settlement_variance", owner: "Finance", severity: "medium", linkedRecordId: batch.id, resolutionCode: "fee_schedule_updated", resolvedBy: "Earlier Finance", resolvedAt: wat("2027-06-30T12:00:00"), notes: "Fee schedule updated." } });
  const answer = run(state);
  const holds = exceptionsOf(state, batch).filter((item) => item.data.condition === `settlement_variance:${batch.id}:provider_identity`);
  assert.deepEqual([holds.length, holds[0]?.status, answer.data.settlementProviderIdentityReviews], [1, "open", undefined], "a batch held with no exception of the hold's own gets one");
}
// Decision on a collision: a confirmation settles which connection's payout a batch is. It does not settle a collision
// between two batches that claim one identity, which the data owner settles by correcting the duplicate batch's reference
// or provider, after which the genuine batch is released automatically.
const idR1 = JSON.stringify(["connection-a", "R-1"]);
/** The provider's batch R-1 of connection-a, and a copy Finance entered by hand, which an earlier build let take its reference. */
function duplicateBatches(merchantId: string) {
  const { state } = liveFixture({ withFailure: false, merchantId });
  addObservation(state, { reference: "PAY-1", amountKobo: 99_500, grossAmountKobo: 100_000, feeKobo: 500, batchReference: "R-1", source: "settlement", eventId: "l1", occurredAt: wat("2027-07-01T08:00:00"), providerConnection: "connection-a" } as any);
  run(state);
  const built = recordsOf(state, "settlement-batches").find((item) => item.reference === "R-1")!;
  const typed = makeRecord(state, "settlement-batches", { name: "Settlement batch R-1", status: "pending", reference: "R-1", data: { batchReference: "R-1", provider: "connection-a", currency: "NGN", grossKobo: 100_000, feeKobo: 500, netKobo: 99_500 } });
  run(state);
  const holdOf = (batch: TypedRecord<"settlement-batches">) => exceptionsOf(state, batch).find((item) => item.status === "open" && item.data.condition === `settlement_variance:${batch.id}:provider_identity`);
  return { state, built, typed, holdOf };
}
{
  // This build refuses a batch reference another batch has, on a create, even one giving only the batch reference, and on an edit.
  const { state } = liveFixture({ withFailure: false, merchantId: "duplicate-reference" });
  addObservation(state, { reference: "PAY-1", amountKobo: 99_500, grossAmountKobo: 100_000, feeKobo: 500, batchReference: "R-1", source: "settlement", eventId: "l1", occurredAt: wat("2027-07-01T08:00:00"), providerConnection: "connection-a" } as any);
  run(state);
  const duplicate = /^Another settlement batch already has this reference\. Each batch is one provider connection’s payout/;
  const refusedWith409 = (run: () => unknown) => assert.throws(run, (error) => (error as { status?: number }).status === 409 && duplicate.test((error as Error).message));
  const hand = () => ({ name: "Settlement batch R-1B", status: "pending", reference: "R-1B", amountKobo: 0, customerId: "", data: { batchReference: "R-1B", provider: "connection-a", grossKobo: 100_000, feeKobo: 500, netKobo: 99_500 } });
  refusedWith409(() => validateRecord(state, finance, "settlement-batches", { ...hand(), reference: "R-1", data: { ...hand().data, batchReference: "R-1" } }));
  refusedWith409(() => validateRecord(state, finance, "settlement-batches", { ...hand(), reference: undefined, data: { ...hand().data, batchReference: "R-1" } } as any));
  const input = hand();
  validateRecord(state, finance, "settlement-batches", input);
  const typed = makeRecord(state, "settlement-batches", input);
  refusedWith409(() => validateRecord(state, finance, "settlement-batches", { ...structuredClone(typed), reference: "R-1", data: { ...typed.data, batchReference: "R-1" } }, true));
  refusedWith409(() => validateRecord(state, finance, "settlement-batches", { ...structuredClone(typed), data: { ...typed.data, batchReference: "R-1" } }, true));
  assert.doesNotThrow(() => validateRecord(state, finance, "settlement-batches", { ...structuredClone(typed), name: "Settlement batch R-1B (renamed)", data: { ...typed.data, grossKobo: 100_000 } }, true), "an edit that keeps its references is not checked");
}
{
  // A copy an earlier build let an API client create with only its batch reference carries the other batch's reference in
  // both fields. The console's Edit changes the reference only: correcting such a duplicate carries its batch reference over,
  // so the repair the confirmation's refusal asks for can be made there, while every other edit keeps its batch reference.
  const { state, built, typed } = duplicateBatches("legacy-copy-repair");
  const edited = { ...structuredClone(typed), reference: "R-1C" };
  validateRecord(state, finance, "settlement-batches", edited, true);
  assert.deepEqual([edited.reference, edited.data.batchReference], ["R-1C", "R-1C"], "the duplicate's batch reference follows its corrected reference");
  Object.assign(typed, edited);
  const own = makeRecord(state, "settlement-batches", { name: "Settlement batch R-9", status: "pending", reference: "R-9", data: { batchReference: "R-9", provider: "connection-a", currency: "NGN", grossKobo: 100_000, feeKobo: 500, netKobo: 99_500 } });
  const renamed = { ...structuredClone(own), reference: "R-9 (typed)" };
  validateRecord(state, finance, "settlement-batches", renamed, true);
  assert.deepEqual([renamed.reference, renamed.data.batchReference, built.data.batchReference], ["R-9 (typed)", "R-9", "R-1"], "a batch no other batch shares a reference with keeps its batch reference, the key the provider's lines match by");
}
{
  // Both batches claim ["connection-a","R-1"], so both are held, and neither can be confirmed as that payout.
  const { state, built, typed, holdOf } = duplicateBatches("duplicate-identity");
  assert.deepEqual([built.status, !!built.data.providerIdentityReview, typed.status, !!typed.data.providerIdentityReview], ["variance", true, "variance", true], "both batches are held");
  assert.deepEqual([built.data.providerIdentityClaimedBy, typed.data.providerIdentityClaimedBy], [[{ identity: idR1, batchId: typed.id, reference: "R-1", handEntered: true }], [{ identity: idR1, batchId: built.id, reference: "R-1", handEntered: false }]], "each records the other batch that claims its identity");
  const collision = (other: string) => `Settlement batch R-1 cannot be confirmed as this payout: settlement batch R-1, ${other} also records or claims the payout of connection-a. Confirming whose payout a batch is does not settle two batches claiming the same payout: the lender’s data owner must correct the duplicate batch’s reference or provider. The next reconciliation then releases the right batch.`;
  assert.deepEqual(refusal(state, holdOf(built)!, "Finance", { confirmedProviderIdentity: idR1 }), [409, collision("entered by hand")], "the provider's batch cannot be confirmed as the payout the copy also claims");
  assert.deepEqual(refusal(state, holdOf(typed)!, "Finance", { confirmedProviderIdentity: idR1 }), [409, collision("built from the provider’s lines")], "nor can the copy");
  run(state);
  const saved = kinds(state);
  run(state);
  assert.equal(kinds(state), saved, "reconciling again changes nothing");
  // The data owner corrects the copy's reference: the next reconciliation releases the provider's batch, and the copy as its own.
  const corrected = { ...structuredClone(typed), reference: "R-1C", data: { ...typed.data, batchReference: "R-1C" } };
  validateRecord(state, finance, "settlement-batches", corrected, true);
  const [builtHold, typedHold] = [holdOf(built)!, holdOf(typed)!];
  Object.assign(typed, corrected);
  const answer = run(state);
  assert.deepEqual([built.data.providerIdentityKey, (built.data.providerIdentityRelease as { confirmedBy?: string }).confirmedBy, built.data.providerIdentityClaimedBy, typed.data.providerIdentityKey, typed.data.providerIdentityClaimedBy, answer.data.settlementProviderIdentityReleases], [idR1, undefined, undefined, JSON.stringify(["connection-a", "R-1C"]), undefined, 2], "the genuine batch is released automatically, and so is the corrected copy");
  assert.deepEqual([builtHold.status, builtHold.data.resolutionCode, typedHold.status, typedHold.data.resolutionCode], ["closed", "condition_cleared", "closed", "condition_cleared"]);
}
{
  // Two confirmations of one payout recorded before one reconciliation, as the build before this fix accepted them: neither
  // is applied. Each batch keeps an open exception, a new one since a decision is never reopened, saying why; once the data
  // owner corrects the duplicate, the genuine batch's confirmation applies and the copy is released as its own.
  const { state, built, typed, holdOf } = duplicateBatches("duplicate-confirmations");
  const [builtHold, typedHold] = [holdOf(built)!, holdOf(typed)!];
  for (const hold of [builtHold, typedHold]) {
    Object.assign(hold, { status: "resolved" });
    Object.assign(hold.data, { resolutionCode: "provider_identity_confirmed", confirmedProviderIdentity: idR1, resolvedBy: "Sandbox Finance", resolvedAt: now, resolutionRuleVersion: 1, notes: "Confirmed by the providers." });
  }
  const answer = run(state);
  assert.deepEqual([identityHeldOf(built), identityHeldOf(typed), answer.data.settlementProviderIdentityReleases], [true, true, undefined], "neither confirmation is applied");
  for (const [batch, other] of [[built, "entered by hand"], [typed, "built from the provider’s lines"]] as const) {
    const open = holdOf(batch)!;
    assert.ok(open && ![builtHold.id, typedHold.id].includes(open.id), "the batch has a new open exception for its hold");
    assert.match(String(open.data.notes), new RegExp(`Update on [^:]*: the confirmation recorded on exception .*, of settlement batch R-1 as the payout of connection-a, was not applied: settlement batch R-1, ${other} also records or claims the payout of connection-a`));
  }
  assert.deepEqual([builtHold.status, typedHold.status, builtHold.data.resolutionCode], ["resolved", "resolved", "provider_identity_confirmed"], "the decisions are kept as they were recorded");
  const saved = kinds(state);
  run(state);
  assert.equal(kinds(state), saved, "reconciling again changes nothing");
  const corrected = { ...structuredClone(typed), reference: "R-1C", data: { ...typed.data, batchReference: "R-1C" } };
  validateRecord(state, finance, "settlement-batches", corrected, true);
  Object.assign(typed, corrected);
  run(state);
  assert.deepEqual([(built.data.providerIdentityRelease as { exceptionId?: string }).exceptionId, built.data.providerIdentityKey, typed.data.providerIdentityKey, (typed.data.providerIdentityRelease as { confirmedBy?: string }).confirmedBy], [builtHold.id, idR1, JSON.stringify(["connection-a", "R-1C"]), undefined], "the genuine batch's confirmation applies once no other batch claims its identity, and the copy is released as its own");
  assert.deepEqual(exceptionsOf(state, built).concat(exceptionsOf(state, typed)).filter((item) => item.status === "open"), [], "their open exceptions close");
}
{
  // A batch held for both reasons, its evidence naming two connections and another batch claiming one of them, can be
  // confirmed as the identity nobody else claims; the one the other batch claims is refused.
  let other!: TypedRecord<"settlement-batches">;
  const mixed = mixedBatch("collision-and-mixture", (state) => {
    other = makeRecord(state, "settlement-batches", { name: "Settlement batch SHARED", status: "pending", reference: "SHARED", data: { batchReference: "SHARED", provider: "connection-a", providerConnection: "connection-a", providerIdentityKey: identityOf("connection-a"), currency: "NGN", lineObservationIds: [], linePaymentIds: [], grossKobo: 0, feeKobo: 0, netKobo: 0 } });
  });
  const { state, batch, hold, aLine, aCredit } = mixed;
  assert.deepEqual(batch.data.providerIdentityClaimedBy, [{ identity: identityOf("connection-a"), batchId: other.id, reference: "SHARED", handEntered: false }]);
  assert.equal(refusal(state, hold, "Finance", { confirmedProviderIdentity: identityOf("connection-a") })[0], 409, "the identity the other batch records is refused");
  confirm(state, hold, "Finance", { confirmedProviderIdentity: identityOf("connection-b") });
  run(state); run(state);
  assert.deepEqual([batch.data.providerIdentityKey, batch.status, identityHeldOf(other), other.data.lineObservationIds, aCredit.data.resolvedTo, aLine.data.settlementBatchId], [identityOf("connection-b"), "reconciled", false, [aLine.id], `batch:${other.id}`, other.id], "confirmed as the other connection, the batch is released, and the evidence of connection-a goes to that connection's batch, which is then released");
}
{
  // A confirmation an earlier build recorded although another batch claimed its identity is skipped; it does not outlast
  // Finance's later decision: confirming the identity nobody claims, on the new hold exception, releases the batch as that.
  let copy!: TypedRecord<"settlement-batches">;
  const { state, batch, hold } = mixedBatch("skipped-then-other", (state) => {
    copy = makeRecord(state, "settlement-batches", { name: "Settlement batch SHARED", status: "pending", reference: "SHARED", data: { batchReference: "SHARED", provider: "connection-a", currency: "NGN", grossKobo: 100_000, feeKobo: 500, netKobo: 99_500 } });
  });
  assert.ok(identityHeldOf(copy), "the copy is held too");
  Object.assign(hold, { status: "resolved" });
  Object.assign(hold.data, { resolutionCode: "provider_identity_confirmed", confirmedProviderIdentity: identityOf("connection-a"), resolvedBy: "Sandbox Finance", resolvedAt: now, resolutionRuleVersion: 1, notes: "Confirmed by the providers." });
  runAt(state, wat("2027-07-03T11:00:00"));
  const reopened = exceptionsOf(state, batch).find((item) => item.status === "open" && item.data.condition === `settlement_variance:${batch.id}:provider_identity`)!;
  assert.ok(identityHeldOf(batch) && reopened && reopened.id !== hold.id, "the skipped confirmation leaves the batch held with a new hold exception");
  confirm(state, reopened, "Finance", { confirmedProviderIdentity: identityOf("connection-b") }, wat("2027-07-03T12:00:00"));
  runAt(state, wat("2027-07-03T13:00:00"));
  assert.deepEqual([batch.data.providerIdentityKey, (batch.data.providerIdentityRelease as { exceptionId?: string } | undefined)?.exceptionId], [identityOf("connection-b"), reopened.id], "Finance's later confirmation is the one applied");
  const saved = kinds(state);
  runAt(state, wat("2027-07-03T14:00:00"));
  assert.equal(kinds(state), saved, "reconciling again changes nothing");
}
{
  // A batch released as the identity Finance confirmed stays released when a duplicate later claims it; the duplicate is
  // held and cannot be confirmed as that identity, which the released batch records.
  const { state, batch, hold } = mixedBatch("confirmed-then-duplicate");
  confirm(state, hold, "Finance", { confirmedProviderIdentity: identityOf("connection-a") });
  run(state);
  const copy = makeRecord(state, "settlement-batches", { name: "Settlement batch SHARED", status: "pending", reference: "SHARED", data: { batchReference: "SHARED", provider: "connection-a", currency: "NGN", grossKobo: 100_000, feeKobo: 500, netKobo: 99_500 } });
  runAt(state, wat("2027-07-04T10:00:00"));
  const copyHold = exceptionsOf(state, copy).find((item) => item.status === "open" && item.data.condition === `settlement_variance:${copy.id}:provider_identity`)!;
  assert.deepEqual([identityHeldOf(batch), identityHeldOf(copy), copy.data.providerIdentityClaimedBy], [false, true, [{ identity: identityOf("connection-a"), batchId: batch.id, reference: "SHARED", handEntered: false }]]);
  assert.match(refusal(state, copyHold, "Finance", { confirmedProviderIdentity: identityOf("connection-a") }, wat("2027-07-04T11:00:00"))[1], /cannot be confirmed as this payout: settlement batch SHARED, built from the provider’s lines also records or claims the payout of connection-a/);
}
{
  // Decision on a later hold: the release it ends stays in the batch's history, a confirmation of the earlier hold does not
  // decide the new one, and the new hold has an exception of its own.
  const mixed = mixedBatch("held-again"), { state, batch, hold, bCredit } = mixed;
  confirm(state, hold, "Finance", { confirmedProviderIdentity: identityOf("connection-a") });
  run(state);
  const first = structuredClone(batch.data.providerIdentityRelease) as Record<string, unknown>;
  assert.deepEqual([batch.status, first.exceptionId, first.detachedCreditIds], ["reconciled", hold.id, [bCredit.id]]);
  // A day later, an edit outside reconciliation links connection-b's credit to the batch again.
  const later = wat("2027-07-04T10:00:00"), after = wat("2027-07-05T10:00:00");
  bCredit.data.resolvedTo = `batch:${batch.id}`;
  runAt(state, later); runAt(state, later);
  const history = batch.data.providerIdentityHistory as { release: unknown; heldAgainAt: string; identities: string[] }[];
  assert.deepEqual([batch.status, batch.data.providerIdentityRelease, history.length, history[0]!.release, history[0]!.identities], ["variance", undefined, 1, first, [identityOf("connection-a"), identityOf("connection-b")]], "held again, the batch keeps the release it had in its history and is not released by the earlier confirmation");
  const again = exceptionsOf(state, batch).filter((item) => item.data.condition === `settlement_variance:${batch.id}:provider_identity` && item.status === "open");
  assert.equal(again.length, 1, "the new hold has an open exception of its own");
  // The batch records its identity, which the store keeps, so only that identity can be confirmed now.
  assert.deepEqual(refusal(state, again[0]!, "Finance", { confirmedProviderIdentity: identityOf("connection-b") }), [400, "Choose one of the connections settlement batch SHARED was held for: connection-a."]);
  confirm(state, again[0]!, "Finance", { confirmedProviderIdentity: identityOf("connection-a") }, after);
  runAt(state, after);
  const second = batch.data.providerIdentityRelease as Record<string, unknown>;
  assert.deepEqual([batch.status, second.exceptionId, second.detachedCreditIds, (batch.data.providerIdentityHistory as unknown[]).length], ["reconciled", again[0]!.id, [bCredit.id], 1], "the new confirmation releases it again, and the history keeps the first release");
  const saved = kinds(state);
  runAt(state, after);
  assert.equal(kinds(state), saved, "reconciling again changes nothing");
}
{
  // A confirmed release of a batch whose gross, fee and net Finance typed by hand keeps those, but always takes the moved
  // lines' expected fee out, which Finance cannot type, so a correction of the typed totals reconciles the batch.
  const { state, batch, hold } = mixedBatch("typed-totals", (_state, batch) => Object.assign(batch.data, { grossKobo: 200_000, feeKobo: 1_100, netKobo: 198_900 }));
  confirm(state, hold, "Finance", { confirmedProviderIdentity: identityOf("connection-a") });
  const answer = run(state);
  assert.deepEqual([batch.data.grossKobo, batch.data.feeKobo, batch.data.netKobo, batch.data.expectedFeeKobo, batch.data.feeVarianceKobo], [200_000, 1_100, 198_900, 500, 600], "the typed totals stay and the moved line's expected fee leaves the batch");
  assert.match(String(answer.data.auditNote), /Its amounts before fees, fee and after fees were typed by hand, so they were left as typed\. Only the expected fee of the lines that moved was taken out/);
  Object.assign(batch.data, { grossKobo: 100_000, feeKobo: 500, netKobo: 99_500 }); // Finance corrects the typed totals.
  run(state);
  assert.deepEqual([batch.data.feeVarianceKobo, batch.status], [0, "reconciled"]);
}
{
  // Review fix: a batch Finance entered by hand with no provider claims no connection of its own: its lines, which an
  // earlier build joined to it by reference, name one connection, so it is not held and records theirs.
  const { state, due } = liveFixture({ withFailure: false, merchantId: "hand-entered-no-provider" });
  addAttempt(state, due, { status: "succeeded", occurredAt: wat("2027-07-01T07:00:00"), providerReference: "PSK-7" });
  const batch = makeRecord(state, "settlement-batches", { name: "Settlement batch B-7", status: "reconciled", reference: "B-7", data: { batchReference: "B-7", grossKobo: 2_500_000, feeKobo: 12_500, netKobo: 2_487_500 } });
  const settled = addObservation(state, { reference: "PSK-7", amountKobo: 2_487_500, grossAmountKobo: 2_500_000, feeKobo: 12_500, batchReference: "B-7", source: "settlement", customerId: due.customerId, eventId: "s7", occurredAt: wat("2027-07-01T08:00:00"), provider: "Sandbox Rail Settlements" } as any);
  const bank = addObservation(state, { reference: "STMT-B-7", amountKobo: 2_487_500, batchReference: "B-7", source: "statement", eventId: "st7", occurredAt: wat("2027-07-01T09:00:00") });
  delete bank.data.provider;
  const payment = makeRecord(state, "payments", { name: "Canonical payment", status: "unallocated", reference: "PSK-7", customerId: due.customerId, amountKobo: 2_500_000, data: { providerReference: "PSK-7", providerConnection: "Sandbox Rail Settlements", currency: "NGN", channel: "settlement", collectionStatus: "received", settlementStatus: "settled", reversalStatus: "none", refundStatus: "none", allocatedKobo: 0, canonical: true } });
  Object.assign(batch.data, { enteredTotals: { grossKobo: 2_500_000, feeKobo: 12_500, netKobo: 2_487_500, currency: "NGN" }, lineObservationIds: [settled.id], linePaymentIds: [payment.id], expectedFeeKobo: 12_500, feeVarianceKobo: 0, currency: "NGN", statementObservationId: bank.id, statementNetKobo: 2_487_500 });
  Object.assign(settled, { status: "resolved" }); Object.assign(settled.data, { paymentId: payment.id, settlementBatchId: batch.id, countedGrossKobo: 2_500_000, assumedFeeKobo: 12_500, expectedFeeKobo: 12_500 });
  Object.assign(bank, { status: "resolved" }); Object.assign(bank.data, { resolvedTo: `batch:${batch.id}`, resolutionKey: "settlement_batch_net_credit" });
  const answer = run(state);
  assert.deepEqual([batch.data.providerIdentityReview, batch.status, batch.data.providerIdentityKey, batch.data.providerConnection, answer.data.settlementProviderIdentityHolds], [undefined, "reconciled", JSON.stringify(["sandbox rail settlements", "B-7"]), "Sandbox Rail Settlements", undefined]);
}
for (const kept of ["connection-a", "connection-b"]) {
  const moved = kept === "connection-a" ? "connection-b" : "connection-a";
  const { state, batch, aLine, bLine, aCredit, bCredit, hold } = mixedBatch(`confirm-${kept}`);
  const [keptLine, movedLine, keptCredit, movedCredit] = kept === "connection-a" ? [aLine, bLine, aCredit, bCredit] : [bLine, aLine, bCredit, aCredit];
  const snapshot = structuredClone(batch.data.providerIdentityReview);
  const answer = confirm(state, hold, "Finance", { confirmedProviderIdentity: identityOf(kept) });
  assert.match(answer.message, new RegExp(`The next reconciliation releases settlement batch SHARED as the payout of ${kept}`));
  assert.deepEqual([hold.status, hold.data.confirmedProviderIdentity, hold.data.resolvedBy], ["resolved", identityOf(kept), "Sandbox Finance"], "the decision names the identity and who confirmed it");
  const reconciled = run(state);
  const release = batch.data.providerIdentityRelease as Record<string, unknown>;
  assert.deepEqual([release.identity, release.confirmedBy, release.confirmedAt, release.exceptionId, release.detachedLineIds, release.detachedCreditIds], [identityOf(kept), "Sandbox Finance", now, hold.id, [movedLine.id], [movedCredit.id]], `${kept}: the release records the identity, who confirmed it, when, and what was moved`);
  assert.deepEqual([batch.data.providerIdentityReview, batch.data.providerIdentityKey, batch.data.provider, batch.data.providerConnection, release.previous], [snapshot, identityOf(kept), kept, kept, kept === "connection-a" ? undefined : { provider: "connection-a", providerConnection: "connection-a" }], `${kept}: the snapshot is kept and the batch takes the confirmed connection, keeping any other it recorded`);
  assert.deepEqual([batch.status, batch.data.lineObservationIds, batch.data.grossKobo, batch.data.netKobo, batch.data.statementNetKobo, keptCredit.data.resolvedTo], ["reconciled", [keptLine.id], 100_000, 99_500, 99_500, `batch:${batch.id}`], `${kept}: it keeps its connection's line and credit, and its totals leave the moved line out`);
  const theirs = recordsOf(state, "settlement-batches").find((item) => item.reference === "SHARED" && item.id !== batch.id)!;
  assert.deepEqual([theirs.data.providerIdentityKey, theirs.data.lineObservationIds, movedLine.data.settlementBatchId, movedCredit.data.resolvedTo, theirs.status], [identityOf(moved), [movedLine.id], theirs.id, `batch:${theirs.id}`, "reconciled"], `${kept}: the other connection's line is counted in its own batch, and its credit links there`);
  assert.match(String(reconciled.data.auditNote), new RegExp(`Released settlement batch SHARED as the payout of ${kept}, which Sandbox Finance confirmed .*PAY-${moved}.*STMT-${moved}`));
  const saved = JSON.stringify(state.records.filter((item) => ["settlement-batches", "observations", "exceptions"].includes(item.kind)));
  run(state);
  assert.equal(JSON.stringify(state.records.filter((item) => ["settlement-batches", "observations", "exceptions"].includes(item.kind))), saved, `${kept}: rerunning changes nothing`);
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
// Review fix: a reversal that no payment of its own connection matches is applied, once adopted, to the payment with its
// reference through another connection (canonicalPayment). The renewed review holds that payment and the instalment its
// evidence names, and the repair of the holds the deployed build wrote keeps that hold and that pause while it is open.
function reversalElsewhere(merchantId: string) {
  const { state, due } = liveFixture({ withFailure: false, merchantId });
  const reversal = addObservation(state, { reference: "OLD-REVERSAL", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: "old-reversal", reversed: true, occurredAt: wat("2027-07-01T08:00:00") });
  reconcile(state, ctxAt(wat("2027-07-02T09:00:00"), "Finance"));
  const old = recordsOf(state, "exceptions").find((item) => item.data.linkedRecordId === reversal.id)!;
  Object.assign(old, { status: "resolved", updatedAt: wat("2027-07-02T09:30:00") });
  Object.assign(old.data, { resolutionCode: "provider_state_adopted", resolvedAt: old.updatedAt, resolvedBy: "Earlier Finance", notes: "Original provider review." });
  // The collection it reverses arrived only in the settlement file, through another spelling of the connection.
  addObservation(state, { reference: "OLD-REVERSAL", amountKobo: due.amountKobo - 12_500, grossAmountKobo: due.amountKobo, feeKobo: 12_500, batchReference: "B-9", source: "settlement", customerId: due.customerId, eventId: "set-1", occurredAt: wat("2027-07-02T10:00:00"), provider: "Sandbox Rail Settlements", dueItemId: due.id } as any);
  reconcile(state, ctxAt(wat("2027-07-02T11:00:00"), "Finance"));
  delete old.data.resolutionRuleVersion; // The earlier build recorded no rule version.
  const payment = recordsOf(state, "payments").find((item) => item.reference === "OLD-REVERSAL")!;
  return { state, due, reversal, payment };
}
{
  const { state, due, reversal, payment } = reversalElsewhere("reversal-elsewhere");
  assert.deepEqual([payment.data.providerConnection, payment.status], ["Sandbox Rail Settlements", "unallocated"]);
  run(state);
  const review = reviewOf(state);
  assert.deepEqual([review.status, holdsOf(payment), holdsOf(due), due.status, pauseOf(due)?.status], ["open", [review.id], [review.id], "in_dispute", "scheduled"], "the payment an adoption would reverse, and the instalment its evidence names, are held");
  assert.throws(() => transaction(state, () => allocatePayment(state, finance, payment, due, due.amountKobo, "manual", "manual", false)), /held for renewed Finance review/);
  resolve(state, review, "provider_state_adopted");
  run(state); run(state);
  assert.deepEqual([payment.data.reversalStatus, reversal.data.paymentId, reversal.data.resolutionKey, due.status, holdsOf(payment), holdsOf(due), pauseOf(due)], ["reversed", payment.id, "adopted_after_review", "scheduled", undefined, undefined, undefined], "adopted, the reversal reverses that payment, which was never applied, and the instalment gets its status back");
}
{
  // The same records as the deployed build held them: it followed the reference through any connection.
  const { state, due, payment } = reversalElsewhere("reversal-elsewhere-deployed");
  run(state);
  const review = reviewOf(state);
  holdAsPr61(review, [due], [payment]);
  const answer = run(state);
  assert.deepEqual([holdsOf(payment), holdsOf(due), due.status, pauseOf(due), answer.data.legacyReversalStatusesRestored], [[review.id], [review.id], "in_dispute", { status: "scheduled", pausedAt: now, inferred: true }, undefined], "the repair keeps that hold and leaves the instalment paused while the review is open");
}

console.log("Financial migration regressions passed: unversioned reversal authority, renewed Finance review, prior allocations/dispositions, replay, provider-scoped settlement and legacy quarantine, one fee schedule per settlement line, the quarantine kept to genuinely ambiguous batches and released otherwise, Finance's confirmation of a held batch's connection as its only resolution, with a data owner's repair releasing it and one renewed review of an earlier decision, and reversal review holds that keep instalment statuses and reach only the reversal's own connection.");
