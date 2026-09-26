/** TRD Appendix A exception catalogue: trigger, default owner, SLA and controlled resolution codes. */
export interface ExceptionDefinition {
  readonly title: string;
  readonly trigger: string;
  readonly owner: string;
  readonly slaBusinessDays: number;
  readonly severity: "low" | "medium" | "high";
  readonly resolutionCodes: readonly string[];
}

/** The Appendix A catalogue, keyed by exception type. */
export const exceptionCatalogue = {
  activation_expired: { title: "Activation deadline passed", trigger: "Mandate passes its activation deadline", owner: "Operations", slaBusinessDays: 2, severity: "medium", resolutionCodes: ["reissued", "customer_declined", "wrong_number", "abandoned"] },
  unallocated_payment: { title: "Unallocated payment", trigger: "A payment is still unmatched after 24 hours", owner: "Finance", slaBusinessDays: 2, severity: "medium", resolutionCodes: ["allocated_manual", "refund_requested", "held_credit", "not_ours"] },
  suspected_duplicate: { title: "Suspected duplicate", trigger: "A payment may be a duplicate of another payment", owner: "Finance", slaBusinessDays: 2, severity: "high", resolutionCodes: ["confirmed_duplicate_refund", "distinct_payments", "applied_to_next", "same_payment", "not_money"] },
  overpayment: { title: "Overpayment", trigger: "The allocated amount is more than the instalment due", owner: "Finance", slaBusinessDays: 2, severity: "medium", resolutionCodes: ["refund_requested", "held_credit", "applied_to_next"] },
  unpaid_after_final_attempt: { title: "Unpaid after final attempt", trigger: "The retry policy allows no further attempts", owner: "Operations", slaBusinessDays: 2, severity: "medium", resolutionCodes: ["paid_other_channel", "rescheduled_by_lms", "written_off_by_lms", "mandate_reissued"] },
  mandate_limit_exceeded: { title: "Mandate limit exceeded", trigger: "Due amount above the mandate limit", owner: "Operations", slaBusinessDays: 2, severity: "medium", resolutionCodes: ["limit_raised_new_mandate", "split_by_lms", "cancelled"] },
  settlement_variance: { title: "Settlement variance", trigger: "The net settlement amount does not match the gross amount minus fees", owner: "Finance", slaBusinessDays: 2, severity: "medium", resolutionCodes: ["fee_schedule_updated", "provider_corrected", "accepted_variance", "provider_identity_confirmed"] },
  provider_status_mismatch: { title: "Provider status mismatch", trigger: "Provider and platform disagree on mandate or attempt state", owner: "Operations", slaBusinessDays: 1, severity: "medium", resolutionCodes: ["provider_state_adopted", "platform_state_confirmed", "escalated_to_provider"] },
  customer_dispute: { title: "Customer dispute", trigger: "The provider reports a disputed debit, or the lender records a customer dispute", owner: "Operations", slaBusinessDays: 1, severity: "high", resolutionCodes: ["upheld_refund", "not_upheld", "mandate_cancelled"] },
  unknown_outcome: { title: "Unknown outcome", trigger: "A debit's outcome, or a pay-by-bank payment's, is still unknown after 24 hours", owner: "Operations", slaBusinessDays: 1, severity: "high", resolutionCodes: ["resolved_succeeded", "resolved_failed", "provider_confirmed_no_debit"] },
  notice_not_evidenced: { title: "Notice acceptance not confirmed", trigger: "There is no evidence that the provider accepted a required notice by its deadline", owner: "Operations", slaBusinessDays: 1, severity: "medium", resolutionCodes: ["number_corrected", "channel_restored", "deferred_executed", "customer_unreachable_cancelled"] },
  ownership_conflict: { title: "Ownership conflict", trigger: "Another system attempted collection for a group assigned to Valo Pay, or the group changed before the required ownership check", owner: "Admin", slaBusinessDays: 1, severity: "high", resolutionCodes: ["incumbent_disabled", "owner_reverted", "duplicate_refund_requested"] },
  imported_consent_gap: { title: "Missing consent evidence", trigger: "An imported mandate with missing consent evidence", owner: "Admin", slaBusinessDays: 2, severity: "high", resolutionCodes: ["gap_accepted_in_writing", "evidence_supplied", "mandate_reissued", "observation_only"] },
  mapping_needed: { title: "Failure code needs classification", trigger: "The provider returned a failure code that has not been classified", owner: "Valo Pay ops", slaBusinessDays: 2, severity: "low", resolutionCodes: ["mapped_to_code"] },
} as const satisfies Record<string, ExceptionDefinition>;

/** A catalogue exception type. */
export type ExceptionType = keyof typeof exceptionCatalogue;
/** Every catalogue type. */
export const exceptionTypes = Object.keys(exceptionCatalogue) as ExceptionType[];

/** Type spellings earlier builds wrote.  Read as the catalogue type, never written. */
export const exceptionTypeAliases: Readonly<Record<string, ExceptionType>> = {
  possible_duplicate: "suspected_duplicate",
  duplicate: "suspected_duplicate",
  unallocated: "unallocated_payment",
  final_attempt: "unpaid_after_final_attempt",
};

/** Reads a type from stored or input data, accepting earlier spellings; undefined when unknown. */
export function resolveExceptionType(raw: unknown): ExceptionType | undefined {
  const value = String(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (value in exceptionCatalogue) return value as ExceptionType;
  return exceptionTypeAliases[value];
}

/** Codes accepted for an exception whose type is not in the catalogue (legacy rows). */
export const genericResolutionCodes = ["no_action_required", "customer_contacted", "evidence_received", "ownership_corrected", "refunded_externally", "allocated", "duplicate_confirmed", "mandate_reissued"] as const;

/**
 * The code the platform records when it closes an exception whose condition
 * cleared: its payment was allocated in full, refunded or reversed, its
 * instalment was paid or left dispute, or its outcome became known. It is
 * never a person's resolution, so no type offers it.
 */
export const conditionClearedCode = "condition_cleared";

/** The controlled resolution codes for an exception's type, or the generic list for a type outside the catalogue. */
export function resolutionCodesFor(rawType: unknown): readonly string[] {
  const type = resolveExceptionType(rawType);
  return type ? exceptionCatalogue[type].resolutionCodes : genericResolutionCodes;
}

/**
 * Finance's resolutions of payment evidence held for review (a
 * suspected_duplicate linked to the evidence): same_payment joins it to the
 * payment its exception names as more evidence of that payment, and not_money
 * sets it aside, so no payment is made from it.
 */
export const heldEvidenceCodes = { samePayment: "same_payment", notMoney: "not_money" } as const;

/**
 * The condition a suspected_duplicate for held payment evidence is raised
 * with: the evidence, the payment its exception names, and whether it was
 * held only because it came through another connection than that payment.
 */
export function heldEvidenceCondition(observationId: string, paymentId: string, connectionOnly: boolean): string {
  return connectionOnly ? `suspected_duplicate:${observationId}:connection:${paymentId}` : `suspected_duplicate:${observationId}:${paymentId}`;
}

/** What a held-evidence condition (heldEvidenceCondition) names; undefined for any other condition. */
export function heldEvidenceOf(condition: unknown): { observationId: string; paymentId: string; connectionOnly: boolean } | undefined {
  const parts = String(condition ?? "").split(":");
  if (parts[0] !== "suspected_duplicate" || !parts[1]) return undefined;
  if (parts.length === 4 && parts[2] === "connection" && parts[3]) return { observationId: parts[1], paymentId: parts[3], connectionOnly: true };
  if (parts.length === 3 && parts[2]) return { observationId: parts[1], paymentId: parts[2], connectionOnly: false };
  return undefined;
}

/**
 * The condition a Finance-owned provider_status_mismatch is raised with for
 * evidence of a reversal that has waited for a payment no connection has seen.
 */
export function unseenReversalCondition(observationId: string): string {
  return `provider_status_mismatch:${observationId}:unseen`;
}

/** The evidence an unseen-payment condition (unseenReversalCondition) names; undefined for any other condition. */
export function unseenReversalOf(condition: unknown): string | undefined {
  const parts = String(condition ?? "").split(":");
  return (parts.length === 3 || (parts.length === 5 && parts[3] === "review" && !!parts[4])) && parts[0] === "provider_status_mismatch" && parts[1] && parts[2] === "unseen" ? parts[1] : undefined;
}

/**
 * Finance's resolutions of a reversal that waited for a payment no connection
 * has seen: setAside (platform_state_confirmed) sets it aside for good, so it
 * reverses nothing even if its payment arrives later; adopted
 * (provider_state_adopted) keeps it waiting, with no new exception, and the
 * reconciliation that records its payment reverses that payment. While Finance
 * checks with the provider, the exception stays open.
 */
export const unseenReversalCodes = { setAside: "platform_state_confirmed", adopted: "provider_state_adopted" } as const;

/**
 * FIN-03: the condition a settlement_variance is raised with for a settlement
 * batch held for its provider identity, because its evidence names more than one
 * provider connection or another batch claims its identity.
 */
export function providerIdentityCondition(batchId: string): string {
  return `settlement_variance:${batchId}:provider_identity`;
}

/**
 * The condition of a renewed review of an earlier decision on a batch's provider
 * identity hold: reconciliation raises one, once, for a batch still held whose
 * hold's exception an earlier build resolved or closed without a confirmed
 * identity, naming that exception.
 */
export function providerIdentityReviewCondition(batchId: string, earlierExceptionId: string): string {
  return `${providerIdentityCondition(batchId)}:review:${earlierExceptionId}`;
}

/**
 * The batch a provider identity condition names: the hold's own
 * (providerIdentityCondition) or a renewed review's
 * (providerIdentityReviewCondition); undefined for any other condition.
 */
export function providerIdentityOf(condition: unknown): string | undefined {
  const parts = String(condition ?? "").split(":");
  const hold = parts[0] === "settlement_variance" && !!parts[1] && parts[2] === "provider_identity";
  return hold && (parts.length === 3 || (parts.length === 5 && parts[3] === "review" && !!parts[4])) ? parts[1] : undefined;
}

/** The earlier exception a renewed review of a provider identity hold names (providerIdentityReviewCondition); undefined for any other condition. */
export function providerIdentityReviewOf(condition: unknown): string | undefined {
  const parts = String(condition ?? "").split(":");
  return parts.length === 5 && providerIdentityOf(condition) !== undefined ? parts[4] : undefined;
}

/**
 * Finance's release of a settlement batch held for its provider identity, once
 * the providers have confirmed whose payout it is: the only code its hold's
 * exception, or a renewed review of it, offers and accepts. Only Admin or Finance
 * records it, with the identity it confirms (data.confirmedProviderIdentity, one
 * of the identities the batch was held for, providerIdentityReview.identities):
 * the next reconciliation keeps that connection's evidence in the batch and moves
 * the evidence of the others to their own batches. Where the providers cannot
 * attribute the payout to one connection, the exception stays open until the
 * data owner repairs the evidence.
 */
export const providerIdentityConfirmedCode = "provider_identity_confirmed";

/**
 * Decision on what a resolution means: it keeps the meaning Finance was shown
 * when it was recorded. resolve_exception records the rules it was recorded
 * under on the exception (data.resolutionRuleVersion). Several earlier builds
 * omitted it while giving the same code different meanings. Such a reversal
 * requires a new explicit Finance review; its old decision is never reinterpreted.
 */
export const resolutionRuleVersion = 1;

/**
 * The resolution codes one exception offers: its type's, less those that do
 * not apply to it. A suspected_duplicate offers same_payment only for payment
 * evidence held because it came through another connection alone, and
 * not_money only for held payment evidence, never for a held payment. The
 * provider_status_mismatch of a reversal waiting for a payment no connection
 * has seen offers only the two codes that decide it (unseenReversalCodes). A
 * settlement_variance raised for a batch held for its provider identity, or a
 * renewed review of one (providerIdentityOf), offers only
 * provider_identity_confirmed, the one code that decides it, while the batch is
 * held; once it is not (`identityHeld` false), such an exception stays open only
 * for the reports an earlier build made it carry, and offers the other
 * settlement_variance codes. No other settlement_variance offers that code.
 */
export function resolutionCodesForException(exception: { data?: { type?: unknown; condition?: unknown } | null } | null | undefined, { identityHeld = true }: { identityHeld?: boolean } = {}): readonly string[] {
  const codes = resolutionCodesFor(exception?.data?.type);
  const type = resolveExceptionType(exception?.data?.type);
  if (type === "provider_status_mismatch" && unseenReversalOf(exception?.data?.condition)) return codes.filter((code) => code === unseenReversalCodes.adopted || code === unseenReversalCodes.setAside);
  if (type === "settlement_variance") return codes.filter((code) => (code === providerIdentityConfirmedCode) === (identityHeld && providerIdentityOf(exception?.data?.condition) !== undefined));
  if (type !== "suspected_duplicate") return codes;
  const held = heldEvidenceOf(exception?.data?.condition);
  return codes.filter((code) => code === heldEvidenceCodes.samePayment ? held?.connectionOnly === true : code === heldEvidenceCodes.notMoney ? held !== undefined : true);
}
