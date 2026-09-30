import assert from "node:assert/strict";
import { seedMerchant } from "../src/lib/valopay-seed";
import {
  saveImportBatch,
  commitImportBatch,
  coordinateCase,
  batchView,
} from "../src/domain/pilot-workflow";
import { advanceRecordVersions } from "../src/lib/edit-versions";
import { validateRecord } from "../src/domain/validation";
import { executeAction } from "../src/domain/actions";
import type { BatchInput } from "@workspace/valopay-schema";
import { ZodError } from "zod";
process.env.DATABASE_URL ||= "postgres://unused:unused@127.0.0.1:1/unused";
const { assertFinalState } = await import("../src/lib/valopay-store");
const { recoverableRequest } = await import("../src/lib/operation-recovery");

const ctx = {
  actor: "Clerk:user_A",
  role: "Admin",
  now: "2026-09-22T10:00:00.000Z",
};
const input: BatchInput = {
  name: "Customer feed",
  source: "loan-system",
  sourceBatchId: "feed-001",
  kind: "customers",
  identityColumn: "source_row_id",
  amountUnit: "naira",
  syntheticOnly: true,
  mapping: {},
  csv: "source_row_id,name,consentProvenance\nsource-1,Same name,Sample consent\nsource-2,Same name,Sample consent",
};
const state = seedMerchant("pilot-domain", true);
const customersBefore = state.records.filter(
  (r) => r.kind === "customers",
).length;
assert.throws(
  () =>
    saveImportBatch(structuredClone(state), ctx, {
      ...input,
      csv: "source_row_id,name,account_number\nsource-1,Same name,0123456789",
    }),
  /Do not enter a full bank account number/,
  "Source rows are screened where the batch is saved, whatever route or key delivered them.",
);
let before = structuredClone(state);
let batch = saveImportBatch(state, ctx, input);
advanceRecordVersions(before, state, ctx.now);
assert.equal(batch.status, "ready");
assert.equal(batch.data.check.valid, 2);
assert.equal(
  state.records.filter((r) => r.kind === "customers").length,
  customersBefore,
  "Saving a batch does not ingest records.",
);
assert.equal("csv" in batchView(batch).data, false);
assert.equal("preview" in batchView(batch).data.check, false);
before = structuredClone(state);
batch = commitImportBatch(state, ctx, batch.id, batch.updatedAt);
advanceRecordVersions(before, state, ctx.now);
assert.equal(batch.status, "committed");
assert.equal(
  batch.data.check.imported,
  2,
  "Same-looking rows with distinct stable IDs must both be imported.",
);
assert.equal(new Set(batch.data.recordIds).size, 2);
assertFinalState(before, state, state.merchant.id, ctx.now);
// The batch list reads a plaintext summary of the check, so it never needs the
// protected source rows; a view that needs them refuses sealed ones loudly.
const summaryOf = (check: any) => ({ valid: check.valid, invalid: check.invalid, imported: check.imported, skipped: check.skipped });
assert.deepEqual(batch.data.checkSummary, summaryOf(batch.data.check), "A commit stores the new check's summary.");
{
  const sealed = { protectedPayload: 1 };
  const listed = structuredClone(batch);
  listed.data.check = sealed;
  assert.deepEqual(batchView(listed).data.check, summaryOf(batch.data.check), "The list uses the summary, not the sealed check.");
  delete listed.data.checkSummary;
  assert.throws(() => batchView(listed), (e: any) => e.status === 500, "A sealed check without a summary is refused, not listed as empty counts.");
  assert.equal(batchView(listed, false, "omit").data.check, undefined, "When the key service could not open it, the batch is listed without counts.");
  assert.deepEqual(batchView({ ...listed, data: { ...listed.data, check: batch.data.check } }, false, "omit").data.check, summaryOf(batch.data.check), "An open check still gives its counts.");
  const draft = saveImportBatch(structuredClone(state), ctx, { ...input, sourceBatchId: "sealed-draft" });
  assert.deepEqual(draft.data.checkSummary, summaryOf(draft.data.check), "A save stores its check's summary.");
  const sealedState = structuredClone(state);
  const unopened = saveImportBatch(sealedState, ctx, { ...input, sourceBatchId: "sealed-commit" });
  unopened.data.csv = sealed;
  assert.throws(
    () => commitImportBatch(sealedState, ctx, unopened.id, unopened.updatedAt),
    (e: any) => e.status === 500 && !(e instanceof ZodError),
    "Committing a batch whose rows were not opened is a server fault, not a validation failure or a source check.",
  );
}
const replay = saveImportBatch(state, ctx, {
  ...input,
  sourceBatchId: "feed-002",
});
assert.equal(
  replay.data.check.skipped,
  2,
  "A later upload recognises original source row IDs.",
);
assert.equal(replay.data.check.valid, 0);
const conflict = saveImportBatch(state, ctx, {
  ...input,
  sourceBatchId: "feed-003",
  csv: input.csv.replace("source-1,Same name", "source-1,Changed name"),
});
assert.equal(
  conflict.data.check.invalid,
  1,
  "The same identity cannot replace previously imported data.",
);
const unrelated = saveImportBatch(state, ctx, {
  ...input,
  source: "another-system",
  sourceBatchId: "feed-001",
});
assert.equal(
  unrelated.data.check.valid,
  2,
  "Source namespaces are independent.",
);
assert.throws(() => saveImportBatch(state, ctx, input), /already saved/);
assert.throws(
  () =>
    saveImportBatch(state, ctx, {
      ...input,
      sourceBatchId: "duplicates",
      csv: input.csv.replace("source-2", "source-1"),
    }),
  /different, non-empty/,
);
assert.throws(
  () =>
    saveImportBatch(
      state,
      { ...ctx, role: "Read-only" },
      { ...input, sourceBatchId: "blocked" },
    ),
  (e: any) => e.status === 403,
);

const invalid = saveImportBatch(state, ctx, {
  ...input,
  sourceBatchId: "correct-me",
  csv: "source_row_id,name,status,consentProvenance\nfix-1,Fix me,not-a-customer-status,Sample consent",
});
assert.equal(invalid.status, "needs_correction");
const oldVersion = invalid.updatedAt;
before = structuredClone(state);
const corrected = saveImportBatch(
  state,
  ctx,
  {
    ...input,
    sourceBatchId: "correct-me",
    csv: "source_row_id,name,status,consentProvenance\nfix-1,Fix me,active,Sample consent",
    expectedUpdatedAt: oldVersion,
  },
  invalid.id,
);
advanceRecordVersions(before, state, ctx.now);
assert.equal(corrected.status, "ready");
assert.notEqual(corrected.updatedAt, oldVersion);
assert.throws(
  () => commitImportBatch(state, ctx, invalid.id, oldVersion),
  (e: any) => e.status === 409,
);
assert.throws(
  () =>
    saveImportBatch(
      state,
      ctx,
      {
        ...input,
        sourceBatchId: "correct-me",
        csv: "source_row_id,name\nchanged-id,Fix me",
        expectedUpdatedAt: corrected.updatedAt,
      },
      corrected.id,
    ),
  /original source row IDs/,
);
const imported = state.records.find((r) => r.data.importIdentity)!;
assert.throws(
  () =>
    validateRecord(
      state,
      ctx,
      imported.kind,
      { ...imported, data: { ...imported.data, importIdentity: {} } },
      true,
    ),
  /Imported details change only through an import correction/,
);

const exception = state.records.find(
  (r) => r.kind === "exceptions" && r.status === "open",
)!;
const assignees = [
  { actor: ctx.actor, name: "Pilot administrator", role: "Admin" },
  { actor: "Clerk:user_B", name: "Finance colleague", role: "Finance" },
];
const caseInput = {
  action: "claim" as const,
  expectedUpdatedAt: exception.updatedAt,
  note: "Checked the source receipt.",
  nextAction: "Ask Finance to review the payment",
  nextActionAt: "2026-09-23T09:00:00.000Z",
  evidenceIds: [],
};
before = structuredClone(state);
coordinateCase(state, ctx, exception.id, caseInput, assignees);
advanceRecordVersions(before, state, ctx.now);
assert.equal(exception.data.case.assignee, ctx.actor);
assert.equal(exception.status, "in_progress");
assert.throws(
  () => coordinateCase(state, ctx, exception.id, caseInput, assignees),
  (e: any) => e.status === 409,
);
assert.throws(
  () =>
    coordinateCase(
      state,
      { ...ctx, actor: "Clerk:user_B", role: "Finance" },
      exception.id,
      { ...caseInput, expectedUpdatedAt: exception.updatedAt },
      assignees,
    ),
  /assigned to someone else/,
);
before = structuredClone(state);
coordinateCase(
  state,
  ctx,
  exception.id,
  {
    ...caseInput,
    action: "handover",
    assignee: "Clerk:user_B",
    expectedUpdatedAt: exception.updatedAt,
  },
  assignees,
);
advanceRecordVersions(before, state, ctx.now);
assert.equal(exception.data.case.assignee, "Clerk:user_B");
assert.equal(
  state.records.filter(
    (r) => r.kind === "case-events" && r.data.exceptionId === exception.id,
  ).length,
  2,
);
assert.equal(
  state.records.filter((r) => r.kind === "allocations").length,
  before.records.filter((r) => r.kind === "allocations").length,
  "A handover never makes a financial allocation.",
);
assert.throws(
  () =>
    coordinateCase(
      state,
      ctx,
      exception.id,
      {
        ...caseInput,
        expectedUpdatedAt: exception.updatedAt,
        evidenceIds: ["another-lender-record"],
      },
      assignees,
    ),
  /eligible record/,
);
assert.throws(
  () =>
    executeAction(
      state,
      { ...ctx, actor: "Clerk:user_C", role: "Operations" },
      {
        action: "resolve_exception",
        recordId: exception.id,
        reason: "Attempt to close someone else’s case.",
        data: { resolutionCode: "allocated" },
      },
    ),
  /Only the person this case is assigned to, or an Admin, can resolve this exception\./,
);
const otherCustomer = state.records.find(r => r.kind === 'customers' && r.id !== exception.customerId)!;
assert.ok(exception.customerId && otherCustomer);
assert.throws(() => coordinateCase(state,ctx,exception.id,{...caseInput,expectedUpdatedAt:exception.updatedAt,evidenceIds:[otherCustomer.id]},assignees),/another customer/);
before = structuredClone(state);
const event = state.records.find((r) => r.kind === "case-events")!;
event.data.note = "Tampered note";
assert.throws(
  () => assertFinalState(before, state, state.merchant.id, ctx.now),
  /Saved evidence cannot be changed\. Reload the page and try again\./,
);
assert.equal(
  recoverableRequest("POST", "/v1/actions", { action: "daily_close" }),
  true,
);
assert.equal(
  recoverableRequest("POST", "/v1/actions", { action: "set_role" }),
  false,
);
assert.equal(recoverableRequest("POST", "/v1/team/invitations", {}), false);
assert.equal(
  recoverableRequest("POST", "https://outside.example/write", {}),
  false,
);
console.log(
  "Pilot workflow domain checks passed: saved corrections, stable row identity, all-or-nothing imports, independent cases, stale edits and immutable evidence.",
);
