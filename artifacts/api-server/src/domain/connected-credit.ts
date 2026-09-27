import {
  counted,
  legacyCollatedCompare,
  multiplyDivideMoney,
  sameJson,
  WAT_OFFSET_MS,
} from "@workspace/valopay-schema";
import { canonicalDigest } from "../lib/digests";

/**
 * Synthetic Credit Desk. This module has no provider client, payment command or
 * lending side effect. Its rulecard is an illustrative, unvalidated rulecard,
 * never a probability of default or permission to make a real lending decision.
 * Callers must persist results and reviews as append-only, tenant-scoped records.
 */
export type CreditSegment =
  "salaried" | "self_employed" | "microbusiness" | "thin_file";
export type CreditPermission = "credit:assess" | "credit:review";
export interface CreditContext {
  tenantId: string;
  actorId: string;
  permissions: readonly CreditPermission[];
  now: string;
  mfaVerified?: boolean;
}
export interface CreditGrant {
  id: string;
  tenantId: string;
  applicantId: string;
  purpose: "applicant_account_read" | "credit_assessment";
  status: "active" | "refused" | "revoked" | "expired" | "suspended";
  accountIds: string[];
  validFrom: string;
  expiresAt: string;
  version: number;
}
export interface CreditSource {
  id: string;
  tenantId: string;
  applicantId: string;
  accountId: string;
  synthetic: true;
  accessMethod: "bank_authorised" | "credential_aggregation" | "unknown";
  identityVerified: boolean;
  currency: "NGN";
  acquiredAt: string;
  sourceAsOf: string;
  coverageStart: string;
  coverageEnd: string;
  pagesComplete: boolean;
  missingDays: number;
  contentHash: string;
  /** Booked balance observations; a single current balance is not a history. */
  dailyBalances: { date: string; balanceKobo: number }[];
}
export type CreditTransactionCategory =
  | "salary"
  | "business_revenue"
  | "own_transfer"
  | "loan_proceeds"
  | "refund"
  | "asset_sale"
  | "essential_expense"
  | "business_expense"
  | "debt_service"
  | "unknown";
export interface CreditTransaction {
  id: string;
  sourceId: string;
  accountId: string;
  bookedAt: string;
  amountKobo: number;
  direction: "credit" | "debit";
  currency: "NGN";
  status: "booked" | "pending" | "reversed";
  category: CreditTransactionCategory;
  classification: "confirmed" | "unreviewed";
  /** Opaque source identity, not a bank account number or sensitive narration. */
  payerRef?: string;
  facilityRef?: string;
  /** Both equally sized, opposite legs and common authorised ownership required. */
  transferPairRef?: string;
}
export interface CreditCommitment {
  facilityRef: string;
  monthlyKobo: number;
  evidence: "verified" | "declared";
  sourceAsOf: string;
}
export interface CreditPolicy {
  id: string;
  version: number;
  rulecardVersion: string;
  status: "synthetic_only";
  segment: Exclude<CreditSegment, "thin_file">;
  minHistoryDays: number;
  maxSourceAgeDays: number;
  maxUnknownInflowBps: number;
  minScore: number;
  incomeStressBps: number;
  maxDebtServiceBps: number;
  minimumResidualKobo: number;
}
export interface CreditAssessmentInput {
  mode: "synthetic";
  tenantId: string;
  applicantId: string;
  applicationRef: string;
  version: number;
  previousResultId?: string;
  segment: CreditSegment;
  asOf: string;
  grants: CreditGrant[];
  requiredAccountIds: string[];
  sources: CreditSource[];
  transactions: CreditTransaction[];
  commitments: CreditCommitment[];
  commitmentsReviewed: boolean;
  declaredEssentialMonthlyKobo: number;
  essentialCostsReviewed: boolean;
  repaymentHistory: {
    known: boolean;
    missedPayments: number;
    sourceAsOf: string;
  };
  requestedPrincipalKobo: number;
  /** Actual inclusive-of-charges lender schedule, not an assumed flat EMI. */
  repaymentSchedule: { dueAt: string; amountKobo: number }[];
  policy: CreditPolicy;
}
export interface CreditIssue {
  code: string;
  message: string;
  severity: "blocking" | "warning";
  sourceId?: string;
}
export interface CreditFeatures {
  codeVersion: "credit-features-synthetic-v1";
  currency: "NGN";
  periodDays: 30;
  periodCount: number;
  monthlyIncomeKobo: number[];
  sustainableMonthlyIncomeKobo: number;
  observedEssentialMonthlyKobo: number;
  essentialMonthlyKobo: number;
  verifiedCommitmentsMonthlyKobo: number;
  declaredCommitmentsMonthlyKobo: number;
  totalCommitmentsMonthlyKobo: number;
  activeIncomePeriods: number;
  incomeVolatilityBps: number | null;
  largestPayerShareBps: number | null;
  liquidityBufferKobo: number | null;
  unknownInflowKobo: number;
  unknownInflowBps: number;
  includedTransactionRefs: string[];
  excludedTransactions: { reference: string; reason: string }[];
  duplicatesIgnored: number;
}
export interface CreditAffordability {
  incomeStressBps: number;
  stressedMonthlyIncomeKobo: number;
  baselineResidualKobo: number;
  stressedResidualKobo: number;
  monthlyCapacityKobo: number;
  peakScheduledMonthlyKobo: number;
  scheduledTotalKobo: number;
  requestedPrincipalKobo: number;
  /** Proportionally scales THIS schedule only; not a loan offer or new terms. */
  indicativePrincipalCapacityKobo: number;
  termDays: number;
  debtServiceBps: number | null;
  repaymentMonths: {
    month: string;
    amountKobo: number;
    stressedAfterPaymentKobo: number;
  }[];
  scheduleAffordable: boolean;
}
export interface CreditScoreFactor {
  code: string;
  label: string;
  points: number;
  maximum: number;
  reason: string;
}
export interface CreditAssessmentResult {
  id: string;
  tenantId: string;
  applicantId: string;
  applicationRef: string;
  version: number;
  previousResultId: string | null;
  mode: "synthetic";
  createdAt: string;
  assessedAsOf: string;
  createdBy: string;
  state: "review_pending" | "insufficient_evidence" | "blocked";
  evidence: {
    status: "adequate" | "insufficient" | "blocked";
    issues: CreditIssue[];
    coverageDays: number;
    sourceCount: number;
    latestSourceAsOf: string | null;
    earliestSourceAsOf: string | null;
    reviewValidUntil: string | null;
    requiredAccountIds: string[];
    grantVersions: { id: string; version: number }[];
  };
  features: CreditFeatures | null;
  score: {
    type: "rulecard";
    value: number;
    maximum: 100;
    band: "stronger" | "review" | "weaker";
    rulecardVersion: string;
    factors: CreditScoreFactor[];
    disclaimer: string;
  } | null;
  affordability: CreditAffordability | null;
  policy: {
    id: string;
    version: number;
    recommendation:
      "review_recommended" | "policy_not_met" | "insufficient_evidence";
    reasons: string[];
  };
  snapshotHash: string;
  requiredReview: true;
  billable: false;
  restrictions: string[];
}
export interface CreditReviewInput {
  expectedAssessmentVersion: number;
  outcome: "approve" | "amend_terms" | "decline" | "request_information";
  rationale: string;
  applicantExplanation: string;
  reasonCodes: string[];
  overrideRationale?: string;
  /** Rechecked CURRENT grants, not the assessment's historical snapshots. */
  currentGrants: CreditGrant[];
}
export interface CreditReviewRecord {
  id: string;
  assessmentId: string;
  assessmentVersion: number;
  tenantId: string;
  applicantId: string;
  reviewer: string;
  reviewedAt: string;
  outcome: CreditReviewInput["outcome"];
  rationale: string;
  applicantExplanation: string;
  reasonCodes: string[];
  override: boolean;
  overrideRationale: string | null;
  mode: "synthetic";
  actualLendingDecision: false;
  fundsMoved: false;
}

export class CreditDomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "CreditDomainError";
  }
}
export const DEFAULT_SYNTHETIC_CREDIT_POLICY: Readonly<CreditPolicy> =
  Object.freeze({
    id: "synthetic-salaried-v1",
    version: 1,
    rulecardVersion: "illustrative-rulecard-v1",
    status: "synthetic_only",
    segment: "salaried",
    minHistoryDays: 90,
    maxSourceAgeDays: 7,
    maxUnknownInflowBps: 2000,
    minScore: 65,
    incomeStressBps: 2000,
    maxDebtServiceBps: 4000,
    minimumResidualKobo: 5_000_000,
  });
const DAY = 86_400_000;
const transactionCategories = new Set<CreditTransactionCategory>([
  "salary",
  "business_revenue",
  "own_transfer",
  "loan_proceeds",
  "refund",
  "asset_sale",
  "essential_expense",
  "business_expense",
  "debt_service",
  "unknown",
]);
const fail = (code: string, message: string, status = 400): never => {
  throw new CreditDomainError(code, message, status);
};
function stamp(value: string): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return fail("INVALID_DATE", "Use a valid UTC timestamp.");
  if (new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19))
    return fail(
      "INVALID_DATE",
      "The timestamp contains an invalid calendar date.",
    );
  return Date.parse(value);
}
/**
 * The same West Africa Time day and time `months` calendar months after an
 * instant, or the month's last day when it is shorter: a monthly repayment
 * date, so each month carries one repayment.
 */
export function monthsAfter(value: string, months: number): string {
  const wat = new Date(stamp(value) + WAT_OFFSET_MS);
  const target = new Date(
    Date.UTC(
      wat.getUTCFullYear(),
      wat.getUTCMonth() + months,
      1,
      wat.getUTCHours(),
      wat.getUTCMinutes(),
      wat.getUTCSeconds(),
      wat.getUTCMilliseconds(),
    ),
  );
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(wat.getUTCDate(), lastDay));
  return new Date(target.getTime() - WAT_OFFSET_MS).toISOString();
}
function integer(value: number, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum)
    return fail(
      "INVALID_AMOUNT",
      `${label} must be a safe whole number${minimum >= 0 ? " of at least " + minimum : ""}.`,
    );
  return value;
}
function checked(value: bigint): number {
  const result = Number(value);
  return integer(result, "Calculated value", Number.MIN_SAFE_INTEGER);
}
function sum(values: number[]): number {
  return checked(
    values.reduce(
      (total, value) =>
        total + BigInt(integer(value, "Amount", Number.MIN_SAFE_INTEGER)),
      0n,
    ),
  );
}
function mulDiv(value: number, multiplier: number, divisor: number): number {
  return checked((BigInt(value) * BigInt(multiplier)) / BigInt(divisor));
}
function ratio(value: number, denominator: number): number | null {
  return denominator > 0 ? mulDiv(value, 10_000, denominator) : null;
}
function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : checked((BigInt(sorted[middle - 1]!) + BigInt(sorted[middle]!)) / 2n);
}
// Snapshot hashes and the IDs derived from them are stored with each
// assessment and review: they keep the form they were first written in.
function hash(value: unknown): string {
  return canonicalDigest(value, "legacy-en-us-omit");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function permission(
  ctx: CreditContext,
  requested: CreditPermission,
  tenantId: string,
): void {
  if (
    !ctx.actorId?.trim() ||
    ctx.tenantId !== tenantId ||
    !ctx.permissions.includes(requested)
  )
    fail(
      "CREDIT_FORBIDDEN",
      "You do not have permission for this Credit Desk action in this workspace.",
      403,
    );
  stamp(ctx.now);
}
function validateGrantBindings(
  grants: CreditGrant[],
  tenantId: string,
  applicantId: string,
): void {
  for (const grant of grants) {
    if (grant.tenantId !== tenantId || grant.applicantId !== applicantId)
      fail(
        "GRANT_SCOPE_MISMATCH",
        "The permission belongs to a different workspace or applicant.",
        403,
      );
    integer(grant.version, "Permission version", 1);
    stamp(grant.validFrom);
    stamp(grant.expiresAt);
    if (
      !grant.id ||
      !["applicant_account_read", "credit_assessment"].includes(
        grant.purpose,
      ) ||
      !["active", "refused", "revoked", "expired", "suspended"].includes(
        grant.status,
      )
    )
      fail(
        "INVALID_GRANT",
        "Credit permissions must have an explicit supported purpose and state.",
      );
  }
  if (new Set(grants.map((grant) => grant.id)).size !== grants.length)
    fail("AMBIGUOUS_GRANT", "Supply each current permission once.");
}
function grantIssues(
  grants: CreditGrant[],
  accounts: string[],
  tenantId: string,
  applicantId: string,
  now: number,
): CreditIssue[] {
  validateGrantBindings(grants, tenantId, applicantId);
  const issues: CreditIssue[] = [];
  for (const purpose of [
    "applicant_account_read",
    "credit_assessment",
  ] as const) {
    for (const account of accounts) {
      const candidates = grants.filter(
        (grant) =>
          grant.purpose === purpose && grant.accountIds.includes(account),
      );
      const active = candidates.some(
        (grant) =>
          grant.status === "active" &&
          stamp(grant.validFrom) <= now &&
          stamp(grant.expiresAt) > now,
      );
      if (!active) {
        const state = candidates.some(
          (grant) => grant.status === "revoked" || grant.status === "suspended",
        )
          ? "REVOKED"
          : candidates.some((grant) => grant.status === "refused")
            ? "REFUSED"
            : candidates.length
              ? "EXPIRED"
              : "MISSING";
        issues.push({
          code: `AUTHORITY_${state}`,
          severity: "blocking",
          message: `${purpose === "credit_assessment" ? "Credit assessment" : "Account reading"} permission is ${state.toLowerCase()} for a required account. Refusal is not a credit-risk penalty.`,
        });
      }
    }
  }
  return issues;
}

/** Produce an immutable reproducible evidence + calculation + recommendation snapshot. */
export function assessCredit(
  input: CreditAssessmentInput,
  context: CreditContext,
): CreditAssessmentResult {
  permission(context, "credit:assess", input.tenantId);
  if (input.mode !== "synthetic" || input.policy.status !== "synthetic_only")
    fail(
      "LIVE_CREDIT_DISABLED",
      "Credit Desk currently supports synthetic assessment exercises only.",
      403,
    );
  if (!input.applicantId?.trim() || !input.applicationRef?.trim())
    fail(
      "APPLICATION_REQUIRED",
      "An applicant and lender application reference are required.",
    );
  integer(input.version, "Assessment version", 1);
  if (input.version > 1 !== Boolean(input.previousResultId))
    fail(
      "VERSION_LINEAGE_REQUIRED",
      "A reassessment must link its previous immutable result; a first assessment cannot replace one.",
    );
  const asOf = stamp(input.asOf),
    now = stamp(context.now),
    policy = input.policy;
  if (asOf > now)
    fail(
      "FUTURE_ASSESSMENT",
      "An assessment cannot use a future decision cutoff.",
    );
  integer(input.requestedPrincipalKobo, "Requested principal", 1);
  integer(input.declaredEssentialMonthlyKobo, "Declared essential costs");
  integer(policy.version, "Policy version", 1);
  integer(policy.minHistoryDays, "History window", 30);
  integer(policy.maxSourceAgeDays, "Maximum data age", 1);
  integer(policy.minimumResidualKobo, "Residual buffer");
  for (const value of [
    policy.incomeStressBps,
    policy.maxUnknownInflowBps,
    policy.maxDebtServiceBps,
  ])
    if (!Number.isInteger(value) || value < 0 || value > 10_000)
      fail(
        "INVALID_POLICY",
        "Policy ratios must be from 0 to 10,000 basis points.",
      );
  if (
    !Number.isInteger(policy.minScore) ||
    policy.minScore < 0 ||
    policy.minScore > 100 ||
    policy.minHistoryDays > 720
  )
    fail("INVALID_POLICY", "The illustrative policy limits are invalid.");
  if (
    !policy.id?.trim() ||
    !policy.rulecardVersion?.trim() ||
    !["salaried", "self_employed", "microbusiness"].includes(policy.segment)
  )
    fail("INVALID_POLICY", "A named, versioned segment policy is required.");
  if (
    !input.requiredAccountIds.length ||
    new Set(input.requiredAccountIds).size !==
      input.requiredAccountIds.length ||
    input.requiredAccountIds.some((id) => !id)
  )
    fail(
      "REQUIRED_ACCOUNTS",
      "Select distinct required accounts for the evidence scope.",
    );
  if (
    input.transactions.length > 50_000 ||
    input.sources.length > 50 ||
    input.grants.length > 100 ||
    input.commitments.length > 1000 ||
    input.repaymentSchedule.length > 366
  )
    fail(
      "INPUT_TOO_LARGE",
      "This assessment exceeds the bounded synthetic assessment limits.",
    );
  const issues = grantIssues(
    input.grants,
    input.requiredAccountIds,
    input.tenantId,
    input.applicantId,
    now,
  );
  const issue = (
    code: string,
    message: string,
    sourceId?: string,
    severity: CreditIssue["severity"] = "blocking",
  ) =>
    issues.push({ code, message, severity, ...(sourceId ? { sourceId } : {}) });
  if (input.segment !== policy.segment)
    issue(
      "SEGMENT_NOT_VALIDATED",
      "This policy is not defined for the applicant's segment. Thin history must not inherit another segment's score.",
    );
  if (!input.commitmentsReviewed)
    issue(
      "COMMITMENTS_INCOMPLETE",
      "Existing commitments have not been reviewed. Unknown debt is not zero debt.",
    );
  if (!input.essentialCostsReviewed)
    issue(
      "ESSENTIAL_COSTS_INCOMPLETE",
      "Essential living or business costs have not been reviewed.",
    );
  if (!input.repaymentHistory.known)
    issue(
      "REPAYMENT_HISTORY_UNKNOWN",
      "Verified commitment behaviour is missing; the rulecard cannot award or silently redistribute these points.",
    );
  integer(input.repaymentHistory.missedPayments, "Missed repayments");
  if (
    input.repaymentHistory.known &&
    (stamp(input.repaymentHistory.sourceAsOf) > asOf ||
      now - stamp(input.repaymentHistory.sourceAsOf) >
        policy.maxSourceAgeDays * DAY)
  )
    issue(
      "REPAYMENT_HISTORY_STALE",
      "Refresh repayment history before producing a score.",
    );
  const windowStart = asOf - policy.minHistoryDays * DAY,
    sources = new Map<string, CreditSource>();
  let coverageDays = policy.minHistoryDays;
  for (const source of input.sources) {
    if (
      source.tenantId !== input.tenantId ||
      source.applicantId !== input.applicantId
    )
      fail(
        "SOURCE_SCOPE_MISMATCH",
        "Account evidence belongs to another workspace or applicant.",
        403,
      );
    if (!input.requiredAccountIds.includes(source.accountId))
      fail(
        "SOURCE_OUTSIDE_PURPOSE",
        "The source account is outside this assessment's authorised scope.",
        403,
      );
    if (
      sources.has(source.id) ||
      [...sources.values()].some(
        (other) => other.accountId === source.accountId,
      )
    )
      fail(
        "AMBIGUOUS_SOURCE",
        "Supply one canonical evidence snapshot per account.",
      );
    sources.set(source.id, source);
    const acquired = stamp(source.acquiredAt),
      sourceAsOf = stamp(source.sourceAsOf),
      start = stamp(source.coverageStart),
      end = stamp(source.coverageEnd);
    integer(source.missingDays, "Missing history days");
    if (source.synthetic !== true || source.accessMethod !== "bank_authorised")
      issue(
        "SOURCE_NOT_AUTHORISED",
        "This source is not a synthetic bank-authorised route. Credential aggregation is unsupported.",
        source.id,
      );
    if (!source.identityVerified)
      issue(
        "IDENTITY_UNCONFIRMED",
        "The account-to-applicant identity link is unconfirmed.",
        source.id,
      );
    if (source.currency !== "NGN")
      issue(
        "UNSUPPORTED_CURRENCY",
        "This illustrative rulecard supports NGN evidence only.",
        source.id,
      );
    if (
      acquired > asOf ||
      sourceAsOf > asOf ||
      end > sourceAsOf ||
      start > end ||
      acquired < sourceAsOf
    )
      issue(
        "EVIDENCE_AFTER_CUTOFF",
        "The source vintage or coverage is inconsistent with the decision cutoff. Future evidence is not used.",
        source.id,
      );
    if (now - sourceAsOf > policy.maxSourceAgeDays * DAY)
      issue(
        "STALE_SOURCE",
        "Bank evidence is older than this policy permits. Refresh it before review.",
        source.id,
      );
    if (!source.pagesComplete || source.missingDays)
      issue(
        "HISTORY_GAPS",
        "History has missing days or incomplete pages. Missing records are not zero activity.",
        source.id,
      );
    if (!source.contentHash?.trim())
      issue(
        "PROVENANCE_MISSING",
        "The source content digest is missing.",
        source.id,
      );
    const covered = Math.max(
      0,
      Math.floor((Math.min(end, asOf) - Math.max(start, windowStart)) / DAY) -
        source.missingDays,
    );
    coverageDays = Math.min(coverageDays, covered);
    if (start > windowStart || end < asOf)
      issue(
        "SHORT_HISTORY",
        `This policy needs ${policy.minHistoryDays} complete days through the assessment cutoff.`,
        source.id,
      );
    for (const balance of source.dailyBalances) {
      stamp(balance.date);
      integer(balance.balanceKobo, "Booked balance", Number.MIN_SAFE_INTEGER);
    }
  }
  for (const account of input.requiredAccountIds)
    if (![...sources.values()].some((source) => source.accountId === account)) {
      issue("MISSING_SOURCE", "A required account has no source evidence.");
      coverageDays = 0;
    }
  const commitments = new Map<string, CreditCommitment>();
  for (const commitment of input.commitments) {
    if (
      !commitment.facilityRef ||
      !["verified", "declared"].includes(commitment.evidence)
    )
      fail(
        "INVALID_COMMITMENT",
        "Each commitment needs its facility reference and evidence type.",
      );
    integer(commitment.monthlyKobo, "Monthly commitment");
    const date = stamp(commitment.sourceAsOf);
    if (date > asOf || now - date > policy.maxSourceAgeDays * DAY)
      issue(
        "STALE_COMMITMENT",
        "A commitment is stale or was observed after the assessment cutoff.",
      );
    const prior = commitments.get(commitment.facilityRef);
    if (prior && prior.monthlyKobo !== commitment.monthlyKobo)
      issue(
        "CONFLICTING_COMMITMENT",
        "Different amounts were supplied for the same facility. Reconcile them before assessment.",
      );
    if (!prior || commitment.evidence === "verified")
      commitments.set(commitment.facilityRef, commitment);
  }
  if (!input.repaymentSchedule.length)
    fail(
      "SCHEDULE_REQUIRED",
      "Supply the lender's proposed repayment schedule including all charges.",
    );
  const scheduleByMonth = new Map<string, number>();
  // Two calendar years, so a 24-month schedule fits even when it spans 29 February.
  const horizon = stamp(monthsAfter(input.asOf, 24));
  for (const payment of input.repaymentSchedule) {
    const due = stamp(payment.dueAt);
    integer(payment.amountKobo, "Scheduled repayment", 1);
    if (due <= asOf || due > horizon)
      fail(
        "INVALID_REPAYMENT_DATE",
        "Repayments must follow the assessment and fit within the two-year synthetic horizon.",
      );
    const month = new Date(due + 3_600_000).toISOString().slice(0, 7);
    scheduleByMonth.set(
      month,
      sum([scheduleByMonth.get(month) ?? 0, payment.amountKobo]),
    );
  }
  const scheduledTotal = sum(
    input.repaymentSchedule.map((item) => item.amountKobo),
  );
  if (scheduledTotal < input.requestedPrincipalKobo)
    fail(
      "INCOMPLETE_REPAYMENT_SCHEDULE",
      "The schedule cannot omit part of the requested principal.",
    );
  const unique = new Map<string, CreditTransaction>(),
    excluded: CreditFeatures["excludedTransactions"] = [];
  let duplicatesIgnored = 0;
  const authorisedToInfer = !issues.some(
    (item) =>
      item.code.startsWith("AUTHORITY_") ||
      ["SOURCE_NOT_AUTHORISED", "IDENTITY_UNCONFIRMED"].includes(item.code),
  );
  for (const tx of input.transactions) {
    const source = sources.get(tx.sourceId);
    if (!source || source.accountId !== tx.accountId)
      fail(
        "TRANSACTION_SCOPE_MISMATCH",
        "A transaction does not match its authorised account source.",
        403,
      );
    integer(tx.amountKobo, "Transaction amount", 1);
    const booked = stamp(tx.bookedAt);
    if (
      !tx.id ||
      !transactionCategories.has(tx.category) ||
      !["credit", "debit"].includes(tx.direction) ||
      !["booked", "pending", "reversed"].includes(tx.status) ||
      !["confirmed", "unreviewed"].includes(tx.classification)
    )
      fail(
        "INVALID_TRANSACTION",
        "A transaction has an unsupported identity, category or state.",
      );
    const key = `${tx.sourceId}:${tx.id}`,
      prior = unique.get(key);
    if (prior) {
      if (!sameJson(prior, tx))
        issue(
          "CONFLICTING_DUPLICATE",
          "The same transaction reference has conflicting evidence.",
          tx.sourceId,
        );
      else duplicatesIgnored++;
      continue;
    }
    unique.set(key, tx);
    if (tx.currency !== "NGN")
      issue(
        "UNSUPPORTED_CURRENCY",
        "Mixed currency transactions cannot be scored as NGN.",
        tx.sourceId,
      );
    if (booked > asOf)
      issue(
        "FUTURE_TRANSACTION_EXCLUDED",
        "A post-cutoff transaction was excluded; no future outcome may influence the score.",
        tx.sourceId,
        "warning",
      );
  }
  const transactionRef = (tx: CreditTransaction) => `${tx.sourceId}:${tx.id}`;
  const periodCount = Math.ceil(policy.minHistoryDays / 30),
    income = new Array<number>(periodCount).fill(0),
    expenses = new Array<number>(periodCount).fill(0);
  const included: string[] = [],
    payers = new Map<string, number>(),
    transferPairs = new Map<string, CreditTransaction[]>();
  for (const tx of unique.values())
    if (
      tx.transferPairRef &&
      tx.category === "own_transfer" &&
      tx.classification === "confirmed" &&
      tx.status === "booked"
    )
      transferPairs.set(tx.transferPairRef, [
        ...(transferPairs.get(tx.transferPairRef) ?? []),
        tx,
      ]);
  let grossInflows = 0,
    unknownInflows = 0;
  for (const tx of (authorisedToInfer ? [...unique.values()] : []).sort(
    (a, b) => legacyCollatedCompare(transactionRef(a), transactionRef(b)),
  )) {
    const date = stamp(tx.bookedAt),
      ref = transactionRef(tx),
      source = sources.get(tx.sourceId)!;
    const exclude = (reason: string) =>
      excluded.push({ reference: ref, reason });
    if (
      date > asOf ||
      date < windowStart ||
      date < stamp(source.coverageStart) ||
      date > stamp(source.coverageEnd)
    ) {
      exclude("outside_observation_window");
      continue;
    }
    if (tx.status !== "booked") {
      exclude(tx.status);
      continue;
    }
    const bucket = Math.min(
      periodCount - 1,
      Math.floor((date - windowStart) / (30 * DAY)),
    );
    if (tx.direction === "credit")
      grossInflows = sum([grossInflows, tx.amountKobo]);
    if (tx.classification !== "confirmed") {
      if (tx.direction === "credit")
        unknownInflows = sum([unknownInflows, tx.amountKobo]);
      exclude("classification_requires_review");
      continue;
    }
    if (tx.category === "own_transfer") {
      const pair = tx.transferPairRef
        ? (transferPairs.get(tx.transferPairRef) ?? [])
        : [];
      const linked =
        pair.length === 2 &&
        pair[0]!.accountId !== pair[1]!.accountId &&
        pair[0]!.direction !== pair[1]!.direction &&
        pair[0]!.amountKobo === pair[1]!.amountKobo &&
        pair.every(
          (leg) =>
            stamp(leg.bookedAt) <= asOf && stamp(leg.bookedAt) >= windowStart,
        );
      if (!linked) {
        if (tx.direction === "credit")
          unknownInflows = sum([unknownInflows, tx.amountKobo]);
        issue(
          "UNLINKED_TRANSFER",
          "An own-account transfer lacks both matched, authorised legs. It is excluded from income and needs review.",
          tx.sourceId,
          "warning",
        );
      }
      exclude(
        linked
          ? "matched_own_account_transfer"
          : "unconfirmed_own_account_transfer",
      );
      continue;
    }
    if (["loan_proceeds", "refund", "asset_sale"].includes(tx.category)) {
      exclude("non_recurring_income");
      continue;
    }
    const eligibleIncome =
      tx.direction === "credit" &&
      ((input.segment === "salaried" && tx.category === "salary") ||
        (["self_employed", "microbusiness"].includes(input.segment) &&
          tx.category === "business_revenue"));
    if (eligibleIncome) {
      income[bucket] = sum([income[bucket]!, tx.amountKobo]);
      included.push(ref);
      const payer = tx.payerRef || "unidentified_source";
      payers.set(payer, sum([payers.get(payer) ?? 0, tx.amountKobo]));
    } else if (
      tx.direction === "debit" &&
      ["essential_expense", "business_expense"].includes(tx.category)
    ) {
      expenses[bucket] = sum([expenses[bucket]!, tx.amountKobo]);
      included.push(ref);
    } else if (tx.direction === "debit" && tx.category === "debt_service") {
      if (!tx.facilityRef || !commitments.has(tx.facilityRef))
        issue(
          "UNRECONCILED_DEBT_SERVICE",
          "A bank repayment has no reviewed facility match. Reconcile it so existing debt is neither omitted nor counted twice.",
          tx.sourceId,
        );
      exclude("counted_in_commitment_register");
    } else {
      if (tx.direction === "credit")
        unknownInflows = sum([unknownInflows, tx.amountKobo]);
      exclude("not_eligible_recurring_income");
    }
  }
  const unknownBps = ratio(unknownInflows, grossInflows) ?? 0;
  if (unknownBps > policy.maxUnknownInflowBps)
    issue(
      "UNCLEAR_INCOME",
      "Too much incoming value is unclassified. Obtain evidence before scoring.",
    );
  // Monthly averages are kobo: divided exactly, down for income and up for spending, which must not be understated.
  const totalIncome = sum(income),
    sustainable = Math.min(
      median(income),
      multiplyDivideMoney(totalIncome, 1, periodCount),
    );
  if (sustainable === 0)
    issue(
      "NO_CONFIRMED_RECURRING_INCOME",
      "Enough recurring income could not be confirmed. This is an evidence gap, not an automatic decline.",
    );
  const verified = sum(
    [...commitments.values()]
      .filter((item) => item.evidence === "verified")
      .map((item) => item.monthlyKobo),
  );
  const declared = sum(
    [...commitments.values()]
      .filter((item) => item.evidence === "declared")
      .map((item) => item.monthlyKobo),
  );
  if (declared)
    issue(
      "DECLARED_COMMITMENTS",
      "Some existing commitments are applicant-declared, not independently verified; the calculations include them conservatively.",
      undefined,
      "warning",
    );
  const balanceDates = new Map<string, Map<string, number>>();
  for (const source of authorisedToInfer ? sources.values() : []) {
    const accountDates = new Set<string>();
    for (const observation of source.dailyBalances) {
      const date = stamp(observation.date),
        key = new Date(date + 3_600_000).toISOString().slice(0, 10);
      if (date < windowStart || date > asOf) continue;
      if (accountDates.has(key)) {
        issue(
          "AMBIGUOUS_BALANCE",
          "Supply one booked closing balance per account and date.",
          source.id,
        );
        continue;
      }
      accountDates.add(key);
      const accounts = balanceDates.get(key) ?? new Map<string, number>();
      accounts.set(source.accountId, observation.balanceKobo);
      balanceDates.set(key, accounts);
    }
  }
  const consolidatedBalances = [...balanceDates.values()]
    .filter((entries) =>
      input.requiredAccountIds.every((account) => entries.has(account)),
    )
    .map((entries) => sum([...entries.values()]));
  const liquidityBuffer =
    consolidatedBalances.length >= Math.min(30, policy.minHistoryDays)
      ? median(consolidatedBalances)
      : null;
  if (liquidityBuffer === null)
    issue(
      "LIQUIDITY_HISTORY_MISSING",
      "At least 30 aligned closing-balance observations are required; a current balance cannot establish a liquidity buffer.",
    );
  const observedEssential = Math.max(
    median(expenses),
    multiplyDivideMoney(sum(expenses), 1, periodCount, "ceil"),
  );
  const features: CreditFeatures = {
    codeVersion: "credit-features-synthetic-v1",
    currency: "NGN",
    periodDays: 30,
    periodCount,
    monthlyIncomeKobo: income,
    sustainableMonthlyIncomeKobo: sustainable,
    observedEssentialMonthlyKobo: observedEssential,
    essentialMonthlyKobo: Math.max(
      observedEssential,
      input.declaredEssentialMonthlyKobo,
    ),
    verifiedCommitmentsMonthlyKobo: verified,
    declaredCommitmentsMonthlyKobo: declared,
    totalCommitmentsMonthlyKobo: sum([verified, declared]),
    activeIncomePeriods: income.filter((value) => value > 0).length,
    incomeVolatilityBps: ratio(
      multiplyDivideMoney(
        sum(income.map((value) => Math.abs(value - sustainable))),
        1,
        periodCount,
      ),
      sustainable,
    ),
    largestPayerShareBps: ratio(Math.max(0, ...payers.values()), totalIncome),
    liquidityBufferKobo: liquidityBuffer,
    unknownInflowKobo: unknownInflows,
    unknownInflowBps: unknownBps,
    includedTransactionRefs: included,
    excludedTransactions: excluded,
    duplicatesIgnored,
  };
  const authorityBlocked = issues.some(
    (item) =>
      /^AUTHORITY_(?:REVOKED|EXPIRED|MISSING)/.test(item.code) ||
      ["SOURCE_NOT_AUTHORISED", "IDENTITY_UNCONFIRMED"].includes(item.code),
  );
  const usable = !issues.some((item) => item.severity === "blocking");
  let affordability: CreditAffordability | null = null,
    score: CreditAssessmentResult["score"] = null;
  const policyReasons: string[] = [];
  let recommendation: CreditAssessmentResult["policy"]["recommendation"] =
    "insufficient_evidence";
  if (usable) {
    const stressedIncome = mulDiv(
      sustainable,
      10_000 - policy.incomeStressBps,
      10_000,
    );
    const baselineResidual = sum([
      sustainable,
      -features.essentialMonthlyKobo,
      -features.totalCommitmentsMonthlyKobo,
      -policy.minimumResidualKobo,
    ]);
    const stressedResidual = sum([
      stressedIncome,
      -features.essentialMonthlyKobo,
      -features.totalCommitmentsMonthlyKobo,
      -policy.minimumResidualKobo,
    ]);
    const serviceCapacity = Math.max(
      0,
      mulDiv(stressedIncome, policy.maxDebtServiceBps, 10_000) -
        features.totalCommitmentsMonthlyKobo,
    );
    const capacity = Math.max(0, Math.min(stressedResidual, serviceCapacity));
    const peak = Math.max(...scheduleByMonth.values());
    affordability = {
      incomeStressBps: policy.incomeStressBps,
      stressedMonthlyIncomeKobo: stressedIncome,
      baselineResidualKobo: baselineResidual,
      stressedResidualKobo: stressedResidual,
      monthlyCapacityKobo: capacity,
      peakScheduledMonthlyKobo: peak,
      scheduledTotalKobo: scheduledTotal,
      requestedPrincipalKobo: input.requestedPrincipalKobo,
      indicativePrincipalCapacityKobo: Math.min(
        input.requestedPrincipalKobo,
        mulDiv(input.requestedPrincipalKobo, capacity, peak),
      ),
      termDays: Math.ceil(
        (Math.max(...input.repaymentSchedule.map((item) => stamp(item.dueAt))) -
          asOf) /
          DAY,
      ),
      debtServiceBps: ratio(
        sum([features.totalCommitmentsMonthlyKobo, peak]),
        stressedIncome,
      ),
      repaymentMonths: [...scheduleByMonth.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, amountKobo]) => ({
          month,
          amountKobo,
          stressedAfterPaymentKobo: sum([stressedResidual, -amountKobo]),
        })),
      scheduleAffordable: peak <= capacity,
    };
    const capacityRatio = ratio(capacity, peak) ?? 0;
    const liquidityRatio =
      ratio(
        Math.max(0, liquidityBuffer!),
        sum([
          features.essentialMonthlyKobo,
          features.totalCommitmentsMonthlyKobo,
          peak,
        ]),
      ) ?? 0;
    const factors: CreditScoreFactor[] = [
      {
        code: "income_regularity",
        label: "Income regularity",
        maximum: 25,
        points: mulDiv(features.activeIncomePeriods, 25, periodCount),
        reason: `Confirmed recurring income appears in ${features.activeIncomePeriods} of ${counted(periodCount, "observed 30-day period")}.`,
      },
      {
        code: "residual_capacity",
        label: "Stressed repayment capacity",
        maximum: 30,
        points:
          capacityRatio >= 15_000
            ? 30
            : capacityRatio >= 10_000
              ? 20
              : capacityRatio >= 5_000
                ? 10
                : 0,
        reason: `Capacity covers ${Math.floor(capacityRatio / 100)}% of the largest proposed monthly payment after the income stress and buffer.`,
      },
      {
        code: "liquidity_buffer",
        label: "Observed liquidity buffer",
        maximum: 15,
        points:
          liquidityRatio >= 20_000
            ? 15
            : liquidityRatio >= 10_000
              ? 10
              : liquidityRatio >= 5_000
                ? 5
                : 0,
        reason: `${counted(consolidatedBalances.length, "aligned booked closing balance supports", "aligned booked closing balances support")} the observed buffer.`,
      },
      {
        code: "commitment_behaviour",
        label: "Verified commitment behaviour",
        maximum: 20,
        points:
          input.repaymentHistory.missedPayments === 0
            ? 20
            : input.repaymentHistory.missedPayments === 1
              ? 10
              : 0,
        reason: `${counted(input.repaymentHistory.missedPayments, "missed repayment")} in the supplied verified history. This does not establish complete bureau coverage.`,
      },
      {
        code: "income_variability",
        label: "Income variability",
        maximum: 10,
        points:
          features.incomeVolatilityBps! <= 1000
            ? 10
            : features.incomeVolatilityBps! <= 3000
              ? 5
              : 0,
        reason: `Mean absolute income variation is ${Math.floor(features.incomeVolatilityBps! / 100)}% of the sustainable-income estimate; no seasonality claim is made.`,
      },
    ];
    const value = sum(factors.map((factor) => factor.points));
    score = {
      type: "rulecard",
      value,
      maximum: 100,
      band: value >= 80 ? "stronger" : value >= 60 ? "review" : "weaker",
      rulecardVersion: policy.rulecardVersion,
      factors,
      disclaimer:
        "Illustrative synthetic rule score. Not a probability of default or a lending decision.",
    };
    if (value < policy.minScore)
      policyReasons.push(
        `Rule score is below this illustrative policy's ${policy.minScore}-point threshold.`,
      );
    if (!affordability.scheduleAffordable)
      policyReasons.push(
        "The requested schedule exceeds stressed monthly capacity or the policy's debt-service limit.",
      );
    recommendation = policyReasons.length
      ? "policy_not_met"
      : "review_recommended";
    if (!policyReasons.length)
      policyReasons.push(
        "The illustrative checks support a lender review. No loan has been approved, amended or disbursed.",
      );
  } else
    policyReasons.push(
      "Resolve the evidence or authority issues before scoring or making a lending recommendation.",
    );
  const sourceDates = [...sources.values()]
    .map((source) => source.sourceAsOf)
    .sort();
  const inputSnapshot = {
    ...input,
    sources: [...input.sources].sort((a, b) => legacyCollatedCompare(a.id, b.id)),
    grants: [...input.grants].sort((a, b) => legacyCollatedCompare(a.id, b.id)),
    transactions: [...unique.values()].sort((a, b) =>
      legacyCollatedCompare(transactionRef(a), transactionRef(b)),
    ),
  };
  const snapshotHash = hash(inputSnapshot);
  const result: CreditAssessmentResult = {
    id: `credit-${hash({ tenant: input.tenantId, applicant: input.applicantId, application: input.applicationRef, version: input.version, snapshotHash }).slice(0, 32)}`,
    tenantId: input.tenantId,
    applicantId: input.applicantId,
    applicationRef: input.applicationRef,
    version: input.version,
    previousResultId: input.previousResultId ?? null,
    mode: "synthetic",
    createdAt: context.now,
    assessedAsOf: input.asOf,
    createdBy: context.actorId,
    state: authorityBlocked
      ? "blocked"
      : usable
        ? "review_pending"
        : "insufficient_evidence",
    evidence: {
      status: authorityBlocked
        ? "blocked"
        : usable
          ? "adequate"
          : "insufficient",
      issues,
      coverageDays,
      sourceCount: sources.size,
      latestSourceAsOf: sourceDates.at(-1) ?? null,
      earliestSourceAsOf: sourceDates[0] ?? null,
      reviewValidUntil: sourceDates[0]
        ? new Date(
            stamp(sourceDates[0]) + Math.min(7, policy.maxSourceAgeDays) * DAY,
          ).toISOString()
        : null,
      requiredAccountIds: [...input.requiredAccountIds],
      grantVersions: input.grants.map((grant) => ({
        id: grant.id,
        version: grant.version,
      })),
    },
    // Do not expose inferred features from an unauthorised or refused data purpose.
    features: authorisedToInfer ? features : null,
    score,
    affordability,
    policy: {
      id: policy.id,
      version: policy.version,
      recommendation,
      reasons: policyReasons,
    },
    snapshotHash,
    requiredReview: true,
    billable: false,
    restrictions: [
      "Synthetic data only; rulecard and policy are unvalidated.",
      "No probability of default or automated lending decision.",
      "An account connection or assessment never authorises a payment.",
      "Current permissions and evidence freshness must be rechecked before review.",
      "Indicative capacity scales the supplied schedule; it is not an offer or a substitute for a lender's cost and liability review.",
    ],
  };
  return freeze(result);
}

/** A separate immutable exercise record; cannot mutate the score or issue credit. */
export function reviewCreditAssessment(
  result: CreditAssessmentResult,
  input: CreditReviewInput,
  context: CreditContext,
): CreditReviewRecord {
  permission(context, "credit:review", result.tenantId);
  if (!context.mfaVerified)
    fail(
      "REVIEW_MFA_REQUIRED",
      "A fresh authenticated reviewer session is required.",
      403,
    );
  if (result.mode !== "synthetic")
    fail(
      "LIVE_CREDIT_DISABLED",
      "Real lending decisions are not available from this module.",
      403,
    );
  if (input.expectedAssessmentVersion !== result.version)
    fail(
      "STALE_ASSESSMENT_VERSION",
      "This assessment has changed. Refresh it before recording a review.",
      409,
    );
  if (
    !["approve", "amend_terms", "decline", "request_information"].includes(
      input.outcome,
    )
  )
    fail("INVALID_REVIEW_OUTCOME", "Choose a supported review outcome.");
  if (
    typeof input.rationale !== "string" ||
    typeof input.applicantExplanation !== "string" ||
    input.rationale.trim().length < 20 ||
    input.applicantExplanation.trim().length < 20 ||
    !input.reasonCodes?.length ||
    input.reasonCodes.some((code) => typeof code !== "string" || !code.trim())
  )
    fail(
      "REVIEW_REASON_REQUIRED",
      "Record a meaningful review rationale, applicant explanation and reason code.",
    );
  if (
    input.rationale.length > 4000 ||
    input.applicantExplanation.length > 4000 ||
    input.reasonCodes.length > 20
  )
    fail(
      "REVIEW_TOO_LARGE",
      "Keep the review within the supported text and reason limits.",
    );
  const now = stamp(context.now);
  if (now < stamp(result.createdAt))
    fail(
      "REVIEW_BEFORE_ASSESSMENT",
      "The review cannot predate its assessment.",
    );
  const currentIssues = grantIssues(
    input.currentGrants,
    result.evidence.requiredAccountIds,
    result.tenantId,
    result.applicantId,
    now,
  );
  if (currentIssues.length)
    fail(
      "REVIEW_AUTHORITY_UNAVAILABLE",
      "Current account and assessment permissions must be active before recording a review.",
      409,
    );
  for (const old of result.evidence.grantVersions) {
    const current = input.currentGrants.find((grant) => grant.id === old.id);
    if (!current || current.version !== old.version)
      fail(
        "ASSESSMENT_AUTHORITY_CHANGED",
        "Permission scope or version changed. Create a new assessment before using its result.",
        409,
      );
  }
  // Preserve a strict seven-day limit even if a caller supplies a stale retained snapshot.
  if (
    result.evidence.reviewValidUntil &&
    now > stamp(result.evidence.reviewValidUntil)
  )
    fail(
      "REVIEW_EVIDENCE_STALE",
      "Refresh the evidence and create a new assessment before review.",
      409,
    );
  if (
    input.outcome !== "request_information" &&
    (result.state !== "review_pending" ||
      !result.score ||
      !result.affordability)
  )
    fail(
      "ASSESSMENT_UNUSABLE",
      "Insufficient or blocked evidence cannot be turned into a lending outcome.",
      409,
    );
  const override =
    input.outcome === "approve" &&
    result.policy.recommendation === "policy_not_met";
  if (override && (input.overrideRationale?.trim().length ?? 0) < 30)
    fail(
      "OVERRIDE_RATIONALE_REQUIRED",
      "Explain the policy override and the additional evidence considered in at least 30 characters.",
    );
  if (input.outcome === "amend_terms")
    fail(
      "REASSESS_CHANGED_TERMS",
      "Create a new assessment with the amended repayment schedule before recording a review of those terms.",
      409,
    );
  const record: CreditReviewRecord = {
    id: `credit-review-${hash({ assessmentId: result.id, reviewer: context.actorId, reviewedAt: context.now, outcome: input.outcome, rationale: input.rationale.trim(), applicantExplanation: input.applicantExplanation.trim(), reasonCodes: input.reasonCodes, overrideRationale: input.overrideRationale?.trim() }).slice(0, 32)}`,
    assessmentId: result.id,
    assessmentVersion: result.version,
    tenantId: result.tenantId,
    applicantId: result.applicantId,
    reviewer: context.actorId,
    reviewedAt: context.now,
    outcome: input.outcome,
    rationale: input.rationale.trim(),
    applicantExplanation: input.applicantExplanation.trim(),
    reasonCodes: [...input.reasonCodes],
    override,
    overrideRationale: override ? input.overrideRationale!.trim() : null,
    mode: "synthetic",
    actualLendingDecision: false,
    fundsMoved: false,
  };
  return freeze(record);
}

/** Reversible alphabetic encoding keeps opaque ids distinct without resembling bank numbers. */
export function syntheticCreditAccountId(applicantId: string): string {
  const encoded = Buffer.from(applicantId, "utf8")
    .toString("hex")
    .replace(/[0-9a-f]/g, (digit) =>
      String.fromCharCode(97 + Number.parseInt(digit, 16)),
    );
  return `synthetic-account-${encoded}`;
}

/** Reproducible, clearly synthetic scenarios for the sandbox UI and integration tests. */
export function createSyntheticCreditInput(options: {
  tenantId: string;
  applicantId: string;
  applicationRef: string;
  now: string;
  scenario?: "ready" | "thin_file" | "stale" | "refused" | "high_commitments";
}): CreditAssessmentInput {
  const now = stamp(options.now),
    at = (days: number) => new Date(now + days * DAY).toISOString(),
    accountId = syntheticCreditAccountId(options.applicantId);
  const sourceId = `synthetic-source-${options.applicantId}`;
  const input: CreditAssessmentInput = {
    mode: "synthetic",
    tenantId: options.tenantId,
    applicantId: options.applicantId,
    applicationRef: options.applicationRef,
    version: 1,
    segment: "salaried",
    asOf: options.now,
    policy: { ...DEFAULT_SYNTHETIC_CREDIT_POLICY },
    requiredAccountIds: [accountId],
    grants: (["applicant_account_read", "credit_assessment"] as const).map(
      (purpose) => ({
        id: `${accountId}-${purpose}`,
        tenantId: options.tenantId,
        applicantId: options.applicantId,
        purpose,
        status: "active",
        accountIds: [accountId],
        validFrom: at(-120),
        expiresAt: at(30),
        version: 1,
      }),
    ),
    sources: [
      {
        id: sourceId,
        tenantId: options.tenantId,
        applicantId: options.applicantId,
        accountId,
        synthetic: true,
        accessMethod: "bank_authorised",
        identityVerified: true,
        currency: "NGN",
        acquiredAt: options.now,
        sourceAsOf: options.now,
        coverageStart: at(-90),
        coverageEnd: options.now,
        pagesComplete: true,
        missingDays: 0,
        contentHash: hash({ synthetic: true, accountId, now }),
        dailyBalances: Array.from({ length: 90 }, (_, index) => ({
          date: at(-89 + index),
          balanceKobo: 80_000_000,
        })),
      },
    ],
    transactions: Array.from({ length: 3 }, (_, index) => [
      {
        id: `synthetic-salary-${index}`,
        sourceId,
        accountId,
        bookedAt: at(-80 + 30 * index),
        amountKobo: 50_000_000,
        direction: "credit" as const,
        currency: "NGN" as const,
        status: "booked" as const,
        category: "salary" as const,
        classification: "confirmed" as const,
        payerRef: "synthetic-employer",
      },
      {
        id: `synthetic-living-${index}`,
        sourceId,
        accountId,
        bookedAt: at(-75 + 30 * index),
        amountKobo: 15_000_000,
        direction: "debit" as const,
        currency: "NGN" as const,
        status: "booked" as const,
        category: "essential_expense" as const,
        classification: "confirmed" as const,
      },
    ]).flat(),
    commitments: [
      {
        facilityRef: "synthetic-existing-facility",
        monthlyKobo: 3_000_000,
        evidence: "verified",
        sourceAsOf: options.now,
      },
    ],
    commitmentsReviewed: true,
    declaredEssentialMonthlyKobo: 15_000_000,
    essentialCostsReviewed: true,
    repaymentHistory: {
      known: true,
      missedPayments: 0,
      sourceAsOf: options.now,
    },
    requestedPrincipalKobo: 24_000_000,
    repaymentSchedule: [1, 2, 3].map((month) => ({
      dueAt: monthsAfter(options.now, month),
      amountKobo: 9_000_000,
    })),
  };
  if (options.scenario === "thin_file") {
    input.sources[0]!.coverageStart = at(-30);
    input.sources[0]!.dailyBalances =
      input.sources[0]!.dailyBalances.slice(-30);
  }
  if (options.scenario === "stale") {
    input.sources[0]!.sourceAsOf = at(-10);
    input.sources[0]!.coverageEnd = at(-10);
  }
  if (options.scenario === "refused") input.grants[1]!.status = "refused";
  if (options.scenario === "high_commitments")
    input.commitments[0]!.monthlyKobo = 18_000_000;
  return input;
}
