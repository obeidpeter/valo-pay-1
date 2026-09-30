import { notFound, onlyRoles } from "../lib/refusal-words";
import { purposeLabels } from "./connected-consents";
import { watMonth } from "./calendar";
import { makeRecord, touch } from "./records";
import { permissionActive } from "./connected-permission-validity";
import type {
  ActionResult,
  Context,
  DomainState,
  ValopayRecord,
} from "./types";
import {
  approvePayrollPlan,
  buildErpDraft,
  cashEvidenceHash,
  consolidateCashPositions,
  exportPayrollManifest,
  forecastCash,
  guardErpDispatch,
  payrollPlanSummary,
  preparePayrollFundingPlan,
  refreshPayrollFundingPlan,
  reconcileVatEvidence,
  reviewErpDraft,
  transitionPayrollItem,
  vatEvidenceHash,
  type CashAccount,
  type CashCommitment,
  type CashObservation,
  type CurrencyScope,
  type ErpDraft,
  type ErpDraftInput,
  type PayrollPlan,
  type PayrollRun,
  type VatBankAllocation,
  type VatControlInput,
  type VatInvoiceEvidence,
} from "./connected-cash";

const DAY = 86_400_000;
const entityScope = (state: DomainState): CurrencyScope => ({
  tenantId: state.merchant.id,
  legalEntityId: `${state.merchant.id}:sme`,
  currency: "NGN",
});
type Purpose = "merchant_account_read" | "erp_draft" | "payroll_prepare";
type AuthoritySnapshot = Array<{
  purpose: Purpose;
  id: string;
  version: number;
  hash: string;
}>;
const erpPurposes: Purpose[] = ["merchant_account_read", "erp_draft"];
const payrollPurposes: Purpose[] = ["merchant_account_read", "payroll_prepare"];
/** The grants a saved view or schedule is bound to when it is saved (replayAuthority): business-account read, and
 * accounting preparation for a VAT schedule. ERP drafts and payroll plans bind their own preparation and review. */
const savedPurposes: Record<string, Purpose[]> = {
  "connected-cash-workspace": ["merchant_account_read"],
  "connected-cash-forecasts": ["merchant_account_read"],
  "connected-cash-vat": erpPurposes,
};
/** Whether a Cash Desk record is bound, when saved, to the grants it was made under (savedCashDisclosable). */
export const boundWhenSaved = (kind: string): boolean =>
  Object.hasOwn(savedPurposes, kind);
/** Bind a review to the exact current scoped grants, not merely to another grant
 * with the same purpose. Unknown dates, versions and overlapping grants fail closed. */
function authoritySnapshot(
  state: DomainState,
  purposes: Purpose[],
  now: string,
): AuthoritySnapshot | undefined {
  const at = Date.parse(now);
  if (!Number.isFinite(at)) return undefined;
  const snapshot: AuthoritySnapshot = [];
  for (const purpose of purposes) {
    const grants = state.records.filter(
      (r) =>
        r.merchantId === state.merchant.id &&
        r.kind === "connected-consents" &&
        r.data.purpose === purpose &&
        r.data.subjectId === "sme" &&
        r.data.entityId === entityScope(state).legalEntityId &&
        permissionActive({
          status: r.status,
          validFrom: r.data.validFrom ?? r.createdAt,
          expiresAt: r.data.expiresAt,
          version: r.data.version,
        }, now),
    );
    if (grants.length !== 1) return undefined;
    const grant = grants[0]!;
    snapshot.push({
      purpose,
      id: grant.id,
      version: Number(grant.data.version),
      hash: cashEvidenceHash({
        merchantId: grant.merchantId,
        createdAt: grant.createdAt,
        data: grant.data,
      }),
    });
  }
  return snapshot;
}
function authorityCurrent(
  state: DomainState,
  saved: unknown,
  purposes: Purpose[],
  now: string,
): boolean {
  const current = authoritySnapshot(state, purposes, now);
  return (
    Array.isArray(saved) &&
    !!current &&
    cashEvidenceHash(saved) === cashEvidenceHash(current)
  );
}
function requireBoundAuthority(
  state: DomainState,
  record: ValopayRecord,
  key: "preparationAuthority" | "reviewAuthority",
  purposes: Purpose[],
  now: string,
): void {
  if (key === "reviewAuthority" && !record.data[key])
    throw refusal(
      "Finance must approve this before the export file can be prepared.",
      409,
    );
  if (!authorityCurrent(state, record.data[key], purposes, now))
    throw refusal(
      "The permission used for this review changed or expired. Refresh the review, then ask Finance to approve it again.",
      409,
    );
}
function permission(
  state: DomainState,
  purpose: Purpose,
  now: string,
): boolean {
  return !!authoritySnapshot(state, [purpose], now);
}
/** A refusal the HTTP layer answers with its own status; a plain error would read as a 400. */
const refusal = (message: string, status: number): Error =>
  Object.assign(new Error(message), { status });
function requirePermission(
  state: DomainState,
  purpose: Purpose,
  now: string,
): void {
  if (!permission(state, purpose, now))
    throw refusal(
      `Grant the ‘${purposeLabels[purpose]}’ permission in Permissions and readiness, then try again.`,
      403,
    );
}
function ownRecords(state: DomainState, kind: string): ValopayRecord[] {
  return state.records.filter(
    (r) =>
      r.merchantId === state.merchant.id &&
      r.kind === kind &&
      r.data.entityId === entityScope(state).legalEntityId,
  );
}
function ownRecord(
  state: DomainState,
  kind: string,
  id?: string,
): ValopayRecord {
  const record = ownRecords(state, kind).find((r) => r.id === id);
  if (!record) throw refusal(notFound("Cash Desk record"), 404);
  return record;
}
/** Refuses a role the action does not allow: "Only an Admin or Operations can set up Cash Desk." */
function requireRole(ctx: Context, roles: string[], action: string): void {
  if (!roles.includes(ctx.role))
    throw refusal(onlyRoles(roles, action, ctx.accessMode), 403);
}
function minor(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Enter a whole number of 0 or more.");
  return value;
}
function stored(state: DomainState) {
  return ownRecords(state, "connected-cash-workspace")[0];
}
function sample(state: DomainState, now: string) {
  const scope = entityScope(state);
  const future = (days: number) =>
    new Date(Date.parse(now) + days * DAY).toISOString();
  const accounts: CashAccount[] = [
    {
      ...scope,
      id: "sample-operating",
      name: "Operating account · •• 1024",
      source: "Sample bank statement",
      sourceDefinition: "Bank-reported booked and available balance",
      authorised: true,
      bookedMinor: 1_850_000_000,
      availableMinor: 1_790_000_000,
      pendingMinor: -60_000_000,
      balanceAsOf: now,
      fetchedAt: now,
      coverageComplete: true,
    },
    {
      ...scope,
      id: "sample-reserve",
      name: "Reserve account · •• 2086",
      source: "Sample bank statement",
      sourceDefinition: "Bank-reported booked and available balance",
      authorised: true,
      bookedMinor: 630_000_000,
      availableMinor: 630_000_000,
      pendingMinor: 0,
      balanceAsOf: now,
      fetchedAt: now,
      coverageComplete: true,
    },
  ];
  const commitments: CashCommitment[] = [
    {
      ...scope,
      id: "sample-invoice",
      label: "Customer invoice receipts",
      direction: "inflow",
      amountMinor: 840_000_000,
      dueAt: future(5),
      knownAt: now,
      approved: true,
      source: "invoice",
      version: "1",
    },
    {
      ...scope,
      id: "sample-supplier",
      label: "Approved supplier bills",
      direction: "outflow",
      amountMinor: 660_000_000,
      dueAt: future(6),
      knownAt: now,
      approved: true,
      source: "bill",
      version: "1",
    },
    {
      ...scope,
      id: "sample-payroll",
      label: "Approved net-pay run",
      direction: "outflow",
      amountMinor: 360_000_000,
      dueAt: future(7),
      knownAt: now,
      approved: true,
      source: "payroll",
      version: "1",
    },
    {
      ...scope,
      id: "sample-month-end",
      label: "Month-end invoice receipts",
      direction: "inflow",
      amountMinor: 1_040_000_000,
      dueAt: future(24),
      knownAt: now,
      approved: true,
      source: "invoice",
      version: "1",
    },
    {
      ...scope,
      id: "sample-rent",
      label: "Rent and utilities assumption",
      direction: "outflow",
      amountMinor: 290_000_000,
      dueAt: future(21),
      knownAt: now,
      approved: true,
      source: "recurring_assumption",
      version: "1",
    },
  ];
  const observations: CashObservation[] = [
    {
      ...scope,
      id: "sample-transfer-out",
      sourceReference: "sample-transfer-out",
      accountId: accounts[0]!.id,
      amountMinor: -200_000_000,
      status: "booked",
      occurredAt: now,
      observedAt: now,
      internalTransferId: "sample-own-transfer",
    },
    {
      ...scope,
      id: "sample-transfer-in",
      sourceReference: "sample-transfer-in",
      accountId: accounts[1]!.id,
      amountMinor: 200_000_000,
      status: "booked",
      occurredAt: now,
      observedAt: now,
      internalTransferId: "sample-own-transfer",
    },
  ];
  const erpInput: ErpDraftInput = {
    scope,
    maker: "not yet prepared",
    postingDate: now,
    canonicalReceiptId: "sample-erp-receipt",
    bankReference: "SAMPLE-BANK-RECEIPT",
    grossMinor: 1_075_000,
    feeMinor: 5_000,
    netMinor: 1_070_000,
    mapping: {
      ...scope,
      companyId: "sample-xero-company",
      provider: "xero",
      version: "finance-mapping-v1",
      active: true,
      contactId: "sample-contact",
      bankLedgerCode: "090",
      revenueAccountCode: "200",
      feeAccountCode: "404",
      taxCode: "SAMPLE-APPROVED-VAT",
      financeApproved: true,
    },
    invoices: [
      {
        ...scope,
        id: "INV-SAMPLE-204",
        companyId: "sample-xero-company",
        contactId: "sample-contact",
        version: "1",
        outstandingMinor: 1_500_000,
        taxCode: "SAMPLE-APPROVED-VAT",
      },
    ],
    allocations: [
      {
        invoiceId: "INV-SAMPLE-204",
        invoiceVersion: "1",
        amountMinor: 1_075_000,
      },
    ],
    creditNotes: [
      {
        id: "CN-SAMPLE-12",
        invoiceId: "INV-SAMPLE-204",
        amountMinor: 100_000,
        approved: true,
        version: "1",
      },
    ],
    source: "synthetic",
  };
  // The tax period is the West Africa Time month: at 00:30 WAT on the 1st, UTC still says the month before.
  const period = watMonth(now);
  const vatInvoices: VatInvoiceEvidence[] = [
    {
      ...scope,
      id: "SAMPLE-SALES-01",
      kind: "sales_invoice",
      netMinor: 10_000_000,
      vatMinor: 750_000,
      taxCode: "SAMPLE-STANDARD",
      invoiceDate: now,
      taxPeriod: period,
      approvedTaxBasis: true,
      evidenceValidated: true,
      inputRecoveryApproved: false,
      eInvoiceRequired: false,
    },
    {
      ...scope,
      id: "SAMPLE-PURCHASE-01",
      kind: "purchase_invoice",
      netMinor: 4_000_000,
      vatMinor: 300_000,
      taxCode: "SAMPLE-STANDARD",
      invoiceDate: now,
      taxPeriod: period,
      approvedTaxBasis: true,
      evidenceValidated: true,
      inputRecoveryApproved: false,
      eInvoiceRequired: false,
    },
  ];
  const vatAllocations: VatBankAllocation[] = [
    {
      ...scope,
      id: "sample-sales-payment",
      invoiceId: "SAMPLE-SALES-01",
      amountMinor: 5_000_000,
      category: "invoice_payment",
      evidenceReference: "SAMPLE-BANK-01",
    },
    {
      ...scope,
      id: "sample-loan-proceeds",
      amountMinor: 25_000_000,
      category: "loan_proceeds",
      evidenceReference: "SAMPLE-LOAN-01",
    },
  ];
  const vatControl: VatControlInput = {
    period,
    configurationVersion: "sample-tax-treatment-v1",
    openingPayableMinor: 0,
    approvedAdjustmentMinor: 0,
    ledgerClosingPayableMinor: 750_000,
    remittancesMinor: 0,
    authorisedRemittanceEvidence: false,
  };
  const payrollRun: PayrollRun = {
    ...scope,
    id: "SAMPLE-NET-PAY",
    version: "1",
    approved: true,
    sourceApprover: "Sample payroll owner",
    sourceHash: cashEvidenceHash("Synthetic approved net-pay run v1"),
    approvedTotalMinor: 360_000_000,
    items: [
      {
        id: "payroll-one",
        employeeReference: "SAMPLE-EMP-01",
        beneficiaryReference: "Sample employee · •• 2041",
        beneficiaryVersion: "1",
        netMinor: 140_000_000,
      },
      {
        id: "payroll-two",
        employeeReference: "SAMPLE-EMP-02",
        beneficiaryReference: "Sample employee · •• 3052",
        beneficiaryVersion: "1",
        netMinor: 120_000_000,
      },
      {
        id: "payroll-three",
        employeeReference: "SAMPLE-EMP-03",
        beneficiaryReference: "Sample employee · •• 4063",
        beneficiaryVersion: "1",
        netMinor: 100_000_000,
      },
    ],
  };
  return {
    scope,
    accounts,
    commitments,
    observations,
    erpInput,
    vatInvoices,
    vatAllocations,
    vatControl,
    payrollRun,
    createdAt: now,
  };
}
type CashWorkspace = ReturnType<typeof sample>;
function workspace(state: DomainState, ctx: Context): CashWorkspace {
  return (
    (stored(state)?.data.workspace as CashWorkspace | undefined) ??
    sample(state, ctx.now)
  );
}
function payrollFundingCurrent(
  accounts: CashAccount[],
  plan: PayrollPlan,
  now: string,
): boolean {
  const source = accounts.find(
    (account) => account.id === plan.sourceAccountId,
  );
  const age = Date.parse(now) - Date.parse(plan.balanceAsOf);
  return (
    !!source &&
    source.balanceAsOf === plan.balanceAsOf &&
    source.availableMinor === plan.availableMinor &&
    source.authorised &&
    source.coverageComplete &&
    source.tenantId === plan.scope.tenantId &&
    source.legalEntityId === plan.scope.legalEntityId &&
    source.currency === plan.scope.currency &&
    Number.isFinite(age) &&
    age >= 0 &&
    age <= 60 * 60_000
  );
}
/** What a forecast is made from, as a digest: the opening booked balance and every commitment. */
const forecastSource = (openingMinor: number, commitments: CashCommitment[]) =>
  cashEvidenceHash({ openingMinor, commitments });
/**
 * Whether a saved view or schedule may be disclosed, on the desk or by a replay:
 * it was bound, when saved, to the grants it was made under, and they are the
 * current ones; and a forecast or VAT schedule was made from the evidence the
 * desk holds now (a forecast's opening balance and commitments, a schedule's
 * invoices, bank allocations and ledger control). One an earlier build saved
 * without these bindings (without its grants, or a forecast without its
 * source) cannot show what it was made under or from, so it is not disclosed
 * either: a new one is prepared under the current permission. Made once for a
 * view, it works out the current grants and evidence once, however many saved
 * schedules the view lists.
 */
export function savedCashDisclosable(
  state: DomainState,
  now: string,
): (record: ValopayRecord) => boolean {
  const data = stored(state)?.data.workspace as CashWorkspace | undefined;
  const grants = new Map<Purpose[], string | undefined>();
  const currentGrants = (purposes: Purpose[]) => {
    if (!grants.has(purposes)) {
      const snapshot = authoritySnapshot(state, purposes, now);
      grants.set(purposes, snapshot && cashEvidenceHash(snapshot));
    }
    return grants.get(purposes);
  };
  let forecastNow: string | undefined, vatNow: string | undefined;
  return (record) => {
    const purposes = savedPurposes[record.kind];
    const bound = record.data.replayAuthority;
    if (!purposes || !Array.isArray(bound)) return false;
    const current = currentGrants(purposes);
    if (!current || cashEvidenceHash(bound) !== current) return false;
    if (record.kind === "connected-cash-forecasts") {
      if (!data) return false;
      forecastNow ??= forecastSource(
        consolidateCashPositions(
          entityScope(state),
          data.accounts,
          data.observations,
          now,
        )[0]?.bookedMinor ?? 0,
        data.commitments,
      );
      return record.data.sourceHash === forecastNow;
    }
    if (record.kind === "connected-cash-vat") {
      if (!data) return false;
      vatNow ??= vatEvidenceHash(
        entityScope(state),
        data.vatInvoices,
        data.vatAllocations,
        data.vatControl,
      );
      return record.data.schedule?.evidenceHash === vatNow;
    }
    return true;
  };
}
export function cashView(state: DomainState, ctx: Context) {
  const data = workspace(state, ctx);
  const read = permission(state, "merchant_account_read", ctx.now);
  const accounts = data.accounts.map((a) => ({
    ...a,
    authorised: read || !stored(state),
  }));
  const positions = consolidateCashPositions(
    data.scope,
    accounts,
    data.observations,
    ctx.now,
  );
  const position = positions.find((p) => p.currency === "NGN");
  const disclosable = savedCashDisclosable(state, ctx.now);
  // The latest saved forecast, while it may be disclosed; withheld, it is named without its figures (savedForecast).
  const savedForecast = ownRecords(state, "connected-cash-forecasts").at(-1);
  const forecastCurrent = !!savedForecast && disclosable(savedForecast);
  const forecast =
    !stored(state) || read
      ? savedForecast
        ? forecastCurrent
          ? savedForecast.data.forecast
          : null
        : forecastCash(
            data.scope,
            position?.bookedMinor ?? 0,
            data.commitments,
            {
              asOf: ctx.now,
              version: "sample-preview",
              openingQualified: position?.qualified ?? false,
              bufferMinor: 150_000_000,
            },
          )
      : null;
  const erp = permission(state, "erp_draft", ctx.now);
  const payroll = permission(state, "payroll_prepare", ctx.now);
  const vat =
    !stored(state) || (read && erp)
      ? reconcileVatEvidence(
          data.scope,
          data.vatInvoices,
          data.vatAllocations,
          data.vatControl,
        )
      : null;
  return {
    initialised: !!stored(state),
    scope: data.scope,
    name: "Sample business · Trading company",
    accounts: read || !stored(state) ? accounts : [],
    positions,
    commitments: read || !stored(state) ? data.commitments : [],
    forecast,
    savedForecast:
      read && savedForecast
        ? {
            id: savedForecast.id,
            createdAt: savedForecast.createdAt,
            state: forecastCurrent
              ? ("current" as const)
              : ("prepare_again" as const),
          }
        : null,
    erpDrafts:
      read && erp
        ? ownRecords(state, "connected-cash-erp").map((r) => {
            const prepared = authorityCurrent(
              state,
              r.data.preparationAuthority,
              erpPurposes,
              ctx.now,
            );
            const reviewed = authorityCurrent(
              state,
              r.data.reviewAuthority,
              erpPurposes,
              ctx.now,
            );
            const draft = r.data.draft as ErpDraft;
            const guard = guardErpDispatch(
              draft,
              {
                scope: data.scope,
                mapping: data.erpInput.mapping,
                invoices: data.erpInput.invoices,
                closedThrough: data.erpInput.closedThrough,
                alreadyRecordedReceiptIds:
                  data.erpInput.alreadyRecordedReceiptIds,
                readAuthorised: read && erp,
              },
              [],
            );
            return {
              id: r.id,
              status:
                !prepared || (draft.review && !reviewed)
                  ? "review_required"
                  : r.status,
              name: r.name,
              createdAt: r.createdAt,
              draft,
              manifest:
                prepared && reviewed && guard.exportAllowed
                  ? r.data.manifest
                  : undefined,
            };
          })
        : [],
    vat,
    // Listed while the grants allow the desk; its figures only while it was made under the current grants and evidence.
    vatExports:
      read && erp
        ? ownRecords(state, "connected-cash-vat").map((r) => {
            const current = disclosable(r);
            return {
              id: r.id,
              createdAt: r.createdAt,
              reviewer: r.data.reviewer,
              state: current
                ? ("current" as const)
                : ("prepare_again" as const),
              ...(current ? { schedule: r.data.schedule } : {}),
            };
          })
        : [],
    payrollPlans:
      read && payroll
        ? ownRecords(state, "connected-cash-payroll").map((r) => {
            const prepared = authorityCurrent(
              state,
              r.data.preparationAuthority,
              payrollPurposes,
              ctx.now,
            );
            const reviewed = authorityCurrent(
              state,
              r.data.reviewAuthority,
              payrollPurposes,
              ctx.now,
            );
            const current = prepared && reviewed;
            const plan = r.data.plan as PayrollPlan;
            return {
              id: r.id,
              status:
                !prepared || (plan.approvalStatus === "approved" && !reviewed)
                  ? "review_required"
                  : r.status,
              // The original approval and outcomes remain stored as history. The
              // ordinary desk must not offer an invalidated file as current.
              plan: current
                ? plan
                : {
                    ...plan,
                    approvalStatus: "draft" as const,
                    approvedHash: undefined,
                    checker: undefined,
                  },
              summary: payrollPlanSummary(plan),
              manifest:
                current && payrollFundingCurrent(data.accounts, plan, ctx.now)
                  ? r.data.manifest
                  : undefined,
            };
          })
        : [],
    payrollReconciliation:
      ctx.role === "Finance" && !(read && payroll)
        ? ownRecords(state, "connected-cash-payroll").flatMap((r) => {
            const plan = r.data.plan as PayrollPlan;
            const items = plan.items
              .filter((item) =>
                ["exported", "submitted", "unknown", "succeeded"].includes(
                  item.status,
                ),
              )
              .map(({ id, employeeReference, netMinor, status }) => ({
                id,
                employeeReference,
                netMinor,
                status,
              }));
            return items.length ? [{ id: r.id, runId: plan.runId, items }] : [];
          })
        : [],
    permissions: { read, erp, payroll },
    limitations: [
      "The sample business’s records are kept apart from the lender’s customer records.",
      "Bank connections, posting to accounting software, tax filing and payroll payments are switched off.",
      "Forecasts and funding buffers do not set any money aside.",
    ],
  };
}

export function runCashAction(
  state: DomainState,
  ctx: Context,
  input: {
    action: string;
    recordId?: string;
    reason: string;
    data: Record<string, unknown>;
  },
): ActionResult {
  if (state.settings.environment !== "sandbox")
    throw refusal(
      "Cash Desk is not available in a pilot yet. It works only with sample data for now.",
      403,
    );
  if (!input.reason?.trim())
    throw new Error(
      "Enter a reason. It is saved in the audit log.",
    );
  const scope = entityScope(state);
  let record: ValopayRecord | undefined;
  let message = "";
  let resultData: Record<string, unknown> = {};
  const store = (
    kind: string,
    name: string,
    status: string,
    data: Record<string, unknown>,
  ) =>
    makeRecord(state, kind, {
      name,
      status,
      createdAt: ctx.now,
      data: {
        ...data,
        entityId: scope.legalEntityId,
        actor: ctx.actor,
        reason: input.reason,
      },
    });
  if (input.action === "cash.initialize") {
    requireRole(ctx, ["Admin", "Operations"], "set up Cash Desk");
    requirePermission(state, "merchant_account_read", ctx.now);
    if (stored(state))
      return {
        message: "Cash Desk is already set up with sample data.",
        data: { synthetic: true },
      };
    record = store(
      "connected-cash-workspace",
      "Sample business Cash Desk",
      "active",
      { workspace: sample(state, ctx.now) },
    );
    message = "Cash Desk is ready, with the sample business’s accounts, invoices, bills and payroll. Sample data only.";
  } else {
    if (!stored(state)) throw new Error("Set up Cash Desk first.");
    // Recording retained outcomes is not new account access or payroll preparation.
    // Finance may reconcile a previously approved/exported item after revocation;
    // its immutable item identity and permitted transition still apply below.
    if (input.action !== "cash.payroll.reconcile")
      requirePermission(state, "merchant_account_read", ctx.now);
    const data = workspace(state, ctx);
    if (input.action === "cash.refresh_sample") {
      requireRole(ctx, ["Admin", "Operations"], "refresh sample balances");
      record = stored(state)!;
      const refreshed = structuredClone(data);
      refreshed.accounts = refreshed.accounts.map((a) => ({
        ...a,
        balanceAsOf: ctx.now,
        fetchedAt: ctx.now,
      }));
      record.data.workspace = refreshed;
      touch(record, ctx.now);
      message =
        "Sample balances refreshed to the current time. Nothing was sent to a bank.";
    } else if (input.action === "cash.forecast") {
      requireRole(ctx, ["Admin", "Operations", "Finance"], "save a forecast");
      const positions = consolidateCashPositions(
        scope,
        data.accounts,
        data.observations,
        ctx.now,
      );
      const position = positions[0]!;
      const value = forecastCash(
        scope,
        position.bookedMinor,
        data.commitments,
        {
          asOf: ctx.now,
          openingQualified: position.qualified,
          version: `sample-${ownRecords(state, "connected-cash-forecasts").length + 1}`,
          bufferMinor: minor(input.data.bufferMinor, 150_000_000),
          downsideInflowBps: minor(input.data.downsideInflowBps, 7000),
          downsideDelayDays: minor(input.data.downsideDelayDays, 7),
        },
      );
      record = store(
        "connected-cash-forecasts",
        "30-day cash forecast",
        "planning_estimate",
        {
          forecast: value,
          sourceHash: forecastSource(position.bookedMinor, data.commitments),
        },
      );
      message = "Forecast saved, with its expected and cautious cases.";
    } else if (input.action === "cash.erp.prepare") {
      requireRole(ctx, ["Admin", "Operations"], "prepare an accounting draft");
      requirePermission(state, "erp_draft", ctx.now);
      if (ownRecords(state, "connected-cash-erp").length)
        throw new Error(
          "The sample receipt already has an accounting draft. Review that draft instead of preparing another.",
        );
      const draft = buildErpDraft({ ...data.erpInput, maker: ctx.actor });
      record = store(
        "connected-cash-erp",
        "Invoice receipt · INV-SAMPLE-204",
        draft.status,
        {
          draft,
          preparationAuthority: authoritySnapshot(state, erpPurposes, ctx.now),
        },
      );
      message =
        "Accounting draft prepared. The receipt, fee and credit note match. Next, Finance must approve it.";
    } else if (input.action === "cash.erp.refresh") {
      requireRole(ctx, ["Admin", "Operations"], "refresh an accounting review");
      requirePermission(state, "erp_draft", ctx.now);
      record = ownRecord(state, "connected-cash-erp", input.recordId);
      const previous = record.data.draft as ErpDraft;
      const draft = buildErpDraft({ ...data.erpInput, maker: ctx.actor });
      if (draft.idempotencyKey !== previous.idempotencyKey)
        throw refusal(
          "The receipt has changed since this draft was prepared, so the draft cannot be refreshed. Prepare a separate correction instead.",
          409,
        );
      record.data.revisions = [
        ...(Array.isArray(record.data.revisions) ? record.data.revisions : []),
        {
          draft: structuredClone(previous),
          manifest: record.data.manifest,
          preparationAuthority: record.data.preparationAuthority,
          reviewAuthority: record.data.reviewAuthority,
          replacedAt: ctx.now,
          reason: input.reason,
        },
      ];
      record.data.draft = draft;
      record.data.preparationAuthority = authoritySnapshot(
        state,
        erpPurposes,
        ctx.now,
      );
      delete record.data.reviewAuthority;
      delete record.data.manifest;
      record.status = draft.status;
      touch(record, ctx.now);
      message =
        "Accounting review refreshed. The receipt is the same. Finance must approve the draft again.";
    } else if (
      input.action === "cash.erp.review" ||
      input.action === "cash.erp.export"
    ) {
      requireRole(ctx, ["Finance"], input.action === "cash.erp.review" ? "approve an accounting draft" : "prepare an accounting export file");
      requirePermission(state, "erp_draft", ctx.now);
      record = ownRecord(state, "connected-cash-erp", input.recordId);
      requireBoundAuthority(
        state,
        record,
        "preparationAuthority",
        erpPurposes,
        ctx.now,
      );
      const current = {
        scope,
        mapping: data.erpInput.mapping,
        invoices: data.erpInput.invoices,
        closedThrough: data.erpInput.closedThrough,
        alreadyRecordedReceiptIds: data.erpInput.alreadyRecordedReceiptIds,
        readAuthorised: true,
      };
      if (input.action === "cash.erp.review") {
        const reviewed = reviewErpDraft(
          record.data.draft as ErpDraft,
          ctx.actor,
        );
        const guard = guardErpDispatch(reviewed, current, []);
        if (!guard.exportAllowed) throw refusal(guard.reasons.join(" "), 409);
        record.data.draft = reviewed;
        record.data.reviewAuthority = authoritySnapshot(
          state,
          erpPurposes,
          ctx.now,
        );
        record.status = "reviewed";
        message = "Accounting draft approved. Nothing was posted to accounting software.";
      } else {
        requireBoundAuthority(
          state,
          record,
          "reviewAuthority",
          erpPurposes,
          ctx.now,
        );
        const draft = record.data.draft as ErpDraft;
        const guard = guardErpDispatch(draft, current, []);
        if (!guard.exportAllowed) throw new Error(guard.reasons.join(" "));
        const manifest = {
          schema: "valo.erp.review-export.v1",
          companyId: draft.input.mapping.companyId,
          invoiceAllocations: draft.input.allocations,
          creditNotes: draft.input.creditNotes,
          grossMinor: draft.input.grossMinor,
          netMinor: draft.input.netMinor,
          feeMinor: draft.input.feeMinor,
          mappingVersion: draft.input.mapping.version,
          requestHash: draft.requestHash,
          reviewer: draft.review!.reviewer,
          status: "not_posted",
          synthetic: true,
        };
        record.data.manifest = {
          ...manifest,
          manifestHash: cashEvidenceHash(manifest),
        };
        record.status = "exported";
        resultData = { manifest: record.data.manifest };
        message =
          "Accounting export file prepared. Nothing was posted to accounting software, and downloading the file does not post it.";
      }
      touch(record, ctx.now);
    } else if (input.action === "cash.vat.export") {
      requireRole(ctx, ["Finance"], "save a VAT schedule");
      requirePermission(state, "erp_draft", ctx.now);
      const schedule = reconcileVatEvidence(
        scope,
        data.vatInvoices,
        data.vatAllocations,
        data.vatControl,
      );
      record = store(
        "connected-cash-vat",
        "VAT schedule",
        schedule.status,
        { schedule, reviewer: ctx.actor },
      );
      resultData = { manifest: schedule };
      message =
        "VAT schedule saved, with its evidence gaps listed. No VAT return was filed and no tax was paid.";
    } else if (input.action === "cash.payroll.prepare") {
      requireRole(ctx, ["Admin", "Operations"], "prepare a payroll funding plan");
      requirePermission(state, "payroll_prepare", ctx.now);
      if (ownRecords(state, "connected-cash-payroll").length)
        throw new Error(
          "This payroll run already has a funding plan. Review that plan before you prepare a correction.",
        );
      const plan = preparePayrollFundingPlan({
        scope,
        run: data.payrollRun,
        importedHash: data.payrollRun.sourceHash,
        maker: ctx.actor,
        sourceAccount: data.accounts[0]!,
        paymentDate: new Date(
          Date.parse(data.createdAt) + 7 * DAY,
        ).toISOString(),
        asOf: ctx.now,
        commitmentsMinor: 660_000_000,
        estimatedFeesMinor: 15_000,
        bufferMinor: 150_000_000,
      });
      record = store(
        "connected-cash-payroll",
        "Approved net-pay funding plan",
        plan.fundingStatus,
        {
          plan,
          preparationAuthority: authoritySnapshot(
            state,
            payrollPurposes,
            ctx.now,
          ),
        },
      );
      message =
        "Payroll funding plan prepared from the approved net pay. Next, Finance must approve it. No one has been paid.";
    } else if (input.action === "cash.payroll.refresh") {
      requireRole(ctx, ["Admin", "Operations"], "refresh a payroll funding review");
      requirePermission(state, "payroll_prepare", ctx.now);
      record = ownRecord(state, "connected-cash-payroll", input.recordId);
      const oldPlan = record.data.plan as PayrollPlan;
      const sourceAccount = data.accounts.find(
        (a) => a.id === oldPlan.sourceAccountId,
      );
      if (!sourceAccount) throw new Error("The account this plan pays from was not found. Reload the page and try again.");
      const revised = refreshPayrollFundingPlan(
        oldPlan,
        sourceAccount,
        ctx.now,
        ctx.actor,
      );
      record.data.revisions = [
        ...(Array.isArray(record.data.revisions) ? record.data.revisions : []),
        {
          plan: structuredClone(oldPlan),
          preparationAuthority: record.data.preparationAuthority,
          reviewAuthority: record.data.reviewAuthority,
          replacedAt: ctx.now,
          reason: input.reason,
        },
      ];
      record.data.plan = revised;
      record.data.preparationAuthority = authoritySnapshot(
        state,
        payrollPurposes,
        ctx.now,
      );
      delete record.data.reviewAuthority;
      delete record.data.manifest;
      record.status = revised.fundingStatus;
      touch(record, ctx.now);
      message =
        "Payroll funding review refreshed. Outcomes already recorded are unchanged. Finance must approve this version.";
    } else if (
      input.action === "cash.payroll.approve" ||
      input.action === "cash.payroll.export" ||
      input.action === "cash.payroll.reconcile"
    ) {
      requireRole(ctx, ["Finance"], input.action === "cash.payroll.approve" ? "approve a payroll funding plan" : input.action === "cash.payroll.export" ? "prepare a payroll export file" : "record payroll outcomes");
      if (input.action !== "cash.payroll.reconcile")
        requirePermission(state, "payroll_prepare", ctx.now);
      record = ownRecord(state, "connected-cash-payroll", input.recordId);
      let plan = record.data.plan as PayrollPlan;
      const checkCurrentFunding = () => {
        if (!payrollFundingCurrent(data.accounts, plan, ctx.now))
          throw new Error(
            "The balances this plan was checked against are out of date or have changed. Refresh sample balances and the payroll funding review, then ask Finance to approve it again.",
          );
      };
      if (input.action === "cash.payroll.approve") {
        requireBoundAuthority(
          state,
          record,
          "preparationAuthority",
          payrollPurposes,
          ctx.now,
        );
        checkCurrentFunding();
        plan = approvePayrollPlan(plan, ctx.actor);
        record.data.reviewAuthority = authoritySnapshot(
          state,
          payrollPurposes,
          ctx.now,
        );
        record.status = "approved";
        message =
          "Payroll funding plan approved. No one has been paid. Each payment still needs approval at the bank.";
      } else if (input.action === "cash.payroll.export") {
        requireBoundAuthority(
          state,
          record,
          "preparationAuthority",
          payrollPurposes,
          ctx.now,
        );
        requireBoundAuthority(
          state,
          record,
          "reviewAuthority",
          payrollPurposes,
          ctx.now,
        );
        // Check freshness again at export; a prior green funding snapshot is not permanent authority.
        checkCurrentFunding();
        const manifest = exportPayrollManifest(plan);
        if (!manifest.itemCount)
          throw new Error(
            "No payments are left to export. Record the outcomes of the payments already exported.",
          );
        record.data.manifest = manifest;
        resultData = { manifest };
        for (const item of plan.items.filter((i) => i.status === "planned"))
          plan = transitionPayrollItem(plan, item.id, {
            status: "exported",
            reference: manifest.manifestHash,
            amountMinor: item.netMinor,
            beneficiaryVersion: item.beneficiaryVersion,
            source: "export",
          });
        record.status = "exported_unpaid";
        message =
          "Payroll export file prepared. No one has been paid. Each payment stays unpaid until you record its outcome from the bank.";
      } else {
        const item = plan.items.find((i) => i.id === input.data.itemId);
        if (!item) throw new Error("Choose a payment from this payroll funding plan.");
        const status = String(input.data.status);
        if (!["succeeded", "failed", "unknown", "reversed"].includes(status))
          throw new Error("Choose one of the sample bank outcomes.");
        plan = transitionPayrollItem(plan, item.id, {
          status: status as "succeeded" | "failed" | "unknown" | "reversed",
          reference: `SAMPLE-${status}-${item.id}`,
          amountMinor: item.netMinor,
          beneficiaryVersion: item.beneficiaryVersion,
          source: "synthetic_bank_evidence",
          lookupConfirmedNotSubmitted:
            input.data.lookupConfirmedNotSubmitted === true,
        });
        // Retain the historical export, but never offer it as the current bank file after item outcomes change.
        if (record.data.manifest) {
          record.data.exportHistory = [
            ...(Array.isArray(record.data.exportHistory)
              ? record.data.exportHistory
              : []),
            { manifest: record.data.manifest, supersededAt: ctx.now },
          ];
          delete record.data.manifest;
        }
        record.status = payrollPlanSummary(plan).status;
        message =
          "Sample bank outcome recorded for this payment only. No money moved.";
      }
      record.data.plan = plan;
      touch(record, ctx.now);
    } else throw new Error("This Cash Desk action is not available.");
  }
  // Recorded at saving, not at first replay: the grants a saved view or schedule was made under.
  const purposes = record && savedPurposes[record.kind];
  if (record && purposes) {
    const authority = authoritySnapshot(state, purposes, ctx.now);
    if (!authority)
      throw refusal(
        "This needs a current permission before it can be saved. Grant it in Permissions and readiness, then try again.",
        403,
      );
    record.data.replayAuthority = authority;
  }
  return {
    message,
    record,
    data: {
      ...resultData,
      synthetic: true,
      externalInstructionPerformed: false,
    },
  };
}
