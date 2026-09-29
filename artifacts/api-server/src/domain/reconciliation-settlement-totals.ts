/** Settlement identities, fee schedules and line totals shared by batch handling and provider-identity review. */
import { type DomainState, type ValopayRecord, type TypedRecord } from "./types";
import { connectionKey, connectionOf, currencyOf } from "./reconciliation-values";
import { type ProviderFeeSchedule, validMoneyBps, nonnegativeMoney, DEFAULT_PROVIDER_FEE, hasFeeSchedule, isKobo, providerFeeKobo, sumMoney, SETTLEMENT_ITEM_TOLERANCE_KOBO } from "@workspace/valopay-schema";

export const settlementIdentity = (state: DomainState, record: ValopayRecord, reference = record.reference): string => JSON.stringify([connectionKey(connectionOf(state, record)), reference]);

export const batchIdentity = (state: DomainState, batch: TypedRecord<"settlement-batches">): string => String(batch.data.providerIdentityKey || settlementIdentity(state, batch));

/** CON-09: the provider fee schedule for a connection, falling back to the merchant's default provider, then the plan's sourced rail fee. */
export function feeScheduleFor(state: DomainState, provider: unknown): ProviderFeeSchedule {
  const schedules = (state.settings.providerFeeSchedule || {}) as Record<string, { bps?: unknown; capKobo?: unknown }>;
  const configured = schedules[String(provider)] || schedules[state.merchant.provider];
  if (configured) {
    return { bps: validMoneyBps(configured.bps as number), capKobo: configured.capKobo === undefined ? Number.MAX_SAFE_INTEGER : nonnegativeMoney(configured.capKobo as number) };
  }
  if (state.settings.providerFeeBps !== undefined) return { bps: validMoneyBps(state.settings.providerFeeBps as number), capKobo: Number.MAX_SAFE_INTEGER };
  return DEFAULT_PROVIDER_FEE;
}

/** The fee schedule for money in `currency` through a connection: none outside naira, whose schedules they all are (hasFeeSchedule). */
function feeScheduleIn(state: DomainState, provider: unknown, currency: string): ProviderFeeSchedule | undefined {
  return hasFeeSchedule(currency) ? feeScheduleFor(state, provider) : undefined;
}

/** What a settlement line adds to its batch's totals. */
interface LineTotals { grossKobo: number; feeKobo: number; expectedFeeKobo: number }

/**
 * The one fee schedule a settlement line is checked against, at its first count
 * (settlementBatch) and at every recount (completeLineGross, recountEarlierLines,
 * countDisplacedLines): the schedule of the provider it names (data.provider),
 * else of the connection it names (data.providerConnection), else of the lender's
 * provider, for money in its currency (none outside naira). The line alone
 * decides it, never the payment it settles, whose connection is that of whichever
 * evidence arrived first, so the same line gets the same schedule in every
 * arrival order. A line records the expected fee it was counted with, so counts
 * already saved stay as they are until a recount. The batch the line counts in is
 * still found by its connection (settlementIdentity), which its provider does not
 * change.
 */
export const lineSchedule = (state: DomainState, line: TypedRecord<"observations">): ProviderFeeSchedule | undefined =>
  feeScheduleIn(state, String(line.data.provider || line.data.providerConnection || state.merchant.provider), currencyOf(line));

/**
 * ING-07: what a settlement line adds to its batch. A line whose gross is
 * known, because it states one or its payment's gross is complete, adds that
 * gross, its stated fee (else the gross less what it paid out, else the
 * schedule's fee) and the schedule's fee on the gross. A line that states only
 * what it paid out, for a payment whose gross is not yet known, adds that as
 * its net: a stated fee makes its gross with it, and without one it adds no fee
 * and no expected fee, so a gross not yet known never puts its batch in
 * variance. The debit's gross completes it later (completeLineGross). A line
 * in a currency with no fee schedule adds no expected fee.
 */
export function lineTotals(line: TypedRecord<"observations">, payment: TypedRecord<"payments">, schedule: ProviderFeeSchedule | undefined): LineTotals {
  const stated = isKobo(line.data.feeKobo) ? line.data.feeKobo : undefined;
  const scheduleFee = (grossKobo: number) => schedule ? providerFeeKobo(grossKobo, schedule) : 0;
  if (line.data.grossAmountKobo === undefined && payment.data.grossUnstated === true) {
    const grossKobo = sumMoney([line.amountKobo, stated ?? 0]);
    return { grossKobo, feeKobo: stated ?? 0, expectedFeeKobo: stated === undefined ? 0 : scheduleFee(grossKobo) };
  }
  const grossKobo = payment.amountKobo, expectedFeeKobo = scheduleFee(grossKobo);
  return { grossKobo, feeKobo: stated ?? (grossKobo > line.amountKobo ? grossKobo - line.amountKobo : expectedFeeKobo), expectedFeeKobo };
}

/** Whether a batch's fees are checked: there is a fee schedule for its currency (hasFeeSchedule). */
export const feesChecked = (batch: ValopayRecord): boolean => hasFeeSchedule(currencyOf(batch));

/**
 * Moves a batch's totals from what a line added before (`was`) to what it
 * adds now, and records that on the line (countedGrossKobo, assumedFeeKobo,
 * expectedFeeKobo, and feeVarianceKobo while its fee differs from the schedule's).
 * A batch whose fees are not checked, and its lines, keep no expected fee and no
 * fee variance.
 */
export function countLine(batch: TypedRecord<"settlement-batches">, line: TypedRecord<"observations">, now: LineTotals, was: LineTotals): void {
  batch.data.grossKobo = sumMoney([Number(batch.data.grossKobo || 0), now.grossKobo, -was.grossKobo]);
  batch.data.feeKobo = sumMoney([Number(batch.data.feeKobo || 0), now.feeKobo, -was.feeKobo]);
  if (feesChecked(batch)) batch.data.expectedFeeKobo = sumMoney([Number(batch.data.expectedFeeKobo || 0), now.expectedFeeKobo, -was.expectedFeeKobo]);
  batch.data.netKobo = sumMoney([Number(batch.data.grossKobo), -Number(batch.data.feeKobo)]);
  line.data.countedGrossKobo = now.grossKobo;
  line.data.assumedFeeKobo = now.feeKobo;
  if (!feesChecked(batch)) {
    for (const record of [batch, line]) { delete record.data.expectedFeeKobo; delete record.data.feeVarianceKobo; }
    return;
  }
  batch.data.feeVarianceKobo = sumMoney([Number(batch.data.feeKobo), -Number(batch.data.expectedFeeKobo)]);
  line.data.expectedFeeKobo = now.expectedFeeKobo;
  if (Math.abs(now.feeKobo - now.expectedFeeKobo) > SETTLEMENT_ITEM_TOLERANCE_KOBO) line.data.feeVarianceKobo = now.feeKobo - now.expectedFeeKobo;
  else delete line.data.feeVarianceKobo;
}

/** A settlement line that made its payment, from what it paid out when it stated no gross. */
export const madeItsPayment = (line: TypedRecord<"observations">): boolean => line.data.resolutionKey === "new_canonical_provider_reference" || line.data.resolutionKey === "separate_payment_after_review";

/** A line's payment. */
export type PaymentOf = (line: TypedRecord<"observations">) => TypedRecord<"payments"> | undefined;

/** What a counted line added to its batch: the gross it recorded, else stated, else the payout it made its payment from, else its payment's amount, and the fees it recorded. */
export function lineAdded(line: TypedRecord<"observations">, paymentOf: PaymentOf): LineTotals {
  const grossKobo = isKobo(line.data.countedGrossKobo) ? line.data.countedGrossKobo : line.data.grossAmountKobo !== undefined ? Number(line.data.grossAmountKobo) : madeItsPayment(line) ? line.amountKobo : Number(paymentOf(line)?.amountKobo);
  return { grossKobo, feeKobo: Number(line.data.assumedFeeKobo), expectedFeeKobo: isKobo(line.data.expectedFeeKobo) ? line.data.expectedFeeKobo : 0 };
}

/**
 * Whether a batch's totals are still the ones its lines added (lineAdded): a
 * batch Finance has corrected by hand, or one with a line missing or counted
 * with no recorded fee, is not.
 */
export function totalsFromLines(batch: TypedRecord<"settlement-batches">, lines: readonly (TypedRecord<"observations"> | undefined)[], paymentOf: PaymentOf): boolean {
  let grossKobo = 0, feeKobo = 0, expectedFeeKobo = 0;
  for (const line of lines) {
    if (!line || !isKobo(line.data.assumedFeeKobo)) return false;
    const added = lineAdded(line, paymentOf);
    grossKobo = sumMoney([grossKobo, added.grossKobo]); feeKobo = sumMoney([feeKobo, added.feeKobo]); expectedFeeKobo = sumMoney([expectedFeeKobo, added.expectedFeeKobo]);
  }
  return grossKobo === batch.data.grossKobo && feeKobo === batch.data.feeKobo && expectedFeeKobo === Number(batch.data.expectedFeeKobo ?? 0);
}

/** A batch's first counted line gives it its currency, and the fee schedule for that currency when there is one. */
export function takeLineCurrency(batch: TypedRecord<"settlement-batches">, currency: string, schedule: ProviderFeeSchedule | undefined): void {
  batch.data.currency = currency;
  if (schedule) { batch.data.feeSchedule ??= schedule; batch.data.expectedFeeKobo ??= 0; return; }
  for (const key of ["feeSchedule", "expectedFeeKobo", "feeVarianceKobo"]) delete batch.data[key];
}
