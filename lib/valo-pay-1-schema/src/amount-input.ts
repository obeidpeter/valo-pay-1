import { currencyMinorUnit, moneyText } from "./text";
import { importFieldsOf } from "./import-mapping";

/** Exact decimal parsing shared by forms and CSV imports. Stored money is integer kobo, or another currency's minor unit. */
export class MoneyInputError extends Error {}

/** Parse a decimal naira string without floating-point multiplication. */
export function nairaToKobo(value: string): number {
  const input = value.trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{0,2})?$/.test(input)) {
    throw new MoneyInputError('Enter an amount in naira with no more than 2 decimal places, for example 1,000.50.');
  }
  const [whole, fraction = ''] = input.replace(/,/g, '').split('.');
  const kobo = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (kobo > BigInt(Number.MAX_SAFE_INTEGER)) throw new MoneyInputError('Enter an amount of ₦90,071,992,547,409.91 or less.');
  return Number(kobo);
}

/** Format an integer kobo amount exactly, including the safe-integer boundary. */
export function koboToNaira(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new MoneyInputError('The stored amount must be a non-negative whole number of kobo.');
  const kobo = BigInt(value);
  return `${kobo / 100n}.${String(kobo % 100n).padStart(2, '0')}`;
}

/** A currency code as a record names it: in capitals, naira when it names none. */
const codeOf = (currency: string | undefined): string => String(currency || "NGN").trim().toUpperCase();

/**
 * Parse a decimal amount in a currency's major unit into its minor unit, the
 * unit a payment stores, with the currency's decimals by ISO 4217
 * (currencyMinorUnit) and no floating-point multiplication: naira as
 * nairaToKobo does, USD 1,000.50 as 100050 cents, JPY 1,000 as 1000 and KWD
 * 1.5 as 1500. More decimals than the currency has, or a code ISO 4217 gives
 * no minor unit, are refused.
 */
export function majorToMinor(value: string, currency?: string): number {
  const code = codeOf(currency);
  if (code === "NGN") return nairaToKobo(value);
  const digits = currencyMinorUnit(code);
  if (digits === undefined) throw new MoneyInputError(`Valo Pay 1 cannot read an amount in ${code} in its main unit, because ${code} has no smaller unit. Check the currency code, or enter the amount in its smallest unit.`);
  const input = value.trim();
  if (!new RegExp(`^(?:\\d+|\\d{1,3}(?:,\\d{3})+)${digits ? `(?:\\.\\d{0,${digits}})?` : ""}$`).test(input)) {
    const example = digits ? `1,000.${"5".padEnd(digits, "0")}` : "1,000";
    throw new MoneyInputError(`Enter an amount in ${code} with ${digits ? `no more than ${digits} decimal place${digits === 1 ? "" : "s"}` : "no decimal places"}, for example ${example}.`);
  }
  const [whole, fraction = ""] = input.replace(/,/g, "").split(".");
  const minor = BigInt(whole!) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, "0") || "0");
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new MoneyInputError(`Enter an amount of ${moneyText(Number.MAX_SAFE_INTEGER, code)} or less.`);
  return Number(minor);
}

/** An amount in a currency's minor unit written exactly in its major unit, as a form field shows it: 1000.50 for 100050 US cents, 1000 for JPY 1,000. */
export function minorToMajor(value: number, currency?: string): string {
  const code = codeOf(currency);
  const digits = code === "NGN" ? 2 : currencyMinorUnit(code);
  if (digits === undefined) throw new MoneyInputError(`Valo Pay 1 cannot write an amount in ${code} in its main unit, because ${code} has no smaller unit.`);
  if (!Number.isSafeInteger(value) || value < 0) throw new MoneyInputError(`The saved amount must be a whole number of 0 or more, in the smallest unit of ${code}.`);
  const minor = BigInt(value), unit = 10n ** BigInt(digits);
  return digits ? `${minor / unit}.${String(minor % unit).padStart(digits, "0")}` : String(minor);
}

/**
 * Decode a CSV source amount in its explicitly chosen unit: `naira` is the
 * major unit of the row's currency (naira when it names none), converted with
 * that currency's decimals (majorToMinor), and `kobo` its minor unit as a whole
 * number. A minor-unit amount that is not one names the row's smallest unit
 * and the other unit as the import screens call it for the kind (amountUnitName).
 */
export function csvAmountToKobo(value: string, unit: 'naira' | 'kobo', currency?: string, kind = ''): number {
  if (unit === 'naira') return majorToMinor(value, currency);
  const input = value.trim();
  if (!/^\d+$/.test(input) || !Number.isSafeInteger(Number(input))) {
    const code = codeOf(currency), major = amountUnitName('naira', kind);
    throw new MoneyInputError(code === "NGN"
      ? `Enter kobo as a whole number without commas or decimals, for example 100000. Choose ${major} if the source uses naira.`
      : `Enter the smallest unit of ${code} as a whole number without commas or decimals, for example 100000. Choose ${major} if the source gives amounts in ${code} rather than its smallest unit.`);
  }
  return Number(input);
}

/**
 * What an import screen calls a source amount unit. A row of payment evidence
 * can name its own currency, whose units it is then read in (csvAmountToKobo),
 * so for such a kind the units are the major and minor units, not naira and kobo.
 */
export function amountUnitName(unit: 'naira' | 'kobo', kind: string): string {
  const ownCurrency = importFieldsOf(kind).includes("currency");
  if (unit === 'naira') return ownCurrency ? "Main unit (₦, or the row’s own currency)" : "Naira (₦)";
  return ownCurrency ? "Smallest unit (kobo, or the smallest unit of the row’s own currency)" : "Kobo";
}
