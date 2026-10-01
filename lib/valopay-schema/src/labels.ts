/*
 * The words the console and the import's row errors use for a stored value:
 * a status, an enum code or a failure code. The value itself stays as the API
 * keeps it; only what a person reads changes.
 */

/** Values whose words are not simply the value itself spelled out. */
export const valueLabels: Readonly<Record<string, string>> = {
  valopay: "Valo Pay", valo: "Valo Pay", lms: "Loan management system",
  merchant_manual: "Lender team", provider_auto: "Provider automatic collection",
  pending_activation: "Awaiting activation", unpaid_final: "Unpaid after final attempt", superseded: "No longer in use",
  returned: "Returned to the payer", partial: "Partly allocated", unsettled: "Not settled", variance: "Difference found",
  webhook: "Provider notification", statement: "Bank statement", settlement: "Settlement report", transfer: "Bank transfer", card: "Card payment",
  resolved: "Resolved", condition_cleared: "Closed automatically", suspected_duplicate: "Possible duplicate", unknown_outcome: "Outcome unknown",
  settlement_variance: "Settlement difference", accepted_variance: "Difference accepted", distinct_payments: "Separate payments",
  provider_state_adopted: "Provider status accepted", platform_state_confirmed: "Valo Pay status kept", provider_identity_confirmed: "Connection confirmed",
  info: "Information", awaiting_review: "Waiting for review", fortnightly: "Every two weeks",
  in_collection: "Collection in progress", in_flight: "Awaiting an outcome",
  not_proven: "Not yet proven", not_eligible: "Not eligible for a retry",
  would_schedule: "Would schedule a retry", observation_only: "Watch only",
  give_up: "No further retries", defer: "Retry postponed", holdout: "Comparison group",
  engine: "Automated retry group", preregistered: "Plan registered",
  handed_back: "Collection returned",
  transfer_to_activate: "Activate with a bank transfer", hosted_consent: "Consent through the provider",
  paper_mandate: "Paper mandate", not_ours: "Payment belongs elsewhere",
  allocated_manual: "Allocated manually", held_credit: "Kept unallocated",
  confirmed_duplicate_refund: "Duplicate confirmed; refund required",
  same_payment: "Same payment; evidence joined to it", not_money: "Not money; evidence set aside",
  paid_other_channel: "Paid through another channel", applied_to_next: "Allocated to the next instalment",
  rescheduled_by_lms: "Rescheduled in the loan system", written_off_by_lms: "Written off in the loan system",
  limit_raised_new_mandate: "Limit increased through a new mandate", split_by_lms: "Split in the loan system",
  upheld_refund: "Dispute upheld; refund required", not_upheld: "Dispute not upheld",
  resolved_succeeded: "Confirmed successful", resolved_failed: "Confirmed failed",
  deferred_executed: "Postponed attempt completed", customer_unreachable_cancelled: "Cancelled; customer could not be reached",
  incumbent_disabled: "Previous collection system disabled", owner_reverted: "Previous collection owner restored",
  mapped_to_code: "Failure code classified", imported_consent_gap: "Missing consent evidence",
  notice_not_evidenced: "Notice acceptance not confirmed", ownership_conflict: "Collection ownership conflict",
  mapping_needed: "Failure code needs classification", activation_expired: "Activation deadline passed",
  INSUFFICIENT_FUNDS: "Insufficient funds", ACCOUNT_RESTRICTED: "Account restricted",
  INVALID_ACCOUNT: "Invalid or closed account", MANDATE_INACTIVE: "Mandate inactive",
  MANDATE_LIMIT_EXCEEDED: "Mandate limit exceeded", BANK_UNAVAILABLE: "Bank unavailable",
  PROVIDER_ERROR: "Provider error", TIMEOUT_UNKNOWN: "Outcome unknown",
  DUPLICATE: "Duplicate instruction", CUSTOMER_DISPUTED: "Customer disputed the debit", UNKNOWN: "Unclassified failure",
  // Connected banking. A code that other pages show in other words, or that needs its own colour, is keyed by the record it describes ("checkout.created").
  review_pending: "Waiting for review", insufficient_evidence: "More evidence needed", reconciled_for_review: "Ready for accountant review",
  exported_unpaid: "Exported, not paid", needs_reconciliation: "Some outcomes unknown", partially_completed: "Not all confirmed",
  "checkout.created": "Awaiting authorisation", "checkout.unknown": "Outcome unknown", "permission.revoked": "Withdrawn",
  "assessment.blocked": "Blocked", "accounting-draft.blocked": "Blocked",
  "accounting-draft.proposed": "Waiting for review", "accounting-draft.reviewed": "Approved",
  "accounting-draft.review_required": "Needs new approval", "vat-schedule.review_required": "Needs evidence",
  "payroll-run.completed": "All confirmed", "payroll-run.submitted": "Sent to bank", "payroll-item.submitted": "Sent to bank",
  "payroll-item.succeeded": "Confirmed", "payroll-item.unknown": "Outcome unknown", "payroll-funding.unknown": "Balance unknown",
  // Import batches, Data sources, Reports, Data retention and Team and access.
  committed: "Imported", awaiting_first_delivery: "Waiting for the first delivery",
  awaiting_verification: "Waiting for a Paystack check", quarantined: "Held for review", ignored_stale: "Ignored: older message",
  rejected_fixture: "Rejected: signature did not match", wrong_allocation: "Wrong match undone",
  re_allocation: "Allocated again at a higher value",
  preview: "Waiting for review", running: "In progress", attention: "Needs attention", already_absent: "Already deleted",
  "staff.invited": "Invitation created", "staff.invitation_approved": "Invitation approved", "staff.invitation_revoked": "Invitation revoked",
  "staff.accepted": "Invitation accepted", "staff.change_requested": "Access change requested", "staff.changed": "Access changed",
  "staff.change_approved": "Access change approved", "staff.change_declined": "Access change rejected or withdrawn",
  "staff.lender_access_changed": "Lender access changed", "staff.provisioned": "First Admin set up by the Valo Pay team",
  "staff.administrator_added": "Admin added by the Valo Pay team", "staff.renewed": "Access renewed",
};

/** A stored value in words: its label, or the value spelled out ("pending_review" as "Pending review"). */
export function valueLabel(value: unknown): string {
  // A missing value reads "Not recorded", as the standard words a missing value.
  const raw = String(value || "Not recorded");
  if (Object.hasOwn(valueLabels, raw)) return valueLabels[raw]!;
  // In sentence case, whatever the code's own capitals: "awaitingProviderReview" and "AWAITING_PROVIDER_REVIEW" both as "Awaiting provider review".
  const spelled = raw.replace(/([a-z\d])([A-Z])/g, (_, before: string, capital: string) => `${before} ${capital.toLowerCase()}`).replace(/[_.-]+/g, " ");
  const words = raw === raw.toUpperCase() ? spelled.toLowerCase() : spelled;
  return words.charAt(0).toUpperCase() + words.slice(1);
}
