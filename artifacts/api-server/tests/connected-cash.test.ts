import assert from "node:assert/strict";
import {
  ConnectedCashError,
  consolidateCashPositions,
  forecastCash,
  buildErpDraft,
  reviewErpDraft,
  guardErpDispatch,
  reconcileVatEvidence,
  preparePayrollFundingPlan,
  approvePayrollPlan,
  transitionPayrollItem,
  payrollPlanSummary,
  exportPayrollManifest,
  type CashAccount,
  type CashObservation,
  type ErpDraftInput,
  type PayrollFundingInput,
  type VatInvoiceEvidence,
} from "../src/domain/connected-cash.js";

const scope = {
  tenantId: "sample-tenant",
  legalEntityId: "sample-company",
  currency: "NGN",
};
const now = "2026-09-21T10:00:00.000Z";
const account: CashAccount = {
  ...scope,
  id: "bank-1",
  name: "Operating account",
  source: "synthetic",
  sourceDefinition: "Provider booked and available balance",
  authorised: true,
  bookedMinor: 100_000,
  availableMinor: 90_000,
  pendingMinor: -10_000,
  balanceAsOf: now,
  fetchedAt: now,
  coverageComplete: true,
};
const observation = (
  id: string,
  amountMinor: number,
  extra: Partial<CashObservation> = {},
): CashObservation => ({
  ...scope,
  id,
  accountId: "bank-1",
  sourceReference: id,
  amountMinor,
  status: "booked",
  occurredAt: now,
  observedAt: now,
  ...extra,
});
const code = (expected: string) => (error: unknown) =>
  error instanceof ConnectedCashError && error.code === expected;
let checks = 0;

const positions = consolidateCashPositions(
  scope,
  [
    account,
    { ...account, id: "bank-2" },
    { ...account, id: "usd", currency: "USD", availableMinor: null },
  ],
  [
    observation("in", 20_000),
    observation("pending", -5_000, { status: "pending" }),
    observation("out", -5_000, { supersedesId: "pending" }),
    observation("t1", -30_000, { internalTransferId: "transfer" }),
    observation("t2", 30_000, {
      accountId: "bank-2",
      internalTransferId: "transfer",
    }),
  ],
  now,
);
assert.equal(positions[0]!.bookedMinor, 200_000);
assert.equal(positions[0]!.availableMinor, 180_000);
assert.equal(positions[0]!.pendingMinor, -20_000);
assert.equal(positions[0]!.incomeMinor, 20_000);
assert.equal(positions[0]!.expenseMinor, 5_000);
assert.equal(positions[1]!.availableMinor, null);
checks += 6;
assert.throws(
  () =>
    consolidateCashPositions(
      scope,
      [{ ...account, tenantId: "other" }],
      [],
      now,
    ),
  code("scope_mismatch"),
);
checks++;
assert.equal(
  consolidateCashPositions(
    scope,
    [{ ...account, balanceAsOf: "2026-09-20T10:00:00Z" }],
    [],
    now,
  )[0]!.availableMinor,
  null,
);
checks++;
assert.equal(
  consolidateCashPositions(
    scope,
    [account],
    [observation("x", 4), observation("x", 4)],
    now,
  )[0]!.incomeMinor,
  4,
);
checks++;
assert.throws(
  () =>
    consolidateCashPositions(
      scope,
      [account],
      [observation("x", 4), observation("x", 5)],
      now,
    ),
  code("duplicate_conflict"),
);
checks++;
assert.equal(
  consolidateCashPositions(
    scope,
    [account],
    [
      observation("x", 4),
      observation("r", -4, { status: "reversed", reversalOfId: "x" }),
    ],
    now,
  )[0]!.incomeMinor,
  0,
);
checks++;
const unpaired = consolidateCashPositions(
  scope,
  [account],
  [observation("t1", -30_000, { internalTransferId: "missing" })],
  now,
)[0]!;
assert.equal(unpaired.expenseMinor, 0);
assert.equal(unpaired.qualified, false);
checks += 2;
assert.throws(
  () =>
    consolidateCashPositions(
      scope,
      [account],
      [
        observation("x", 4, { supersedesId: "y" }),
        observation("y", 4, { supersedesId: "x" }),
      ],
      now,
    ),
  code("invalid_lineage"),
);
checks++;

const forecast = forecastCash(
  scope,
  100_000,
  [
    {
      ...scope,
      id: "invoice",
      label: "Expected invoice",
      direction: "inflow",
      amountMinor: 50_000,
      dueAt: "2026-09-25T10:00:00Z",
      knownAt: now,
      approved: true,
      source: "invoice",
      version: "1",
    },
    {
      ...scope,
      id: "bill",
      label: "Supplier bill",
      direction: "outflow",
      amountMinor: 120_000,
      dueAt: "2026-09-26T10:00:00Z",
      knownAt: now,
      approved: true,
      source: "bill",
      version: "1",
    },
    {
      ...scope,
      id: "future",
      label: "Future information",
      direction: "inflow",
      amountMinor: 5_000_000,
      dueAt: "2026-09-26T10:00:00Z",
      knownAt: "2026-09-22T10:00:00Z",
      approved: true,
      source: "invoice",
      version: "1",
    },
  ],
  { asOf: now, openingQualified: true, version: "1", bufferMinor: 10_000 },
);
assert.equal(forecast.scenarios[0]!.points[0]!.closingMinor, 30_000);
assert.equal(forecast.scenarios[1]!.points[0]!.closingMinor, -20_000);
assert.equal(forecast.scenarios[1]!.points[1]!.closingMinor, 15_000);
assert.ok(forecast.excludedCommitmentIds.includes("future"));
assert.equal(forecast.openingMinor, 100_000);
checks += 5;
// An approved outflow past its due date is still owed, so it counts as due now in
// every point of both scenarios; a receipt past its due date is not counted on.
const overdue = forecastCash(
  scope,
  100_000,
  [
    {
      ...scope,
      id: "late-bill",
      label: "Overdue supplier bill",
      direction: "outflow",
      amountMinor: 30_000,
      dueAt: "2026-09-18T10:00:00Z",
      knownAt: "2026-09-01T10:00:00Z",
      approved: true,
      source: "bill",
      version: "1",
    },
    {
      ...scope,
      id: "late-invoice",
      label: "Overdue customer invoice",
      direction: "inflow",
      amountMinor: 50_000,
      dueAt: "2026-09-19T10:00:00Z",
      knownAt: "2026-09-01T10:00:00Z",
      approved: true,
      source: "invoice",
      version: "1",
    },
  ],
  { asOf: now, openingQualified: true, version: "1", bufferMinor: 10_000 },
);
for (const scenario of overdue.scenarios)
  assert.deepEqual(
    scenario.points.map((p) => [p.inflowMinor, p.outflowMinor, p.closingMinor]),
    Array.from({ length: 5 }, () => [0, 30_000, 70_000]),
    scenario.name,
  );
assert.deepEqual(overdue.includedCommitmentIds, ["late-bill"]);
assert.deepEqual(overdue.excludedCommitmentIds, ["late-invoice"]);
assert.ok(
  overdue.warnings.includes(
    "An approved outgoing payment is past its due date, so it is counted as due now.",
  ),
);
checks += 5;
assert.equal(
  forecastCash(scope, 1, [], {
    asOf: now,
    openingQualified: false,
    version: "1",
  }).status,
  "unknown_opening_balance",
);
checks++;

const erpInput: ErpDraftInput = {
  scope,
  maker: "Sandbox Operations",
  postingDate: now,
  canonicalReceiptId: "receipt-1",
  bankReference: "sample-bank-evidence",
  grossMinor: 100_000,
  feeMinor: 200,
  netMinor: 99_800,
  mapping: {
    ...scope,
    companyId: "xero-1",
    provider: "xero",
    version: "1",
    active: true,
    contactId: "contact-1",
    bankLedgerCode: "090",
    revenueAccountCode: "200",
    feeAccountCode: "404",
    taxCode: "approved-tax-code",
    financeApproved: true,
  },
  invoices: [
    {
      ...scope,
      id: "invoice-1",
      companyId: "xero-1",
      contactId: "contact-1",
      version: "1",
      outstandingMinor: 150_000,
      taxCode: "approved-tax-code",
    },
  ],
  allocations: [
    { invoiceId: "invoice-1", invoiceVersion: "1", amountMinor: 100_000 },
  ],
  creditNotes: [
    {
      id: "credit-1",
      invoiceId: "invoice-1",
      amountMinor: 25_000,
      approved: true,
      version: "1",
    },
  ],
  source: "synthetic",
};
const draft = buildErpDraft(erpInput);
assert.equal(draft.residuals[0]!.afterMinor, 25_000);
assert.equal(draft.liveDispatchAllowed, false);
checks += 2;
assert.throws(
  () => buildErpDraft({ ...erpInput, netMinor: 99_000 }),
  code("unbalanced_receipt"),
);
checks++;
assert.throws(
  () =>
    buildErpDraft({
      ...erpInput,
      creditNotes: [{ ...erpInput.creditNotes![0]!, amountMinor: 60_000 }],
    }),
  code("over_allocation"),
);
checks++;
assert.throws(
  () =>
    buildErpDraft({
      ...erpInput,
      invoices: [{ ...erpInput.invoices[0]!, companyId: "other-company" }],
    }),
  code("mapping_mismatch"),
);
checks++;
assert.throws(
  () => reviewErpDraft(draft, erpInput.maker),
  code("self_approval"),
);
checks++;
const reviewed = reviewErpDraft(draft, "Sandbox Finance");
const current = {
  scope,
  mapping: erpInput.mapping,
  invoices: erpInput.invoices,
  readAuthorised: true,
};
assert.equal(
  guardErpDispatch(reviewed, current, []).status,
  "ready_for_export",
);
checks++;
assert.equal(
  guardErpDispatch(reviewed, { ...current, closedThrough: now }, []).status,
  "blocked",
);
checks++;
assert.equal(
  guardErpDispatch(
    reviewed,
    {
      ...current,
      invoices: [{ ...erpInput.invoices[0]!, outstandingMinor: 149_999 }],
    },
    [],
  ).status,
  "blocked",
);
checks++;
assert.equal(
  guardErpDispatch(reviewed, current, [
    {
      idempotencyKey: draft.idempotencyKey,
      requestHash: draft.requestHash,
      status: "unknown",
    },
  ]).exportAllowed,
  false,
);
checks++;
assert.equal(
  guardErpDispatch(reviewed, current, [
    {
      idempotencyKey: draft.idempotencyKey,
      requestHash: draft.requestHash,
      status: "posted",
    },
  ]).status,
  "already_recorded",
);
checks++;
const changed = structuredClone(reviewed);
changed.input.allocations[0]!.amountMinor--;
assert.equal(guardErpDispatch(changed, current, []).exportAllowed, false);
checks++;

const vatInvoice: VatInvoiceEvidence = {
  ...scope,
  id: "tax-invoice",
  kind: "sales_invoice",
  netMinor: 100_000,
  vatMinor: 7_500,
  taxCode: "approved-standard",
  invoiceDate: now,
  taxPeriod: "2026-09",
  approvedTaxBasis: true,
  evidenceValidated: true,
  inputRecoveryApproved: false,
  eInvoiceRequired: false,
};
const vatControl = {
  period: "2026-09",
  configurationVersion: "finance-1",
  openingPayableMinor: 0,
  approvedAdjustmentMinor: 0,
  ledgerClosingPayableMinor: 7_500,
  remittancesMinor: 0,
  authorisedRemittanceEvidence: false,
};
const vat = reconcileVatEvidence(
  scope,
  [vatInvoice],
  [
    {
      ...scope,
      id: "loan",
      amountMinor: 1_000_000,
      category: "loan_proceeds",
      evidenceReference: "loan-proof",
    },
    {
      ...scope,
      id: "partial",
      amountMinor: 20_000,
      category: "invoice_payment",
      invoiceId: vatInvoice.id,
      evidenceReference: "bank-proof",
    },
  ],
  vatControl,
);
assert.equal(vat.outputVatMinor, 7_500);
assert.equal(vat.excludedBankCreditsMinor, 1_000_000);
assert.equal(vat.lines[0]!.paidMinor, 20_000);
assert.equal(vat.varianceMinor, 0);
assert.equal(vat.filingStatus, "not_submitted");
checks += 5;
assert.equal(
  reconcileVatEvidence(
    scope,
    [{ ...vatInvoice, kind: "purchase_invoice", inputRecoveryApproved: false }],
    [],
    vatControl,
  ).eligibleInputVatMinor,
  0,
);
checks++;
assert.equal(
  reconcileVatEvidence(
    scope,
    [{ ...vatInvoice, eInvoiceRequired: true }],
    [],
    vatControl,
  ).status,
  "review_required",
);
checks++;
assert.equal(
  reconcileVatEvidence(scope, [vatInvoice], [], {
    ...vatControl,
    remittancesMinor: 7_500,
    authorisedRemittanceEvidence: false,
  }).expectedClosingMinor,
  7_500,
);
checks++;

const payrollInput: PayrollFundingInput = {
  scope,
  maker: "Sandbox Operations",
  sourceAccount: account,
  importedHash: "approved-file-hash",
  paymentDate: "2026-09-22T10:00:00Z",
  asOf: now,
  commitmentsMinor: 5_000,
  estimatedFeesMinor: 500,
  bufferMinor: 10_000,
  run: {
    ...scope,
    id: "run-1",
    version: "1",
    approved: true,
    sourceApprover: "Payroll manager",
    sourceHash: "approved-file-hash",
    approvedTotalMinor: 60_000,
    items: [
      {
        id: "one",
        employeeReference: "EMP-01",
        beneficiaryReference: "masked-destination-one",
        beneficiaryVersion: "1",
        netMinor: 20_000,
      },
      {
        id: "two",
        employeeReference: "EMP-02",
        beneficiaryReference: "masked-destination-two",
        beneficiaryVersion: "1",
        netMinor: 40_000,
      },
    ],
  },
};
const plan = preparePayrollFundingPlan(payrollInput);
assert.equal(plan.requiredMinor, 75_500);
assert.equal(plan.shortfallMinor, 0);
checks += 2;
assert.throws(
  () => preparePayrollFundingPlan({ ...payrollInput, importedHash: "changed" }),
  code("unapproved_payroll"),
);
checks++;
assert.throws(
  () =>
    preparePayrollFundingPlan({
      ...payrollInput,
      run: { ...payrollInput.run, approvedTotalMinor: 10 },
    }),
  code("payroll_total_mismatch"),
);
checks++;
assert.equal(
  preparePayrollFundingPlan({
    ...payrollInput,
    sourceAccount: { ...account, balanceAsOf: "2026-09-20T10:00:00Z" },
  }).fundingStatus,
  "unknown",
);
checks++;
assert.equal(
  preparePayrollFundingPlan({
    ...payrollInput,
    sourceAccount: { ...account, availableMinor: 10 },
  }).fundingStatus,
  "shortfall",
);
checks++;
assert.throws(
  () => approvePayrollPlan(plan, payrollInput.maker),
  code("self_approval"),
);
checks++;
let approved = approvePayrollPlan(plan, "Sandbox Finance");
assert.equal(exportPayrollManifest(approved).paymentStatus, "not_evidenced");
checks++;
for (const item of approved.items)
  approved = transitionPayrollItem(approved, item.id, {
    status: "exported",
    reference: `export-${item.id}`,
    amountMinor: item.netMinor,
    beneficiaryVersion: item.beneficiaryVersion,
    source: "export",
  });
assert.equal(payrollPlanSummary(approved).status, "exported_unpaid");
checks++;
approved = transitionPayrollItem(approved, "one", {
  status: "succeeded",
  reference: "bank-one",
  amountMinor: 20_000,
  beneficiaryVersion: "1",
  source: "synthetic_bank_evidence",
});
approved = transitionPayrollItem(approved, "two", {
  status: "unknown",
  reference: "unknown-two",
  amountMinor: 40_000,
  beneficiaryVersion: "1",
  source: "synthetic_bank_evidence",
});
assert.equal(payrollPlanSummary(approved).status, "partially_completed");
assert.equal(exportPayrollManifest(approved).itemCount, 0);
checks += 2;
assert.throws(
  () =>
    transitionPayrollItem(approved, "one", {
      status: "exported",
      reference: "duplicate",
      amountMinor: 20_000,
      beneficiaryVersion: "1",
      source: "export",
    }),
  code("invalid_payroll_transition"),
);
checks++;
assert.throws(
  () =>
    transitionPayrollItem(approved, "two", {
      status: "failed",
      reference: "not-looked-up",
      amountMinor: 40_000,
      beneficiaryVersion: "1",
      source: "synthetic_bank_evidence",
    }),
  code("unknown_requires_lookup"),
);
checks++;
assert.throws(
  () =>
    transitionPayrollItem(approved, "two", {
      status: "succeeded",
      reference: "pretend",
      amountMinor: 40_000,
      beneficiaryVersion: "1",
      source: "export",
    }),
  code("bank_evidence_required"),
);
checks++;
const edited = structuredClone(approved);
edited.items[0]!.beneficiaryVersion = "2";
assert.throws(
  () => exportPayrollManifest(edited),
  code("payroll_approval_changed"),
);
checks++;

console.log(
  `Connected Cash domain: ${checks} focused checks passed (offline synthetic fixtures).`,
);
