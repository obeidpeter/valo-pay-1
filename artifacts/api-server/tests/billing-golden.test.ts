// Golden tests for invoicing (BIL-04) and post-invoice adjustments (BIL-07)
// against TRD v1.1 section 5.15, with the terms that bill a licence (BIL-02),
// the reversal window (BIL-01) and the recovery fee gate (BIL-03).
import assert from "node:assert/strict";
import { ctxAt, wat } from "./helpers.js";
import { executeAction } from "../src/domain/actions.js";
import { buildOverview, buildReports } from "../src/domain/reports.js";
import { billableCollection, issueInvoice, monthOf, pendingAdjustments, previousMonth, periodEnd } from "../src/domain/billing.js";
import { supersedeAllocation } from "../src/domain/reconciliation.js";
import { makeRecord, recordsOf } from "../src/domain/records.js";
import { seedMerchant } from "../src/lib/valopay-seed.js";
import type { DomainState, TypedRecord, ValopayRecord } from "../src/domain/types.js";
import { validateRecord } from '../src/domain/validation.js';

const { assertFinalState } = await import("../src/lib/valopay-store.js");
let checks = 0;
const finance = (now: string) => ctxAt(now, "Finance");
const LICENCE = 60_000_000; // contracted Scale licence in the seed
const invoiceFor = (state: DomainState, period: string, now: string) => executeAction(state, finance(now), { action: "issue_invoice", reason: "month end", data: { period } }).record!;

/** A seeded lender whose design-partner terms are signed from `effectiveDate`, so its first invoice is for that month or an earlier one. */
function fixture(id: string, effectiveDate = "2027-06-01"): { state: DomainState; collection: (reference: string, observedAt: string, amountKobo?: number) => TypedRecord<"payments"> } {
  const state = seedMerchant(id);
  const terms = recordsOf(state, "commercial")[0]!;
  terms.data.signed = true; terms.data.effectiveDate = effectiveDate;
  // These dates describe this fixture's reviewed agreement, not a platform calendar default.
  terms.data.signedFullPriceTerms = true;
  terms.data.discountStartDate = '2027-01-01'; terms.data.fullPriceStartDate = '2028-01-01';
  terms.data.discountTermsReference = 'synthetic-agreement';
  validateRecord(state, finance(wat('2026-12-01T09:00:00')), 'commercial', terms);
  // The seeded receipts become transfers so only the collections each case creates are billable (BIL-01 is covered in measurement-golden).
  for (const payment of recordsOf(state, "payments")) payment.data.channel = "transfer";
  const customer = recordsOf(state, "customers")[0]!;
  const collection = (reference: string, observedAt: string, amountKobo = 2_500_000) => {
    const due = makeRecord(state, "due-items", { name: `due ${reference}`, status: "paid", customerId: customer.id, amountKobo, reference: `DUE-${reference}`, data: { dueDate: observedAt.slice(0, 10), owner: "lms", outstandingKobo: 0 } });
    const payment = makeRecord(state, "payments", { name: reference, status: "allocated", customerId: customer.id, amountKobo, reference, data: { channel: "direct_debit", collectionStatus: "succeeded", settlementStatus: "settled", observedAt, settledAt: observedAt, reversalStatus: "none", refundStatus: "none", allocatedKobo: amountKobo, dueItemId: due.id } });
    makeRecord(state, "allocations", { name: "R1", status: "confirmed", customerId: customer.id, amountKobo, data: { paymentId: payment.id, dueItemId: due.id, rule: "R1", confidence: "certain", automatic: true } });
    return payment;
  };
  return { state, collection };
}

// ---------- Helpers: billing months are calendar months in West Africa Time ----------
assert.equal(previousMonth("2027-07-01T09:00:00.000Z"), "2027-06");
assert.equal(previousMonth("2027-01-15T09:00:00.000Z"), "2026-12");
assert.equal(periodEnd("2027-06"), "2027-06-30T22:59:59.999Z", "June ends at midnight WAT, 23:00 UTC");
assert.equal(monthOf(wat("2028-01-01T00:30:00")), "2028-01", "00:30 WAT on 1 January is January, though it is still December in UTC");
assert.equal(previousMonth(wat("2028-02-01T00:30:00")), "2028-01", "at 00:30 WAT on 1 February the previous month is January");
checks += 5;

// BIL-02: a calendar year is not signed authority to end the pilot/bridge discount.
{
  const { state } = fixture('unreviewed-discount', '2028-01-01');
  delete recordsOf(state, 'commercial')[0]!.data.discountReview;
  state.settings.billingPeriod = '2028-01';
  const before = structuredClone(state);
  assert.throws(() => issueInvoice(state, finance(wat('2028-02-02T09:00:00')), { period: '2028-01' }), /review.*discount dates/i,
    'Older design-partner agreements need reviewed contract dates before a new invoice, not an automatic full-price calendar rollover.');
  assert.deepEqual(state, before, 'Refused pricing creates no invoice or financial change');
  const billing = buildReports(state, wat('2028-02-02T09:00:00')).billing;
  assert.equal(billing.totalKobo, null); assert.equal(billing.pricingReady, false);
  assert.equal(billing.nextInvoicePricingReady, false);
  assert.deepEqual(billing.lines, []);
  assert.equal(billing.unitEconomics.recurringKobo, null);
  assert.equal(billing.unitEconomics.annualisedRecurringRevenueKobo, null);
  checks += 8;
}

// The funded contract may cover a different year; the server records the review and keeps its exact evidence on the invoice.
{
  const { state, collection } = fixture('contract-dates', '2028-05-01');
  const terms = recordsOf(state, 'commercial')[0]!;
  const edit = structuredClone(terms);
  Object.assign(edit.data, { discountStartDate: '2028-05-01', fullPriceStartDate: '2028-07-01', discountTermsReference: 'reviewed-pilot-and-bridge' });
  const ctx = finance(wat('2028-04-20T09:00:00'));
  validateRecord(state, ctx, 'commercial', edit, true);
  Object.assign(terms.data, edit.data);
  assert.equal(terms.data.discountReview?.reviewedBy, ctx.actor);
  assert.equal(terms.data.discountReview?.reviewedAt, ctx.now);
  collection('CONTRACT-RECEIPT', wat('2028-05-10T09:00:00'));
  const may = invoiceFor(state, '2028-05', wat('2028-06-02T09:00:00'));
  assert.equal(may.data.designPartnerDiscount?.rate, 0.5);
  assert.match(may.data.designPartnerDiscount?.note ?? '', /full price from 2028-07-01/);
  assert.deepEqual(may.data.terms?.discountReview, terms.data.discountReview);
  const immutable = structuredClone(may);
  assert.equal(invoiceFor(state, '2028-06', wat('2028-07-02T09:00:00')).data.designPartnerDiscount?.rate, 0.5);
  assert.equal(invoiceFor(state, '2028-07', wat('2028-08-02T09:00:00')).data.designPartnerDiscount?.rate, 0);
  assert.deepEqual(may, immutable, 'Later billing never reprices issued evidence');
  terms.data.fullPriceStartDate = '2028-09-01';
  assert.throws(() => invoiceFor(state, '2028-08', wat('2028-09-02T09:00:00')), /review.*discount dates/i, 'A persisted date changed outside its review cannot reuse stale review evidence');
  assert.deepEqual(may, immutable);
  checks += 10;
}

// Dates are reviewed by an authorised writer, never by a supplied identity or an inferred calendar.
{
  const { state } = fixture('date-validation');
  const terms = recordsOf(state, 'commercial')[0]!;
  const changed = (patch: Record<string, unknown>) => ({ ...structuredClone(terms), data: { ...structuredClone(terms.data), ...patch } });
  for (const patch of [{ fullPriceStartDate: '2027-01-01' }, { discountStartDate: '2027-02-30' }, { discountStartDate: '2027-06-15' }, { discountTermsReference: '' }]) {
    assert.throws(() => validateRecord(state, finance(wat('2027-06-02T09:00:00')), 'commercial', changed(patch), true));
  }
  assert.throws(() => validateRecord(state, finance(wat('2027-06-02T09:00:00')), 'commercial', changed({ discountReview: { ...terms.data.discountReview, reviewedBy: 'Someone else' } }), true), /review identity/);
  assert.throws(() => validateRecord(state, ctxAt(wat('2027-06-02T09:00:00'), 'Read-only'), 'commercial', changed({ fullPriceStartDate: '2028-02-01' }), true), /read-only access/);
  const cleared = changed({ signedFullPriceTerms: false });
  validateRecord(state, finance(wat('2027-06-02T09:00:00')), 'commercial', cleared, true);
  assert.equal(cleared.data.discountReview, undefined);
  const untouched = structuredClone(terms);
  validateRecord(state, finance(wat('2027-06-02T09:00:00')), 'commercial', untouched, true);
  assert.deepEqual(untouched.data.discountReview, terms.data.discountReview, 'Unrelated edits retain the original review time');
  checks += 8;
}

// Persisted legacy JSON did not validate these formerly unknown commercial
// fields on read. Malformed review evidence must request review, not crash
// the reports page or be copied into newly issued invoice evidence.
{
  const { state: baseline } = fixture('malformed-review');
  baseline.settings.billingPeriod = '2027-06';
  const review = structuredClone(recordsOf(baseline, 'commercial')[0]!.data.discountReview!);
  const malformed: Array<[string, Record<string, unknown>]> = [
    ['numeric reviewer', { discountReview: { ...review, reviewedBy: 42 } }],
    ['numeric review timestamp', { discountReview: { ...review, reviewedAt: 42 } }],
    ['array review timestamp', { discountReview: { ...review, reviewedAt: ['2027-01-01'] } }],
    ['array review', { discountReview: [review] }],
    ['scalar review', { discountReview: 'reviewed' }],
    ['malformed review date', { discountReview: { ...review, discountStartDate: ['2027-01-01'] } }],
    ['malformed review reference', { discountReview: { ...review, termsReference: 42 } }],
    ['malformed contract date', { discountStartDate: 42 }],
    ['malformed contract reference', { discountTermsReference: ['synthetic-agreement'] }],
  ];
  for (const [label, patch] of malformed) {
    const state = structuredClone(baseline);
    Object.assign(recordsOf(state, 'commercial')[0]!.data, patch);
    const before = structuredClone(state);
    const billing = buildReports(state, wat('2027-07-02T09:00:00')).billing;
    assert.equal(billing.pricingReady, false, `${label}: malformed stored evidence needs review`);
    assert.equal(billing.totalKobo, null, `${label}: no assumed price`);
    assert.throws(() => issueInvoice(state, finance(wat('2027-07-02T09:00:00')), { period: '2027-06' }), /review.*discount dates/i,
      `${label}: a documented pricing refusal, not an incidental TypeError`);
    assert.deepEqual(state, before, `${label}: refusal and report preserve historical state`);
    checks += 4;
  }
  const state = structuredClone(baseline);
  Object.assign(recordsOf(state, 'commercial')[0]!.data, { designPartner: false, discountReview: { reviewedBy: 42 } });
  const before = structuredClone(state);
  const invoice = invoiceFor(state, '2027-06', wat('2027-07-02T09:00:00'));
  assert.equal(invoice.data.designPartnerDiscount.rate, 0, 'ordinary commercial terms retain public pricing');
  assert.equal(invoice.data.terms!.discountReview, undefined, 'an irrelevant malformed legacy review is never issued as invoice evidence');
  assert.deepEqual(recordsOf(state, 'commercial'), recordsOf(before, 'commercial'), 'issuing an invoice does not rewrite legacy terms');
  checks += 3;
}

// ---------- BIL-04: the first invoice: licence from the signed terms, one usage line per billable collection, discount, VAT shown ----------
{
  const { state, collection } = fixture("invoice-first");
  const paid = collection("PSK-1", wat("2027-06-10T06:20:00"));
  collection("PSK-2", wat("2027-06-28T06:20:00")); // inside the seven-day reversal window at the invoice date
  const invoice = invoiceFor(state, "2027-06", wat("2027-07-01T09:00:00"));
  assert.equal(invoice.kind, "invoices"); assert.equal(invoice.status, "issued"); assert.equal(invoice.reference, "INV-2027-06-001");
  assert.equal(invoice.data.collectionsCounted, 1, "the collection still inside its reversal window is not counted");
  assert.equal(invoice.data.usageLines[0].paymentId, paid.id);
  assert.equal(invoice.data.usageLines[0].feeKobo, 7_500, "0.3% of NGN 25,000");
  assert.deepEqual([invoice.data.usageLines[0].discountRate, invoice.data.usageLines[0].chargedKobo], [0.5, 3_750], "the line keeps the discount it was billed under and what it charged");
  assert.equal(invoice.data.licence.kobo, LICENCE, "the contracted licence is billed");
  assert.equal(invoice.data.licence.tierMismatch, true, "one collection is the entry tier; the contract governs and the mismatch is shown");
  assert.equal(invoice.data.designPartnerDiscount.kobo, -Math.floor((LICENCE + 7_500) / 2), "50% design-partner discount in 2027");
  const net = LICENCE + 7_500 - Math.floor((LICENCE + 7_500) / 2);
  assert.equal(invoice.data.totals.netKobo, net);
  assert.equal(invoice.data.totals.vatBps, 750);
  assert.equal(invoice.data.totals.vatKobo, Math.trunc(net * 0.075), "VAT at 7.5% shown separately");
  assert.equal(invoice.data.totals.totalKobo, net + Math.trunc(net * 0.075));
  assert.equal(invoice.amountKobo, invoice.data.totals.totalKobo);
  assert.equal(invoice.data.adjustments.length, 0);
  assert.equal(invoice.data.recoveryFee.enabled, false, "BIL-03: the recovery fee is gated off");
  assert.match(invoice.data.recoveryFee.note, /recorded as proven/);
  assert.throws(() => invoiceFor(state, "2027-06", wat("2027-07-02T09:00:00")), /already been issued/, "one invoice per period; corrections are adjustment lines");
  assert.throws(() => invoiceFor(state, "2027-05", wat("2027-07-02T09:00:00")), /period order/);
  assert.throws(() => issueInvoice(state, finance(wat("2027-07-02T09:00:00")), { period: "2027-08" }), /future period/);
  assert.throws(() => issueInvoice(state, finance(wat("2027-07-02T09:00:00")), { period: "June" }), /YYYY-MM/);
  assert.throws(() => executeAction(state, ctxAt(wat("2027-07-02T09:00:00"), "Operations"), { action: "issue_invoice", reason: "x", data: { period: "2027-07" } }), /not permitted/);
  assert.throws(() => invoiceFor(state, "2027-07", wat("2027-07-31T23:30:00")), /once the month has ended/, "a month is invoiced only after it has ended");
  checks += 22;

  // The withheld collection is billed on the next invoice once its window has passed; the issued invoice is immutable.
  const next = invoiceFor(state, "2027-07", wat("2027-08-01T00:30:00")); // July ended at midnight WAT
  assert.equal(next.reference, "INV-2027-07-002");
  assert.equal(next.data.collectionsCounted, 1);
  assert.equal(next.data.usageLines[0].paymentReference, "PSK-2", "billed once, on the first invoice after its reversal window closed");
  const before = structuredClone(state);
  invoice.data.totals.totalKobo = 1;
  assert.throws(() => assertFinalState(before, state, state.merchant.id), /immutable/, "issued invoices are never edited");
  invoice.data.totals.totalKobo = before.records.find((item) => item.id === invoice.id)!.data.totals.totalKobo;
  checks += 4;
}

// ---------- BIL-07: a reversal, a refund, a confirmed duplicate and a wrong allocation after billing are credit lines on the next invoice, with references ----------
{
  const { state, collection } = fixture("adjustments");
  const reversed = collection("PSK-R", wat("2027-06-05T06:20:00"));
  const refunded = collection("PSK-F", wat("2027-06-06T06:20:00"));
  const duplicate = collection("PSK-D", wat("2027-06-07T06:20:00"));
  const wrong = collection("PSK-W", wat("2027-06-08T06:20:00"));
  const untouched = collection("PSK-U", wat("2027-06-09T06:20:00"));
  const first = invoiceFor(state, "2027-06", wat("2027-07-01T09:00:00"));
  assert.equal(first.data.collectionsCounted, 5);
  assert.deepEqual(pendingAdjustments(state), [], "nothing to adjust right after issue");
  const reconciled = () => buildOverview(state, wat("2027-07-10T09:00:00")).metrics.find((item) => item.key === "settled")!.value;
  const reconciledBefore = reconciled();
  reversed.data.reversalStatus = "reversed";
  refunded.data.refundStatus = "refunded";
  makeRecord(state, "exceptions", { name: "dup", status: "resolved", customerId: duplicate.customerId, data: { type: "suspected_duplicate", linkedRecordId: duplicate.id, resolutionCode: "confirmed_duplicate_refund", owner: "Finance", severity: "medium" } });
  supersedeAllocation(state, finance(wat("2027-07-10T09:00:00")), recordsOf(state, "allocations").find((item) => item.data.paymentId === wrong.id)!, "Precision audit: wrong match");
  assert.equal(reconciled(), reconciledBefore - 7_500_000, "the overview reads the same applied money as billing: the reversed, refunded and wrongly allocated collections leave it");
  const pending = pendingAdjustments(state);
  // Each fee was billed at the 2027 design-partner rate, so each credit is the NGN 37.50 charged, not the NGN 75 public fee.
  // PSK-F's refund was recorded without an amount, as refunds were before refundedKobo existed: it is read as the whole payment.
  assert.deepEqual(pending.map((line) => [line.paymentReference, line.reason, line.kobo]), [["PSK-D", "confirmed_duplicate", -3_750], ["PSK-F", "refund", -3_750], ["PSK-R", "reversal", -3_750], ["PSK-W", "wrong_allocation", -3_750]], "one credit per affected collection, the untouched one is not adjusted");
  assert.ok(pending.every((line) => line.originalInvoiceId === first.id && line.originalInvoiceReference === first.reference), "every line references the invoice it corrects");
  assert.match(pending[2]!.explanation, /PSK-R .*at the 50% design-partner discount.*reversed by the provider.*credit of NGN 37\.50/);
  assert.deepEqual([pending[2]!.feeDeltaKobo, pending[2]!.discountRate, pending[2]!.billedChargedKobo], [-7_500, 0.5, 3_750], "the line shows the public fee it takes off and the rate it was billed at");
  assert.ok(pending[3]!.allocationIds.length >= 1, "the superseded allocation is referenced");
  assert.equal(buildReports(state, wat("2027-07-15T09:00:00")).billing.pendingAdjustmentsKobo, -15_000, "the statement shows what the next invoice will carry");
  checks += 8;

  const second = invoiceFor(state, "2027-07", wat("2027-08-01T09:00:00"));
  assert.equal(second.data.adjustments.length, 4);
  assert.equal(second.data.subtotals.adjustmentsKobo, -15_000);
  assert.equal(second.data.collectionsCounted, 0, "no new collections in July");
  assert.equal(second.data.subtotals.licenceKobo, LICENCE);
  assert.equal(second.data.designPartnerDiscount.kobo, -LICENCE / 2, "the discount applies to this invoice's licence; the credits already carry the rate they were billed at");
  assert.equal(second.data.totals.netKobo, LICENCE / 2 - 15_000);
  assert.equal(first.data.adjustments.length, 0, "the first invoice is untouched");
  assert.deepEqual(pendingAdjustments(state), [], "adjustments are billed once");
  checks += 8;

  // A wrong match re-allocated at a higher value is a debit line; re-allocated at the same value there is nothing to adjust.
  wrong.status = "allocated"; wrong.data.allocatedKobo = 4_000_000; wrong.amountKobo = 4_000_000;
  const debit = pendingAdjustments(state);
  assert.deepEqual(debit.map((line) => [line.paymentReference, line.reason, line.kobo]), [["PSK-W", "re_allocation", 6_000]], "usage on NGN 40,000 is NGN 120, charged at 50% as it was first billed, nothing billed net so far");
  const third = invoiceFor(state, "2027-08", wat("2027-09-01T09:00:00"));
  assert.equal(third.data.subtotals.adjustmentsKobo, 6_000);
  assert.equal(third.data.adjustments[0].originalInvoiceReference, first.reference, "still references the invoice that first billed the collection");
  assert.deepEqual(pendingAdjustments(state), []);
  void untouched;
  checks += 4;

  // A credit note: adjustments larger than the month's charges give a negative net with negative VAT, never an edit to the issued invoice.
  const { state: creditState, collection: creditCollection } = fixture("credit-note");
  recordsOf(creditState, "commercial")[0]!.data.signed = false; // no licence
  const big = creditCollection("PSK-BIG", wat("2027-06-05T06:20:00"), 10_000_000);
  invoiceFor(creditState, "2027-06", wat("2027-07-01T09:00:00"));
  big.data.reversalStatus = "reversed";
  const note = invoiceFor(creditState, "2027-07", wat("2027-08-01T09:00:00"));
  assert.equal(note.data.totals.netKobo, -15_000, "the capped NGN 150 fee is credited");
  assert.equal(note.data.totals.vatKobo, -1_125);
  assert.equal(note.data.totals.creditNote, true);
  assert.equal(note.amountKobo, 0, "record amounts stay non-negative; the credit is in the totals");
  checks += 4;
}

// ---------- BIL-04: months are West Africa Time: a collection at 00:30 WAT on 1 January is January's, and so is the default period at 00:30 WAT on 1 February ----------
{
  const { state, collection } = fixture("wat-months", "2027-12-01");
  collection("PSK-NYE", wat("2027-12-31T23:30:00"));
  collection("PSK-NY", wat("2028-01-01T00:30:00"));
  const december = invoiceFor(state, "2027-12", wat("2028-01-09T09:00:00"));
  assert.deepEqual(december.data.usageLines.map((line: any) => line.paymentReference), ["PSK-NYE"], "the collection at 00:30 WAT on 1 January is not December's");
  assert.equal(december.data.periodEnd, "2027-12-31T22:59:59.999Z", "December ends at midnight WAT");
  const january = executeAction(state, finance(wat("2028-02-01T00:30:00")), { action: "issue_invoice", reason: "month end" }).record!;
  assert.equal(january.data.period, "2028-01", "with no period given, the invoice is for the WAT month that has just ended");
  assert.deepEqual(january.data.usageLines.map((line: any) => line.paymentReference), ["PSK-NY"]);
  checks += 4;
}

// ---------- BIL-07: a correction is priced at the rate of the invoice that first billed the collection ----------
{
  const { state, collection } = fixture("adjustment-rates", "2026-12-01");
  // Billed at the public price in 2026 and reversed in 2027: the whole fee is credited, not half of it.
  const fullPrice = collection("PSK-2026", wat("2026-12-10T06:20:00"), 10_000_000);
  const december2026 = invoiceFor(state, "2026-12", wat("2027-01-09T09:00:00"));
  fullPrice.data.reversalStatus = "reversed";
  const january2027 = invoiceFor(state, "2027-01", wat("2027-02-01T09:00:00"));
  assert.deepEqual(january2027.data.adjustments.map((line: any) => [line.paymentReference, line.reason, line.kobo]), [["PSK-2026", "reversal", -15_000]], "the capped NGN 150 fee billed in full is credited in full");
  assert.equal(january2027.data.totals.netKobo, LICENCE / 2 - 15_000, "the 2027 discount halves the licence, not the credit for a fee billed at the public price");
  assert.equal(january2027.data.designPartnerDiscount.kobo, -LICENCE / 2);
  // February to November are quiet months, invoiced in order all the same.
  for (let month = 2; month <= 11; month++) invoiceFor(state, `2027-${String(month).padStart(2, "0")}`, wat(`2027-${String(month + 1).padStart(2, "0")}-01T09:00:00`));
  // Billed at half price in 2027 and corrected in 2028: the credit is what was charged, and a debit is charged at the same rate.
  const reversed = collection("PSK-2027", wat("2027-12-10T06:20:00"), 10_000_000);
  const raised = collection("PSK-UP", wat("2027-12-11T06:20:00"));
  const december2027 = invoiceFor(state, "2027-12", wat("2028-01-09T09:00:00"));
  reversed.data.reversalStatus = "reversed";
  raised.amountKobo = 4_000_000; raised.data.allocatedKobo = 4_000_000;
  const january2028 = invoiceFor(state, "2028-01", wat("2028-02-01T09:00:00"));
  assert.deepEqual(january2028.data.adjustments.map((line: any) => [line.paymentReference, line.reason, line.kobo]), [["PSK-2027", "reversal", -7_500], ["PSK-UP", "re_allocation", 2_250]], "the NGN 75 charged is credited, not the NGN 150 public fee; the increase is debited at 50% (NGN 60 less the NGN 37.50 charged)");
  assert.equal(january2028.data.totals.netKobo, LICENCE - 7_500 + 2_250, "2028 is at the public price, and nothing discounts the corrections again");
  assert.equal(january2028.data.designPartnerDiscount.kobo, 0);
  // Each line records the rate it was billed at, the public fee, what it charged, and the fee change a correction carries.
  assert.deepEqual([december2026.data.usageLines[0].feeKobo, december2026.data.usageLines[0].discountRate, december2026.data.usageLines[0].chargedKobo], [15_000, 0, 15_000]);
  assert.deepEqual(december2027.data.usageLines.map((line: any) => [line.paymentReference, line.feeKobo, line.discountRate, line.chargedKobo]), [["PSK-2027", 15_000, 0.5, 7_500], ["PSK-UP", 7_500, 0.5, 3_750]]);
  assert.deepEqual(january2028.data.adjustments.map((line: any) => [line.feeDeltaKobo, line.discountRate, line.billedChargedKobo]), [[-15_000, 0.5, 7_500], [4_500, 0.5, 3_750]]);
  assert.match(january2028.data.adjustments[0].explanation, /billed NGN 75\.00 on INV-2027-12-013 at the 50% design-partner discount\) was reversed by the provider after it was billed; credit of NGN 75\.00\./);
  assert.match(january2028.data.designPartnerDiscount.note, /Adjustment lines carry the rate of the invoice that first billed each collection/);
  assert.deepEqual(pendingAdjustments(state), [], "each correction is billed once");
  checks += 12;
}
{
  // Invoices issued before each line kept its rate: usage lines carry only the public fee, an adjustment line
  // only the public-price change, and the invoice's 50% discount applied to all of them. A credit returns what was charged.
  const { state, collection } = fixture("legacy-invoices");
  const whole = collection("PSK-LEG-A", wat("2027-04-10T06:20:00"), 10_000_000);
  const cut = collection("PSK-LEG-B", wat("2027-04-11T06:20:00"));
  const legacyInvoice = (period: string, data: Record<string, unknown>) => makeRecord(state, "invoices", { name: `Invoice ${period}`, status: "issued", reference: `INV-${period}-001`, createdAt: wat(`${period}-28T09:00:00`), data: { period, issuedAt: wat(`${period}-28T09:00:00`), usageLines: [], adjustments: [], designPartnerDiscount: { rate: 0.5, kobo: 0, note: "Design-partner discount of 50% in 2027." }, ...data } });
  const april = legacyInvoice("2027-04", { usageLines: [whole, cut].map((payment) => ({ paymentId: payment.id, paymentReference: payment.reference, allocatedKobo: payment.amountKobo, feeKobo: payment.amountKobo === 10_000_000 ? 15_000 : 7_500 })) });
  // PSK-LEG-B's allocation fell to NGN 10,000 in May: the old line carried the public-price change of NGN 45, which the invoice then halved.
  legacyInvoice("2027-05", { adjustments: [{ reason: "wrong_allocation", paymentId: cut.id, paymentReference: cut.reference, originalInvoiceId: april.id, originalInvoiceReference: april.reference, kobo: -4_500, billedFeeKobo: 7_500, currentFeeKobo: 3_000, billedAllocatedKobo: 2_500_000, currentAllocatedKobo: 1_000_000, allocationIds: [], explanation: "legacy" }] });
  whole.data.reversalStatus = "reversed"; cut.data.reversalStatus = "reversed";
  assert.deepEqual(pendingAdjustments(state).map((line) => [line.paymentReference, line.reason, line.kobo, line.discountRate, line.billedChargedKobo, line.billedFeeKobo]),
    [["PSK-LEG-A", "reversal", -7_500, 0.5, 7_500, 15_000], ["PSK-LEG-B", "reversal", -1_500, 0.5, 1_500, 3_000]],
    "the capped fee charged at half is credited as NGN 75; the NGN 37.50 charged less the NGN 22.50 already credited leaves NGN 15");
  const june = invoiceFor(state, "2027-06", wat("2027-07-01T09:00:00"));
  assert.equal(june.data.totals.netKobo, LICENCE / 2 - 9_000, "the credits are not discounted again");
  checks += 2;
}

// ---------- BIL-01 and BIL-07: a refund returns what the payment had not applied, so the fee on the money that stayed still stands ----------
{
  const { state, collection } = fixture("refund-excess");
  /** A NGN 30,000 direct debit with NGN 25,000 applied to its instalment and NGN 5,000 of excess. */
  const overpaid = (reference: string, observedAt: string) => {
    const payment = collection(reference, observedAt, 3_000_000);
    payment.status = "overpaid"; payment.data.allocatedKobo = 2_500_000;
    recordsOf(state, "allocations").find((item) => item.data.paymentId === payment.id)!.amountKobo = 2_500_000;
    return payment;
  };
  const refund = (payment: ValopayRecord, now: string) => executeAction(state, finance(now), { action: "record_refund", recordId: payment.id, reason: "Excess returned to the payer", data: { reference: `RF-${payment.reference}` } });
  const over = overpaid("PSK-OVER", wat("2027-06-10T06:20:00"));
  const june = invoiceFor(state, "2027-06", wat("2027-07-01T09:00:00"));
  assert.deepEqual(june.data.usageLines.map((line: any) => [line.paymentReference, line.allocatedKobo, line.feeKobo]), [["PSK-OVER", 2_500_000, 7_500]]);
  refund(over, wat("2027-07-03T11:00:00"));
  assert.deepEqual(pendingAdjustments(state), [], "the NGN 25,000 that stayed on its instalment is still billed, so nothing is credited");
  // Refunded before it was invoiced: the collection is billed on the money that stayed.
  const early = overpaid("PSK-EARLY", wat("2027-07-05T06:20:00"));
  refund(early, wat("2027-07-06T10:00:00"));
  const july = invoiceFor(state, "2027-07", wat("2027-08-01T09:00:00"));
  assert.deepEqual(july.data.usageLines.map((line: any) => [line.paymentReference, line.allocatedKobo, line.feeKobo]), [["PSK-EARLY", 2_500_000, 7_500]], "a refunded excess does not make the collection unbillable");
  assert.equal(july.data.adjustments.length, 0);
  assert.deepEqual([over.data.refundedKobo, early.data.refundedKobo], [500_000, 500_000], "each refund records what went back");
  checks += 5;
}

// ---------- BIL-01: a direct debit whose settlement line arrived without its webhook succeeded, so it is withheld inside its window and then billed ----------
{
  const { state, collection } = fixture("settled-only", "2027-07-01");
  const settled = collection("PSK-SETTLED", wat("2027-06-28T06:20:00"));
  settled.data.collectionStatus = "received"; // stored before a settlement line set it to succeeded
  state.settings.billingPeriod = "2027-06";
  assert.equal(buildReports(state, wat("2027-06-30T09:00:00")).billing.withheldInsideReversalWindow, 1, "inside its reversal window it is withheld, not lost");
  const july = invoiceFor(state, "2027-07", wat("2027-08-01T09:00:00"));
  assert.deepEqual(july.data.usageLines.map((line: any) => line.paymentReference), ["PSK-SETTLED"], "billed once its window has passed");
  settled.data.collectionStatus = "failed";
  assert.equal(buildReports(state, wat("2027-06-30T09:00:00")).billing.withheldInsideReversalWindow, 0, "a failed collection is never billed, whatever its settlement says");
  checks += 3;
}

// ---------- BIL-03: the recovery fee is billed only after the 30-day window closes, engine arm only, and only when the gate is open ----------
{
  const { state } = fixture("recovery");
  const customer = recordsOf(state, "customers")[1]!;
  const due = makeRecord(state, "due-items", { name: "recovered", status: "paid", customerId: customer.id, amountKobo: 2_500_000, reference: "DUE-REC", data: { dueDate: "2027-06-01", owner: "valopay", outstandingKobo: 0, experimentArm: "engine", experimentId: "x", firstFailureAt: wat("2027-06-10T06:16:00") } });
  makeRecord(state, "attempts", { name: "retry", status: "succeeded", customerId: customer.id, amountKobo: 2_500_000, data: { dueItemId: due.id, number: 2, source: "valo", occurredAt: wat("2027-06-12T06:16:00") } });
  const gated = invoiceFor(state, "2027-06", wat("2027-07-01T09:00:00"));
  assert.equal(gated.data.recoveryFee.enabled, false);
  assert.equal(gated.data.subtotals.recoveryKobo, 0);
  state.settings.recoveryFeeEnabled = true;
  assert.equal(issueInvoice(structuredClone(state), finance(wat("2027-08-01T09:00:00")), { period: "2027-07" }).data.recoveryFee!.enabled, false, "the flag alone does not open the gate");
  state.settings.recoveryFeeDecision = "proven";
  const july = invoiceFor(state, "2027-07", wat("2027-08-01T09:00:00"));
  assert.equal(july.data.recoveryFee.enabled, true);
  assert.equal(july.data.recoveryFee.lines.length, 1, "the window closed on 10 July, so July's invoice carries the fee, not June's");
  assert.equal(july.data.recoveryFee.lines[0].dueItemId, due.id);
  assert.equal(july.data.subtotals.recoveryKobo, 15_000);
  const august = invoiceFor(state, "2027-08", wat("2027-09-01T09:00:00"));
  assert.equal(august.data.recoveryFee.lines.length, 0, "billed once");
  checks += 8;
}

// ---------- BIL-04: every month is invoiced, in order: a skipped month is refused, naming the month to issue first, and a quiet month gets a zero invoice ----------
{
  const { state, collection } = fixture("sequence", "2027-01-01");
  const statement = (now: string) => buildReports(state, now).billing;
  assert.throws(() => invoiceFor(state, "2027-03", wat("2027-04-03T10:00:00")), /issue the invoice for 2027-01 first/, "the first invoice is for the month the signed terms took effect, so no licensed month is passed over");
  assert.equal(statement(wat("2027-04-03T10:00:00")).nextInvoicePeriod, "2027-01", "the statement names the month the first invoice covers");
  collection("PSK-JAN", wat("2027-01-10T06:20:00"));
  const january = invoiceFor(state, "2027-01", wat("2027-02-03T10:00:00"));
  assert.throws(() => invoiceFor(state, "2027-03", wat("2027-04-03T10:00:00")), /issue the invoice for 2027-02 first/, "March after January is refused, so February is never left behind");
  assert.equal(statement(wat("2027-04-03T10:00:00")).nextInvoicePeriod, "2027-02");
  const february = invoiceFor(state, "2027-02", wat("2027-04-03T10:00:00"));
  assert.deepEqual([february.data.collectionsCounted, february.data.licence.kobo, february.data.totals.netKobo], [0, LICENCE, LICENCE / 2], "a month with no collections still bills its licence");
  const march = invoiceFor(state, "2027-03", wat("2027-04-03T11:00:00"));
  assert.deepEqual([january, february, march].map((invoice) => invoice.reference), ["INV-2027-01-001", "INV-2027-02-002", "INV-2027-03-003"]);
  assert.throws(() => invoiceFor(state, "2027-02", wat("2027-04-03T12:00:00")), /already been issued/);
  assert.equal(statement(wat("2027-04-03T12:00:00")).nextInvoicePeriod, "2027-04");
  checks += 8;

  // With no signed terms and nothing to bill, the month still gets its invoice, for zero.
  const quiet = fixture("quiet-month").state;
  recordsOf(quiet, "commercial")[0]!.data.signed = false;
  const zero = invoiceFor(quiet, "2027-06", wat("2027-07-01T09:00:00"));
  assert.deepEqual([zero.data.collectionsCounted, zero.data.licence.kobo, zero.data.totals.netKobo, zero.data.totals.vatKobo, zero.data.totals.totalKobo, zero.amountKobo], [0, 0, 0, 0, 0, 0], "a quiet month gets an explicit zero invoice");
  assert.throws(() => invoiceFor(quiet, "2027-08", wat("2027-09-01T09:00:00")), /issue the invoice for 2027-07 first/);
  checks += 2;
}

// ---------- BIL-02: the licence comes from the lender's latest signed terms in effect in the month, found by the lender's id, for the whole month ----------
{
  const { state } = fixture("terms", "2027-05-01");
  const original = recordsOf(state, "commercial")[0]!;
  state.merchant.name = "Renamed Lender Ltd"; // the terms keep the name they were signed under: the lender's id links them
  // Another lender's signed terms never bill this one, nor move where its invoices start.
  state.records.push({ ...structuredClone(original), id: "other-lender-terms", merchantId: "other-lender", data: { ...structuredClone(original.data), licenceKobo: 1_000, effectiveDate: "2027-01-01" } });
  // A renewal at the Standard price from 15 July, at the full price (not a design partner), and an unsigned proposal from August.
  const renewal = makeRecord(state, "commercial", { name: "Licence renewal", status: "signed", createdAt: wat("2027-06-20T09:00:00"), data: { ...structuredClone(original.data), licenceKobo: 35_000_000, effectiveDate: "2027-07-15", signed: true, designPartner: false } });
  makeRecord(state, "commercial", { name: "Proposal", status: "discovery", createdAt: wat("2027-07-20T09:00:00"), data: { ...structuredClone(original.data), licenceKobo: 15_000_000, effectiveDate: "2027-08-01", signed: false } });
  const [may, june, july, august] = [["2027-05", "2027-06-01"], ["2027-06", "2027-07-01"], ["2027-07", "2027-08-01"], ["2027-08", "2027-09-01"]].map(([period, day]) => invoiceFor(state, period!, wat(`${day}T09:00:00`)));
  const billedBy = (invoice: ValopayRecord) => [invoice.data.terms?.commercialId, invoice.data.licence.kobo, invoice.data.designPartnerDiscount.rate, invoice.data.totals.netKobo];
  assert.deepEqual([may!, june!].map(billedBy), [[original.id, LICENCE, 0.5, LICENCE / 2], [original.id, LICENCE, 0.5, LICENCE / 2]], "the signed design-partner terms bill May and June at half price, though the lender was renamed");
  assert.deepEqual([july!, august!].map(billedBy), [[renewal.id, 35_000_000, 0, 35_000_000], [renewal.id, 35_000_000, 0, 35_000_000]], "the renewal, not a design partner's, bills all of July from its effective month with no proration, and the unsigned proposal bills nothing");
  state.settings.billingPeriod = "2027-09";
  assert.deepEqual(buildReports(state, wat("2027-09-15T09:00:00")).billing.lines.map((line: any) => [line.commercialId, line.contractedLicenceKobo, line.designPartnerDiscount]), [[renewal.id, 35_000_000, false]], "the statement shows the terms that bill the month");
  checks += 3;
}

// ---------- BIL-01: the reversal window runs from settlement ----------
{
  const { state, collection } = fixture("window-from-settlement", "2027-03-01");
  const late = collection("PSK-SETTLED-LATE", wat("2027-03-01T07:00:00"));
  late.data.settledAt = wat("2027-03-07T07:00:00"); // collected on 1 March, paid out on 7 March
  assert.equal(billableCollection(state, late, wat("2027-03-08T08:00:00")), false, "a day after settlement it is inside the seven-day window, though it was collected a week before");
  assert.equal(billableCollection(state, late, wat("2027-03-14T07:00:00")), true, "seven days after settlement it can be billed");
  const unrecorded = collection("PSK-NO-SETTLED-AT", wat("2027-03-02T07:00:00"));
  delete unrecorded.data.settledAt; // settled before its settlement time was kept: the window runs from when it was observed
  assert.equal(billableCollection(state, unrecorded, wat("2027-03-09T07:00:00")), true);
  state.settings.billingPeriod = "2027-03";
  assert.equal(buildReports(state, wat("2027-03-10T09:00:00")).billing.withheldInsideReversalWindow, 1, "withheld while inside its window from settlement");
  const march = invoiceFor(state, "2027-03", wat("2027-04-01T09:00:00"));
  assert.deepEqual(march.data.usageLines.map((line: any) => [line.paymentReference, line.settledAt]), [["PSK-SETTLED-LATE", wat("2027-03-07T07:00:00")], ["PSK-NO-SETTLED-AT", null]]);
  checks += 5;
}

// ---------- Second review finding 4: the statement's receipts by channel sum naira only and list other currencies beside them ----------
{
  const { state } = fixture("statement-currencies", "2027-07-01");
  const customer = recordsOf(state, "customers")[0]!;
  const receipt = (channel: "card" | "transfer", reference: string, amountKobo: number, currency?: string) => makeRecord(state, "payments", { name: reference, status: "unallocated", customerId: customer.id, amountKobo, reference, data: { channel, collectionStatus: "received", settlementStatus: "unsettled", observedAt: wat("2027-07-01T07:00:00"), reversalStatus: "none", refundStatus: "none", allocatedKobo: 0, ...(currency ? { currency } : {}) } });
  receipt("card", "CARD-USD-1", 100_000, "USD"); receipt("card", "CARD-NGN-1", 700_000); receipt("card", "CARD-EUR-1", 5_000, " eur "); receipt("transfer", "TRF-NGN-1", 300_000);
  state.settings.billingPeriod = "2027-07";
  const statement = buildReports(state, wat("2027-07-02T09:00:00")).billing;
  assert.deepEqual(statement.channelBreakdown.card, { count: 3, kobo: 700_000, otherCurrencies: { EUR: { count: 1, amount: 5_000 } , USD: { count: 1, amount: 100_000 } }, billable: 0, reason: "This payment is included in reconciliation reports but is not charged a collection fee." }, "every receipt counts; the naira value leaves the dollars and euros out and lists them beside it");
  assert.deepEqual([statement.channelBreakdown.transfer.count, statement.channelBreakdown.transfer.kobo, "otherCurrencies" in statement.channelBreakdown.transfer], [1, 300_000, false], "a channel with naira alone lists no other currency");
  checks += 2;
}

console.log(`Billing golden tests passed (${checks} checks): invoice lines, VAT, WAT months and period rules, every month invoiced in order with a zero invoice for a quiet one, the latest signed terms in effect found by the lender's id, withheld collections and the reversal window from settlement, adjustment credits and debits with references at the rate first billed, refunds of unapplied money, debits settled without a webhook, credit note, recovery fee gate and window, and receipts by channel in naira with other currencies beside them.`);
