import assert from 'node:assert/strict';
import { databaseMoney } from '../src/lib/database-money';
import { MoneyArithmeticError } from '@workspace/valo-pay-1-schema';

for (const value of [0, 1, 123456, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]) {
  assert.equal(databaseMoney(value), value);
  assert.equal(databaseMoney(String(value)), value);
}
for (const value of ['9007199254740992', '9007199254740993', '-9007199254740992', '18014398509481982']) {
  assert.throws(() => databaseMoney(value), (error: unknown) => error instanceof MoneyArithmeticError && error.code === 'MONEY_OUT_OF_RANGE');
}
for (const value of ['', '1.5', '1e3', 'Infinity', ' 12 ', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  assert.throws(() => databaseMoney(value), MoneyArithmeticError);
}
console.log('Database money checks passed: exact decimal-string reads and refusal of unsupported SQL aggregates before Number conversion.');
