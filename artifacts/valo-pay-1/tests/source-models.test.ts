import { describe, expect, it } from "vitest";
import {
  consoleSourceProfileSchema,
  consoleSourcesViewSchema,
  sourceProfileRecordSchema,
} from "@/lib/source-models";

const profile = () => ({
  id: "source-profile-1",
  merchantId: "sample-lender",
  kind: "source-profiles",
  name: "Loan system feed",
  status: "active",
  reference: "",
  amountKobo: 0,
  customerId: "",
  createdAt: "2026-09-29T07:00:00.000Z",
  updatedAt: "2026-09-29T07:00:00.000Z",
  data: {
    source: "loan-system",
    kind: "customers",
    mapping: { customer_name: "name" },
    amountUnit: "naira",
    identityColumn: "source_row_id",
  },
});
const delivery = {
  status: "awaiting_first_delivery",
  missedDeliveries: 0,
  nextExpectedAt: "2026-09-30T07:00:00.000Z",
  lastCommittedAt: null,
  lastBatchId: null,
};
const view = () => ({
  profiles: [{ ...profile(), delivery }],
  completeness: {
    businessDate: "2026-09-29",
    manifest: null,
    files: [],
    activeProfiles: [],
    undeclared: [],
    status: "incomplete",
    issues: [],
    basisDigest: "a".repeat(64),
    expectedFiles: 0,
    completeFiles: 0,
  },
  batches: [{
    id: "retained-batch",
    name: "Retained source evidence",
    source: "loan-system",
    sourceBatchId: "file-1",
    kind: "customers",
    status: "committed",
    createdAt: "2026-09-29T07:00:00.000Z",
    quality: {
      profileId: null,
      profileVersion: null,
      sourceRows: 4,
      sourceAmountKobo: null,
      importedRows: 3,
      importedAmountKobo: null,
      duplicateRows: 1,
      conflictRows: 0,
      invalidRows: 0,
      status: "unavailable",
      issues: ["The original source totals were not retained."],
    },
  }],
  summary: { lateSources: 0, duplicateRows: 1, conflictRows: 0, batchesNeedingReview: 1 },
  paystack: {
    mode: "test_only",
    externalConnectionVerified: false,
    canRunFixtures: true,
    state: "configuration_required",
    message: "External connection not verified.",
    events: [{
      id: "sample-event",
      name: "Sample receipt",
      status: "awaiting_verification",
      reference: "sample-reference",
      amountKobo: 1250,
      createdAt: "2026-09-29T07:00:00.000Z",
      updatedAt: "2026-09-29T07:00:00.000Z",
      mode: "fixture",
      message: "Fixed local sample event.",
      deliveryCount: 1,
      replayCount: 0,
      financialRecordsCreated: 0,
    }],
    total: 1,
    quarantined: 0,
    duplicates: 0,
  },
});

describe("shared source response models", () => {
  it("reads older profiles without inventing optional scheduling or synthetic fields", () => {
    const answer = consoleSourcesViewSchema.parse(view());
    expect(answer.profiles[0]?.data.mapping).toEqual({ customer_name: "name" });
    expect(answer.profiles[0]?.data.firstExpectedAt).toBeUndefined();
    expect(answer.profiles[0]?.data.expectedRows).toBeUndefined();
    expect(answer.profiles[0]?.data.syntheticOnly).toBeUndefined();
    expect(answer.profiles[0]?.delivery.lastCommittedAt).toBeNull();
  });

  it("accepts profile save receipts without requiring list-only delivery state", () => {
    const saved = profile();
    expect(sourceProfileRecordSchema.safeParse(saved).success).toBe(true);
    expect(consoleSourceProfileSchema.safeParse(saved).success).toBe(false);
    expect(consoleSourceProfileSchema.safeParse({ ...saved, delivery }).success).toBe(true);
  });

  it("refuses unreadable mappings and unsupported record types before they reach either editor", () => {
    const saved = profile();
    for (const data of [
      { ...saved.data, mapping: { customer_name: 42 } },
      { ...saved.data, kind: "payments" },
      { ...saved.data, amountUnit: "pounds" },
    ]) {
      expect(sourceProfileRecordSchema.safeParse({ ...saved, data }).success).toBe(false);
      expect(consoleSourcesViewSchema.safeParse({
        ...view(), profiles: [{ ...saved, data, delivery }],
      }).success).toBe(false);
    }
    expect(sourceProfileRecordSchema.safeParse({ ...saved, kind: "customers" }).success).toBe(false);
  });

  it("preserves unavailable legacy batch totals without requiring original files or currency breakdowns", () => {
    const answer = consoleSourcesViewSchema.parse(view());
    expect(answer.batches[0]?.quality).toMatchObject({
      sourceRows: 4,
      importedRows: 3,
      sourceAmountKobo: null,
      importedAmountKobo: null,
      status: "unavailable",
    });
    expect(answer.batches[0]?.quality.sourceOtherCurrencies).toBeUndefined();
    expect(answer.batches[0]?.quality.importedOtherCurrencies).toBeUndefined();
  });

  it("keeps each currency's totals separate from naira totals", () => {
    const source = view();
    const batch = source.batches[0]!;
    const answer = consoleSourcesViewSchema.parse({
      ...source,
      batches: [{
        ...batch,
        quality: {
          ...batch.quality,
          sourceAmountKobo: 1250,
          sourceOtherCurrencies: { USD: { count: 1, amount: 300 } },
          importedAmountKobo: 1250,
          importedOtherCurrencies: { USD: { count: 1, amount: 300 } },
        },
      }],
    });
    expect(answer.batches[0]?.quality.sourceAmountKobo).toBe(1250);
    expect(answer.batches[0]?.quality.sourceOtherCurrencies?.USD).toEqual({ count: 1, amount: 300 });
  });

  it("refuses live or malformed provider receipts instead of displaying them as test evidence", () => {
    const source = view();
    const receipt = source.paystack.events[0]!;
    for (const change of [
      { mode: "live" },
      { deliveryCount: "1" },
      { replayCount: -1 },
      { financialRecordsCreated: 1 },
    ]) {
      expect(consoleSourcesViewSchema.safeParse({
        ...source,
        paystack: { ...source.paystack, events: [{ ...receipt, ...change }] },
      }).success).toBe(false);
    }
  });
});
