// Golden tests for the owner's decision on currencies in settlement batches: a
// batch holds one currency, its first counted line's (or the one Finance
// enters, naira unless given), and its totals are in that currency's smallest
// unit; a line in another currency is linked to it as evidence, never added to
// its totals, and reported to Finance until Finance resolves it; fees are
// checked only where a fee schedule exists for the batch's currency (naira), and
// a statement credit in another currency never matches the batch; batches an
// earlier build saved in several currencies are corrected once, ending where this
// build reading the same evidence from the start ends; and the close
// lists each batch in its own currency, summing naira only. Every request runs as
// the store runs it: on a copy, with the repository's final-state check, and
// rolled back when it is refused.
import assert from "node:assert/strict";
import { addAttempt, addObservation, ctxAt, liveFixture, outstandingOf, wat } from "./helpers.js";
import { reconcile } from "../src/domain/reconciliation.js";
import { executeAction } from "../src/domain/actions.js";
import { makeRecord, recordsOf } from "../src/domain/records.js";
import { validateRecord } from "../src/domain/validation.js";
import { closeReviewIssues } from "../src/domain/close-review.js";
import { pageReconciliation } from "../src/lib/console-read-models.js";
import type { DomainState, TypedRecord, ValopayRecord } from "../src/domain/types.js";

const { assertFinalState } = await import("../src/lib/valo-pay-1-store.js");
const finance = (now: string) => ctxAt(now, "Finance");
let checks = 0;
const failures: string[] = [];
const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks += 1; };
const equal = <T>(actual: T, expected: T, message: string) => { assert.deepEqual(actual, expected, message); checks += 1; };
/** One case's checks; a failure is reported with the others, so every case is seen at once. */
function section(name: string, run: () => void) {
  try { run(); } catch (error) { failures.push(`${name}: ${(error as Error).message.split("\n")[0]}`); }
}
/** A request as the store applies it: run on the lender, check the final state against the state before, and roll back when refused. */
function request<T>(state: DomainState, run: () => T): { ok: true; value: T } | { ok: false; message: string } {
  const before = structuredClone(state);
  try {
    const value = run();
    assertFinalState(structuredClone(before), state, state.merchant.id, new Date().toISOString());
    return { ok: true, value };
  } catch (error) {
    state.records = before.records; state.settings = before.settings; state.merchant = before.merchant;
    return { ok: false, message: (error as Error).message };
  }
}
function accepted<T>(outcome: ReturnType<typeof request<T>>, label: string): T {
  if (!outcome.ok) assert.fail(`${label} was refused: ${outcome.message}`);
  checks += 1;
  return outcome.value;
}
const reconciled = (state: DomainState, at: string) => accepted(request(state, () => reconcile(state, finance(wat(at)))), `the reconciliation at ${at} WAT`);
const closeAnswer = (state: DomainState, at: string) => accepted(request(state, () => executeAction(state, finance(wat(at)), { action: "daily_close" })), `the daily close at ${at} WAT`);
const batchOf = (state: DomainState, reference: string) => recordsOf(state, "settlement-batches").find((item) => item.reference === reference)!;
const lineOf = (state: DomainState, eventId: string) => recordsOf(state, "observations").find((item) => item.data.eventId === eventId)!;
const paymentOf = (state: DomainState, reference: string) => recordsOf(state, "payments").find((item) => item.reference === reference)!;
const exceptionsOn = (state: DomainState, id: string) => recordsOf(state, "exceptions").filter((item) => item.data.linkedRecordId === id && item.data.type === "settlement_variance");
const isOpen = (item: ValopayRecord) => ["open", "assigned", "in_progress"].includes(item.status);
const totals = (batch: ValopayRecord) => [batch.data.currency, batch.data.grossKobo, batch.data.feeKobo, batch.data.netKobo, batch.data.expectedFeeKobo, batch.data.feeVarianceKobo];
const GROSS = 2_500_000, FEE = 12_500, NET = GROSS - FEE; // NGN 25,000.00 at 0.5%
const USD_GROSS = 100_000, USD_FEE = 500, USD_NET = USD_GROSS - USD_FEE; // USD 1,000.00 in cents
const UNCHECKED = "Its fees were not checked, because there is no fee schedule for USD.";

/** A lender with a naira debit (PSK-N) collected for its instalment, and a card customer paying in dollars. */
function lender(label: string) {
  const fixture = liveFixture({ withFailure: false, merchantId: `batch-currency-${label}` });
  addAttempt(fixture.state, fixture.due, { status: "succeeded", occurredAt: wat("2027-07-01T06:00:00"), providerReference: "PSK-N" });
  return fixture;
}
const nairaLine = (state: DomainState, customerId: string, batch: string, eventId: string) =>
  addObservation(state, { reference: "PSK-N", amountKobo: NET, grossAmountKobo: GROSS, feeKobo: FEE, batchReference: batch, source: "settlement", customerId, eventId, occurredAt: wat("2027-07-01T07:00:00") });
const dollarLine = (state: DomainState, customerId: string, batch: string, eventId: string, reference = "PSK-U", fee = USD_FEE) =>
  addObservation(state, { reference, amountKobo: USD_GROSS - fee, grossAmountKobo: USD_GROSS, feeKobo: fee, batchReference: batch, source: "settlement", customerId, eventId, occurredAt: wat("2027-07-01T07:00:00"), currency: "USD" } as any);

// ---------- A naira line first, then a dollar line in the same batch ----------
section("a dollar line in a naira batch", () => {
  const { state, due } = lender("naira-first");
  nairaLine(state, due.customerId, "B-MIX-1", "n1");
  dollarLine(state, due.customerId, "B-MIX-1", "u1");
  reconciled(state, "2027-07-01T08:00:00");
  const batch = batchOf(state, "B-MIX-1"), n1 = lineOf(state, "n1"), u1 = lineOf(state, "u1"), dollars = paymentOf(state, "PSK-U");
  equal(totals(batch), ["NGN", GROSS, FEE, NET, FEE, 0], "the batch is in naira, its first line's currency, and counts the naira line alone");
  equal([batch.data.lineObservationIds, batch.data.linePaymentIds, batch.data.otherCurrencyLineIds], [[n1.id], [n1.data.paymentId], [u1.id]], "the dollar line is linked to it as evidence, not counted");
  equal([u1.status, u1.data.settlementBatchId, u1.data.otherCurrencyLine, u1.data.countedGrossKobo, u1.data.paymentId], ["resolved", batch.id, true, undefined, dollars.id], "the dollar line is marked, and resolved to its payment");
  equal([dollars.data.currency, dollars.amountKobo, dollars.data.settlementStatus], ["USD", USD_GROSS, "settled"], "its payment is reconciled as a payment: settled in dollars");
  const [report] = exceptionsOn(state, batch.id);
  equal([report?.data.condition, report?.amountKobo, report?.data.currency, report?.status], [`settlement_variance:${batch.id}:currency:${u1.id}`, USD_GROSS, "USD", "open"], "Finance is told with a settlement_variance of its own, in dollars");
  check(String(report?.data.notes).startsWith("Settlement line PSK-U (USD 1,000.00) is in USD, but settlement batch B-MIX-1 is in NGN. A batch holds one currency, so the line is not counted in its totals."), `the exception names the batch, the line and both currencies (${report?.data.notes})`);
  // The batch's statement credit reconciles it; the report stays open until Finance resolves it.
  addObservation(state, { reference: "STMT-MIX-1", amountKobo: NET, batchReference: "B-MIX-1", source: "statement", eventId: "st1", occurredAt: wat("2027-07-01T09:00:00") });
  closeAnswer(state, "2027-07-01T10:00:00");
  closeAnswer(state, "2027-07-02T08:00:00");
  equal([batch.status, report!.status, exceptionsOn(state, batch.id).length], ["reconciled", "open", 1], "the batch reconciles on its naira, and the report stays open");
  check(/the batch is now reconciled\..*It stays open for the settlement line in a different currency from the batch: resolve it once you have checked with the provider which batch pays it out\./.test(String(report!.data.notes)), `its notes say why it stays open (${report!.data.notes})`);
  accepted(request(state, () => executeAction(state, finance(wat("2027-07-02T09:00:00")), { action: "resolve_exception", recordId: report!.id, reason: "The provider paid the dollar collection out in its dollar batch.", data: { resolutionCode: "provider_corrected" } })), "Finance's resolution");
  closeAnswer(state, "2027-07-03T08:00:00");
  equal(exceptionsOn(state, batch.id).map((item) => item.status), ["resolved"], "Finance's resolution settles it: nothing is raised again");
  equal(totals(batch), ["NGN", GROSS, FEE, NET, FEE, 0], "and the batch still counts its naira alone");
  // The naira lines that are counted keep their fee check.
  equal([n1.data.countedGrossKobo, n1.data.assumedFeeKobo, n1.data.expectedFeeKobo], [GROSS, FEE, FEE], "the naira line records what it adds");
});

// ---------- A dollar line first, then a naira line, in separate passes ----------
section("a naira line in a dollar batch", () => {
  const { state, due } = lender("dollars-first");
  dollarLine(state, due.customerId, "B-MIX-2", "u2");
  reconciled(state, "2027-07-01T08:00:00");
  nairaLine(state, due.customerId, "B-MIX-2", "n2");
  reconciled(state, "2027-07-01T09:00:00");
  const batch = batchOf(state, "B-MIX-2"), n2 = lineOf(state, "n2"), naira = paymentOf(state, "PSK-N");
  equal(totals(batch), ["USD", USD_GROSS, USD_FEE, USD_NET, undefined, undefined], "the batch is in dollars, its first line's currency, with no expected fee and no fee variance");
  equal([batch.status, batch.data.explanation], ["pending", `It waits for its statement credit. ${UNCHECKED}`], "it says plainly that its fees were not checked");
  equal([batch.data.otherCurrencyLineIds, n2.data.otherCurrencyLine, n2.data.settlementBatchId], [[n2.id], true, batch.id], "the naira line is linked and marked, not counted");
  const [report] = exceptionsOn(state, batch.id);
  equal([report?.data.condition, report?.amountKobo, "currency" in (report?.data ?? {})], [`settlement_variance:${batch.id}:currency:${n2.id}`, GROSS, false], "the report of the naira line is in naira");
  check(String(report?.data.notes).startsWith("Settlement line PSK-N (₦25,000.00) is in NGN, but settlement batch B-MIX-2 is in USD"), `and names both currencies (${report?.data.notes})`);
  equal([naira.data.settlementStatus, naira.status, due.status, outstandingOf(due)], ["settled", "allocated", "paid", 0], "the naira collection is still reconciled and matched to its instalment");
  // Its line records no expected fee either.
  const u2 = lineOf(state, "u2");
  equal([u2.data.countedGrossKobo, u2.data.assumedFeeKobo, "expectedFeeKobo" in u2.data, "feeVarianceKobo" in u2.data], [USD_GROSS, USD_FEE, false, false], "the dollar line records its gross and fee, and no expected fee");
});

// ---------- A batch in dollars alone ----------
section("a dollar batch", () => {
  const { state, due } = lender("dollars-only");
  // Fees far from anything a naira schedule would give: never a fee variance, since there is no schedule for dollars.
  dollarLine(state, due.customerId, "B-USD", "u3", "PSK-U3", 50_000);
  dollarLine(state, due.customerId, "B-USD", "u4", "PSK-U4", 0);
  reconciled(state, "2027-07-01T08:00:00");
  const batch = batchOf(state, "B-USD");
  equal([totals(batch), batch.status, batch.data.feeSchedule, exceptionsOn(state, batch.id).length], [["USD", 2 * USD_GROSS, 50_000, 2 * USD_GROSS - 50_000, undefined, undefined], "pending", undefined, 0], "fees of any size are not a variance, and it waits for its statement credit");
  // A statement credit in dollars for its net reconciles it.
  addObservation(state, { reference: "STMT-USD", amountKobo: 2 * USD_GROSS - 50_000, batchReference: "B-USD", source: "statement", eventId: "st-usd", occurredAt: wat("2027-07-01T09:00:00"), currency: "USD" } as any);
  reconciled(state, "2027-07-01T10:00:00");
  equal([batch.status, batch.data.explanation, batch.data.statementNetKobo, exceptionsOn(state, batch.id).length], ["reconciled", `The statement credit equals the batch’s amount after fees. It was not allocated to a customer. ${UNCHECKED}`, 2 * USD_GROSS - 50_000, 0], "its statement check still runs, and its state says the fees were not checked");
  // A credit that does not match is a statement variance, never a fee variance.
  addObservation(state, { reference: "STMT-USD-2", amountKobo: 1_000, batchReference: "B-USD", source: "statement", eventId: "st-usd-2", occurredAt: wat("2027-07-01T11:00:00"), currency: "USD" } as any);
  reconciled(state, "2027-07-01T12:00:00");
  const [variance] = exceptionsOn(state, batch.id);
  equal([batch.status, batch.data.explanation, String(variance?.data.condition).split(":").slice(2, 3)], ["variance", `The batch’s 2 statement credits together do not equal its amount after fees. Compare the provider’s settlement report with the bank statement. ${UNCHECKED}`, ["statement"]], "a credit that differs is a statement variance");
});

// ---------- A statement credit in another currency than its batch ----------
section("a statement credit in another currency", () => {
  const { state, due } = lender("credit-currency");
  nairaLine(state, due.customerId, "B-CR", "n5");
  // The dollar credit states the naira batch's net in cents: it never matches, whatever its figure.
  const dollars = addObservation(state, { reference: "STMT-CR-USD", amountKobo: NET, batchReference: "B-CR", source: "statement", eventId: "st-cr-usd", occurredAt: wat("2027-07-01T09:00:00"), currency: "USD" } as any);
  reconciled(state, "2027-07-01T10:00:00");
  const batch = batchOf(state, "B-CR");
  const otherText = "A statement credit for this batch is in another currency (USD 24,875.00). A credit in another currency cannot match the batch’s amount after fees in NGN.";
  equal([batch.status, batch.data.explanation, batch.data.statementObservationId, batch.data.statementNetKobo, batch.data.statementOtherCurrencies], ["variance", otherText, undefined, undefined, { USD: { count: 1, amount: NET } }], "the batch is in variance, and lists the credit in its own currency");
  equal([dollars.status, dollars.data.resolvedTo, dollars.data.otherCurrencyCredit, recordsOf(state, "payments").some((item) => item.reference === "STMT-CR-USD")], ["resolved", `batch:${batch.id}`, true, false], "the credit is linked to the batch, marked, and never a customer's payment");
  const [variance] = exceptionsOn(state, batch.id);
  equal(variance?.data.condition, `settlement_variance:${batch.id}:statement:none:${NET}:${FEE}:USD=${NET}`, "its exception names the state it was raised for");
  // The naira credit arrives too: the dollar credit still names the batch, so it still does not match.
  addObservation(state, { reference: "STMT-CR", amountKobo: NET, batchReference: "B-CR", source: "statement", eventId: "st-cr", occurredAt: wat("2027-07-01T11:00:00") });
  reconciled(state, "2027-07-01T12:00:00");
  equal([batch.status, batch.data.statementNetKobo, batch.data.explanation], ["variance", NET, otherText], "a credit in another currency never lets the batch match");
  // A batch in dollars is not matched by a naira credit either.
  dollarLine(state, due.customerId, "B-CR-USD", "u5");
  addObservation(state, { reference: "STMT-CR-NGN", amountKobo: USD_NET, batchReference: "B-CR-USD", source: "statement", eventId: "st-cr-ngn", occurredAt: wat("2027-07-01T13:00:00") });
  reconciled(state, "2027-07-01T14:00:00");
  const dollarBatch = batchOf(state, "B-CR-USD");
  equal([dollarBatch.status, dollarBatch.data.statementOtherCurrencies], ["variance", { NGN: { count: 1, amount: USD_NET } }], "a naira credit does not match a dollar batch");
  check(String(dollarBatch.data.explanation).endsWith(UNCHECKED), `and the dollar batch still says its fees were not checked (${dollarBatch.data.explanation})`);
});

// ---------- A batch Finance enters by hand carries a currency ----------
section("a batch Finance enters by hand", () => {
  const { state, due } = lender("by-hand");
  const ctx = finance(wat("2027-07-01T06:00:00"));
  const enter = (reference: string, data: Record<string, unknown>) => {
    const input: any = { name: `Settlement batch ${reference}`, reference, status: "pending", data: { provider: "Sandbox Rail", batchReference: reference, grossKobo: USD_GROSS, feeKobo: USD_FEE, netKobo: USD_NET, ...data } };
    return request(state, () => { validateRecord(state, ctx, "settlement-batches", input); return makeRecord(state, "settlement-batches", input) as TypedRecord<"settlement-batches">; });
  };
  for (const [currency, why] of [["XYZ", "not a code"], ["XAU", "no minor unit"], [7, "not text"]] as const) {
    const refused = enter(`B-HAND-${String(currency)}`, { currency });
    check(!refused.ok && /Enter the batch currency as a three-letter code, such as NGN or USD\./.test(refused.message), `a currency that is ${why} is refused (${!refused.ok && refused.message})`);
  }
  const naira = accepted(enter("B-HAND-NGN", {}), "a batch entered with no currency");
  const dollars = accepted(enter("B-HAND-USD", { currency: " usd " }), "a batch entered in dollars");
  equal([naira.data.currency, dollars.data.currency], ["NGN", "USD"], "a hand-entered batch is in naira unless given, and names its currency in capitals");
  // Its statement credit in its own currency reconciles it; its fees are not checked in dollars.
  addObservation(state, { reference: "STMT-HAND-USD", amountKobo: USD_NET, batchReference: "B-HAND-USD", source: "statement", eventId: "st-hand-usd", occurredAt: wat("2027-07-01T07:00:00"), currency: "USD" } as any);
  reconciled(state, "2027-07-01T08:00:00");
  equal([dollars.status, dollars.data.explanation], ["reconciled", `The statement credit equals the batch’s amount after fees. It was not allocated to a customer. ${UNCHECKED}`], "a hand-entered dollar batch reconciles to its dollar credit");
  // Finance may correct the currency of a batch it entered, never one the provider's lines build.
  const edit = (batch: ValopayRecord, data: Record<string, unknown>) => request(state, () => validateRecord(state, finance(wat("2027-07-01T09:00:00")), "settlement-batches", { ...structuredClone(batch), data: { ...structuredClone(batch.data), ...data } }, true));
  accepted(edit(naira, { currency: "jpy" }), "correcting a hand-entered batch's currency");
  // What PATCH validates after its merge: a null removes the stored field, so the edit arrives without it.
  const unnamed = structuredClone(naira) as ValopayRecord; delete unnamed.data.currency;
  const kept = request(state, () => { validateRecord(state, finance(wat("2027-07-01T09:00:00")), "settlement-batches", unnamed, true); return unnamed.data.currency; });
  equal(kept.ok && kept.value, "NGN", "an edit that leaves the currency out keeps the stored one");
  nairaLine(state, due.customerId, "B-LINES", "n6");
  reconciled(state, "2027-07-01T10:00:00");
  const built = batchOf(state, "B-LINES");
  const changed = edit(built, { currency: "USD" });
  check(!changed.ok && /so it is in its first line’s currency\. You cannot change the currency here\./.test(changed.message), `the currency of a batch the lines build cannot be changed (${!changed.ok && changed.message})`);
  check(edit(built, { currency: "ngn" }).ok, "the same currency is accepted");
  for (const [key, value] of [["otherCurrencyLineIds", ["x"]], ["statementOtherCurrencies", { USD: { count: 1, amount: 1 } }]] as const) {
    const refused = edit(built, { [key]: value });
    check(!refused.ok && /Reconciliation sets this detail of the settlement batch/.test(refused.message), `${key} is reconciliation's to record (${!refused.ok && refused.message})`);
  }
  // The provider's lines take over a hand-entered batch in their currency; the typed totals keep theirs.
  const typed = accepted(enter("B-HAND-TYPED", { currency: "NGN", grossKobo: GROSS, feeKobo: FEE, netKobo: NET }), "a naira batch typed by hand");
  dollarLine(state, due.customerId, "B-HAND-TYPED", "u6", "PSK-U6");
  reconciled(state, "2027-07-01T11:00:00");
  equal([totals(typed), typed.data.enteredTotals], [["USD", USD_GROSS, USD_FEE, USD_NET, undefined, undefined], { grossKobo: GROSS, feeKobo: FEE, netKobo: NET, currency: "NGN" }], "its first line gives it its currency, and the typed totals keep theirs");
});

// ---------- Batches an earlier build saved in several currencies are corrected once ----------
section("a batch an earlier build saved in several currencies", () => {
  /**
   * What the earlier build left: it counted every line in the batch its reference named, whatever its currency, with
   * the naira schedule's fee on its gross, and recorded no currency on the batch or the lines it left out.
   */
  const earlier = (label: string, first: "naira" | "dollars") => {
    const { state, due } = lender(`earlier-${label}`);
    const lines = first === "naira" ? [nairaLine(state, due.customerId, "B-OLD", "old-n"), dollarLine(state, due.customerId, "", "old-u")] : [dollarLine(state, due.customerId, "B-OLD", "old-u"), nairaLine(state, due.customerId, "", "old-n")];
    reconciled(state, "2027-07-01T08:00:00");
    const batch = batchOf(state, "B-OLD"), added = lines[1]!;
    const gross = added.data.grossAmountKobo as number, fee = added.data.feeKobo as number, expected = Math.min(100_000, Math.floor(gross * 50 / 10_000));
    added.data.batchReference = "B-OLD";
    Object.assign(added.data, { settlementBatchId: batch.id, countedGrossKobo: gross, assumedFeeKobo: fee, expectedFeeKobo: expected });
    const firstExpected = first === "naira" ? FEE : Math.min(100_000, Math.floor(USD_GROSS * 50 / 10_000));
    Object.assign(batch.data, { lineObservationIds: [lines[0]!.id, added.id], linePaymentIds: [lines[0]!.data.paymentId, added.data.paymentId], grossKobo: Number(batch.data.grossKobo) + gross, feeKobo: Number(batch.data.feeKobo) + fee, expectedFeeKobo: firstExpected + expected, feeSchedule: { bps: 50, capKobo: 100_000 } });
    batch.data.netKobo = batch.data.grossKobo - batch.data.feeKobo; batch.data.feeVarianceKobo = batch.data.feeKobo - Number(batch.data.expectedFeeKobo);
    if (first === "dollars") Object.assign(lines[0]!.data, { expectedFeeKobo: firstExpected });
    delete batch.data.currency; delete batch.data.otherCurrencyLineIds;
    return { state, batch, first: lines[0]!, other: added };
  };
  const nairaFirst = earlier("naira-first", "naira");
  const corrected = reconciled(nairaFirst.state, "2027-07-02T08:00:00");
  equal(totals(nairaFirst.batch), ["NGN", GROSS, FEE, NET, FEE, 0], "the next reconciliation takes the dollar line out of the naira batch's totals");
  equal([nairaFirst.batch.data.lineObservationIds, nairaFirst.batch.data.linePaymentIds, nairaFirst.batch.data.otherCurrencyLineIds], [[nairaFirst.first.id], [nairaFirst.first.data.paymentId], [nairaFirst.other.id]], "and out of its lines, keeping it as evidence");
  equal([nairaFirst.other.data.otherCurrencyLine, nairaFirst.other.data.countedGrossKobo], [true, undefined], "the line is marked, and no longer records what it adds");
  const [report] = exceptionsOn(nairaFirst.state, nairaFirst.batch.id);
  equal([report?.data.condition, report?.data.currency, report?.status], [`settlement_variance:${nairaFirst.batch.id}:currency:${nairaFirst.other.id}`, "USD", "open"], "and it is reported as a line in another currency is");
  check(/It had been added to the batch’s totals by mistake and is now taken out of them\./.test(String(report?.data.notes)), `its report says what the earlier build did (${report?.data.notes})`);
  equal([corrected.data.settlementLinesSeparated, corrected.data.auditNote], [1, "Moved 1 settlement line in another currency out of its batch, because a batch holds one currency: PSK-U (USD) from settlement batch B-OLD (NGN)."], "the reconciliation counts it, and its audit entry names it");
  const after = JSON.stringify(recordsOf(nairaFirst.state, "settlement-batches").concat(recordsOf(nairaFirst.state, "observations") as any, recordsOf(nairaFirst.state, "exceptions") as any));
  const again = reconciled(nairaFirst.state, "2027-07-02T09:00:00");
  equal(["settlementLinesSeparated" in again.data, JSON.stringify(recordsOf(nairaFirst.state, "settlement-batches").concat(recordsOf(nairaFirst.state, "observations") as any, recordsOf(nairaFirst.state, "exceptions") as any))], [false, after], "once: a later reconciliation changes nothing");
  // A batch whose first line was in dollars is a dollar batch: the naira line comes out, and so does the naira fee check.
  const dollarsFirst = earlier("dollars-first", "dollars");
  reconciled(dollarsFirst.state, "2027-07-02T08:00:00");
  equal([totals(dollarsFirst.batch), dollarsFirst.batch.data.feeSchedule, "expectedFeeKobo" in dollarsFirst.first.data], [["USD", USD_GROSS, USD_FEE, USD_NET, undefined, undefined], undefined, false], "a batch whose first line was in dollars keeps the dollars, with no expected fee");
  equal([dollarsFirst.batch.status, dollarsFirst.batch.data.explanation], ["pending", `It waits for its statement credit. ${UNCHECKED}`], "and says its fees were not checked");
  equal(exceptionsOn(dollarsFirst.state, dollarsFirst.batch.id).map((item) => [item.data.condition, item.amountKobo, item.data.currency]), [[`settlement_variance:${dollarsFirst.batch.id}:currency:${dollarsFirst.other.id}`, GROSS, undefined]], "the naira line is reported in naira");
  // Totals Finance typed by hand are left as typed; the line still comes out of the batch and is reported.
  const byHand = earlier("typed", "naira");
  Object.assign(byHand.batch.data, { grossKobo: GROSS, feeKobo: FEE, netKobo: NET });
  reconciled(byHand.state, "2027-07-02T08:00:00");
  equal([byHand.batch.data.grossKobo, byHand.batch.data.lineObservationIds, byHand.batch.data.otherCurrencyLineIds], [GROSS, [byHand.first.id], [byHand.other.id]], "a batch whose totals Finance typed keeps them, and the dollar line still comes out");
  check(/The totals no longer show what its lines added, as Finance may have typed them by hand, so they were left as they are\. Check that they leave this line out\./.test(String(exceptionsOn(byHand.state, byHand.batch.id)[0]?.data.notes)), "and its report says so");
  // A batch an earlier build saved in dollars alone names its currency and drops the naira fee check.
  const { state, due } = lender("earlier-dollars-only");
  dollarLine(state, due.customerId, "B-OLD-USD", "old-usd");
  reconciled(state, "2027-07-01T08:00:00");
  const usd = batchOf(state, "B-OLD-USD"), line = lineOf(state, "old-usd");
  Object.assign(usd.data, { expectedFeeKobo: 500, feeVarianceKobo: 0, feeSchedule: { bps: 50, capKobo: 100_000 } }); delete usd.data.currency;
  Object.assign(line.data, { expectedFeeKobo: 500 });
  reconciled(state, "2027-07-02T08:00:00");
  equal([totals(usd), "expectedFeeKobo" in line.data, usd.data.explanation], [["USD", USD_GROSS, USD_FEE, USD_NET, undefined, undefined], false, `It waits for its statement credit. ${UNCHECKED}`], "an earlier dollar batch names its currency and loses the naira fee check");
  // An earlier naira batch is left exactly as it is: one that names no currency is in naira.
  const { state: plain, due: plainDue } = lender("earlier-naira");
  nairaLine(plain, plainDue.customerId, "B-OLD-NGN", "old-ngn");
  reconciled(plain, "2027-07-01T08:00:00");
  const ngn = batchOf(plain, "B-OLD-NGN");
  delete ngn.data.currency;
  const stamp = ngn.updatedAt;
  reconciled(plain, "2027-07-02T08:00:00");
  equal([ngn.data.currency, ngn.updatedAt], [undefined, stamp], "an earlier naira batch is not rewritten");
});

// ---------- A collection an earlier build counted in a batch of another currency, and listed again elsewhere ----------
section("an earlier mixed batch whose collection the provider lists in other batches too", () => {
  /**
   * The provider misfiles a dollar collection's line in a naira batch (B-MIX), then lists the collection again in a
   * naira batch that counts naira lines (B-NAIRA) and in two dollar batches (B-USD, which its dollar statement credit
   * pays, and B-USD-2). With `earlier`, the dollar evidence is read as the earlier build read every line, in the batch
   * its reference named first whatever its currency, and written back in dollars with no currency on any batch, as that
   * build left it: PSK-U counted in B-MIX, and each later line of it reported as counted there.
   */
  const run = (label: string, earlier: boolean) => {
    const { state, due } = lender(label);
    const dollars = (item: TypedRecord<"observations">) => { if (earlier) item.data.currency = "NGN"; return item; };
    nairaLine(state, due.customerId, "B-MIX", "n1"); dollars(dollarLine(state, due.customerId, "B-MIX", "u-mix"));
    reconciled(state, "2027-07-01T08:00:00");
    addObservation(state, { reference: "PSK-N2", amountKobo: NET, grossAmountKobo: GROSS, feeKobo: FEE, batchReference: "B-NAIRA", source: "settlement", eventId: "n2", occurredAt: wat("2027-07-01T07:00:00") });
    dollars(dollarLine(state, due.customerId, "B-NAIRA", "u-ngn")); dollars(dollarLine(state, due.customerId, "B-USD", "u-usd")); dollars(dollarLine(state, due.customerId, "B-USD-2", "u-usd2"));
    dollars(addObservation(state, { reference: "STMT-USD", amountKobo: USD_NET, batchReference: "B-USD", source: "statement", eventId: "st-usd", occurredAt: wat("2027-07-01T10:00:00"), currency: "USD" } as any));
    reconciled(state, "2027-07-01T11:00:00");
    if (earlier) {
      for (const item of recordsOf(state, "observations")) if (item.reference === "PSK-U" || item.reference === "STMT-USD") item.data.currency = "USD";
      paymentOf(state, "PSK-U").data.currency = "USD";
      for (const batch of recordsOf(state, "settlement-batches")) delete batch.data.currency;
      for (const report of recordsOf(state, "exceptions")) if (String(report.data.notes).includes("PSK-U")) { report.data.notes = String(report.data.notes).replaceAll("₦1,000.00", "USD 1,000.00"); report.data.currency = "USD"; }
    }
    return state;
  };
  const state = run("earlier-moved", true), fresh = run("fresh-moved", false);
  const counting = (at: DomainState) => recordsOf(at, "settlement-batches").filter((batch) => (batch.data.linePaymentIds as string[]).includes(paymentOf(at, "PSK-U").id)).map((batch) => batch.reference);
  const mix = batchOf(state, "B-MIX");
  equal([counting(state), lineOf(state, "u-usd").data.countedInBatchId, lineOf(state, "u-usd2").data.countedInBatchId, lineOf(state, "u-ngn").data.countedInBatchId], [["B-MIX"], mix.id, mix.id, mix.id], "the earlier build counted the collection in the naira batch, and reported its other lines as counted there");
  const answer = reconciled(state, "2027-07-02T08:00:00");
  const usd = batchOf(state, "B-USD"), usd2 = batchOf(state, "B-USD-2"), naira = batchOf(state, "B-NAIRA");
  equal(counting(state), ["B-USD"], "once the dollar line leaves the naira batch, the dollar batch the provider also lists it in counts the collection");
  equal([totals(usd), usd.status, usd.data.lineObservationIds], [["USD", USD_GROSS, USD_FEE, USD_NET, undefined, undefined], "reconciled", [lineOf(state, "u-usd").id]], "in dollars, so its dollar statement credit matches it");
  equal(["duplicateSettlementLine" in lineOf(state, "u-usd").data, "countedInBatchId" in lineOf(state, "u-usd").data], [false, false], "its line there is no longer marked as counted elsewhere");
  equal([usd2.data.currency, lineOf(state, "u-usd2").data.countedInBatchId, lineOf(state, "u-usd2").data.duplicateSettlementLine], ["USD", usd.id, true], "a later dollar batch that counts no line takes its first line's currency, and its line is counted twice with the batch that now counts the collection");
  equal([naira.data.otherCurrencyLineIds, lineOf(state, "u-ngn").data.otherCurrencyLine, "countedInBatchId" in lineOf(state, "u-ngn").data, "duplicateSettlementLine" in lineOf(state, "u-ngn").data], [[lineOf(state, "u-ngn").id], true, false, false], "a line in a naira batch of naira lines is a line in another currency there");
  const reports = (batch: ValopayRecord) => exceptionsOn(state, batch.id).filter(isOpen).map((item) => String(item.data.notes)).join("\n");
  const moved = "settlement batch B-MIX no longer counts its collection, as its line there is in USD and the batch in NGN, so settlement line PSK-U";
  check(reports(usd).includes(`: ${moved} is now counted in this batch.`), `the dollar batch's open report says the line is now counted there (${reports(usd)})`);
  check(reports(usd2).includes(`: ${moved} is still not counted in this batch, as settlement batch B-USD now counts its collection.`), `the later dollar batch's report names the batch that now counts it (${reports(usd2)})`);
  check(reports(naira).includes(`: ${moved} is reported as a line in a different currency from this batch.`) && /is in USD, but settlement batch B-NAIRA is in NGN/.test(reports(naira)), `the naira batch's report says the line is now one in another currency (${reports(naira)})`);
  check(reports(mix).includes(": its collection is now counted in settlement batch B-USD, where the provider lists it too."), `the report of the line taken out says where its collection is now counted (${reports(mix)})`);
  check(String(answer.data.auditNote).includes("PSK-U (USD) from settlement batch B-MIX (NGN), now counted in settlement batch B-USD, where the provider lists it too."), `the audit entry names the batch that now counts it (${answer.data.auditNote})`);
  // This build reading the same evidence from the start ends in the same place.
  const shape = (at: DomainState) => ({
    batches: recordsOf(at, "settlement-batches").map((batch) => [batch.reference, batch.status, ...totals(batch), (batch.data.lineObservationIds as string[]).length, ((batch.data.otherCurrencyLineIds ?? []) as string[]).length]),
    lines: recordsOf(at, "observations").filter((item) => item.data.source === "settlement").map((item) => [item.data.eventId, item.data.duplicateSettlementLine ?? false, item.data.otherCurrencyLine ?? false, recordsOf(at, "settlement-batches").find((batch) => batch.id === item.data.countedInBatchId)?.reference ?? null]),
  });
  reconciled(fresh, "2027-07-02T08:00:00");
  equal(shape(state), shape(fresh), "the correction ends where this build reading the evidence from the start ends");
  const after = JSON.stringify(recordsOf(state, "settlement-batches").concat(recordsOf(state, "observations") as any, recordsOf(state, "exceptions") as any));
  const again = reconciled(state, "2027-07-02T09:00:00");
  equal(["settlementLinesSeparated" in again.data, JSON.stringify(recordsOf(state, "settlement-batches").concat(recordsOf(state, "observations") as any, recordsOf(state, "exceptions") as any))], [false, after], "once: a later reconciliation changes nothing");
});

// ---------- The close and its review show each batch in its own currency ----------
section("the close's settlement differences", () => {
  const { state, due } = lender("close");
  // A naira batch whose fee differs from the schedule, and a dollar batch whose credit differs.
  addObservation(state, { reference: "PSK-N", amountKobo: GROSS - 50_000, grossAmountKobo: GROSS, feeKobo: 50_000, batchReference: "B-FEE", source: "settlement", customerId: due.customerId, eventId: "c1", occurredAt: wat("2027-07-01T07:00:00") });
  dollarLine(state, due.customerId, "B-DOLLAR", "c2");
  addObservation(state, { reference: "STMT-DOLLAR", amountKobo: 1_000, batchReference: "B-DOLLAR", source: "statement", eventId: "c3", occurredAt: wat("2027-07-01T08:00:00"), currency: "USD" } as any);
  const close = closeAnswer(state, "2027-07-01T10:00:00").record!;
  const variances = close.data.report.variances;
  const fee = batchOf(state, "B-FEE"), dollar = batchOf(state, "B-DOLLAR");
  equal([variances.count, variances.feeVarianceKobo, variances.otherCurrencies], [2, 50_000 - FEE, { USD: { count: 1, amount: 0 } }], "the fee variances are summed in naira only, and the dollar batch is listed apart");
  equal(variances.batches.map((item: any) => [item.reference, item.currency, item.netKobo, item.statementNetKobo]), [["B-FEE", "NGN", GROSS - 50_000, null], ["B-DOLLAR", "USD", USD_NET, 1_000]], "each batch in its own currency");
  const issues = closeReviewIssues(close);
  equal([issues.find((item) => item.id === `variance:${fee.id}`)?.detail, issues.find((item) => item.id === `variance:${dollar.id}`)?.detail], ["Fee difference: ₦375.00. Compare the provider and statement totals.", "Fees not checked: there is no fee schedule for USD. Amount after fees: USD 995.00. Compare the provider and statement totals."], "the close review writes each batch in its own currency");
  // What the console's reconciliation page reads carries the currency.
  const page = pageReconciliation(state, "batches", {} as any, wat("2027-07-01T11:00:00")) as { items: ValopayRecord[] };
  equal(page.items.map((item) => [item.reference, item.data.currency]).sort(), [["B-DOLLAR", "USD"], ["B-FEE", "NGN"]], "the reconciliation page's batches name their currency");
});

if (failures.length) {
  console.error(failures.join("\n"));
  assert.fail(`${failures.length} settlement currency section(s) failed`);
}
console.log(`Settlement currency golden tests passed (${checks} checks): a batch in its first line's currency with lines in another linked and reported, in either order, a dollar batch whose fees are not checked, a statement credit in another currency, a hand-entered batch's currency, batches an earlier build saved in several currencies corrected once, a collection such a batch counted read again in the other batches that list it, and the close's differences by currency.`);
