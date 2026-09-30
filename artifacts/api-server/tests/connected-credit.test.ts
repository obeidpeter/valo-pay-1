import assert from "node:assert/strict";
import {
  assessCredit,
  createSyntheticCreditInput,
  CreditDomainError,
  reviewCreditAssessment,
  syntheticCreditAccountId,
  type CreditAssessmentInput,
  type CreditContext,
  type CreditReviewInput,
} from "../src/domain/connected-credit.js";
import {
  creditView,
  runCreditAction,
} from "../src/domain/connected-credit-service.js";
import { assertNoRealBankDetails, makeRecord } from "../src/domain/records.js";
import type { Context, DomainState } from "../src/domain/types.js";

const now = "2026-09-21T10:00:00.000Z";
const ctx: CreditContext = {
  tenantId: "lender-a",
  actorId: "Sandbox Operations",
  permissions: ["credit:assess"],
  now,
};
const reviewer: CreditContext = {
  ...ctx,
  actorId: "Sandbox Finance",
  permissions: ["credit:review"],
  mfaVerified: true,
};
const fixture = (
  scenario?: Parameters<typeof createSyntheticCreditInput>[0]["scenario"],
) =>
  createSyntheticCreditInput({
    tenantId: ctx.tenantId,
    applicantId: "applicant-a",
    applicationRef: "synthetic-application-a",
    now,
    scenario,
  });
let checks = 0;
function test(name: string, run: () => void) {
  run();
  checks++;
  console.log(`PASS ${name}`);
}
function blocked(input: CreditAssessmentInput, code: string) {
  const result = assessCredit(input, ctx);
  assert.equal(result.score, null);
  assert.equal(result.policy.recommendation, "insufficient_evidence");
  assert.ok(
    result.evidence.issues.some((issue) => issue.code === code),
    JSON.stringify(result.evidence.issues),
  );
}
function rejects(run: () => unknown, code: string) {
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof CreditDomainError && error.code === code,
  );
}
const baseline = assessCredit(fixture(), ctx);
const reviewInput = (input = fixture()): CreditReviewInput => ({
  expectedAssessmentVersion: 1,
  outcome: "approve",
  rationale: "Reviewed the synthetic source and all calculation explanations.",
  applicantExplanation:
    "The supplied synthetic evidence supports this exercise outcome.",
  reasonCodes: ["synthetic_evidence_reviewed"],
  currentGrants: input.grants,
});

test("known synthetic cash flows produce independent exact arithmetic", () => {
  assert.equal(baseline.features?.sustainableMonthlyIncomeKobo, 50_000_000);
  assert.equal(baseline.affordability?.stressedMonthlyIncomeKobo, 40_000_000);
  assert.equal(baseline.affordability?.baselineResidualKobo, 27_000_000);
  assert.equal(baseline.affordability?.stressedResidualKobo, 17_000_000);
  assert.equal(baseline.affordability?.monthlyCapacityKobo, 13_000_000);
  assert.equal(baseline.affordability?.scheduledTotalKobo, 27_000_000);
  assert.equal(
    baseline.affordability?.indicativePrincipalCapacityKobo,
    24_000_000,
  );
  assert.equal(baseline.score?.value, 90);
  assert.equal(
    baseline.score?.factors.reduce((total, factor) => total + factor.points, 0),
    90,
  );
  assert.equal(baseline.policy.recommendation, "review_recommended");
});
test("deterministic snapshots, immutable factors, input left untouched", () => {
  const input = fixture(),
    before = structuredClone(input),
    result = assessCredit(input, ctx);
  assert.deepEqual(result, baseline);
  assert.deepEqual(input, before);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.score?.factors));
  assert.throws(() => {
    result.score!.value = 1;
  }, TypeError);
});
test("no PD, no live decision, no fee", () => {
  assert.equal("probability" in baseline, false);
  assert.equal("probability" in baseline.score!, false);
  assert.equal(baseline.billable, false);
  assert.equal(baseline.requiredReview, true);
});
test("insufficient history has no artificial low score", () =>
  blocked(fixture("thin_file"), "SHORT_HISTORY"));
test("stale source must refresh", () =>
  blocked(fixture("stale"), "STALE_SOURCE"));
test("optional refusal has no score and no inferred features", () => {
  const result = assessCredit(fixture("refused"), ctx);
  assert.equal(result.score, null);
  assert.equal(result.features, null);
  assert.equal(result.state, "insufficient_evidence");
});
test("permission revocation prevents inference", () => {
  const input = fixture();
  input.grants[1]!.status = "revoked";
  const result = assessCredit(input, ctx);
  assert.equal(result.state, "blocked");
  assert.equal(result.features, null);
  assert.equal(result.score, null);
});
test("expired grants fail even if marked active", () => {
  const input = fixture();
  input.grants[0]!.expiresAt = now;
  blocked(input, "AUTHORITY_EXPIRED");
});
test("account-read never substitutes credit purpose", () => {
  const input = fixture();
  input.grants = input.grants.slice(0, 1);
  blocked(input, "AUTHORITY_MISSING");
});
test("only a refused permission says a refusal is not a credit-risk penalty", () => {
  const penalty = "Refusal is not a credit-risk penalty.";
  const said = (input: CreditAssessmentInput, code: string) =>
    assessCredit(input, ctx).evidence.issues.find((issue) => issue.code === code)?.message ?? "";
  const refused = said(fixture("refused"), "AUTHORITY_REFUSED");
  assert.ok(refused.includes(penalty), refused);
  const expired = fixture();
  expired.grants[0]!.expiresAt = now;
  const missing = fixture();
  missing.grants = missing.grants.slice(0, 1);
  for (const [input, code] of [[expired, "AUTHORITY_EXPIRED"], [missing, "AUTHORITY_MISSING"]] as const) {
    const message = said(input, code);
    assert.ok(message, `${code} has a message`);
    assert.ok(!message.includes(penalty), message);
  }
});
test("same-tenant applicant binding is enforced", () => {
  const input = fixture();
  input.grants[1]!.applicantId = "other";
  rejects(() => assessCredit(input, ctx), "GRANT_SCOPE_MISMATCH");
});
test("tenant permission binding is enforced", () =>
  rejects(
    () => assessCredit(fixture(), { ...ctx, tenantId: "other" }),
    "CREDIT_FORBIDDEN",
  ));
test("assessor cannot use reviewer permission", () =>
  rejects(() => assessCredit(fixture(), reviewer), "CREDIT_FORBIDDEN"));
test("source identity binding is enforced", () => {
  const input = fixture();
  input.sources[0]!.tenantId = "other";
  rejects(() => assessCredit(input, ctx), "SOURCE_SCOPE_MISMATCH");
});
test("unrequested source cannot leak into assessment", () => {
  const input = fixture();
  input.sources[0]!.accountId = "unrequested";
  rejects(() => assessCredit(input, ctx), "SOURCE_OUTSIDE_PURPOSE");
});
test("transaction cannot name a different account", () => {
  const input = fixture();
  input.transactions[0]!.accountId = "other";
  rejects(() => assessCredit(input, ctx), "TRANSACTION_SCOPE_MISMATCH");
});
test("credential aggregation stays disabled", () => {
  const input = fixture();
  input.sources[0]!.accessMethod = "credential_aggregation";
  blocked(input, "SOURCE_NOT_AUTHORISED");
  assert.equal(assessCredit(input, ctx).features, null);
});
test("unverified account ownership has no score", () => {
  const input = fixture();
  input.sources[0]!.identityVerified = false;
  blocked(input, "IDENTITY_UNCONFIRMED");
});
test("gaps and incomplete pagination cannot imply zero activity", () => {
  const input = fixture();
  input.sources[0]!.pagesComplete = false;
  blocked(input, "HISTORY_GAPS");
});
test("missing required account blocks score", () => {
  const input = fixture();
  input.sources = [];
  input.transactions = [];
  blocked(input, "MISSING_SOURCE");
});
test("exact duplicate provider evidence counts once", () => {
  const input = fixture();
  input.transactions.push(structuredClone(input.transactions[0]!));
  const result = assessCredit(input, ctx);
  assert.equal(result.features?.duplicatesIgnored, 1);
  assert.equal(
    result.features?.sustainableMonthlyIncomeKobo,
    baseline.features?.sustainableMonthlyIncomeKobo,
  );
  assert.equal(result.id, baseline.id);
});
test("conflicting duplicate cannot silently win", () => {
  const input = fixture();
  input.transactions.push({
    ...input.transactions[0]!,
    amountKobo: 100_000_000,
  });
  blocked(input, "CONFLICTING_DUPLICATE");
});
test("same amount different real reference remains independent", () => {
  const input = fixture();
  input.transactions.push({
    ...input.transactions[0]!,
    id: "distinct-receipt",
  });
  const result = assessCredit(input, ctx);
  assert.equal(result.features?.duplicatesIgnored, 0);
  assert.equal(result.features?.monthlyIncomeKobo[0], 100_000_000);
});
for (const category of ["loan_proceeds", "refund", "asset_sale"] as const)
  test(`${category} never inflates income`, () => {
    const input = fixture();
    input.transactions.push({
      ...input.transactions[0]!,
      id: category,
      category,
      amountKobo: 300_000_000,
    });
    const result = assessCredit(input, ctx);
    assert.equal(result.features?.sustainableMonthlyIncomeKobo, 50_000_000);
    assert.ok(
      result.features?.excludedTransactions.some(
        (item) => item.reason === "non_recurring_income",
      ),
    );
  });
test("unmatched own transfer excluded as uncertain", () => {
  const input = fixture();
  input.transactions.push({
    ...input.transactions[0]!,
    id: "own",
    category: "own_transfer",
    amountKobo: 1_000_000,
  });
  const result = assessCredit(input, ctx);
  assert.equal(result.features?.sustainableMonthlyIncomeKobo, 50_000_000);
  assert.equal(result.features?.unknownInflowKobo, 1_000_000);
});
test("future transaction cannot leak into predictors", () => {
  const input = fixture();
  input.transactions.push({
    ...input.transactions[0]!,
    id: "future",
    amountKobo: 800_000_000,
    bookedAt: "2026-10-01T10:00:00.000Z",
  });
  const result = assessCredit(input, ctx);
  assert.equal(result.features?.sustainableMonthlyIncomeKobo, 50_000_000);
  assert.equal(result.score?.value, baseline.score?.value);
});
test("future source vintage cannot masquerade as historical evidence", () => {
  const input = fixture();
  input.sources[0]!.sourceAsOf = "2026-09-22T10:00:00.000Z";
  blocked(input, "EVIDENCE_AFTER_CUTOFF");
});
test("large unexplained inflows require evidence, not a score", () => {
  const input = fixture();
  input.transactions.push({
    ...input.transactions[0]!,
    id: "unknown",
    category: "unknown",
    amountKobo: 100_000_000,
  });
  blocked(input, "UNCLEAR_INCOME");
});
test("pending and reversed funds excluded", () => {
  const input = fixture();
  input.transactions.push(
    { ...input.transactions[0]!, id: "pending", status: "pending" },
    { ...input.transactions[0]!, id: "reversed", status: "reversed" },
  );
  assert.equal(
    assessCredit(input, ctx).features?.sustainableMonthlyIncomeKobo,
    50_000_000,
  );
});
test("unreviewed obligations and costs cannot become zero", () => {
  const input = fixture();
  input.commitmentsReviewed = false;
  blocked(input, "COMMITMENTS_INCOMPLETE");
  input.commitmentsReviewed = true;
  input.essentialCostsReviewed = false;
  blocked(input, "ESSENTIAL_COSTS_INCOMPLETE");
});
test("unverified behaviour never silently reweights the score", () => {
  const input = fixture();
  input.repaymentHistory.known = false;
  blocked(input, "REPAYMENT_HISTORY_UNKNOWN");
});
test("duplicate verified/declared facility counted once", () => {
  const input = fixture();
  input.commitments.push({ ...input.commitments[0]!, evidence: "declared" });
  assert.equal(
    assessCredit(input, ctx).features?.totalCommitmentsMonthlyKobo,
    3_000_000,
  );
});
test("conflicting facility amounts require reconciliation", () => {
  const input = fixture();
  input.commitments.push({ ...input.commitments[0]!, monthlyKobo: 4_000_000 });
  blocked(input, "CONFLICTING_COMMITMENT");
});
test("unknown bank debt cannot be omitted", () => {
  const input = fixture();
  input.transactions.push({
    ...input.transactions[1]!,
    id: "unknown-debt",
    category: "debt_service",
    facilityRef: "unknown-facility",
  });
  blocked(input, "UNRECONCILED_DEBT_SERVICE");
});
test("current balance alone is not a reliable liquidity feature", () => {
  const input = fixture();
  input.sources[0]!.dailyBalances = input.sources[0]!.dailyBalances.slice(-1);
  blocked(input, "LIQUIDITY_HISTORY_MISSING");
});
test("high score cannot bypass independent affordability policy", () => {
  const result = assessCredit(fixture("high_commitments"), ctx);
  assert.ok(result.score!.value >= 65);
  assert.equal(result.policy.recommendation, "policy_not_met");
  assert.equal(result.affordability?.monthlyCapacityKobo, 0);
});
test("actual calendar-month schedule sums obligations", () => {
  const input = fixture();
  input.repaymentSchedule[1]!.dueAt = input.repaymentSchedule[0]!.dueAt;
  const result = assessCredit(input, ctx);
  assert.equal(result.affordability?.peakScheduledMonthlyKobo, 18_000_000);
  assert.equal(result.policy.recommendation, "policy_not_met");
  assert.equal(
    result.affordability?.indicativePrincipalCapacityKobo,
    17_333_333,
  );
});
test("missing charges/principal schedule rejected", () => {
  const input = fixture();
  input.repaymentSchedule = input.repaymentSchedule.slice(0, 1);
  rejects(() => assessCredit(input, ctx), "INCOMPLETE_REPAYMENT_SCHEDULE");
});
test("zero repayment and fractional money rejected", () => {
  const input = fixture();
  input.repaymentSchedule[0]!.amountKobo = 0;
  rejects(() => assessCredit(input, ctx), "INVALID_AMOUNT");
  input.repaymentSchedule[0]!.amountKobo = 9_000_000;
  input.transactions[0]!.amountKobo = 5.5;
  rejects(() => assessCredit(input, ctx), "INVALID_AMOUNT");
});
test("monthly averages of large amounts are exact whole kobo", () => {
  // Three 30-day periods at the top of the range: sustainable income rounds down and observed spending rounds up.
  const input = fixture(), large = 3_002_399_751_580_329;
  [large, large, large + 2].forEach((amount, period) => { input.transactions[period * 2]!.amountKobo = amount; });
  [15_000_000, 15_000_000, 15_000_001].forEach((amount, period) => { input.transactions[period * 2 + 1]!.amountKobo = amount; });
  const features = assessCredit(input, ctx).features!;
  assert.equal(features.periodCount, 3);
  assert.equal(features.sustainableMonthlyIncomeKobo, Number((3n * BigInt(large) + 2n) / 3n));
  assert.equal(features.observedEssentialMonthlyKobo, 15_000_001);
  assert.equal(features.incomeVolatilityBps, 0);
});
test("overflow fails instead of silently rounding kobo", () => {
  const input = fixture();
  input.transactions[0]!.amountKobo = Number.MAX_SAFE_INTEGER;
  input.transactions[2]!.amountKobo = Number.MAX_SAFE_INTEGER;
  rejects(() => assessCredit(input, ctx), "INVALID_AMOUNT");
});
test("invalid calendar date rejected", () => {
  const input = fixture();
  input.asOf = "2026-02-30T10:00:00.000Z";
  rejects(() => assessCredit(input, ctx), "INVALID_DATE");
});
test("real data mode rejected even if called directly", () => {
  const input = fixture();
  (input as { mode: string }).mode = "live";
  rejects(() => assessCredit(input, ctx), "LIVE_CREDIT_DISABLED");
});
test("reassessment creates linked immutable version", () => {
  const input = fixture();
  input.version = 2;
  input.previousResultId = baseline.id;
  const result = assessCredit(input, ctx);
  assert.notEqual(result.id, baseline.id);
  assert.equal(result.previousResultId, baseline.id);
  assert.equal(baseline.version, 1);
});
test("reviewer records separate synthetic outcome", () => {
  const record = reviewCreditAssessment(baseline, reviewInput(), reviewer);
  assert.equal(record.assessmentId, baseline.id);
  assert.equal(record.actualLendingDecision, false);
  assert.equal(record.fundsMoved, false);
  assert.ok(Object.isFrozen(record));
  assert.equal(baseline.policy.recommendation, "review_recommended");
});
test("assessor cannot record review", () =>
  rejects(
    () =>
      reviewCreditAssessment(baseline, reviewInput(), {
        ...ctx,
        mfaVerified: true,
      }),
    "CREDIT_FORBIDDEN",
  ));
test("reviewer session guard applies", () =>
  rejects(
    () =>
      reviewCreditAssessment(baseline, reviewInput(), {
        ...reviewer,
        mfaVerified: false,
      }),
    "REVIEW_MFA_REQUIRED",
  ));
test("stale review version rejected", () =>
  rejects(
    () =>
      reviewCreditAssessment(
        baseline,
        { ...reviewInput(), expectedAssessmentVersion: 2 },
        reviewer,
      ),
    "STALE_ASSESSMENT_VERSION",
  ));
test("revocation between score and review stops use", () => {
  const input = reviewInput();
  input.currentGrants[1]!.status = "revoked";
  rejects(
    () => reviewCreditAssessment(baseline, input, reviewer),
    "REVIEW_AUTHORITY_UNAVAILABLE",
  );
});
test("changed grant versions require reassessment", () => {
  const input = reviewInput();
  input.currentGrants[1]!.version = 2;
  rejects(
    () => reviewCreditAssessment(baseline, input, reviewer),
    "ASSESSMENT_AUTHORITY_CHANGED",
  );
});
test("expired evidence rejected at review time", () =>
  rejects(
    () =>
      reviewCreditAssessment(baseline, reviewInput(), {
        ...reviewer,
        now: "2026-09-29T10:00:00.000Z",
      }),
    "REVIEW_EVIDENCE_STALE",
  ));
test("meaningful rationale and applicant explanation required", () =>
  rejects(
    () =>
      reviewCreditAssessment(
        baseline,
        { ...reviewInput(), rationale: "ok" },
        reviewer,
      ),
    "REVIEW_REASON_REQUIRED",
  ));
test("policy override must explain new evidence", () => {
  const result = assessCredit(fixture("high_commitments"), ctx);
  rejects(
    () => reviewCreditAssessment(result, reviewInput(), reviewer),
    "OVERRIDE_RATIONALE_REQUIRED",
  );
  const review = reviewCreditAssessment(
    result,
    {
      ...reviewInput(),
      overrideRationale:
        "The synthetic reviewer documented verified additional income evidence for this exercise.",
    },
    reviewer,
  );
  assert.equal(review.override, true);
  assert.equal(result.policy.recommendation, "policy_not_met");
});
test("changed terms require new affordability assessment", () =>
  rejects(
    () =>
      reviewCreditAssessment(
        baseline,
        { ...reviewInput(), outcome: "amend_terms" },
        reviewer,
      ),
    "REASSESS_CHANGED_TERMS",
  ));
test("insufficient evidence cannot become an approval", () => {
  const input = fixture("thin_file");
  rejects(
    () =>
      reviewCreditAssessment(
        assessCredit(input, ctx),
        reviewInput(input),
        reviewer,
      ),
    "ASSESSMENT_UNUSABLE",
  );
});
test("stricter policy source age survives into later review", () => {
  const input = fixture();
  input.policy.maxSourceAgeDays = 1;
  rejects(
    () =>
      reviewCreditAssessment(assessCredit(input, ctx), reviewInput(input), {
        ...reviewer,
        now: "2026-09-23T10:00:00.000Z",
      }),
    "REVIEW_EVIDENCE_STALE",
  );
});
test("both own-transfer legs exclude income without counting unknown", () => {
  const input = fixture(),
    otherAccount = "synthetic-other",
    otherSource = "synthetic-other-source";
  input.requiredAccountIds.push(otherAccount);
  input.grants.forEach((grant) => grant.accountIds.push(otherAccount));
  input.sources.push({
    ...structuredClone(input.sources[0]!),
    id: otherSource,
    accountId: otherAccount,
  });
  input.transactions.push(
    {
      ...input.transactions[0]!,
      id: "transfer-in",
      category: "own_transfer",
      amountKobo: 30_000_000,
      transferPairRef: "owned-transfer",
    },
    {
      ...input.transactions[0]!,
      sourceId: otherSource,
      accountId: otherAccount,
      id: "transfer-out",
      direction: "debit",
      category: "own_transfer",
      amountKobo: 30_000_000,
      transferPairRef: "owned-transfer",
    },
  );
  const result = assessCredit(input, ctx);
  assert.equal(result.features?.sustainableMonthlyIncomeKobo, 50_000_000);
  assert.equal(result.features?.unknownInflowKobo, 0);
  assert.equal(
    result.features?.excludedTransactions.filter(
      (item) => item.reason === "matched_own_account_transfer",
    ).length,
    2,
  );
});
test("segment policy mismatch never borrows salaried score", () => {
  const input = fixture();
  input.segment = "microbusiness";
  blocked(input, "SEGMENT_NOT_VALIDATED");
});

function serviceFixture(customerId = "customer-a", at = now) {
  const state: DomainState = {
    merchant: {
      id: "lender-a",
      name: "Synthetic Lender",
      shortName: "SYN",
      segment: "lender",
      mode: "observation",
      status: "active",
      provider: "synthetic",
      monthlyVolume: 0,
      killSwitch: false,
      preDataReady: false,
      preLiveReady: false,
    },
    settings: { environment: "sandbox" },
    records: [],
  };
  const customer = makeRecord(state, "customers", {
    id: customerId,
    name: "Synthetic Applicant",
    reference: "SYN-APPLICANT",
    status: "active",
    createdAt: at,
  });
  for (const purpose of ["account_read", "credit_assessment"])
    makeRecord(state, "connected-consents", {
      name: purpose,
      status: "active",
      createdAt: at,
      data: {
        purpose,
        subjectId: customer.id,
        entityId: state.merchant.id,
        expiresAt: new Date(Date.parse(at) + 30 * 86_400_000).toISOString(),
        version: 1,
      },
    });
  return {
    state,
    customer,
    operator: {
      actor: "Sandbox Operations",
      role: "Operations",
      now: at,
    } as Context,
    finance: { actor: "Sandbox Finance", role: "Finance", now: at } as Context,
  };
}
const assessAction = {
  action: "credit.assess",
  reason: "Test the synthetic credit workflow",
  data: { customerId: "customer-a", scenario: "ready" },
};
test("numeric UUIDs keep synthetic account identities distinct and pass the unchanged privacy guard", () => {
  const applicantId = "12345678-1234-4123-8123-123456789012";
  const input = createSyntheticCreditInput({
    tenantId: ctx.tenantId,
    applicantId,
    applicationRef: "SYN-NUMERIC-ID",
    now,
  });
  assert.doesNotThrow(() => assertNoRealBankDetails(input));
  assert.equal(input.requiredAccountIds[0], syntheticCreditAccountId(applicantId));
  assert.notEqual(syntheticCreditAccountId(applicantId), syntheticCreditAccountId(applicantId.replace(/2$/, "3")));
  assert.notEqual(syntheticCreditAccountId("customer-1"), syntheticCreditAccountId("customer-b"));
  assert.throws(() => assertNoRealBankDetails({ accountId: "1234567890" }), /Raw financial identifiers/);
  for (const withPermission of [true, false]) {
    const { state, operator, finance } = serviceFixture(applicantId);
    if (!withPermission)
      state.records = state.records.filter((record) => record.kind !== "connected-consents");
    const record = runCreditAction(state, operator, {
      ...assessAction,
      data: { ...assessAction.data, customerId: applicantId },
    });
    assert.equal(record.data.result.state, withPermission ? "review_pending" : "blocked");
    assert.doesNotThrow(() => assertNoRealBankDetails(record));
    if (withPermission) {
      const { currentGrants: _, ...data } = reviewInput();
      assert.doesNotThrow(() => runCreditAction(state, finance, {
        action: "credit.review", recordId: record.id,
        reason: "Review numeric UUID synthetic provenance", data,
      }));
    }
  }
});
test("service uses sandbox environment, not instruction mode", () => {
  const { state, operator } = serviceFixture();
  const record = runCreditAction(state, operator, assessAction);
  assert.equal(record.kind, "connected-credit-assessments");
  assert.equal(record.data.result.state, "review_pending");
  assert.equal(state.merchant.mode, "observation");
});
test("service cannot run outside sandbox or with actual actor", () => {
  const { state, operator } = serviceFixture();
  state.settings.environment = "live";
  assert.throws(
    () => runCreditAction(state, operator, assessAction),
    /not available in a pilot yet/,
  );
  state.settings.environment = "sandbox";
  assert.throws(
    () =>
      runCreditAction(
        state,
        { ...operator, actor: "actual-user" },
        assessAction,
      ),
    /not available in a pilot yet/,
  );
});
test("service binds customer to tenant and rejects unexpected request fields", () => {
  const { state, operator } = serviceFixture();
  assert.throws(
    () =>
      runCreditAction(state, operator, {
        ...assessAction,
        data: { customerId: "not-in-this-tenant" },
      }),
    /Choose an applicant from this lender/,
  );
  assert.throws(
    () =>
      runCreditAction(state, operator, {
        ...assessAction,
        data: { ...assessAction.data, score: 100 },
      }),
    /Unrecognized/,
  );
});
test("service requires actual consent records and preserves missing state", () => {
  const { state, operator } = serviceFixture();
  state.records = state.records.filter(
    (record) => record.kind !== "connected-consents",
  );
  const record = runCreditAction(state, operator, assessAction);
  assert.equal(record.data.result.state, "blocked");
  assert.equal(record.data.result.score, null);
});
test("revocation hides retained score without mutating audit snapshot", () => {
  const { state, operator } = serviceFixture();
  const record = runCreditAction(state, operator, assessAction);
  const snapshot = JSON.stringify(record);
  state.records.find((item) => item.kind === "connected-consents")!.status =
    "revoked";
  const view = creditView(state, operator);
  assert.equal(view.assessments[0]!.result.score, null);
  assert.equal(view.assessments[0]!.permissionRestricted, true);
  assert.equal(JSON.stringify(record), snapshot);
});
test("a stored future permission start blocks credit inference despite an earlier creation time", () => {
  const { state, operator } = serviceFixture();
  state.records.find((record) => record.kind === "connected-consents")!.data.validFrom =
    "2026-09-22T10:00:00.000Z";
  const record = runCreditAction(state, operator, assessAction);
  assert.equal(record.data.result.state, "blocked");
  assert.equal(record.data.result.score, null);
  assert.equal(record.data.result.features, null);
});
test("a changed permission start withholds retained credit results and refuses review", () => {
  const { state, operator, finance } = serviceFixture();
  const assessment = runCreditAction(state, operator, assessAction);
  const snapshot = JSON.stringify(assessment);
  state.records.find((record) => record.kind === "connected-consents")!.data.validFrom =
    "2026-09-22T10:00:00.000Z";
  const view = creditView(state, operator);
  assert.equal(view.permissions[0]!.accountRead, false);
  assert.equal(view.assessments[0]!.permissionRestricted, true);
  assert.equal(view.assessments[0]!.result.score, null);
  assert.equal(JSON.stringify(assessment), snapshot);
  const { currentGrants: _, ...data } = reviewInput();
  rejects(() => runCreditAction(state, finance, {
    action: "credit.review", recordId: assessment.id,
    reason: "Review the original synthetic assessment", data,
  }), "REVIEW_AUTHORITY_UNAVAILABLE");
});
test("invalid current permission versions are withheld by the credit read model", () => {
  const { state, operator } = serviceFixture();
  runCreditAction(state, operator, assessAction);
  state.records.find((record) => record.kind === "connected-consents")!.data.version = 0;
  const view = creditView(state, operator);
  assert.equal(view.permissions[0]!.accountRead, false);
  assert.equal(view.assessments[0]!.permissionRestricted, true);
});
test("service review is append-only and role-distinct", () => {
  const { state, operator, finance } = serviceFixture();
  const assessment = runCreditAction(state, operator, assessAction);
  const data = { ...reviewInput(), currentGrants: undefined };
  delete (data as Partial<CreditReviewInput>).currentGrants;
  const action = {
    action: "credit.review",
    recordId: assessment.id,
    reason: "Reviewed the supplied synthetic evidence",
    data,
  };
  assert.throws(
    () => runCreditAction(state, { ...operator, role: "Admin" }, action),
    /A different person must review this assessment/,
  );
  const before = JSON.stringify(assessment),
    record = runCreditAction(state, finance, action);
  assert.equal(record.kind, "connected-credit-reviews");
  assert.equal(record.data.review.actualLendingDecision, false);
  assert.equal(JSON.stringify(assessment), before);
  assert.throws(() => runCreditAction(state, finance, action), /already has/);
});
test("service cannot review a superseded assessment", () => {
  const { state, operator, finance } = serviceFixture();
  const first = runCreditAction(state, operator, assessAction);
  const second = runCreditAction(state, operator, {
    ...assessAction,
    data: { ...assessAction.data, scenario: "high_commitments" },
  });
  assert.equal(second.data.result.version, 2);
  assert.equal(second.data.result.previousResultId, first.data.result.id);
  const { currentGrants: _, ...data } = reviewInput();
  assert.throws(
    () =>
      runCreditAction(state, finance, {
        action: "credit.review",
        recordId: first.id,
        reason: "Review the original synthetic evidence",
        data,
      }),
    /newer assessment/,
  );
});
test("service accepts complete explicit schedule but rejects partial terms", () => {
  const { state, operator } = serviceFixture();
  assert.throws(
    () =>
      runCreditAction(state, operator, {
        ...assessAction,
        data: { ...assessAction.data, principalKobo: 5_000_000 },
      }),
    /together/,
  );
  const record = runCreditAction(state, operator, {
    ...assessAction,
    data: {
      ...assessAction.data,
      principalKobo: 20_000_000,
      repaymentKobo: 8_000_000,
      termMonths: 3,
    },
  });
  assert.equal(record.data.result.affordability.scheduledTotalKobo, 24_000_000);
});
test("a synthetic schedule falls due once a calendar month in West Africa Time, so no month carries two repayments", () => {
  const assess = (at: string, repaymentKobo: number, termMonths: number) => {
    const { state, operator } = serviceFixture("customer-a", at);
    const affordability = runCreditAction(state, operator, {
      ...assessAction,
      data: { ...assessAction.data, principalKobo: repaymentKobo, repaymentKobo, termMonths },
    }).data.result.affordability;
    return {
      peak: affordability.peakScheduledMonthlyKobo,
      termDays: affordability.termDays,
      months: affordability.repaymentMonths.map((item: { month: string; amountKobo: number }) => `${item.month}:${item.amountKobo}`),
    };
  };
  // From 09:00 WAT on 1 January 2027, 30-day steps put two repayments in May and none in February.
  const year = assess("2027-01-01T08:00:00.000Z", 5_500_000, 12);
  assert.deepEqual(year.months, ["2027-02", "2027-03", "2027-04", "2027-05", "2027-06", "2027-07", "2027-08", "2027-09", "2027-10", "2027-11", "2027-12", "2028-01"].map((month) => `${month}:5500000`));
  assert.equal(year.peak, 5_500_000, "the peak month is one instalment");
  // From 00:30 WAT on 31 January (still 30 January in UTC), each repayment is on the WAT month's last day when it has no 31st.
  const monthEnd = assess("2027-01-30T23:30:00.000Z", 8_000_000, 3);
  assert.deepEqual(monthEnd.months, ["2027-02:8000000", "2027-03:8000000", "2027-04:8000000"]);
  assert.equal(monthEnd.termDays, 89, "the last repayment is at 00:30 WAT on 30 April");
  // The longest term, 24 months, may span 29 February and still fits the two-year horizon.
  const longest = assess("2027-03-01T08:00:00.000Z", 1_000_000, 24);
  assert.equal(longest.months.length, 24);
  assert.equal(longest.termDays, 731);
  // The sample schedule an assessment uses without explicit terms steps by calendar month too: from 30 January, February, March and April.
  const sampleAt = "2027-01-30T10:00:00.000Z";
  const sample = assessCredit(
    createSyntheticCreditInput({ tenantId: ctx.tenantId, applicantId: "applicant-a", applicationRef: "synthetic-application-a", now: sampleAt }),
    { ...ctx, now: sampleAt },
  ).affordability!;
  assert.deepEqual(sample.repaymentMonths.map((item) => item.month), ["2027-02", "2027-03", "2027-04"]);
  assert.equal(sample.peakScheduledMonthlyKobo, 9_000_000);
});
console.log(`Connected Credit: ${checks} scenarios passed.`);
