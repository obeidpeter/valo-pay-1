import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertFinalState } from "../src/domain/final-state-integrity";

// A fresh process catches accidental persistence initialisation even when this
// test runner already has a database URL or cached repository dependencies.
const guardEnvironment = { ...process.env };
delete guardEnvironment.DATABASE_URL;
const isolatedGuard = spawnSync(process.execPath, [
  fileURLToPath(new URL("../../../scripts/node_modules/tsx/dist/cli.mjs", import.meta.url)),
  fileURLToPath(new URL("../src/domain/final-state-integrity.ts", import.meta.url)),
], { env: guardEnvironment, encoding: "utf8", timeout: 30_000 });
assert.equal(isolatedGuard.status, 0, `Final-state validation must load without database configuration: ${isolatedGuard.error?.message ?? isolatedGuard.stderr}`);

// Final-state rules load independently of persistence. The remaining audit,
// journal and readiness helpers still initialise the repository (without connecting).
process.env.DATABASE_URL ||= "postgres://unused:unused@127.0.0.1:1/unused";
const { appendAudit, expiredWorkspaceCleanupEnabled, verifyAudit, journalReceipt } = await import("../src/lib/valopay-store.js");
const { canonicalJson } = await import("@workspace/valopay-schema");
const { seedMerchant } = await import("../src/lib/valopay-seed.js");

const seed = () => seedMerchant("merchant-a");
const expectConflict = (run: () => void) => assert.throws(run, (error: any) => error?.status === 409);

assert.equal(canonicalJson({ b: 2, a: 1 }, "legacy-en-us-null"), '{"a":1,"b":2}', "Historical canonical bytes must not change.");
assert.equal(canonicalJson({ b: 2, a: 1 }, "legacy-en-us-null"), canonicalJson({ a: 1, b: 2 }, "legacy-en-us-null"), "JSONB key reordering must not affect digests.");
assert.equal(expiredWorkspaceCleanupEnabled(undefined), false, "Automatic workspace cleanup must default off.");
assert.equal(expiredWorkspaceCleanupEnabled("off"), false, "Only the explicit opt-in may enable cleanup.");
assert.equal(expiredWorkspaceCleanupEnabled("on"), true, "The documented opt-in must enable cleanup.");
// The journal keeps a reference to what a completed request saved; the whole answer is kept once, as the replay copy.
assert.deepEqual(journalReceipt({ id: "record-1", kind: "customers", name: "Synthetic", data: { note: "x".repeat(1000) } }), { id: "record-1", kind: "customers" }, "A saved record is kept as its reference.");
assert.deepEqual(journalReceipt({ message: "Daily close complete.", record: { id: "close-1", kind: "closes", data: { report: { rows: Array.from({ length: 500 }, () => "x") } } }, data: { closeId: "close-1" } }), { record: { id: "close-1", kind: "closes" } }, "An action keeps a reference to the record it saved, not the record.");
assert.deepEqual(journalReceipt({ id: "run-1", status: "approved", candidates: [] }), { id: "run-1" }, "A result without a record kind keeps its ID.");
for (const answer of [{ message: "Audit log check complete.", data: { valid: true } }, null, undefined, "text", [{ id: "x" }], { id: 7 }]) assert.deepEqual(journalReceipt(answer), {}, "An answer that names no record keeps nothing.");
// An export job's answer names the kind of record it exports, not its own: its reference is to an export.
assert.deepEqual(journalReceipt({ id: "export-1", kind: "customers", format: "csv", status: "queued", downloadUrl: "/api/v1/exports/export-1/download?merchantId=m" }), { id: "export-1", kind: "exports" }, "An export is kept as a reference to the export, not to a customer.");
{
  // Backlog item UX-B02-X3: what Operations says of an entry's request, from its method, path and a few short body fields.
  const { summariseRequest } = await import("../src/lib/operation-summary.js");
  const { recoverableRequest } = await import("../src/lib/operation-recovery.js");
  const facts = (method: string, path: string, rest: Record<string, string | null> = {}) => ({ method, path, action: null, decision: null, status: null, kind: null, format: null, target: null, targetKind: null, ...rest });
  assert.deepEqual(summariseRequest(facts("PATCH", "/v1/records/customers/cus%201", { status: "inactive" })), { summary: { action: "Change a record", targetKind: "customers", targetId: "cus 1", details: [{ name: "Status", value: "Inactive" }] }, resultKind: "customers", resultOverrides: false }, "a record update names its record, from the path, and the status it sets, in words");
  assert.deepEqual(summariseRequest(facts("POST", "/v1/actions", { action: "mandate_suspend", target: "mnd-1", targetKind: "mandates" }))?.summary, { action: "Suspend mandate", targetKind: "mandates", targetId: "mnd-1", details: [] }, "an action is named in words, as its button names it, with the record its recordId names");
  assert.deepEqual(summariseRequest(facts("POST", "/v1/exports", { kind: "customers", format: "csv" })), { summary: { action: "Create an export", targetKind: null, targetId: null, details: [{ name: "Record type", value: "Customers" }, { name: "Format", value: "CSV" }] }, resultKind: "exports", resultOverrides: true }, "an export's answer is an export, whatever kind it exports");
  assert.deepEqual(summariseRequest(facts("POST", "/v1/pilot/cases/exc-1", { action: "claim" }))?.summary, { action: "Update a case", targetKind: "exceptions", targetId: "exc-1", details: [{ name: "Action", value: "Claim" }] });
  // Words, never codes: an action's, a connected banking action's with its product, and a status through the shared labels.
  assert.equal(summariseRequest(facts("POST", "/v1/actions", { action: "kill_switch" }))?.summary.action, "Turn the emergency stop on or off");
  assert.equal(summariseRequest(facts("POST", "/v1/connected/actions", { action: "payment.create" }))?.summary.action, "Pay by Bank: create checkout");
  assert.equal(summariseRequest(facts("POST", "/v1/connected/actions", { action: "consent.revoke" }))?.summary.action, "Withdraw permission");
  assert.equal(summariseRequest(facts("POST", "/v1/connected/actions", { action: "cash.erp.prepare" }))?.summary.action, "Cash Desk: prepare accounting draft");
  assert.deepEqual(summariseRequest(facts("PATCH", "/v1/records/mandates/m-1", { status: "pending_activation" }))?.summary.details, [{ name: "Status", value: "Awaiting activation" }]);
  // The label a new entry stores, and a label an earlier build stored as a spelled-out code, read in words.
  const { requestLabel } = await import("../src/lib/operation-summary.js");
  const { auditEntryName, storedRequestLabel, withAuditName } = await import("../src/lib/action-names.js");
  assert.equal(requestLabel({ method: "POST", path: "/v1/actions", body: { action: "mandate_cancel" } }), "Cancel mandate");
  assert.equal(requestLabel({ method: "POST", path: "/v1/records/due-items", body: {} }), "Add a record");
  assert.equal(requestLabel({ method: "POST", path: "/v1/team/invitations", body: {} }), "Saved change");
  assert.equal(storedRequestLabel("kill switch"), "Turn the emergency stop on or off");
  assert.equal(storedRequestLabel("payment.refund request"), "Pay by Bank: request refund");
  assert.equal(storedRequestLabel("Save pilot batches"), "Save pilot batches", "a label already in words is shown as stored");
  // An audit entry is named in words from its stored action, which stays as it was.
  assert.equal(auditEntryName("post.records.customers"), "Customer added");
  assert.equal(auditEntryName("patch.records.exceptions.3f2a.9"), "Exception edited");
  assert.equal(auditEntryName("mandate_suspend"), "Mandate suspended");
  assert.equal(auditEntryName("consent.grant"), "Permission granted");
  assert.equal(auditEntryName("post.lifecycle.runs.run-1.approve"), "Deletion run approved");
  assert.equal(auditEntryName("an.unknown.code"), "Change recorded");
  const entry = { kind: "audit", name: "post.records.due-items", data: { action: "post.records.due-items" } };
  assert.deepEqual(withAuditName(entry), { kind: "audit", name: "Instalment added", data: { action: "post.records.due-items" } });
  assert.equal(entry.name, "post.records.due-items", "the stored entry is not changed");
  assert.deepEqual(withAuditName({ kind: "customers", name: "post.records", data: {} }).name, "post.records", "only an audit entry is renamed");
  assert.equal(summariseRequest(facts("POST", "/v1/lifecycle/runs/run-1/approve"))?.resultKind, "retention-runs", "an answer that names no kind is the kind its route saves");
  assert.equal(summariseRequest(facts("POST", "/v1/team/invitations")), null, "a route the journal does not record has no summary");
  assert.equal(summariseRequest({ ...facts("POST", "/v1/actions"), method: null, path: null }), null, "nor has a sealed or purged request");
  // Every route the journal records is named in words, whatever its ids.
  const journaled = ["PATCH /v1/records/customers/x", "PATCH /v1/settings", "POST /v1/actions", "POST /v1/imports", "POST /v1/connected/actions", "POST /v1/records/customers", "POST /v1/exports", "POST /v1/exports/x/retry", "POST /v1/pilot/batches", "POST /v1/pilot/batches/x/save", "POST /v1/pilot/batches/x/commit", "POST /v1/pilot/cases/x", "POST /v1/pilot/import-corrections", "POST /v1/pilot/import-corrections/x/decision", "POST /v1/pilot/close-reviews/prepare", "POST /v1/pilot/close-reviews/x/decision", "POST /v1/sources/manifests", "POST /v1/sources/profiles", "POST /v1/sources/profiles/x/save", "POST /v1/sources/paystack/fixtures", "POST /v1/sources/events/x/replay", "POST /v1/work/notifications/read", "POST /v1/work/handovers/acknowledge", "POST /v1/lifecycle/policy", "POST /v1/lifecycle/holds", "POST /v1/lifecycle/runs", "POST /v1/lifecycle/runs/x/approve", "POST /v1/lifecycle/runs/x/execute"];
  for (const route of journaled) {
    const [method, path] = route.split(" ") as [string, string];
    assert.ok(recoverableRequest(method, path, { commit: true, action: "daily_close" }), `${route} is journaled`);
    const described = summariseRequest(facts(method, path, { action: "daily_close" }));
    assert.ok(described && /^[A-Z][a-z]/.test(described.summary.action) && !/[/_]|\.[a-z]/.test(described.summary.action), `${route} is named in words: ${described?.summary.action}`);
  }
}
{
  const state = seed();
  appendAudit(state, { actor: "System", role: "Admin", now: "2026-01-01T00:00:00.000Z" }, "test", "workspace", "Synthetic test");
  // JSONB can reorder keys; verification must use the same canonical encoding.
  const audit = state.records.find((record) => record.kind === "audit")!;
  audit.data = Object.fromEntries(Object.entries(audit.data).reverse());
  assert.equal(verifyAudit(state).valid, true);
}
{
  const unchanged = seed();
  assert.doesNotThrow(() => assertFinalState({ merchant: structuredClone(unchanged.merchant), settings: {}, records: [] }, unchanged, "merchant-a"));
}
{
  const before = seed();
  const after = structuredClone(before);
  after.records[0]!.merchantId = "merchant-b";
  expectConflict(() => assertFinalState(before, after, "merchant-a"));
}
{
  const before = seed();
  const after = structuredClone(before);
  after.records.pop();
  expectConflict(() => assertFinalState(before, after, "merchant-a"));
}
{
  const before = seed();
  const frozen = before.records.find((record) => record.kind === "policies")!;
  frozen.status = "approved";
  const after = structuredClone(before);
  after.records.find((record) => record.id === frozen.id)!.name = "rewritten";
  expectConflict(() => assertFinalState(before, after, "merchant-a"));
}
{
  const before = seed();
  before.records.push({
    id: "audit-1", merchantId: "merchant-a", kind: "audit", name: "created", status: "recorded",
    reference: "", amountKobo: 0, customerId: "", createdAt: "2028-01-01T00:00:00.000Z", updatedAt: "2028-01-01T00:00:00.000Z",
    data: { sequence: 1, hash: "unchanged" },
  });
  const after = structuredClone(before);
  after.records.find((record) => record.id === "audit-1")!.data.hash = "rewritten";
  expectConflict(() => assertFinalState(before, after, "merchant-a"));
}
{
  const before = seed();
  const after = structuredClone(before);
  const payment = after.records.find((record) => record.kind === "payments" && record.status === "allocated")!;
  const due = after.records.find((record) => record.kind === "due-items" && record.customerId === payment.customerId)!;
  after.records.push({
    id: "new-over-allocation", merchantId: "merchant-a", kind: "allocations", name: "forged allocation",
    status: "confirmed", reference: "", amountKobo: payment.amountKobo, customerId: payment.customerId,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    data: { paymentId: payment.id, dueItemId: due.id, synthetic: true },
  });
  expectConflict(() => assertFinalState(before, after, "merchant-a"));
}

{
  const before = seed();
  const attempt = before.records.find((record) => record.kind === "attempts")!;
  const after = structuredClone(before);
  const due = after.records.find((record) => record.id === attempt.data.dueItemId)!;
  due.amountKobo += 100000;
  assert.doesNotThrow(() => assertFinalState(before, after, "merchant-a"), "A due edit must not rewrite or invalidate a historical attempt amount.");
  const newAttempt = { ...structuredClone(attempt), id: "new-mismatched-attempt" };
  after.records.push(newAttempt);
  expectConflict(() => assertFinalState(before, after, "merchant-a"));
}
for (const amount of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  const before = seed(), after = structuredClone(before);
  after.records[0]!.amountKobo = amount;
  expectConflict(() => assertFinalState(before, after, "merchant-a"));
}
for (const key of ["policyId", "experimentId", "proposedDueItemId", "noticeId", "settlementBatchId", "statementObservationId", "virtualAccountCustomerId", "linkedRecordId"]) {
  const before = seed(), after = structuredClone(before);
  after.records.find((record) => record.kind === "due-items")!.data[key] = "foreign-or-missing-record";
  expectConflict(() => assertFinalState(before, after, "merchant-a"));
}
{
  const before = seed(), after = structuredClone(before);
  after.records.push(structuredClone(after.records[0]!));
  expectConflict(() => assertFinalState(before, after, "merchant-a"));
}
{
  // A recorded payer never changes, except that Finance's identification is withdrawn, back to no payer, while nothing of
  // the payment is applied and the identification is kept in its history (the review of the 23 September audit fixes).
  const identified = () => {
    const state = seed();
    const payment = state.records.find((record) => record.reference === "SBX-UNIDENTIFIED-001")!;
    const due = state.records.find((record) => record.kind === "due-items" && record.status === "scheduled")!;
    const allocation = { ...structuredClone(payment), id: "allocation-identifying", kind: "allocations", name: "Allocation R7", status: "superseded", reference: "SYN-allocation", customerId: due.customerId, amountKobo: 1_000_000, data: { paymentId: payment.id, dueItemId: due.id, rule: "R7", confidence: "manual", automatic: false, supersededByReview: true } };
    state.records.push(allocation);
    payment.customerId = due.customerId;
    payment.data.payerIdentification = { customerId: due.customerId, identifiedBy: "Sandbox Finance", identifiedAt: "2027-07-01T09:00:00.000Z", reason: "By phone.", dueItemId: due.id, allocationId: allocation.id };
    return { state, payment: payment.id, allocation: allocation.id, customer: due.customerId };
  };
  const withdraw = (state: ReturnType<typeof seed>, id: string) => {
    const payment = state.records.find((record) => record.id === id)!;
    payment.data.payerIdentificationHistory = [{ ...payment.data.payerIdentification, withdrawnBy: "Sandbox Finance", withdrawnAt: "2027-07-02T09:00:00.000Z", withdrawnReason: "Wrong payer." }];
    delete payment.data.payerIdentification;
    payment.customerId = "";
    return payment;
  };
  const { state: before, payment, allocation, customer } = identified();
  const other = before.records.find((record) => record.kind === "customers" && record.id !== customer)!.id;
  const withdrawn = structuredClone(before); withdraw(withdrawn, payment);
  assert.doesNotThrow(() => assertFinalState(before, withdrawn, "merchant-a"), "a withdrawal that keeps its history while nothing is applied is accepted");
  const forgotten = structuredClone(withdrawn); delete forgotten.records.find((record) => record.id === payment)!.data.payerIdentificationHistory;
  expectConflict(() => assertFinalState(before, forgotten, "merchant-a"));
  const applied = structuredClone(before);
  Object.assign(applied.records.find((record) => record.id === allocation)!, { status: "confirmed" });
  applied.records.find((record) => record.id === payment)!.data.allocatedKobo = 1_000_000;
  const appliedWithdrawn = structuredClone(applied); withdraw(appliedWithdrawn, payment);
  expectConflict(() => assertFinalState(applied, appliedWithdrawn, "merchant-a"));
  const reassigned = structuredClone(before); reassigned.records.find((record) => record.id === payment)!.customerId = other;
  expectConflict(() => assertFinalState(before, reassigned, "merchant-a"));
  const named = structuredClone(before); delete named.records.find((record) => record.id === payment)!.data.payerIdentification;
  const namedWithdrawn = structuredClone(named); Object.assign(namedWithdrawn.records.find((record) => record.id === payment)!, { customerId: "" });
  expectConflict(() => assertFinalState(named, namedWithdrawn, "merchant-a"));
  // Nor is an identification withdrawn once evidence resolved to the payment names that customer (the third review of the audit fixes).
  const confirmed = structuredClone(before), paymentRecord = confirmed.records.find((record) => record.id === payment)!;
  confirmed.records.push({ ...structuredClone(paymentRecord), id: "evidence-naming-payer", kind: "observations", name: "transfer TRF-1", status: "resolved", reference: paymentRecord.reference, customerId: customer, data: { source: "transfer", paymentId: payment, resolutionKey: "canonical_provider_reference" } });
  const confirmedWithdrawn = structuredClone(confirmed); withdraw(confirmedWithdrawn, payment);
  expectConflict(() => assertFinalState(confirmed, confirmedWithdrawn, "merchant-a"));
  const unnamed = structuredClone(confirmed); Object.assign(unnamed.records.find((record) => record.id === "evidence-naming-payer")!, { customerId: "" });
  const unnamedWithdrawn = structuredClone(unnamed); withdraw(unnamedWithdrawn, payment);
  assert.doesNotThrow(() => assertFinalState(unnamed, unnamedWithdrawn, "merchant-a"), "evidence that names no payer does not stop the withdrawal");
  // After the withdrawal, Finance identifies the real payer; the wrong match keeps the customer the history names, and no other.
  const reidentified = structuredClone(withdrawn); Object.assign(reidentified.records.find((record) => record.id === payment)!, { customerId: other });
  assert.doesNotThrow(() => assertFinalState(withdrawn, reidentified, "merchant-a"), "the real payer is recorded next");
  const unrelated = structuredClone(reidentified); unrelated.records.find((record) => record.id === payment)!.data.payerIdentificationHistory[0].customerId = "someone-else";
  expectConflict(() => assertFinalState(withdrawn, unrelated, "merchant-a"));
}
console.log("valopay repository pure guards passed");

{
  const { queueExport, retryExport } = await import("../src/lib/export-jobs");
  const context = { actor: "Sandbox Finance", role: "Finance", now: "2028-01-01T10:00:00.000Z" };
  for (const status of ["failed", "running"] as const) {
    const before = seed();
    const job = queueExport(before, context, { kind: "customers", format: "csv" }, "/private/synthetic");
    const record = before.records.find(row => row.id === job.id)!;
    record.status = status; Object.assign(record.data, { lastError: "Synthetic failure", leaseToken: "old-lease", leaseExpiresAt: "2028-01-01T09:59:59.000Z" });
    const after = structuredClone(before); retryExport(after, context, job.id);
    assert.doesNotThrow(() => assertFinalState(before, after, "merchant-a", context.now));
    for (const key of ["bucket", "objectName", "kind", "format", "requestedBy", "checksum", "attempts"]) {
      const forged = structuredClone(after); forged.records.find(row => row.id === job.id)!.data[key] = "rewritten";
      expectConflict(() => assertFinalState(before, forged, "merchant-a", context.now));
    }
    if (status === "running") expectConflict(() => assertFinalState(before, after, "merchant-a", "2028-01-01T09:00:00.000Z"));
    const ready = structuredClone(before); ready.records.find(row => row.id === job.id)!.status = "ready";
    expectConflict(() => assertFinalState(ready, after, "merchant-a", context.now));
  }
  console.log("Export retry guards passed: failed/expired only, unchanged request and object identity, immutable ready evidence.");
}
{
  // The guard query in docs/database-migrations.md, run by the owner before publishing, is built from the catalogue
  // readiness checks: one row for each guard, in its order, with its kind, name, table and definition as SQL text,
  // and one for each superseded guard, with its table and definition. integrity-guards.integration.test.ts runs it
  // against PostgreSQL.
  const { readFileSync } = await import("node:fs");
  const { integrityGuards, supersededGuards } = await import("../src/lib/valopay-store.js");
  const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;
  const rows = integrityGuards.map((guard) => `  (${[guard.type, guard.name, guard.table, guard.definition].map(literal).join(", ")})`).join(",\n");
  const superseded = supersededGuards.map((guard) => `  (${[guard.table, guard.definition].map(literal).join(", ")})`).join(",\n");
  const documented = readFileSync(new URL("../../../docs/database-migrations.md", import.meta.url), "utf8");
  const query = [...documented.matchAll(/```sql\n([\s\S]*?)```/g)].map((match) => match[1]!);
  assert.equal(query.length, 1, "docs/database-migrations.md holds one SQL block, the guard query");
  assert.ok(query[0]!.includes(`FROM (VALUES\n${rows}\n) AS guard`), `The documented guard query must list exactly integrityGuards; its rows should read:\n${rows}`);
  assert.ok(query[0]!.includes(`FROM (VALUES\n${superseded}\n) AS superseded`), `The documented guard query must list exactly supersededGuards; its rows should read:\n${superseded}`);
  console.log(`Guard query rows passed: the query in docs/database-migrations.md lists the ${integrityGuards.length} integrity guards readiness checks, in order, and each superseded guard it refuses.`);
}
{
  // Readiness names a missing guard with a migration (guardMigrations) only when applying that file again builds it:
  // the file creates the guard with a statement of its own. A guard created inside CREATE TABLE IF NOT EXISTS, as 003
  // and 004 create most of theirs, is not built again once the table exists, so it is named with the manual restore,
  // as the base tables' guards are. Migration 009 drops exactly the superseded definition readiness refuses.
  const { readFileSync, readdirSync } = await import("node:fs");
  const { integrityGuards, guardMigrations, supersededGuards } = await import("../src/lib/valopay-store.js");
  const directory = new URL("../../../lib/db/migrations/", import.meta.url);
  const files = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();
  const sql = Object.fromEntries(files.map((file) => [file, readFileSync(new URL(file, directory), "utf8")]));
  const buildsAgain = (file: string, guard: (typeof integrityGuards)[number]) => new RegExp(`^CREATE UNIQUE INDEX IF NOT EXISTS ${guard.name} ON `, "m").test(sql[file]!);
  for (const guard of integrityGuards) {
    const migration = guardMigrations[guard.name];
    assert.deepEqual(files.filter((file) => buildsAgain(file, guard)), migration ? [migration] : [], `${guard.name} is named with a migration exactly when applying that file again builds it`);
  }
  const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;
  for (const guard of supersededGuards) assert.ok(sql[guard.migration]!.includes(`old_definition CONSTANT text := ${literal(guard.definition)};`), `${guard.migration} drops the definition readiness refuses`);
  console.log(`Guard sources passed: each of the ${Object.keys(guardMigrations).length} guards a migration builds again when applied is named with that file, every other guard with the manual restore, and 009 drops the superseded definition readiness refuses.`);
}
