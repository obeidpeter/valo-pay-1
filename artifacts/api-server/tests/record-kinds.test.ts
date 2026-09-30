// Typed record kinds (audit item 27): every kind the platform stores has a
// typed data schema in lib/valopay-schema/src/records.ts and, where its
// workflow uses a fixed set, its statuses in kinds.ts. The record API still
// addresses and edits exactly the kinds it did, and the schemas describe what
// the workflows really write: each of the platform's own kinds is produced
// here by its real workflow and parsed with its schema.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

process.env.DATABASE_URL ||= "postgres://unused:unused@127.0.0.1:1/unused";
const schema = await import("@workspace/valopay-schema");
const { domainRecordKinds, editableKinds, recordDataSchemas, recordKinds, recordStatuses, storedRecordKinds, describeIssues } = schema;
const { seedMerchant } = await import("../src/lib/valopay-seed.js");
const { makeRecord, recordsOf } = await import("../src/domain/records.js");
const { validateRecord } = await import("../src/domain/validation.js");
const { saveImportBatch, commitImportBatch, coordinateCase } = await import("../src/domain/pilot-workflow.js");
const { saveSourceProfile } = await import("../src/domain/source-quality.js");
const { saveSourceManifest } = await import("../src/domain/source-completeness.js");
const { bindCloseReviewBasis, closeReviewIssues, prepareCloseReview, decideCloseReview } = await import("../src/domain/close-review.js");
const { personalWorkItems, recordWorkReceipt } = await import("../src/domain/personal-work.js");
const { previewImportCorrection, proposeImportCorrection, decideImportCorrection } = await import("../src/domain/import-corrections.js");
const { lifecyclePolicy, lifecycleHolds, lifecyclePreview, approveLifecycleRun, saveLifecyclePolicy, setLifecycleHold, eraseLifecycleRawCsv, recordLifecycleReceipt } = await import("../src/domain/lifecycle.js");
const { runPaystackFixture } = await import("../src/providers/paystack-inbox.js");
const { runConnectedAction, connectedActionSchema, connectedRevision } = await import("../src/domain/connected.js");
type Context = import("../src/domain/types.js").Context;
type DomainState = import("../src/domain/types.js").DomainState;
type TypedRecord<K extends import("@workspace/valopay-schema").RecordKind> = import("../src/domain/types.js").TypedRecord<K>;
type RecordDataOf<K extends import("@workspace/valopay-schema").RecordKind> = import("@workspace/valopay-schema").RecordDataOf<K>;

let checks = 0;
const root = path.resolve(import.meta.dirname, "..", "..", "..");

// ---- 1. The record API addresses and edits exactly the kinds it did ----
assert.deepEqual([...recordKinds], [
  "customers", "mandates", "due-items", "attempts", "observations", "payments", "allocations",
  "settlement-batches", "exceptions", "policies", "templates", "notifications", "cutovers", "audit",
  "closes", "exports", "commercial", "reviews", "evidence", "experiments", "costs", "calendar",
  "integrations", "members", "retry-decisions", "invoices",
]);
assert.deepEqual([...editableKinds], [
  "customers", "mandates", "due-items", "attempts", "observations", "exceptions", "policies", "templates",
  "cutovers", "commercial", "reviews", "evidence", "experiments", "costs", "calendar", "settlement-batches",
]);
{
  const state = seedMerchant("record-kinds-api", true);
  for (const kind of domainRecordKinds) {
    checks += 2;
    assert.ok(!(recordKinds as readonly string[]).includes(kind), `${kind} is not a record API path`);
    assert.throws(() => validateRecord(state, { actor: "Sandbox Admin", role: "Admin", now: "2026-09-23T09:00:00.000Z" }, kind, { status: "recorded", data: {} }), new RegExp(`^Error: ${schema.recordTypeTitle(kind, 2)} cannot be created or edited here\\.$`));
  }
}

// ---- 2. Every stored kind has a schema, and every kind the platform writes is declared ----
assert.deepEqual(Object.keys(recordDataSchemas).sort(), [...storedRecordKinds].sort());
assert.equal(new Set(storedRecordKinds).size, recordKinds.length + domainRecordKinds.length);
for (const kind of Object.keys(recordStatuses)) { checks += 1; assert.ok((storedRecordKinds as readonly string[]).includes(kind), `${kind} has statuses but is not a stored kind`); }
const walk = (dir: string): string[] => readdirSync(path.join(root, dir)).flatMap((entry) => {
  const file = `${dir}/${entry}`;
  return statSync(path.join(root, file)).isDirectory() ? walk(file) : /\.ts$/.test(file) ? [file] : [];
});
const written = new Set<string>();
for (const file of walk("artifacts/api-server/src")) {
  const text = readFileSync(path.join(root, file), "utf8");
  for (const match of text.matchAll(/makeRecord(?:<[^>]*>)?\(\s*\w+\s*,\s*["']([a-z-]+)["']/g)) written.add(match[1]!);
  for (const match of text.matchAll(/store\(\s*["'](connected-cash-[a-z-]+)["']/g)) written.add(match[1]!);
  for (const match of text.matchAll(/kind\s*:\s*["']([a-z-]+)["']\s*,\s*name\s*:/g)) written.add(match[1]!);
}
assert.ok(written.size >= 40, `the scan found the kinds the source writes (${written.size})`);
for (const kind of written) { checks += 1; assert.ok((storedRecordKinds as readonly string[]).includes(kind), `${kind} is written but has no typed schema in records.ts`); }

// ---- 3. Each of the platform's kinds, written by its real workflow, matches its schema and statuses ----
const ops: Context = { actor: "Clerk:operator", principalId: "person-operator", role: "Operations", now: "2026-09-23T09:00:00.000Z" };
const finance: Context = { actor: "Clerk:finance", principalId: "person-finance", role: "Finance", now: "2026-09-23T10:00:00.000Z" };
const admin: Context = { actor: "Clerk:admin", role: "Admin", now: "2026-10-30T10:00:00.000Z" };
const people = [{ actor: ops.actor, name: "Operator", role: "Operations" }, { actor: finance.actor, name: "Finance", role: "Finance" }, { actor: admin.actor, name: "Administrator", role: "Admin" }];
const date = "2026-09-22";
const pilot = seedMerchant("record-kinds-pilot", true);
{
  const batch = saveImportBatch(pilot, ops, { name: "Customers", source: "lms", sourceBatchId: "customers-22", kind: "customers", businessDate: date, csv: "source_row_id,name,reference,consentProvenance\nrow-1,Ada Import,IMP-001,Synthetic consent", mapping: {}, identityColumn: "source_row_id", amountUnit: "naira", syntheticOnly: true });
  commitImportBatch(pilot, ops, batch.id, batch.updatedAt);
  saveSourceProfile(pilot, ops, { name: "Loan system customers", source: "lms", kind: "customers", mapping: {}, identityColumn: "source_row_id", amountUnit: "naira", firstExpectedAt: "2026-09-20T08:00:00.000Z", cadenceHours: 24, graceMinutes: 60, expectedRows: null, expectedAmountKobo: null, status: "active", syntheticOnly: true });
  saveSourceManifest(pilot, ops, { businessDate: date, files: [{ source: "lms", sourceBatchId: "customers-22", kind: "customers", expectedRows: 1, expectedAmountKobo: 0 }], noFilesExpected: false, reason: "The source owner confirms the daily file set.", evidence: "Source control report KINDS-22.", syntheticOnly: true });
  // A case claimed and read.
  const exception = recordsOf(pilot, "exceptions").find((record) => !["resolved", "closed"].includes(record.status))!;
  coordinateCase(pilot, ops, exception.id, { action: "claim", expectedUpdatedAt: exception.updatedAt, nextAction: "Call the customer about the payment.", nextActionAt: "2026-09-24T10:00:00.000Z", evidenceIds: [], note: "Claimed for the kinds test." }, people);
  const item = personalWorkItems(pilot, ops, people).find((work) => work.sourceId === exception.id)!;
  recordWorkReceipt(pilot, ops, people, "read", { sourceId: item.sourceId, eventId: item.eventId, expectedUpdatedAt: item.sourceVersion, expectedDigest: item.sourceDigest });
  // A close prepared and approved.
  const close = makeRecord(pilot, "closes" as string, { name: "Kinds close", status: "completed", createdAt: ops.now, data: { sourceBusinessDate: date, closedAt: ops.now, summary: "Kinds close", report: { variances: { count: 0, batches: [] }, positionRebuild: { mismatches: [] }, unallocated: { count: 0 }, proposed: { count: 0 }, possibleDuplicates: { count: 0 } } } });
  bindCloseReviewBasis(pilot, close);
  const review = prepareCloseReview(pilot, ops, { closeId: close.id, expectedUpdatedAt: close.updatedAt, reviewer: finance.actor, preparationNote: "Compared the close against the source controls.", discrepancyResponses: closeReviewIssues(close).map((issue) => ({ issueId: issue.id, explanation: "Finance owns the follow-up for this item." })), unresolvedAcceptance: "Finance will inspect the outstanding items tomorrow." }, [finance]);
  decideCloseReview(pilot, finance, review.id, { action: "approve", expectedUpdatedAt: review.updatedAt, note: "Independently checked this close snapshot.", sourceExceptions: review.data.snapshot!.data.reviewBasis.sourceCompleteness.issues.map((issue: { id: string }) => ({ issueId: issue.id, reason: "Accepted for this synthetic rehearsal.", evidence: "Finance review case KINDS-1." })) });
  // An import correction proposed and approved.
  const target = pilot.records.find((record) => record.data.importIdentity?.rowId === "row-1")!;
  const correction = { batchId: batch.id, targetId: target.id, expectedUpdatedAt: target.updatedAt, changes: { name: "Ada Corrected" }, syntheticOnly: true as const };
  const preview = previewImportCorrection(pilot, ops, correction);
  const proposal = proposeImportCorrection(pilot, ops, { ...correction, previewDigest: preview.previewDigest, reviewer: finance.actor, reason: "Correct the source name", evidence: "SOURCE-KINDS-1" }, [{ actor: finance.actor, role: "Finance" }]);
  decideImportCorrection(pilot, finance, proposal.id, { proposalDigest: proposal.proposalDigest, action: "approve", reason: "Checked against the corrected source" }, [{ actor: finance.actor, role: "Finance" }]);
  // Retention: a policy, a hold released, a run approved and one raw CSV erased.
  saveLifecyclePolicy(pilot, admin, { policy: { rawCsvDays: 30, journalPayloadDays: null, exportFileDays: null, auditTrail: "retain" }, expectedRevision: lifecyclePolicy(pilot).revision, reason: "Agreed source retention for the kinds test." });
  for (const held of [true, false]) setLifecycleHold(pilot, admin, { kind: "raw_csv", sourceId: batch.id, held, expectedHoldRevision: lifecycleHolds(pilot).revision, reason: held ? "Keep this source for the kinds test." : "The kinds test released its hold." });
  const run = lifecyclePreview(pilot, admin, { expectedPolicyRevision: lifecyclePolicy(pilot).revision });
  approveLifecycleRun(pilot, admin, run.id, { expectedUpdatedAt: run.updatedAt, previewDigest: run.previewDigest, reason: "Reviewed the exact eligible sample source." });
  eraseLifecycleRawCsv(pilot, admin, run.id, run.candidates[0]!);
  recordLifecycleReceipt(pilot, admin, run.id, run.candidates[0]!, "deleted", "Committed source CSV removed; imported records retained.");
  // Paystack test evidence in every outcome the fixtures produce.
  for (const scenario of ["payment", "duplicate", "amount_mismatch", "out_of_order", "tampered"] as const) runPaystackFixture(pilot, finance, scenario);
}
// Connected banking: consents, a refunded pay-by-bank checkout, a reviewed credit assessment and the Cash Desk.
const connected = seedMerchant("record-kinds-connected");
{
  const sandbox: Context = { actor: "Sandbox Admin", role: "Admin", now: "2026-09-21T10:00:00.000Z" };
  const sandboxFinance: Context = { ...sandbox, actor: "Sandbox Finance", role: "Finance" };
  const act = (action: string, data: Record<string, unknown> = {}, recordId?: string, context = sandbox) =>
    runConnectedAction(connected, context, connectedActionSchema.parse({ action, data, recordId, reason: "Testing the typed record kinds", expectedRevision: connectedRevision(connected) })) as { id: string };
  const due = connected.records.find((record) => record.kind === "due-items" && record.reference === "DEMO-LOAN-1005")!;
  const checkout = act("payment.create", { dueItemId: due.id, amountKobo: due.amountKobo });
  act("payment.authorise", {}, checkout.id);
  act("payment.outcome", { outcome: "confirmed" }, checkout.id);
  act("payment.refund_request", {}, checkout.id);
  act("payment.refund_confirm", {}, checkout.id, sandboxFinance);
  const applicant = recordsOf(connected, "customers")[0]!;
  for (const purpose of ["account_read", "credit_assessment"]) act("consent.grant", { subjectId: applicant.id, purpose });
  const assessment = act("credit.assess", { customerId: applicant.id, scenario: "ready" });
  act("credit.review", { expectedAssessmentVersion: 1, outcome: "approve", rationale: "Reviewed the synthetic source and all calculation explanations.", applicantExplanation: "The supplied synthetic evidence supports this exercise outcome.", reasonCodes: ["synthetic_evidence_reviewed"] }, assessment.id, sandboxFinance);
  for (const purpose of ["merchant_account_read", "erp_draft", "payroll_prepare"]) act("consent.grant", { subjectId: "sme", purpose });
  act("cash.initialize");
  act("cash.forecast");
  act("cash.erp.prepare");
  act("cash.vat.export", {}, undefined, sandboxFinance);
  act("cash.payroll.prepare");
  const consent = recordsOf(connected, "connected-consents").find((record) => record.data.subjectId === "sme")!;
  act("consent.revoke", {}, consent.id);
}
const seen = new Map<string, number>();
for (const record of [...pilot.records, ...connected.records]) {
  if (!(domainRecordKinds as readonly string[]).includes(record.kind)) continue;
  const kind = record.kind as (typeof domainRecordKinds)[number];
  seen.set(kind, (seen.get(kind) || 0) + 1);
  const parsed = recordDataSchemas[kind].safeParse(record.data);
  checks += 1;
  assert.ok(parsed.success, `${kind} data matches its schema: ${parsed.success ? "" : describeIssues(parsed.error)}`);
  const statuses = (recordStatuses as Partial<Record<string, readonly string[]>>)[kind];
  if (statuses) { checks += 1; assert.ok(statuses.includes(record.status), `${kind} status ${record.status} is one of ${statuses.join(", ")}`); }
}
assert.deepEqual([...domainRecordKinds].filter((kind) => !seen.has(kind)), [], "every platform kind was produced by a workflow");
assert.ok(["recorded", "awaiting_verification", "quarantined", "rejected_fixture"].every((status) => recordsOf(pilot, "provider-events").some((record) => record.status === status)));

// ---- 4. The data is typed: TypeScript checks this function (tsconfig.tests.json), and it never runs ----
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
export function typedKinds(state: DomainState, review: TypedRecord<"close-reviews">, run: TypedRecord<"retention-runs">) {
  const digest: string | undefined = review.data.snapshotDigest;
  const candidates: Array<{ sourceId: string; digest: string }> | undefined = run.data.candidates;
  const action: Equal<RecordDataOf<"work-events">["action"], "read" | "acknowledge" | undefined> = true;
  const kind: Equal<RecordDataOf<"import-batches">["kind"], "customers" | "mandates" | "due-items" | "attempts" | "observations" | undefined> = true;
  const receipt: Equal<RecordDataOf<"retention-receipts">["result"], "deleted" | "already_absent" | "blocked" | "failed" | undefined> = true;
  // @ts-expect-error a close review's snapshot digest is a string
  makeRecord(state, "close-reviews", { data: { snapshotDigest: 1 } });
  // @ts-expect-error an import batch holds one of the importer's kinds
  makeRecord(state, "import-batches", { data: { kind: "payments" } });
  // @ts-expect-error a retention run's candidates are retention candidates
  makeRecord(state, "retention-runs", { data: { candidates: ["batch-1"] } });
  // @ts-expect-error a work receipt's action is read or acknowledge
  makeRecord(state, "work-events", { data: { action: "approve" } });
  // @ts-expect-error a provider event's delivery count is a number
  recordsOf(state, "provider-events")[0]!.data.deliveryCount = "2";
  return { digest, candidates, action, kind, receipt };
}

console.log(`Record kinds passed: ${checks} checks; ${domainRecordKinds.length} platform kinds typed and each matched by its real workflow's records (${[...seen.values()].reduce((sum, count) => sum + count, 0)} records); the record API's kinds unchanged.`);
