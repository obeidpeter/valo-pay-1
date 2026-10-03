import { z } from 'zod';
import { instantInputSchema } from './api';
const id = z.string().min(1).max(200), hash = z.string().regex(/^[a-f0-9]{64}$/), at = z.string().datetime();
/** Source artifact categories that can be retained or deleted; excludes financial records. */
export const lifecycleKindSchema = z.enum(['raw_csv', 'journal_payload', 'export_file']);
/** Explicit minimum retention ages, disabled by default, with audit permanently retained. */
export const retentionPolicySchema = z.object({ rawCsvDays: z.number().int().min(1).max(3650).nullable(), journalPayloadDays: z.number().int().min(1).max(3650).nullable(), exportFileDays: z.number().int().min(1).max(3650).nullable(), auditTrail: z.literal('retain') }).strict();
/** Configured retention ages for eligible source artifacts. */
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;
/** The shortest retention a policy may set for each category, in days: the same keys as the policy. */
export const retentionMinimumSchema = z.object({ rawCsvDays: z.number().int().min(1), journalPayloadDays: z.number().int().min(1), exportFileDays: z.number().int().min(1) }).strict();
/** A category's shortest permitted retention, in days. */
export type RetentionMinimum = z.infer<typeof retentionMinimumSchema>;
/**
 * The shortest retention each category may have (docs/pilot-operations-controls.md, "Retention"). The anonymous
 * sandbox keeps 30 days, the lifetime of an inactive sandbox, so a policy can never delete sample work sooner than
 * the sandbox itself would go. A staff pilot rehearses a regulated lender: its original source files and its export
 * files are evidence and keep the six years the documents name for evidence (2,192 days, which covers the leap days
 * any six years hold); its recovery payloads keep a year, one annual audit cycle, since the records they created and
 * the audit trail that names them are kept regardless.
 */
export const retentionMinimumDays = {
  sandbox: { rawCsvDays: 30, journalPayloadDays: 30, exportFileDays: 30 },
  staff: { rawCsvDays: 2192, journalPayloadDays: 366, exportFileDays: 2192 },
} as const satisfies Record<'sandbox' | 'staff', RetentionMinimum>;
/** Version-protected administrator policy decision and accountable reason. */
export const retentionPolicyInputSchema = z.object({ policy: retentionPolicySchema, expectedRevision: hash, reason: z.string().trim().min(10).max(500) }).strict();
/** Version-protected hold or release for one exact artifact. */
export const retentionHoldInputSchema = z.object({ kind: lifecycleKindSchema, sourceId: id, held: z.boolean(), expectedHoldRevision: hash, reason: z.string().trim().min(10).max(500) }).strict();
/** Public-safe artifact identity, terminal retention start and exact version digest. */
export const lifecycleCandidateSchema = z.object({ kind: lifecycleKindSchema, merchantId: id, sourceId: id, version: id, createdAt: at, label: z.string().min(1).max(200), digest: hash, status: z.enum(['committed', 'completed', 'cancelled', 'ready', 'failed']) }).strict();
/** One exact source artifact eligible for retention evaluation. */
export type LifecycleCandidate = z.infer<typeof lifecycleCandidateSchema>;
/** Terminal request payload or export artifact supplied by the scoped storage service. */
export type LifecycleExternalCandidate = LifecycleCandidate & { kind: 'journal_payload' | 'export_file' };
/** Why an export file is kept whatever the policy says: it is linked as evidence to a case that is still open, or it is the reviewed-close export of an approved Finance close review. `recordId` names the case or the review. */
export const lifecycleEvidenceSchema = z.object({ reason: z.enum(['open_case', 'approved_close_review']), recordId: id }).strict();
/** One reason an export file is kept as evidence. */
export type LifecycleEvidence = z.infer<typeof lifecycleEvidenceSchema>;
/** Policy revision to use when saving a bounded deletion preview. */
export const lifecyclePreviewInputSchema = z.object({ expectedPolicyRevision: hash }).strict();
/** Fresh approval of one exact unexpired deletion preview. */
export const lifecycleApproveInputSchema = z.object({ expectedUpdatedAt: instantInputSchema, previewDigest: hash, reason: z.string().trim().min(10).max(500) }).strict();
/** Immutable preview identity for executing or resuming an approved run. */
export const lifecycleExecuteInputSchema = z.object({ previewDigest: hash }).strict();
/** Verified executor result; blocked and failed candidates remain resumable. */
export const lifecycleReceiptStatusSchema = z.enum(['deleted', 'already_absent', 'blocked', 'failed']);
/** Durable deletion receipt with source identity and accountable actor. */
export const lifecycleReceiptViewSchema = z.object({ id, kind: lifecycleKindSchema, sourceId: id, status: lifecycleReceiptStatusSchema, at, detail: z.string(), actor: id }).strict();
/** Exact reviewed manifest and bounded execution progress for one retention run, with who prepared it (absent from answers stored by an earlier build). */
export const lifecycleRunViewSchema = z.object({ id, merchantId: id, status: z.enum(['preview', 'approved', 'running', 'completed', 'attention']), updatedAt: at, createdAt: at, expiresAt: at, previewDigest: hash, policyRevision: hash, candidates: z.array(lifecycleCandidateSchema).max(100), candidateCount: z.number().int().nonnegative(), moreEligible: z.number().int().nonnegative(), preparedBy: z.string().nullable().optional(), approvedBy: z.string().nullable(), approvedAt: at.nullable(), receipts: z.array(lifecycleReceiptViewSchema).max(100), successful: z.number().int().nonnegative(), remaining: z.number().int().nonnegative(), auditRetained: z.literal(true), financialRecordsRetained: z.literal(true), syntheticOnly: z.literal(true) }).strict();
/** Validated retention preview, approval and receipt read model. */
export type LifecycleRunView = z.infer<typeof lifecycleRunViewSchema>;
/** Administrator-only policy, holds, bounded inventory and saved retention runs. A source kept as evidence carries the reasons, is never eligible and is counted in `evidenceTotal`. `minimumDays` is the shortest retention this workspace's policy may set, and `secondApprover` says whether a run must be approved by an administrator other than the one who prepared it (staff pilots; absent from answers stored by an earlier build). */
export const lifecycleViewSchema = z.object({ merchantId: id, lenderName: z.string(), actor: id, asOf: at, policy: retentionPolicySchema, minimumDays: retentionMinimumSchema.optional(), secondApprover: z.boolean().optional(), policyRevision: hash, holdRevision: hash, eligibleCount: z.number().int().nonnegative(), evidenceTotal: z.number().int().nonnegative(), targets: z.array(lifecycleCandidateSchema.extend({ held: z.boolean(), evidence: z.array(lifecycleEvidenceSchema).max(10) }).strict()).max(100), targetTotal: z.number().int().nonnegative(), targetOffset: z.number().int().nonnegative(), holds: z.array(z.object({ kind: lifecycleKindSchema, sourceId: id, reason: z.string(), actor: id, at }).strict()).max(100), holdTotal: z.number().int().nonnegative(), runs: z.array(lifecycleRunViewSchema).max(10), auditRetained: z.literal(true), financialRecordsRetained: z.literal(true), syntheticOnly: z.literal(true) }).strict();
/** Validated retention control response for one lender. */
export type LifecycleView = z.infer<typeof lifecycleViewSchema>;
