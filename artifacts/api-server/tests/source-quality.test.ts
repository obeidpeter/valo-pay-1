import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { seedMerchant } from "../src/lib/valo-pay-1-seed";
import { saveSourceProfile, batchSourceQuality, assertSourceBatchReady, sourceDelivery } from "../src/domain/source-quality";
import { saveImportBatch, commitImportBatch } from "../src/domain/pilot-workflow";
import { advanceRecordVersions } from "../src/lib/edit-versions";
import { makeRecord } from "../src/domain/records";
import { receivePaystackEvent, replayProviderEvent, runPaystackFixture, providerEventView, assertProviderEventChange } from "../src/providers/paystack-inbox";
import { parsePaystackTestWebhook } from "../src/providers/paystack";
import type { SourceProfileInput } from "@workspace/valo-pay-1-schema";

const ctx = { actor: "Clerk:source_operator", role: "Admin", now: "2026-09-22T08:00:00.000Z" };
const fresh = (id = "source-quality-test") => { const state = seedMerchant(id, true); state.records = []; return state; };
const profileInput: SourceProfileInput = { name: "Daily customer feed", source: "test-lms", kind: "customers", mapping: {}, identityColumn: "source_row_id", amountUnit: "naira", firstExpectedAt: "2026-09-22T09:00:00.000Z", cadenceHours: 24, graceMinutes: 60, expectedRows: 1, expectedAmountKobo: 0, status: "active", syntheticOnly: true };
const state = fresh();
let before = structuredClone(state);
const profile = saveSourceProfile(state, ctx, profileInput);
advanceRecordVersions(before, state, ctx.now);
assert.equal(sourceDelivery(state, profile, "2026-09-22T09:59:00.000Z").missedDeliveries, 0);
assert.equal(sourceDelivery(state, profile, "2026-09-22T10:01:00.000Z").missedDeliveries, 1);
assert.equal(sourceDelivery(state, profile, "2026-09-24T10:01:00.000Z").missedDeliveries, 3);
assert.throws(() => saveSourceProfile(state, ctx, { ...profileInput, expectedUpdatedAt: "2020-01-01T00:00:00.000Z" }, profile.id), /changed|Refresh|newer/i);
assert.throws(() => saveSourceProfile(state, { ...ctx, role: "Read-only" }, profileInput), /role/);
assert.throws(() => saveSourceProfile(fresh("foreign"), ctx, { ...profileInput, expectedUpdatedAt: profile.updatedAt }, profile.id), /not found/);
before = structuredClone(state);
let batch = saveImportBatch(state, ctx, { name: "Customers 001", source: "test-lms", sourceBatchId: "customers-001", kind: "customers", csv: "source_row_id,name,reference,consentProvenance\nc-1,Sample customer,TEST-C-1,Synthetic consent", mapping: {}, identityColumn: "source_row_id", amountUnit: "naira", syntheticOnly: true });
advanceRecordVersions(before, state, ctx.now);
assert.equal(batchSourceQuality(state, batch).status, "checked");
assert.equal(assertSourceBatchReady(state, batch).profileId, profile.id);
profile.data.expectedRows = 2;
assert.throws(() => assertSourceBatchReady(state, batch), /Expected 2 rows; this batch has 1 row/);
profile.data.expectedRows = 1;
const committed = commitImportBatch(state, ctx, batch.id, batch.updatedAt);
assert.equal(committed.status, "committed");
batch = state.records.find(r=>r.id === batch.id)!;
assert.equal(batchSourceQuality(state, batch).importedRows, 1);
const repeated = saveImportBatch(state, ctx, { name: "Customers 002", source: "test-lms", sourceBatchId: "customers-002", kind: "customers", csv: batch.data.csv, mapping: {}, identityColumn: "source_row_id", amountUnit: "naira", syntheticOnly: true });
assert.equal(batchSourceQuality(state, repeated).duplicateRows, 1);
assert.equal(batchSourceQuality(state, repeated).importedRows, 0);
// Source rows the route did not open are a server fault, never an "unavailable" quality a person would act on.
for (const field of ["csv", "check"]) {
  const unopened = structuredClone(repeated); unopened.data[field] = { protectedPayload: 1 };
  assert.throws(() => batchSourceQuality(state, unopened), (e: any) => e.status === 500 && /not opened/.test(e.message), `a sealed ${field} is refused`);
}

// A later delivery does not erase a missed first day; each cadence window has its own receipt.
makeRecord(state, "import-batches", { status: "committed", data: { source: "test-lms", kind: "customers", committedAt: "2026-09-23T09:15:00.000Z" } });
assert.equal(sourceDelivery(state, profile, "2026-09-24T10:01:00.000Z").missedDeliveries, 1);
const noFirst = fresh(); noFirst.records = state.records.filter(r=>r.kind !== "import-batches" || r.id !== batch.id);
assert.equal(sourceDelivery(noFirst, profile, "2026-09-24T10:01:00.000Z").missedDeliveries, 2);

// Totals use integer arithmetic across every row, beyond the preview's first ten.
const amountBatch = makeRecord(state, "import-batches", { data: { kind: "observations", source: "amounts", csv: "row,amount\n1,0.10\n2,0.20", amountUnit: "naira", mapping: {}, check: {} } });
assert.equal(batchSourceQuality(state, amountBatch).sourceAmountKobo, 30);
amountBatch.data.csv = "row,amount\n1,9007199254740991\n2,1"; amountBatch.data.amountUnit = "kobo";
assert.equal(batchSourceQuality(state, amountBatch).status, "unavailable");
assert.equal(batchSourceQuality(state, amountBatch).sourceAmountKobo, null);
assert.throws(() => assertSourceBatchReady(state, amountBatch), /larger than Valo Pay 1 supports/);
amountBatch.data.csv = "row,amount\n1,not-money";
assert.equal(batchSourceQuality(state, amountBatch).status, "unavailable");
// As in the import, a blank amount counts for nothing on a customer row, and stays an error where the kind needs an amount.
const customerAmounts = makeRecord(state, "import-batches", { data: { kind: "customers", source: "amounts", csv: "row,amount\n1,\n2,0.20", amountUnit: "naira", mapping: {}, check: {} } });
assert.equal(batchSourceQuality(state, customerAmounts).sourceAmountKobo, 20);
amountBatch.data.csv = "row,amount\n1,";
assert.equal(batchSourceQuality(state, amountBatch).status, "unavailable");
// Integration fix: as in the import, only a kind with a currency field (payment evidence) reads a row's amount in the
// row's currency, so a currency column in an instalment file leaves its amounts in naira.
const dueCurrency = makeRecord(state, "import-batches", { data: { kind: "due-items", source: "amounts", csv: 'row,amount,currency\n1,"1,000,000",JPY\n2,1.5,KWD', amountUnit: "naira", mapping: {}, check: {} } });
assert.deepEqual([batchSourceQuality(state, dueCurrency).sourceAmountKobo, batchSourceQuality(state, dueCurrency).sourceOtherCurrencies], [100_000_150, undefined]);
// Integration fix: amounts in different currencies are never added together. The source total sums the naira rows
// (a row that names no currency is naira) and lists each other currency's rows and money beside it, in its minor unit.
const mixedSource = makeRecord(state, "import-batches", { data: { kind: "observations", source: "amounts", csv: 'row,amount,currency\n1,"1,000",JPY\n2,10.00,usd\n3,10.00,NGN\n4,5.00,\n5,2.50,USD', amountUnit: "naira", mapping: {}, check: {} } });
assert.deepEqual([batchSourceQuality(state, mixedSource).sourceAmountKobo, batchSourceQuality(state, mixedSource).sourceOtherCurrencies], [1500, { JPY: { count: 1, amount: 1000 }, USD: { count: 2, amount: 1250 } }]);
mixedSource.data.amountUnit = "kobo"; mixedSource.data.csv = "row,amount,currency\n1,1000,JPY\n2,1500,";
assert.deepEqual([batchSourceQuality(state, mixedSource).sourceAmountKobo, batchSourceQuality(state, mixedSource).sourceOtherCurrencies], [1500, { JPY: { count: 1, amount: 1000 } }]);
assert.equal("sourceOtherCurrencies" in batchSourceQuality(state, amountBatch), false, "a batch in naira alone lists no other currency");
{
  // The imported total does the same, and a profile's expected amount, which is in naira, is compared with the naira
  // rows only: a batch with rows in another currency says so, and needs review before it is committed.
  const evidence = fresh("source-quality-currencies");
  const csv = 'source_row_id,name,reference,amount,source,currency\no-1,Yen payment,OBS-JPY,"1,000",card,JPY\no-2,Dollar payment,OBS-USD,10.00,card,usd\no-3,Naira payment,OBS-NGN,10.00,card,';
  const input = { name: "Card payments 001", source: "card-feed", sourceBatchId: "cards-001", kind: "observations" as const, csv, mapping: {}, identityColumn: "source_row_id", amountUnit: "naira" as const, syntheticOnly: true as const };
  const cardProfile = saveSourceProfile(evidence, ctx, { ...profileInput, name: "Card feed", source: "card-feed", kind: "observations", expectedRows: 3, expectedAmountKobo: 1000 });
  const held = saveImportBatch(evidence, ctx, input);
  assert.equal(held.data.sourceQuality.status, "needs_review");
  assert.deepEqual(held.data.sourceQuality.issues, ["The source profile’s expected total is in naira, so it is compared with the naira rows only. This batch also has JPY 1,000 and USD 10.00 in other currencies, which it does not cover."]);
  assert.throws(() => assertSourceBatchReady(evidence, held), /in other currencies, which it does not cover/);
  cardProfile.data.expectedAmountKobo = null;
  const batch = saveImportBatch(evidence, ctx, { ...input, expectedUpdatedAt: held.updatedAt }, held.id);
  assert.equal(batch.data.sourceQuality.status, "checked", JSON.stringify(batch.data.sourceQuality.issues));
  const saved = commitImportBatch(evidence, ctx, batch.id, batch.updatedAt).data.sourceQuality;
  assert.deepEqual([saved.sourceAmountKobo, saved.sourceOtherCurrencies, saved.importedRows, saved.importedAmountKobo, saved.importedOtherCurrencies], [1000, { JPY: { count: 1, amount: 1000 }, USD: { count: 1, amount: 1000 } }, 3, 1000, { JPY: { count: 1, amount: 1000 }, USD: { count: 1, amount: 1000 } }]);
}

const inbox = fresh("inbox-test");
const first = runPaystackFixture(inbox, ctx, "payment");
assert.equal(first.event.status, "awaiting_verification");
const originalReceipt = structuredClone(first.event);
const duplicated = runPaystackFixture(inbox, ctx, "duplicate");
assert.doesNotThrow(() => assertProviderEventChange(originalReceipt, duplicated.event));
assert.equal(duplicated.event.id, first.event.id, "A lost acknowledgement followed by redelivery cannot create another receipt or financial record.");
assert.equal(inbox.records.filter(r=>r.kind === "provider-events").length, 1);
assert.equal(duplicated.duplicate, true);
assert.equal(runPaystackFixture(inbox, ctx, "amount_mismatch").event.status, "quarantined");
assert.equal(runPaystackFixture(inbox, ctx, "out_of_order").event.status, "ignored_stale");
assert.equal(runPaystackFixture(inbox, ctx, "tampered").accepted, false);
assert.equal(inbox.records.some(r=>["payments", "allocations", "observations", "mandates"].includes(r.kind)), false);
assert.throws(()=>replayProviderEvent(inbox,ctx,inbox.records.find(r=>r.status === "quarantined")!.id,ctx.now,"Review conflict"),/cannot be rechecked/);
assert.throws(()=>replayProviderEvent(fresh("other"),ctx,first.event.id,first.event.updatedAt,"Wrong lender"),/not found/);
assert.throws(()=>replayProviderEvent(inbox,ctx,first.event.id,"2000-01-01T00:00:00.000Z","Stale replay"),/changed|Refresh|newer/i);
assert.equal(replayProviderEvent(inbox,ctx,first.event.id,first.event.updatedAt,"Recheck saved evidence").data.replayHistory.length,1);
assert.doesNotThrow(() => assertProviderEventChange(originalReceipt, first.event));
for (const tamper of [
  (record: typeof first.event) => { record.data.mode = "test"; },
  (record: typeof first.event) => { record.data.event.payment.amountKobo++; },
  (record: typeof first.event) => { record.data.payloadDigest = "rewritten"; },
  (record: typeof first.event) => { record.data.connectionId = "another-lender"; },
  (record: typeof first.event) => { record.data.deliveryCount = 0; },
  (record: typeof first.event) => { record.data.replayHistory[0].reason = "rewritten history"; },
]) { const altered = structuredClone(first.event); tamper(altered); assert.throws(() => assertProviderEventChange(first.event, altered), /Saved provider messages cannot be changed/); }
const quarantined = inbox.records.find(record => record.status === "quarantined")!;
const cleared = structuredClone(quarantined); cleared.status = "awaiting_verification"; cleared.data.replayHistory.push({ result: "awaiting_verification" });
assert.throws(() => assertProviderEventChange(quarantined, cleared), /Saved provider messages cannot be changed/);
assert.equal("connectionId" in providerEventView(first.event),false);
assert.equal("event" in providerEventView(first.event),false);

// The same transaction ID belongs independently to each provisioned connection; no cross-connection matching.
const key = ["sk", "test", "OFFLINE", "0".repeat(20)].join("_");
const body = Buffer.from(JSON.stringify({event:"charge.success",data:{domain:"test",id:"123",reference:"SOURCE-REF-1",amount:100,currency:"NGN",status:"success",channel:"direct_debit"}}));
const signature = createHmac("sha512",key).update(body).digest("hex");
const event = parsePaystackTestWebhook(body,signature,key);
const one = receivePaystackEvent(inbox,ctx,event,{connectionId:"a".repeat(64),mode:"test"});
const two = receivePaystackEvent(inbox,ctx,event,{connectionId:"b".repeat(64),mode:"test"});
assert.notEqual(one.event.id,two.event.id);
assert.throws(()=>parsePaystackTestWebhook(Buffer.concat([body,Buffer.from(" ")]),signature,key),/signature/);
const wrongExpected = fresh();
makeRecord(wrongExpected,"attempts",{reference:"SOURCE-REF-1",amountKobo:101});
assert.equal(receivePaystackEvent(wrongExpected,ctx,event,{connectionId:"c".repeat(64),mode:"test"}).event.status,"quarantined");
console.log("Source quality and Paystack inbox checks passed: totals, schedules, stale changes, duplicates, conflicts, signatures, replay and isolation.");
