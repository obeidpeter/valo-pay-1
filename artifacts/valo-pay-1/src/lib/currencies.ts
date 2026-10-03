import type { OtherCurrencies } from '@workspace/valo-pay-1-api-client-react';
import { currencyMinorUnit, importFieldsOf, smallestUnitText } from '@workspace/valo-pay-1-schema';
import { MARKET_LOCALE, formatCount, formatKobo, formatNumber } from './formatters';

/**
 * Money in another currency than naira, which a close or a report lists beside
 * its naira totals (`otherCurrencies`) and never adds to them. Only pages show
 * it, never the shell, so it stays out of `formatters`, which the shell carries.
 */
type Layout = { format: Intl.NumberFormat; unit: bigint; digits: number; positive: Intl.NumberFormatPart[]; negative: Intl.NumberFormatPart[] };
/**
 * Each currency's layout (sign, code and separators) and how many minor units make one, by code; null for a code ISO
 * 4217 gives no minor unit. The decimals are the shared table's (currencyMinorUnit), which the API's moneyText reads
 * too, stated to Intl as its minimum and maximum: the browser's own figures differ between browsers.
 */
const layouts = new Map<string, Layout | null>();
function layoutOf(code: string): Layout | null {
  if (!layouts.has(code)) {
    const digits = currencyMinorUnit(code);
    let layout: Layout | null = null;
    if (digits !== undefined) {
      const format = new Intl.NumberFormat(MARKET_LOCALE, { style: 'currency', currency: code, currencyDisplay: 'code', minimumFractionDigits: digits, maximumFractionDigits: digits });
      layout = { format, unit: 10n ** BigInt(digits), digits, positive: format.formatToParts(1), negative: format.formatToParts(-1) };
    }
    layouts.set(code, layout);
  }
  return layouts.get(code)!;
}

/**
 * An amount in a currency's minor unit, as a payment stores it, in that
 * currency with its code and the market's grouping: USD 1,000.00, JPY 1,000,
 * KWD 1,000.000; naira as formatKobo shows it. The decimals are ISO 4217's, as
 * the API writes them, whatever the browser. A whole number is split into units
 * and the rest with integer arithmetic, as formatKobo splits kobo, so every safe
 * integer shows exactly. A code ISO 4217 gives no minor unit is shown as given,
 * with the amount in its smallest unit, as the API says it.
 */
export function formatMinor(amount: number, currency: string): string {
  const code = currency.trim().toUpperCase();
  if (code === 'NGN') return formatKobo(amount);
  const layout = layoutOf(code);
  if (!layout) return smallestUnitText(amount, code);
  if (!Number.isSafeInteger(amount)) return layout.format.format(amount / Number(layout.unit));
  const minor = BigInt(amount), whole = minor < 0n ? -minor : minor;
  return (minor < 0n ? layout.negative : layout.positive)
    .map(part => part.type === 'integer' ? formatNumber(Number(whole / layout.unit)) : part.type === 'fraction' ? String(whole % layout.unit).padStart(layout.digits, '0') : part.value)
    .join('');
}

/**
 * A record's money in the currency it names when its kind has a currency field (a payment and its evidence, a settlement
 * batch, an exception about money in another currency), naira otherwise: a currency column imported with instalments,
 * mandates or attempts is kept as detail, and their amounts are read and held in kobo whatever it says.
 */
export function formatRecordMoney(record: { kind: string; data?: { currency?: unknown } | null } | null | undefined, amount: number): string {
  return formatMinor(amount, String((record && importFieldsOf(record.kind).includes('currency') && record.data?.currency) || 'NGN'));
}

/**
 * Money held in other currencies than naira, as the contract's OtherCurrencies
 * lists it (a close's `otherCurrencies`, a customer position's
 * `unallocatedOtherCurrencies`: by currency code, a count and an amount in that
 * currency's minor unit), by code: each currency's money in that currency
 * ("USD 1,000.00") and what it counts ("1 payment"). Empty with none.
 */
export function otherCurrencyEntries(otherCurrencies: OtherCurrencies | null | undefined, singular: string, pluralForm?: string): { code: string; money: string; counted: string }[] {
  // A close's report reaches the page untyped, so anything but an object lists nothing.
  return Object.entries(otherCurrencies && typeof otherCurrencies === 'object' ? otherCurrencies as Record<string, Partial<OtherCurrencies[string]> | null> : {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([code, entry]) => ({ code, money: formatMinor(Number(entry?.amount ?? 0), code), counted: formatCount(Number(entry?.count ?? 0), singular, pluralForm) }));
}

/**
 * A naira total with the money held beside it in other currencies, which is
 * never added to it, each with what it counts (otherCurrencyEntries):
 * "₦32,000.00 and USD 1,000.00 (1 payment)". With none, the naira total alone.
 */
export function formatWithOtherCurrencies(kobo: number, otherCurrencies: OtherCurrencies | null | undefined, singular: string, pluralForm?: string): string {
  const amounts = [formatKobo(kobo), ...otherCurrencyEntries(otherCurrencies, singular, pluralForm).map(({ money, counted }) => `${money} (${counted})`)];
  return amounts.length === 1 ? amounts[0]! : `${amounts.slice(0, -1).join(', ')} and ${amounts.at(-1)}`;
}
