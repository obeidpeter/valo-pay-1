/** Controlled vocabularies shared by the API validator, the engine and the console. */
export const roles = ["Admin", "Operations", "Finance", "Compliance reviewer", "Read-only"] as const;
/** One of the demo personas' roles; the API's permissions and the console's controls derive from it. */
export type Role = (typeof roles)[number];

/**
 * Execution owner of a due item (SCH-08).  The TRD spells the platform owner
 * "valo"; the platform stores "valopay" and accepts either on input.
 */
export const executionOwners = ["valopay", "lms", "merchant_manual", "provider_auto"] as const;
/** Who executes a due item's collection: the platform, the lender's LMS, the lender by hand, or the provider automatically. */
export type ExecutionOwner = (typeof executionOwners)[number];
/** The owner value for the platform itself. */
export const PLATFORM_OWNER: ExecutionOwner = "valopay";
/** Owners a cohort can be handed back to (DEB-12): everyone but the platform. */
export const handBackOwners = ["lms", "merchant_manual", "provider_auto"] as const;
/** An owner a cohort can be handed back to. */
export type HandBackOwner = (typeof handBackOwners)[number];
/** DEB-12: the platform itself is never a fallback owner. */
export function isHandBackOwner(value: unknown): value is HandBackOwner {
  return typeof value === "string" && (handBackOwners as readonly string[]).includes(value);
}
/** Reads an owner from input, accepting the TRD's "valo" spellings for the platform; undefined when unknown. */
export function normaliseOwner(raw: unknown): ExecutionOwner | undefined {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "valo" || value === "valopay" || value === "valo_pay") return "valopay";
  return (executionOwners as readonly string[]).includes(value) ? (value as ExecutionOwner) : undefined;
}
/** DEB-12: who a hand-back returns collection to: the owner the cutover contract names, or the loan management system when it names none the platform may hand back to. */
export function handBackFallbackOwner(contractOwner: unknown): HandBackOwner {
  const owner = normaliseOwner(contractOwner);
  return isHandBackOwner(owner) ? owner : "lms";
}

/** MAN-15 activation workflow registry types. */
export const activationWorkflows = ["transfer_to_activate", "hosted_consent"] as const;
/** How a mandate is activated: by a transfer, or through a hosted consent page. */
export type ActivationWorkflow = (typeof activationWorkflows)[number];

/** How often a mandate collects. */
export const mandateFrequencies = ["weekly", "fortnightly", "monthly", "quarterly", "custom"] as const;
/** Where a mandate came from: created here, imported, or re-issued from an earlier one. */
export const mandateOrigins = ["created", "imported", "reissued"] as const;

/** ING-01 observation sources. */
export const observationSources = ["webhook", "settlement", "statement", "transfer", "card", "manual"] as const;
/** Where a payment observation came from. */
export type ObservationSource = (typeof observationSources)[number];

/** The channel a payment was observed on; only a direct debit is billable (BIL-01). */
export const paymentChannels = ["direct_debit", "transfer", "card", "statement", "manual", "webhook", "settlement"] as const;
/** A payment's channel. */
export type PaymentChannel = (typeof paymentChannels)[number];

/** DEB-02 authorisation modes. */
export const authorisationModes = ["batch", "standing"] as const;
/** How the lender authorises debits: per batch, or as a standing authorisation. */
export type AuthorisationMode = (typeof authorisationModes)[number];

/** DEB-10 merchant modes. */
export const merchantModes = ["observation", "instruction"] as const;

/** The Test 2 arms: the retry engine, or the holdout that follows the lender's existing process. */
export const experimentArms = ["engine", "holdout"] as const;
/** An arm of the recovery experiment. */
export type ExperimentArm = (typeof experimentArms)[number];

/** TRD 6.3 decision outcomes recorded on every retry decision (RET-03). */
export const retryDecisionKinds = ["stop", "blocked", "give_up", "not_eligible", "holdout", "observation_only", "defer", "would_schedule"] as const;
/** The outcome recorded on a retry decision. */
export type RetryDecisionKind = (typeof retryDecisionKinds)[number];

/** Exception severities, least urgent first. */
export const exceptionSeverities = ["low", "medium", "high"] as const;
/** An exception's severity. */
export type ExceptionSeverity = (typeof exceptionSeverities)[number];

/** Whether an attempt was made by the platform or recorded from an external system. */
export const attemptSources = ["valo", "external"] as const;
/** Where an attempt came from. */
export type AttemptSource = (typeof attemptSources)[number];

/**
 * TRD 4.2: a Payment carries four independent status dimensions.  These are
 * the only spellings the platform writes; readers normalise legacy values.
 */
export const collectionStatuses = ["received", "succeeded", "failed", "unknown"] as const;
/** Whether the provider has settled the money to the lender, or the batch shows a variance. */
export const settlementStatuses = ["unsettled", "settled", "variance"] as const;
/** Whether the debit was reversed after collection. */
export const reversalStatuses = ["none", "reversed"] as const;
/** Whether the customer was refunded, or a refund was requested. */
export const refundStatuses = ["none", "requested", "refunded"] as const;

/** Reads a reversal status from stored data; anything but "reversed" is "none". */
export function normaliseReversalStatus(raw: unknown): (typeof reversalStatuses)[number] {
  return raw === "reversed" ? "reversed" : "none";
}
/** Reads a refund status from stored data, mapping the legacy "recorded_externally" to "refunded". */
export function normaliseRefundStatus(raw: unknown): (typeof refundStatuses)[number] {
  if (raw === "refunded" || raw === "recorded_externally") return "refunded";
  if (raw === "requested") return "requested";
  return "none";
}
/**
 * All of a payment's money went back to the payer: a provider reversal, or a
 * refund recorded outside Valo Pay that returned the whole amount. A refund
 * recorded before its amount was kept is read as the whole payment. What such
 * a payment has not already applied is neither allocatable nor customer
 * credit, and it is nobody's open work. A refund of part of it, such as an
 * overpayment's excess, leaves the rest with the lender.
 */
export function paymentMoneyReturned(payment: { amountKobo?: unknown; data?: { reversalStatus?: unknown; refundStatus?: unknown; refundedKobo?: unknown } | null } | null | undefined): boolean {
  if (!payment) return false;
  if (normaliseReversalStatus(payment.data?.reversalStatus) === "reversed") return true;
  return normaliseRefundStatus(payment.data?.refundStatus) === "refunded" && paymentRefundedKobo(payment) >= Number(payment.amountKobo || 0);
}
/**
 * What a payment still holds that is not applied to an instalment: the
 * customer's credit, and what Finance may allocate. What a refund returned is
 * not held, so after a refund of an overpayment's excess only the money that
 * stayed can be applied again if its allocation is superseded.
 */
export function paymentUnappliedKobo(payment: { amountKobo?: unknown; data?: { allocatedKobo?: unknown; reversalStatus?: unknown; refundStatus?: unknown; refundedKobo?: unknown } | null } | null | undefined): number {
  if (!payment || paymentMoneyReturned(payment)) return 0;
  return Math.max(0, Number(payment.amountKobo || 0) - Number(payment.data?.allocatedKobo || 0) - paymentRefundedKobo(payment));
}
/**
 * REC-04: a payment whose money waits for Finance to allocate it: an
 * unallocated payment, or the unapplied rest of one that is partly applied
 * (partial, or overpaid after its instalment was settled), holding money it
 * has not applied. A proposal, a duplicate hold, returned money and a payment
 * with nothing unapplied, such as one an earlier build made for ₦0, wait for
 * no one. Finance's payments queue, the unallocated ageing and the close
 * totals read payments through this.
 */
export function paymentAwaitsAllocation(payment: { status?: unknown; amountKobo?: unknown; data?: { allocatedKobo?: unknown; reversalStatus?: unknown; refundStatus?: unknown; refundedKobo?: unknown } | null } | null | undefined): boolean {
  if (!payment) return false;
  return (payment.status === "unallocated" || payment.status === "partial" || payment.status === "overpaid") && paymentUnappliedKobo(payment) > 0;
}
/**
 * What a refund returned to the payer: data.refundedKobo as recorded, or the
 * whole payment for a refund recorded before the amount was kept.
 */
export function paymentRefundedKobo(payment: { amountKobo?: unknown; data?: { refundStatus?: unknown; refundedKobo?: unknown } | null } | null | undefined): number {
  if (!payment || normaliseRefundStatus(payment.data?.refundStatus) !== "refunded") return 0;
  const recorded = payment.data?.refundedKobo;
  return typeof recorded === "number" && Number.isSafeInteger(recorded) && recorded >= 0 ? recorded : Number(payment.amountKobo || 0);
}
/**
 * The applied money that stands: what a payment applied to instalments, less
 * whatever of it a refund returned, and nothing once the payment was reversed.
 * Billing, the uplift report and the overview read collections through this.
 */
export function paymentAppliedKobo(payment: { amountKobo?: unknown; data?: { allocatedKobo?: unknown; reversalStatus?: unknown; refundStatus?: unknown; refundedKobo?: unknown } | null } | null | undefined): number {
  if (!payment || normaliseReversalStatus(payment.data?.reversalStatus) === "reversed") return 0;
  return Math.max(0, Math.min(Number(payment.data?.allocatedKobo || 0), Number(payment.amountKobo || 0) - paymentRefundedKobo(payment)));
}
/** Instalment statuses that take no allocation, whatever is still owed. */
export const allocationClosedStatuses = ["cancelled", "closed", "in_dispute"] as const;
/** What an instalment still owes: its outstanding balance, or its whole amount before it has one. */
export function instalmentOutstandingKobo(due: { amountKobo: number; data?: { outstandingKobo?: unknown } | null }): number {
  const outstanding = due.data?.outstandingKobo;
  return Number.isInteger(outstanding) ? Number(outstanding) : due.amountKobo;
}
/**
 * An instalment that can take an allocation now: it still owes something, is
 * not cancelled, closed or in dispute, and reconciliation does not hold it for
 * a renewed review of an earlier reversal decision (legacyReversalReviewIds),
 * whatever its status. A manual allocation is refused for any other, the hold
 * with its own reason, and the allocation picker lists only these (the record
 * list's `allocatable`), so its count is the count of choices.
 */
export function canTakeAllocation(due: { status: string; amountKobo: number; data?: { outstandingKobo?: unknown; legacyReversalReviewIds?: unknown } | null }): boolean {
  const held = due.data?.legacyReversalReviewIds;
  return instalmentOutstandingKobo(due) > 0 && !(allocationClosedStatuses as readonly string[]).includes(due.status) && !(Array.isArray(held) && held.length > 0);
}

/** Why a customer message was sent. */
export const notificationPurposes = ["activation_reminder", "pre_debit", "failed_debit", "confirmation", "final_attempt", "policy_change"] as const;

/** NFR-OBS-02 alert severities, most urgent first. */
export const alertSeverities = ["critical", "high", "medium", "info"] as const;
/** An alert's severity. */
export type AlertSeverity = (typeof alertSeverities)[number];
/** The channels a customer message can go by. */
export const notificationChannels = ["sms", "whatsapp", "email"] as const;

/** REC-01: whether a daily close was started by the scheduler at the configured time or by a person. */
export const closeTriggers = ["scheduled", "manual"] as const;
/** What started a daily close. */
export type CloseTrigger = (typeof closeTriggers)[number];

/** BIL-07: why a billed collection carries a credit or debit line on a later invoice. */
export const adjustmentReasons = ["reversal", "refund", "confirmed_duplicate", "wrong_allocation", "re_allocation"] as const;
/** Why an adjustment line exists. */
export type AdjustmentReason = (typeof adjustmentReasons)[number];
