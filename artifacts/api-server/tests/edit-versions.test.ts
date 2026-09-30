import assert from "node:assert/strict";
import { settingsRevision, assertRecordVersion, assertSettingsVersion, advanceRecordVersions, recordChanged, nextRecordVersion, mergeData } from "../src/lib/edit-versions.js";
import { seedMerchant } from "../src/lib/valopay-seed.js";

const state = seedMerchant("version-tests", false);
const record = state.records.find(record => record.kind === "customers")!;
assert.doesNotThrow(() => assertRecordVersion(record, record.updatedAt));
assert.doesNotThrow(() => assertRecordVersion(record, undefined));
assert.throws(() => assertRecordVersion(record, "not-a-time"), (error: any) => error.status === 400);
assert.throws(() => assertRecordVersion(record, "2000-01-01T00:00:00Z"), (error: any) => error.status === 409 && /record changed after you opened it, so your changes were not saved\. Reload the page/.test(error.message));
const revision = settingsRevision(state.settings);
assert.doesNotThrow(() => assertSettingsVersion(state.settings, revision));
assert.doesNotThrow(() => assertSettingsVersion(state.settings, undefined));
assert.equal(settingsRevision({ ...state.settings, nextCloseAt: "2028-01-01T07:00:00.000Z", lastCloseAt: "2027-01-01T07:00:00.000Z" }), revision, "scheduler activity does not invalidate an edit");
assert.throws(() => assertSettingsVersion({ ...state.settings, contactRoute: "new support route" }, revision), (error: any) => error.status === 409);

const changed = structuredClone(state), edited = changed.records.find(row => row.id === record.id)!;
edited.name = "Revised customer";
advanceRecordVersions(state, changed, record.updatedAt);
assert.equal(Date.parse(edited.updatedAt), Date.parse(record.updatedAt) + 1, "same-millisecond updates are distinct");
advanceRecordVersions(state, changed, record.updatedAt);
assert.equal(Date.parse(edited.updatedAt), Date.parse(record.updatedAt) + 1, "checking again does not advance twice");
for (const unchanged of changed.records.filter(row => row.id !== record.id)) assert.deepEqual(unchanged, state.records.find(row => row.id === unchanged.id));
const late = structuredClone(changed), lateRecord = late.records.find(row => row.id === record.id)!;
lateRecord.name = "A later change";
advanceRecordVersions(changed, late, "2000-01-01T00:00:00.000Z");
assert.equal(Date.parse(lateRecord.updatedAt), Date.parse(edited.updatedAt) + 1, "a waiting transaction cannot move a revision backward");
assert.throws(() => assertRecordVersion(lateRecord, edited.updatedAt), (error: any) => error.status === 409);

// Audit item 26: a record whose keys were only reordered holds the value PostgreSQL already stores. It is not a
// change, so it gets no new version, which for evidence would trip the immutability check.
const reordered = structuredClone(state), index = reordered.records.findIndex(row => row.id === record.id);
const shuffled = Object.fromEntries(Object.entries({ ...reordered.records[index]!, data: Object.fromEntries(Object.entries(record.data).reverse()) }).reverse()) as unknown as typeof record;
reordered.records[index] = shuffled;
assert.notEqual(JSON.stringify(shuffled), JSON.stringify(record), "the fixture really reorders the keys");
assert.equal(recordChanged(JSON.stringify(record), shuffled), false);
advanceRecordVersions(state, reordered, "2030-01-01T00:00:00.000Z");
assert.equal(shuffled.updatedAt, record.updatedAt, "a reordering of keys does not advance the version");
assert.equal(recordChanged(JSON.stringify(record), { ...shuffled, data: { ...shuffled.data, bankName: "Another bank" } }), true, "a changed value is a change");
assert.equal(recordChanged(JSON.stringify(record), { ...shuffled, data: { ...shuffled.data, extra: undefined } }), false, "an undefined field is not stored, so it is not a change");
assert.equal(recordChanged(JSON.stringify(record), { ...shuffled, data: { ...shuffled.data, extra: null } }), true, "a null field is stored");
assert.equal(nextRecordVersion(record, record.updatedAt, "2000-01-01T00:00:00.000Z"), new Date(Date.parse(record.updatedAt) + 1).toISOString());
// An edit's data is a merge patch: a field sent as null is removed, a field left out keeps its value.
assert.deepEqual(mergeData({ owner: "Finance", severity: "medium", notes: "Kept" }, { owner: null, severity: null, dueBy: "2026-09-30" }), { notes: "Kept", dueBy: "2026-09-30" });
assert.deepEqual(mergeData({ owner: "Finance" }, undefined), { owner: "Finance" });
assert.deepEqual(mergeData({ owner: "Finance" }, { owner: "" }), { owner: "" }, "an empty string is a value, not a removal");
console.log("Edit versions passed: stale records/settings rejected, scheduler cursor excluded, strictly increasing versions, key order is not a change, a null data field is removed.");
