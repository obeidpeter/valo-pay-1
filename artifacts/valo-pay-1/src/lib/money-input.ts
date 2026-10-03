/** Form and import amounts use the same exact parser; API amounts remain integer kobo, or another currency's minor unit. */
export { MoneyInputError, nairaToKobo, koboToNaira, majorToMinor, minorToMajor } from '@workspace/valo-pay-1-schema';

/** Existing form definitions still identify API fields by their canonical Kobo names: the label names the currency they are entered in, naira unless given. */
export function moneyFieldLabel(label: string, currency = 'NGN'): string {
  const code = currency.trim().toUpperCase() || 'NGN', unit = code === 'NGN' ? '₦' : code;
  if (/\([^)]*kobo[^)]*\)/i.test(label)) return label.replace(/\([^)]*kobo[^)]*\)/i, `(${unit})`);
  if (code === 'NGN') return label.includes('₦') ? label : `${label} (₦)`;
  return label.includes('(₦)') ? label.replace('(₦)', `(${unit})`) : `${label} (${unit})`;
}
