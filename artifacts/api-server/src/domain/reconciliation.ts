/** Ordered reconciliation pass. Workflow modules share this pass's record index; none owns persistence, provider calls or audit publication. */
import { type DomainState, type Context, type TypedRecord } from "./types";
import { indexedPass, recordsWhere } from "./record-index";
import { recordsOf, touch } from "./records";
import { reviewEarlierReversalDecisions, CanonicalPaymentIndex, reportsReversal, canonicalPayment, refreshHeldEvidence } from "./reconciliation-evidence";
import { recordExceptionCurrencies, raiseException, confirmAttemptOutcome, clearSettledExceptions, clearedExceptionsNote } from "./reconciliation-exceptions";
import { holdEarlierSettlementIdentities, releasedBatchesNote, identityReviewsNote } from "./reconciliation-settlement-identity";
import { separateEarlierCurrencies, SettlementLines, settlementBatch, recountEarlierLines, linkSettlementStatements, evaluateSettlementBatches, keepLinesCountedTwiceReported, separatedLinesNote } from "./reconciliation-settlement";
import { holdEarlierReversalPayments, restoredStatusesNote } from "./reconciliation-reversal-holds";
import { paymentsToSettle, settlePaymentStatus } from "./reconciliation-payments";
import { derivedDueStatus, settleDueStatus } from "./reconciliation-instalments";
import { MatchIndex } from "./reconciliation-matching-index";
import { matchPayment } from "./reconciliation-matching";
import { paymentUnappliedKobo, paymentAwaitsAllocation, moneyText, resolveExceptionType, isOpenException, normaliseFailureCode } from "@workspace/valopay-schema";
import { identityCondition, paymentReturned, paymentObservedAt, UNALLOCATED_AGE_MS, currencyOf, UNKNOWN_OUTCOME_AGE_MS } from "./reconciliation-values";
import { applyDecisions, ageUnknownCheckouts } from "./reconciliation-retry-decisions";
import { attemptTime } from "./policy-engine";

// Compatibility entry point: existing callers retain the same public reconciliation API.
export { clearSettledExceptions, clearedExceptionsNote, confirmAttemptOutcome, exceptionCurrency, raiseException, withAuditNote, type MoneyLookup } from "./reconciliation-exceptions";
export { currencyOf, paymentReversed } from "./reconciliation-values";
export { DUPLICATE_WINDOW_MS, UNALLOCATED_AGE_MS, UNSEEN_REVERSAL_AGE_MS, UNKNOWN_OUTCOME_AGE_MS, paymentRefunded, paymentReturned, paymentObservedAt, allocationConfirmedAt, connectionOf, identityHeld } from "./reconciliation-values";
export { paymentDimensions, allocatePayment, allocationPayer, withdrawPayerIdentification, applyConfirmedAllocation, supersedeAllocation, releaseDispute, REVIEW_SUPERSESSION, supersededByReview, reinstateAllocation, settlePaymentStatus, recordPaymentRefund, releaseDuplicateHold, rememberRejectedMatch, forgetRejectedMatch, reversePayment } from "./reconciliation-payments";
export { feeScheduleFor } from "./reconciliation-settlement-totals";
export { identityExceptionHeld, heldBatchToConfirm, identityClaimedElsewhere } from "./reconciliation-settlement-identity";
export { settlementBatchState } from "./reconciliation-settlement";
export { derivedDueStatus, dueStatusText, settleDueStatus, amendDueItem } from "./reconciliation-instalments";
export { reportsReversal, refreshHeldEvidence } from "./reconciliation-evidence";
export { intendedDueItem } from "./reconciliation-matching-index";
export { checkoutUnknownSince } from "./reconciliation-retry-decisions";

/**
 * One reconciliation pass over the lender's records, run with its lookups
 * indexed (indexedPass): a close that confirms many matches, or evaluates many
 * instalments, costs what its records do rather than their number times the
 * items it handles.
 */
export function reconcile(state: DomainState, ctx: Context): ReturnType<typeof reconcileRecords> {
  return indexedPass(state, () => reconcileRecords(state, ctx));
}

function reconcileRecords(state: DomainState, ctx: Context) {
  const exceptionsBefore = recordsOf(state, "exceptions").length;
  const legacyReviews = reviewEarlierReversalDecisions(state, ctx);
  const observations = recordsOf(state, "observations").filter((item) => item.status === "unresolved");
  // Exceptions an earlier build raised for money in another currency name it from now on.
  const currenciesRecorded = recordExceptionCurrencies(state, ctx);
  const identities = holdEarlierSettlementIdentities(state, ctx);
  // Batches an earlier build saved in several currencies hold one from now on, before any line is counted.
  const separated = separateEarlierCurrencies(state, ctx);
  const canonicalPayments = new CanonicalPaymentIndex(state), settlementLines = new SettlementLines(state);
  // The lines a released batch held are counted as they would have been when they arrived, before this pass's evidence.
  for (const line of identities.released.flatMap((item) => [...item.held, ...(item.detached ?? [])])) {
    const payment = recordsWhere(state, "payments", "id", String(line.data.paymentId ?? ""))[0];
    if (payment) settlementBatch(state, ctx, line, payment, settlementLines);
  }
  // Evidence of a reversal is read after every other piece of evidence, so the payment it reverses, arriving in the same
  // import or close, is recorded first whatever order the evidence arrived in.
  const ordered = [...observations.filter((item) => !reportsReversal(item)), ...observations.filter(reportsReversal)];
  const resolved = ordered.map((item) => canonicalPayment(state, ctx, item, canonicalPayments, settlementLines)).filter(Boolean) as TypedRecord<"payments">[];
  const holdsRestored = holdEarlierReversalPayments(state, ctx, legacyReviews);
  recountEarlierLines(state, ctx);
  const statements = linkSettlementStatements(state, ctx);
  const identityReviews: TypedRecord<"exceptions">[] = [];
  const batchVariances = evaluateSettlementBatches(state, ctx, statements.credits, identityReviews);
  keepLinesCountedTwiceReported(state, ctx);
  const allocationsBefore = new Set(recordsOf(state, "allocations").map((item) => item.id));
  // Statuses written before these rules, or by a path that did not settle the
  // payment, are re-derived first, so the rule ladder only sees whole,
  // unapplied payments that still hold their money.
  const repaired = paymentsToSettle(state);
  repaired.forEach((payment) => settlePaymentStatus(state, ctx, payment));
  // Instalment statuses that contradict their stored balance, as an amount edit
  // could leave them before this rule, are re-derived before matching and before
  // the engine evaluates them. A record without a stored balance is left alone.
  const duesRepaired = recordsOf(state, "due-items")
    .filter((due) => Number.isInteger(due.data.outstandingKobo) && derivedDueStatus(state, due) !== due.status)
    .filter((due) => settleDueStatus(state, ctx, due)).length;
  const matches = new MatchIndex(state);
  let paymentsSkipped = 0;
  for (const payment of recordsOf(state, "payments").filter((item) => item.status === "unallocated")) {
    try {
      matchPayment(state, ctx, payment, matches);
    } catch (error) {
      // A payment the ladder cannot apply is held for Finance with the reason and an exception; one record never stops the close.
      if (!(error instanceof Error) || error.constructor !== Error) throw error;
      const explanation = `Automatic matching could not allocate this payment, so it waits for Finance. ${error.message}`;
      if (payment.data.explanation !== explanation) { payment.data.explanation = explanation; touch(payment, ctx.now); }
      raiseException(state, ctx, "unallocated_payment", { linkedRecordId: payment.id, customerId: payment.customerId, amountKobo: paymentUnappliedKobo(payment), notes: explanation, condition: identityCondition("unallocated_payment", payment.id) });
      paymentsSkipped += 1;
    }
  }
  const now = Date.parse(ctx.now);
  // REC-04: money waiting for Finance ages into an exception: an unallocated payment, and the unapplied rest of one
  // applied in part. An overpayment's excess has its own exception already.
  const aged = recordsOf(state, "payments").filter((item) => ["unallocated", "partial"].includes(item.status) && paymentAwaitsAllocation(item) && !paymentReturned(item) && now - paymentObservedAt(item) >= UNALLOCATED_AGE_MS);
  aged.forEach((payment) => {
    const left = paymentUnappliedKobo(payment), rest = payment.status === "partial";
    raiseException(state, ctx, "unallocated_payment", {
      linkedRecordId: payment.id, customerId: payment.customerId, amountKobo: left,
      notes: rest ? `${moneyText(left, currencyOf(payment))} of this payment is still not allocated to an instalment after 24 hours.` : "This payment has not been allocated to an instalment after 24 hours.",
      condition: rest ? `unallocated_payment:${payment.id}:unapplied:${left}` : identityCondition("unallocated_payment", payment.id),
    });
  });
  // Outcomes resolved before resolutions updated the attempt are applied now, the latest resolution first,
  // so those instalments stop waiting as in flight.
  const unknownAttempts = new Set(recordsOf(state, "attempts").filter((attempt) => attempt.status === "unknown").map((attempt) => attempt.id));
  const resolvedAt = (item: TypedRecord<"exceptions">) => String(item.data.resolvedAt || item.updatedAt);
  const outcomesConfirmed = recordsOf(state, "exceptions")
    .filter((item) => unknownAttempts.has(String(item.data.linkedRecordId)) && resolveExceptionType(item.data.type) === "unknown_outcome" && !isOpenException(item.status))
    .sort((a, b) => resolvedAt(b).localeCompare(resolvedAt(a)))
    .filter((item) => confirmAttemptOutcome(state, ctx, item)).length;
  const giveUps = applyDecisions(state, ctx);
  const unknownOutcomes = recordsOf(state, "attempts").filter((attempt) => attempt.status === "unknown" && now - Date.parse(attemptTime(attempt)) >= UNKNOWN_OUTCOME_AGE_MS);
  unknownOutcomes.forEach((attempt) => raiseException(state, ctx, "unknown_outcome", { linkedRecordId: attempt.id, customerId: attempt.customerId, amountKobo: attempt.amountKobo, notes: "The collection attempt’s outcome has been unknown for 24 hours. Ask the provider to confirm it, using the payment reference.", condition: identityCondition("unknown_outcome", attempt.id) }));
  const checkoutsUnknown = ageUnknownCheckouts(state, ctx, now);
  const mappingNeeded = recordsOf(state, "attempts").filter((attempt) => attempt.status === "failed" && normaliseFailureCode(attempt.data.failureCode) === "UNKNOWN" && attempt.data.rawFailureCode);
  mappingNeeded.forEach((attempt) => raiseException(state, ctx, "mapping_needed", { linkedRecordId: attempt.id, customerId: attempt.customerId, amountKobo: attempt.amountKobo, notes: `The provider’s failure code “${attempt.data.rawFailureCode}” is not recognised. Classify it, so Valo Pay knows whether to retry.`, condition: `mapping_needed:${attempt.id}:${attempt.data.rawFailureCode}` }));
  // Matching may have tied a payment a hold names to an instalment: the holds are re-derived as the payments now stand.
  refreshHeldEvidence(state, ctx);
  // Last, so nothing raised above is left open once its condition cleared.
  const cleared = [...identities.cleared, ...clearSettledExceptions(state, ctx)];
  const newAllocations = recordsOf(state, "allocations").filter((item) => !allocationsBefore.has(item.id));
  const allocationsByRule: Record<string, number> = {};
  for (const allocation of newAllocations) allocationsByRule[String(allocation.data.rule)] = (allocationsByRule[String(allocation.data.rule)] || 0) + 1;
  const observationsBySource: Record<string, number> = {};
  for (const observation of observations.filter((item) => item.status === "resolved")) observationsBySource[String(observation.data.source)] = (observationsBySource[String(observation.data.source)] || 0) + 1;
  return {
    message: "Reconciliation complete. Payment evidence has been checked for matches. No money moved, and no collection instruction was sent.",
    data: {
      observationsResolved: observations.filter((item) => item.status === "resolved").length, observationsBySource, canonicalPayments: resolved.length,
      settlementStatementsMatched: statements.linked, settlementVariances: batchVariances, allocationsByRule, paymentStatusesRepaired: repaired.length, dueStatusesRepaired: duesRepaired, paymentsSkipped, attemptOutcomesConfirmed: outcomesConfirmed,
      proposed: recordsOf(state, "payments").filter((item) => item.status === "proposed").length,
      unallocated: recordsOf(state, "payments").filter((item) => paymentAwaitsAllocation(item)).length,
      possibleDuplicates: recordsOf(state, "payments").filter((item) => item.status === "possible_duplicate").length,
      agedUnallocated: aged.length, finalAttemptExceptions: giveUps.finalFailures, disputesFrozen: giveUps.disputes, noticesNotEvidenced: giveUps.deferred, retryDecisionsRecorded: giveUps.decisionsRecorded, unknownOutcomes: unknownOutcomes.length,
      checkoutOutcomesUnknown: checkoutsUnknown, exceptionsOpened: recordsOf(state, "exceptions").length - exceptionsBefore, exceptionsCleared: cleared.length,
      ...(currenciesRecorded ? { exceptionCurrenciesRecorded: currenciesRecorded } : {}),
      ...(identities.held ? { settlementProviderIdentityHolds: identities.held } : {}),
      ...(identities.released.length ? { settlementProviderIdentityReleases: identities.released.length } : {}),
      ...(identityReviews.length ? { settlementProviderIdentityReviews: identityReviews.length } : {}),
      ...(legacyReviews.some((item) => isOpenException(item.status)) ? { legacyReversalReviewsPending: legacyReviews.filter((item) => isOpenException(item.status)).length } : {}),
      ...(holdsRestored.length ? { legacyReversalStatusesRestored: holdsRestored.length } : {}),
      ...(separated.length ? { settlementLinesSeparated: separated.length } : {}),
      ...(cleared.length || legacyReviews.length || separated.length || identities.released.length || identityReviews.length ? { auditNote: [releasedBatchesNote(identities.released), identityReviewsNote(state, identityReviews), separatedLinesNote(separated), clearedExceptionsNote(cleared), legacyReviews.some((item) => isOpenException(item.status)) ? "Some earlier reversal decisions need a fresh Finance review. Past decisions and payments were left as they were." : undefined, restoredStatusesNote(holdsRestored)].filter(Boolean).join(" ") } : {}),
    },
  };
}
