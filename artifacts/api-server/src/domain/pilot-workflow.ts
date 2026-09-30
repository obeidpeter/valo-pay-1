import { parse } from "csv-parse/sync";
import {
  batchInputSchema,
  caseInputSchema,
  changedText,
  notFoundText,
  type BatchInput,
  type CaseInput,
} from "@workspace/valopay-schema";
import { roleRefusal } from "./validation";
import type { Context, DomainState, ValopayRecord } from "./types";
import { makeRecord, assertNoRealBankDetails, assertSourceOpened, isSealedPayload } from "./records";
import { assertRecordVersion } from "../lib/edit-versions";
import { importCsv, sourceRowIds } from "../lib/valopay-import";
import { batchSourceQuality, assertSourceBatchReady } from './source-quality';
import { assertSourceExpectation } from './source-completeness';

function refuse(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}
function writer(ctx: Context, allowed = ["Admin", "Operations", "Finance"], action = "save or import a batch") {
  if (!allowed.includes(ctx.role))
    refuse(roleRefusal(ctx, allowed, action), 403);
}
/** The check's counts, stored in plaintext beside the protected check so the batch list never opens it. */
const checkSummaryOf = (check: { valid: number; invalid: number; imported: number; skipped: number }) => ({
  valid: check.valid,
  invalid: check.invalid,
  imported: check.imported,
  skipped: check.skipped,
});
/**
 * A batch as the list or its detail shows it. `sealedCheck` is what the list
 * does with a check that is still sealed and has no summary (a batch saved
 * before summaries were stored): "refuse" (500) when the route should have
 * opened it, "omit" when the key service could not, so the batch is listed
 * without counts instead of failing the whole list.
 */
export function batchView(batch: ValopayRecord, detail = false, sealedCheck: "refuse" | "omit" = "refuse") {
  return {
    ...batch,
    data: detail
      ? batch.data
      : {
          source: batch.data.source,
          sourceBatchId: batch.data.sourceBatchId,
          businessDate: batch.data.businessDate,
          sourceExpectationId: batch.data.sourceExpectationId,
          kind: batch.data.kind,
          revision: batch.data.revision,
          checkedAt: batch.data.checkedAt,
          committedAt: batch.data.committedAt,
          synthetic: true,
          sourceQuality: batch.data.sourceQuality,
          // Batches saved before the summary existed open their check for the list.
          check:
            batch.data.checkSummary ??
            (sealedCheck === "omit" && isSealedPayload(batch.data.check)
              ? undefined
              : (assertSourceOpened(batch, ["check"]), {
                  valid: batch.data.check?.valid,
                  invalid: batch.data.check?.invalid,
                  imported: batch.data.check?.imported,
                  skipped: batch.data.check?.skipped,
                })),
        },
  };
}
function rowIdentities(input: BatchInput): string[] {
  let rows: Record<string, string>[];
  try {
    rows = parse(input.csv, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      max_record_size: 20000,
    });
  } catch {
    refuse("Valo Pay could not read this CSV file. Use a header row, the same number of columns on every row, and quotes around values that contain commas.");
  }
  // The rows are screened here, where every batch is saved, not only where a
  // recoverable request carries a key.
  try {
    assertNoRealBankDetails(rows);
  } catch (error) {
    refuse(error instanceof Error ? error.message : "Valo Pay could not check the rows in this file.");
  }
  if (
    !rows.length ||
    rows.length > 500 ||
    Buffer.byteLength(input.csv) > 1500000
  )
    refuse("A file must have between 1 and 500 rows and be no larger than 1.5 MB.");
  // The quick import's rule: a different, non-empty ID on every row, up to 160 characters.
  return sourceRowIds(rows, input.identityColumn, Object.keys(rows[0]!));
}
export function saveImportBatch(
  state: DomainState,
  ctx: Context,
  input: BatchInput,
  id?: string,
) {
  writer(ctx);
  input = batchInputSchema.parse(input);
  assertSourceExpectation(state, input);
  const old = id
    ? state.records.find((r) => r.id === id && r.kind === "import-batches")
    : undefined;
  if (id && !old) refuse(notFoundText("import batch"), 404);
  if (old) {
    if (!input.expectedUpdatedAt)
      refuse(changedText("import batch"), 409);
    assertRecordVersion(old, input.expectedUpdatedAt);
    if (old.status === "committed")
      refuse(
        "This batch is already imported. Start a new batch for new records.",
        409,
      );
    if (
      old.data.source !== input.source ||
      old.data.sourceBatchId !== input.sourceBatchId ||
      old.data.kind !== input.kind
    )
      refuse("Keep this batch’s data source, source batch ID and record type.");
  }
  const existing = state.records.find(
    (r) =>
      r.kind === "import-batches" &&
      r.id !== id &&
      r.data.source === input.source &&
      r.data.sourceBatchId === input.sourceBatchId &&
      r.data.kind === input.kind,
  );
  if (existing)
    refuse(
      "This batch is already saved. Open it from Import batches to continue.",
      409,
    );
  const ids = rowIdentities(input);
  if (
    old &&
    JSON.stringify([...old.data.rowIds].sort()) !==
      JSON.stringify([...ids].sort())
  )
    refuse(
      "Keep the original source row IDs when you correct this batch. Use a new batch for new records.",
    );
  // The identity column is metadata. It must not become arbitrary record data.
  const mapping = {
    ...input.mapping,
    [input.identityColumn]:
      input.mapping[input.identityColumn] ??
      (["reference", "eventId"].includes(input.identityColumn)
        ? input.identityColumn
        : ""),
  };
  const current =
    old ||
    makeRecord(state, "import-batches", {
      name: input.name,
      status: "draft",
      createdAt: ctx.now,
    });
  const check = importCsv(state, ctx, {
    ...input,
    mapping,
    commit: false,
    identities: { source: input.source, batchId: current.id, ids },
  });
  const revision = Number(current.data.revision || 0) + 1;
  current.name = input.name;
  current.status = check.invalid ? "needs_correction" : "ready";
  current.data = {
    ...input,
    mapping,
    rowIds: ids,
    revision,
    checkedBy: ctx.actor,
    checkedAt: ctx.now,
    check,
    checkSummary: checkSummaryOf(check),
    synthetic: true,
  };
  delete current.data.expectedUpdatedAt;
  current.data.sourceQuality = batchSourceQuality(state, current);
  makeRecord(state, "import-revisions", {
    name: `Import batch version ${revision}`,
    status: "recorded",
    createdAt: ctx.now,
    data: {
      batchId: current.id,
      revision,
      actor: ctx.actor,
      mapping,
      amountUnit: input.amountUnit,
      valid: check.valid,
      invalid: check.invalid,
      skipped: check.skipped,
    },
  });
  return current;
}
export function commitImportBatch(
  state: DomainState,
  ctx: Context,
  id: string,
  expectedUpdatedAt: string,
) {
  writer(ctx);
  const batch = state.records.find(
    (r) => r.id === id && r.kind === "import-batches",
  );
  if (!batch) refuse(notFoundText("import batch"), 404);
  assertRecordVersion(batch, expectedUpdatedAt);
  if (batch.status === "committed") return batch;
  assertSourceOpened(batch, ["csv", "check"]);
  assertSourceBatchReady(state, batch);
  const input = batchInputSchema.parse({
    ...Object.fromEntries(
      [
        "name",
        "kind",
        "source",
        "sourceBatchId",
        "businessDate",
        "sourceExpectationId",
        "csv",
        "mapping",
        "amountUnit",
        "identityColumn",
        "syntheticOnly",
      ].map((key) => [key, key === "name" ? batch.name : batch.data[key]]),
    ),
  });
  const before = new Set(state.records.map((r) => r.id));
  const result = importCsv(state, ctx, {
    ...input,
    commit: true,
    identities: {
      source: input.source,
      batchId: batch.id,
      ids: batch.data.rowIds,
    },
  });
  // importCsv swaps a working clone on commit; update the stored clone.
  const saved = state.records.find((r) => r.id === batch.id)!;
  saved.data.check = result;
  saved.data.checkSummary = checkSummaryOf(result);
  saved.data.checkedAt = ctx.now;
  saved.status = result.invalid ? "needs_correction" : "committed";
  if (!result.invalid)
    Object.assign(saved.data, {
      committedAt: ctx.now,
      committedBy: ctx.actor,
      recordIds: state.records
        .filter((r) => !before.has(r.id))
        .map((r) => r.id),
    });
  saved.data.sourceQuality = batchSourceQuality(state, saved);
  return saved;
}
export function coordinateCase(
  state: DomainState,
  ctx: Context,
  id: string,
  input: CaseInput,
  assignees: Array<{ actor: string; name: string; role: string }>,
) {
  writer(ctx, ["Admin", "Operations", "Finance", "Compliance reviewer"], "work on cases");
  input = caseInputSchema.parse(input);
  const record = state.records.find(
    (r) => r.id === id && r.kind === "exceptions",
  );
  if (!record) refuse(notFoundText("exception"), 404);
  assertRecordVersion(record, input.expectedUpdatedAt);
  if (["resolved", "closed"].includes(record.status))
    refuse(
      "This exception is already resolved. Its handover history is kept.",
      409,
    );
  const prior = record.data.case || {};
  if (prior.assignee && prior.assignee !== ctx.actor && ctx.role !== "Admin")
    refuse(
      "This case is assigned to someone else. Ask them or an Admin to hand it over.",
      409,
    );
  const target =
    input.action === "claim"
      ? ctx.actor
      : input.action === "handover"
        ? input.assignee
        : prior.assignee;
  if (input.action === "update" && !prior.assignee)
    refuse("Claim this case before you record its next step.", 409);
  const assignee = assignees.find((person) => person.actor === target);
  if (!assignee) refuse("Choose an active team member who can work on cases.");
  if (Date.parse(input.nextActionAt) <= Date.parse(ctx.now))
    refuse(
      "Set the next step for a future time. The exception’s original deadline stays visible.",
    );
  const evidence = [...new Set(input.evidenceIds)];
  for (const evidenceId of evidence) {
    const linked = state.records.find(
      (item) => item.id === evidenceId && item.merchantId === state.merchant.id,
    );
    if (
      !linked ||
      ![
        "customers",
        "mandates",
        "due-items",
        "attempts",
        "payments",
        "observations",
        "allocations",
        "settlement-batches",
        "evidence",
        "closes",
        "exports",
        "policies",
        "notifications",
      ].includes(linked.kind)
    )
      refuse(
        "Link evidence only to this lender’s records.",
      );
    const linkedCustomer = linked.kind === 'customers' ? linked.id : linked.customerId;
    if (record.customerId && linkedCustomer && record.customerId !== linkedCustomer)
      refuse("This evidence belongs to another customer.");
  }
  const next = {
    assignee: assignee.actor,
    assigneeName: assignee.name,
    nextAction: input.nextAction,
    nextActionAt: input.nextActionAt,
    evidenceIds: evidence,
  };
  record.data.case = next;
  record.status = "in_progress";
  const event = makeRecord(state, "case-events", {
    name: `${input.action === "claim" ? "Case claimed" : input.action === "handover" ? "Case handed over" : "Next action updated"}`,
    status: "recorded",
    customerId: record.customerId,
    createdAt: ctx.now,
    data: {
      exceptionId: record.id,
      actor: ctx.actor,
      action: input.action,
      note: input.note,
      before: prior,
      after: next,
    },
  });
  record.data.case = { ...next, eventId: event.id, handoverEventId: input.action === 'update' ? prior.handoverEventId : event.id };
  return record;
}
