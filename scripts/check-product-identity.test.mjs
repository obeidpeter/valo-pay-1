import assert from 'node:assert/strict';
import { identityOccurrences, unapprovedOccurrences, digest, duplicateGeneration } from './check-product-identity.mjs';
const oldName = ['Valo', 'Pay'].join(' ');
const path = 'fixture.ts';
for (const value of ['Valo Pay 1', 'ValoPay1', 'valoPay1', 'valo-pay-1', 'valo_pay_1', 'VALO_PAY_1_ENVIRONMENT', 'valo-pay-1:test:theme']) {
  assert.equal(identityOccurrences(path, value).length, 0, `${value} is canonical`);
}
const exception = { path, kind: 'content', lineSha256: digest(oldName), token: oldName, count: 1 };
assert.equal(unapprovedOccurrences(path, oldName, [exception]).length, 0);
assert.equal(unapprovedOccurrences('other.ts', oldName, [exception]).length, 1, 'exceptions cannot move to another file');
assert.equal(unapprovedOccurrences(path, `${oldName}\n${oldName}`, [exception]).length, 1, 'exceptions cannot multiply');
assert.equal(unapprovedOccurrences(path, `const name = '${oldName}';`, [exception]).length, 1, 'exceptions cannot move to a new context');
assert(duplicateGeneration.test(['Valo', 'Pay', '1', '1'].join(' ')));
assert(duplicateGeneration.test(['valo', 'pay', '1', '1'].join('-')));
assert.equal(digest('same\r\ntext'), digest('same\ntext'), 'checkout newline conversion does not rewrite history');
console.log('Product identity guard: canonical names and exact-context exception regressions passed.');
