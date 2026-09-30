/**
 * Wording helpers shared by the API and the console, so a count, an amount and a
 * date read the same everywhere and the market's conventions are named once.
 */
import { WAT_OFFSET_MS } from "./policy";

/** Nigerian English for numbers and money: 1,234.56 and the naira sign. */
export const MARKET_LOCALE = "en-NG";

const numberFormat = new Intl.NumberFormat(MARKET_LOCALE);
const moneyFormat = new Intl.NumberFormat(MARKET_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// The layout (separators) of an amount above zero; a credit's sign goes before the naira sign, as the console writes it.
const moneyLayout = { positive: moneyFormat.formatToParts(1) };
const pluralRules = new Intl.PluralRules(MARKET_LOCALE);

/** A count with its noun in the right number: "1 item", "0 items", "1,234 records". An irregular plural is passed in. */
export function counted(count: number, singular: string, plural = `${singular}s`): string {
  return `${numberFormat.format(count)} ${pluralRules.select(count) === "one" ? singular : plural}`;
}
/**
 * A length of time as people read it, from whole minutes: "45 minutes" under
 * two hours, then hours under two days, then days, with "about" when the time
 * is not a whole number of them ("about 3 hours").
 */
export function durationText(minutes: number): string {
  const whole = Math.max(0, Math.floor(minutes));
  if (whole < 120) return counted(whole, "minute");
  const [unit, size] = whole < 2880 ? ["hour", 60] as const : ["day", 1440] as const;
  return `${whole % size === 0 ? "" : "about "}${counted(Math.round(whole / size), unit)}`;
}
/**
 * An amount in kobo as Valo Pay writes money for people, in messages, notes and
 * PDFs: "₦25,000.00", and "-₦1.50" for a credit, as the console shows it. A whole
 * number of kobo is split into naira and kobo with integer arithmetic, so every
 * safe integer reads exactly; dividing by 100 as a float loses a kobo above about
 * ₦10 trillion. CSV and JSON files keep amounts as numbers.
 */
export function nairaText(kobo: number): string {
  if (!Number.isSafeInteger(kobo)) return `${kobo < 0 ? "-" : ""}₦${moneyFormat.format(Math.abs(kobo) / 100)}`;
  const minor = BigInt(kobo), whole = minor < 0n ? -minor : minor;
  const parts = moneyLayout.positive
    .map((part) => part.type === "integer" ? numberFormat.format(whole / 100n) : part.type === "fraction" ? String(whole % 100n).padStart(2, "0") : part.value);
  return `${minor < 0n ? "-" : ""}₦${parts.join("")}`;
}

/** Currency codes with the same number of decimal places, as a table's entries. */
const withDecimals = (digits: number, codes: string) => codes.split(" ").map((code) => [code, digits] as const);
/**
 * The decimal places of each currency's minor unit, the unit a payment stores its
 * amount in, as ISO 4217 List One gives them (current codes and a few recently
 * withdrawn). One table for the API and the console: the runtime's own figures,
 * from its copy of CLDR, differ between runtimes (Node 22 gave COP, HUF, IDR and
 * PKR no decimals and RSD two, Chromium 141 the reverse), so the same payment was
 * printed 100 times apart. Codes with no minor unit (gold, the SDR, the testing
 * and no-currency codes) are left out, like any code ISO 4217 does not list.
 */
const minorUnits: ReadonlyMap<string, number> = new Map([
  ...withDecimals(0, "BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF"),
  ...withDecimals(3, "BHD IQD JOD KWD LYD OMR TND"),
  ...withDecimals(4, "CLF UYW"),
  ...withDecimals(2, "AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CNY COP COU CRC CUC CUP CVE CZK DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GTQ GYD HKD HNL HRK HTG HUF IDR ILS INR IRR JMD KES KGS KHR KPW KYD KZT LAK LBP LKR LRD LSL MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD PAB PEN PGK PHP PKR PLN QAR RON RSD RUB SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TOP TRY TTD TWD TZS UAH USD USN UYU UZS VED VES WST XCD XCG YER ZAR ZMW ZWG ZWL"),
]);
/** The decimal places of a currency's minor unit by ISO 4217 (2 for USD, 0 for JPY, 3 for KWD), or undefined for a code it gives none. */
export function currencyMinorUnit(currency: string): number | undefined {
  return minorUnits.get(String(currency).trim().toUpperCase());
}
/**
 * An amount in a currency whose minor unit is not known (a code ISO 4217 gives
 * none), in that smallest unit rather than with guessed decimals: "100,000 in the
 * smallest unit of XAU".
 */
export function smallestUnitText(amount: number, currency: string): string {
  const code = String(currency).trim().toUpperCase();
  return `${numberFormat.format(amount)} in the smallest unit of ${code || "an unnamed currency"}`;
}
/**
 * An amount in its currency's minor unit, as a payment stores it, written the
 * way Valo Pay writes money for people: naira as nairaText does ("₦25,000.00"),
 * any other currency by its code with its ISO 4217 decimals ("USD 1,000.00" for
 * 100,000 cents), with the same integer arithmetic, and a code without them as
 * smallestUnitText does. The console's formatMinor prints the same figure.
 */
export function moneyText(amount: number, currency = "NGN"): string {
  const code = String(currency || "NGN").trim().toUpperCase();
  if (code === "NGN") return nairaText(amount);
  const digits = currencyMinorUnit(code);
  if (digits === undefined) return smallestUnitText(amount, code);
  const layout = new Intl.NumberFormat(MARKET_LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (!Number.isSafeInteger(amount)) return `${code} ${layout.format(amount / 10 ** digits)}`;
  const minor = BigInt(amount), whole = minor < 0n ? -minor : minor, unit = 10n ** BigInt(digits);
  const parts = layout.formatToParts(minor < 0n ? -1 : 1)
    .map((part) => part.type === "integer" ? numberFormat.format(whole / unit) : part.type === "fraction" ? String(whole % unit).padStart(digits, "0") : part.value);
  return `${code} ${parts.join("")}`;
}
/**
 * Money in currencies other than naira, as the close and the billing statement
 * list it beside a naira total (otherCurrencies: each code's count and amount
 * in its minor unit), for a sentence: "EUR 50.00 and USD 1,000.00", by code.
 */
export function otherCurrenciesText(other: Readonly<Record<string, { amount: number }>> | undefined): string {
  const rows = Object.entries(other ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return new Intl.ListFormat("en-GB").format(rows.map(([code, row]) => moneyText(row.amount, code)));
}

/** The short names of the months as the console's dates write them (en-GB): "Sept", not "Sep". */
const shortMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"] as const;
const longMonths = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
const DAY_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_ONLY = /^(\d{4})-(\d{2})$/;
const two = (value: number) => String(value).padStart(2, "0");
/** The West Africa Time calendar parts of an instant, a YYYY-MM-DD day as it is, or undefined for anything that is not a date. */
function watParts(value: unknown): { year: number; month: number; day: number; hour?: number; minute?: number } | undefined {
  if (typeof value === "string" && DAY_ONLY.test(value)) {
    const [, year, month, day] = DAY_ONLY.exec(value)!.map(Number);
    const date = new Date(Date.UTC(year!, month! - 1, day!));
    return date.getUTCMonth() === month! - 1 && date.getUTCDate() === day ? { year: year!, month: month!, day: day! } : undefined;
  }
  const ms = typeof value === "number" ? value : value instanceof Date ? value.getTime() : typeof value === "string" && value.trim() ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) return undefined;
  const wat = new Date(ms + WAT_OFFSET_MS);
  return Number.isFinite(wat.getTime()) ? { year: wat.getUTCFullYear(), month: wat.getUTCMonth() + 1, day: wat.getUTCDate(), hour: wat.getUTCHours(), minute: wat.getUTCMinutes() } : undefined;
}
/**
 * A day as people read it, "29 Sept 2026", as the console writes dates: a
 * YYYY-MM-DD day as it is, and an instant as its day in West Africa Time.
 * Anything that is not a date is returned as it was given.
 */
export function dayText(value: unknown): string {
  const parts = watParts(value);
  return parts ? `${parts.day} ${shortMonths[parts.month - 1]} ${parts.year}` : String(value ?? "");
}
/**
 * An instant as people read it, "29 Sept 2026, 14:05 WAT", as the console
 * writes it: its date and 24-hour time in West Africa Time. A YYYY-MM-DD day
 * is only a day, with no invented time; anything else is returned as given.
 */
export function instantText(value: unknown): string {
  const parts = watParts(value);
  if (!parts) return String(value ?? "");
  const day = `${parts.day} ${shortMonths[parts.month - 1]} ${parts.year}`;
  return parts.hour === undefined ? day : `${day}, ${two(parts.hour)}:${two(parts.minute!)} WAT`;
}
/** A billing month (YYYY-MM), or the month of an instant in West Africa Time, as people read it: "September 2026". */
export function monthText(value: unknown): string {
  const month = typeof value === "string" ? MONTH_ONLY.exec(value) : null;
  if (month && Number(month[2]) >= 1 && Number(month[2]) <= 12) return `${longMonths[Number(month[2]) - 1]} ${month[1]}`;
  const parts = watParts(value);
  return parts ? `${longMonths[parts.month - 1]} ${parts.year}` : String(value ?? "");
}
