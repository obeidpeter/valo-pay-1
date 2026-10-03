import { integerMoney, moneyFromBigInt, MoneyArithmeticError } from '@workspace/valo-pay-1-schema';

/** pg returns bigint/numeric aggregates as decimal strings. Do not round them
 * through Number before deciding whether the v1 minor-unit range is supported. */
export function databaseMoney(value: string | number): number {
  if (typeof value === 'number') return integerMoney(value);
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new MoneyArithmeticError('INVALID_MONEY_AMOUNT', 'The stored monetary value is not an integer minor-unit amount.');
  }
  return moneyFromBigInt(BigInt(value));
}
