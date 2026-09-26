import { conditionClearedCode, heldEvidenceOf, isOpenException, providerConnectionKey, resolveExceptionType, unseenReversalOf } from "@workspace/valopay-schema";
import { evidenceConflict } from "./evidence-agreement";
import { indexedPass, recordsWhere } from "./record-index";
import type { DomainState, TypedRecord, ValopayRecord } from "./types";

/** The effective decision is shared by reconciliation and guards that run before its first migration pass. */
export function latestEvidenceResolution(state: DomainState, observation: TypedRecord<"observations">): TypedRecord<"exceptions"> | undefined {
  const resolvedAt = (item: TypedRecord<"exceptions">) => String(item.data.resolvedAt || item.updatedAt);
  let latest: TypedRecord<"exceptions"> | undefined;
  const renewals: TypedRecord<"exceptions">[] = [];
  for (const exception of recordsWhere(state, "exceptions", "data.linkedRecordId", observation.id)) {
    const code = exception.data.resolutionCode;
    if (isOpenException(exception.status) || !code || code === conditionClearedCode) continue;
    const type = resolveExceptionType(exception.data.type);
    const decides = type === "suspected_duplicate" ? heldEvidenceOf(exception.data.condition)?.observationId === observation.id : type === "provider_status_mismatch" && unseenReversalOf(exception.data.condition) === observation.id;
    if (decides && exception.data.legacyResolutionReview && exception.data.resolutionRuleVersion !== undefined) renewals.push(exception);
    if (decides && (!latest || resolvedAt(exception) >= resolvedAt(latest))) latest = exception;
  }
  // Explicit renewal supersedes the decision it names even across historical host clock skew.
  const seen = new Set<string>();
  while (latest && !seen.has(latest.id)) {
    seen.add(latest.id);
    const id = latest.id;
    const renewed = renewals.find((item) => (item.data.legacyResolutionReview as { priorExceptionId?: string }).priorExceptionId === id);
    if (!renewed) break;
    latest = renewed;
  }
  return latest;
}

function observationNeedsReview(state: DomainState, observation: TypedRecord<"observations">): boolean {
  if (observation.data.reversed !== true && observation.data.reversalStatus !== "reversed") return false;
  if (recordsWhere(state, "exceptions", "data.linkedRecordId", observation.id).some((item) => item.data.legacyResolutionReview && isOpenException(item.status))) return true;
  const latest = latestEvidenceResolution(state, observation);
  return !!latest && resolveExceptionType(latest.data.type) === "provider_status_mismatch" && latest.data.resolutionRuleVersion === undefined;
}

/** ING-03: the connection a record came through, its providerConnection, else its provider, else the lender's, compared without case or surrounding spaces. */
const connectionKeyOf = (state: DomainState, record: ValopayRecord): string => providerConnectionKey(String(record.data.providerConnection || record.data.provider || state.merchant.provider));
/** A payment's references: its own and its provider reference. */
const referencesOf = (payment: TypedRecord<"payments">): string[] => [...new Set([payment.reference, payment.data.providerReference].filter((value): value is string => typeof value === "string" && !!value))];

/** The connections reconciliation keys a payment under: its own, and those of the evidence resolved to it. */
function paymentConnections(state: DomainState, payment: TypedRecord<"payments">): Set<string> {
  const connections = new Set([connectionKeyOf(state, payment)]);
  for (const reference of referencesOf(payment)) for (const evidence of recordsWhere(state, "observations", "reference", reference)) {
    if (evidence.status === "resolved" && evidence.data.paymentId === payment.id) connections.add(connectionKeyOf(state, evidence));
  }
  return connections;
}

/** Whether a reversal names a payment through its own provider identity: resolved to it, or keyed, as the payment is, by its connection and reference. */
function reversalNamesPayment(state: DomainState, reversal: TypedRecord<"observations">, payment: TypedRecord<"payments">): boolean {
  return reversal.data.paymentId === payment.id || (referencesOf(payment).includes(reversal.reference) && paymentConnections(state, payment).has(connectionKeyOf(state, reversal)));
}

/** An allocation still in use: applied, or proposed. */
const liveAllocation = (allocation: TypedRecord<"allocations">): boolean => allocation.status === "confirmed" || allocation.status === "proposed";

/** The payers of the instalments a payment is tied to: the one its evidence names and the one it is proposed for. */
const tiedPayers = (state: DomainState, payment: TypedRecord<"payments">): string[] => [payment.data.dueItemId, payment.data.proposedDueItemId]
  .map((id) => (id ? recordsWhere(state, "due-items", "id", String(id))[0]?.customerId : undefined)).filter((customerId): customerId is string => !!customerId);

/**
 * The payment an adopted decision would reverse through another connection, as reconciliation applies one
 * (canonicalPayment): when neither the reversal's paymentId nor its own connection and reference name a payment, the
 * first payment made with its reference under any connection, provided it agrees with the reversal (evidenceConflict:
 * the same payer, currency and amount). Undefined otherwise.
 */
function adoptedElsewhere(state: DomainState, reversal: TypedRecord<"observations">): TypedRecord<"payments"> | undefined {
  if (!reversal.reference) return undefined;
  if (typeof reversal.data.paymentId === "string" && recordsWhere(state, "payments", "id", reversal.data.paymentId)[0]) return undefined;
  // First made first, as reconciliation's payment index orders them.
  const withReference = [...new Set([...recordsWhere(state, "payments", "reference", reversal.reference), ...recordsWhere(state, "payments", "data.providerReference", reversal.reference)])]
    .sort((a, b) => state.records.indexOf(a) - state.records.indexOf(b));
  if (withReference.some((payment) => reversalNamesPayment(state, reversal, payment))) return undefined;
  const first = withReference[0];
  return first && !evidenceConflict(first, reversal, (payment) => tiedPayers(state, payment)) ? first : undefined;
}

/**
 * FIN-02, decision on what a renewed reversal review holds: exactly the
 * payments adopting the decision would reverse, and the instalments they and
 * the reversal concern, never through an allocation no longer in use. The
 * payments are the one it is resolved to and those keyed by its connection and
 * reference; when none is, the one an adopted decision reverses through another
 * connection (adoptedElsewhere), which is the only payment of another
 * connection it holds. The instalments are the one it names, those its debit
 * attempts with its reference through its connection collect, and those the
 * held payments' evidence names or their live allocations (applied or
 * proposed) are for.
 */
export function reversalHoldScope(state: DomainState, reversal: TypedRecord<"observations">): { payments: TypedRecord<"payments">[]; dueIds: Set<string> } {
  const connection = connectionKeyOf(state, reversal), payments = new Map<string, TypedRecord<"payments">>(), dueIds = new Set<string>();
  const add = (id: unknown) => { if (typeof id === "string" && id) dueIds.add(id); };
  const named = typeof reversal.data.paymentId === "string" ? recordsWhere(state, "payments", "id", reversal.data.paymentId)[0] : undefined;
  if (named) payments.set(named.id, named);
  add(reversal.data.dueItemId);
  for (const key of ["reference", "data.providerReference"] as const) {
    if (!reversal.reference) break;
    for (const payment of recordsWhere(state, "payments", key, reversal.reference)) if (reversalNamesPayment(state, reversal, payment)) payments.set(payment.id, payment);
    for (const attempt of recordsWhere(state, "attempts", key, reversal.reference)) if (connectionKeyOf(state, attempt) === connection) add(attempt.data.dueItemId);
  }
  const elsewhere = payments.size ? undefined : adoptedElsewhere(state, reversal);
  if (elsewhere) payments.set(elsewhere.id, elsewhere);
  for (const payment of payments.values()) {
    add(payment.data.dueItemId);
    for (const allocation of recordsWhere(state, "allocations", "data.paymentId", payment.id)) if (liveAllocation(allocation)) add(allocation.data.dueItemId);
  }
  return { payments: [...payments.values()], dueIds };
}

/** Reversal evidence with this reference that needs a renewed review. */
const reversalsNeedingReview = (state: DomainState, reference: unknown): TypedRecord<"observations">[] =>
  typeof reference === "string" && reference ? recordsWhere(state, "observations", "reference", reference).filter((observation) => observationNeedsReview(state, observation)) : [];

const storedHold = (record: TypedRecord<"payments"> | TypedRecord<"due-items">): boolean => Array.isArray(record.data.legacyReversalReviewIds) && record.data.legacyReversalReviewIds.length > 0;

/** No action may apply ambiguous historical money while waiting for the first reconciliation to materialise its hold (reversalHoldScope). */
export function paymentNeedsReversalReview(state: DomainState, payment: TypedRecord<"payments">): boolean {
  return indexedPass(state, () => storedHold(payment) || referencesOf(payment).some((reference) => reversalsNeedingReview(state, reference)
    .some((reversal) => reversalNamesPayment(state, reversal, payment) || adoptedElsewhere(state, reversal)?.id === payment.id)));
}

/** Follow the reversal's own evidence, debit and payments (reversalHoldScope); do not infer a hold from a customer's other obligations. */
export function dueNeedsReversalReview(state: DomainState, due: TypedRecord<"due-items">): boolean {
  return indexedPass(state, () => {
    if (storedHold(due)) return true;
    if (recordsWhere(state, "observations", "data.dueItemId", due.id).some((observation) => observationNeedsReview(state, observation))) return true;
    for (const attempt of recordsWhere(state, "attempts", "data.dueItemId", due.id)) {
      const through = connectionKeyOf(state, attempt);
      if ([attempt.reference, attempt.data.providerReference].some((reference) => reversalsNeedingReview(state, reference).some((reversal) => connectionKeyOf(state, reversal) === through))) return true;
    }
    const payments = [
      ...recordsWhere(state, "payments", "data.dueItemId", due.id),
      ...recordsWhere(state, "allocations", "data.dueItemId", due.id).filter(liveAllocation).flatMap((allocation) => recordsWhere(state, "payments", "id", allocation.data.paymentId)),
    ];
    return payments.some((payment) => paymentNeedsReversalReview(state, payment));
  });
}
