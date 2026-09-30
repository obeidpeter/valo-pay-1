/*
 * The words the console and the import's row errors use for a stored value:
 * a status, an enum code or a failure code. The value itself stays as the API
 * keeps it; only what a person reads changes.
 */

/** Values whose words are not simply the value itself spelled out. */
export const valueLabels: Readonly<Record<string, string>> = {
  valopay: "Valo Pay", valo: "Valo Pay", lms: "Loan management system",
  merchant_manual: "Lender team", provider_auto: "Provider automatic collection",
  pending_activation: "Awaiting activation", unpaid_final: "Unpaid after final attempt", superseded: "No longer applied",
  returned: "Returned to the payer",
  in_collection: "Collection in progress", in_flight: "Awaiting an outcome",
  not_proven: "Not yet proven", not_eligible: "Not eligible for a retry",
  would_schedule: "Would schedule a retry", observation_only: "Observation only",
  give_up: "No further retries", defer: "Retry postponed", holdout: "Comparison group",
  engine: "Automated retry group", preregistered: "Plan registered",
  handed_back: "Returned to the fallback collection owner",
  transfer_to_activate: "Activate with a bank transfer", hosted_consent: "Consent through the provider",
  paper_mandate: "Paper mandate", not_ours: "Payment belongs elsewhere",
  allocated_manual: "Allocated manually", held_credit: "Kept as unallocated credit",
  confirmed_duplicate_refund: "Duplicate confirmed; refund required",
  same_payment: "Same payment; evidence joined to it", not_money: "Not money; evidence set aside",
  paid_other_channel: "Paid through another channel", applied_to_next: "Applied to the next instalment",
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
  // Import batches, Data sources, Reports, Data retention and Team and access.
  committed: "Imported", awaiting_review: "Waiting for review", awaiting_first_delivery: "Waiting for the first delivery",
  awaiting_verification: "Waiting for a Paystack check", quarantined: "Held for review", ignored_stale: "Ignored: older message",
  rejected_fixture: "Rejected: signature did not match", wrong_allocation: "Wrong match undone",
  re_allocation: "Allocated again at a higher value",
  preview: "Waiting for approval", running: "In progress", attention: "Needs attention", already_absent: "Already deleted",
  "staff.invited": "Invitation created", "staff.invitation_approved": "Invitation approved", "staff.invitation_revoked": "Invitation revoked",
  "staff.accepted": "Invitation accepted", "staff.change_requested": "Access change requested", "staff.changed": "Access changed",
  "staff.change_approved": "Access change approved", "staff.change_declined": "Access change rejected or withdrawn",
  "staff.lender_access_changed": "Lender access changed", "staff.provisioned": "First Admin set up by the Valo Pay team",
  "staff.administrator_added": "Admin added by the Valo Pay team", "staff.renewed": "Access renewed",
};

/** A stored value in words: its label, or the value spelled out ("pending_review" as "Pending review"). */
export function valueLabel(value: unknown): string {
  const raw = String(value || "Unknown");
  if (Object.hasOwn(valueLabels, raw)) return valueLabels[raw]!;
  const words = raw.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/[_.-]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
