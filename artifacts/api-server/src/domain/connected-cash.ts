import { counted, sumMoney } from "@workspace/valo-pay-1-schema";
import { canonicalDigest } from "../lib/digests";

/** Synthetic/import planning domain. These functions never connect to a bank, post to an ERP,
 * file a return or pay an employee. All amounts are integer currency minor units. */
export interface CashScope {
  tenantId: string;
  legalEntityId: string;
}
export interface CurrencyScope extends CashScope {
  currency: string;
}
export class ConnectedCashError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConnectedCashError";
  }
}
const fail = (code: string, message: string): never => {
  throw new ConnectedCashError(code, message);
};
const required = (value: string, label: string) => {
  if (typeof value !== "string" || !value.trim())
    fail("invalid_input", `${label} is required.`);
};
function money(value: number, label: string, signed = false): number {
  if (!Number.isSafeInteger(value) || (!signed && value < 0))
    fail(
      "invalid_amount",
      `${label} must be a whole amount${signed ? "" : " of ₦0.00 or more"}.`,
    );
  return value;
}
/** An exact sum. A total beyond the supported range is the money refusal every calculation gives
 * (MoneyArithmeticError, answered 422 with its code), not a refusal of the input. */
const total = (values: number[]): number => sumMoney(values);
function instant(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    fail("invalid_date", `${label} must be a valid date and time.`);
  return parsed;
}
function validateScope(scope: CashScope): void {
  required(scope.tenantId, "Lender");
  required(scope.legalEntityId, "Business");
}
function assertScope(expected: CashScope, actual: CashScope): void {
  validateScope(expected);
  validateScope(actual);
  if (
    expected.tenantId !== actual.tenantId ||
    expected.legalEntityId !== actual.legalEntityId
  )
    fail(
      "scope_mismatch",
      "This record belongs to another lender or business.",
    );
  if (
    "currency" in expected &&
    "currency" in actual &&
    expected.currency !== actual.currency
  )
    fail("currency_mismatch", "Review each currency separately.");
}
const currency = (value: string) => {
  if (!/^[A-Z]{3}$/.test(value))
    fail("invalid_currency", "Use a three-letter currency code.");
};
function unique(values: string[], label: string): void {
  values.forEach((value) => required(value, label));
  if (new Set(values).size !== values.length)
    fail("duplicate_identity", `${label} must be unique.`);
}
// Request, approval, frozen-plan and manifest hashes are stored and checked
// again, so they keep the form they were first written in.
export const cashEvidenceHash = (value: unknown): string =>
  canonicalDigest(value, "legacy-en-us-omit");
const DAY = 86_400_000;

export interface CashAccount extends CurrencyScope {
  id: string;
  name: string;
  source: string;
  sourceDefinition: string;
  authorised: boolean;
  bookedMinor: number;
  availableMinor: number | null;
  pendingMinor: number | null;
  balanceAsOf: string;
  fetchedAt: string;
  coverageComplete: boolean;
}
export interface CashObservation extends CurrencyScope {
  id: string;
  accountId: string;
  sourceReference: string;
  amountMinor: number;
  status: "pending" | "booked" | "reversed";
  occurredAt: string;
  observedAt: string;
  supersedesId?: string;
  reversalOfId?: string;
  internalTransferId?: string;
}
export interface CashPosition {
  currency: string;
  bookedMinor: number;
  availableMinor: number | null;
  pendingMinor: number | null;
  incomeMinor: number;
  expenseMinor: number;
  accountCount: number;
  omittedAccountIds: string[];
  oldestBalanceAsOf: string | null;
  latestFetchedAt: string | null;
  qualified: boolean;
  warnings: string[];
}

/** CASH-01–05: retain balance definitions; do not add pending flows to booked balances.
 * Explicit replacement/reversal links are required; amount/date similarity is not identity. */
export function consolidateCashPositions(
  scope: CashScope,
  accounts: CashAccount[],
  observations: CashObservation[],
  asOf: string,
  freshnessMinutes = 60,
): CashPosition[] {
  scope = { tenantId: scope.tenantId, legalEntityId: scope.legalEntityId };
  validateScope(scope);
  const at = instant(asOf, "As-of time");
  if (!Number.isFinite(freshnessMinutes) || freshnessMinutes <= 0)
    fail("invalid_input", "The maximum age of the balances must be more than zero.");
  unique(
    accounts.map((a) => a.id),
    "Account ID",
  );
  accounts.forEach((a) => {
    assertScope(scope, a);
    currency(a.currency);
    required(a.source, "Balance source");
    required(a.sourceDefinition, "Balance definition");
    money(a.bookedMinor, "Booked balance", true);
    if (a.availableMinor !== null)
      money(a.availableMinor, "Available balance", true);
    if (a.pendingMinor !== null) money(a.pendingMinor, "Pending balance", true);
    instant(a.balanceAsOf, "Bank as-of time");
    instant(a.fetchedAt, "Fetch time");
  });
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const deduplicated = new Map<string, CashObservation>();
  observations.forEach((o) => {
    assertScope(scope, o);
    currency(o.currency);
    money(o.amountMinor, "Transaction amount", true);
    required(o.id, "Transaction ID");
    required(o.sourceReference, "Source reference");
    const account = accountById.get(o.accountId);
    if (!account || account.currency !== o.currency)
      fail(
        "account_mismatch",
        "A transaction is for an account or currency the business has not given permission for.",
      );
    const observed = instant(o.observedAt, "Observed time");
    instant(o.occurredAt, "Occurrence time");
    if (observed > at || instant(o.occurredAt, "Occurrence time") > at) return;
    const key = `${o.accountId}:${o.sourceReference}`;
    const duplicate = deduplicated.get(key);
    if (duplicate && cashEvidenceHash(duplicate) !== cashEvidenceHash(o))
      fail(
        "duplicate_conflict",
        "Two transactions with the same reference disagree. Link the correction to the transaction it corrects.",
      );
    deduplicated.set(key, o);
  });
  const visible = [...deduplicated.values()];
  unique(
    visible.map((o) => o.id),
    "Transaction ID",
  );
  const byId = new Map(visible.map((o) => [o.id, o]));
  const superseded = new Set<string>();
  visible.forEach((o) => {
    for (const predecessorId of [o.supersedesId, o.reversalOfId].filter(
      (id): id is string => !!id,
    )) {
      const predecessor = byId.get(predecessorId);
      if (
        !predecessor ||
        predecessor.accountId !== o.accountId ||
        predecessor.currency !== o.currency ||
        predecessor.id === o.id
      )
        fail(
          "invalid_lineage",
          "A correction or reversal must be for the same account and currency as the transaction it changes.",
        );
      const visited = new Set([o.id]);
      let cursor: CashObservation | undefined = predecessor;
      while (cursor) {
        if (visited.has(cursor.id))
          fail(
            "invalid_lineage",
            "These transactions correct each other in a loop. Check the corrections.",
          );
        visited.add(cursor.id);
        cursor = byId.get(cursor.supersedesId ?? cursor.reversalOfId ?? "");
      }
      superseded.add(predecessorId);
    }
  });
  return [...new Set(accounts.map((a) => a.currency))].sort().map((code) => {
    const all = accounts.filter((a) => a.currency === code);
    const usable = all.filter(
      (a) =>
        a.authorised &&
        instant(a.balanceAsOf, "Bank time") <= at &&
        instant(a.fetchedAt, "Fetch time") <= at,
    );
    const ids = new Set(usable.map((a) => a.id));
    const warnings: string[] = [];
    const omitted = all.filter((a) => !ids.has(a.id)).map((a) => a.id);
    if (omitted.length)
      warnings.push(
        `${counted(omitted.length, "account")} left out: no permission to read, or no balance known at this time.`,
      );
    if (
      usable.some(
        (a) =>
          at - instant(a.balanceAsOf, "Bank time") > freshnessMinutes * 60_000,
      )
    )
      warnings.push("One or more bank balances are out of date.");
    if (usable.some((a) => !a.coverageComplete))
      warnings.push(
        "Some transactions are missing, so these totals are not final.",
      );
    if (usable.some((a) => a.availableMinor === null))
      warnings.push("Some accounts do not show an available balance.");
    const flows = visible.filter(
      (o) =>
        ids.has(o.accountId) &&
        o.status === "booked" &&
        !superseded.has(o.id) &&
        !o.reversalOfId,
    );
    const transfers = new Map<string, CashObservation[]>();
    flows
      .filter((o) => o.internalTransferId)
      .forEach((o) => {
        const group = transfers.get(o.internalTransferId!) ?? [];
        group.push(o);
        transfers.set(o.internalTransferId!, group);
      });
    for (const legs of transfers.values())
      if (
        legs.length !== 2 ||
        legs[0]!.accountId === legs[1]!.accountId ||
        total(legs.map((o) => o.amountMinor)) !== 0
      )
        warnings.push(
          "A transfer between the business’s own accounts does not match on both sides. It is left out of money in and out until it is reviewed.",
        );
    const external = flows.filter((o) => !o.internalTransferId);
    const qualified = warnings.length === 0 && usable.length > 0;
    return {
      currency: code,
      bookedMinor: total(usable.map((a) => a.bookedMinor)),
      availableMinor: qualified
        ? total(usable.map((a) => a.availableMinor!))
        : null,
      pendingMinor:
        usable.length && usable.every((a) => a.pendingMinor !== null)
          ? total(usable.map((a) => a.pendingMinor!))
          : null,
      incomeMinor: total(
        external.filter((o) => o.amountMinor > 0).map((o) => o.amountMinor),
      ),
      expenseMinor: total(
        external.filter((o) => o.amountMinor < 0).map((o) => -o.amountMinor),
      ),
      accountCount: usable.length,
      omittedAccountIds: omitted,
      oldestBalanceAsOf: usable.length
        ? [...usable].sort((a, b) =>
            a.balanceAsOf.localeCompare(b.balanceAsOf),
          )[0]!.balanceAsOf
        : null,
      latestFetchedAt: usable.length
        ? [...usable].sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))[0]!
            .fetchedAt
        : null,
      qualified,
      warnings: [...new Set(warnings)],
    };
  });
}

export interface CashCommitment extends CurrencyScope {
  id: string;
  label: string;
  direction: "inflow" | "outflow";
  amountMinor: number;
  dueAt: string;
  knownAt: string;
  approved: boolean;
  source: "invoice" | "bill" | "payroll" | "recurring_assumption";
  version: string;
}
export interface ForecastOptions {
  asOf: string;
  horizonDays?: 7 | 30;
  version: string;
  openingQualified: boolean;
  downsideInflowBps?: number;
  downsideDelayDays?: number;
  bufferMinor?: number;
}
/** CASH-06: historical evaluation excludes future knowledge; reserves are planning values only.
 * An approved outflow past its due date is still owed and counts as due now; an overdue receipt is left out. */
export function forecastCash(
  scope: CurrencyScope,
  openingMinor: number,
  commitments: CashCommitment[],
  options: ForecastOptions,
) {
  validateScope(scope);
  currency(scope.currency);
  money(openingMinor, "Opening balance", true);
  required(options.version, "Forecast version");
  const at = instant(options.asOf, "As-of time");
  const days = options.horizonDays ?? 30;
  const bps = options.downsideInflowBps ?? 7000;
  const delay = options.downsideDelayDays ?? 7;
  const buffer = money(options.bufferMinor ?? 0, "Planning buffer");
  if (
    ![7, 30].includes(days) ||
    !Number.isInteger(bps) ||
    bps < 0 ||
    bps > 10000 ||
    !Number.isInteger(delay) ||
    delay < 0 ||
    delay > 30
  )
    fail("invalid_input", "Check the forecast period and the cautious case settings.");
  unique(
    commitments.map((c) => c.id),
    "Commitment ID",
  );
  commitments.forEach((c) => {
    assertScope(scope, c);
    money(c.amountMinor, "Commitment amount");
    instant(c.knownAt, "Known time");
    instant(c.dueAt, "Due time");
    required(c.version, "Commitment version");
  });
  // An approved outflow past its due date is still owed, so it counts as due
  // now; a receipt past its due date is not counted on until it arrives.
  const eligible = commitments.filter(
    (c) =>
      c.approved &&
      instant(c.knownAt, "Known time") <= at &&
      (c.direction === "outflow" || instant(c.dueAt, "Due time") >= at),
  );
  const dueTime = (c: CashCommitment) =>
    Math.max(instant(c.dueAt, "Due time"), at);
  const overdueOutflows = eligible.filter(
    (c) => instant(c.dueAt, "Due time") < at,
  ).length;
  const points = Array.from({ length: Math.ceil(days / 7) }, (_, i) =>
    Math.min((i + 1) * 7, days),
  );
  const scenarios = (["base", "downside"] as const).map((name) => ({
    name,
    points: points.map((day) => {
      const until = at + day * DAY;
      const included = eligible.filter(
        (c) =>
          dueTime(c) +
            (name === "downside" && c.direction === "inflow"
              ? delay * DAY
              : 0) <=
          until,
      );
      const inflowMinor = total(
        included
          .filter((c) => c.direction === "inflow")
          .map((c) =>
            name === "downside"
              ? Number((BigInt(c.amountMinor) * BigInt(bps)) / 10000n)
              : c.amountMinor,
          ),
      );
      const outflowMinor = total(
        included
          .filter((c) => c.direction === "outflow")
          .map((c) => c.amountMinor),
      );
      const closingMinor = total([openingMinor, inflowMinor, -outflowMinor]);
      return {
        day,
        date: new Date(until).toISOString(),
        inflowMinor,
        outflowMinor,
        closingMinor,
        afterPlanningBufferMinor: total([closingMinor, -buffer]),
        shortfallMinor: money(
          Math.max(0, total([buffer, -closingMinor])),
          "Forecast shortfall",
        ),
      };
    }),
  }));
  const inputHash = cashEvidenceHash({
    scope,
    openingMinor,
    eligible,
    options,
  });
  return {
    ...scope,
    asOf: options.asOf,
    version: options.version,
    inputHash,
    status: options.openingQualified
      ? ("planning_estimate" as const)
      : ("unknown_opening_balance" as const),
    openingMinor,
    persistenceBaselineMinor: openingMinor,
    planningBufferMinor: buffer,
    scenarios,
    includedCommitmentIds: eligible
      .filter((c) => dueTime(c) <= at + days * DAY)
      .map((c) => c.id),
    excludedCommitmentIds: commitments
      .filter((c) => !eligible.includes(c))
      .map((c) => c.id),
    warnings: [
      "Forecasts are estimates, not available bank balances.",
      ...(options.openingQualified
        ? []
        : [
            "The opening balance is not confirmed. Refresh the sample balances before you rely on this forecast.",
          ]),
      ...(overdueOutflows === 1
        ? [
            "An approved outgoing payment is past its due date, so it is counted as due now.",
          ]
        : overdueOutflows
          ? [
              `${overdueOutflows} approved outgoing payments are past their due dates, so they are counted as due now.`,
            ]
          : []),
    ],
  };
}

export interface ErpMapping extends CurrencyScope {
  companyId: string;
  provider: "xero" | "odoo" | "export";
  version: string;
  active: boolean;
  contactId: string;
  bankLedgerCode: string;
  revenueAccountCode: string;
  feeAccountCode: string;
  taxCode: string;
  financeApproved: boolean;
}
export interface ErpInvoice extends CurrencyScope {
  id: string;
  companyId: string;
  contactId: string;
  version: string;
  outstandingMinor: number;
  taxCode: string;
}
export interface ErpDraftInput {
  scope: CurrencyScope;
  maker: string;
  postingDate: string;
  canonicalReceiptId: string;
  bankReference: string;
  grossMinor: number;
  feeMinor: number;
  netMinor: number;
  mapping: ErpMapping;
  invoices: ErpInvoice[];
  allocations: Array<{
    invoiceId: string;
    invoiceVersion: string;
    amountMinor: number;
  }>;
  creditNotes?: Array<{
    id: string;
    invoiceId: string;
    amountMinor: number;
    approved: boolean;
    version: string;
  }>;
  source: "bank_evidence" | "synthetic";
  alreadyRecordedReceiptIds?: string[];
  closedThrough?: string;
}
export interface ErpDraft {
  kind: "erp_receipt_draft";
  input: ErpDraftInput;
  idempotencyKey: string;
  requestHash: string;
  status: "proposed" | "blocked" | "already_recorded" | "reviewed";
  reasons: string[];
  residuals: Array<{
    invoiceId: string;
    beforeMinor: number;
    paymentMinor: number;
    creditNoteMinor: number;
    afterMinor: number;
  }>;
  review?: { reviewer: string; approvedHash: string };
  liveDispatchAllowed: false;
}
/** ERP-02/06: support exact partial and credit-note arithmetic as reviewed drafts; no implied posting. */
export function buildErpDraft(input: ErpDraftInput): ErpDraft {
  validateScope(input.scope);
  currency(input.scope.currency);
  assertScope(input.scope, input.mapping);
  (
    [
      ["maker", "Preparer"],
      ["canonicalReceiptId", "Receipt ID"],
      ["bankReference", "Bank reference"],
    ] as const
  ).forEach(([key, label]) => required(input[key], label));
  instant(input.postingDate, "Accounting date");
  (
    [
      ["companyId", "Accounting company"],
      ["version", "Accounting setup version"],
      ["contactId", "Accounting contact"],
      ["bankLedgerCode", "Bank account code"],
      ["revenueAccountCode", "Revenue account code"],
      ["feeAccountCode", "Fee account code"],
      ["taxCode", "Tax code"],
    ] as const
  ).forEach(([key, label]) => required(input.mapping[key], label));
  const gross = money(input.grossMinor, "Amount before fees"),
    fee = money(input.feeMinor, "Fee"),
    net = money(input.netMinor, "Amount received in the bank");
  if (gross <= 0 || total([net, fee]) !== gross)
    fail(
      "unbalanced_receipt",
      "The amount before fees must equal the amount received in the bank plus the recorded fee.",
    );
  unique(
    input.invoices.map((i) => i.id),
    "Invoice ID",
  );
  unique(
    input.allocations.map((i) => i.invoiceId),
    "Allocation invoice",
  );
  unique(
    (input.creditNotes ?? []).map((c) => c.id),
    "Credit note ID",
  );
  const reasons: string[] = [];
  if (!input.mapping.active || !input.mapping.financeApproved)
    reasons.push("Finance must approve the current accounting setup.");
  if (
    input.closedThrough &&
    instant(input.postingDate, "Accounting date") <=
      instant(input.closedThrough, "Period lock")
  )
    reasons.push("The accounting period is closed.");
  const invoices = new Map(
    input.invoices.map((invoice) => {
      assertScope(input.scope, invoice);
      money(invoice.outstandingMinor, "Amount still owed on the invoice");
      if (
        invoice.companyId !== input.mapping.companyId ||
        invoice.contactId !== input.mapping.contactId ||
        invoice.taxCode !== input.mapping.taxCode
      )
        fail(
          "mapping_mismatch",
          "The invoice’s company, contact or tax code does not match the approved accounting setup.",
        );
      required(invoice.version, "Invoice version");
      return [invoice.id, invoice] as const;
    }),
  );
  input.allocations.forEach((a) => {
    money(a.amountMinor, "Allocation");
    const invoice = invoices.get(a.invoiceId);
    if (!invoice || invoice.version !== a.invoiceVersion)
      fail("invoice_changed", "This invoice has changed. Refresh it and try again.");
  });
  if (total(input.allocations.map((a) => a.amountMinor)) !== gross)
    fail(
      "unallocated_receipt",
      "The amounts applied to invoices must add up to the amount before fees. Differences cannot be written off.",
    );
  (input.creditNotes ?? []).forEach((c) => {
    money(c.amountMinor, "Credit note");
    required(c.version, "Credit note version");
    if (!invoices.has(c.invoiceId))
      fail("invoice_missing", "The invoice for this credit note is missing.");
    if (!c.approved)
      reasons.push("A credit note still needs Finance approval.");
  });
  const residuals = input.invoices.map((i) => {
    const paymentMinor = total(
      input.allocations
        .filter((a) => a.invoiceId === i.id)
        .map((a) => a.amountMinor),
    );
    const creditNoteMinor = total(
      (input.creditNotes ?? [])
        .filter((c) => c.invoiceId === i.id)
        .map((c) => c.amountMinor),
    );
    const afterMinor = total([
      i.outstandingMinor,
      -paymentMinor,
      -creditNoteMinor,
    ]);
    if (afterMinor < 0)
      fail(
        "over_allocation",
        "The payment and credit notes are more than the amount still owed on the invoice.",
      );
    return {
      invoiceId: i.id,
      beforeMinor: i.outstandingMinor,
      paymentMinor,
      creditNoteMinor,
      afterMinor,
    };
  });
  const immutable = structuredClone(input);
  const idempotencyKey = cashEvidenceHash({
    ...input.scope,
    companyId: input.mapping.companyId,
    provider: input.mapping.provider,
    canonicalReceiptId: input.canonicalReceiptId,
  });
  return {
    kind: "erp_receipt_draft",
    input: immutable,
    idempotencyKey,
    requestHash: cashEvidenceHash(immutable),
    status: input.alreadyRecordedReceiptIds?.includes(input.canonicalReceiptId)
      ? "already_recorded"
      : reasons.length
        ? "blocked"
        : "proposed",
    reasons: [...new Set(reasons)],
    residuals,
    liveDispatchAllowed: false,
  };
}
export function reviewErpDraft(draft: ErpDraft, reviewer: string): ErpDraft {
  required(reviewer, "Finance reviewer");
  if (reviewer === draft.input.maker)
    fail(
      "self_approval",
      "A different Finance reviewer must approve this draft.",
    );
  if (
    draft.status !== "proposed" ||
    draft.requestHash !== cashEvidenceHash(draft.input)
  )
    fail(
      "draft_not_reviewable",
      "This draft cannot be approved: it is blocked, already recorded or has changed. Refresh the accounting review to see why.",
    );
  return {
    ...structuredClone(draft),
    status: "reviewed",
    review: { reviewer, approvedHash: draft.requestHash },
  };
}
export interface ErpCommand {
  idempotencyKey: string;
  requestHash: string;
  status: "queued" | "unknown" | "posted" | "failed";
  externalReference?: string;
}
/** ERP-03/05/08: dispatch readiness is for reviewed export only. Unknown acceptance requires lookup,
 * including after a timeout; same-key/different-payload is always blocked. */
export function guardErpDispatch(
  draft: ErpDraft,
  current: {
    scope: CurrencyScope;
    mapping: ErpMapping;
    invoices: ErpInvoice[];
    closedThrough?: string;
    readAuthorised: boolean;
    alreadyRecordedReceiptIds?: string[];
  },
  ledger: ErpCommand[],
) {
  assertScope(draft.input.scope, current.scope);
  assertScope(current.scope, current.mapping);
  const reasons = [...draft.reasons];
  if (!current.readAuthorised)
    reasons.push("A permission this needs has expired or was withdrawn. Grant it again in Permissions and readiness.");
  if (
    draft.status !== "reviewed" ||
    draft.review?.reviewer === draft.input.maker ||
    draft.review?.approvedHash !== cashEvidenceHash(draft.input) ||
    draft.requestHash !== cashEvidenceHash(draft.input)
  )
    reasons.push("A different Finance reviewer must approve the current version of this draft.");
  if (
    cashEvidenceHash(current.mapping) !== cashEvidenceHash(draft.input.mapping)
  )
    reasons.push("The accounting setup has changed. Refresh the accounting review.");
  if (
    current.closedThrough &&
    instant(draft.input.postingDate, "Accounting date") <=
      instant(current.closedThrough, "Period lock")
  )
    reasons.push("The accounting period is now closed.");
  unique(
    current.invoices.map((i) => i.id),
    "Current invoice ID",
  );
  for (const old of draft.input.invoices) {
    const fresh = current.invoices.find((i) => i.id === old.id);
    if (!fresh || cashEvidenceHash(fresh) !== cashEvidenceHash(old))
      reasons.push(
        `Invoice ${old.id} has changed. Refresh the accounting review to see the amount still owed.`,
      );
  }
  const commands = ledger.filter(
    (c) => c.idempotencyKey === draft.idempotencyKey,
  );
  if (commands.some((c) => c.requestHash !== draft.requestHash))
    reasons.push("An earlier attempt used the same reference with different details. Check it before you try again.");
  if (commands.some((c) => c.status === "unknown" || c.status === "queued"))
    reasons.push("Check the outcome of the earlier attempt before you try again.");
  const alreadyRecorded =
    commands.some((c) => c.status === "posted") ||
    !!current.alreadyRecordedReceiptIds?.includes(
      draft.input.canonicalReceiptId,
    ) ||
    draft.status === "already_recorded";
  if (alreadyRecorded)
    reasons.push("This receipt is already recorded in accounting software. Do not post it again.");
  return {
    status: alreadyRecorded
      ? ("already_recorded" as const)
      : reasons.length
        ? ("blocked" as const)
        : ("ready_for_export" as const),
    exportAllowed: reasons.length === 0,
    liveDispatchAllowed: false as const,
    reasons: [...new Set(reasons)],
  };
}

export interface VatInvoiceEvidence extends CurrencyScope {
  id: string;
  kind:
    | "sales_invoice"
    | "sales_credit_note"
    | "purchase_invoice"
    | "purchase_credit_note";
  netMinor: number;
  vatMinor: number;
  taxCode: string;
  invoiceDate: string;
  taxPeriod: string;
  approvedTaxBasis: boolean;
  evidenceValidated: boolean;
  inputRecoveryApproved: boolean;
  eInvoiceRequired: boolean;
  eInvoiceReference?: string;
}
export interface VatBankAllocation extends CurrencyScope {
  id: string;
  invoiceId?: string;
  amountMinor: number;
  category: "invoice_payment" | "loan_proceeds" | "own_transfer" | "other";
  evidenceReference: string;
}
export interface VatControlInput {
  period: string;
  configurationVersion: string;
  openingPayableMinor: number;
  approvedAdjustmentMinor: number;
  ledgerClosingPayableMinor: number;
  remittancesMinor: number;
  authorisedRemittanceEvidence: boolean;
}
/** The evidence a VAT schedule is made from, as its digest (the schedule's evidenceHash): a saved schedule is
 * disclosed only while the desk holds the same evidence. */
export const vatEvidenceHash = (
  scope: CurrencyScope,
  invoices: VatInvoiceEvidence[],
  bankAllocations: VatBankAllocation[],
  control: VatControlInput,
): string => cashEvidenceHash({ scope, invoices, bankAllocations, control });
/** TAX-REC: report the approved invoice tax amounts, including unpaid invoices. Cash receipts never
 * create tax evidence or input-tax entitlement; this is a review schedule, not a filed return. */
export function reconcileVatEvidence(
  scope: CurrencyScope,
  invoices: VatInvoiceEvidence[],
  bankAllocations: VatBankAllocation[],
  control: VatControlInput,
) {
  validateScope(scope);
  currency(scope.currency);
  required(control.period, "Tax period");
  required(control.configurationVersion, "Tax settings version");
  unique(
    invoices.map((i) => i.id),
    "Tax invoice ID",
  );
  unique(
    bankAllocations.map((a) => a.id),
    "Bank allocation ID",
  );
  money(control.openingPayableMinor, "Opening VAT balance", true);
  money(control.approvedAdjustmentMinor, "Approved adjustment", true);
  money(control.ledgerClosingPayableMinor, "Closing VAT balance in the ledger", true);
  money(control.remittancesMinor, "VAT paid");
  const missing: string[] = [];
  invoices.forEach((i) => {
    assertScope(scope, i);
    money(i.netMinor, "Invoice net");
    money(i.vatMinor, "Invoice VAT");
    required(i.taxCode, "Tax code");
    instant(i.invoiceDate, "Invoice date");
    if (
      !i.approvedTaxBasis ||
      !i.evidenceValidated ||
      (i.eInvoiceRequired && !i.eInvoiceReference)
    )
      missing.push(
        `Invoice ${i.id} needs an approved VAT treatment or checked invoice evidence.`,
      );
  });
  bankAllocations.forEach((a) => {
    assertScope(scope, a);
    money(a.amountMinor, "Bank allocation");
    required(a.evidenceReference, "Bank evidence");
    if (
      a.category === "invoice_payment" &&
      !invoices.some((i) => i.id === a.invoiceId)
    )
      missing.push(`Bank payment ${a.id} has no matching invoice.`);
  });
  const eligible = invoices.filter(
    (i) =>
      i.taxPeriod === control.period &&
      i.approvedTaxBasis &&
      i.evidenceValidated &&
      (!i.eInvoiceRequired || !!i.eInvoiceReference),
  );
  const outputVatMinor = total(
    eligible
      .filter((i) => i.kind.startsWith("sales_"))
      .map((i) => (i.kind === "sales_credit_note" ? -i.vatMinor : i.vatMinor)),
  );
  const eligibleInputVatMinor = total(
    eligible
      .filter((i) => i.kind.startsWith("purchase_") && i.inputRecoveryApproved)
      .map((i) =>
        i.kind === "purchase_credit_note" ? -i.vatMinor : i.vatMinor,
      ),
  );
  const blockedInputVatMinor = total(
    eligible
      .filter((i) => i.kind === "purchase_invoice" && !i.inputRecoveryApproved)
      .map((i) => i.vatMinor),
  );
  if (blockedInputVatMinor)
    missing.push(
      "VAT on purchases is left out of the VAT you can reclaim until a decision to reclaim it is approved.",
    );
  if (control.remittancesMinor && !control.authorisedRemittanceEvidence)
    missing.push(
      "The VAT payment is not confirmed, so it has not reduced the expected VAT balance.",
    );
  const verifiedRemittancesMinor = control.authorisedRemittanceEvidence
    ? control.remittancesMinor
    : 0;
  const expectedClosingMinor = total([
    control.openingPayableMinor,
    outputVatMinor,
    -eligibleInputVatMinor,
    control.approvedAdjustmentMinor,
    -verifiedRemittancesMinor,
  ]);
  const varianceMinor = total([
    control.ledgerClosingPayableMinor,
    -expectedClosingMinor,
  ]);
  if (varianceMinor !== 0)
    missing.push(
      "The invoice totals do not match the VAT account in the ledger.",
    );
  const lines = invoices
    .filter((i) => i.taxPeriod === control.period)
    .map((i) => ({
      invoiceId: i.id,
      kind: i.kind,
      netMinor: i.netMinor,
      vatMinor: i.vatMinor,
      taxCode: i.taxCode,
      paidMinor: total(
        bankAllocations
          .filter(
            (a) => a.category === "invoice_payment" && a.invoiceId === i.id,
          )
          .map((a) => a.amountMinor),
      ),
      evidenceComplete: eligible.includes(i),
    }));
  return {
    ...scope,
    period: control.period,
    configurationVersion: control.configurationVersion,
    outputVatMinor,
    eligibleInputVatMinor,
    blockedInputVatMinor,
    expectedClosingMinor,
    ledgerClosingMinor: control.ledgerClosingPayableMinor,
    varianceMinor,
    status: missing.length
      ? ("review_required" as const)
      : ("reconciled_for_review" as const),
    filingStatus: "not_submitted" as const,
    paymentStatus: "not_initiated" as const,
    lines,
    missingEvidence: missing,
    excludedBankCreditsMinor: total(
      bankAllocations
        .filter((a) => a.category !== "invoice_payment")
        .map((a) => a.amountMinor),
    ),
    evidenceHash: vatEvidenceHash(scope, invoices, bankAllocations, control),
  };
}

export type PayrollItemStatus =
  | "planned"
  | "exported"
  | "submitted"
  | "succeeded"
  | "failed"
  | "unknown"
  | "reversed";
export interface PayrollNetItem {
  id: string;
  employeeReference: string;
  beneficiaryReference: string;
  beneficiaryVersion: string;
  netMinor: number;
}
export interface PayrollRun extends CurrencyScope {
  id: string;
  version: string;
  approved: boolean;
  sourceApprover: string;
  sourceHash: string;
  approvedTotalMinor: number;
  items: PayrollNetItem[];
}
export interface PayrollFundingInput {
  scope: CurrencyScope;
  run: PayrollRun;
  importedHash: string;
  maker: string;
  sourceAccount: CashAccount;
  paymentDate: string;
  asOf: string;
  freshnessMinutes?: number;
  commitmentsMinor: number;
  estimatedFeesMinor: number;
  bufferMinor: number;
}
export interface PayrollPlan {
  kind: "payroll_funding_plan";
  scope: CurrencyScope;
  runId: string;
  runVersion: string;
  sourceHash: string;
  maker: string;
  sourceApprover: string;
  sourceAccountId: string;
  paymentDate: string;
  asOf: string;
  balanceAsOf: string;
  reviewVersion: number;
  totalNetMinor: number;
  requiredMinor: number;
  availableMinor: number | null;
  shortfallMinor: number | null;
  commitmentsMinor: number;
  estimatedFeesMinor: number;
  bufferMinor: number;
  fundingStatus: "ready_for_review" | "shortfall" | "unknown";
  approvalStatus: "draft" | "approved";
  items: Array<
    PayrollNetItem & {
      status: PayrollItemStatus;
      idempotencyKey: string;
      evidenceReference?: string;
    }
  >;
  frozenHash: string;
  checker?: string;
  approvedHash?: string;
  evidenceAuthority?: { maker: string; checker: string; identityHash: string };
  liveDispatchAllowed: false;
}
function payrollIdentityHash(plan: PayrollPlan): string {
  return cashEvidenceHash({
    scope: plan.scope,
    runId: plan.runId,
    runVersion: plan.runVersion,
    sourceHash: plan.sourceHash,
    sourceAccountId: plan.sourceAccountId,
    paymentDate: plan.paymentDate,
    items: plan.items.map(
      ({
        id,
        employeeReference,
        beneficiaryReference,
        beneficiaryVersion,
        netMinor,
        idempotencyKey,
      }) => ({
        id,
        employeeReference,
        beneficiaryReference,
        beneficiaryVersion,
        netMinor,
        idempotencyKey,
      }),
    ),
  });
}
function payrollFrozenPayload(plan: PayrollPlan) {
  return {
    scope: plan.scope,
    runId: plan.runId,
    runVersion: plan.runVersion,
    sourceHash: plan.sourceHash,
    maker: plan.maker,
    sourceApprover: plan.sourceApprover,
    sourceAccountId: plan.sourceAccountId,
    paymentDate: plan.paymentDate,
    asOf: plan.asOf,
    balanceAsOf: plan.balanceAsOf,
    reviewVersion: plan.reviewVersion,
    totalNetMinor: plan.totalNetMinor,
    requiredMinor: plan.requiredMinor,
    availableMinor: plan.availableMinor,
    commitmentsMinor: plan.commitmentsMinor,
    estimatedFeesMinor: plan.estimatedFeesMinor,
    bufferMinor: plan.bufferMinor,
    items: plan.items.map(
      ({
        id,
        employeeReference,
        beneficiaryReference,
        beneficiaryVersion,
        netMinor,
        idempotencyKey,
      }) => ({
        id,
        employeeReference,
        beneficiaryReference,
        beneficiaryVersion,
        netMinor,
        idempotencyKey,
      }),
    ),
  };
}
/** PAYROLL-01/02: import only approved net pay, discard extraneous employee data, expose funding
 * shortfalls without reserving money or claiming authority to debit an account. */
export function preparePayrollFundingPlan(
  input: PayrollFundingInput,
): PayrollPlan {
  assertScope(input.scope, input.run);
  assertScope(input.scope, input.sourceAccount);
  currency(input.scope.currency);
  required(input.maker, "Preparer");
  required(input.run.sourceApprover, "Payroll source approver");
  required(input.run.version, "Payroll version");
  required(input.run.sourceHash, "Approved payroll file check");
  if (!input.run.approved || input.importedHash !== input.run.sourceHash)
    fail(
      "unapproved_payroll",
      "The payroll file must match the approved net-pay run exactly.",
    );
  unique(
    input.run.items.map((i) => i.id),
    "Payroll item",
  );
  if (!input.run.items.length)
    fail("empty_payroll", "The approved payroll run needs at least one payment.");
  const at = instant(input.asOf, "As-of time");
  instant(input.paymentDate, "Payment date");
  const freshness = input.freshnessMinutes ?? 60;
  if (!Number.isFinite(freshness) || freshness <= 0)
    fail("invalid_input", "The maximum age of the balances must be more than zero.");
  const items = input.run.items.map((i) => {
    money(i.netMinor, "Approved net pay");
    required(i.employeeReference, "Employee reference");
    required(i.beneficiaryReference, "Beneficiary reference");
    required(i.beneficiaryVersion, "Beneficiary version");
    return {
      id: i.id,
      employeeReference: i.employeeReference,
      beneficiaryReference: i.beneficiaryReference,
      beneficiaryVersion: i.beneficiaryVersion,
      netMinor: i.netMinor,
      status: "planned" as const,
      idempotencyKey: cashEvidenceHash({
        scope: input.scope,
        runId: input.run.id,
        runVersion: input.run.version,
        itemId: i.id,
      }),
    };
  });
  const totalNetMinor = total(items.map((i) => i.netMinor));
  if (
    totalNetMinor !==
    money(input.run.approvedTotalMinor, "Approved payroll total")
  )
    fail(
      "payroll_total_mismatch",
      "The approved payroll total does not match its payments.",
    );
  const commitmentsMinor = money(input.commitmentsMinor, "Other commitments"),
    estimatedFeesMinor = money(input.estimatedFeesMinor, "Estimated fees"),
    bufferMinor = money(input.bufferMinor, "Funding buffer");
  const requiredMinor = total([
    totalNetMinor,
    commitmentsMinor,
    estimatedFeesMinor,
    bufferMinor,
  ]);
  const bankAt = instant(input.sourceAccount.balanceAsOf, "Bank timestamp"),
    fetchedAt = instant(input.sourceAccount.fetchedAt, "Fetch timestamp");
  if (input.sourceAccount.availableMinor !== null)
    money(input.sourceAccount.availableMinor, "Available balance", true);
  const known =
    input.sourceAccount.authorised &&
    input.sourceAccount.coverageComplete &&
    input.sourceAccount.availableMinor !== null &&
    bankAt <= at &&
    fetchedAt <= at &&
    at - bankAt <= freshness * 60_000;
  const availableMinor = known ? input.sourceAccount.availableMinor : null;
  const shortfallMinor =
    availableMinor === null
      ? null
      : money(Math.max(0, total([requiredMinor, -availableMinor])), "Payroll shortfall");
  const plan: PayrollPlan = {
    kind: "payroll_funding_plan",
    scope: structuredClone(input.scope),
    runId: input.run.id,
    runVersion: input.run.version,
    sourceHash: input.run.sourceHash,
    maker: input.maker,
    sourceApprover: input.run.sourceApprover,
    sourceAccountId: input.sourceAccount.id,
    paymentDate: input.paymentDate,
    asOf: input.asOf,
    balanceAsOf: input.sourceAccount.balanceAsOf,
    reviewVersion: 1,
    totalNetMinor,
    requiredMinor,
    availableMinor,
    shortfallMinor,
    commitmentsMinor,
    estimatedFeesMinor,
    bufferMinor,
    fundingStatus:
      shortfallMinor === null
        ? "unknown"
        : shortfallMinor > 0
          ? "shortfall"
          : "ready_for_review",
    approvalStatus: "draft",
    items,
    frozenHash: "",
    liveDispatchAllowed: false,
  };
  plan.frozenHash = cashEvidenceHash(payrollFrozenPayload(plan));
  return plan;
}
export function approvePayrollPlan(
  plan: PayrollPlan,
  checker: string,
): PayrollPlan {
  required(checker, "Approver");
  if (checker === plan.maker)
    fail(
      "self_approval",
      "A different person must approve the payroll funding plan. The person who prepared it cannot approve it.",
    );
  if (
    plan.fundingStatus !== "ready_for_review" ||
    plan.frozenHash !== cashEvidenceHash(payrollFrozenPayload(plan))
  )
    fail(
      "payroll_not_ready",
      "This plan is not ready to approve. Its funding is short or unknown, or the plan has changed. Refresh the payroll funding review first.",
    );
  return {
    ...structuredClone(plan),
    approvalStatus: "approved",
    checker,
    approvedHash: plan.frozenHash,
    evidenceAuthority: {
      maker: plan.maker,
      checker,
      identityHash: payrollIdentityHash(plan),
    },
  };
}
/** A fresh review never resets submitted/unknown/successful item state or its idempotency key.
 * Unknown/submitted amounts remain conservatively included in funding exposure, but not exports. */
export function refreshPayrollFundingPlan(
  plan: PayrollPlan,
  sourceAccount: CashAccount,
  asOf: string,
  maker: string,
): PayrollPlan {
  assertScope(plan.scope, sourceAccount);
  required(maker, "Preparer");
  if (sourceAccount.id !== plan.sourceAccountId)
    fail(
      "account_mismatch",
      "To pay from a different account, prepare a correction and have a different person approve it.",
    );
  const at = instant(asOf, "As-of time"),
    balanceAt = instant(sourceAccount.balanceAsOf, "Balance time"),
    fetched = instant(sourceAccount.fetchedAt, "Fetch time");
  if (sourceAccount.availableMinor !== null)
    money(sourceAccount.availableMinor, "Available balance", true);
  const known =
    sourceAccount.authorised &&
    sourceAccount.coverageComplete &&
    sourceAccount.availableMinor !== null &&
    balanceAt <= at &&
    fetched <= at &&
    at - balanceAt <= 60 * 60_000;
  const remainingMinor = total(
    plan.items
      .filter((i) =>
        ["planned", "exported", "submitted", "unknown"].includes(i.status),
      )
      .map((i) => i.netMinor),
  );
  const requiredMinor = total([
    remainingMinor,
    plan.commitmentsMinor,
    plan.estimatedFeesMinor,
    plan.bufferMinor,
  ]);
  const availableMinor = known ? sourceAccount.availableMinor : null;
  const shortfallMinor =
    availableMinor === null
      ? null
      : money(Math.max(0, total([requiredMinor, -availableMinor])), "Payroll shortfall");
  const refreshed: PayrollPlan = {
    ...structuredClone(plan),
    maker,
    asOf,
    balanceAsOf: sourceAccount.balanceAsOf,
    reviewVersion: plan.reviewVersion + 1,
    requiredMinor,
    availableMinor,
    shortfallMinor,
    fundingStatus:
      shortfallMinor === null
        ? "unknown"
        : shortfallMinor > 0
          ? "shortfall"
          : "ready_for_review",
    approvalStatus: "draft",
    checker: undefined,
    approvedHash: undefined,
  };
  refreshed.frozenHash = cashEvidenceHash(payrollFrozenPayload(refreshed));
  return refreshed;
}
export interface PayrollEvidence {
  status: PayrollItemStatus;
  reference: string;
  amountMinor: number;
  beneficiaryVersion: string;
  source: "export" | "synthetic_bank_evidence";
  lookupConfirmedNotSubmitted?: boolean;
}
/** PAYROLL-03/05/06: export is not payment. Reconcile independent items; never replay a success or
 * unknown outcome, and never simulate cancelling an instruction already sent. */
export function transitionPayrollItem(
  plan: PayrollPlan,
  itemId: string,
  evidence: PayrollEvidence,
): PayrollPlan {
  const currentApproval =
    plan.approvalStatus === "approved" &&
    !!plan.checker &&
    plan.checker !== plan.maker &&
    plan.approvedHash === cashEvidenceHash(payrollFrozenPayload(plan));
  const retainedEvidenceAuthority =
    !!plan.evidenceAuthority &&
    plan.evidenceAuthority.checker !== plan.evidenceAuthority.maker &&
    plan.evidenceAuthority.identityHash === payrollIdentityHash(plan) &&
    ["submitted", "succeeded", "failed", "unknown", "reversed"].includes(
      evidence.status,
    );
  if (
    !currentApproval &&
    !(
      evidence.source === "synthetic_bank_evidence" && retainedEvidenceAuthority
    )
  )
    fail(
      "payroll_approval_changed",
      "This payroll funding plan is not approved, or it changed after approval. Ask a different Finance reviewer to approve it again.",
    );
  const found = plan.items.find((i) => i.id === itemId);
  if (!found)
    throw new ConnectedCashError(
      "payroll_item_missing",
      "This payment is not in the payroll funding plan. Reload the page and try again.",
    );
  const item = found;
  required(evidence.reference, "Outcome evidence");
  money(evidence.amountMinor, "Evidence amount");
  if (
    evidence.amountMinor !== item.netMinor ||
    evidence.beneficiaryVersion !== item.beneficiaryVersion
  )
    fail(
      "payroll_evidence_mismatch",
      "The amount or the employee’s account details do not match the approved payment.",
    );
  if (evidence.source === "export" && evidence.status !== "exported")
    fail(
      "bank_evidence_required",
      "An export file does not show that anyone was paid. Record the bank’s outcome instead.",
    );
  if (
    item.status === evidence.status &&
    item.evidenceReference === evidence.reference
  )
    return structuredClone(plan);
  const allowed: Record<PayrollItemStatus, PayrollItemStatus[]> = {
    planned: ["exported"],
    exported: ["submitted", "unknown", "succeeded", "failed"],
    submitted: ["succeeded", "failed", "unknown"],
    unknown: ["succeeded", "failed"],
    succeeded: ["reversed"],
    failed: [],
    reversed: [],
  };
  if (
    item.status === "unknown" &&
    evidence.status === "failed" &&
    !evidence.lookupConfirmedNotSubmitted
  )
    fail(
      "unknown_requires_lookup",
      "Check with the bank that this payment was not sent before you record it as failed.",
    );
  if (!allowed[item.status].includes(evidence.status))
    fail(
      "invalid_payroll_transition",
      "This payment cannot be retried or changed to that outcome. After review, prepare a correction and have a different person approve it.",
    );
  const copy = structuredClone(plan);
  const updated = copy.items.find((i) => i.id === itemId)!;
  updated.status = evidence.status;
  updated.evidenceReference = evidence.reference;
  return copy;
}
export function payrollPlanSummary(plan: PayrollPlan) {
  const counts = Object.fromEntries(
    (
      [
        "planned",
        "exported",
        "submitted",
        "succeeded",
        "failed",
        "unknown",
        "reversed",
      ] as PayrollItemStatus[]
    ).map((status) => [
      status,
      plan.items.filter((i) => i.status === status).length,
    ]),
  ) as Record<PayrollItemStatus, number>;
  return {
    itemCount: plan.items.length,
    totalNetMinor: plan.totalNetMinor,
    counts,
    status:
      counts.succeeded === plan.items.length
        ? "completed"
        : counts.succeeded > 0 || counts.failed > 0 || counts.reversed > 0
          ? "partially_completed"
          : counts.unknown > 0
            ? "needs_reconciliation"
            : counts.submitted > 0
              ? "submitted"
              : counts.exported > 0
                ? "exported_unpaid"
                : "planning",
    liveDispatchAllowed: false as const,
  };
}
export function exportPayrollManifest(plan: PayrollPlan) {
  if (
    plan.approvalStatus !== "approved" ||
    !plan.checker ||
    plan.checker === plan.maker ||
    plan.approvedHash !== cashEvidenceHash(payrollFrozenPayload(plan))
  )
    fail(
      "payroll_approval_changed",
      "A different Finance reviewer must approve the current version of this plan before the export file can be prepared.",
    );
  const items = plan.items
    .filter((i) => i.status === "planned" || i.status === "exported")
    .map(
      ({
        id,
        beneficiaryReference,
        beneficiaryVersion,
        netMinor,
        idempotencyKey,
      }) => ({
        id,
        beneficiaryReference,
        beneficiaryVersion,
        netMinor,
        idempotencyKey,
      }),
    );
  const manifest = {
    scope: plan.scope,
    runId: plan.runId,
    runVersion: plan.runVersion,
    sourceAccountId: plan.sourceAccountId,
    paymentDate: plan.paymentDate,
    checker: plan.checker,
    approvedHash: plan.approvedHash,
    itemCount: items.length,
    totalMinor: total(items.map((i) => i.netMinor)),
    items,
    paymentStatus: "not_evidenced" as const,
  };
  return {
    ...manifest,
    manifestHash: cashEvidenceHash(manifest),
    warning:
      "This file does not show that anyone was paid, and it does not set money aside. Record each payment’s outcome from the bank before you try any payment again.",
  };
}
