/**
 * TRD 4.4 normalised failure codes.  Every module downstream of a connector
 * works only with these codes; provider-specific spellings are aliases.
 */
export type RetryRule = "yes" | "once" | "no" | "never" | "unresolved";

/** A catalogue entry: what the code means, its retry rule and how it is handled. */
export interface FailureCodeDefinition {
  readonly meaning: string;
  readonly retry: RetryRule;
  readonly handling: string;
}

/** The TRD 4.4 catalogue, keyed by normalised code. */
export const failureCodes = {
  INSUFFICIENT_FUNDS: { meaning: "The account did not have enough money for this debit.", retry: "yes", handling: "Retry only within the retry policy’s limits and after the required notice." },
  ACCOUNT_RESTRICTED: { meaning: "The bank has restricted debits from this account.", retry: "once", handling: "Allow one retry after the required waiting period, then raise an exception." },
  INVALID_ACCOUNT: { meaning: "The account does not exist or is closed.", retry: "no", handling: "Raise an exception and flag the mandate for review." },
  MANDATE_INACTIVE: { meaning: "The provider has not marked the mandate as active.", retry: "no", handling: "Cancel the attempt and review the mandate activation." },
  MANDATE_LIMIT_EXCEEDED: { meaning: "The amount is above the mandate limit.", retry: "no", handling: "Raise an exception. Do not retry a lower amount unless the consent covers it." },
  BANK_UNAVAILABLE: { meaning: "The customer’s bank did not respond.", retry: "yes", handling: "Retry only within the retry policy’s limits." },
  PROVIDER_ERROR: { meaning: "The provider reported an internal error.", retry: "yes", handling: "Check the connection first. Retry the debit under the retry policy only if the provider confirms that no debit took place." },
  TIMEOUT_UNKNOWN: { meaning: "The provider has not confirmed whether the debit succeeded.", retry: "unresolved", handling: "Check the status with the provider. Raise an exception if the outcome is still unknown after 24 hours." },
  DUPLICATE: { meaning: "The provider reports a duplicate instruction.", retry: "no", handling: "Match the result to the original instruction." },
  CUSTOMER_DISPUTED: { meaning: "The customer has disputed the debit.", retry: "never", handling: "Stop collection for the instalment while the dispute is open, and raise an exception with a one-business-day deadline." },
  UNKNOWN: { meaning: "The provider returned a failure code that has not been classified.", retry: "no", handling: "Raise an exception and classify the code, so that Valo Pay 1 knows whether to retry." },
} as const satisfies Record<string, FailureCodeDefinition>;

/** A catalogue code. */
export type FailureCode = keyof typeof failureCodes;
/** Every catalogue code, in catalogue order. */
export const failureCodeList = Object.keys(failureCodes) as FailureCode[];

/** Spellings earlier builds and some providers use.  Mapped, never stored. */
export const failureCodeAliases: Readonly<Record<string, FailureCode>> = {
  TECHNICAL_FAILURE: "PROVIDER_ERROR",
  ACCOUNT_CLOSED: "INVALID_ACCOUNT",
  MANDATE_CANCELLED: "MANDATE_INACTIVE",
  MANDATE_EXPIRED: "MANDATE_INACTIVE",
  MANDATE_SUSPENDED: "MANDATE_INACTIVE",
  NO_MANDATE: "MANDATE_INACTIVE",
  LIMIT_EXCEEDED: "MANDATE_LIMIT_EXCEEDED",
  TIMEOUT: "TIMEOUT_UNKNOWN",
  DISPUTED: "CUSTOMER_DISPUTED",
};

/** True for a catalogue code or a known alias, whatever its case. */
export function isKnownFailureCode(raw: unknown): boolean {
  const value = String(raw ?? "").trim().toUpperCase();
  return value in failureCodes || value in failureCodeAliases;
}

/** Map any raw code to the catalogue; unmapped codes become UNKNOWN (mapping needed). */
export function normaliseFailureCode(raw: unknown): FailureCode {
  const value = String(raw ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (value in failureCodes) return value as FailureCode;
  return failureCodeAliases[value] ?? "UNKNOWN";
}

/** The retry rule for any raw code; an unmapped code is UNKNOWN and is not retried. */
export function retryRuleFor(raw: unknown): RetryRule {
  return failureCodes[normaliseFailureCode(raw)].retry;
}

/** Codes the section 6.2 parameter table allows a policy to retry. */
export const retryableFailureCodes: readonly FailureCode[] = failureCodeList.filter((code) => failureCodes[code].retry === "yes" || failureCodes[code].retry === "once");
/** Codes that can never be added to a retryable list (section 6.2). */
export const neverRetryableFailureCodes: readonly FailureCode[] = ["INVALID_ACCOUNT", "MANDATE_INACTIVE", "MANDATE_LIMIT_EXCEEDED", "CUSTOMER_DISPUTED"];
