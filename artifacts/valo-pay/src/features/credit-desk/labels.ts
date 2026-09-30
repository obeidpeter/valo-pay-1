export const scenarios = [
  [
    "ready",
    "Complete evidence",
    "Three months of income, with costs and existing repayments checked.",
  ],
  [
    "thin_file",
    "Short history",
    "Only one month of bank records. This shows why three months are needed.",
  ],
  [
    "stale",
    "Out-of-date evidence",
    "The bank records are too old. This shows why they must be refreshed first.",
  ],
  [
    "refused",
    "Applicant refused permission",
    "The applicant refused permission to assess the application. There is no score, and the refusal does not count against them.",
  ],
  [
    "high_commitments",
    "High existing repayments",
    "A good score cannot outweigh repayments the applicant cannot afford.",
  ],
] as const;
export const recommendationLabels: Record<string, string> = {
  review_recommended: "Policy checks met",
  policy_not_met: "Policy checks not met",
  insufficient_evidence: "More evidence needed",
};
export const outcomeLabels: Record<string, string> = {
  approve: "Sample approval recorded",
  decline: "Sample decline recorded",
  request_information: "More information requested",
};
/** Why a bank transaction was left out of the assessment, by the code the assessment records. */
export const exclusionLabels: Record<string, string> = {
  outside_observation_window: "Outside the dates checked",
  pending: "Pending, not yet booked",
  reversed: "Reversed by the bank",
  classification_requires_review: "Type unclear, needs review",
  matched_own_account_transfer: "Transfer between the applicant’s own accounts",
  unconfirmed_own_account_transfer: "Transfer between own accounts that could not be matched",
  non_recurring_income: "One-off income",
  counted_in_commitment_register: "Already counted as an existing repayment",
  not_eligible_recurring_income: "Not regular income",
};
