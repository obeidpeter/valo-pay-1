import assert from "node:assert/strict";
import { MoneyArithmeticError, integerMoney, legacyDiscountMoney, multiplyDivideMoney, providerFeeKobo, sumMoney, usageFeeKobo, validMoneyBps, vatKobo } from "@workspace/valopay-schema";
import { billedLedger, chargedAtRate, issueInvoice, vatBpsFor } from "../src/domain/billing.js";
import { inNaira, positionFor } from "../src/domain/close.js";
import { feeScheduleFor } from "../src/domain/reconciliation.js";
import { consolidateCashPositions, ConnectedCashError, forecastCash, type CashAccount } from "../src/domain/connected-cash.js";
import { makeRecord, recordsOf } from "../src/domain/records.js";
import { seedMerchant } from "../src/lib/valopay-seed.js";
import type { ValopayRecord } from "../src/domain/types.js";

const MAX = Number.MAX_SAFE_INTEGER;
let checks = 0;
const outOfRange = (fn: () => unknown) => {
  assert.throws(fn, (e: unknown) => e instanceof MoneyArithmeticError && e.code === "MONEY_OUT_OF_RANGE");
  checks++;
};

// Audit reproduction: the former floating product changed the tax by one kobo.
assert.equal(Math.floor((9_007_199_254_736_012 * 750) / 10_000), 675_539_944_105_201);
assert.equal(vatKobo(9_007_199_254_736_012, 750), 675_539_944_105_200);
assert.equal(vatKobo(-101, 750), -8, "standalone VAT retains floor rounding");
assert.equal(multiplyDivideMoney(-101, 750, 10_000, "trunc"), -7, "credit-note VAT retains invoice truncation towards zero");
assert.equal(sumMoney([MAX, 2, -2]), MAX, "exact intermediate cancellation cannot silently lose a kobo");
assert.equal(sumMoney([-MAX, -2, 2]), -MAX);
assert.equal(sumMoney([]), 0);
assert.equal(legacyDiscountMoney(-199, 0.5), -99);
assert.equal(legacyDiscountMoney(MAX, 1e-7), Number(BigInt(MAX) / 10_000_000n));
assert.equal(chargedAtRate(MAX, 0.5), Number(BigInt(MAX) / 2n));
checks += 10;
outOfRange(() => sumMoney([MAX, 1]));
outOfRange(() => sumMoney([-MAX, -1]));
outOfRange(() => multiplyDivideMoney(MAX, 2, 1));
for (const bad of [NaN, Infinity, -Infinity, 1.5, MAX + 1, "100", null, undefined]) {
  assert.throws(() => integerMoney(bad as number), MoneyArithmeticError);
  assert.throws(() => sumMoney([1, bad as number]), MoneyArithmeticError);
  checks += 2;
}
for (const bad of [-1, 0.5, 10_001, MAX, NaN, Infinity, "750", null]) {
  assert.throws(() => validMoneyBps(bad as number), MoneyArithmeticError);
  assert.throws(() => providerFeeKobo(100, { bps: bad as number, capKobo: 100 }), MoneyArithmeticError);
  checks += 2;
}
for (const cap of [-1, 1.5, MAX + 1, NaN, "100"]) {
  assert.throws(() => providerFeeKobo(100, { bps: 30, capKobo: cap as number }), MoneyArithmeticError);
  checks++;
}
for (const rate of [-0.01, 1.01, NaN, Infinity]) {
  assert.throws(() => chargedAtRate(100, rate), MoneyArithmeticError);
  checks++;
}
assert.throws(() => usageFeeKobo(-1), MoneyArithmeticError);
assert.throws(() => multiplyDivideMoney(1, 2, 0), MoneyArithmeticError);
checks += 2;

// Independent deterministic integer oracle across the entire supported v1 range.
// No provider, database, random clock, or implementation helper participates in the oracle.
let random = 0x123456789abcdn;
const next = () => {
  random = (random * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) & ((1n << 64n) - 1n);
  return random;
};
for (let i = 0; i < 5_000; i++) {
  const amount = Number(next() % BigInt(MAX + 1));
  const bps = Number(next() % 10_001n);
  const cap = Number(next() % BigInt(MAX + 1));
  const oracle = (BigInt(amount) * BigInt(bps)) / 10_000n;
  assert.equal(vatKobo(amount, bps), Number(oracle));
  assert.equal(providerFeeKobo(amount, { bps, capKobo: cap }), Number(oracle < BigInt(cap) ? oracle : BigInt(cap)));
  assert.equal(usageFeeKobo(amount), Number((BigInt(amount) * 30n) / 10_000n < 15_000n ? (BigInt(amount) * 30n) / 10_000n : 15_000n));
  const discountBps = Number(next() % 10_001n);
  assert.equal(chargedAtRate(amount, discountBps / 10_000), Number((BigInt(amount) * BigInt(10_000 - discountBps)) / 10_000n));
  assert.equal(multiplyDivideMoney(-amount, bps, 10_000, "trunc"), Number(-oracle));
  assert.equal(sumMoney([amount, MAX, -MAX]), amount);
  checks += 6;
}

const now = "2028-03-01T10:00:00.000Z";
function billingFixture(licenceKobo: number) {
  const state = seedMerchant(`exact-billing-${licenceKobo}`);
  state.records = state.records.filter((record) => record.kind === "commercial");
  const terms = recordsOf(state, "commercial")[0]!;
  terms.data.signed = true;
  terms.data.designPartner = false; // This fixture tests full-price exact arithmetic, not discount authority.
  terms.data.effectiveDate = "2028-02-01";
  terms.data.licenceKobo = licenceKobo;
  state.settings.vatBps = 750;
  return state;
}
{
  const amount = 8_000_000_000_000_013;
  const state = billingFixture(amount);
  const invoice = issueInvoice(state, { now, actor: "Synthetic Finance", role: "Finance" }, { period: "2028-02" });
  const tax = (BigInt(amount) * 750n) / 10_000n;
  assert.equal(invoice.data.totals.vatKobo, Number(tax));
  assert.equal(invoice.data.totals.totalKobo, Number(BigInt(amount) + tax));
  assert.equal(invoice.amountKobo, invoice.data.totals.totalKobo);
  checks += 3;
}
{
  const state = billingFixture(MAX);
  const before = structuredClone(state);
  outOfRange(() => issueInvoice(state, { now, actor: "Synthetic Finance", role: "Finance" }, { period: "2028-02" }));
  assert.deepEqual(state, before, "an unsupported invoice is rejected before a record is created");
  state.settings.vatBps = -1;
  assert.throws(() => vatBpsFor(state), MoneyArithmeticError);
  state.settings.providerFeeSchedule = { [state.merchant.provider]: { bps: 50, capKobo: -1 } };
  assert.throws(() => feeScheduleFor(state, state.merchant.provider), MoneyArithmeticError);
  checks += 3;
}
{
  const state = billingFixture(0);
  makeRecord(state, "invoices", { reference: "OLD-1", status: "issued", data: {
    period: "2028-01", issuedAt: now, designPartnerDiscount: { rate: 0.5, kobo: 0 },
    adjustments: [{ paymentId: "payment-1", kobo: -199 }] as any,
  } });
  const entry = billedLedger(state).get("payment-1")!;
  assert.equal(entry.netFeeKobo, -199);
  assert.equal(entry.netChargedKobo, -100, "legacy credit keeps its own truncation and original discount precision");
  checks += 2;
}

const scope = { tenantId: "synthetic-tenant", legalEntityId: "synthetic-entity" };
const account = (id: string, balance: number): CashAccount => ({
  ...scope, id, name: id, currency: "NGN", source: "synthetic", sourceDefinition: "Booked synthetic balance",
  authorised: true, bookedMinor: balance, availableMinor: balance, pendingMinor: 0,
  balanceAsOf: now, fetchedAt: now, coverageComplete: true,
});
assert.equal(consolidateCashPositions(scope, [account("a", MAX), account("b", 2), account("c", -2)], [], now)[0]!.bookedMinor, MAX);
// A Cash Desk total beyond the range is the money refusal every calculation gives (a 422 naming its code), not a
// refusal of the input (400) or, on a read, a failure (500). An amount that is not whole money is still the input's.
outOfRange(() => consolidateCashPositions(scope, [account("a", MAX), account("b", 1)], [], now));
outOfRange(() => forecastCash({ ...scope, currency: "NGN" }, -MAX, [], { asOf: now, version: "synthetic-v1", bufferMinor: 1, openingQualified: true }));
assert.throws(() => consolidateCashPositions(scope, [account("a", 1.5)], [], now), (e: unknown) => e instanceof ConnectedCashError && e.code === "invalid_amount");
checks += 1;

// Rounding up, for a figure that must not be understated (the Credit Desk's observed monthly spending).
assert.deepEqual([7, 8, 9, -7, -8, 0].map((value) => multiplyDivideMoney(value, 1, 4, "ceil")), [2, 2, 3, -1, -2, 0]);
assert.equal(multiplyDivideMoney(MAX, 1, 2, "ceil"), Number((BigInt(MAX) + 1n) / 2n));
assert.equal(multiplyDivideMoney(MAX, 1, 1, "ceil"), MAX);
outOfRange(() => multiplyDivideMoney(MAX, 2, 1, "ceil"));
checks += 3;
for (let i = 0; i < 1_000; i++) {
  const amount = Number(next() % BigInt(MAX + 1)) * (i % 2 ? -1 : 1), divisor = Number(next() % 1_000n) + 1;
  const quotient = BigInt(amount) / BigInt(divisor), inexact = BigInt(amount) % BigInt(divisor) !== 0n;
  assert.equal(multiplyDivideMoney(amount, 1, divisor, "ceil"), Number(quotient + (inexact && amount > 0 ? 1n : 0n)));
  assert.equal(multiplyDivideMoney(amount, 1, divisor), Number(quotient - (inexact && amount < 0 ? 1n : 0n)));
  checks += 2;
}

{
  const state = billingFixture(0);
  const make = (id: string, amountKobo: number, currency = "NGN"): ValopayRecord => ({ id, amountKobo, merchantId: state.merchant.id, kind: "due-items", name: id, status: "scheduled", reference: id, customerId: "customer", createdAt: now, updatedAt: now, data: { currency } });
  const high = make("one", MAX), extra = make("two", 1);
  state.records = [high, extra];
  outOfRange(() => positionFor(state, "customer"));
  outOfRange(() => inNaira([high, extra], (record) => record.amountKobo));
  outOfRange(() => inNaira([make("usd1", MAX, "USD"), make("usd2", 1, "USD")], (record) => record.amountKobo));
  assert.equal(inNaira([high, make("usd", MAX, "USD")], (record) => record.amountKobo).kobo, MAX, "separate currencies never share an aggregate");
  checks++;
}
console.log(`Exact money: ${checks} checks passed (6,000 deterministic oracle cases; billing, close and connected cash integration).`);
