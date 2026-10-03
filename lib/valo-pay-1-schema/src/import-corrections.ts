import { z } from "zod";
import { instantInputSchema } from "./api";

/** The first correction release deliberately accepts only these four fields. */
export const importCorrectionChangesSchema = z
  .object({
    name: z.string().trim().min(2).max(160).optional(),
    phoneMasked: z
      .string()
      .trim()
      .max(40)
      .refine(
        (value) => !value || /[*xX•]/.test(value) || value.length <= 4,
        "Use a masked phone number.",
      )
      .optional(),
    amountKobo: z
      .number()
      .int()
      .min(500000)
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(
        (value) =>
          Number.isFinite(Date.parse(value)) &&
          new Date(value).toISOString().slice(0, 10) === value,
        "Enter a real date.",
      )
      .optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "Choose at least one correction.",
  );
/** Previewing does not save a proposal or change a source record. */
export const importCorrectionPreviewInputSchema = z
  .object({
    batchId: z.string().min(1).max(100),
    targetId: z.string().min(1).max(100),
    expectedUpdatedAt: instantInputSchema,
    changes: importCorrectionChangesSchema,
    syntheticOnly: z.literal(true),
  })
  .strict();
/** A proposal is bound to the exact server-calculated preview. */
export const importCorrectionProposalInputSchema =
  importCorrectionPreviewInputSchema
    .extend({
      previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
      reviewer: z.string().min(1).max(180),
      reason: z.string().trim().min(10).max(1000),
      evidence: z.string().trim().min(5).max(1000),
    })
    .strict();
/** Every approval or rejection is a separate immutable event. */
export const importCorrectionDecisionInputSchema = z
  .object({
    proposalDigest: z.string().regex(/^[a-f0-9]{64}$/),
    assignmentEventId: z.string().min(1).max(100).nullable().optional(),
    action: z.enum(["approve", "reject", "withdraw"]),
    reason: z.string().trim().min(10).max(1000),
  })
  .strict();
/** An administrator changes only the assignment, against the version they inspected. */
export const importCorrectionRecoveryInputSchema = z.object({
  proposalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expectedAssignmentEventId: z.string().min(1).max(100).nullable(),
  reviewer: z.string().min(1).max(180),
  reason: z.string().trim().min(10).max(1000),
}).strict();
/** Before/after display; source row provenance itself never changes. */
export const importCorrectionDifferenceSchema = z
  .object({
    field: z.enum(["name", "phoneMasked", "amountKobo", "dueDate"]),
    before: z.union([z.string(), z.number(), z.null()]),
    after: z.union([z.string(), z.number()]),
  })
  .strict();
/** Evidence records which must be revisited when an approved amendment changes the current record. */
export const importCorrectionImpactSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    name: z.string(),
    reference: z.string(),
    status: z.string(),
    updatedAt: z.string(),
  })
  .strict();
/** Compact preview returned by both the dry run and saved proposal list. */
export const importCorrectionPreviewSchema = z
  .object({
    merchantId: z.string(),
    batchId: z.string(),
    targetId: z.string(),
    targetKind: z.string(),
    source: z.string(),
    rowId: z.string(),
    targetUpdatedAt: z.string(),
    financial: z.boolean(),
    previewDigest: z.string(),
    differences: z.array(importCorrectionDifferenceSchema),
    affected: z.array(importCorrectionImpactSchema),
    blockers: z.array(z.string()),
    consequence: z.string(),
  })
  .strict();
/** Saved proposals expose a derived decision and cannot be overwritten. */
export const importCorrectionViewSchema = z
  .object({
    id: z.string(),
    merchantId: z.string(),
    createdAt: z.string(),
    proposedBy: z.string(),
    proposedPrincipal: z.string(),
    reviewer: z.string(),
    originalReviewer: z.string().optional(),
    assignmentEventId: z.string().nullable().default(null),
    assignmentUpdatedAt: z.string().optional(),
    assignmentHistory: z.array(z.object({
      id: z.string(), fromReviewer: z.string(), reviewer: z.string(),
      actor: z.string(), reason: z.string(), at: z.string(),
    }).strict()).default([]),
    reason: z.string(),
    evidence: z.string(),
    proposalDigest: z.string(),
    status: z.enum(["awaiting_review", "approved", "rejected", "withdrawn"]),
    current: z.boolean(),
    preview: importCorrectionPreviewSchema,
    decision: z
      .object({
        id: z.string(),
        action: z.enum(["approve", "reject", "withdraw"]),
        actor: z.string(),
        principalId: z.string(),
        reason: z.string(),
        at: z.string(),
      })
      .nullable(),
  })
  .strict();
/** Only imported canonical records belonging to this committed batch are selectable. */
export const importCorrectionTargetSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    name: z.string(),
    reference: z.string(),
    updatedAt: z.string(),
    rowId: z.string(),
    amountKobo: z.number(),
    dueDate: z.string().nullable(),
    phoneMasked: z.string(),
    supported: z.boolean(),
    status: z.string(),
  })
  .strict();
/** Lender-scoped import amendment workbench. */
export const importCorrectionsResponseSchema = z
  .object({
    batchId: z.string(),
    actor: z.string(),
    ownPrincipal: z.string(),
    role: z.string(),
    targets: z.array(importCorrectionTargetSchema),
    proposals: z.array(importCorrectionViewSchema),
    reviewers: z.array(
      z.object({ actor: z.string(), name: z.string(), role: z.string() }),
    ),
    syntheticOnly: z.literal(true),
  })
  .strict();
/** Validated dry-run comparison input. */
export type ImportCorrectionPreviewInput = z.infer<
  typeof importCorrectionPreviewInputSchema
>;
/** Validated immutable correction proposal. */
export type ImportCorrectionProposalInput = z.infer<
  typeof importCorrectionProposalInputSchema
>;
/** Validated independent decision or proposer withdrawal. */
export type ImportCorrectionDecisionInput = z.infer<
  typeof importCorrectionDecisionInputSchema
>;
/** Validated administrator reassignment request. */
export type ImportCorrectionRecoveryInput = z.infer<typeof importCorrectionRecoveryInputSchema>;
