import { z } from "zod";
import { assigneeSchema, instantInputSchema, merchantSchema, valopayRecordSchema } from "./api";

const id = z.string().trim().min(1).max(100);
const note = z.string().trim().min(10).max(3000);
/** Strict preparation request for one immutable close and named independent reviewer. */
export const prepareCloseReviewSchema = z.object({
  closeId: id,
  expectedUpdatedAt: instantInputSchema,
  reviewer: z.string().trim().min(1).max(200),
  preparationNote: note,
  discrepancyResponses: z.array(z.object({ issueId: id, explanation: note }).strict()).max(500),
  unresolvedAcceptance: z.string().trim().max(3000).default(""),
}).strict();
/** A Finance decision always names the version the reviewer inspected. */
export const decideCloseReviewSchema = z.object({
  expectedUpdatedAt: instantInputSchema,
  action: z.enum(["approve", "return"]),
  note,
  sourceExceptions: z.array(z.object({ issueId: z.string().min(1).max(200), reason: note, evidence: z.string().trim().min(5).max(1000) }).strict()).max(500).default([]),
}).strict();
/** Validated close preparation fields. */
export type PrepareCloseReviewInput = z.infer<typeof prepareCloseReviewSchema>;
/** Validated approval or request-for-changes fields. */
export type DecideCloseReviewInput = z.input<typeof decideCloseReviewSchema>;
/** An administrator can replace a pending reviewer without changing the evidence or deciding it. */
export const reassignCloseReviewSchema = z.object({ expectedUpdatedAt: instantInputSchema, reviewer: z.string().trim().min(1).max(200), reason: note }).strict();
/** Validated replacement of a pending Finance reviewer. */
export type ReassignCloseReviewInput = z.infer<typeof reassignCloseReviewSchema>;
/** Bounded searchable close history; direct links are independent of the current page. */
export const closeReviewHistoryQuerySchema = z.object({ search: z.string().trim().max(200).default(""), offset: z.coerce.number().int().min(0).max(1000000).default(0), limit: z.coerce.number().int().min(1).max(25).default(25) }).strip();
/** Validated search and paging fields for Finance close history. */
export type CloseReviewHistoryQuery = z.infer<typeof closeReviewHistoryQuerySchema>;

/** Progress states distinguish evidence, missing work and blocked decisions. */
export const pilotProgressStates = ["not_started", "in_progress", "awaiting_review", "completed", "blocked"] as const;
/** A status supported by the evidence-led pilot journey. */
export type PilotProgressState = typeof pilotProgressStates[number];
/** One pilot stage with the evidence and remaining requirements behind it. */
export const pilotProgressStepSchema = z.object({ id: z.string(), name: z.string(), href: z.string().startsWith("/"), state: z.enum(pilotProgressStates), evidence: z.array(z.string()), missing: z.array(z.string()) }).strict();
/** One pilot stage with the evidence and remaining requirements behind it. */
export type PilotProgressStep = z.infer<typeof pilotProgressStepSchema>;
/** Whether real staff access is enabled on this host, and what demo progress does not establish. */
export const pilotAccessSchema = z.object({ mode: z.enum(["sandbox", "staff"]), state: z.enum(["configured", "not_configured"]), message: z.string() }).strict();
/** The lender's progress through onboarding, ingestion, reconciliation, exceptions, close review and export, derived from its records. */
export const pilotProgressSchema = z.object({ lender: merchantSchema, syntheticOnly: z.literal(true), access: pilotAccessSchema, steps: z.array(pilotProgressStepSchema) }).strict();
/** A discrepancy or unresolved item a close's preparer must answer. */
export const closeReviewIssueSchema = z.object({ id: z.string(), label: z.string(), detail: z.string(), unresolved: z.boolean() }).strict();
/** A close review record with whether its snapshot still matches the close and its source evidence. */
export const closeReviewRecordSchema = valopayRecordSchema.extend({ current: z.boolean() }).strict();
/** One close with its discrepancies, why it cannot be reviewed now (if so), pending financial corrections and its reviews. */
export const closeReviewEntrySchema = z.object({ close: valopayRecordSchema, issues: z.array(closeReviewIssueSchema), problem: z.string().nullable(), pendingFinancialCorrections: z.number().int().min(0), reviews: z.array(closeReviewRecordSchema) }).strict();
/** The 25 newest closes with their reviews, the Finance reviewers available and who the caller is, so the console can enforce separation of duties. */
export const closeReviewListSchema = z.object({ closes: z.array(closeReviewEntrySchema).max(25), total: z.number().int().min(0), actor: z.string(), reviewers: z.array(assigneeSchema), accessMode: z.enum(["sandbox", "staff"]), ownPrincipal: z.string() }).strict();
/** A small history row carries no full reports or frozen review snapshots. */
export const closeReviewHistorySchema = z.object({ closes: z.array(z.object({ id: id, name: z.string(), reference: z.string(), createdAt: z.string(), businessDate: z.string().nullable(), reviewStatus: z.string().nullable(), latest: z.boolean() }).strict()).max(25), total: z.number().int().min(0), offset: z.number().int().min(0), limit: z.number().int().min(1).max(25) }).strict();
/** One lender-scoped historical close with complete recorded evidence, decisions and assignment history. */
export const closeReviewDetailSchema = z.object({ entry: closeReviewEntrySchema, events: z.array(valopayRecordSchema), actor: z.string(), reviewers: z.array(assigneeSchema), accessMode: z.enum(["sandbox", "staff"]), ownPrincipal: z.string(), pendingCorrections: z.array(z.object({ id, batchId: id, name: z.string() }).strict()) }).strict();
