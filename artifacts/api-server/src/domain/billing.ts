/**
 * Billing of merchants (TRD 5.15).  BIL-01 decides what is billable, BIL-02
 * prices it, BIL-04 issues a monthly invoice net of VAT with VAT shown and a
 * statement of the collections counted, and BIL-07 corrects a billed
 * collection with a credit or debit line on the next invoice, never by editing
 * an issued one.  The recovery fee (BIL-03) stays behind its gate.
 */
import {
  counted, sumMoney, multiplyDivideMoney, legacyDiscountMoney, nonnegativeMoney, validMoneyBps, MoneyArithmeticError,
  DEFAULT_REVERSAL_WINDOW_DAYS, DEFAULT_VAT_BPS, RECOVERY_FEE_KOBO, USAGE_FEE_BPS, USAGE_FEE_CAP_KOBO,
  billableChannels, experimentRules, isBillableChannel, isKobo, licenceTierFor, nairaText, paymentAppliedKobo, usageFeeKobo, vatKobo, type AdjustmentReason,
  latestTermsFirst, termsEffectiveAt, WAT_OFFSET_MS,
} from "@workspace/valopay-schema";
import { makeRecord, recordsOf } from "./records";
import type { Context, DomainState, TypedRecord, ValopayRecord } from "./types";
import { paymentObservedAt, paymentRefunded, paymentReversed } from "./reconciliation";
import { inNaira, type OtherCurrencies } from "./close";
import { attemptTime } from "./policy-engine";
import { watMonth, watMonthStart } from "./calendar";
import { designPartnerDiscount } from './commercial-terms';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The billing month (YYYY-MM) of an instant: calendar months are counted in West Africa Time. */
export const monthOf = (value: string): string => watMonth(value);

/** The WAT calendar month before the one containing `now`, the default invoice period. */
export function previousMonth(now: string): string {
  return watMonth(watMonthStart(watMonth(now)) - 1);
}
/** Last instant of a YYYY-MM period: one millisecond before midnight WAT on the next month's 1st. */
export function periodEnd(period: string): string {
  return new Date(watMonthStart(nextPeriodAfter(period)) - 1).toISOString();
}
/** A YYYY-MM period as ISO instants: its WAT start, and the next month's start, which it excludes. */
export function periodBounds(period: string): { start: string; end: string } {
  return { start: new Date(watMonthStart(period)).toISOString(), end: new Date(watMonthStart(nextPeriodAfter(period))).toISOString() };
}
/** The month after a YYYY-MM period. */
export function nextPeriodAfter(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year!, month!, 1)).toISOString().slice(0, 7);
}

/** BIL-01: the provider's own reversal window when configured, else the merchant's, else the plan's seven days. */
export function reversalWindowDays(state: DomainState, provider: unknown): number {
  const perProvider = (state.settings.providerReversalWindowDays || {}) as Record<string, unknown>;
  for (const candidate of [perProvider[String(provider)], state.settings.reversalWindowDays, DEFAULT_REVERSAL_WINDOW_DAYS]) {
    const days = Number(candidate);
    if (Number.isFinite(days) && days >= 0) return days;
  }
  return DEFAULT_REVERSAL_WINDOW_DAYS;
}

/**
 * A direct debit was collected when its webhook said so or a settlement line
 * paid it out, unless the provider reported it failed. The settlement test
 * also covers debits stored as "received" before a settlement line set them.
 */
export function collectionSucceeded(payment: TypedRecord<"payments">): boolean {
  if (payment.data.collectionStatus === "succeeded") return true;
  return isBillableChannel(payment.data.channel) && payment.data.settlementStatus === "settled" && payment.data.collectionStatus !== "failed";
}

/** When a payment settled: its settlement line's time, or when it was observed for a payment settled before that time was kept. */
const paymentSettledAt = (payment: TypedRecord<"payments">): number => Date.parse(String(payment.data.settledAt || payment.data.observedAt || payment.createdAt));

/**
 * BIL-01: a collection is billable when its attempt succeeded (a direct debit
 * the platform observed by webhook or settlement line), the Payment is settled
 * and allocated, still has applied money that no reversal or refund took back
 * at the invoice date, and the provider's reversal window has passed since it
 * settled. Transfers, card receipts and statement credits are reconciled and
 * reported, never billed as collections.
 */
export function billableCollection(state: DomainState, payment: TypedRecord<"payments">, now: string, checkWindow = true): boolean {
  if (!isBillableChannel(payment.data.channel) || !collectionSucceeded(payment)) return false;
  if (!["allocated", "overpaid", "partial"].includes(payment.status) || payment.data.settlementStatus !== "settled") return false;
  if (paymentReversed(payment) || paymentAppliedKobo(payment) <= 0) return false;
  return !checkWindow || Date.parse(now) - paymentSettledAt(payment) >= reversalWindowDays(state, payment.data.providerConnection || state.merchant.provider) * DAY_MS;
}

export function vatBpsFor(state: DomainState): number {
  return state.settings.vatBps === undefined ? DEFAULT_VAT_BPS : validMoneyBps(state.settings.vatBps as number);
}

const issuedInvoices = (state: DomainState): TypedRecord<"invoices">[] =>
  recordsOf(state, "invoices").filter((item) => item.status === "issued").sort((a, b) => String(a.data.period).localeCompare(String(b.data.period)) || String(a.data.issuedAt).localeCompare(String(b.data.issuedAt)));

function confirmedDuplicate(state: DomainState, payment: TypedRecord<"payments">): boolean {
  return payment.status === "possible_duplicate" || recordsOf(state, "exceptions").some((item) => item.data.linkedRecordId === payment.id && item.data.type === "suspected_duplicate" && item.data.resolutionCode === "confirmed_duplicate_refund");
}

/**
 * What a collection that was already billed is worth today: the usage fee on
 * its applied money that stands, or nothing with the reason it is no longer
 * billable. A refund of money the payment never applied, such as an
 * overpayment's excess, changes nothing.
 */
export function collectionFeeNow(state: DomainState, payment: TypedRecord<"payments">): { feeKobo: number; allocatedKobo: number; reason: AdjustmentReason | null } {
  const allocatedKobo = paymentAppliedKobo(payment);
  if (paymentReversed(payment)) return { feeKobo: 0, allocatedKobo, reason: "reversal" };
  const refundTookApplied = paymentRefunded(payment) && allocatedKobo < Number(payment.data.allocatedKobo || 0);
  if (refundTookApplied && allocatedKobo <= 0) return { feeKobo: 0, allocatedKobo, reason: "refund" };
  if (confirmedDuplicate(state, payment)) return { feeKobo: 0, allocatedKobo, reason: "confirmed_duplicate" };
  // The reversal window was already respected when the collection was first billed.
  if (!billableCollection(state, payment, payment.updatedAt, false) || allocatedKobo <= 0) return { feeKobo: 0, allocatedKobo, reason: "wrong_allocation" };
  return { feeKobo: usageFeeKobo(allocatedKobo), allocatedKobo, reason: refundTookApplied ? "refund" : null };
}

/** What a line charges after a design-partner discount of `rate` (the share taken off), in whole basis points, rounded down in the lender's favour. */
export function chargedAtRate(kobo: number, rate: number): number {
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new MoneyArithmeticError("INVALID_MONEY_RATE", "The discount share must be between zero and one.");
  return multiplyDivideMoney(nonnegativeMoney(kobo), 10_000 - Math.round(rate * 10_000), 10_000);
}
/** A stored discount rate, or the fallback when it is missing or out of range. */
const rateOf = (value: unknown, fallback: number): number => typeof value === "number" && value >= 0 && value <= 1 ? value : fallback;

interface LedgerEntry { netFeeKobo: number; netChargedKobo: number; discountRate: number; allocatedKobo: number; originalInvoiceId: string; originalInvoiceReference: string; invoiceIds: string[] }

/**
 * What each collection has been billed so far across every issued invoice:
 * the net public-price fee, the net amount charged, and the design-partner
 * rate of the invoice that first billed it, from its usage line and any later
 * adjustment lines. Lines issued before the rate and charge were kept on each
 * line take their invoice's rate.
 */
export function billedLedger(state: DomainState): Map<string, LedgerEntry> {
  const ledger = new Map<string, LedgerEntry>();
  for (const invoice of issuedInvoices(state)) {
    const invoiceRate = rateOf(invoice.data.designPartnerDiscount?.rate, 0);
    const entryFor = (paymentId: string, discountRate: number): LedgerEntry => ledger.get(paymentId) ?? { netFeeKobo: 0, netChargedKobo: 0, discountRate, allocatedKobo: 0, originalInvoiceId: invoice.id, originalInvoiceReference: invoice.reference, invoiceIds: [] };
    for (const line of (invoice.data.usageLines || []) as Array<{ paymentId: string; feeKobo: number; allocatedKobo: number; discountRate?: number; chargedKobo?: number }>) {
      const rate = rateOf(line.discountRate, invoiceRate), feeKobo = Number(line.feeKobo || 0);
      const entry = entryFor(line.paymentId, rate);
      entry.netFeeKobo = sumMoney([entry.netFeeKobo, feeKobo]); entry.netChargedKobo = sumMoney([entry.netChargedKobo, isKobo(line.chargedKobo) ? line.chargedKobo : chargedAtRate(feeKobo, rate)]);
      entry.allocatedKobo = Number(line.allocatedKobo || 0); entry.invoiceIds.push(invoice.id);
      ledger.set(line.paymentId, entry);
    }
    for (const line of (invoice.data.adjustments || []) as Array<{ paymentId: string; kobo: number; feeDeltaKobo?: number; currentAllocatedKobo?: number }>) {
      const entry = entryFor(line.paymentId, invoiceRate), kobo = Number(line.kobo || 0);
      if (line.feeDeltaKobo !== undefined) { entry.netFeeKobo = sumMoney([entry.netFeeKobo, Number(line.feeDeltaKobo)]); entry.netChargedKobo = sumMoney([entry.netChargedKobo, kobo]); }
      // An earlier line carried the public-price change, and its invoice's discount applied to it with everything else.
      else { entry.netFeeKobo = sumMoney([entry.netFeeKobo, kobo]); entry.netChargedKobo = sumMoney([entry.netChargedKobo, kobo, -legacyDiscountMoney(kobo, invoiceRate)]); }
      if (line.currentAllocatedKobo !== undefined) entry.allocatedKobo = Number(line.currentAllocatedKobo);
      entry.invoiceIds.push(invoice.id);
      ledger.set(line.paymentId, entry);
    }
  }
  return ledger;
}

/** A recovery fee line (BIL-05): one per obligation the engine recovered inside the 30-day window, billed once. */
export interface RecoveryFeeLine {
  dueItemId: string;
  reference: string;
  attemptId: string;
  firstFailureAt?: string;
  windowClosedAt: string;
  feeKobo: number;
}

export interface AdjustmentLine {
  reason: AdjustmentReason;
  paymentId: string;
  paymentReference: string;
  originalInvoiceId: string;
  originalInvoiceReference: string;
  /** What this invoice carries, priced at the rate of the invoice that first billed the collection: negative for a credit, positive for a debit. */
  kobo: number;
  /** The change in the public-price fee. */
  feeDeltaKobo: number;
  /** The design-partner share taken off when the collection was first billed. */
  discountRate: number;
  /** What the collection had been charged net before this line. */
  billedChargedKobo: number;
  billedFeeKobo: number;
  currentFeeKobo: number;
  billedAllocatedKobo: number;
  currentAllocatedKobo: number;
  allocationIds: string[];
  explanation: string;
}

const reasonText: Record<AdjustmentReason, string> = {
  reversal: "was reversed by the provider after it was billed",
  refund: "was refunded to the customer after it was billed",
  confirmed_duplicate: "was confirmed as a duplicate after it was billed",
  wrong_allocation: "had its allocation superseded as a wrong match after it was billed",
  re_allocation: "was re-allocated at a higher value after it was billed",
};

/**
 * BIL-07: for every collection billed on an issued invoice, the difference
 * between what it is worth today and what has been charged net so far.  A
 * reversal, refund, confirmed duplicate or superseded allocation credits the
 * fee; a re-allocation at a higher value debits the difference.  Both are
 * priced at the rate of the invoice that first billed the collection, so a
 * credit returns what was charged.  Computed from the ledger, so it is
 * idempotent and never touches an issued invoice.
 */
export function pendingAdjustments(state: DomainState): AdjustmentLine[] {
  const lines: AdjustmentLine[] = [];
  const payments = new Map(recordsOf(state, "payments").map((item) => [item.id, item]));
  for (const [paymentId, entry] of billedLedger(state)) {
    const payment = payments.get(paymentId);
    if (!payment) continue;
    const fee = collectionFeeNow(state, payment);
    const kobo = sumMoney([chargedAtRate(fee.feeKobo, entry.discountRate), -entry.netChargedKobo]);
    if (kobo === 0) continue;
    const reason: AdjustmentReason = kobo > 0 ? "re_allocation" : (fee.reason ?? "wrong_allocation");
    const discount = entry.discountRate > 0 ? ` at the ${Math.round(entry.discountRate * 100)}% design-partner discount` : "";
    lines.push({
      reason, paymentId, paymentReference: payment.reference, originalInvoiceId: entry.originalInvoiceId, originalInvoiceReference: entry.originalInvoiceReference, kobo,
      feeDeltaKobo: sumMoney([fee.feeKobo, -entry.netFeeKobo]), discountRate: entry.discountRate, billedChargedKobo: entry.netChargedKobo,
      billedFeeKobo: entry.netFeeKobo, currentFeeKobo: fee.feeKobo, billedAllocatedKobo: entry.allocatedKobo, currentAllocatedKobo: fee.allocatedKobo,
      allocationIds: recordsOf(state, "allocations").filter((item) => item.data.paymentId === paymentId).map((item) => item.id),
      explanation: `Collection ${payment.reference} (${nairaText(entry.allocatedKobo)} billed ${nairaText(entry.netChargedKobo)} on ${entry.originalInvoiceReference}${discount}) ${reasonText[reason]}; ${kobo < 0 ? "credit" : "debit"} of ${nairaText(Math.abs(kobo))}.`,
    });
  }
  return lines.sort((a, b) => a.paymentReference.localeCompare(b.paymentReference));
}

/**
 * An issued invoice charged at another rate than the terms billing reads for its month now give: commercialId names
 * those terms, and the explanation names them, when they took effect and the whole-month rule.
 */
export interface RateDiscrepancy { invoiceId: string; invoiceReference: string; period: string; commercialId: string; chargedRate: number; agreedRate: number; explanation: string }
const rateText = (rate: number): string => rate > 0 ? `the ${Math.round(rate * 100)}% design-partner discount` : "the full public price";
/** What Finance does about a discrepancy: there is no correction for an issued invoice's discount, so it is agreed outside the platform. */
export const RATE_DISCREPANCY_GUIDANCE = "An issued invoice is never changed, and Valo Pay has no way to correct an issued invoice's discount: the next invoice's adjustment lines correct only collections that were reversed, refunded, confirmed as duplicates or re-allocated. Adjustment lines on later invoices for a listed invoice's collections, such as a re-allocation debit or a reversal credit, carry that invoice's rate too, so include them in what you agree. Agree any difference with the lender outside Valo Pay and keep a record of what you agreed. Each invoice is compared with the terms in effect for its month now, as billing reads them: a month takes the terms in effect by its end, and ordinary terms give the full public price. While the design-partner terms in effect for a month are not confirmed, its invoices are not compared; confirming their discount dates compares them. New invoices are priced from the confirmed dates.";
/** When terms took effect, as a WAT date, for an explanation; terms that name no date have applied from the start. */
function effectiveFrom(terms: TypedRecord<"commercial">): string {
  const at = effectiveAt(terms), wat = new Date(at + WAT_OFFSET_MS);
  if (Number.isFinite(wat.getTime())) return wat.toISOString().slice(0, 10);
  return Number.isFinite(at) ? String(terms.data.effectiveDate) : "the start";
}
/**
 * BIL-02: every issued invoice charged at another rate than the terms billing reads for its month now give, such as
 * one issued under the earlier calendar-year rule. Those are the lender's signed terms in effect by the month's end,
 * in billing's own order (termsFor), whichever terms billed it: ordinary terms give the full public price, and
 * design-partner terms count once their discount dates are confirmed. While the terms in effect cannot price the
 * month, its invoices are not compared. It is only reported: an issued invoice is never rewritten and no money is created.
 */
export function rateDiscrepancies(state: DomainState): RateDiscrepancy[] {
  return issuedInvoices(state).flatMap((invoice) => {
    const period = String(invoice.data.period), inEffect = termsFor(state, period);
    const agreed = inEffect ? designPartnerDiscount(inEffect.data, period) : undefined;
    const chargedRate = rateOf(invoice.data.designPartnerDiscount?.rate, 0);
    if (!inEffect || !agreed?.ready || agreed.rate === chargedRate) return [];
    const terms = `“${inEffect.name}”, ${inEffect.data.designPartner === true
      ? `design-partner terms in effect from ${effectiveFrom(inEffect)}, whose confirmed agreement ${String(inEffect.data.discountTermsReference ?? "").trim()} gives ${rateText(agreed.rate!)}`
      : `ordinary terms in effect from ${effectiveFrom(inEffect)}, which give the full public price`}`;
    return [{ invoiceId: invoice.id, invoiceReference: invoice.reference, period, commercialId: inEffect.id, chargedRate, agreedRate: agreed.rate!,
      explanation: `${invoice.reference} for ${period} charged ${rateText(chargedRate)}. A month takes the terms in effect by its end: for ${period} those are ${terms}.` }];
  });
}

/** BIL-03: the recovery fee, billed only after the 30-day window closes and only when the gate is open. */
export function recoveryFeeLines(state: DomainState, period: string) {
  const enabled = state.settings.recoveryFeeEnabled === true && state.settings.recoveryFeeDecision === "proven";
  const note = enabled
    ? `NGN ${RECOVERY_FEE_KOBO / 100} per recovered failed debit in the engine arm, billed once its ${experimentRules.outcomeWindowDays}-day window has closed, so a reversal inside the window never needs a credit.`
    : "The recovery fee is off. It can be charged only after the recovery test (Test 2) is recorded as proven and the fee is enabled in settings.";
  if (!enabled) return { enabled, lines: [] as RecoveryFeeLine[], kobo: 0, note };
  const end = Date.parse(periodEnd(period));
  const billed = new Set(issuedInvoices(state).flatMap((invoice) => ((invoice.data.recoveryFee?.lines || []) as Array<{ dueItemId: string }>).map((line) => line.dueItemId)));
  const lines = recordsOf(state, "due-items").flatMap((due) => {
    if (due.data.experimentArm !== "engine" || !due.data.firstFailureAt || billed.has(due.id) || due.status !== "paid") return [];
    const start = Date.parse(String(due.data.firstFailureAt)), close = start + experimentRules.outcomeWindowDays * DAY_MS;
    if (close > end) return []; // the window has not closed by the invoice period end
    const retry = recordsOf(state, "attempts").find((attempt) => attempt.data.dueItemId === due.id && attempt.data.source === "valo" && attempt.status === "succeeded" && Date.parse(attemptTime(attempt)) >= start && Date.parse(attemptTime(attempt)) <= close);
    if (!retry) return []; // recovered by another channel, not under an engine-scheduled retry
    return [{ dueItemId: due.id, reference: due.reference, attemptId: retry.id, firstFailureAt: due.data.firstFailureAt, windowClosedAt: new Date(close).toISOString(), feeKobo: RECOVERY_FEE_KOBO }];
  });
  return { enabled, lines, kobo: sumMoney(lines.map((line) => line.feeKobo)), note };
}

/** When terms take effect; terms that name no date have applied from the start (shared with the console). */
const effectiveAt = (terms: TypedRecord<"commercial">): number => termsEffectiveAt(terms.data);
/**
 * The lender's signed terms, the latest to take effect first (the later
 * recorded first on the same date). They are the lender's by the record's
 * lender id, whatever name they were signed under; unsigned entries are
 * prospects' evidence, not subscriptions.
 */
function signedTerms(state: DomainState): TypedRecord<"commercial">[] {
  return recordsOf(state, "commercial")
    .filter((item) => item.merchantId === state.merchant.id && item.data.signed === true)
    .sort(latestTermsFirst);
}
/**
 * The terms that bill a period: the latest signed terms in effect by its end,
 * design-partner or not. Their licence is billed for the whole month, with no
 * proration, whichever day they took effect.
 */
function termsFor(state: DomainState, period: string): TypedRecord<"commercial"> | undefined {
  const end = watMonthStart(nextPeriodAfter(period));
  return signedTerms(state).find((item) => effectiveAt(item) < end);
}
/** The month the earliest signed terms took effect, which the first invoice may not pass over; none while no signed terms name a date. */
function firstTermsPeriod(state: DomainState): string | undefined {
  const dated = signedTerms(state).map(effectiveAt).filter(Number.isFinite);
  return dated.length ? watMonth(Math.min(...dated)) : undefined;
}
/**
 * BIL-04: the month the next invoice covers. Invoices cover every month in
 * order, so it is the month after the latest issued invoice; before the first,
 * it is the month just ended, or the month the earliest signed terms took
 * effect when that is earlier.
 */
function nextInvoicePeriod(state: DomainState, now: string): string {
  const latest = issuedInvoices(state).at(-1);
  if (latest) return nextPeriodAfter(String(latest.data.period));
  const first = firstTermsPeriod(state), previous = previousMonth(now);
  return first && first < previous ? first : previous;
}
/** The monthly statement for the console and the billing export: what the period's receipts are worth and what the next invoice will carry. */
export function buildBillingStatement(state: DomainState, now: string): Record<string, any> {
  const payments = recordsOf(state, "payments");
  const period = String(state.settings.billingPeriod || monthOf(now));
  const terms = termsFor(state, period);
  const pricing = designPartnerDiscount(terms?.data, period);
  const nextPeriod = nextInvoicePeriod(state, now);
  const nextPricing = designPartnerDiscount(termsFor(state, nextPeriod)?.data, nextPeriod);
  const inPeriod = payments.filter((item) => monthOf(String(item.data.observedAt || item.createdAt)) === period);
  const billablePayments = inPeriod.filter((item) => billableCollection(state, item, now));
  const usageBase = sumMoney(billablePayments.map(paymentAppliedKobo));
  const usageFee = sumMoney(billablePayments.map((item) => usageFeeKobo(paymentAppliedKobo(item))));
  const tier = licenceTierFor(billablePayments.length);
  // Receipts by channel, as the close counts money: every receipt counts, kobo sums naira only, and money in another currency is listed beside it.
  const channelBreakdown: Record<string, { count: number; kobo: number; otherCurrencies?: OtherCurrencies; billable: number; reason: string }> = {};
  for (const channel of [...new Set(inPeriod.map((payment) => String(payment.data.channel || "manual")))]) {
    const receipts = inPeriod.filter((payment) => String(payment.data.channel || "manual") === channel);
    channelBreakdown[channel] = {
      ...inNaira(receipts, (payment) => payment.amountKobo), billable: receipts.filter((payment) => billableCollection(state, payment, now)).length,
      reason: isBillableChannel(channel) ? "A successful direct debit can be billed after settlement on the money it applied, provided that money has not been reversed or refunded and the reversal window from settlement has passed." : "This payment is included in reconciliation reports but is not charged a collection fee.",
    };
  }
  // Collections that pass every BIL-01 check except the reversal window are billed on a later statement, never lost.
  const withheld = inPeriod.filter((item) => billableCollection(state, item, now, false) && !billableCollection(state, item, now));
  const lines = terms && pricing.ready ? [(() => {
    const rate = pricing.rate!;
    const usage = sumMoney(billablePayments.map((item) => chargedAtRate(usageFeeKobo(paymentAppliedKobo(item)), rate)));
    const contractedLicence = nonnegativeMoney(terms.data.licenceKobo ?? 0);
    const licence = chargedAtRate(contractedLicence, rate);
    return { commercialId: terms.id, prospect: terms.name, implementationKobo: 0, licenceKobo: licence, contractedLicenceKobo: contractedLicence, volumeTier: tier.name, volumeTierLicenceKobo: tier.licenceKobo, tierMismatch: contractedLicence !== tier.licenceKobo, usageKobo: usage, totalKobo: sumMoney([licence, usage]), designPartnerDiscount: rate > 0 };
  })()] : [];
  const invoices = issuedInvoices(state).map((invoice) => ({
    id: invoice.id, reference: invoice.reference, period: invoice.data.period, issuedAt: invoice.data.issuedAt, issuedBy: invoice.data.issuedBy, collectionsCounted: invoice.data.collectionsCounted,
    usageKobo: invoice.data.subtotals?.usageKobo, licenceKobo: invoice.data.subtotals?.licenceKobo, adjustmentsKobo: invoice.data.subtotals?.adjustmentsKobo, adjustmentCount: (invoice.data.adjustments || []).length,
    netKobo: invoice.data.totals?.netKobo, vatKobo: invoice.data.totals?.vatKobo, totalKobo: invoice.data.totals?.totalKobo, creditNote: invoice.data.totals?.creditNote === true,
  }));
  const adjustments = pendingAdjustments(state);
  return {
    period, usageRateBps: USAGE_FEE_BPS, usageCapKobo: USAGE_FEE_CAP_KOBO, reversalWindowDays: reversalWindowDays(state, state.merchant.provider), vatBps: vatBpsFor(state),
    billableChannels: [...billableChannels], billableRule: "A collection can be billed when the direct debit succeeded (its webhook or its settlement line says so), the payment is settled and still has applied money that was not reversed or refunded at the invoice date, and the provider's reversal window has passed since it settled.",
    eligibleAllocatedKobo: usageBase, successfulCollections: billablePayments.length, usageFeeKobo: usageFee, volumeTier: tier.name,
    channelBreakdown, withheldInsideReversalWindow: withheld.length,
    lines, totalKobo: pricing.ready ? sumMoney(lines.map((line) => line.totalKobo)) : null,
    pricingReady: pricing.ready, pricingExplanation: pricing.explanation,
    invoices, nextInvoicePeriod: nextPeriod, nextInvoicePricingReady: nextPricing.ready, nextInvoicePricingExplanation: nextPricing.explanation,
    pendingAdjustments: adjustments, pendingAdjustmentsKobo: sumMoney(adjustments.map((line) => line.kobo)),
    rateDiscrepancies: rateDiscrepancies(state), rateDiscrepancyGuidance: RATE_DISCREPANCY_GUIDANCE,
    adjustmentRule: "If a billed collection is reversed, refunded, confirmed as a duplicate or affected by an invalidated allocation, the correction appears as a credit or debit on the next invoice. Issued invoices are never changed. A correction is priced at the rate of the invoice that first billed the collection.",
    recoveryFee: recoveryFeeLines(state, period).note,
    implementationExcludedFromRecurring: true, synthetic: true,
  };
}

/**
 * BIL-04: issue the invoice for a WAT calendar month that has ended as an
 * immutable record: the licence from the signed terms in effect that month,
 * one usage line per billable collection not billed before and observed by the
 * period end (so a collection withheld inside its reversal window is billed on
 * the next invoice), the design-partner discount on the licence and those usage
 * lines, the BIL-07 adjustment lines at the rate each collection was first
 * billed under, the gated recovery fee, then VAT on the net. Every month is
 * invoiced, in order, a quiet one for zero: a month passed over could never be
 * invoiced afterwards, and its licence would be lost.
 */
export function issueInvoice(state: DomainState, ctx: Context, input: { period?: unknown }): TypedRecord<"invoices"> {
  const now = ctx.now;
  const period = input.period ? String(input.period) : previousMonth(now);
  if (!/^\d{4}-\d{2}$/.test(period) || Number.isNaN(Date.parse(`${period}-01T00:00:00Z`))) throw new Error("Enter the billing month as YYYY-MM, for example 2026-09.");
  const current = monthOf(now);
  if (period > current) throw new Error("An invoice cannot be issued for a future period.");
  if (period === current) throw new Error(`The ${period} invoice can be issued once the month has ended, from 00:00 WAT on ${nextPeriodAfter(period)}-01.`);
  const existing = issuedInvoices(state);
  const duplicate = existing.find((invoice) => invoice.data.period === period);
  if (duplicate) throw new Error(`Invoice ${duplicate.reference} has already been issued for ${period}. Any correction will appear on the next invoice.`);
  const latest = existing.at(-1);
  if (latest && String(latest.data.period) > period) throw new Error(`Invoices are issued in period order; ${latest.reference} already covers ${latest.data.period}.`);
  const due = latest ? nextPeriodAfter(String(latest.data.period)) : firstTermsPeriod(state);
  if (due && period > due) throw new Error(`Invoices are issued for every month in order, with a zero invoice for a month with nothing to bill: issue the invoice for ${due} first${latest ? "" : ", the month the signed terms took effect"}.`);
  const end = Date.parse(periodEnd(period));
  const ledger = billedLedger(state);
  const terms = termsFor(state, period);
  const pricing = designPartnerDiscount(terms?.data, period);
  if (!pricing.ready) throw Object.assign(new Error(pricing.explanation), { status: 409 });
  const rate = pricing.rate!;
  const usageLines = recordsOf(state, "payments")
    .filter((payment) => !ledger.has(payment.id) && paymentObservedAt(payment) <= end && billableCollection(state, payment, now))
    .sort((a, b) => paymentObservedAt(a) - paymentObservedAt(b) || a.reference.localeCompare(b.reference))
    .map((payment) => {
      const allocatedKobo = paymentAppliedKobo(payment), feeKobo = usageFeeKobo(allocatedKobo);
      return { paymentId: payment.id, paymentReference: payment.reference, customerId: payment.customerId, channel: payment.data.channel, observedAt: payment.data.observedAt || payment.createdAt, settledAt: payment.data.settledAt ?? null, allocatedKobo, feeKobo, discountRate: rate, chargedKobo: chargedAtRate(feeKobo, rate), allocationIds: recordsOf(state, "allocations").filter((item) => item.data.paymentId === payment.id && item.status === "confirmed").map((item) => item.id) };
    });
  const adjustments = pendingAdjustments(state);
  const recoveryFee = recoveryFeeLines(state, period);
  const tier = licenceTierFor(usageLines.length);
  const contractedLicence = nonnegativeMoney(terms?.data.licenceKobo ?? 0);
  const usageKobo = sumMoney(usageLines.map((line) => line.feeKobo));
  // Adjustment lines already carry the rate their collection was first billed under, so the discount leaves them alone.
  const adjustmentsKobo = sumMoney(adjustments.map((line) => line.kobo));
  const discountKobo = 0 - sumMoney([contractedLicence, -chargedAtRate(contractedLicence, rate), ...usageLines.map((line) => sumMoney([line.feeKobo, -line.chargedKobo]))]);
  const netKobo = sumMoney([contractedLicence, usageKobo, adjustmentsKobo, discountKobo, recoveryFee.kobo]);
  const vatBps = vatBpsFor(state);
  const vat = multiplyDivideMoney(netKobo, validMoneyBps(vatBps), 10_000, "trunc");
  const totalKobo = sumMoney([netKobo, vat]);
  const sequence = existing.length + 1;
  return makeRecord(state, "invoices", {
    name: `Invoice ${period}`, status: "issued", reference: `INV-${period}-${String(sequence).padStart(3, "0")}`, amountKobo: Math.max(0, totalKobo), createdAt: now,
    data: {
      period, periodEnd: new Date(end).toISOString(), issuedAt: now, issuedBy: ctx.actor, sequence,
      terms: terms ? { commercialId: terms.id, prospect: terms.name, contractedLicenceKobo: contractedLicence, designPartner: terms.data.designPartner === true, effectiveDate: terms.data.effectiveDate ?? null, ...(terms.data.designPartner === true && terms.data.discountReview ? { discountReview: structuredClone(terms.data.discountReview) } : {}) } : null,
      licence: { kobo: contractedLicence, volumeTier: tier.name, volumeTierLicenceKobo: tier.licenceKobo, tierMismatch: contractedLicence !== tier.licenceKobo, note: terms ? "Contracted monthly licence from the signed terms in effect this month, for the whole month; the tier for this month's count is shown for comparison." : "No signed terms: no licence is billed." },
      usageLines, collectionsCounted: usageLines.length, usageRateBps: USAGE_FEE_BPS, usageCapKobo: USAGE_FEE_CAP_KOBO,
      designPartnerDiscount: { rate, kobo: discountKobo, note: `${pricing.explanation}${adjustments.length ? " Adjustment lines carry the rate of the invoice that first billed each collection." : ""}` },
      adjustments, recoveryFee,
      subtotals: { licenceKobo: contractedLicence, usageKobo, adjustmentsKobo, discountKobo, recoveryKobo: recoveryFee.kobo },
      totals: { netKobo, vatBps, vatKobo: vat, totalKobo, creditNote: totalKobo < 0 },
      statement: `${counted(usageLines.length, "collection")} counted at ${USAGE_FEE_BPS / 100}% capped at ${nairaText(USAGE_FEE_CAP_KOBO)}; ${counted(adjustments.length, "adjustment line")}; VAT at ${vatBps / 100}% shown separately.`,
      disputeRoute: "Dispute a count by raising it with your Valo Pay contact quoting the invoice reference and the collection reference; the count is derived from records and reproducible (BIL-01).",
      synthetic: true,
    },
  });
}
