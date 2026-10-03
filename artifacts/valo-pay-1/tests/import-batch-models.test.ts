import { describe, expect, it } from "vitest";
import {
  batchDetailSchema,
  batchFormInput,
  batchListSchema,
  importBatchRecordSchema,
} from "@/features/imports/models";

const batch = () => ({
  id: "sample-batch",
  merchantId: "sample-lender",
  kind: "import-batches",
  name: "Saved sample",
  status: "ready",
  reference: "",
  amountKobo: 0,
  customerId: "",
  createdAt: "2026-09-29T10:00:00.000Z",
  updatedAt: "2026-09-29T10:00:00.000Z",
  data: {
    kind: "customers",
    source: "Loan system",
    sourceBatchId: "sample-file",
    revision: 1,
    businessDate: "2026-09-29",
    csv: "source_row_id,name\nrow-1,Sample",
    mapping: { source_row_id: "" },
    amountUnit: "naira",
    identityColumn: "source_row_id",
    syntheticOnly: true,
    check: {
      valid: 1,
      invalid: 0,
      imported: 0,
      skipped: 0,
      rows: [{ row: 2, status: "valid", message: "Ready." }],
    },
  },
});

describe("import batch response models", () => {
  it("accepts count-only list summaries without treating them as opened detail or write receipts", () => {
    const record = batch();
    const summary = {
      ...record,
      data: {
        source: record.data.source,
        sourceBatchId: record.data.sourceBatchId,
        kind: record.data.kind,
        revision: 1,
        check: { valid: 1, invalid: 0, imported: 0, skipped: 0 },
      },
    };
    expect(
      batchListSchema.safeParse({ items: [summary], total: 1, offset: 0 })
        .success,
    ).toBe(true);
    expect(
      batchDetailSchema.safeParse({ batch: summary, revisions: [] }).success,
    ).toBe(false);
    expect(
      importBatchRecordSchema.safeParse({
        ...record,
        data: { ...record.data, check: summary.data.check },
      }).success,
    ).toBe(false);
  });

  it("keeps a legacy list available when opening its sealed check was not possible", () => {
    const record = batch();
    const summary = {
      ...record,
      data: {
        source: record.data.source,
        sourceBatchId: record.data.sourceBatchId,
        kind: record.data.kind,
        revision: 1,
      },
    };
    expect(
      batchListSchema.safeParse({ items: [summary], total: 1, offset: 0 })
        .success,
    ).toBe(true);
  });

  it("retains saved evidence when retention removed the CSV and an older batch has no business date", () => {
    const record = batch();
    const { csv: _csv, businessDate: _businessDate, ...retained } = record.data;
    const saved = importBatchRecordSchema.parse({
      ...record,
      status: "committed",
      data: { ...retained, rawCsvRemovedAt: "2026-09-29T11:00:00.000Z" },
    });
    expect(saved.data.check?.rows).toHaveLength(1);
    expect(batchFormInput(saved)).toMatchObject({
      csv: "",
      businessDate: undefined,
      expectedUpdatedAt: saved.updatedAt,
    });
    expect(batchFormInput(saved)).not.toHaveProperty("check");
    expect(batchFormInput(saved)).not.toHaveProperty("rawCsvRemovedAt");
  });

  it("refuses malformed row checks instead of making them editable or confirmed", () => {
    const record = batch();
    const unreadable = {
      ...record,
      data: {
        ...record.data,
        check: {
          ...record.data.check,
          rows: [{ row: "2", status: "valid", message: "Ready." }],
        },
      },
    };
    expect(
      batchDetailSchema.safeParse({ batch: unreadable, revisions: [] }).success,
    ).toBe(false);
    expect(importBatchRecordSchema.safeParse(unreadable).success).toBe(false);
  });
});
