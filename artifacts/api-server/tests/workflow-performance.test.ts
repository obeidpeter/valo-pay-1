import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { runDailyClose } from "../src/domain/actions";
import { reconcile } from "../src/domain/reconciliation";
import { workflowFixture, WORKFLOW_NOW } from "./workflow-fixture";
import { positionFor, positionMismatches, positionSnapshot } from "../src/domain/close";

process.env.DATABASE_URL ||= "postgres://unused:unused@127.0.0.1:1/unused";
const { buildExportBytes } = await import("../src/lib/valo-pay-1-exports");

const count = Number(process.env.VALO_PAY_1_BENCH_CUSTOMERS || 1_000);
const fixture = workflowFixture(count);
const context = { now: WORKFLOW_NOW, actor: "Sandbox Finance", role: "Finance" };
const timings: Record<string, number> = {};
const timed = <T>(name: string, operation: () => T) => { const start = performance.now(); const result = operation(); timings[name] = Math.round((performance.now() - start) * 10) / 10; return result; };
const reconciliation = structuredClone(fixture);
const result = timed("reconciliationMs", () => reconcile(reconciliation, context));
assert.equal(result.data.observationsResolved, Math.ceil(count / 5));
assert.equal(result.data.allocationsByRule.R1, Math.ceil(count / 5));
const state = structuredClone(fixture);
let fullArrayFilterVisits = 0;
Object.defineProperty(state.records, "filter", { configurable: true, value: function (...args: Parameters<Array<any>["filter"]>) { fullArrayFilterVisits += this.length; return Array.prototype.filter.apply(this, args); } });
const close = timed("dailyCloseMs", () => runDailyClose(state, context, "manual"));
// A deterministic work budget, not a machine-speed assertion: the prior
// per-customer/per-instalment rebuild exceeded 180 million visits here, and
// scanning every record for each match confirmed (the 23 September audit)
// about 12 million; the close now scans the list a bounded number of times.
assert.ok(fullArrayFilterVisits < fixture.records.length * 100, `close full-array filter visits ${fullArrayFilterVisits} exceeded budget`);
delete (state.records as any).filter;
assert.equal(close.record!.data.report.positionRebuild.customersChecked, count);
assert.equal(close.record!.data.report.positionRebuild.mismatches.length, 0);
assert.equal(close.record!.data.report.customerPositionsChanged.length, Math.ceil(count / 5));
assert.equal(close.record!.data.report.allocated.count, count * 6 + Math.ceil(count / 5));
const again = timed("repeatCloseMs", () => runDailyClose(state, { ...context, now: "2027-07-02T06:00:00.000Z" }, "manual"));
assert.equal(again.record!.data.report.customerPositionsChanged.length, 0);
assert.equal(again.record!.data.report.allocated.count, 0);
const exportSizes: Record<string, number> = {};
for (const format of ["csv", "json", "pdf"] as const) {
  const start = performance.now();
  const output = await buildExportBytes(state, context, format === "pdf" ? { kind: "customer-pack", customerId: "customer-0", format } : { kind: "payments", format });
  timings[`export${format.toUpperCase()}Ms`] = Math.round((performance.now() - start) * 10) / 10;
  exportSizes[format] = output.bytes.length;
  assert.ok(output.bytes.length > 100);
  if (format === "pdf") { assert.equal(output.bytes.subarray(0, 5).toString(), "%PDF-"); assert.equal(output.pack!.timeline.length, 29); }
  if (format === "json") assert.equal(JSON.parse(output.bytes.toString()).data.length, count * 6 + Math.ceil(count / 5));
  if (format === "csv") assert.equal(output.bytes.toString().split("\r\n").length, count * 6 + Math.ceil(count / 5) + 1);
}

// Indexed aggregates match the direct single-customer calculation even after
// partial allocations, cancellation and an intentionally stale stored balance.
const varied = workflowFixture(3);
const allocation = varied.records.find(record => record.kind === "allocations")!;
allocation.amountKobo = 500_000;
varied.records.find(record => record.id === allocation.data.dueItemId)!.data.outstandingKobo = 12;
varied.records.find(record => record.id === "due-1-1")!.status = "cancelled";
for (const [id, position] of positionSnapshot(varied)) assert.deepEqual(position, positionFor(varied, id));
assert.deepEqual(positionMismatches(varied).map(row => [row.dueItemId, row.rebuiltOutstandingKobo]), [["due-0-1", 500_000]]);

// Preserve first-record wins across collisions of the three strong keys.
const collision = workflowFixture(2);
const payments = collision.records.filter(record => record.kind === "payments");
payments[1]!.data.providerReference = payments[0]!.reference;
const observation = collision.records.find(record => record.id === "new-observation-0")!;
observation.reference = payments[0]!.reference;
observation.data.paymentId = payments[1]!.id;
reconcile(collision, context);
assert.equal(observation.data.paymentId, payments[0]!.id);

// Duplicate evidence in one batch is registered before the next observation.
const duplicate = workflowFixture(1);
const original = duplicate.records.find(record => record.id === "new-observation-0")!;
duplicate.records.push({ ...structuredClone(original), id: "same-pass-duplicate" });
reconcile(duplicate, context);
assert.equal(duplicate.records.filter(record => record.kind === "payments" && record.reference === original.reference).length, 1);
assert.equal(duplicate.records.filter(record => record.kind === "allocations" && record.data.dueItemId === "new-due-0").length, 1);
console.log(JSON.stringify({ benchmark: "complete-synthetic-workflows", customers: count, initialRecords: fixture.records.length, fullArrayFilterVisits, timings, exportBytes: exportSizes, scope: "domain execution and complete local artifact generation; excludes PostgreSQL persistence, object storage and network" }));
