import {
  importBatchDetailSchema,
  importBatchListSchema,
  importKinds,
  importResultSchema,
  recordDataSchemas,
  sourceCompletenessSchema,
  valopayRecordSchema,
  type BatchInput,
} from "@workspace/valo-pay-1-schema";
import { z } from "zod";

/** Detail and write receipts contain opened checks; list responses deliberately contain only their counts. */
const batchFields = recordDataSchemas["import-batches"].extend({
  kind: z.enum(importKinds),
  source: z.string(),
  sourceBatchId: z.string(),
  mapping: z.record(z.string()),
  amountUnit: z.enum(["naira", "kobo"]),
  identityColumn: z.string(),
  syntheticOnly: z.literal(true),
  // Retention may remove the original file while leaving the batch and its evidence accessible.
  csv: z.string().optional(),
  check: importResultSchema.optional(),
});
export const importBatchRecordSchema = valopayRecordSchema.extend({
  kind: z.literal("import-batches"),
  data: batchFields,
});
const batchSummaryRecordSchema = valopayRecordSchema.extend({
  kind: z.literal("import-batches"),
  data: recordDataSchemas["import-batches"].extend({
    // Older sealed batches can omit their check when the key service is unavailable.
    check: importResultSchema
      .pick({ valid: true, invalid: true, imported: true, skipped: true })
      .partial()
      .optional(),
  }),
});
const revisionRecordSchema = valopayRecordSchema.extend({
  kind: z.literal("import-revisions"),
  data: recordDataSchemas["import-revisions"],
});
export const batchListSchema = importBatchListSchema.extend({
  items: z.array(batchSummaryRecordSchema).max(25),
});
export const batchDetailSchema = importBatchDetailSchema.extend({
  batch: importBatchRecordSchema,
  revisions: z.array(revisionRecordSchema),
});

export type ImportBatch = z.infer<typeof importBatchRecordSchema>;
export type ImportCheck = z.infer<typeof importResultSchema>;
export type ImportRevision = z.infer<typeof revisionRecordSchema>;
export type ExpectedSourceFile = z.infer<
  typeof sourceCompletenessSchema
>["files"][number];
export type SetBatchField = <K extends keyof BatchInput>(
  key: K,
  value: BatchInput[K],
) => void;

/** Copy only the editable batch fields. Saved evidence and storage metadata never become form input. */
export function batchFormInput(record: ImportBatch): BatchInput {
  const data = record.data;
  return {
    name: record.name,
    kind: data.kind,
    source: data.source,
    sourceBatchId: data.sourceBatchId,
    businessDate: data.businessDate,
    sourceExpectationId: data.sourceExpectationId,
    identityColumn: data.identityColumn,
    amountUnit: data.amountUnit,
    mapping: data.mapping,
    csv: data.csv || "",
    syntheticOnly: data.syntheticOnly,
    expectedUpdatedAt: record.updatedAt,
  };
}
