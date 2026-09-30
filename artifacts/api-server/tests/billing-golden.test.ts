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
import type { Context, DomainState, TypedRecord, ValopayRecord } from "../src/domain/types.js";
import { validateRecord } from '../src/domain/validation.js';
import { termsReplaced } from "@workspace/valopay-schema";

const { assertFinalState } = await import("../src/lib/valopay-store.js");
let checks = 0;
const finance = (now: string) => ctxAt(now, "Finance");
const LICENCE = 60_000_000; // contracted Scale licence in the seed
const invoiceFor = (state: DomainState, period: string, now: string) => executeAction(state, finance(now), { action: "issue_invoice", reason: "month end", data: { period } }).record!;
/** A signed-in staff member: the actor is their account, the principal the person behind it. */
const staffAt = (name: string, role: string, now: string): Context => ({ actor: `Clerk:user_${name}`, principalId: `principal-${name}`, role, now, accessMode: 'staff' });
/** A second person confirms the dates the lender's terms propose, as confirm_discount_terms records it. */
function confirmTerms(state: DomainState, now: string, by = 'fixture_admin') {
  const terms = recordsOf(state, 'commercial')[0]!;
  return executeAction(state, staffAt(by, 'Admin', now), { action: 'confirm_discount_terms', recordId: terms.id, reason: 'Checked against the signed agreement',
    data: { discountStartDate: terms.data.discountStartDate, fullPriceStartDate: terms.data.fullPriceStartDate, discountTermsReference: terms.data.discountTermsReference } });
}

/** A seeded lender whose design-partner terms are signed from `effectiveDate`, so its first invoice is for that month or an earlier one. */
function fixture(id: string, effectiveDate = "2027-06-01", dates = { discountStartDate: '2027-01-01', fullPriceStartDate: '2028-01-01' }): { state: DomainState; collection: (reference: string, observedAt: string, amountKobo?: number) => TypedRecord<"payments"> } {
  const state = seedMerchant(id);
  const terms = recordsOf(state, "commercial")[0]!;
  terms.data.signed = true; terms.data.effectiveDate = effectiveDate;
  // These dates describe this fixture's reviewed agreement, not a platform calendar default.
  terms.data.signedFullPriceTerms = true;
  Object.assign(terms.data, dates);
  terms.data.discountTermsReference = 'synthetic-agreement';
  // One person saves the dates, proposing them; a different person confirms them.
  validateRecord(state, staffAt('fixture_finance', 'Finance', wat('2026-12-01T09:00:00')), 'commercial', terms);
  confirmTerms(state, wat('2026-12-02T09:00:00'));
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

// ---------- Review fix: a design-partner price that is not ready names its actual cause, in the same words everywhere ----------
{
  const state = seedMerchant('pricing-causes');
  const terms = recordsOf(state, 'commercial')[0]!;
  terms.data.signed = true; terms.data.effectiveDate = '2027-06-01';
  for (const payment of recordsOf(state, 'payments')) payment.data.channel = 'transfer';
  state.settings.billingPeriod = '2027-06';
  const now = wat('2027-07-02T09:00:00');
  /** An edit through the record API's checks; null removes a field, as a PATCH does. */
  const save = (patch: Record<string, unknown>) => {
    const edit = structuredClone(terms);
    for (const [key, value] of Object.entries(patch)) if (value === null) delete edit.data[key]; else edit.data[key] = value;
    validateRecord(state, finance(wat('2027-06-20T09:00:00')), 'commercial', edit, true);
    Object.assign(terms, edit);
  };
  /** The invoice refusal (409), the statement, the next invoice and the report give one cause in the same words. */
  const cause = () => {
    const before = structuredClone(state);
    let refusal: (Error & { status?: number }) | undefined;
    try { issueInvoice(state, finance(now), { period: '2027-06' }); } catch (error) { refusal = error as Error & { status?: number }; }
    assert.equal(refusal?.status, 409, 'the invoice is refused as a conflict with the terms');
    assert.deepEqual(state, before, 'a refused invoice changes nothing');
    const billing = buildReports(state, now).billing;
    assert.deepEqual([billing.pricingReady, billing.nextInvoicePricingReady, billing.totalKobo], [false, false, null]);
    assert.equal(billing.pricingExplanation, refusal!.message, 'the statement names the cause the refusal names');
    assert.equal(billing.nextInvoicePricingExplanation, refusal!.message, 'so does the next invoice');
    assert.ok(String(billing.unitEconomics.note).includes(refusal!.message), `the report names it too: ${billing.unitEconomics.note}`);
    checks += 7;
    return refusal!.message;
  };
  // Dates and reference saved without ticking “Full-price terms are signed”: the save succeeds, and the flag is the cause, not the dates.
  save({ signedFullPriceTerms: false, discountStartDate: '2027-01-01', fullPriceStartDate: '2028-01-01', discountTermsReference: 'SYN-CAUSES' });
  assert.equal(recordsOf(state, 'commercial')[0]!.data.discountReview, undefined, 'nothing is proposed while the full-price terms are not signed');
  const flag = cause();
  assert.match(flag, /^These design-partner terms cannot be used on a new invoice yet\. The full-price terms are not recorded as signed\. Tick “Full-price terms are signed”/);
  assert.doesNotMatch(flag, /missing|correcting|await/, 'the dates are complete and valid, so they are not blamed');
  // An agreement saved before the dates existed, with the flag ticked: the missing dates and reference are named.
  save({ signedFullPriceTerms: true, discountStartDate: null, fullPriceStartDate: null, discountTermsReference: null });
  assert.match(cause(), /The discount start date, the full-price start date and the signed agreement reference are missing\. Enter them from the signed agreement\.$/);
  // Neither the flag nor the dates: both causes, each in its own words.
  terms.data.signedFullPriceTerms = false;
  const both = cause();
  assert.match(both, /full-price terms are not recorded as signed.*The discount start date, the full-price start date and the signed agreement reference are missing/);
  // Stored before today's checks (written directly, not through the record API): a missing reference, a mid-month date, an unreadable date.
  Object.assign(terms.data, { signedFullPriceTerms: true, discountStartDate: '2027-01-01', fullPriceStartDate: '2028-01-01', discountTermsReference: ' ' });
  assert.match(cause(), /The signed agreement reference is missing\. Enter it from the signed agreement\.$/);
  Object.assign(terms.data, { discountTermsReference: 'SYN-CAUSES', discountStartDate: '2027-01-15' });
  assert.match(cause(), /The saved discount dates need correcting\. Each discount date must be the first day of a month, because a monthly invoice uses one price for the whole month\./);
  Object.assign(terms.data, { discountStartDate: 20270101 });
  assert.match(cause(), /Valo Pay cannot read the saved discount start date\. Enter it again from the signed agreement\.$/);
  // Proposed, then changed outside the record API: the proposal no longer matches the dates.
  terms.data.discountStartDate = '2027-01-01';
  save({ fullPriceStartDate: '2028-01-01' });
  assert.equal(terms.data.discountReview?.discountStartDate, '2027-01-01', 'saving complete signed terms records a proposal');
  terms.data.fullPriceStartDate = '2027-12-01';
  assert.match(cause(), /The discount dates or agreement reference changed after they were proposed\. Save the commercial terms again/);
  // A proposal stored in a form the service cannot read.
  Object.assign(terms.data, { fullPriceStartDate: '2028-01-01', discountReview: { ...terms.data.discountReview, reviewedBy: 42 } });
  assert.match(cause(), /Valo Pay cannot read the saved proposal or confirmation of these discount dates/);
  checks += 9;
}

// ---------- Review fix: design-partner pricing takes two people: one proposes the dates by saving them, a different one confirms them ----------
{
  const state = seedMerchant('two-people');
  const terms = recordsOf(state, 'commercial')[0]!;
  terms.data.signed = true; terms.data.effectiveDate = '2027-06-01';
  for (const payment of recordsOf(state, 'payments')) payment.data.channel = 'transfer';
  state.settings.billingPeriod = '2027-06';
  const now = wat('2027-07-02T09:00:00');
  /** A signed-in staff member: the actor is their account, the principal the person behind it. */
  const staff = (name: string, role: string, at = wat('2027-06-20T09:00:00')): Context => ({ actor: `Clerk:user_${name}`, principalId: `principal-${name}`, role, now: at, accessMode: 'staff' });
  const dates = { discountStartDate: '2027-01-01', fullPriceStartDate: '2028-01-01', discountTermsReference: 'SYN-TWO-PEOPLE' };
  const save = (ctx: Context, patch: Record<string, unknown>) => {
    const edit = structuredClone(terms);
    Object.assign(edit.data, patch);
    validateRecord(state, ctx, 'commercial', edit, true);
    Object.assign(terms, edit);
  };
  const confirm = (ctx: Context, data: Record<string, unknown> = dates) => executeAction(state, ctx, { action: 'confirm_discount_terms', recordId: terms.id, reason: 'Checked against the signed agreement', data });
  const billing = () => buildReports(state, now).billing;
  const refusedWith = (status: number, pattern: RegExp) => (error: unknown) => (error as { status?: number }).status === status && pattern.test((error as Error).message);
  const proposal = { reviewedBy: 'Clerk:user_ada', reviewedAt: wat('2027-06-20T09:00:00'), proposedPrincipal: 'principal-ada', discountStartDate: '2027-01-01', fullPriceStartDate: '2028-01-01', termsReference: 'SYN-TWO-PEOPLE' };

  // One person saves the dates. That is a proposal: it prices nothing until a different person confirms it.
  save(staff('ada', 'Finance'), { signedFullPriceTerms: true, ...dates });
  assert.equal(billing().nextInvoicePricingReady, false, 'the person who saved the dates cannot price an invoice alone');
  assert.throws(() => issueInvoice(state, finance(now), { period: '2027-06' }), refusedWith(409, /The discount dates are waiting for confirmation\. A different Admin or Finance team member must check them against the signed agreement/));
  assert.deepEqual(terms.data.discountReview, proposal, 'the service records who proposed the dates, which person that is, when, and what they proposed');
  // The proposer cannot confirm, in another role or under another account of the same person; nor can a role without the right.
  assert.throws(() => confirm(staff('ada', 'Admin')), refusedWith(403, /A different person must confirm these discount dates/));
  assert.throws(() => confirm({ ...staff('ada-second-login', 'Admin'), principalId: 'principal-ada' }), refusedWith(403, /A different person must confirm/));
  assert.throws(() => confirm(staff('olu', 'Operations')), /Only an Admin or Finance team member can confirm discount dates\./);
  // The confirmer names what they checked: dates that are not the proposal's are refused, and nothing is recorded.
  assert.throws(() => confirm(staff('bola', 'Admin'), { ...dates, fullPriceStartDate: '2027-12-01' }), refusedWith(409, /The proposed discount dates changed after you opened them\./));
  assert.throws(() => confirm(staff('bola', 'Admin'), { discountStartDate: '2027-01-01' }), (error: unknown) => (error as { issues?: Array<{ path: unknown[] }> }).issues?.some((issue) => issue.path.join('.') === 'data.fullPriceStartDate') === true);
  assert.deepEqual(terms.data.discountReview, proposal, 'refused confirmations record nothing');
  // A different person confirms: who, which person and when are recorded, and the confirmed dates price the month.
  const answer = confirm(staff('bola', 'Admin', wat('2027-06-21T10:00:00')));
  const confirmed = { ...proposal, confirmedBy: 'Clerk:user_bola', confirmedPrincipal: 'principal-bola', confirmedAt: wat('2027-06-21T10:00:00') };
  assert.deepEqual(terms.data.discountReview, confirmed);
  assert.equal(terms.updatedAt, wat('2027-06-21T10:00:00'));
  assert.match(answer.message, /confirmed/i);
  assert.deepEqual([billing().pricingReady, billing().nextInvoicePricingReady], [true, true]);
  assert.match(billing().nextInvoicePricingExplanation, /^50% design-partner discount for this billing month\. Confirmed agreement: discount from 1 Jan 2027; full price from 1 Jan 2028\.$/);
  assert.throws(() => confirm(staff('chi', 'Finance')), refusedWith(409, /already confirmed by Clerk:user_bola/));
  const ordinary = structuredClone(state);
  recordsOf(ordinary, 'commercial')[0]!.data.designPartner = false;
  assert.throws(() => executeAction(ordinary, staff('chi', 'Finance'), { action: 'confirm_discount_terms', recordId: terms.id, reason: 'Checked', data: dates }), refusedWith(409, /These terms are billed at the full public price, so there are no discount dates to confirm\./));
  // An edit that leaves the flags, dates and reference alone keeps the proposal and the confirmation.
  save(staff('ada', 'Finance', wat('2027-06-22T09:00:00')), { monthlyVolume: 4_321 });
  assert.deepEqual(terms.data.discountReview, confirmed, 'unrelated edits keep both');
  // Any change to them returns the terms to a proposal awaiting confirmation, by whoever saved it.
  save(staff('bola', 'Admin', wat('2027-06-23T09:00:00')), { fullPriceStartDate: '2027-12-01' });
  assert.deepEqual(terms.data.discountReview, { ...proposal, reviewedBy: 'Clerk:user_bola', reviewedAt: wat('2027-06-23T09:00:00'), proposedPrincipal: 'principal-bola', fullPriceStartDate: '2027-12-01' });
  assert.equal(billing().nextInvoicePricingReady, false, 'a changed date needs a new confirmation');
  assert.throws(() => confirm(staff('bola', 'Admin'), { ...dates, fullPriceStartDate: '2027-12-01' }), refusedWith(403, /different person/), 'the person who changed them cannot confirm the change');
  save(staff('ada', 'Finance', wat('2027-06-24T09:00:00')), { signedFullPriceTerms: false });
  assert.equal(recordsOf(state, 'commercial')[0]!.data.discountReview, undefined, 'unticking the full-price terms withdraws the proposal');
  save(staff('ada', 'Finance', wat('2027-06-24T10:00:00')), { signedFullPriceTerms: true });
  assert.deepEqual([terms.data.discountReview?.reviewedBy, terms.data.discountReview?.confirmedBy], ['Clerk:user_ada', undefined], 'ticking it again proposes the dates afresh');
  confirm(staff('bola', 'Admin', wat('2027-06-25T09:00:00')), { ...dates, fullPriceStartDate: '2027-12-01' });
  assert.equal(billing().nextInvoicePricingReady, true);
  // Confirmed dates changed outside the record API: the confirmation no longer matches them.
  terms.data.fullPriceStartDate = '2028-02-01';
  assert.throws(() => issueInvoice(state, finance(now), { period: '2027-06' }), refusedWith(409, /The discount dates or agreement reference changed after they were confirmed/));
  // No client supplies who proposed or who confirmed.
  terms.data.fullPriceStartDate = '2027-12-01';
  for (const forged of [{ ...terms.data.discountReview, confirmedBy: 'Clerk:user_zed' }, { ...proposal, confirmedBy: 'Clerk:user_zed', confirmedPrincipal: 'principal-zed', confirmedAt: now }, undefined]) {
    assert.throws(() => save(staff('ada', 'Finance'), { discountReview: forged }), /Valo Pay records who proposed and who confirmed the discount dates/);
  }
  // A review an earlier build recorded, by one person with no confirmation, is a proposal awaiting confirmation.
  const legacy = { reviewedBy: 'Clerk:user_ada', reviewedAt: '2026-09-29T10:00:00.000Z', discountStartDate: '2027-01-01', fullPriceStartDate: '2027-12-01', termsReference: 'SYN-TWO-PEOPLE' };
  terms.data.discountReview = structuredClone(legacy);
  assert.equal(billing().nextInvoicePricingReady, false, 'a single-person review from before this fix prices nothing');
  assert.match(billing().nextInvoicePricingExplanation, /waiting for confirmation/);
  assert.throws(() => confirm(staff('ada', 'Admin'), { ...dates, fullPriceStartDate: '2027-12-01' }), refusedWith(403, /different person/), 'its reviewer cannot confirm it');
  confirm(staff('bola', 'Admin', wat('2027-06-26T09:00:00')), { ...dates, fullPriceStartDate: '2027-12-01' });
  assert.deepEqual(terms.data.discountReview, { ...legacy, confirmedBy: 'Clerk:user_bola', confirmedPrincipal: 'principal-bola', confirmedAt: wat('2027-06-26T09:00:00') });
  const invoice = invoiceFor(state, '2027-06', now);
  assert.deepEqual([invoice.data.designPartnerDiscount.rate, invoice.data.terms?.discountReview], [0.5, terms.data.discountReview], 'the invoice keeps the proposal and its confirmation');
  checks += 34;
}
{
  // In a sandbox every demo role is its one visitor: switching roles is not a second person.
  const state = seedMerchant('sandbox-two-people');
  const terms = recordsOf(state, 'commercial')[0]!;
  const dates = { discountStartDate: '2027-01-01', fullPriceStartDate: '2028-01-01', discountTermsReference: 'SYN-SANDBOX' };
  // The sandbox's visitor as the service knows them (principalId), and a demo role without one, which stands for the visitor.
  const visitor = (role: string): Context => ({ ...ctxAt(wat('2027-06-20T09:00:00'), role), principalId: 'sandbox-visitor', accessMode: 'sandbox' });
  const propose = (ctx: Context, discountStartDate: string) => {
    const edit = structuredClone(terms);
    Object.assign(edit.data, { signed: true, signedFullPriceTerms: true, effectiveDate: '2027-06-01', ...dates, discountStartDate });
    validateRecord(state, ctx, 'commercial', edit, true);
    Object.assign(terms, edit);
  };
  const confirm = (ctx: Context) => () => executeAction(state, ctx, { action: 'confirm_discount_terms', recordId: terms.id, reason: 'Switched to Admin', data: { ...dates, discountStartDate: terms.data.discountStartDate } });
  const oneVisitor = (error: unknown) => (error as { status?: number }).status === 403 && /Switching demo roles is not a second person\./.test((error as Error).message);
  propose(visitor('Finance'), '2027-01-01');
  assert.equal(terms.data.discountReview?.proposedPrincipal, 'sandbox-visitor');
  assert.throws(confirm(visitor('Admin')), oneVisitor);
  propose(ctxAt(wat('2027-06-20T09:00:00'), 'Finance'), '2027-02-01');
  assert.equal(terms.data.discountReview?.proposedPrincipal, 'unidentified-demo-person', 'a demo role without a principal is recorded as the sandbox placeholder');
  assert.throws(confirm(ctxAt(wat('2027-06-20T09:00:00'), 'Admin')), oneVisitor);
  // A single-person review an earlier build recorded in a sandbox names no principal; its demo role is still the visitor.
  terms.data.discountReview = { reviewedBy: 'Sandbox Finance', reviewedAt: '2026-09-29T10:00:00.000Z', discountStartDate: '2027-02-01', fullPriceStartDate: '2028-01-01', termsReference: 'SYN-SANDBOX' };
  assert.throws(confirm(visitor('Admin')), oneVisitor);
  assert.equal(terms.data.discountReview.confirmedBy, undefined);
  checks += 6;
}

// ---------- Review fix: an issued invoice charged at another rate than the confirmed agreement gives is reported, never rewritten ----------
{
  // The signed agreement gives the discount from March 2027 until March 2028; earlier invoices were issued under the calendar-2027 rule.
  const { state } = fixture('rate-discrepancy', '2027-01-01', { discountStartDate: '2027-03-01', fullPriceStartDate: '2028-03-01' });
  const terms = recordsOf(state, 'commercial')[0]!;
  const calendarRule = (period: string, sequence: number, rate: number) => makeRecord(state, 'invoices', { name: `Invoice ${period}`, status: 'issued', reference: `INV-${period}-00${sequence}`, createdAt: wat(`${period}-28T09:00:00`),
    data: { period, issuedAt: wat(`${period}-28T09:00:00`), issuedBy: 'Sandbox Finance', sequence, usageLines: [], adjustments: [], terms: { commercialId: terms.id, prospect: terms.name, contractedLicenceKobo: LICENCE, designPartner: true, effectiveDate: '2027-01-01' },
      designPartnerDiscount: { rate, kobo: -LICENCE * rate, note: 'Design-partner discount of 50% in 2027 on the licence and this invoice’s usage lines.' }, totals: { netKobo: LICENCE * (1 - rate), vatBps: 750, vatKobo: 0, totalKobo: LICENCE * (1 - rate), creditNote: false } } });
  const issued = [calendarRule('2027-01', 1, 0.5), calendarRule('2027-02', 2, 0.5), calendarRule('2027-03', 3, 0.5)];
  const before = structuredClone(state.records);
  state.settings.billingPeriod = '2027-04';
  const statement = () => buildReports(state, wat('2027-05-02T09:00:00')).billing;
  const listed = () => (statement().rateDiscrepancies as Array<Record<string, any>> | undefined)?.map((line) => [line.invoiceId, line.invoiceReference, line.period, line.chargedRate, line.agreedRate]);
  assert.deepEqual(listed(), [[issued[0]!.id, 'INV-2027-01-001', '2027-01', 0.5, 0], [issued[1]!.id, 'INV-2027-02-002', '2027-02', 0.5, 0]], 'each month charged at another rate than the confirmed agreement gives is listed; March agrees');
  assert.equal(statement().rateDiscrepancies[0].explanation, `INV-2027-01-001 for January 2027 charged the 50% design-partner discount. A month uses the terms in effect at its end: for January 2027 those are “${terms.name}”, design-partner terms in effect from 1 Jan 2027, whose confirmed agreement synthetic-agreement gives the full public price.`);
  assert.match(statement().rateDiscrepancyGuidance, /An issued invoice never changes, and Valo Pay cannot correct an issued invoice’s discount/);
  assert.match(statement().rateDiscrepancyGuidance, /Adjustment lines on later invoices for a listed invoice’s collections, such as a re-allocation charge or a reversal credit, carry that invoice’s rate too\. Include them in what you agree\./);
  assert.match(statement().rateDiscrepancyGuidance, /Agree any difference with the lender outside Valo Pay/);
  assert.deepEqual(state.records, before, 'reporting a difference changes no invoice and creates no money');
  assert.equal(statement().pendingAdjustmentsKobo, 0, 'nothing is added to the next invoice automatically');
  // A new invoice can still be issued, priced from the confirmed dates, and agrees with them.
  const april = invoiceFor(state, '2027-04', wat('2027-05-02T09:00:00'));
  assert.deepEqual([april.reference, april.data.designPartnerDiscount.rate], ['INV-2027-04-004', 0.5]);
  assert.equal(listed()!.length, 2, 'the new invoice agrees with the agreement');
  // While changed dates await a second person nothing is compared: a proposal is not an agreement, and it gives no rate.
  const edit = structuredClone(terms);
  edit.data.fullPriceStartDate = '2028-04-01';
  validateRecord(state, staffAt('fixture_finance', 'Finance', wat('2027-05-03T09:00:00')), 'commercial', edit, true);
  Object.assign(terms.data, edit.data);
  assert.equal(statement().nextInvoicePricingReady, false, 'the changed dates await confirmation');
  assert.deepEqual(statement().rateDiscrepancies, [], 'no month is compared with dates that await confirmation');
  confirmTerms(state, wat('2027-05-04T09:00:00'));
  assert.equal(listed()!.length, 2, 'once confirmed, the same months differ again');
  checks += 13;
}

// ---------- Review follow-up: months billed by terms that replacement terms now govern are compared with the replacement's confirmed agreement, the terms in effect ----------
{
  const state = seedMerchant('replacement-terms');
  for (const payment of recordsOf(state, 'payments')) payment.data.channel = 'transfer';
  // Terms signed before contract dates existed, with none: January to March 2027 were invoiced under the calendar-2027 rule, at half price.
  const old = recordsOf(state, 'commercial')[0]!;
  Object.assign(old.data, { signed: true, effectiveDate: '2027-01-01', signedFullPriceTerms: true });
  const calendarRule = (period: string, sequence: number) => makeRecord(state, 'invoices', { name: `Invoice ${period}`, status: 'issued', reference: `INV-${period}-00${sequence}`, createdAt: wat(`${period}-28T09:00:00`),
    data: { period, issuedAt: wat(`${period}-28T09:00:00`), issuedBy: 'Sandbox Finance', sequence, usageLines: [], adjustments: [], terms: { commercialId: old.id, prospect: old.name, contractedLicenceKobo: LICENCE, designPartner: true, effectiveDate: '2027-01-01' },
      designPartnerDiscount: { rate: 0.5, kobo: -LICENCE / 2 }, totals: { netKobo: LICENCE / 2, vatBps: 750, vatKobo: 0, totalKobo: LICENCE / 2, creditNote: false } } });
  const issued = ['2027-01', '2027-02', '2027-03'].map((period, index) => calendarRule(period, index + 1));
  state.settings.billingPeriod = '2027-04';
  const statement = () => buildReports(state, wat('2027-05-02T09:00:00')).billing;
  const listed = () => (statement().rateDiscrepancies as Array<Record<string, any>>).map((line) => [line.invoiceId, line.period, line.chargedRate, line.agreedRate, line.commercialId]);
  assert.deepEqual(listed(), [], 'terms with no dates give no agreement to compare with');
  // The old terms may not even be saveable. Finance records the signed agreement as replacement terms (Add terms) from the same date, and a second person confirms them.
  const input: any = { name: 'Replacement terms', status: 'signed', reference: 'SYN-REPLACEMENT-TERMS', amountKobo: 0, customerId: '', createdAt: wat('2027-04-20T09:00:00'), updatedAt: wat('2027-04-20T09:00:00'),
    data: { signed: true, designPartner: true, signedFullPriceTerms: true, licenceKobo: LICENCE, effectiveDate: '2027-01-01', discountStartDate: '2027-03-01', fullPriceStartDate: '2028-03-01', discountTermsReference: 'SYN-REPLACEMENT', synthetic: true } };
  validateRecord(state, staffAt('fixture_finance', 'Finance', wat('2027-04-20T09:00:00')), 'commercial', input);
  const replacement = makeRecord(state, 'commercial', input);
  assert.deepEqual(listed(), [], 'replacement terms whose dates await a second person give no agreement to compare with');
  executeAction(state, staffAt('fixture_admin', 'Admin', wat('2027-04-21T09:00:00')), { action: 'confirm_discount_terms', recordId: replacement.id, reason: 'Checked against the signed agreement', data: { discountStartDate: '2027-03-01', fullPriceStartDate: '2028-03-01', discountTermsReference: 'SYN-REPLACEMENT' } });
  // January and February were billed by the old terms, which are not confirmed: the confirmed replacement, now in effect for those months, gives the full price. March agrees.
  assert.deepEqual(listed(), [[issued[0]!.id, '2027-01', 0.5, 0, replacement.id], [issued[1]!.id, '2027-02', 0.5, 0, replacement.id]], 'the months the replaced terms billed are compared with the confirmed terms now in effect');
  assert.equal(statement().rateDiscrepancies[0].explanation, 'INV-2027-01-001 for January 2027 charged the 50% design-partner discount. A month uses the terms in effect at its end: for January 2027 those are “Replacement terms”, design-partner terms in effect from 1 Jan 2027, whose confirmed agreement SYN-REPLACEMENT gives the full public price.');
  assert.match(statement().rateDiscrepancyGuidance, /Each invoice is compared with the terms in effect for its month now\. A month uses the terms in effect at its end, and ordinary terms give the full public price\. Invoices for a month whose design-partner terms are not confirmed yet are compared once their discount dates are confirmed\./);
  // Replacement terms that take effect later govern only their own months: January stays with the old terms, uncompared.
  replacement.data.effectiveDate = '2027-02-01';
  assert.deepEqual(listed(), [[issued[1]!.id, '2027-02', 0.5, 0, replacement.id]], 'a month the replacement does not govern is not compared');
  checks += 6;
}

// ---------- Review follow-up: the terms Go-live evidence treats as replaced (no note, no confirmation) are exactly the signed terms billing never reads ----------
{
  const state = seedMerchant('replaced-terms');
  const first = recordsOf(state, 'commercial')[0]!;
  Object.assign(first.data, { signed: true, designPartner: false, effectiveDate: '2027-01-01' });
  const add = (name: string, createdAt: string, data: Record<string, unknown>) => makeRecord(state, 'commercial', { name, status: 'signed', createdAt: wat(createdAt), data: { licenceKobo: LICENCE, ...data } });
  const laterThatMonth = add('Later the same month', '2027-01-02T09:00:00', { signed: true, effectiveDate: '2027-01-15' });
  add('Recorded first', '2027-02-01T09:00:00', { signed: true, effectiveDate: '2027-03-01' });
  const recordedLater = add('Recorded later', '2027-02-02T09:00:00', { signed: true, effectiveDate: '2027-03-01' });
  add('Unsigned, recorded last', '2027-02-03T09:00:00', { signed: false, effectiveDate: '2027-03-01' });
  const billedBy = ['2026-12', '2027-01', '2027-02', '2027-03', '2027-04'].map((period) => {
    state.settings.billingPeriod = period;
    return buildReports(state, wat('2027-05-02T09:00:00')).billing.lines[0]?.commercialId;
  });
  assert.deepEqual(billedBy, [undefined, laterThatMonth.id, laterThatMonth.id, recordedLater.id, recordedLater.id], 'each month is billed by the latest signed terms in effect by its end, the later recorded on the same date');
  const all = recordsOf(state, 'commercial');
  assert.deepEqual(all.filter((terms) => termsReplaced(terms, all)).map((terms) => terms.name), [first.name, 'Recorded first'], 'terms another signed record overtakes from their first month are replaced; unsigned terms replace nothing');
  checks += 2;
}

/**
 * Review follow-up 2: a lender whose first terms (from 1 January 2027, `data` merged in) billed `months` at `rate`, as
 * the earlier calendar-2027 rule issued them. With contract dates in `data`, one person proposed them and another
 * confirmed them. `listed` gives each rate difference as [month, charged, agreed, terms compared with].
 */
function billedUnder(id: string, data: Record<string, unknown>, months: string[], rate: number) {
  const state = seedMerchant(id);
  for (const payment of recordsOf(state, 'payments')) payment.data.channel = 'transfer';
  const first = recordsOf(state, 'commercial')[0]!;
  first.createdAt = wat('2026-12-01T09:00:00');
  Object.assign(first.data, { signed: true, signedFullPriceTerms: true, effectiveDate: '2027-01-01', ...data });
  if (first.data.discountTermsReference) {
    validateRecord(state, staffAt('fixture_finance', 'Finance', wat('2026-12-01T09:00:00')), 'commercial', first);
    confirmTerms(state, wat('2026-12-02T09:00:00'));
  }
  const invoices = months.map((period, index) => makeRecord(state, 'invoices', { name: `Invoice ${period}`, status: 'issued', reference: `INV-${period}-00${index + 1}`, createdAt: wat(`${period}-28T09:00:00`),
    data: { period, issuedAt: wat(`${period}-28T09:00:00`), issuedBy: 'Sandbox Finance', sequence: index + 1, usageLines: [], adjustments: [], terms: { commercialId: first.id, prospect: first.name, contractedLicenceKobo: LICENCE, designPartner: first.data.designPartner === true, effectiveDate: '2027-01-01' },
      designPartnerDiscount: { rate, kobo: -LICENCE * rate }, totals: { netKobo: LICENCE * (1 - rate), vatBps: 750, vatKobo: 0, totalKobo: LICENCE * (1 - rate), creditNote: false } } }));
  const discrepancies = () => buildReports(state, wat('2027-09-02T09:00:00')).billing.rateDiscrepancies as Array<Record<string, any>>;
  const listed = () => discrepancies().map((line) => [line.period, line.chargedRate, line.agreedRate, line.commercialId]);
  return { state, first, invoices, discrepancies, listed };
}
/** Signed terms Finance adds with Add terms: one person proposes any discount dates, and a second confirms them unless `confirm` is false. */
function addTerms(state: DomainState, name: string, data: Record<string, unknown>, recordedAt: string, confirm = true) {
  const at = wat(recordedAt);
  const input: any = { name, status: 'signed', reference: '', amountKobo: 0, customerId: '', createdAt: at, updatedAt: at, data: { signed: true, signedFullPriceTerms: true, licenceKobo: LICENCE, synthetic: true, ...data } };
  validateRecord(state, staffAt('fixture_finance', 'Finance', at), 'commercial', input);
  const terms = makeRecord(state, 'commercial', input);
  if (confirm) confirmAdded(state, terms, recordedAt);
  return terms;
}
/** A second person confirms added terms' dates, as they were proposed. */
function confirmAdded(state: DomainState, terms: TypedRecord<'commercial'>, at: string) {
  executeAction(state, staffAt('fixture_admin', 'Admin', wat(at)), { action: 'confirm_discount_terms', recordId: terms.id, reason: 'Checked against the signed agreement',
    data: { discountStartDate: terms.data.discountStartDate, fullPriceStartDate: terms.data.fullPriceStartDate, discountTermsReference: terms.data.discountTermsReference } });
}
const wrongDates = { designPartner: true, discountStartDate: '2027-03-01', fullPriceStartDate: '2028-01-01', discountTermsReference: 'SYN-A-WRONG' };
const firstHalf = ['2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06'];

// ---------- Review follow-up 2: a confirmed agreement that corrected terms from the same date replace is no longer compared with ----------
{
  // A's dates were entered wrongly (discount from March) and confirmed; January and February were invoiced at half price.
  const { state, first, listed } = billedUnder('replaced-confirmed', wrongDates, ['2027-01', '2027-02'], 0.5);
  assert.deepEqual(listed(), [['2027-01', 0.5, 0, first.id], ['2027-02', 0.5, 0, first.id]], 'while A is in effect, both months differ from its agreement');
  // Finance records the signed agreement correctly as terms from the same date (Add terms), and a second person confirms them.
  addTerms(state, 'Corrected terms', { designPartner: true, effectiveDate: '2027-01-01', discountStartDate: '2027-01-01', fullPriceStartDate: '2028-01-01', discountTermsReference: 'SYN-CORRECTED' }, '2027-03-10T09:00:00');
  assert.deepEqual(listed(), [], 'the corrected agreement, in effect for both months, gives the rate charged');
  assert.equal(termsReplaced(first, recordsOf(state, 'commercial')), true, 'Go-live evidence no longer shows A, and nothing is compared with it');
  checks += 3;
}

// ---------- Review follow-up 2: a retroactive amendment recorded as new terms governs the months it is in effect by ----------
{
  const { state, first, listed } = billedUnder('retroactive-amendment', wrongDates, ['2027-01', '2027-02'], 0.5);
  // The amendment, signed in March, applies from 15 January: recorded as new terms, it is in effect by the end of January.
  addTerms(state, 'Amendment from 15 January', { designPartner: true, effectiveDate: '2027-01-15', discountStartDate: '2027-01-01', fullPriceStartDate: '2028-01-01', discountTermsReference: 'SYN-AMENDMENT' }, '2027-03-10T09:00:00');
  assert.deepEqual(listed(), [], 'both months take the amendment, which gives the rate charged');
  assert.equal(termsReplaced(first, recordsOf(state, 'commercial')), true, 'A bills no month');
  checks += 2;
}

// ---------- Review follow-up 2: ordinary terms in effect count as an agreement at the full public price ----------
{
  // A pilot's terms with no dates billed January to March at half price; the lender was never a design partner, and Finance records its ordinary terms from the same date.
  const { state, listed, discrepancies } = billedUnder('ordinary-replacement', { designPartner: true }, ['2027-01', '2027-02', '2027-03'], 0.5);
  assert.deepEqual(listed(), [], 'design-partner terms with no dates give no rate to compare with');
  const ordinary = addTerms(state, 'Ordinary terms', { designPartner: false, effectiveDate: '2027-01-01' }, '2027-04-10T09:00:00', false);
  assert.deepEqual(listed(), [['2027-01', 0.5, 0, ordinary.id], ['2027-02', 0.5, 0, ordinary.id], ['2027-03', 0.5, 0, ordinary.id]], 'each month is compared with the ordinary terms in effect, which have nothing to confirm');
  assert.equal(discrepancies()[0]!.explanation, 'INV-2027-01-001 for January 2027 charged the 50% design-partner discount. A month uses the terms in effect at its end: for January 2027 those are “Ordinary terms”, ordinary terms in effect from 1 Jan 2027, which give the full public price.');
  checks += 3;
}

// ---------- Review follow-up 2: a month whose terms changed partway through takes the terms in effect by its end, and says when they took effect ----------
{
  // The pilot's terms, with no dates, billed January to June at half price. A bridge signed on 15 June, discount from July, is recorded in August and confirmed.
  const { state, listed, discrepancies } = billedUnder('partway-bridge', { designPartner: true }, firstHalf, 0.5);
  const bridge = addTerms(state, 'Bridge signed 15 June', { designPartner: true, effectiveDate: '2027-06-15', discountStartDate: '2027-07-01', fullPriceStartDate: '2028-01-01', discountTermsReference: 'SYN-BRIDGE' }, '2027-08-10T09:00:00');
  assert.deepEqual(listed(), [['2027-06', 0.5, 0, bridge.id]], 'June takes the bridge, in effect by its end; January to May keep the pilot terms, which cannot be compared');
  assert.equal(discrepancies()[0]!.explanation, 'INV-2027-06-006 for June 2027 charged the 50% design-partner discount. A month uses the terms in effect at its end: for June 2027 those are “Bridge signed 15 June”, design-partner terms in effect from 15 Jun 2027, whose confirmed agreement SYN-BRIDGE gives the full public price.');
  checks += 2;
}

// ---------- Review follow-up 2: with several replacements, nothing is compared until the latest is confirmed ----------
{
  const { state, listed } = billedUnder('several-replacements', wrongDates, ['2027-01', '2027-02', '2027-03'], 0.5);
  addTerms(state, 'B', { designPartner: true, effectiveDate: '2027-01-01', discountStartDate: '2027-01-01', fullPriceStartDate: '2028-01-01', discountTermsReference: 'SYN-B' }, '2027-04-10T09:00:00');
  assert.deepEqual(listed(), [], 'B, confirmed and in effect, gives the rate charged');
  const c = addTerms(state, 'C', { designPartner: true, effectiveDate: '2027-01-01', discountStartDate: '2027-02-01', fullPriceStartDate: '2028-02-01', discountTermsReference: 'SYN-C' }, '2027-04-11T09:00:00', false);
  assert.deepEqual(listed(), [], 'while the latest terms, C, await confirmation, no month is compared, with B or with A');
  confirmAdded(state, c, '2027-04-12T09:00:00');
  assert.deepEqual(listed(), [['2027-01', 0.5, 0, c.id]], 'once C is confirmed, each month is compared with it');
  checks += 3;
}

// ---------- Review follow-up 2: a later agreement from a later month, and another lender's terms, govern none of these months ----------
{
  const bridgeFromJuly = { designPartner: true, effectiveDate: '2027-07-01', discountStartDate: '2027-07-01', fullPriceStartDate: '2028-01-01', discountTermsReference: 'SYN-BRIDGE' };
  // The pilot's terms, with no dates, billed January to June; a bridge from July is confirmed. January to June keep the pilot terms: they are not compared.
  const pilot = billedUnder('later-agreement', { designPartner: true }, firstHalf, 0.5);
  addTerms(pilot.state, 'Bridge from July', bridgeFromJuly, '2027-08-10T09:00:00');
  assert.deepEqual(pilot.listed(), [], 'a later agreement does not govern the months before it');
  // With the pilot's dates confirmed (discount until June) and July invoiced at half price, June takes the pilot agreement and July the bridge.
  const confirmed = billedUnder('later-agreement-confirmed', { designPartner: true, discountStartDate: '2027-01-01', fullPriceStartDate: '2027-07-01', discountTermsReference: 'SYN-PILOT' }, [...firstHalf, '2027-07'], 0.5);
  addTerms(confirmed.state, 'Bridge from July', bridgeFromJuly, '2027-08-10T09:00:00');
  assert.deepEqual(confirmed.listed(), [], 'each month is compared with the terms in effect by its end, whichever terms billed it');
  // Another lender's confirmed terms from the same date, even ones an invoice names, as a merged or damaged load might hold them, are never read.
  const other = billedUnder('one-lender-terms', { designPartner: true }, ['2027-01', '2027-02', '2027-03'], 0.5);
  const theirs = addTerms(other.state, 'Another lender’s terms', { designPartner: true, effectiveDate: '2027-01-01', discountStartDate: '2027-03-01', fullPriceStartDate: '2028-03-01', discountTermsReference: 'SYN-OTHER' }, '2027-04-10T09:00:00');
  theirs.merchantId = 'a-different-lender';
  other.invoices[0]!.data.terms!.commercialId = theirs.id;
  assert.deepEqual(other.listed(), [], 'another lender’s terms govern none of this lender’s months');
  checks += 3;
}

// BIL-02: a calendar year is not signed authority to end the pilot/bridge discount.
{
  const { state } = fixture('unreviewed-discount', '2028-01-01');
  delete recordsOf(state, 'commercial')[0]!.data.discountReview;
  state.settings.billingPeriod = '2028-01';
  const before = structuredClone(state);
  assert.throws(() => issueInvoice(state, finance(wat('2028-02-02T09:00:00')), { period: '2028-01' }), /These discount dates have not been proposed/,
    'Older design-partner agreements need proposed and confirmed contract dates before a new invoice, not an automatic full-price calendar rollover.');
  assert.deepEqual(state, before, 'Refused pricing creates no invoice or financial change');
  const billing = buildReports(state, wat('2028-02-02T09:00:00')).billing;
  assert.equal(billing.totalKobo, null); assert.equal(billing.pricingReady, false);
  assert.equal(billing.nextInvoicePricingReady, false);
  assert.deepEqual(billing.lines, []);
  assert.equal(billing.unitEconomics.recurringKobo, null);
  assert.equal(billing.unitEconomics.annualisedRecurringRevenueKobo, null);
  checks += 8;
}

// The funded contract may cover a different year; the server records the proposal and its confirmation and keeps their exact evidence on the invoice.
{
  const { state, collection } = fixture('contract-dates', '2028-05-01');
  const terms = recordsOf(state, 'commercial')[0]!;
  const edit = structuredClone(terms);
  Object.assign(edit.data, { discountStartDate: '2028-05-01', fullPriceStartDate: '2028-07-01', discountTermsReference: 'reviewed-pilot-and-bridge' });
  const ctx = staffAt('fixture_finance', 'Finance', wat('2028-04-20T09:00:00'));
  validateRecord(state, ctx, 'commercial', edit, true);
  Object.assign(terms.data, edit.data);
  assert.equal(terms.data.discountReview?.reviewedBy, ctx.actor);
  assert.equal(terms.data.discountReview?.reviewedAt, ctx.now);
  assert.equal(terms.data.discountReview?.confirmedBy, undefined, 'the changed dates await a new confirmation');
  confirmTerms(state, wat('2028-04-21T09:00:00'));
  collection('CONTRACT-RECEIPT', wat('2028-05-10T09:00:00'));
  const may = invoiceFor(state, '2028-05', wat('2028-06-02T09:00:00'));
  assert.equal(may.data.designPartnerDiscount?.rate, 0.5);
  assert.match(may.data.designPartnerDiscount?.note ?? '', /full price from 1 Jul 2028/);
  assert.deepEqual(may.data.terms?.discountReview, terms.data.discountReview);
  const immutable = structuredClone(may);
  assert.equal(invoiceFor(state, '2028-06', wat('2028-07-02T09:00:00')).data.designPartnerDiscount?.rate, 0.5);
  assert.equal(invoiceFor(state, '2028-07', wat('2028-08-02T09:00:00')).data.designPartnerDiscount?.rate, 0);
  assert.deepEqual(may, immutable, 'Later billing never reprices issued evidence');
  terms.data.fullPriceStartDate = '2028-09-01';
  assert.throws(() => invoiceFor(state, '2028-08', wat('2028-09-02T09:00:00')), /changed after they were confirmed/, 'A persisted date changed outside its review cannot reuse stale review evidence');
  assert.deepEqual(may, immutable);
  checks += 10;
}

// Dates are proposed by an authorised writer, never by a supplied identity or an inferred calendar.
{
  const { state } = fixture('date-validation');
  const terms = recordsOf(state, 'commercial')[0]!;
  const changed = (patch: Record<string, unknown>) => ({ ...structuredClone(terms), data: { ...structuredClone(terms.data), ...patch } });
  for (const patch of [{ fullPriceStartDate: '2027-01-01' }, { discountStartDate: '2027-02-30' }, { discountStartDate: '2027-06-15' }, { discountTermsReference: '' }]) {
    assert.throws(() => validateRecord(state, finance(wat('2027-06-02T09:00:00')), 'commercial', changed(patch), true));
  }
  assert.throws(() => validateRecord(state, finance(wat('2027-06-02T09:00:00')), 'commercial', changed({ discountReview: { ...terms.data.discountReview, reviewedBy: 'Someone else' } }), true), /Valo Pay records who proposed and who confirmed the discount dates/);
  assert.throws(() => validateRecord(state, ctxAt(wat('2027-06-02T09:00:00'), 'Read-only'), 'commercial', changed({ fullPriceStartDate: '2028-02-01' }), true), /Your role is Read-only, so you can view records but not change them\./);
  const cleared = changed({ signedFullPriceTerms: false });
  validateRecord(state, finance(wat('2027-06-02T09:00:00')), 'commercial', cleared, true);
  assert.equal(cleared.data.discountReview, undefined);
  const untouched = structuredClone(terms);
  validateRecord(state, finance(wat('2027-06-02T09:00:00')), 'commercial', untouched, true);
  assert.deepEqual(untouched.data.discountReview, terms.data.discountReview, 'Unrelated edits retain the original proposal and its confirmation');
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
    assert.throws(() => issueInvoice(state, finance(wat('2027-07-02T09:00:00')), { period: '2027-06' }), /These design-partner terms cannot be used on a new invoice yet\. Valo Pay cannot read the saved (proposal or confirmation of these discount dates|discount start date|signed agreement reference)/,
      `${label}: a documented pricing refusal naming the unreadable evidence, not an incidental TypeError`);
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
  assert.throws(() => invoiceFor(state, "2027-05", wat("2027-07-02T09:00:00")), /Invoices are issued month by month\./);
  assert.throws(() => issueInvoice(state, finance(wat("2027-07-02T09:00:00")), { period: "2027-08" }), /You cannot issue an invoice for a future month\./);
  assert.throws(() => issueInvoice(state, finance(wat("2027-07-02T09:00:00")), { period: "June" }), /YYYY-MM/);
  assert.throws(() => executeAction(state, ctxAt(wat("2027-07-02T09:00:00"), "Operations"), { action: "issue_invoice", reason: "x", data: { period: "2027-07" } }), /Only an Admin or Finance team member can issue an invoice\./);
  assert.throws(() => invoiceFor(state, "2027-07", wat("2027-07-31T23:30:00")), /once the month has ended/, "a month is invoiced only after it has ended");
  checks += 22;

  // The withheld collection is billed on the next invoice once its window has passed; the issued invoice is immutable.
  const next = invoiceFor(state, "2027-07", wat("2027-08-01T00:30:00")); // July ended at midnight WAT
  assert.equal(next.reference, "INV-2027-07-002");
  assert.equal(next.data.collectionsCounted, 1);
  assert.equal(next.data.usageLines[0].paymentReference, "PSK-2", "billed once, on the first invoice after its reversal window closed");
  const before = structuredClone(state);
  invoice.data.totals.totalKobo = 1;
  assert.throws(() => assertFinalState(before, state, state.merchant.id), /Saved evidence cannot be changed\. Reload the page and try again\./, "issued invoices are never edited");
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
  assert.match(pending[2]!.explanation, /Collection PSK-R was reversed by the provider after invoice .* billed it\. That invoice charged .* at the 50% design-partner discount\. This line credits ₦37\.50\./);
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
  assert.match(january2028.data.adjustments[0].explanation, /was reversed by the provider after invoice INV-2027-12-013 billed it\. That invoice charged ₦75\.00 on .* at the 50% design-partner discount\. This line credits ₦75\.00\./);
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
  assert.throws(() => invoiceFor(state, "2027-03", wat("2027-04-03T10:00:00")), /Issue the invoice for January 2027 first: the month the signed terms took effect\./, "the first invoice is for the month the signed terms took effect, so no licensed month is passed over");
  assert.equal(statement(wat("2027-04-03T10:00:00")).nextInvoicePeriod, "2027-01", "the statement names the month the first invoice covers");
  collection("PSK-JAN", wat("2027-01-10T06:20:00"));
  const january = invoiceFor(state, "2027-01", wat("2027-02-03T10:00:00"));
  assert.throws(() => invoiceFor(state, "2027-03", wat("2027-04-03T10:00:00")), /Issue the invoice for February 2027 first\./, "March after January is refused, so February is never left behind");
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
  assert.throws(() => invoiceFor(quiet, "2027-08", wat("2027-09-01T09:00:00")), /Issue the invoice for July 2027 first\./);
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

console.log(`Billing golden tests passed (${checks} checks): invoice lines, VAT, WAT months and period rules, every month invoiced in order with a zero invoice for a quiet one, the latest signed terms in effect found by the lender's id, withheld collections and the reversal window from settlement, adjustment credits and debits with references at the rate first billed, refunds of unapplied money, debits settled without a webhook, credit note, recovery fee gate and window, receipts by channel in naira with other currencies beside them, a design-partner price that is not ready naming its cause in the same words everywhere, discount dates proposed by one person and confirmed by another, issued invoices whose rate differs from the terms in effect for their month reported, never rewritten, whichever terms billed them and with ordinary terms at the full public price, and the terms Go-live evidence treats as replaced being those billing never reads.`);
