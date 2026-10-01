// Offline tests for the API shell helpers: list paging with an updatedSince
// watermark, and the sandbox creation limiter.
import assert from "node:assert/strict";
import { allocatableOnly, allocationChoices, pageRecords, LIST_PAGE_CEILING } from "../src/lib/valopay-list.js";
import { createCreationLimiter } from "../src/lib/creation-limit.js";
import type { ValopayRecord } from "../src/domain/types.js";

let checks = 0;
const record = (i: number, status = "open"): ValopayRecord => ({ id: `r${String(i).padStart(3, "0")}`, merchantId: "m", kind: "exceptions", name: `record ${i}`, status, reference: `REF-${i}`, amountKobo: i, customerId: "", createdAt: new Date(Date.UTC(2027, 0, 1, 0, i)).toISOString(), updatedAt: new Date(Date.UTC(2027, 0, 2, 0, i)).toISOString(), data: { note: i % 2 ? "odd" : "even" } });
const records = Array.from({ length: 1200 }, (_, i) => record(i, i % 3 ? "open" : "resolved"));

{
  const all = pageRecords(records, {});
  assert.equal(all.items.length, 1200, "no limit returns the whole set, as the console expects");
  assert.equal(all.total, 1200); assert.equal(all.nextOffset, undefined);
  assert.equal(all.items[0]!.id, "r1199", "newest first");
  const first = pageRecords(records, { limit: 100 });
  assert.equal(first.items.length, 100); assert.equal(first.total, 1200); assert.equal(first.nextOffset, 100);
  const second = pageRecords(records, { limit: 100, offset: 100 });
  assert.equal(second.items[0]!.id, "r1099"); assert.equal(second.nextOffset, 200);
  const last = pageRecords(records, { limit: 100, offset: 1150 });
  assert.equal(last.items.length, 50); assert.equal(last.nextOffset, undefined, "no next page after the last row");
  assert.equal(pageRecords(records, { limit: 5000 }).items.length, LIST_PAGE_CEILING, "a page never exceeds the ceiling");
  assert.equal(pageRecords(records, { limit: -3, offset: -1 }).items.length, 1200, "invalid paging values fall back to the defaults");
  const filtered = pageRecords(records, { status: "resolved", search: "odd", limit: 10 });
  assert.equal(filtered.total, records.filter((r) => r.status === "resolved" && r.data.note === "odd").length, "total counts the filtered set");
  assert.equal(filtered.items.length, 10);
  const since = pageRecords(records, { updatedSince: new Date(Date.UTC(2027, 0, 2, 0, 1190)).toISOString() });
  assert.equal(since.total, 10, "updatedSince is inclusive of the watermark");
  assert.throws(() => pageRecords(records, { updatedSince: "yesterday" }), /RFC 3339 date and time/);
  checks += 16;
}

{
  // The audit log shows an entry by its action's name in words (withAuditName); a search finds it by that name and
  // still by the stored action, in any case. Only audit entries are named this way.
  const entry = (id: string, action: string, summary: string): ValopayRecord => ({ id, merchantId: "m", kind: "audit", name: action, status: "recorded", reference: "", amountKobo: 0, customerId: "", createdAt: "2027-01-01T00:00:00.000Z", updatedAt: "2027-01-01T00:00:00.000Z", data: { action, summary } });
  const audit = [entry("a1", "post.records.customers", "Added Ada Okonkwo."), entry("a2", "set_role", "Changed the demo role to Finance.")];
  const found = (search: string, list = audit) => pageRecords(list, { search }).items.map((item) => item.id);
  assert.deepEqual(found("Customer added"), ["a1"], "the name in words finds the entry");
  assert.deepEqual(found("post.records.customers"), ["a1"], "so does the stored action");
  assert.deepEqual(found("demo role changed"), ["a2"], "in any case");
  assert.deepEqual(found("Customer added", [{ ...audit[0]!, kind: "exceptions" }]), [], "another kind is not found by an action's words");
  checks += 4;
}

{
  // The allocation picker's list: only instalments a manual allocation accepts, counted as the choices it offers.
  const due = (i: number, status: string, amountKobo: number, outstandingKobo?: unknown): ValopayRecord => ({ ...record(i, status), kind: "due-items", amountKobo, data: outstandingKobo === undefined ? {} : { outstandingKobo } });
  const dues = [due(1, "scheduled", 5000, 5000), due(2, "paid", 5000, 0), due(3, "partially_paid", 5000, 2000), due(4, "cancelled", 5000, 5000), due(5, "closed", 5000, 5000), due(6, "in_dispute", 5000, 5000), due(7, "unpaid_final", 5000, 5000), due(8, "scheduled", 5000), due(9, "in_collection", 5000, 1.5), due(10, "scheduled", 0, 0)];
  const open = pageRecords(dues, { allocatable: "true", limit: 2 });
  assert.deepEqual([open.total, open.items.map((item) => item.id), open.nextOffset], [5, ["r009", "r008"], 2], "owed and not cancelled, closed or in dispute; an outstanding balance that is not whole reads as the amount");
  assert.deepEqual(pageRecords(dues, { allocatable: "true" }).items.map((item) => item.id), ["r009", "r008", "r007", "r003", "r001"]);
  assert.equal(pageRecords(dues, { allocatable: "false" }).total, 10, "false, like leaving it out, lists every instalment");
  // A renewed reversal review's hold may leave an instalment's status as it was, and the service refuses to allocate to a
  // held instalment, so the picker leaves every held one out, whatever its status; an empty list of reviews holds nothing.
  const held = (i: number, status: string, ids: unknown): ValopayRecord => ({ ...due(i, status, 5000, 5000), data: { outstandingKobo: 5000, legacyReversalReviewIds: ids } });
  const holds = [held(11, "unpaid_final", ["review-1"]), held(12, "scheduled", ["review-1", "review-2"]), held(13, "unpaid_final", []), held(14, "in_collection", "not a list")];
  assert.deepEqual(pageRecords([...dues, ...holds], { allocatable: "true" }).items.map((item) => item.id), ["r014", "r013", "r009", "r008", "r007", "r003", "r001"], "a held instalment is not a choice, whatever its status");
  assert.equal(pageRecords([...dues, ...holds], { allocatable: "false" }).total, 14, "and every instalment is still listed without allocatable");
  assert.equal(allocatableOnly("due-items", { allocatable: "true" }), true);
  assert.equal(allocatableOnly("payments", { allocatable: "false" }), false);
  assert.throws(() => allocatableOnly("payments", { allocatable: "true" }), (error: any) => error.status === 400 && /instalments only/.test(error.message), "asked of another kind, it is refused");
  // One payment's choices (paymentId): the payer rule of its manual allocation becomes the customer filter.
  assert.throws(() => allocatableOnly("due-items", { paymentId: "p1" }), (error: any) => error.status === 400 && /Use it with allocatable=true/.test(error.message), "paymentId without allocatable=true is refused");
  assert.equal(allocatableOnly("due-items", { allocatable: "true", paymentId: "p1" }), true);
  const query = { allocatable: "true" as const, paymentId: "p1" };
  assert.deepEqual([allocationChoices(query, { customerId: "c1" }), allocationChoices(query, {}), allocationChoices(query, null), allocationChoices({ ...query, customerId: "c2" }, { customerId: "c1" }), allocationChoices({ ...query, customerId: "c1" }, { customerId: "c1" })],
    [{ ...query, customerId: "c1" }, query, undefined, undefined, { ...query, customerId: "c1" }], "its payer's instalments, any customer's, none, none for another customer's list, and the payer's list as asked");
  checks += 10;
}

{
  // Saved exports: a file an approved retention run removed is listed as expired (derived from fileDeletedAt), never as completed or needing a retry.
  const job = (i: number, status: string, removed = false): ValopayRecord => ({ ...record(i, status), kind: "exports", data: removed ? { fileDeletedAt: "2027-02-01T00:00:00.000Z" } : {} });
  const jobs = [job(1, "ready"), job(2, "ready", true), job(3, "failed"), job(4, "failed", true), job(5, "queued"), job(6, "running")];
  const listed = (status: string) => pageRecords(jobs, { status }, "exports").items.map((item) => item.id);
  assert.deepEqual(listed("ready"), ["r001"], "Completed lists only exports whose file remains");
  assert.deepEqual(listed("failed"), ["r003"], "Needs retry lists only failed exports whose file remains");
  assert.deepEqual(listed("expired"), ["r004", "r002"], "expired lists ready and failed exports whose file was removed");
  assert.deepEqual([listed("queued"), listed("running"), listed("all").length], [["r005"], ["r006"], 6]);
  assert.deepEqual(pageRecords([record(1, "expired")], { status: "expired" }).items.map((item) => item.id), ["r001"], "another kind's status named expired is its own status");
  checks += 5;
}

{
  const limiter = createCreationLimiter(3, 1000);
  assert.equal(limiter.take("a", 0), true); assert.equal(limiter.take("a", 10), true); assert.equal(limiter.take("a", 20), true);
  assert.equal(limiter.take("a", 30), false, "the fourth creation inside the window is refused");
  assert.equal(limiter.remaining("a", 30), 0);
  assert.equal(limiter.take("b", 30), true, "another address has its own window");
  assert.equal(limiter.take("a", 1001), true, "the window resets");
  assert.equal(limiter.remaining("a", 1001), 2);
  checks += 8;
}

console.log(`API shell tests passed (${checks} checks): paging, watermark, ceiling, filtered totals, audit entries found by their names in words, expired exports, creation limiter.`);
