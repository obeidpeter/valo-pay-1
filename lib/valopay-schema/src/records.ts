import { z } from "zod";
import {
  activationWorkflows, adjustmentReasons, alertSeverities, attemptSources, closeTriggers, collectionStatuses, exceptionSeverities, executionOwners, experimentArms,
  handBackOwners, mandateFrequencies, mandateOrigins, notificationChannels, observationSources, paymentChannels, refundStatuses, retryDecisionKinds, reversalStatuses, settlementStatuses,
} from "./enums";
import { importKinds, type RecordKind } from "./kinds";
import { sourceBatchQualitySchema, expectedSourceFileSchema } from "./source-quality";
import { importCorrectionPreviewSchema } from "./import-corrections";
import { lifecycleCandidateSchema, lifecycleKindSchema, lifecycleReceiptStatusSchema, retentionPolicySchema } from "./lifecycle";
import { WAT_OFFSET_MS } from "./policy";

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
/**
 * Whether a day (YYYY-MM-DD) or a UTC timestamp to the millisecond names a
 * real date and time exactly as written, from the year 0001 (PostgreSQL has
 * no year 0). Date.parse rolls 2026-02-30 over to 2 March and 24:00 over to
 * the next day; this refuses both.
 */
export function isRealDate(value: string): boolean {
  const day = DAY_ONLY.test(value);
  if (!day && !UTC_TIMESTAMP.test(value)) return false;
  const time = Date.parse(day ? `${value}T00:00:00.000Z` : value), written = day ? 10 : 19;
  return Number.isFinite(time) && !value.startsWith("0000") && new Date(time).toISOString().slice(0, written) === value.slice(0, written);
}
/**
 * When a deadline passes, in milliseconds: a timestamp at its instant, and a
 * date-only deadline (YYYY-MM-DD) at the end of that day in West Africa Time
 * (23:59:59.999 WAT), so it lasts the whole day. NaN for an impossible date,
 * which is no deadline, as the SQL queues read it.
 */
export function deadlineEnds(value: unknown): number {
  const text = typeof value === "string" ? value : "";
  if (DAY_ONLY.test(text)) return isRealDate(text) ? Date.parse(`${text}T00:00:00.000Z`) + 24 * 60 * 60 * 1000 - WAT_OFFSET_MS - 1 : NaN;
  return UTC_TIMESTAMP.test(text) && !isRealDate(text) ? NaN : Date.parse(text);
}
/** Whether a deadline has passed at `now` (an instant in milliseconds, or ISO text): after its instant, or once its WAT day is over. */
export function deadlinePassed(value: unknown, now: number | string): boolean {
  return deadlineEnds(value) < (typeof now === "number" ? now : Date.parse(now));
}

/**
 * The longest a record's indexed text may be, in characters. Status, reference
 * and customerId are columns of the record indexes, and a payment evidence
 * record's eventId is in its unique index; PostgreSQL refuses an index entry
 * over about 2,700 bytes. Longer text is refused as input, naming its field
 * (400), before anything is saved.
 */
export const recordTextLimits = { status: 100, reference: 200, customerId: 100, eventId: 200 } as const;

/** ISO date (YYYY-MM-DD) or a UTC ISO timestamp with millisecond precision or less, naming a real date. */
export const isoDateOrTimestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/, "Use YYYY-MM-DD or a UTC timestamp such as 2026-09-18T07:00:00Z.").refine(isRealDate, "Enter a valid date.");
/** A day as YYYY-MM-DD, naming a real date. */
export const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD, for example 2026-09-18.").refine(isRealDate, "Enter a valid date.");
/**
 * A design partner's discount dates as the service recorded them (BIL-02). Saving signed terms with the dates records a
 * proposal bound to them: who proposed them (reviewedBy, the demo role or staff account, and proposedPrincipal, the person
 * behind it) and when (reviewedAt). A different Admin or Finance user confirms it with confirm_discount_terms
 * (confirmedBy, confirmedPrincipal, confirmedAt). A proposal an earlier build recorded names no principal and awaits
 * confirmation. No client supplies or edits it.
 */
export const discountReviewSchema = z.object({
  reviewedBy: z.string(), reviewedAt: isoDateOrTimestamp, discountStartDate: isoDay, fullPriceStartDate: isoDay, termsReference: z.string(),
  proposedPrincipal: z.string().optional(), confirmedBy: z.string().optional(), confirmedPrincipal: z.string().optional(), confirmedAt: isoDateOrTimestamp.optional(),
});
/** An amount in kobo: a non-negative safe integer. */
export const kobo = z.number({ invalid_type_error: 'Enter an amount as a number.' }).int('Enter a whole number in kobo (100 kobo = ₦1).').min(0, 'The amount cannot be negative.').max(Number.MAX_SAFE_INTEGER, 'The amount is too large.');
const versionNumber = z.coerce.number().int().min(1);
/** Every record the platform writes is marked synthetic; a provider-accepted notice clears it (NOT-10). */
const common = { synthetic: z.boolean().optional() };
/** Money in another currency than naira, by currency code: how many payments, and their amount in that currency's minor unit as each payment stores it. It is never added to a naira total. */
const otherCurrencies = z.record(z.object({ count: z.number().int().min(0), amount: z.number().int() }));
/** Records and their money: count takes every one whatever its currency, kobo sums naira only, and otherCurrencies lists money in another currency beside it. */
const money = z.object({ count: z.number().int().min(0), kobo: z.number().int(), otherCurrencies: otherCurrencies.optional() });

/** A headline metric as the overview and the reports return it, and as each close freezes it. */
export const metricSchema = z.object({ key: z.string(), label: z.string(), value: z.number(), unit: z.string(), detail: z.string() });
/** NFR-OBS-02 alert as the overview returns it and each close freezes it. */
export const alertSchema = z.object({
  key: z.string(), severity: z.enum(alertSeverities), title: z.string(), detail: z.string(),
  count: z.number().int().optional(), since: z.string().optional(), linkedRecordId: z.string().optional(),
});
/** REC-05: a customer position derived from due items, confirmed allocations and payments. */
export const positionSchema = z.object({ customerId: z.string(), obligationsKobo: z.number().int(), allocatedKobo: z.number().int(), outstandingKobo: z.number().int(), unallocatedKobo: z.number().int() });
/** REC-07: the daily close report, in the order the TRD lists its parts. */
export const closeReportSchema = z.object({
  period: z.object({ from: isoDateOrTimestamp.nullable(), to: isoDateOrTimestamp }),
  openingUnallocated: money,
  observations: z.object({
    received: z.number().int().min(0),
    bySource: z.record(z.object({ received: z.number().int(), resolved: z.number().int(), unresolved: z.number().int(), paymentsResolvedTo: z.number().int(), batchesResolvedTo: z.number().int() })),
    paymentsResolvedTo: z.number().int().min(0),
    canonicalPaymentsCreated: z.number().int().min(0),
  }),
  allocatedByRule: z.record(z.object({ count: z.number().int(), kobo: z.number().int(), automatic: z.number().int() })),
  allocated: money,
  proposed: money,
  unallocated: money.extend({ olderThan24Hours: z.number().int().min(0) }),
  possibleDuplicates: money,
  variances: z.object({
    count: z.number().int().min(0), feeVarianceKobo: z.number().int(), otherCurrencies: otherCurrencies.optional(),
    batches: z.array(z.object({ batchId: z.string(), reference: z.string(), currency: z.string().optional(), feeVarianceKobo: z.number().int(), netKobo: z.number().int(), statementNetKobo: z.number().int().nullable(), explanation: z.string().nullable() })),
  }),
  exceptions: z.object({
    opened: z.object({ count: z.number().int(), byType: z.record(z.number().int()) }),
    closed: z.object({ count: z.number().int(), byType: z.record(z.number().int()) }),
    openAtClose: z.number().int().min(0),
    overdueAtClose: z.number().int().min(0),
  }),
  retryDecisions: z.object({ recorded: z.number().int(), finalAttempts: z.number().int(), disputesFrozen: z.number().int(), noticesNotEvidenced: z.number().int() }),
  customerPositionsChanged: z.array(z.object({ customerId: z.string(), customerName: z.string(), before: positionSchema.nullable(), after: positionSchema })),
  positionRebuild: z.object({
    customersChecked: z.number().int(), dueItemsChecked: z.number().int(),
    mismatches: z.array(z.object({ dueItemId: z.string(), reference: z.string(), customerId: z.string(), storedOutstandingKobo: z.number().int(), rebuiltOutstandingKobo: z.number().int() })),
    alert: z.boolean(),
  }),
  reconciliation: z.record(z.unknown()),
  alerts: z.array(alertSchema).optional(),
}).passthrough();
/** The REC-07 report a daily close freezes. */
export type CloseReport = z.infer<typeof closeReportSchema>;
/** A named measurement with its unit and basis. */
export type MetricData = z.infer<typeof metricSchema>;
/** An NFR-OBS-02 alert as the overview returns it. */
export type AlertData = z.infer<typeof alertSchema>;
/** A customer's derived position: obligations, payment evidence and the outstanding amount. */
export type CustomerPositionData = z.infer<typeof positionSchema>;

// Shapes the platform's own kinds share. Every field of those kinds is optional: the schemas type what
// the workflows write and read, and a record an earlier build wrote may lack a field added since.
/** How PostgreSQL keeps a protected field (protected-payloads.ts): a sealed envelope instead of the value. */
const sealedPayload = z.object({ protectedPayload: z.literal(1) }).passthrough();
/** A whole record as another record keeps a copy of it: a close under review, an imported record before and after a correction. Its data is as untyped as a stored record's. */
const recordCopy = z.object({
  id: z.string(), merchantId: z.string(), kind: z.string(), name: z.string(), status: z.string(), reference: z.string(),
  amountKobo: z.number(), customerId: z.string(), createdAt: z.string(), updatedAt: z.string(), data: z.record(z.any()),
});
/** A case assignment as case events record it before and after a change. */
const caseAssignment = z.object({
  assignee: z.string(), assigneeName: z.string(), nextAction: z.string(), nextActionAt: z.string(), evidenceIds: z.array(z.string()),
  eventId: z.string(), handoverEventId: z.string(),
}).partial().passthrough();
/** What every Cash Desk record carries: its legal entity, who acted and why. The plan or schedule itself is the connected-cash domain's type. */
const cashDesk = { ...common, entityId: z.string(), actor: z.string(), reason: z.string() };
/** An object whose shape a domain module types (a parsed Paystack event, a credit result, a payroll plan): as open as a stored record's data. */
const domainObject = z.record(z.any());

/**
 * Per-kind data schemas, one for every record kind: the fields a caller may
 * supply and the fields the platform sets, typed.  Unknown fields pass through
 * so connectors and imports can attach provider-specific detail beside the
 * record; the API and the console read known fields through these types.
 */
export const recordDataSchemas = {
  customers: z.object({
    ...common,
    bankName: z.string().optional(),
    accountMasked: z.string().optional(),
    phoneMasked: z.string().optional(),
    consentProvenance: z.string().min(1),
    payDay: z.number().int().min(1).max(31).optional(),
    consentCapturedAt: isoDateOrTimestamp.optional(),
  }).passthrough(),
  mandates: z.object({
    ...common,
    workflow: z.enum(activationWorkflows),
    frequency: z.enum(mandateFrequencies).optional(),
    activationDeadline: isoDateOrTimestamp.optional(),
    consentEvidence: z.string().min(1),
    consentGaps: z.array(z.string()).optional(),
    consentGiven: z.boolean().optional(),
    policyId: z.string().optional(),
    /** RET-07: the policy version the consent covers, pinned when the mandate is created or re-issued and moved only by apply_policy_version. */
    consentPolicyId: z.string().optional(),
    consentPolicyVersion: z.coerce.number().int().min(1).optional(),
    consentPolicySummary: z.string().optional(),
    policyVersionHistory: z.array(z.object({ fromPolicyId: z.string().nullable(), fromVersion: z.number().int().nullable(), toPolicyId: z.string(), toVersion: z.number().int(), noticeId: z.string().nullable(), consentEvidence: z.string().nullable(), appliedAt: isoDateOrTimestamp, actor: z.string() }).passthrough()).optional(),
    origin: z.enum(mandateOrigins).optional(),
    reminderCount: z.number().int().min(0).optional(),
    reissuedFrom: z.string().optional(),
    providerReference: z.string().optional(),
    consentCapturedAt: isoDateOrTimestamp.optional(),
    lastReminderAt: isoDateOrTimestamp.optional(),
    lastActionReason: z.string().optional(),
    suspendedAt: isoDateOrTimestamp.optional(),
    reinstatedAt: isoDateOrTimestamp.optional(),
    cancelledAt: isoDateOrTimestamp.optional(),
    cancellationReason: z.string().optional(),
    cancelledScheduledAttemptIds: z.array(z.string()).optional(),
    handBackAt: isoDateOrTimestamp.optional(),
  }).passthrough(),
  "due-items": z.object({
    ...common,
    dueDate: isoDateOrTimestamp,
    mandateId: z.string().optional(),
    owner: z.enum(executionOwners),
    outstandingKobo: kobo.optional(),
    overrideReason: z.string().optional(),
    adminOverrideReason: z.string().optional(),
    policyId: z.string().optional(),
    instalmentId: z.string().optional(),
    experimentId: z.string().optional(),
    experimentArm: z.enum(experimentArms).optional(),
    firstFailureAt: isoDateOrTimestamp.optional(),
    amendedAt: isoDateOrTimestamp.optional(),
    assignmentAt: isoDateOrTimestamp.optional(),
    giveUpRule: z.string().optional(),
    lastActionReason: z.string().optional(),
    handedBackAt: isoDateOrTimestamp.optional(),
    /**
     * The latest release from dispute: a customer dispute resolved as not upheld, or Finance's release with a reason; who,
     * when, why, the status the balance gave it and the last counted attempt, whose disputed debit does not freeze it again.
     */
    disputeRelease: z.object({
      via: z.enum(["not_upheld", "finance_release"]), releasedAt: isoDateOrTimestamp, releasedBy: z.string(), reason: z.string(),
      exceptionId: z.string().optional(), attemptId: z.string().nullable(), status: z.string(), outstandingKobo: kobo,
    }).optional(),
  }).passthrough(),
  attempts: z.object({
    ...common,
    dueItemId: z.string().min(1),
    number: z.number().int().min(1).optional(),
    source: z.enum(attemptSources),
    failureCode: z.string().optional(),
    occurredAt: isoDateOrTimestamp.optional(),
    providerReference: z.string().optional(),
    noticeId: z.string().optional(),
    simulated: z.boolean().optional(),
    rawFailureCode: z.string().optional(),
    actualInstruction: z.boolean().optional(),
    cancellationReason: z.string().optional(),
    settledAt: isoDateOrTimestamp.optional(),
    reversed: z.boolean().optional(),
    reversedAt: isoDateOrTimestamp.optional(),
    paymentId: z.string().optional(),
    /** Set when Operations resolved the attempt's unknown outcome: what it showed before and the resolution that confirmed it. */
    outcomeConfirmation: z.object({
      exceptionId: z.string(),
      resolutionCode: z.string(),
      previousStatus: z.string(),
      previousFailureCode: z.string().optional(),
      previousRawFailureCode: z.string().optional(),
      confirmedAt: isoDateOrTimestamp,
      confirmedBy: z.string(),
    }).optional(),
  }).passthrough(),
  observations: z.object({
    ...common,
    source: z.enum(observationSources),
    dueItemId: z.string().optional(),
    provider: z.string().max(200, 'A provider identity is at most 200 characters.').optional(),
    eventId: z.string().max(recordTextLimits.eventId, `An event ID is at most ${recordTextLimits.eventId} characters.`).optional(),
    narration: z.string().optional(),
    batchReference: z.string().optional(),
    feeKobo: kobo.optional(),
    grossAmountKobo: kobo.optional(),
    occurredAt: isoDateOrTimestamp.optional(),
    reversed: z.boolean().optional(),
    virtualAccountCustomerId: z.string().optional(),
    providerConnection: z.string().max(200, 'A provider connection identity is at most 200 characters.').optional(),
    currency: z.string().optional(),
    settlementStatus: z.enum(settlementStatuses).optional(),
    paymentId: z.string().optional(),
    resolvedTo: z.string().optional(),
    resolutionKey: z.string().optional(),
    resolvedAt: isoDateOrTimestamp.optional(),
    duplicateSettlementLine: z.boolean().optional(),
    /** A settlement line for a collection another batch already counts: the batch it is counted in. */
    countedInBatchId: z.string().optional(),
    /** A settlement line in another currency than its batch (settlementBatchId): linked to it as evidence, never added to its totals. */
    otherCurrencyLine: z.boolean().optional(),
    /** A statement credit in another currency than the batch it names: linked to it, never matched to its net total. */
    otherCurrencyCredit: z.boolean().optional(),
    /** A statement credit repeating one already counted for its batch (same reference and amount): it adds nothing. */
    duplicateStatementCredit: z.boolean().optional(),
    reversalApplied: z.boolean().optional(),
    statementNetKobo: z.number().int().optional(),
    linePaymentIds: z.array(z.string()).optional(),
    settlementBatchId: z.string().optional(),
  }).passthrough(),
  /** Canonical payments (TRD 4.2): four independent status dimensions and the allocation running total; written by reconciliation only. */
  payments: z.object({
    ...common,
    channel: z.enum(paymentChannels).optional(),
    collectionStatus: z.enum(collectionStatuses).optional(),
    settlementStatus: z.enum(settlementStatuses).optional(),
    reversalStatus: z.enum(reversalStatuses).optional(),
    refundStatus: z.enum(refundStatuses).optional(),
    dueItemId: z.string().optional(),
    attemptId: z.string().optional(),
    allocatedKobo: kobo.optional(),
    observedAt: isoDateOrTimestamp.optional(),
    settledAt: isoDateOrTimestamp.optional(),
    reversedAt: isoDateOrTimestamp.optional(),
    proposedDueItemId: z.string().optional(),
    proposedAmountKobo: kobo.optional(),
    provider: z.string().optional(),
    providerConnection: z.string().optional(),
    currency: z.string().optional(),
    narration: z.string().optional(),
    rule: z.string().optional(),
    confidence: z.string().optional(),
    explanation: z.string().optional(),
    refundReference: z.string().optional(),
    refundRecordedAt: isoDateOrTimestamp.optional(),
    refundRecordedExternally: z.boolean().optional(),
    /** What the refund returned to the payer: the money the payment had not applied, or the whole receipt for a pay-by-bank refund. A refund recorded without it is read as the whole payment. */
    refundedKobo: kobo.optional(),
    /** Instalments Finance said this payment does not belong to; automatic matching never proposes them again. */
    rejectedDueItemIds: z.array(z.string()).optional(),
    /** Evidence named no payer, so Finance identified the payer when it applied the payment: who, when, why and through which allocation. */
    payerIdentification: z.object({ customerId: z.string(), identifiedBy: z.string(), identifiedAt: isoDateOrTimestamp, reason: z.string(), dueItemId: z.string(), allocationId: z.string() }).optional(),
    /** Identifications withdrawn once a review or rejection took the match that made them out of use, with nothing of the payment applied: each as recorded, and who withdrew it, when and why. */
    payerIdentificationHistory: z.array(z.object({ customerId: z.string(), identifiedBy: z.string(), identifiedAt: isoDateOrTimestamp, reason: z.string(), dueItemId: z.string(), allocationId: z.string(), withdrawnBy: z.string(), withdrawnAt: isoDateOrTimestamp, withdrawnReason: z.string() })).optional(),
    /** Finance's resolution of a suspected duplicate held on this payment; "distinct_payments" means it is never held again for the same reason. */
    duplicateReview: z.object({ exceptionId: z.string(), resolutionCode: z.string(), reviewedBy: z.string(), reviewedAt: isoDateOrTimestamp }).optional(),
    /** Made from evidence that conflicted with another payment sharing its reference, or came through another connection than the payment with its reference, once Finance resolved that exception. */
    evidenceConflict: z.object({ paymentId: z.string(), exceptionId: z.string(), resolutionCode: z.string() }).optional(),
    /** The amount came from a settlement line that stated only what it paid out: the debit's own gross raises it, whatever is applied, until its money goes back. */
    grossUnstated: z.boolean().optional(),
    /** A pay-by-bank receipt Finance confirmed after its outcome stayed unknown: the masked reference of the evidence that it arrived. */
    evidenceReference: z.string().optional(),
    duplicateSettlementLine: z.boolean().optional(),
    statementObservationId: z.string().optional(),
    settlementBatchId: z.string().optional(),
    observationIds: z.array(z.string()).optional(),
    resolvedTo: z.string().optional(),
    grossAmountKobo: kobo.optional(),
    feeKobo: kobo.optional(),
  }).passthrough(),
  /** Allocations (REC-02 to REC-04): the rule, confidence and explanation, Finance's review and what superseded it. */
  allocations: z.object({
    ...common,
    paymentId: z.string().min(1),
    dueItemId: z.string().min(1),
    rule: z.string().optional(),
    confidence: z.string().optional(),
    automatic: z.boolean().optional(),
    explanation: z.string().optional(),
    tolerance: z.string().optional(),
    reviewed: z.boolean().nullable().optional(),
    reviewReason: z.string().optional(),
    reviewedBy: z.string().optional(),
    reviewedAt: isoDateOrTimestamp.optional(),
    confirmedBy: z.string().optional(),
    confirmedAt: isoDateOrTimestamp.optional(),
    supersededReason: z.string().optional(),
    supersededBy: z.string().optional(),
    /** Set when a precision review marked the match wrong, so a later "correct" verdict can apply it again. */
    supersededByReview: z.boolean().optional(),
    /** When a match marked wrong was reviewed as correct and applied again. */
    reinstatedAt: isoDateOrTimestamp.optional(),
  }).passthrough(),
  /** Customer messages (NOT-01 to NOT-10): purpose, class, the provider's acceptance and delivery evidence and the cost. */
  notifications: z.object({
    ...common,
    purpose: z.string().optional(),
    channel: z.enum(notificationChannels).optional(),
    class: z.string().optional(),
    renderedText: z.string().optional(),
    templateVersion: z.number().int().optional(),
    submittedAt: isoDateOrTimestamp.optional(),
    acceptedAt: isoDateOrTimestamp.nullable().optional(),
    deliveredAt: isoDateOrTimestamp.nullable().optional(),
    costKobo: kobo.optional(),
    dueItemId: z.string().optional(),
    mandateId: z.string().optional(),
    policyId: z.string().optional(),
    policyVersion: z.number().int().optional(),
    attemptId: z.string().optional(),
    sequence: z.number().int().optional(),
    cap: z.number().int().optional(),
    reason: z.string().optional(),
    simulated: z.boolean().optional(),
  }).passthrough(),
  /**
   * A settlement batch holds one currency (currency): its gross, fee, net, expected fee, fee variance and statement
   * total are in that currency's smallest unit, whatever their Kobo names say.
   */
  "settlement-batches": z.object({
    ...common,
    provider: z.string().optional(),
    batchReference: z.string().min(1),
    /** The ISO 4217 code, in capitals, of the batch's money: its first counted line's, or what Finance entered (naira unless given). A batch an earlier build saved without one is in naira. */
    currency: z.string().optional(),
    grossKobo: kobo,
    feeKobo: kobo,
    netKobo: kobo,
    lineObservationIds: z.array(z.string()).optional(),
    linePaymentIds: z.array(z.string()).optional(),
    /** Settlement lines in another currency than the batch: linked to it as evidence and reported, never in its totals. */
    otherCurrencyLineIds: z.array(z.string()).optional(),
    expectedFeeKobo: z.number().int().optional(),
    assumedFeeKobo: z.number().int().optional(),
    feeVarianceKobo: z.number().int().optional(),
    statementNetKobo: z.number().int().nullable().optional(),
    statementObservationId: z.string().optional(),
    /** Statement credits that name the batch in another currency than its own, by currency: never matched to its net total. */
    statementOtherCurrencies: otherCurrencies.optional(),
    explanation: z.string().nullable().optional(),
    reconciledAt: isoDateOrTimestamp.optional(),
    /** Totals Finance typed for a hand-entered batch, and their currency, kept when the provider's lines rebuilt them. */
    enteredTotals: z.object({ grossKobo: kobo, feeKobo: kobo, netKobo: kobo, currency: z.string().optional() }).optional(),
  }).passthrough(),
  exceptions: z.object({
    ...common,
    case: z.object({ assignee: z.string(), assigneeName: z.string(), nextAction: z.string(), nextActionAt: isoDateOrTimestamp, evidenceIds: z.array(z.string()),eventId:z.string().optional(),handoverEventId:z.string().optional() }).optional(),
    type: z.string().min(1),
    severity: z.enum(exceptionSeverities).optional(),
    owner: z.string().optional(),
    dueBy: isoDateOrTimestamp.optional(),
    resolutionCode: z.string().optional(),
    notes: z.string().optional(),
    linkedRecordId: z.string().optional(),
    reason: z.string().optional(),
    resolvedBy: z.string().optional(),
    resolvedAt: isoDateOrTimestamp.optional(),
    legacyType: z.boolean().optional(),
    /** The state that raised the exception; a resolved exception is not raised again while this is unchanged. */
    condition: z.string().optional(),
    /** For an unknown outcome resolved as failed: the failure code the provider confirmed. */
    confirmedFailureCode: z.string().optional(),
    /** For a settlement batch held for its provider identity, resolved as provider_identity_confirmed: the identity Finance confirmed, one the batch was held for. */
    confirmedProviderIdentity: z.string().optional(),
    /**
     * On a renewed review of an earlier decision on a settlement batch's provider identity hold, which reconciliation
     * raises: the earlier exception that closed the hold without a confirmed identity, its status, code, and who resolved it and when.
     */
    legacyIdentityReview: z.object({ priorExceptionId: z.string(), priorStatus: z.string(), priorResolutionCode: z.string().nullable(), priorResolvedBy: z.string().nullable(), priorResolvedAt: z.string().nullable() }).optional(),
    /** The kind of the linked record when it is not the kind the type usually names: connected-intents for a pay-by-bank checkout. */
    linkedKind: z.string().optional(),
    /** Set when the platform closed the exception because its condition cleared (resolutionCode condition_cleared): when, in whose action and why. */
    conditionCleared: z.object({ at: isoDateOrTimestamp, by: z.string(), reason: z.string() }).optional(),
    /**
     * The currency of amountKobo when it is not naira: the ISO 4217 code, in capitals, of the money the exception is
     * about (a payment or payment evidence in another currency), whose minor units amountKobo then holds. Absent for naira.
     */
    currency: z.string().optional(),
    /** On a settlement_variance: the conditions of the reports of a collection counted in two batches it carries beside its own; its resolution settles them too. */
    countedTwice: z.array(z.string()).optional(),
    /** On a settlement_variance: the conditions of the reports of a settlement line in another currency than its batch it carries beside its own; its resolution settles them too. */
    otherCurrencyLines: z.array(z.string()).optional(),
    /** The rules the resolution was recorded under (resolutionRuleVersion), which resolve_exception records; absent on one an earlier build recorded. */
    resolutionRuleVersion: z.number().int().optional(),
  }).passthrough(),
  policies: z.object({
    ...common,
    version: versionNumber.optional(),
    maxAttempts: z.number().int().optional(),
    spacingHours: z.number().int().optional(),
    firstNoticeHours: z.number().int().optional(),
    retryNoticeHours: z.number().int().optional(),
    partialAllowed: z.boolean().optional(),
    author: z.string().optional(),
    reviewer: z.string().optional(),
    approvedAt: isoDateOrTimestamp.optional(),
    complianceMapping: z.string().optional(),
    previousVersionId: z.string().optional(),
    submittedAt: isoDateOrTimestamp.optional(),
    rejectedAt: isoDateOrTimestamp.optional(),
    rejectionReason: z.string().optional(),
  }).passthrough(),
  templates: z.object({
    ...common,
    purpose: z.string().optional(),
    text: z.string().min(1),
    version: versionNumber.optional(),
    author: z.string().optional(),
    reviewer: z.string().optional(),
    approvedAt: isoDateOrTimestamp.optional(),
    submittedAt: isoDateOrTimestamp.optional(),
    rejectedAt: isoDateOrTimestamp.optional(),
    previousVersionId: z.string().optional(),
  }).passthrough(),
  experiments: z.object({
    ...common,
    baselineRate: z.number().min(0).max(1),
    holdoutShare: z.number(),
    minPerArm: z.number().int().min(0),
    analysisDate: isoDateOrTimestamp,
    enrolmentClose: isoDateOrTimestamp,
    seed: z.string().min(1),
    policyId: z.string().min(1),
    preregisteredAt: isoDateOrTimestamp.optional(),
    preregisteredBy: z.string().optional(),
    passRule: z.string().optional(),
    sampleCalculation: z.object({ holdoutMinimum: z.number().int(), engineMinimum: z.number().int(), confidence: z.number(), power: z.number(), effect: z.number() }).passthrough().optional(),
    parametersFrozen: z.boolean().optional(),
    upliftReport: z.record(z.unknown()).optional(),
    closedAt: isoDateOrTimestamp.optional(),
  }).passthrough(),
  cutovers: z.object({
    ...common,
    inventory: z.string().optional(),
    incumbentDisabled: z.boolean().optional(),
    externalAttemptsImported: z.boolean().optional(),
    dualRunComplete: z.boolean().optional(),
    accountableUser: z.string().optional(),
    fallbackOwner: z.enum(handBackOwners).optional(),
    confirmation: z.string().optional(),
    handedBackAt: isoDateOrTimestamp.optional(),
    handBackReason: z.string().optional(),
    checklist: z.array(z.string()).optional(),
    revertedDueItemIds: z.array(z.string()).optional(),
    cancelledAttemptIds: z.array(z.string()).optional(),
  }).passthrough(),
  commercial: z.object({
    ...common,
    monthlyVolume: z.number().int().min(0).optional(),
    averageTicketKobo: kobo.optional(),
    implementationKobo: kobo.optional(),
    licenceKobo: kobo.optional(),
    usageBps: z.number().int().min(0).max(10_000).optional(),
    usageCapKobo: kobo.optional(),
    signed: z.boolean().optional(),
    signedFullPriceTerms: z.boolean().optional(),
    effectiveDate: isoDateOrTimestamp.optional(),
    startCondition: z.string().optional(),
    conversationComplete: z.boolean().optional(),
    designPartner: z.boolean().optional(),
    /** Reviewed monthly pricing dates. Missing legacy dates never imply a calendar-year rollover. */
    discountStartDate: isoDay.optional(),
    fullPriceStartDate: isoDay.optional(),
    discountTermsReference: z.string().max(500).optional(),
    /** Recorded by the service alone: the proposal when Finance or Admin saves signed dates, and a different person's confirmation. */
    discountReview: discountReviewSchema.optional(),
  }).passthrough(),
  reviews: z.object({
    ...common,
    reviewer: z.string().optional(),
    reviewedAt: isoDateOrTimestamp.optional(),
    confirmedJobs: z.union([z.number().int().min(0), z.array(z.string())]).optional(),
    note: z.string().optional(),
  }).passthrough(),
  evidence: z.object({
    ...common,
    owner: z.string().optional(),
    evidenceDate: isoDateOrTimestamp.optional(),
    gateId: z.string().optional(),
    reference: z.string().optional(),
    notes: z.string().optional(),
  }).passthrough(),
  costs: z.object({ ...common, period: z.string().optional(), category: z.string().optional(), costKobo: kobo.optional(), note: z.string().optional() }).passthrough(),
  calendar: z.object({ ...common, date: isoDay, note: z.string().optional() }).passthrough(),
  /** Integrations are descriptive: no production adapter is connected in this sandbox. */
  integrations: z.object({ ...common, type: z.string().optional(), description: z.string().optional(), capabilities: z.array(z.string()).optional() }).passthrough(),
  /** Demo personas, not production staff provisioning. */
  members: z.object({ ...common, role: z.string().optional(), mfaEnrolled: z.boolean().optional() }).passthrough(),
  /** AUD-04: one hash-chained entry per transaction, written by the repository. */
  audit: z.object({
    sequence: z.number().int().min(1),
    actor: z.string(),
    action: z.string(),
    objectId: z.string(),
    summary: z.string(),
    changeDigest: z.string(),
    previousHash: z.string(),
    timestamp: isoDateOrTimestamp,
    hash: z.string(),
  }).passthrough(),
  /** Export metadata (AUD-02, AUD-06): the file's checksum and provenance; storage location is never listed. */
  exports: z.object({
    ...common,
    kind: z.string(),
    format: z.string(),
    checksum: z.string().optional(),
    usedInRealCase: z.boolean().optional(),
    byteLength: z.number().int().min(0).optional(),
    generationMs: z.number().int().min(0).optional(),
    contentType: z.string().optional(),
    events: z.number().int().min(0).optional(),
    customerReference: z.string().optional(),
    objectName: z.string().optional(),
    bucket: z.string().optional(),
    requestedBy: z.string().optional(),
    requestedRole: z.string().optional(),
    attempts: z.number().int().min(0).optional(),
    leaseToken: z.string().optional(),
    leaseExpiresAt: z.string().optional(),
    startedAt: z.string().optional(),
    generatedAt: z.string().optional(),
    lastError: z.string().optional(),
  }).passthrough(),
  /** RET-03: written by the engine at every close evaluation; never created or edited through the record API. */
  "retry-decisions": z.object({
    ...common,
    dueItemId: z.string().min(1),
    attemptId: z.string().nullable().optional(),
    decision: z.enum(retryDecisionKinds),
    rule: z.string().min(1),
    reason: z.string(),
    policyId: z.string().min(1),
    policyVersion: z.coerce.number().int().min(1),
    nextAt: isoDateOrTimestamp.nullable(),
    evaluatedAt: isoDateOrTimestamp,
    experimentArm: z.enum(experimentArms).nullable().optional(),
    inputs: z.record(z.unknown()),
    noticeRequired: z.object({
      purpose: z.string(),
      leadHours: z.number().int().min(0),
      requiredBy: isoDateOrTimestamp.nullable(),
      noticeId: z.string().nullable(),
      acceptedAt: isoDateOrTimestamp.nullable(),
      evidenced: z.boolean(),
    }).optional(),
    fingerprint: z.string().min(1),
    previousDecisionId: z.string().nullable().optional(),
  }).passthrough(),
  /** REC-07: the daily close report as written by the close; immutable evidence. */
  closes: z.object({
    ...common,
    closedAt: isoDateOrTimestamp,
    report: closeReportSchema,
    summary: z.string().optional(),
    period: z.object({ from: isoDateOrTimestamp.nullable(), to: isoDateOrTimestamp }).passthrough().optional(),
    metrics: z.array(metricSchema).optional(),
    operational: z.record(z.unknown()).optional(),
    positionAlert: z.boolean().optional(),
    /** REC-01: how the close was started, the scheduled instant it covered (if one was pending), its delay and the next scheduled instant. */
    schedule: z.object({
      trigger: z.enum(closeTriggers),
      scheduledFor: isoDateOrTimestamp.nullable(),
      delayMinutes: z.number().int().min(0).nullable(),
      late: z.boolean(),
      nextAt: isoDateOrTimestamp,
    }).passthrough().optional(),
  }).passthrough(),
  /** BIL-04 and BIL-07: an issued invoice is immutable; later corrections are adjustment lines on the next invoice. */
  invoices: z.object({
    ...common,
    period: z.string().regex(/^\d{4}-\d{2}$/),
    periodEnd: isoDateOrTimestamp.optional(),
    issuedAt: isoDateOrTimestamp,
    issuedBy: z.string().min(1),
    sequence: z.number().int().min(1).optional(),
    terms: z.object({ commercialId: z.string(), prospect: z.string(), contractedLicenceKobo: z.number().int(), designPartner: z.boolean(), effectiveDate: z.string().nullable(), discountReview: discountReviewSchema.optional() }).nullable().optional(),
    issueReason: z.string().optional(),
    collectionsCounted: z.number().int().min(0).optional(),
    licence: z.object({ kobo: z.number().int(), volumeTier: z.string().optional(), volumeTierLicenceKobo: z.number().int().optional(), tierMismatch: z.boolean().optional(), note: z.string().optional() }).optional(),
    designPartnerDiscount: z.object({ rate: z.number(), kobo: z.number().int(), note: z.string().optional() }).optional(),
    recoveryFee: z.object({ enabled: z.boolean(), lines: z.array(z.object({ dueItemId: z.string(), reference: z.string(), attemptId: z.string(), firstFailureAt: isoDateOrTimestamp.optional(), windowClosedAt: isoDateOrTimestamp, feeKobo: z.number().int() })), kobo: z.number().int(), note: z.string().optional() }).optional(),
    subtotals: z.record(z.number()).optional(),
    /** feeKobo is the public price, discountRate the design-partner share taken off it, and chargedKobo what the line charged; lines issued before the last two were kept take the invoice's rate. */
    usageLines: z.array(z.object({ paymentId: z.string(), paymentReference: z.string(), allocatedKobo: kobo, feeKobo: kobo, discountRate: z.number().min(0).max(1).optional(), chargedKobo: kobo.optional(), allocationIds: z.array(z.string()).optional() })),
    adjustments: z.array(z.object({
      reason: z.enum(adjustmentReasons),
      paymentId: z.string(),
      paymentReference: z.string(),
      originalInvoiceId: z.string(),
      originalInvoiceReference: z.string().optional(),
      /** What this invoice carries, priced at the rate of the invoice that first billed the collection. Lines issued before feeDeltaKobo was kept carry the public-price change, discounted with the rest of their invoice. */
      kobo: z.number().int(),
      /** The change in the public-price fee. */
      feeDeltaKobo: z.number().int().optional(),
      /** The design-partner share the collection was first billed under. */
      discountRate: z.number().min(0).max(1).optional(),
      /** What the collection had been charged net before this line. */
      billedChargedKobo: z.number().int().optional(),
      billedFeeKobo: z.number().int().optional(),
      currentFeeKobo: z.number().int().optional(),
      billedAllocatedKobo: z.number().int().optional(),
      currentAllocatedKobo: z.number().int().optional(),
      allocationIds: z.array(z.string()).optional(),
      explanation: z.string().optional(),
    })),
    totals: z.object({ netKobo: z.number().int(), vatBps: z.number().int().min(0), vatKobo: z.number().int(), totalKobo: z.number().int(), creditNote: z.boolean().optional() }),
  }).passthrough(),
  // The kinds only the platform writes (domainRecordKinds): every field optional.
  /** A saved source batch: its settings, the importer's check and, once committed, the records it created. Storage seals the CSV and check. */
  "import-batches": z.object({
    ...common,
    name: z.string(), kind: z.enum(importKinds), source: z.string(), sourceBatchId: z.string(), businessDate: isoDay, sourceExpectationId: z.string(),
    csv: z.union([z.string(), sealedPayload]), mapping: z.record(z.string()), amountUnit: z.enum(["naira", "kobo"]), identityColumn: z.string(), syntheticOnly: z.boolean(),
    rowIds: z.array(z.string()), revision: z.number().int().min(1), checkedBy: z.string(), checkedAt: isoDateOrTimestamp,
    /** The importer's row-by-row result (sealed in storage); the summary keeps its counts open. */
    check: z.record(z.any()),
    checkSummary: z.object({ valid: z.number().int(), invalid: z.number().int(), imported: z.number().int(), skipped: z.number().int() }),
    sourceQuality: sourceBatchQualitySchema,
    committedAt: isoDateOrTimestamp, committedBy: z.string(), recordIds: z.array(z.string()),
    /** Set when a retention run erased the raw CSV; the batch, its totals and the imported records remain. */
    rawCsvRemovedAt: isoDateOrTimestamp, rawCsvRetentionRunId: z.string(),
  }).partial().passthrough(),
  /** One saved revision of a source batch's settings, with its check counts. */
  "import-revisions": z.object({
    ...common, batchId: z.string(), revision: z.number().int().min(1), actor: z.string(), mapping: z.record(z.string()), amountUnit: z.enum(["naira", "kobo"]),
    valid: z.number().int(), invalid: z.number().int(), skipped: z.number().int(),
  }).partial().passthrough(),
  /** A proposed correction to one imported record (immutable): the records before and after, the comparison and the digests its approval checks again,
   * the role it was proposed with (its checks use that authority) and the rule of its impact digest (2 covers each earlier close and close review as the
   * comparison lists it; a proposal saved before either was kept has neither). */
  "import-corrections": z.object({
    ...common, batchId: z.string(), targetId: z.string(), input: z.record(z.any()), before: recordCopy, after: recordCopy,
    impactDigest: z.string(), impactVersion: z.number().int(), preview: importCorrectionPreviewSchema.partial().passthrough(), proposedBy: z.string(), proposedPrincipal: z.string(),
    proposedRole: z.string(), reviewer: z.string(), reason: z.string(), evidence: z.string(), proposalDigest: z.string(),
  }).partial().passthrough(),
  /** A decision or administrator reassignment on a proposed import correction (immutable). */
  "import-correction-events": z.object({
    ...common, proposalId: z.string(), targetId: z.string(), batchId: z.string(), proposalDigest: z.string(), action: z.enum(["approve", "reject", "withdraw", "reassign"]),
    actor: z.string(), principalId: z.string(), reason: z.string(),
    assignmentEventId: z.string().nullable(), previousAssignmentEventId: z.string().nullable(), fromReviewer: z.string(), reviewer: z.string(),
  }).partial().passthrough(),
  /** A source's reusable import contract and delivery expectation; its source and record type never change. */
  "source-profiles": z.object({
    ...common, source: z.string(), kind: z.string(), mapping: z.record(z.string()), identityColumn: z.string(), amountUnit: z.enum(["naira", "kobo"]),
    firstExpectedAt: isoDateOrTimestamp, cadenceHours: z.number().int(), graceMinutes: z.number().int(), expectedRows: z.number().int().nullable(),
    expectedAmountKobo: z.number().int().nullable(), syntheticOnly: z.boolean(), changedBy: z.string(),
  }).partial().passthrough(),
  /** The files a lender expects for one business day with their control totals (immutable; a change is a new revision). */
  "source-manifests": z.object({
    ...common, businessDate: isoDay, timezone: z.string(), files: z.array(expectedSourceFileSchema.extend({ id: z.string() })), noFilesExpected: z.boolean(),
    reason: z.string(), evidence: z.string(), revision: z.number().int().min(1), previousManifestId: z.string().nullable(), declaredBy: z.string(), declaredAt: isoDateOrTimestamp,
  }).partial().passthrough(),
  /** A Paystack test or fixture delivery, never a financial record: the parsed event, its payload digest and its delivery and replay history. */
  "provider-events": z.object({
    ...common, provider: z.string(), mode: z.enum(["fixture", "test"]), connectionId: z.string(), event: domainObject, dedupeKey: z.string(), payloadDigest: z.string(),
    deliveryCount: z.number().int().min(0), firstReceivedAt: isoDateOrTimestamp, lastReceivedAt: isoDateOrTimestamp, message: z.string(), financialRecordsCreated: z.number().int(),
    replayHistory: z.array(z.object({ at: isoDateOrTimestamp, actor: z.string(), reason: z.string(), result: z.string() }).partial().passthrough()),
  }).partial().passthrough(),
  /** Finance's independent review of one daily close: the frozen close, the preparer's explanations and the reviewer's decision. */
  "close-reviews": z.object({
    ...common, closeId: z.string(), reviewNumber: z.number().int().min(1), preparedBy: z.string(), preparedPrincipal: z.string(), preparedAt: isoDateOrTimestamp, reviewer: z.string(),
    snapshot: recordCopy, snapshotDigest: z.string(), inputDigest: z.string(), preparationNote: z.string(),
    discrepancyResponses: z.array(z.object({ issueId: z.string(), explanation: z.string() }).passthrough()), unresolvedAcceptance: z.string(),
    decidedBy: z.string(), decidedPrincipal: z.string(), decidedAt: isoDateOrTimestamp, decisionNote: z.string(),
    sourceExceptions: z.array(z.object({ issueId: z.string(), reason: z.string(), evidence: z.string() }).passthrough()),
  }).partial().passthrough(),
  /** A step in a close review's history: preparation, reassignment or decision (immutable). */
  "close-review-events": z.object({
    ...common, reviewId: z.string(), closeId: z.string(), action: z.enum(["prepared", "approve", "return", "reassign"]), actor: z.string(), reviewer: z.string(), previousReviewer: z.string(), note: z.string(), snapshotDigest: z.string(),
  }).partial().passthrough(),
  /** A claim, handover or next-action update on a case, with the assignment before and after (immutable). */
  "case-events": z.object({
    ...common, exceptionId: z.string(), actor: z.string(), action: z.enum(["claim", "handover", "update"]), note: z.string(), before: caseAssignment, after: caseAssignment,
  }).partial().passthrough(),
  /** A person's read or acknowledgement receipt for a work item (immutable); it changes no case, review or money. */
  "work-events": z.object({
    ...common, action: z.enum(["read", "acknowledge"]), sourceId: z.string(), eventId: z.string(), assignmentEventId: z.string().nullable(), sourceVersion: z.string(),
    sourceDigest: z.string(), actor: z.string(), summary: z.string(), href: z.string(),
  }).partial().passthrough(),
  /** A saved retention policy (immutable; the newest applies). */
  "retention-policies": z.object({ ...common, policy: retentionPolicySchema, actor: z.string(), reason: z.string(), sequence: z.number().int().min(1) }).partial().passthrough(),
  /** A retention hold placed on or released from one source (immutable; the newest per source applies). */
  "retention-holds": z.object({
    ...common, kind: lifecycleKindSchema, sourceId: z.string(), held: z.boolean(), reason: z.string(), expectedHoldRevision: z.string(), actor: z.string(), sequence: z.number().int().min(1),
  }).partial().passthrough(),
  /** A deletion run: the previewed candidates, the digests approval checks, and who prepared and approved it. */
  "retention-runs": z.object({
    ...common, candidates: z.array(lifecycleCandidateSchema), previewDigest: z.string(), policyRevision: z.string(), moreEligible: z.number().int().min(0),
    expiresAt: isoDateOrTimestamp, preparedBy: z.string(), approvedBy: z.string(), approvedAt: isoDateOrTimestamp, approvalReason: z.string(),
  }).partial().passthrough(),
  /** The executor's verified outcome for one candidate of a deletion run (immutable). */
  "retention-receipts": z.object({
    ...common, runId: z.string(), kind: lifecycleKindSchema, sourceId: z.string(), sourceDigest: z.string(), version: z.string(), result: lifecycleReceiptStatusSchema,
    detail: z.string(), actor: z.string(), sequence: z.number().int().min(1),
  }).partial().passthrough(),
  /** A simulated consent: its purpose, subject, scope and expiry, and its revocation. */
  "connected-consents": z.object({
    ...common, purpose: z.string(), subjectId: z.string(), days: z.number().int(), entityId: z.string(), version: z.number().int(), expiresAt: z.string(), grantedBy: z.string(),
    authority: z.string(), noticeVersion: z.string(), source: z.string(), intentId: z.string(), amountKobo: z.number().int(), currency: z.string(), beneficiaryId: z.string(),
    dueItemId: z.string(), revokedAt: isoDateOrTimestamp, revokedBy: z.string(),
  }).partial().passthrough(),
  /** A sample pay-by-bank checkout: the instalment, its expiry, its event history and the receipt or refund it led to. */
  "connected-intents": z.object({
    ...common, dueItemId: z.string(), currency: z.string(), beneficiary: z.string(), beneficiaryId: z.string(), rail: z.string(), expiresAt: isoDateOrTimestamp, createdBy: z.string(),
    events: z.array(z.object({ at: isoDateOrTimestamp, status: z.string(), detail: z.string() }).passthrough()), consentId: z.string(), paymentId: z.string(),
    observationId: z.string(), receiptReference: z.string(), confirmedAt: isoDateOrTimestamp,
    refundRequest: z.object({ maker: z.string(), reason: z.string(), at: isoDateOrTimestamp }).passthrough(),
    /** The unknown-outcome exception a checkout whose outcome stayed unknown for 24 hours was raised under. */
    outcomeExceptionId: z.string(),
    /** Finance's resolution of an outcome that stayed unknown: the outcome it recorded, with the evidence for a payment confirmed as received. */
    outcomeResolution: z.object({
      exceptionId: z.string(), resolutionCode: z.string(), outcome: z.enum(["confirmed", "failed"]), evidenceReference: z.string().optional(),
      resolvedBy: z.string(), resolvedAt: isoDateOrTimestamp, reason: z.string(),
    }).passthrough(),
  }).partial().passthrough(),
  /** A synthetic credit assessment (immutable): the engine's result (connected-credit.ts) and how it was started. */
  "connected-credit-assessments": z.object({
    ...common, result: domainObject, scenario: z.string(), createdBy: z.string(), reason: z.string(), rulesStatus: z.string(), scheduleSource: z.string(),
  }).partial().passthrough(),
  /** A reviewer's decision on a credit assessment (immutable). */
  "connected-credit-reviews": z.object({ ...common, assessmentRecordId: z.string(), review: domainObject, authentication: z.string(), reason: z.string() }).partial().passthrough(),
  /** The Cash Desk's sample SME workspace. */
  "connected-cash-workspace": z.object({ ...cashDesk, workspace: domainObject }).partial().passthrough(),
  /** A saved cash forecast with its input version. */
  "connected-cash-forecasts": z.object({ ...cashDesk, forecast: domainObject }).partial().passthrough(),
  /** An accounting (ERP) draft and its review. */
  "connected-cash-erp": z.object({ ...cashDesk, draft: domainObject }).partial().passthrough(),
  /** A VAT evidence schedule and its reviewer. */
  "connected-cash-vat": z.object({ ...cashDesk, schedule: domainObject, reviewer: z.string() }).partial().passthrough(),
  /** A payroll funding plan. */
  "connected-cash-payroll": z.object({ ...cashDesk, plan: domainObject }).partial().passthrough(),
} as const satisfies Record<RecordKind, z.ZodTypeAny>;

/** The map of every kind's data schema. */
export type RecordDataSchemas = typeof recordDataSchemas;
/** The data type of a kind by its schema key; the same as RecordDataOf for a record kind. */
export type DataOf<K extends keyof RecordDataSchemas> = z.infer<RecordDataSchemas[K]>;
/** The typed data of a record of kind K: the declared fields with their types, and anything else as unknown. */
export type RecordDataOf<K extends RecordKind> = z.infer<RecordDataSchemas[K]>;

/** Human-readable zod failure for API error bodies and import row reports. */
export function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "data"}: ${issue.message}`).join("; ");
}

/** Fields the CSV importer coerces to numbers and booleans, derived from the schemas above. */
export const importNumericFields = new Set(["amountKobo", "maxAttempts", "spacingHours", "firstNoticeHours", "retryNoticeHours", "number", "outstandingKobo", "monthlyVolume", "grossKobo", "feeKobo", "netKobo", "grossAmountKobo", "baselineRate", "holdoutShare", "minPerArm", "reminderCount", "payDay", "version"]);
/** Data fields the CSV importer reads as booleans ("true", anything else false). */
export const importBooleanFields = new Set(["simulated", "partialAllowed", "reversed", "consentGiven", "signed", "signedFullPriceTerms", "designPartner", "incumbentDisabled", "externalAttemptsImported", "dualRunComplete"]);
