import { describe, expect, it } from 'vitest';
import { koboToNaira, MoneyInputError, nairaToKobo } from '@/lib/money-input';

describe('naira form amounts', () => {
  it.each([
    ['0', 0], ['0.01', 1], ['0.29', 29], ['1.15', 115], ['12.3', 1230],
    ['1,234.56', 123456], [' 32000.00 ', 3200000], ['90071992547409.91', Number.MAX_SAFE_INTEGER],
  ])('converts %s to exact integer kobo and back', (input, kobo) => {
    expect(nairaToKobo(input)).toBe(kobo);
    expect(nairaToKobo(koboToNaira(kobo))).toBe(kobo);
  });

  it.each(['', '-1', '1.001', '1e3', 'Infinity', 'NaN', '1,00', '90071992547409.92'])('rejects %s instead of rounding or changing its meaning', input => {
    expect(() => nairaToKobo(input)).toThrow(MoneyInputError);
  });
});
