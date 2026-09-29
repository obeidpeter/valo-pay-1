/**
 * Rates are typed in per cent and kept as the API keeps them: basis points (whole hundredths of a per cent, such as a
 * usage fee rate) or a fraction of 1 (such as an experiment's baseline recovery rate). The conversions move the
 * decimal point in the digits the person typed or the service stored. They never multiply floating-point numbers,
 * so 0.07 shows as 7 and 7 is saved as 0.07 exactly.
 */
export class PercentInputError extends Error {}

/** How a per cent field is stored by the API. */
export type PercentStorage = 'basisPoints' | 'fraction';

const PERCENT_RULE = 'Enter a percentage from 0 to 100 with no more than 2 decimal places, for example 0.3 or 40.';

/** The whole and decimal digits of a typed percentage from 0 to 100, with at most 2 decimals; a trailing % is allowed. */
function typedPercent(value: string): { whole: string; decimals: string } {
  const input = value.trim().replace(/\s*%$/, '');
  const parts = /^(\d*)(?:\.(\d*))?$/.exec(input);
  if (!parts || !/\d/.test(input)) throw new PercentInputError(PERCENT_RULE);
  const whole = (parts[1] || '0').replace(/^0+(?=\d)/, ''), decimals = (parts[2] || '').replace(/0+$/, '');
  if (decimals.length > 2 || Number(whole) > 100 || (Number(whole) === 100 && decimals)) throw new PercentInputError(PERCENT_RULE);
  return { whole, decimals };
}

/** A typed percentage as whole basis points: "0.3" is 30, "12.5" is 1250 and "100" is 10000. */
export function percentToBasisPoints(value: string): number {
  const { whole, decimals } = typedPercent(value);
  return Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
}

/** Whole basis points as a percentage for a form field: 30 is "0.3", 1250 is "12.5" and 10000 is "100". */
export function basisPointsToPercent(basisPoints: number): string {
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0) throw new PercentInputError('The saved rate is not a whole number of basis points.');
  const whole = Math.floor(basisPoints / 100), decimals = String(basisPoints % 100).padStart(2, '0').replace(/0+$/, '');
  return decimals ? `${whole}.${decimals}` : String(whole);
}

/** A typed percentage as a fraction of 1: "40" is 0.4, "37.5" is 0.375 and "0.05" is 0.0005. */
export function percentToFraction(value: string): number {
  const { whole, decimals } = typedPercent(value);
  const digits = whole.padStart(3, '0');
  return Number(`${digits.slice(0, -2)}.${digits.slice(-2)}${decimals}`);
}

/** A fraction's shortest decimal digits, without an exponent: 1e-7 is "0.0000001". */
function plainDecimal(value: number): string {
  const text = String(value), exponent = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(text);
  if (!exponent) return text;
  const digits = `${exponent[1]}${exponent[2] || ''}`, point = exponent[1]!.length + Number(exponent[3]);
  if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`;
  return point >= digits.length ? digits.padEnd(point, '0') : `${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** A fraction of 1 as a percentage for a form field: 0.4 is "40", 0.375 is "37.5" and 0.07 is "7". */
export function fractionToPercent(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction < 0) throw new PercentInputError('The saved rate is not a fraction from 0 upwards.');
  const [whole = '0', decimals = ''] = plainDecimal(fraction).split('.');
  const moved = decimals.padEnd(2, '0');
  const percentWhole = `${whole}${moved.slice(0, 2)}`.replace(/^0+(?=\d)/, ''), percentDecimals = moved.slice(2).replace(/0+$/, '');
  return percentDecimals ? `${percentWhole}.${percentDecimals}` : percentWhole;
}

/** A typed percentage in the unit its field is stored in. Throws PercentInputError, in words a person can act on. */
export function percentToStored(storage: PercentStorage, value: string): number {
  return storage === 'basisPoints' ? percentToBasisPoints(value) : percentToFraction(value);
}

/** A stored rate as the percentage its field shows, exactly; a value that is not a stored rate is shown as it is. */
export function storedToPercent(storage: PercentStorage, value: unknown): string {
  try {
    return storage === 'basisPoints' ? basisPointsToPercent(Number(value)) : fractionToPercent(Number(value));
  } catch {
    return String(value ?? '');
  }
}
