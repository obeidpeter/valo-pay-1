import { describe, expect, it } from 'vitest';
import { currencyMinorUnit, moneyText, otherCurrenciesText } from '@workspace/valopay-schema';
import { formatMinor, formatRecordMoney, formatWithOtherCurrencies } from '@/lib/currencies';

// Third review of the audit fixes, finding 2: the API took a currency's decimals from Node's copy of CLDR and the console
// from the browser's, which disagree (Node 22 gave COP, HUF, IDR and PKR none and RSD two, Chromium 141 the reverse), so
// the same payment was printed 100 times apart. One ISO 4217 table in the shared schema now gives both their decimals.

/** The console's text as the API writes it: Intl puts a no-break space between a currency code and the amount. */
const asTheApiWrites = (text: string) => text.replace(/ /g, ' ');

/** Runs `check` in a runtime whose Intl gives every currency `digits` decimals unless it is told how many, as a browser with another copy of CLDR would. */
function withRuntimeDecimals(digits: number, check: () => void) {
  const real = globalThis.Intl;
  const NumberFormat = function (locales?: string | string[], options?: Intl.NumberFormatOptions) {
    const told = options?.minimumFractionDigits !== undefined || options?.maximumFractionDigits !== undefined;
    return new real.NumberFormat(locales, options?.style === 'currency' && !told ? { ...options, minimumFractionDigits: digits, maximumFractionDigits: digits } : options);
  } as unknown as typeof Intl.NumberFormat;
  globalThis.Intl = Object.create(real, { NumberFormat: { value: NumberFormat } });
  try { check(); } finally { globalThis.Intl = real; }
}

describe('money in another currency: one figure in the API and in every browser', () => {
  it('never takes a currency\'s decimals from the runtime, whose copy of CLDR differs between browsers', () => {
    for (const digits of [0, 3]) withRuntimeDecimals(digits, () => {
      expect(moneyText(500_000, 'EUR'), `a runtime giving ${digits}`).toBe('EUR 5,000.00');
      expect(asTheApiWrites(formatMinor(500_000, 'EUR')), `a runtime giving ${digits}`).toBe('EUR 5,000.00');
      expect(moneyText(1_500, 'ISK')).toBe('ISK 1,500');
      expect(asTheApiWrites(formatMinor(1_500, 'ISK'))).toBe('ISK 1,500');
      expect(moneyText(2_500, 'BHD')).toBe('BHD 2.500');
      expect(asTheApiWrites(formatMinor(2_500, 'BHD'))).toBe('BHD 2.500');
    });
  });

  it('takes each currency\'s decimals from ISO 4217: COP, HUF, IDR, PKR and RSD two, JPY none, KWD three, CLF four', () => {
    const cases: Array<[string, number, string]> = [
      ['COP', 100_000, 'COP 1,000.00'], ['HUF', 123_456, 'HUF 1,234.56'], ['IDR', 1_500_000, 'IDR 15,000.00'], ['PKR', 250_075, 'PKR 2,500.75'],
      ['RSD', 5_000, 'RSD 50.00'], ['JPY', 1_000, 'JPY 1,000'], ['KWD', 1_234_567, 'KWD 1,234.567'], ['CLF', 12_345, 'CLF 1.2345'], ['USD', 100_000, 'USD 1,000.00'],
    ];
    for (const [code, amount, text] of cases) {
      expect(moneyText(amount, code), code).toBe(text);
      expect(asTheApiWrites(formatMinor(amount, code)), code).toBe(text);
      expect(moneyText(amount, ` ${code.toLowerCase()} `), code).toBe(text);
    }
    expect('COP HUF IDR PKR RSD JPY KWD CLF USD NGN'.split(' ').map(currencyMinorUnit)).toEqual([2, 2, 2, 2, 2, 0, 3, 4, 2, 2]);
  });

  it('writes a code with no ISO 4217 minor unit in its smallest unit, in the same words on both sides', () => {
    for (const code of ['ABC', 'XAU', 'DOLLARS']) {
      expect(currencyMinorUnit(code)).toBeUndefined();
      expect(moneyText(100_000, code)).toBe(`100,000 in the smallest unit of ${code}`);
      expect(formatMinor(100_000, code)).toBe(`100,000 in the smallest unit of ${code}`);
    }
    expect(moneyText(5, ' ')).toBe('5 in the smallest unit of an unnamed currency');
    expect(formatMinor(5, ' ')).toBe('5 in the smallest unit of an unnamed currency');
  });

  it('prints the same figure on both sides for every currency the runtime knows, naira included', () => {
    // Naira reads ₦25,000.00 on the console's pages and in the API's messages alike.
    for (const code of Intl.supportedValuesOf('currency')) for (const amount of [0, 7, 123_456, 9_007_199_254_740_991]) {
      expect(asTheApiWrites(formatMinor(amount, code)), code).toBe(moneyText(amount, code));
    }
    expect(moneyText(2_500_000, 'NGN')).toBe('₦25,000.00');
  });

  // Review of the integration fixes, finding 1: a currency column imported onto a kind with no currency field is kept as
  // detail and its amount is in kobo, so only a kind that carries its own currency is shown in the one it names.
  it('shows a record\'s money in the currency it names only for a kind that carries one', () => {
    for (const kind of ['observations', 'payments', 'settlement-batches', 'exceptions']) {
      expect(asTheApiWrites(formatRecordMoney({ kind, data: { currency: 'USD' } }, 100_000)), kind).toBe('USD 1,000.00');
      expect(formatRecordMoney({ kind, data: {} }, 100_000), kind).toBe('₦1,000.00');
    }
    for (const kind of ['due-items', 'mandates', 'attempts', 'customers', 'allocations']) {
      expect(formatRecordMoney({ kind, data: { currency: 'JPY' } }, 100_000_000), kind).toBe('₦1,000,000.00');
    }
  });

  it('lists a close\'s money in other currencies with the same figures as the close\'s own line', () => {
    const other = { COP: { count: 1, amount: 100_000 }, HUF: { count: 1, amount: 123_456 }, RSD: { count: 1, amount: 5_000 } };
    expect(otherCurrenciesText(other)).toBe('COP 1,000.00, HUF 1,234.56 and RSD 50.00');
    expect(asTheApiWrites(formatWithOtherCurrencies(3_200_000, other, 'payment'))).toBe('₦32,000.00, COP 1,000.00 (1 payment), HUF 1,234.56 (1 payment) and RSD 50.00 (1 payment)');
  });
});
