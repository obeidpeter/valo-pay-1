/**
 * The console's conventions, in one place: British English words and dates
 * (18 Sept 2026, 23:30), the market's numbers and money (₦25,000.00), and every
 * instant in West Africa Time, the lender's operating zone, whatever the
 * viewer's device is set to. Lagos has kept UTC+1 all year since 1949, so the
 * zone label never changes.
 */
export const DATE_LOCALE = 'en-GB';
/** Nigerian English for numbers and money. */
export const MARKET_LOCALE = 'en-NG';
/** The lender's operating zone, applied to every instant shown. */
export const TIME_ZONE = 'Africa/Lagos';
/** The zone's name as shown after a time. */
export const TIME_ZONE_LABEL = 'WAT';

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const instant = new Intl.DateTimeFormat(DATE_LOCALE, { dateStyle: 'medium', timeStyle: 'short', timeZone: TIME_ZONE });
const day = new Intl.DateTimeFormat(DATE_LOCALE, { day: 'numeric', month: 'short', year: 'numeric', timeZone: TIME_ZONE });
const naira = new Intl.NumberFormat(MARKET_LOCALE, { style: 'currency', currency: 'NGN', minimumFractionDigits: 2 });
const number = new Intl.NumberFormat(MARKET_LOCALE);
const plural = new Intl.PluralRules(MARKET_LOCALE);
// The currency's own layout (sign, symbol and separators) for an amount above zero and one below.
const nairaLayout = { positive: naira.formatToParts(1), negative: naira.formatToParts(-1) };
const percents = new Map<string, Intl.NumberFormat>();
const percentFormat = (minimumFractionDigits: number, maximumFractionDigits: number) => {
  const key = `${minimumFractionDigits}-${maximumFractionDigits}`;
  if (!percents.has(key)) percents.set(key, new Intl.NumberFormat(MARKET_LOCALE, { style: 'percent', minimumFractionDigits, maximumFractionDigits }));
  return percents.get(key)!;
};
const points = new Intl.NumberFormat(MARKET_LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * An amount in kobo as naira: ₦25,000.00. A whole number of kobo is split into
 * naira and kobo with integer arithmetic, so every safe integer shows exactly;
 * dividing by 100 as a float loses a kobo above about ₦70 trillion.
 */
export function formatKobo(kobo: number): string {
  if (!Number.isSafeInteger(kobo)) return naira.format(kobo / 100);
  const minor = BigInt(kobo), whole = minor < 0n ? -minor : minor;
  return (minor < 0n ? nairaLayout.negative : nairaLayout.positive)
    .map(part => part.type === 'integer' ? number.format(whole / 100n) : part.type === 'fraction' ? String(whole % 100n).padStart(2, '0') : part.value)
    .join('');
}

/** A plain number with the market's grouping: 20,000. */
export function formatNumber(value: number): string {
  return number.format(value);
}

/**
 * A ratio as a percentage in the market's conventions: 0.123 is "12.3%". With
 * `fractionDigits`, exactly that many decimal places (0.12 at one place is
 * "12.0%"); without, only the places the value needs, up to two (0.12 is
 * "12%", 0.0025 is "0.25%"), as for basis points (bps / 10000).
 */
export function formatPercent(ratio: number, fractionDigits?: number): string {
  return (fractionDigits === undefined ? percentFormat(0, 2) : percentFormat(fractionDigits, fractionDigits)).format(ratio);
}

/** A difference between two ratios in percentage points, to one decimal place: 0.085 is "8.5 percentage points". */
export function formatPercentagePoints(difference: number): string {
  return `${points.format(difference * 100)} percentage points`;
}

/** A count with its noun in the right number: "1 item", "0 items", "1,234 records". An irregular plural is passed in. (The API's `counted` in the schema package is the same rule; the console keeps its own so the shell does not carry that package.) */
export function formatCount(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${number.format(count)} ${plural.select(count) === 'one' ? singular : pluralForm}`;
}

/** An instant as its date and time in West Africa Time with the zone named. A value that is only a day (YYYY-MM-DD) is shown as that day, with no invented time. */
export function formatDate(dateStr: string): string {
  if (!dateStr) return 'Not recorded';
  const date = new Date(dateStr);
  if (!Number.isFinite(date.getTime())) return dateStr === 'Not closed yet' ? 'Not closed yet' : 'Not recorded';
  if (DAY_ONLY.test(dateStr)) return day.format(date);
  return `${instant.format(date)} ${TIME_ZONE_LABEL}`;
}

/** The day of an instant in West Africa Time: 28 Jun 2027. */
export function formatCompactDate(dateStr: string): string {
  if (!dateStr || !Number.isFinite(new Date(dateStr).getTime())) return 'Not recorded';
  return day.format(new Date(dateStr));
}
