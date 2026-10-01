import { z } from "zod";
import {
  assessCredit,
  createSyntheticCreditInput,
  monthsAfter,
  reviewCreditAssessment,
  syntheticCreditAccountId,
  type CreditAssessmentResult,
  type CreditContext,
  type CreditGrant,
  type CreditReviewRecord,
} from "./connected-credit";
import { makeRecord } from "./records";
import { notFound, onlyRoles } from "../lib/refusal-words";
import { permissionActive } from "./connected-permission-validity";
import type { Context, DomainState, ValopayRecord } from "./types";

const scenarios = [
  "ready",
  "thin_file",
  "stale",
  "refused",
  "high_commitments",
] as const;
const assessorRoles = ["Admin", "Operations"];
const reviewerRoles = ["Admin", "Finance", "Compliance reviewer"];
const reject = (message: string, status = 400): never => {
  throw Object.assign(new Error(message), { status });
};
const own = (state: DomainState, kind: string) =>
  state.records.filter(
    (record) => record.merchantId === state.merchant.id && record.kind === kind,
  );
const assessor = (ctx: Context) => assessorRoles.includes(ctx.role);
const reviewer = (ctx: Context) => reviewerRoles.includes(ctx.role);
function context(state: DomainState, ctx: Context): CreditContext {
  return {
    tenantId: state.merchant.id,
    actorId: ctx.actor,
    now: ctx.now,
    permissions: [
      ...(assessor(ctx) ? ["credit:assess" as const] : []),
      ...(reviewer(ctx) ? ["credit:review" as const] : []),
    ],
    // Explicit simulation only. No production authentication assertion is made.
    mfaVerified:
      state.settings.environment === "sandbox" &&
      ctx.actor.startsWith("Sandbox "),
  };
}
/** Each applicant's latest account-read and credit-assessment consent by purpose, from one pass over the records. */
type GrantIndex = Map<unknown, Map<string, ValopayRecord>>;
function grantIndex(state: DomainState): GrantIndex {
  const index: GrantIndex = new Map();
  for (const consent of own(state, "connected-consents")) {
    if (
      consent.data.entityId !== state.merchant.id ||
      !["account_read", "credit_assessment"].includes(consent.data.purpose)
    )
      continue;
    const latest = index.get(consent.data.subjectId) ?? new Map();
    latest.set(consent.data.purpose, consent);
    index.set(consent.data.subjectId, latest);
  }
  return index;
}
function currentGrants(
  state: DomainState,
  customerId: string,
  grants = grantIndex(state),
): CreditGrant[] {
  return [...(grants.get(customerId)?.values() ?? [])].map((consent) => ({
    id: consent.id,
    tenantId: state.merchant.id,
    applicantId: customerId,
    purpose:
      consent.data.purpose === "account_read"
        ? "applicant_account_read"
        : "credit_assessment",
    status: ["active", "refused", "revoked", "expired", "suspended"].includes(
      consent.status,
    )
      ? (consent.status as CreditGrant["status"])
      : "suspended",
    accountIds: [syntheticCreditAccountId(customerId)],
    validFrom: String(consent.data.validFrom ?? consent.createdAt),
    expiresAt: String(consent.data.expiresAt),
    version: typeof consent.data.version === "number" ? consent.data.version : Number.NaN,
  }));
}
function permissionsAvailable(
  state: DomainState,
  customerId: string,
  now: string,
  index = grantIndex(state),
) {
  const grants = currentGrants(state, customerId, index);
  const active = (purpose: CreditGrant["purpose"]) =>
    grants.some((grant) => grant.purpose === purpose && permissionActive(grant, now));
  return {
    accountRead: active("applicant_account_read"),
    creditAssessment: active("credit_assessment"),
  };
}
export function creditView(state: DomainState, ctx: Context) {
  // Built once for the view: the consents by applicant, the names and the reviews by assessment.
  const grants = grantIndex(state);
  const customers = own(state, "customers");
  const names = new Map<string, string>();
  for (const customer of customers)
    if (!names.has(customer.id)) names.set(customer.id, customer.name);
  const reviewsOf = new Map<unknown, ValopayRecord[]>();
  for (const review of own(state, "connected-credit-reviews")) {
    const list = reviewsOf.get(review.data.assessmentRecordId) ?? [];
    list.push(review);
    reviewsOf.set(review.data.assessmentRecordId, list);
  }
  // The workspace lists every customer once; the desk adds the permissions of those holding any.
  const permissions = customers.flatMap((customer) => {
    const held = permissionsAvailable(state, customer.id, ctx.now, grants);
    return held.accountRead || held.creditAssessment
      ? [{ customerId: customer.id, ...held }]
      : [];
  });
  const assessments = own(state, "connected-credit-assessments")
    .map((record) => {
      const result = record.data.result as CreditAssessmentResult;
      const permissions = permissionsAvailable(
        state,
        record.customerId,
        ctx.now,
        grants,
      );
      const current = currentGrants(state, record.customerId, grants);
      const authorityUnchanged = result.evidence.grantVersions.every((grant) =>
        current.some(
          (item) => item.id === grant.id && item.version === grant.version,
        ),
      );
      const permissionRestricted =
        !permissions.accountRead ||
        !permissions.creditAssessment ||
        !authorityUnchanged;
      // Retain the historical audit snapshot while preventing a revoked score from
      // remaining usable or visible as a current assessment in the ordinary desk.
      const visibleResult = permissionRestricted
        ? {
            ...result,
            features: null,
            score: null,
            affordability: null,
            state: "blocked" as const,
            policy: {
              ...result.policy,
              recommendation: "insufficient_evidence" as const,
              reasons: [
                "A permission has changed or ended. Grant both permissions again, then run a new assessment.",
              ],
            },
            evidence: {
              ...result.evidence,
              status: "blocked" as const,
              issues: [
                ...result.evidence.issues,
                {
                  code: "CURRENT_AUTHORITY_UNAVAILABLE",
                  message:
                    "A permission has changed or ended since this assessment was run.",
                  severity: "blocking" as const,
                },
              ],
            },
          }
        : result;
      return {
        id: record.id,
        customerId: record.customerId,
        customerName: names.get(record.customerId) ?? "Sample applicant",
        scenario: String(record.data.scenario),
        createdAt: record.createdAt,
        createdBy: String(record.data.createdBy),
        permissionRestricted,
        result: visibleResult,
        reviews: (reviewsOf.get(record.id) ?? []).map((review) => ({
          ...(review.data.review as CreditReviewRecord),
          id: review.id,
          authentication: "simulated_sandbox_review" as const,
        })),
      };
    })
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) ||
        b.result.version - a.result.version,
    );
  return {
    mode: "synthetic" as const,
    liveEnabled: false,
    canAssess: assessor(ctx),
    canReview: reviewer(ctx),
    actor: ctx.actor,
    permissions,
    assessments,
    scenarios,
    model: {
      name: "Sample scoring rules for salaried applicants",
      version: "illustrative-rulecard-v1",
      status: "Sample data only",
      validation: "Not validated for real lending",
      weights: [
        { label: "Regular income", maximum: 25 },
        { label: "Room to repay if income falls", maximum: 30 },
        { label: "Typical account balance", maximum: 15 },
        { label: "Repayment history", maximum: 20 },
        { label: "How much income changes", maximum: 10 },
      ],
    },
    gate: {
      id: "G-CREDIT",
      enabled: false,
      requirements: [
        "Approved ways to get bank data, and safeguards for real data",
        "A lending policy the lender approved, and scoring rules checked by an independent party",
        "Results from a trial run next to real decisions, and reviewers who make real lending decisions",
      ],
    },
  };
}

export function runCreditAction(
  state: DomainState,
  ctx: Context,
  input: {
    action: string;
    recordId?: string;
    reason: string;
    data: Record<string, unknown>;
  },
): ValopayRecord {
  if (
    state.settings.environment !== "sandbox" ||
    !ctx.actor.startsWith("Sandbox ")
  )
    reject("Credit Desk is not available in a pilot yet.", 403);
  if (
    typeof input.reason !== "string" ||
    input.reason.trim().length < 8 ||
    input.reason.length > 500
  )
    reject("Enter a reason of 8 to 500 characters. It is saved in the audit log.");
  if (input.action === "credit.assess") {
    if (!assessor(ctx))
      reject(onlyRoles(assessorRoles, "run an assessment", ctx.accessMode), 403);
    const data = z
      .object({
        customerId: z.string().min(1).max(100),
        scenario: z.enum(scenarios).default("ready"),
        principalKobo: z
          .number()
          .int()
          .positive()
          .safe()
          .max(100_000_000_000)
          .optional(),
        repaymentKobo: z
          .number()
          .int()
          .positive()
          .safe()
          .max(100_000_000_000)
          .optional(),
        termMonths: z.number().int().min(1).max(24).optional(),
      })
      .strict()
      .parse(input.data);
    const customer =
      own(state, "customers").find((record) => record.id === data.customerId) ??
      reject("Choose an applicant from this lender’s customers.", 404);
    const previous = own(state, "connected-credit-assessments")
      .filter((record) => record.customerId === customer.id)
      .sort(
        (a, b) => Number(b.data.result.version) - Number(a.data.result.version),
      )[0];
    const assessment = createSyntheticCreditInput({
      tenantId: state.merchant.id,
      applicantId: customer.id,
      applicationRef: `SYN-APPLICATION-${customer.reference}`,
      now: ctx.now,
      scenario: data.scenario,
    });
    assessment.grants = currentGrants(state, customer.id);
    if (data.scenario === "refused")
      assessment.grants = assessment.grants.map((grant) =>
        grant.purpose === "credit_assessment"
          ? { ...grant, status: "refused" }
          : grant,
      );
    if (previous) {
      assessment.version = Number(previous.data.result.version) + 1;
      assessment.previousResultId = String(previous.data.result.id);
    }
    if (
      data.principalKobo !== undefined ||
      data.repaymentKobo !== undefined ||
      data.termMonths !== undefined
    ) {
      if (
        data.principalKobo === undefined ||
        data.repaymentKobo === undefined ||
        data.termMonths === undefined
      )
        reject("Enter the loan amount, the monthly repayment and the number of repayments together.");
      assessment.requestedPrincipalKobo = data.principalKobo!;
      // One repayment a calendar month, not every 30 days, which would put two in some months.
      assessment.repaymentSchedule = Array.from(
        { length: data.termMonths! },
        (_, index) => ({
          dueAt: monthsAfter(ctx.now, index + 1),
          amountKobo: data.repaymentKobo!,
        }),
      );
    }
    const result = assessCredit(assessment, context(state, ctx));
    return makeRecord(state, "connected-credit-assessments", {
      name: `${customer.name} · assessment ${result.version}`,
      customerId: customer.id,
      status: result.state,
      reference: result.id,
      createdAt: ctx.now,
      amountKobo: assessment.requestedPrincipalKobo,
      data: {
        result,
        scenario: data.scenario,
        createdBy: ctx.actor,
        reason: input.reason,
        rulesStatus: "synthetic_unvalidated",
        scheduleSource: "synthetic_lender_schedule",
      },
    });
  }
  if (input.action === "credit.review") {
    if (!reviewer(ctx))
      reject(onlyRoles(reviewerRoles, "review an assessment", ctx.accessMode), 403);
    const record =
      own(state, "connected-credit-assessments").find(
        (item) => item.id === input.recordId,
      ) ?? reject(notFound("Assessment"), 404);
    if (record.data.createdBy === ctx.actor)
      reject(
        "A different person must review this assessment. Change your demo role in Settings, then review it.",
        403,
      );
    if (
      own(state, "connected-credit-reviews").some(
        (review) => review.data.assessmentRecordId === record.id,
      )
    )
      reject(
        "This assessment already has a review, and a review cannot be changed. Run a new assessment to review again.",
        409,
      );
    const latest = own(state, "connected-credit-assessments")
      .filter((item) => item.customerId === record.customerId)
      .sort(
        (a, b) => Number(b.data.result.version) - Number(a.data.result.version),
      )[0];
    if (latest?.id !== record.id)
      reject("A newer assessment exists. Review the latest version.", 409);
    const data = z
      .object({
        expectedAssessmentVersion: z.number().int().positive(),
        outcome: z.enum(["approve", "decline", "request_information"]),
        rationale: z.string().trim().min(20).max(4000),
        applicantExplanation: z.string().trim().min(20).max(4000),
        reasonCodes: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
        overrideRationale: z.string().trim().max(4000).optional(),
      })
      .strict()
      .parse(input.data);
    const review = reviewCreditAssessment(
      record.data.result as CreditAssessmentResult,
      { ...data, currentGrants: currentGrants(state, record.customerId) },
      context(state, ctx),
    );
    return makeRecord(state, "connected-credit-reviews", {
      name: `${record.name} · review`,
      customerId: record.customerId,
      status: "recorded",
      reference: review.id,
      createdAt: ctx.now,
      data: {
        assessmentRecordId: record.id,
        review,
        authentication: "simulated_sandbox_review",
        reason: input.reason,
      },
    });
  }
  return reject("This Credit Desk action is not available.");
}
