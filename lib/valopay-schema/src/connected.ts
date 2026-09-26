import { z } from "zod";
import { valopayRecordSchema } from "./api";

/**
 * The connected workspace (GET /v1/connected) and its actions, described
 * exactly: the API validates every answer with these before it is sent and the
 * console reads the answers through them, and the contract is generated from
 * them. The Credit Desk and Cash Desk documents mirror the TypeScript types in
 * artifacts/api-server/src/domain/connected-credit.ts and connected-cash.ts.
 */

const int = z.number().int();
const count = z.number().int().min(0);
const strings = z.array(z.string());

/** Purposes a synthetic connected-banking permission can be granted for. */
export const connectedConsentPurposes = ["account_read", "credit_assessment", "merchant_account_read", "erp_draft", "payroll_prepare"] as const;

/** A connected-workspace action: consent, payment, credit or cash, with its reason, action data and the revision of the workspace it was reviewed at. */
export const connectedActionInputSchema = z
  .object({
    action: z.string().min(1).max(80),
    recordId: z.string().max(100).optional(),
    reason: z.string().trim().min(8, "Explain the reason in at least eight characters.").max(500),
    data: z.record(z.string(), z.unknown()).default({}),
    expectedRevision: z.string().max(80),
  })
  .strict();
/** A validated connected-workspace action. */
export type ConnectedActionInput = z.infer<typeof connectedActionInputSchema>;

// ---- Credit Desk ----
const creditIssueSchema = z.object({ code: z.string(), message: z.string(), severity: z.enum(["blocking", "warning"]), sourceId: z.string().optional() }).strict();
const creditFeaturesSchema = z.object({
  codeVersion: z.literal("credit-features-synthetic-v1"), currency: z.literal("NGN"), periodDays: z.literal(30), periodCount: int,
  monthlyIncomeKobo: z.array(int), sustainableMonthlyIncomeKobo: int, observedEssentialMonthlyKobo: int, essentialMonthlyKobo: int,
  verifiedCommitmentsMonthlyKobo: int, declaredCommitmentsMonthlyKobo: int, totalCommitmentsMonthlyKobo: int, activeIncomePeriods: int,
  incomeVolatilityBps: int.nullable(), largestPayerShareBps: int.nullable(), liquidityBufferKobo: int.nullable(), unknownInflowKobo: int, unknownInflowBps: int,
  includedTransactionRefs: strings, excludedTransactions: z.array(z.object({ reference: z.string(), reason: z.string() }).strict()), duplicatesIgnored: int,
}).strict();
const creditAffordabilitySchema = z.object({
  incomeStressBps: int, stressedMonthlyIncomeKobo: int, baselineResidualKobo: int, stressedResidualKobo: int, monthlyCapacityKobo: int,
  peakScheduledMonthlyKobo: int, scheduledTotalKobo: int, requestedPrincipalKobo: int, indicativePrincipalCapacityKobo: int, termDays: int,
  debtServiceBps: int.nullable(), repaymentMonths: z.array(z.object({ month: z.string(), amountKobo: int, stressedAfterPaymentKobo: int }).strict()), scheduleAffordable: z.boolean(),
}).strict();
const creditScoreSchema = z.object({
  type: z.literal("rulecard"), value: int, maximum: z.literal(100), band: z.enum(["stronger", "review", "weaker"]), rulecardVersion: z.string(),
  factors: z.array(z.object({ code: z.string(), label: z.string(), points: int, maximum: int, reason: z.string() }).strict()), disclaimer: z.string(),
}).strict();
/** An illustrative synthetic assessment: its evidence, features, rule score, affordability and policy recommendation; never a lending decision. */
export const creditAssessmentResultSchema = z.object({
  id: z.string(), tenantId: z.string(), applicantId: z.string(), applicationRef: z.string(), version: int, previousResultId: z.string().nullable(),
  mode: z.literal("synthetic"), createdAt: z.string(), assessedAsOf: z.string(), createdBy: z.string(), state: z.enum(["review_pending", "insufficient_evidence", "blocked"]),
  evidence: z.object({
    status: z.enum(["adequate", "insufficient", "blocked"]), issues: z.array(creditIssueSchema), coverageDays: int, sourceCount: count,
    latestSourceAsOf: z.string().nullable(), earliestSourceAsOf: z.string().nullable(), reviewValidUntil: z.string().nullable(),
    requiredAccountIds: strings, grantVersions: z.array(z.object({ id: z.string(), version: int }).strict()),
  }).strict(),
  features: creditFeaturesSchema.nullable(), score: creditScoreSchema.nullable(), affordability: creditAffordabilitySchema.nullable(),
  policy: z.object({ id: z.string(), version: int, recommendation: z.enum(["review_recommended", "policy_not_met", "insufficient_evidence"]), reasons: strings }).strict(),
  snapshotHash: z.string(), requiredReview: z.literal(true), billable: z.literal(false), restrictions: strings,
}).strict();
/** A recorded sandbox review of one assessment version; never an actual lending decision. */
export const creditReviewViewSchema = z.object({
  id: z.string(), assessmentId: z.string(), assessmentVersion: int, tenantId: z.string(), applicantId: z.string(), reviewer: z.string(), reviewedAt: z.string(),
  outcome: z.enum(["approve", "amend_terms", "decline", "request_information"]), rationale: z.string(), applicantExplanation: z.string(), reasonCodes: strings,
  override: z.boolean(), overrideRationale: z.string().nullable(), mode: z.literal("synthetic"), actualLendingDecision: z.literal(false), fundsMoved: z.literal(false),
  authentication: z.literal("simulated_sandbox_review"),
}).strict();
/**
 * The Credit Desk: the current permissions of each applicant holding any (the
 * applicants are the workspace's customers, listed once in the connected view;
 * one not listed here holds neither), assessments with their reviews, the
 * illustrative rulecard and the closed credit gate.
 */
export const creditViewSchema = z.object({
  mode: z.literal("synthetic"), liveEnabled: z.literal(false), canAssess: z.boolean(), canReview: z.boolean(), actor: z.string(),
  permissions: z.array(z.object({ customerId: z.string(), accountRead: z.boolean(), creditAssessment: z.boolean() }).strict()),
  assessments: z.array(z.object({
    id: z.string(), customerId: z.string(), customerName: z.string(), scenario: z.string(), createdAt: z.string(), createdBy: z.string(),
    permissionRestricted: z.boolean(), result: creditAssessmentResultSchema, reviews: z.array(creditReviewViewSchema),
  }).strict()),
  scenarios: z.array(z.enum(["ready", "thin_file", "stale", "refused", "high_commitments"])),
  model: z.object({ name: z.string(), version: z.string(), status: z.string(), validation: z.string(), weights: z.array(z.object({ label: z.string(), maximum: int }).strict()) }).strict(),
  gate: z.object({ id: z.literal("G-CREDIT"), enabled: z.literal(false), requirements: strings }).strict(),
}).strict();

// ---- Cash Desk ----
const scope = { tenantId: z.string(), legalEntityId: z.string() };
const currencyScope = { ...scope, currency: z.string() };
const currencyScopeSchema = z.object(currencyScope).strict();
const cashAccountSchema = z.object({
  ...currencyScope, id: z.string(), name: z.string(), source: z.string(), sourceDefinition: z.string(), authorised: z.boolean(),
  bookedMinor: int, availableMinor: int.nullable(), pendingMinor: int.nullable(), balanceAsOf: z.string(), fetchedAt: z.string(), coverageComplete: z.boolean(),
}).strict();
const cashPositionSchema = z.object({
  currency: z.string(), bookedMinor: int, availableMinor: int.nullable(), pendingMinor: int.nullable(), incomeMinor: int, expenseMinor: int, accountCount: count,
  omittedAccountIds: strings, oldestBalanceAsOf: z.string().nullable(), latestFetchedAt: z.string().nullable(), qualified: z.boolean(), warnings: strings,
}).strict();
const cashCommitmentSchema = z.object({
  ...currencyScope, id: z.string(), label: z.string(), direction: z.enum(["inflow", "outflow"]), amountMinor: int, dueAt: z.string(), knownAt: z.string(),
  approved: z.boolean(), source: z.enum(["invoice", "bill", "payroll", "recurring_assumption"]), version: z.string(),
}).strict();
/** A base and downside cash forecast: a planning estimate, never an available balance. */
export const cashForecastSchema = z.object({
  ...currencyScope, asOf: z.string(), version: z.string(), inputHash: z.string(), status: z.enum(["planning_estimate", "unknown_opening_balance"]),
  openingMinor: int, persistenceBaselineMinor: int, planningBufferMinor: int,
  scenarios: z.array(z.object({
    name: z.enum(["base", "downside"]),
    points: z.array(z.object({ day: int, date: z.string(), inflowMinor: int, outflowMinor: int, closingMinor: int, afterPlanningBufferMinor: int, shortfallMinor: int }).strict()),
  }).strict()),
  includedCommitmentIds: strings, excludedCommitmentIds: strings, warnings: strings,
}).strict();
const erpAllocationSchema = z.object({ invoiceId: z.string(), invoiceVersion: z.string(), amountMinor: int }).strict();
const erpCreditNoteSchema = z.object({ id: z.string(), invoiceId: z.string(), amountMinor: int, approved: z.boolean(), version: z.string() }).strict();
const erpDraftSchema = z.object({
  kind: z.literal("erp_receipt_draft"),
  input: z.object({
    scope: currencyScopeSchema, maker: z.string(), postingDate: z.string(), canonicalReceiptId: z.string(), bankReference: z.string(),
    grossMinor: int, feeMinor: int, netMinor: int,
    mapping: z.object({
      ...currencyScope, companyId: z.string(), provider: z.enum(["xero", "odoo", "export"]), version: z.string(), active: z.boolean(), contactId: z.string(),
      bankLedgerCode: z.string(), revenueAccountCode: z.string(), feeAccountCode: z.string(), taxCode: z.string(), financeApproved: z.boolean(),
    }).strict(),
    invoices: z.array(z.object({ ...currencyScope, id: z.string(), companyId: z.string(), contactId: z.string(), version: z.string(), outstandingMinor: int, taxCode: z.string() }).strict()),
    allocations: z.array(erpAllocationSchema), creditNotes: z.array(erpCreditNoteSchema).optional(), source: z.enum(["bank_evidence", "synthetic"]),
    alreadyRecordedReceiptIds: strings.optional(), closedThrough: z.string().optional(),
  }).strict(),
  idempotencyKey: z.string(), requestHash: z.string(), status: z.enum(["proposed", "blocked", "already_recorded", "reviewed"]), reasons: strings,
  residuals: z.array(z.object({ invoiceId: z.string(), beforeMinor: int, paymentMinor: int, creditNoteMinor: int, afterMinor: int }).strict()),
  review: z.object({ reviewer: z.string(), approvedHash: z.string() }).strict().optional(), liveDispatchAllowed: z.literal(false),
}).strict();
/** A reviewed accounting export: what an ERP would receive, never posted by the service. */
export const erpManifestSchema = z.object({
  schema: z.literal("valo.erp.review-export.v1"), companyId: z.string(), invoiceAllocations: z.array(erpAllocationSchema), creditNotes: z.array(erpCreditNoteSchema).optional(),
  grossMinor: int, netMinor: int, feeMinor: int, mappingVersion: z.string(), requestHash: z.string(), reviewer: z.string(), status: z.literal("not_posted"),
  synthetic: z.literal(true), manifestHash: z.string(),
}).strict();
/** A VAT evidence review schedule: approved invoice tax reconciled to the ledger control; never a filed return or a payment. */
export const vatScheduleSchema = z.object({
  ...currencyScope, period: z.string(), configurationVersion: z.string(), outputVatMinor: int, eligibleInputVatMinor: int, blockedInputVatMinor: int,
  expectedClosingMinor: int, ledgerClosingMinor: int, varianceMinor: int, status: z.enum(["review_required", "reconciled_for_review"]),
  filingStatus: z.literal("not_submitted"), paymentStatus: z.literal("not_initiated"),
  lines: z.array(z.object({ invoiceId: z.string(), kind: z.enum(["sales_invoice", "sales_credit_note", "purchase_invoice", "purchase_credit_note"]), netMinor: int, vatMinor: int, taxCode: z.string(), paidMinor: int, evidenceComplete: z.boolean() }).strict()),
  missingEvidence: strings, excludedBankCreditsMinor: int, evidenceHash: z.string(),
}).strict();
const payrollItemStatuses = ["planned", "exported", "submitted", "succeeded", "failed", "unknown", "reversed"] as const;
/** A payroll funding plan from an approved net-pay run: maker, checker, funding state and each item's state; it never pays anyone. */
export const payrollPlanSchema = z.object({
  kind: z.literal("payroll_funding_plan"), scope: currencyScopeSchema, runId: z.string(), runVersion: z.string(), sourceHash: z.string(), maker: z.string(),
  sourceApprover: z.string(), sourceAccountId: z.string(), paymentDate: z.string(), asOf: z.string(), balanceAsOf: z.string(), reviewVersion: int,
  totalNetMinor: int, requiredMinor: int, availableMinor: int.nullable(), shortfallMinor: int.nullable(), commitmentsMinor: int, estimatedFeesMinor: int, bufferMinor: int,
  fundingStatus: z.enum(["ready_for_review", "shortfall", "unknown"]), approvalStatus: z.enum(["draft", "approved"]),
  items: z.array(z.object({
    id: z.string(), employeeReference: z.string(), beneficiaryReference: z.string(), beneficiaryVersion: z.string(), netMinor: int,
    status: z.enum(payrollItemStatuses), idempotencyKey: z.string(), evidenceReference: z.string().optional(),
  }).strict()),
  frozenHash: z.string(), checker: z.string().optional(), approvedHash: z.string().optional(),
  evidenceAuthority: z.object({ maker: z.string(), checker: z.string(), identityHash: z.string() }).strict().optional(), liveDispatchAllowed: z.literal(false),
}).strict();
/** An approved payroll bank export: the unsent items and their totals; it does not reserve funds or prove payment. */
export const payrollManifestSchema = z.object({
  scope: currencyScopeSchema, runId: z.string(), runVersion: z.string(), sourceAccountId: z.string(), paymentDate: z.string(), checker: z.string(), approvedHash: z.string(),
  itemCount: count, totalMinor: int,
  items: z.array(z.object({ id: z.string(), beneficiaryReference: z.string(), beneficiaryVersion: z.string(), netMinor: int, idempotencyKey: z.string() }).strict()),
  paymentStatus: z.literal("not_evidenced"), manifestHash: z.string(), warning: z.string(),
}).strict();
/** Whether a saved forecast or VAT schedule may be shown: `current` while the grants it was saved under are the current ones and the desk holds the evidence it was made from, `prepare_again` otherwise (its figures are withheld, and a new one is prepared under the current permission). */
const savedStateSchema = z.enum(["current", "prepare_again"]);
/** The Cash Desk: a separate sample SME's accounts, positions, commitments, forecast, accounting drafts, VAT schedules and payroll plans, as its permissions allow. */
export const cashViewSchema = z.object({
  initialised: z.boolean(), scope: currencyScopeSchema, name: z.string(), accounts: z.array(cashAccountSchema), positions: z.array(cashPositionSchema),
  commitments: z.array(cashCommitmentSchema),
  forecast: cashForecastSchema.nullable().describe("The latest saved forecast while it may be shown, a preview when none is saved, or null: without business-account read permission, or while the latest saved forecast must be prepared again."),
  savedForecast: z.object({ id: z.string(), createdAt: z.string(), state: savedStateSchema }).strict().nullable()
    .describe("The latest saved forecast, named with business-account read permission: current while the grants it was saved under are the current ones and the desk's opening balance and commitments are those it was made from, prepare_again otherwise, when its figures are withheld (forecast is null). Null when none is saved."),
  erpDrafts: z.array(z.object({ id: z.string(), status: z.string(), name: z.string(), createdAt: z.string(), draft: erpDraftSchema, manifest: erpManifestSchema.optional() }).strict()),
  vat: vatScheduleSchema.nullable(),
  vatExports: z.array(z.object({ id: z.string(), createdAt: z.string(), reviewer: z.string(), state: savedStateSchema, schedule: vatScheduleSchema.optional() }).strict())
    .describe("The saved VAT review schedules, listed with business-account read and accounting preparation permissions: each current, with its schedule, while the grants it was saved under are the current ones and the desk holds the invoices, bank allocations and ledger control it was made from; prepare_again otherwise, without its schedule."),
  payrollPlans: z.array(z.object({
    id: z.string(), status: z.string(), plan: payrollPlanSchema,
    summary: z.object({ itemCount: count, totalNetMinor: int, counts: z.object({ planned: count, exported: count, submitted: count, succeeded: count, failed: count, unknown: count, reversed: count }).strict(), status: z.enum(["completed", "partially_completed", "needs_reconciliation", "submitted", "exported_unpaid", "planning"]), liveDispatchAllowed: z.literal(false) }).strict(),
    manifest: payrollManifestSchema.optional(),
  }).strict()),
  payrollReconciliation: z.array(z.object({ id: z.string(), runId: z.string(), items: z.array(z.object({ id: z.string(), employeeReference: z.string(), netMinor: int, status: z.enum(payrollItemStatuses) }).strict()) }).strict()),
  permissions: z.object({ read: z.boolean(), erp: z.boolean(), payroll: z.boolean() }).strict(),
  limitations: strings,
}).strict();

// ---- The workspace and its actions ----
/** The connected workspace: granular consents, bound sample payment intents, the Credit and Cash Desks, and the live gates, every one closed. No read creates a record. */
export const connectedViewSchema = z.object({
  mode: z.literal("synthetic"), revision: z.string(), asOf: z.string(), role: z.string(),
  entity: z.object({ id: z.string(), name: z.string(), workspaceOwner: z.string() }).strict(),
  customers: z.array(z.object({ id: z.string(), name: z.string(), reference: z.string() }).strict()),
  consents: z.array(valopayRecordSchema.extend({ effectiveStatus: z.enum(["active", "revoked", "expired"]) }).strict()),
  purposes: z.array(z.object({ id: z.enum(connectedConsentPurposes), label: z.string() }).strict()),
  gates: z.array(z.object({ id: z.string(), name: z.string(), requires: z.string(), status: z.literal("not_enabled"), liveEnabled: z.literal(false) }).strict()),
  payments: z.object({
    intents: z.array(valopayRecordSchema),
    dues: z.array(z.object({ id: z.string(), name: z.string(), reference: z.string(), customerId: z.string(), customerName: z.string(), outstandingKobo: int, blocked: z.boolean() }).strict()),
  }).strict(),
  credit: creditViewSchema,
  cash: cashViewSchema,
}).strict();
/** The connected workspace as GET /v1/connected answers it. */
export type ConnectedView = z.infer<typeof connectedViewSchema>;
/** What a Cash Desk action did: its message, the record it saved or changed, and any export it prepared. */
export const cashActionOutcomeSchema = z.object({
  message: z.string(),
  record: valopayRecordSchema.optional(),
  data: z.object({
    manifest: z.union([erpManifestSchema, vatScheduleSchema, payrollManifestSchema]).optional(),
    synthetic: z.literal(true),
    externalInstructionPerformed: z.literal(false).optional(),
  }).strict(),
}).strict();
/**
 * A committed sample action: the record it produced (a Cash Desk action's
 * outcome, with its record inside); never an external instruction. The
 * contract's shape, which must accept either kind of answer because an answer
 * does not say which action it answers. To check one answer, choose its shape
 * by action with connectedActionResultFor.
 */
export const connectedActionResultSchema = z.object({
  message: z.string(),
  record: z.union([valopayRecordSchema, cashActionOutcomeSchema]),
  mode: z.literal("synthetic"),
  externalInstructionPerformed: z.literal(false),
}).strict();
/** A connected action's answer. */
export type ConnectedActionResult = z.infer<typeof connectedActionResultSchema>;

/** The record kind a connected action outside the Cash Desk answers with, from its prefix; undefined for an action the service does not know. */
function connectedRecordKind(action: string): string | undefined {
  if (action.startsWith("consent.")) return "connected-consents";
  if (action.startsWith("payment.")) return "connected-intents";
  if (action === "credit.review") return "connected-credit-reviews";
  if (action.startsWith("credit.")) return "connected-credit-assessments";
  return undefined;
}
/** The export each Cash Desk export action prepares and answers inside its outcome. */
const cashExports: Record<string, z.ZodTypeAny> = { "cash.erp.export": erpManifestSchema, "cash.vat.export": vatScheduleSchema, "cash.payroll.export": payrollManifestSchema };

/**
 * A connected action's answer in the one shape its action gives. The service
 * checks every answer with it before the answer is sent (and a stored receipt
 * before it is replayed), and the console before an answer counts as a
 * confirmation. The general schema cannot tell the two kinds of answer apart:
 * a bare outcome ({ message, data: { synthetic: true } }) would pass for a
 * consent, checkout or credit answer, and a malformed record could pass as an
 * outcome carrying extra keys. Chosen by action, a cash.* action answers its
 * outcome, with the Cash Desk record it saved or changed (absent only when
 * cash.initialize finds the Cash Desk already set up) and, for an export, the
 * manifest it prepared; every other action answers the record it produced or
 * changed, of the kind its prefix names: a consent, a checkout, an assessment
 * or a review. With merchantId, every record must belong to that lender.
 */
export function connectedActionResultFor(action: string, merchantId?: string): z.ZodType<ConnectedActionResult> {
  const cash = action.startsWith("cash."), kind = cash ? undefined : connectedRecordKind(action);
  const record = valopayRecordSchema.superRefine((value, context) => {
    if (merchantId !== undefined && value.merchantId !== merchantId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["merchantId"], message: "The record belongs to another lender." });
    if (cash ? !value.kind.startsWith("connected-cash-") : kind !== undefined && value.kind !== kind) context.addIssue({ code: z.ZodIssueCode.custom, path: ["kind"], message: `This action answers with ${cash ? "a Cash Desk record" : `a ${kind} record`}.` });
  });
  if (!cash) return z.object({ message: z.string(), record, mode: z.literal("synthetic"), externalInstructionPerformed: z.literal(false) }).strict();
  const manifest = cashExports[action];
  const data = z.object({ synthetic: z.literal(true), externalInstructionPerformed: z.literal(false).optional() }).strict();
  const outcome = z.object({
    message: z.string(),
    record: action === "cash.initialize" ? record.optional() : record,
    data: manifest ? data.extend({ manifest }) : data,
  }).strict();
  return z.object({ message: z.string(), record: outcome, mode: z.literal("synthetic"), externalInstructionPerformed: z.literal(false) }).strict();
}
