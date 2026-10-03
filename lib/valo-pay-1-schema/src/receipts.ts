import { z } from "zod";
import { merchantSchema, recordDataSchema, valopayRecordSchema } from "./api";

/*
 * The confirmations the record API's writes answer: an action's result, an
 * import, the lender's settings and an export job (a saved record is
 * valopayRecordSchema). The contract describes the same components by hand,
 * and scripts/create-valo-pay-1-spec.cjs checks each of these against its
 * component field for field, so the console can check a write's answer with
 * them instead of loading the whole generated contract (lib/api-zod).
 */

const count = z.number().int();

/** What an action did, in words, with the record it produced or changed and any data it returns (ActionResult). */
export const actionResultSchema = z.object({
  message: z.string(), record: valopayRecordSchema.optional(), data: recordDataSchema,
}).strict();

/** The outcome of one imported row, and an invalid row's problems in the record API's words (ImportRow). */
export const importRowSchema = z.object({ row: count, status: z.string(), message: z.string(), detail: z.string().optional() }).strict();

/** How many rows were valid, invalid and imported, each row's outcome, a check's columns and preview, and its warnings (ImportResult). */
export const importResultSchema = z.object({
  valid: count, invalid: count, imported: count, rows: z.array(importRowSchema),
  columns: z.array(z.string()).optional(),
  preview: z.array(z.object({ row: count, values: recordDataSchema, amountKobo: count.optional() }).strict()).optional(),
  skipped: count.optional(),
  /** A name or reference that came from a fallback while a column went unused, one sentence each; commit is not refused. */
  warnings: z.array(z.string()).optional(),
}).strict();

/** The lender's close schedule as it runs: when, whether automatic, and what the close service is doing (EffectiveCloseSchedule). */
export const effectiveCloseScheduleSchema = z.object({
  time: z.string(), enabled: z.boolean(), automatic: z.boolean(), nextAt: z.string().nullable(),
  runtimeState: z.enum(["not_started", "running", "off", "external", "stopped"]),
  serviceIssue: z.enum(["starting", "delayed", "failed"]).nullable(),
  missed: z.boolean(), overdueMinutes: count, lateAfterMinutes: count,
  lastAt: z.string().nullable(), lastTrigger: z.string().nullable(), lastCheckedAt: z.string().nullable(), lastErrorAt: z.string().nullable(),
  failedAttempts: count.optional(), retryAt: z.string().nullable().optional(), pausedForInactivityAt: z.string().nullable().optional(),
}).strict();

/** A lender's settings and the caller's permissions, with integrations, members, the business calendar and the close schedule (Settings). */
export const settingsViewSchema = z.object({
  merchant: merchantSchema, settings: recordDataSchema, permissions: recordDataSchema,
  integrations: z.array(valopayRecordSchema), members: z.array(valopayRecordSchema), calendar: z.array(valopayRecordSchema),
  closeSchedule: effectiveCloseScheduleSchema.optional(), revision: z.string().optional(),
}).strict();

/** A saved export job's identity, status and retry details; checksum, generation time and size once it is ready; expiredAt, the time an approved retention run deleted its file, once one has, never a scheduled expiry, and retentionRunId, that run, which holds the deletion receipt (ExportResult). */
export const exportResultSchema = z.object({
  id: z.string(), downloadUrl: z.string(),
  status: z.enum(["queued", "running", "ready", "failed"]).optional(),
  stage: z.enum(["queued", "checking", "rendering", "uploading", "confirming", "ready", "failed"]).optional(),
  lastProgressAt: z.string().optional(), stalled: z.boolean().optional(), retryAllowed: z.boolean().optional(),
  recoveryAt: z.string().optional(), expiredAt: z.string().optional(), retentionRunId: z.string().optional(), kind: z.string().optional(), format: z.string().optional(),
  customerId: z.string().optional(), requestedAt: z.string().optional(), attempts: count.optional(), checksum: z.string().optional(),
  generatedAt: z.string().optional(), byteLength: count.optional(), generationMs: count.optional(), error: z.string().optional(),
}).strict();
/** A saved export job as the export routes answer it. */
export type ExportResultView = z.infer<typeof exportResultSchema>;
