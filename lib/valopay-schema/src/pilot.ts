import { z } from "zod";
import { assigneeSchema, instantInputSchema, merchantSchema, valopayRecordSchema } from "./api";
import { importKinds } from "./kinds";
import { businessDateSchema } from "./source-quality";

/** HTTP statuses the service treats as a definitive refusal: the same request would be refused again, so its operations-journal entry is cancelled and its key cannot run again. A money calculation the request needs that cannot be done exactly within the supported limits (422) is one. */
export const definitiveRefusalStatuses = [400, 403, 404, 409, 410, 413, 415, 422] as const;
/** Roles granted by a provisioned pilot administrator, never a browser persona. */
export const pilotRoleSchema = z.enum([
  "Admin",
  "Operations",
  "Finance",
  "Compliance reviewer",
  "Read-only",
]);
/** Export kinds that carry a customer's history or the audit trail (the export_sensitive rule): dispute packs under either name, the customer register and the audit chain. */
export const sensitiveExportKinds = ["dispute-pack", "customer-pack", "customers", "audit"] as const;
/** The roles that may queue, retry or download a sensitive export. */
export const sensitiveExportRoles = ["Admin", "Finance", "Compliance reviewer"] as const;
/** Whether a role may queue, retry or download an export of this kind: any role for other kinds, only `sensitiveExportRoles` for `sensitiveExportKinds`. */
export function exportPermitted(role: string, kind: string): boolean {
  return !(sensitiveExportKinds as readonly string[]).includes(kind) || (sensitiveExportRoles as readonly string[]).includes(role);
}
/** The refusal, in plain words, for a role that may not queue, retry or download a sensitive export. */
export const sensitiveExportRefusal = "Only an Admin, Finance or Compliance reviewer can export or download dispute packs, customer records or the audit log.";
/** Saved synthetic source batch, including the current revision for corrections. */
export const batchInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(importKinds),
    source: z.string().trim().min(1).max(100),
    sourceBatchId: z.string().trim().min(1).max(120),
    businessDate: businessDateSchema.optional(),
    sourceExpectationId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    csv: z.string().min(1).max(1_500_000),
    mapping: z.record(z.string().max(100)).default({}),
    amountUnit: z.enum(["naira", "kobo"]),
    identityColumn: z.string().trim().min(1).max(100),
    syntheticOnly: z.literal(true),
    expectedUpdatedAt: instantInputSchema.optional(),
  })
  .strict();
/** Validated saved-batch input. */
export type BatchInput = z.infer<typeof batchInputSchema>;
/** Named case coordination, with a reviewed version and linked lender evidence. */
export const caseInputSchema = z
  .object({
    action: z.enum(["claim", "handover", "update"]),
    expectedUpdatedAt: instantInputSchema,
    assignee: z.string().max(256).optional(),
    note: z.string().trim().min(3).max(2000),
    nextAction: z.string().trim().min(3).max(240),
    nextActionAt: instantInputSchema,
    evidenceIds: z.array(z.string().min(1).max(100)).max(20).default([]),
  })
  .strict();
/** Validated case handover input. */
export type CaseInput = z.infer<typeof caseInputSchema>;
/** Empty synthetic lender setup; financial gates stay closed. */
export const lenderInputSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    segment: z.enum([
      "Consumer lending",
      "Cooperative",
      "Asset finance",
      "Business finance",
    ]),
  })
  .strict();
/** A manually shared, email-bound invitation for an existing organisation. */
export const invitationInputSchema = z
  .object({
    email: z
      .string()
      .email()
      .max(254)
      .transform((v) => v.trim().toLowerCase()),
    role: pilotRoleSchema,
  })
  .strict();
/** Versioned role or access change, with an accountable reason. */
export const membershipInputSchema = z
  .object({
    role: pilotRoleSchema,
    status: z.enum(["active", "suspended", "revoked"]),
    expectedUpdatedAt: instantInputSchema,
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
/** The batch version a commit names; a stale version is refused (409). */
export const batchVersionInputSchema = z.object({ expectedUpdatedAt: instantInputSchema }).strict();
const count = z.number().int().min(0);
/** Record counts that place a lender on the pilot journey. */
export const journeyCountsSchema = z.object({ customers: count, batches: count, receipts: count, openCases: count, unassignedCases: count, closes: count, exports: count }).strict();
/** The lender, the caller's access mode and the counts behind the journey view; synthetic throughout. */
export const pilotJourneySchema = z.object({ lender: merchantSchema, accessMode: z.enum(["sandbox", "staff"]), actor: z.string(), syntheticOnly: z.literal(true), counts: journeyCountsSchema }).strict();
/** Import batches newest first, 25 a page, with their source identity, quality totals and check counts but not their rows. */
export const importBatchListSchema = z.object({ items: z.array(valopayRecordSchema).max(25), total: count, offset: count }).strict();
/** One batch with its source rows and every saved revision. */
export const importBatchDetailSchema = z.object({ batch: valopayRecordSchema, revisions: z.array(valopayRecordSchema) }).strict();
/** A record a case can cite as evidence. */
export const evidenceLinkSchema = z.object({ id: z.string(), name: z.string(), reference: z.string(), kind: z.string() }).strict();
/** One exception with the people it can be handed to, its handover events and the records it can cite. */
export const caseDetailSchema = z.object({ record: valopayRecordSchema, assignees: z.array(assigneeSchema), events: z.array(valopayRecordSchema), evidence: z.array(evidenceLinkSchema) }).strict();
