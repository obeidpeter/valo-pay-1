export const scenarios = [
  [
    "ready",
    "Complete evidence",
    "Three income cycles, reviewed costs and commitments.",
  ],
  [
    "thin_file",
    "Short history",
    "Show why a month of records cannot stand in for three.",
  ],
  [
    "stale",
    "Out-of-date evidence",
    "Ask for a refresh before the result can be used.",
  ],
  [
    "refused",
    "Optional permission refused",
    "Refusal leaves the score unavailable; it is not bad credit.",
  ],
  [
    "high_commitments",
    "High existing repayments",
    "A strong rule score cannot bypass affordability.",
  ],
] as const;
export const recommendationLabels: Record<string, string> = {
  review_recommended: "Ready for lender review",
  policy_not_met: "Policy checks not met",
  insufficient_evidence: "More evidence needed",
};
export const outcomeLabels: Record<string, string> = {
  approve: "Sample approval recorded",
  decline: "Sample decline recorded",
  request_information: "More information requested",
};
