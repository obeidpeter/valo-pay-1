import { z } from "zod";
import { instantInputSchema, valopayRecordSchema } from "./api";
import { importKinds } from "./kinds";

const safeCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** Source money in currencies other than naira, by code: how many rows and their amount in that currency's minor unit, never added to a naira total. */
const otherCurrencies = z.record(z.object({ count: safeCount, amount: safeCount }));
/** A real calendar date, interpreted as the lender's WAT business date. */
export const businessDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => { const date = new Date(`${value}T00:00:00.000Z`); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value; }, "Enter a real business date as YYYY-MM-DD, for example 2026-09-18.");
/** An expected original source file, independently declared for one business date. */
export const expectedSourceFileSchema = z.object({ source: z.string().trim().min(1).max(100), sourceBatchId: z.string().trim().min(1).max(120), kind: z.enum(importKinds), expectedRows: safeCount.max(500), expectedAmountKobo: safeCount }).strict();
/** Each revision preserves its predecessor; missing expectations never mean complete. */
export const sourceManifestInputSchema = z.object({ businessDate: businessDateSchema, files: z.array(expectedSourceFileSchema).max(100), noFilesExpected: z.boolean(), reason: z.string().trim().min(10).max(3000), evidence: z.string().trim().min(5).max(1000), previousManifestId: z.string().min(1).max(100).optional(), expectedUpdatedAt: instantInputSchema.optional(), syntheticOnly: z.literal(true) }).strict().superRefine((value, context) => { if (value.noFilesExpected === Boolean(value.files.length)) context.addIssue({ code: z.ZodIssueCode.custom, message: "List the expected files, or explicitly declare that no files are expected." }); });
/** Validated date-specific source declaration. */
export type SourceManifestInput = z.infer<typeof sourceManifestInputSchema>;
/** Date-specific completeness evidence exposed to operators and frozen in a close. */
export const sourceCompletenessSchema = z.object({
  businessDate: businessDateSchema, manifest: z.object({ id: z.string(), updatedAt: z.string().datetime(), data: z.record(z.unknown()) }).nullable(),
  files: z.array(expectedSourceFileSchema.extend({ id: z.string(), batchId: z.string().nullable(), batchStatus: z.string(), businessDate: businessDateSchema.nullable(), receivedRows: safeCount.nullable(), receivedAmountKobo: safeCount.nullable(), receivedOtherCurrencies: otherCurrencies.optional(), status: z.enum(["complete", "incomplete"]), problems: z.array(z.string()) })),
  activeProfiles: z.array(z.object({ id: z.string(), source: z.string(), kind: z.string() })),
  undeclared: z.array(z.object({ id: z.string(), name: z.string(), status: z.string(), source: z.string(), sourceBatchId: z.string(), kind: z.string() })),
  status: z.enum(["complete", "incomplete"]), issues: z.array(z.object({ id: z.string(), label: z.string(), detail: z.string() })), basisDigest: z.string().regex(/^[a-f0-9]{64}$/), expectedFiles: safeCount, completeFiles: safeCount,
});
/** Reusable synthetic import contract; cadence uses elapsed UTC hours, not browser time. */
export const sourceProfileInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  source: z.string().trim().min(1).max(100),
  kind: z.enum(importKinds),
  mapping: z.record(z.string().max(100)).default({}),
  identityColumn: z.string().trim().min(1).max(100),
  amountUnit: z.enum(["naira", "kobo"]),
  firstExpectedAt: instantInputSchema,
  cadenceHours: z.number().int().min(1).max(8760),
  graceMinutes: z.number().int().min(0).max(10080),
  expectedRows: safeCount.max(500).nullable().default(null),
  expectedAmountKobo: safeCount.nullable().default(null),
  status: z.enum(["active", "paused"]).default("active"),
  syntheticOnly: z.literal(true),
  expectedUpdatedAt: instantInputSchema.optional(),
}).strict();
/** Validated reusable mapping and delivery expectation. */
export type SourceProfileInput = z.infer<typeof sourceProfileInputSchema>;
/**
 * Quality totals preserve the distinction between source rows and newly imported rows. Each amount total sums naira
 * only (a row that names no currency is naira); money in another currency is listed beside it, present only when there is some.
 */
export const sourceBatchQualitySchema = z.object({
  profileId: z.string().nullable(), profileVersion: z.string().nullable(),
  sourceRows: safeCount, sourceAmountKobo: safeCount.nullable(), sourceOtherCurrencies: otherCurrencies.optional(),
  importedRows: safeCount, importedAmountKobo: safeCount.nullable(), importedOtherCurrencies: otherCurrencies.optional(),
  duplicateRows: safeCount, conflictRows: safeCount, invalidRows: safeCount,
  status: z.enum(["checked", "needs_review", "unavailable"]),
  issues: z.array(z.string()),
});
/** Checked, safe-integer source and ingestion totals. */
export type SourceBatchQuality = z.infer<typeof sourceBatchQualitySchema>;
/** Fixed fixtures exercise ordering and conflicts without accepting caller-crafted provider data. */
export const paystackFixtureInputSchema = z.object({
  scenario: z.enum(["payment", "duplicate", "amount_mismatch", "out_of_order", "tampered"]),
  syntheticOnly: z.literal(true),
}).strict();
/** Explicit replay never overwrites evidence or bypasses quarantine. */
export const providerReplayInputSchema = z.object({
  expectedUpdatedAt: instantInputSchema, reason: z.string().trim().min(3).max(500),
}).strict();
/** A stored provider event as the sources page lists it: its mode, deliveries and replays, and that it created no financial record. Routing and the provider payload stay private. */
export const providerEventViewSchema = z.object({
  id: z.string(), name: z.string(), status: z.string(), reference: z.string(), amountKobo: safeCount, createdAt: z.string(), updatedAt: z.string(),
  mode: z.enum(["fixture", "test"]), message: z.string(), deliveryCount: safeCount, replayCount: safeCount, financialRecordsCreated: z.literal(0),
}).strict();
/** Where a source profile stands against its cadence: missed deliveries, the next expected time and the last committed batch. */
export const sourceDeliverySchema = z.object({
  status: z.enum(["paused", "late", "on_schedule", "awaiting_first_delivery"]), missedDeliveries: safeCount, nextExpectedAt: z.string(),
  lastCommittedAt: z.string().nullable(), lastBatchId: z.string().nullable(),
}).strict();
/** A source profile record with its delivery state. */
export const sourceProfileViewSchema = valopayRecordSchema.extend({ delivery: sourceDeliverySchema }).strict();
/** A batch as the sources page lists it, with its original quality totals. */
export const sourceBatchSummarySchema = z.object({ id: z.string(), name: z.string(), source: z.string(), sourceBatchId: z.string(), kind: z.string(), status: z.string(), createdAt: z.string(), quality: sourceBatchQualitySchema }).strict();
/** Counts that need attention: late sources, duplicate and conflicting rows, batches needing review. */
export const sourceSummarySchema = z.object({ lateSources: safeCount, duplicateRows: safeCount, conflictRows: safeCount, batchesNeedingReview: safeCount }).strict();
/** The read-only Paystack test inbox: its fixed test-only state, the 50 newest stored events and how many were quarantined or delivered again. */
export const paystackInboxSchema = z.object({
  mode: z.literal("test_only"), externalConnectionVerified: z.literal(false), canRunFixtures: z.boolean(), state: z.literal("configuration_required"), message: z.string(),
  events: z.array(providerEventViewSchema).max(50), total: safeCount, quarantined: safeCount, duplicates: safeCount,
}).strict();
/** Everything the sources page shows for one lender and business date. */
export const sourcesViewSchema = z.object({ completeness: sourceCompletenessSchema, profiles: z.array(sourceProfileViewSchema), batches: z.array(sourceBatchSummarySchema), summary: sourceSummarySchema, paystack: paystackInboxSchema }).strict();
/** Whether a recorded Paystack scenario was accepted or recognised as a repeat delivery, and the stored event. */
export const paystackFixtureResultSchema = z.object({ accepted: z.boolean(), duplicate: z.boolean(), event: providerEventViewSchema }).strict();
