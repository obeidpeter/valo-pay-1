import { retentionPolicySchema, retentionPolicyInputSchema, retentionHoldInputSchema, lifecycleCandidateSchema, lifecyclePreviewInputSchema, lifecycleApproveInputSchema, lifecycleRunViewSchema, lifecycleViewSchema, lifecycleReceiptStatusSchema, retentionMinimumDays, type LifecycleCandidate, type LifecycleEvidence, type LifecycleExternalCandidate, type RetentionMinimum, type RetentionPolicy, canonicalJson, sameJson, legacyCollatedCompare, storedInstant, changedText, notFoundText } from '@workspace/valo-pay-1-schema';
import { roleRefusal } from './validation';
import type { Context, DomainState, ValopayRecord } from './types';
import { makeRecord, touch, assertSourceOpened } from './records';
import { canonicalDigest } from '../lib/digests';
import { contractAnswer } from '../lib/contract';

// The request's input is parsed with its schema, so a mismatch is the request's 400. What these builders read
// back from storage (the policy, the sources, the runs) and the answers they build are checked with
// contractAnswer: a mismatch there is the service's fault, a 500 logged as response.invalid, never a 400.
// A stored timestamp that is a valid instant in another form (an offset) is answered as its UTC instant.

const DAY = 86400000;
const defaults: RetentionPolicy = { rawCsvDays: null, journalPayloadDays: null, exportFileDays: null, auditTrail: 'retain' };
// Policy and hold revisions and candidate and preview digests are stored in runs and compared again: their first form.
const hash = (value: unknown) => canonicalDigest(value, 'legacy-en-us-replacer');
function refuse(message: string, status = 409): never { throw Object.assign(new Error(message), { status }); }
function admin(ctx: Context) { if (ctx.role !== 'Admin') refuse(roleRefusal(ctx, ['Admin'], 'manage data retention'), 403); }
/** The shortest retention the caller's workspace allows (retentionMinimumDays): a staff pilot's, or the sandbox's. */
const minimumOf = (ctx: Context): RetentionMinimum => retentionMinimumDays[ctx.accessMode === 'staff' ? 'staff' : 'sandbox'];
const daysText = (days: number) => `${days.toLocaleString('en-GB')} days${days === 2192 ? ' (six years)' : ''}`;
const rows = (state: DomainState, kind: string) => state.records.filter(record => record.kind === kind && record.merchantId === state.merchant.id);
const ordered = (records: ValopayRecord[]) => [...records].sort((a, b) => Number(b.data.sequence || 0) - Number(a.data.sequence || 0) || b.createdAt.localeCompare(a.createdAt));
const nextSequence = (state: DomainState, kind: string) => Math.max(0, ...rows(state, kind).map(record => Number(record.data.sequence || 0))) + 1;
const candidateKey = (candidate: Pick<LifecycleCandidate, 'kind' | 'sourceId'>) => `${candidate.kind}:${candidate.sourceId}`;
/** A source identity read back from storage, its start as the UTC instant it names. */
const storedCandidate = (candidate: unknown): unknown => candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? { ...candidate, createdAt: storedInstant((candidate as { createdAt?: unknown }).createdAt) } : candidate;
const settled = (receipt: ValopayRecord | undefined) => receipt?.data.result === 'deleted' || receipt?.data.result === 'already_absent';
function advanceRun(run: ValopayRecord, now: string) { touch(run, new Date(Math.max(Date.parse(now), Date.parse(run.updatedAt) + 1)).toISOString()); }
export function lifecyclePolicy(state: DomainState) {
  const latest = ordered(rows(state, 'retention-policies'))[0];
  const policy = contractAnswer(retentionPolicySchema, latest?.data.policy || defaults);
  return { policy, revision: hash({ merchantId: state.merchant.id, policy, recordId: latest?.id || null }) };
}
export function lifecycleHolds(state: DomainState) {
  const latest = new Map<string, ValopayRecord>();
  for (const record of ordered(rows(state, 'retention-holds'))) if (!latest.has(`${record.data.kind}:${record.data.sourceId}`)) latest.set(`${record.data.kind}:${record.data.sourceId}`, record);
  return { active: [...latest.values()].filter(record => record.data.held === true), revision: hash([...latest.values()].map(record => ({ id: record.id, data: record.data })).sort((a, b) => legacyCollatedCompare(a.id, b.id))) };
}
/**
 * The export files this lender still relies on as evidence, whatever the
 * retention policy says, by export ID: a file linked to a case that is still
 * open, and the reviewed-close export of an approved Finance review (an
 * approval is final, so that export stays evidence). Such a file is never
 * eligible for deletion, so it needs no hold, and the view says why. A case
 * that is resolved or closed no longer keeps its evidence.
 */
function lifecycleEvidence(state: DomainState): Map<string, LifecycleEvidence[]> {
  const evidence = new Map<string, LifecycleEvidence[]>(), approved = new Set(rows(state, 'close-reviews').filter(review => review.status === 'approved').map(review => review.id));
  const add = (exportId: string, reason: LifecycleEvidence) => { const reasons = evidence.get(exportId) ?? []; if (reasons.length < 10) reasons.push(reason); evidence.set(exportId, reasons); };
  for (const record of state.records) {
    if (record.merchantId !== state.merchant.id) continue;
    if (record.kind === 'exceptions' && !['resolved', 'closed'].includes(record.status) && Array.isArray(record.data.case?.evidenceIds)) {
      for (const id of new Set<unknown>(record.data.case.evidenceIds)) if (typeof id === 'string' && id) add(id, { reason: 'open_case', recordId: record.id });
    } else if (record.kind === 'exports' && typeof record.data.closeReviewId === 'string' && approved.has(record.data.closeReviewId)) add(record.id, { reason: 'approved_close_review', recordId: record.data.closeReviewId });
  }
  return evidence;
}
/**
 * What every source is checked against, read from the lender once: the
 * current policy, the sources an active hold protects and the files kept as
 * evidence. Checking a source is then a lookup, so a request's cost grows with
 * its records plus its sources, never with the two multiplied. Read it again
 * after the state changes.
 */
function rulesOf(state: DomainState, ctx: Context, policy = lifecyclePolicy(state).policy, holds = lifecycleHolds(state)) {
  return { policy, minimum: minimumOf(ctx), held: new Set(holds.active.map(record => `${record.data.kind}:${record.data.sourceId}`)), evidence: lifecycleEvidence(state), now: Date.parse(ctx.now) };
}
type Rules = ReturnType<typeof rulesOf>;
const evidenceFor = (rules: Rules, candidate: LifecycleCandidate): LifecycleEvidence[] => candidate.kind === 'export_file' ? rules.evidence.get(candidate.sourceId) ?? [] : [];
function validateExternal(state: DomainState, candidates: LifecycleExternalCandidate[]): LifecycleCandidate[] {
  const result: LifecycleCandidate[] = [];
  for (const raw of candidates) {
    const candidate = contractAnswer(lifecycleCandidateSchema, storedCandidate(raw));
    if (candidate.merchantId !== state.merchant.id) continue;
    if (candidate.kind === 'journal_payload' && !['completed', 'cancelled'].includes(candidate.status)) continue;
    if (candidate.kind === 'export_file' && !['ready', 'failed'].includes(candidate.status)) continue;
    if (!['journal_payload', 'export_file'].includes(candidate.kind)) continue;
    result.push(candidate);
  }
  if (new Set(result.map(candidateKey)).size !== result.length) refuse('Some files appear twice in the retention list. Reload the page before you prepare a deletion run.');
  return result;
}
export function lifecycleCandidates(state: DomainState, external: LifecycleExternalCandidate[] = []) {
  const batches = rows(state, 'import-batches');
  // A committed batch whose rows were not opened would silently drop out of the inventory.
  for (const record of batches) if (record.status === 'committed' && record.data.csv !== undefined) assertSourceOpened(record, ['csv', 'check']);
  const raw: LifecycleCandidate[] = batches.filter(record => record.status === 'committed' && typeof record.data.csv === 'string' && record.data.csv.length > 0 && typeof record.data.committedAt === 'string').map(record => contractAnswer(lifecycleCandidateSchema, { kind: 'raw_csv', merchantId: state.merchant.id, sourceId: record.id, version: record.updatedAt, createdAt: storedInstant(record.data.committedAt), label: 'Committed import source CSV', digest: hash({ id: record.id, version: record.updatedAt, csv: record.data.csv, preview: record.data.check?.preview || null }), status: 'committed' }));
  return [...raw, ...validateExternal(state, external)].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || candidateKey(a).localeCompare(candidateKey(b)));
}
/**
 * The latest retention start, in milliseconds, at which a source of the category is old enough to delete, or null
 * while the policy keeps the category. A policy saved before the minimum existed, or under the sandbox's shorter one,
 * never deletes sooner than this workspace's minimum.
 */
function oldEnoughAt(rules: Rules, category: keyof RetentionMinimum): number | null {
  const days = rules.policy[category];
  return days === null ? null : rules.now - Math.max(days, rules.minimum[category]) * DAY;
}
function eligible(rules: Rules, candidate: LifecycleCandidate) {
  const cutoff = oldEnoughAt(rules, candidate.kind === 'raw_csv' ? 'rawCsvDays' : candidate.kind === 'journal_payload' ? 'journalPayloadDays' : 'exportFileDays');
  return cutoff !== null && Date.parse(candidate.createdAt) <= cutoff && !rules.held.has(candidateKey(candidate)) && !evidenceFor(rules, candidate).length;
}
/**
 * A window of a lender's journal payloads, which the store lists instead of all of them (lifecycleInventory): the
 * listed ones follow the first `skipped` in the inventory's order, among `total` retained, of which `eligible` are
 * old enough and not held (journalPayloadRule). So a retention request costs the same however many requests a
 * lender's people have made. A view's window starts at its page less the lender's import batches and exports (which
 * bound its other sources) and holds that many and 100; a preview's holds the first 100 and one for each held request.
 */
export interface JournalWindow { total: number; eligible: number; skipped: number }
/**
 * How the store counts the journal payloads it does not list, as `eligible` decides for those it does: old enough when
 * retained since `oldEnough` or before (null while the policy keeps them), and not among `held`.
 */
export function journalPayloadRule(state: DomainState, ctx: Context): { oldEnough: string | null; held: string[] } {
  const rules = rulesOf(state, ctx), cutoff = oldEnoughAt(rules, 'journalPayloadDays'), prefix = 'journal_payload:';
  return { oldEnough: cutoff === null ? null : new Date(cutoff).toISOString(), held: [...rules.held].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length)) };
}
/** The journal payloads a window leaves out, and how many of them are eligible: the store's counts less those listed. */
function unlistedJournal(listed: LifecycleCandidate[], rules: Rules, journal: JournalWindow) {
  const payloads = listed.filter(candidate => candidate.kind === 'journal_payload');
  return { total: journal.total - payloads.length, eligible: journal.eligible - payloads.filter(candidate => eligible(rules, candidate)).length };
}
function runOf(state: DomainState, id: string) { return rows(state, 'retention-runs').find(record => record.id === id) || refuse(notFoundText('deletion run'), 404); }
/** The latest receipt for each source of each run, from one pass over the lender's receipts. */
function receiptsByRun(state: DomainState) {
  const result = new Map<string, Map<string, ValopayRecord>>();
  for (const receipt of ordered(rows(state, 'retention-receipts'))) {
    const run = result.get(receipt.data.runId) ?? new Map<string, ValopayRecord>();
    result.set(receipt.data.runId, run);
    if (!run.has(`${receipt.data.kind}:${receipt.data.sourceId}`)) run.set(`${receipt.data.kind}:${receipt.data.sourceId}`, receipt);
  }
  return result;
}
const latestReceipts = (state: DomainState, runId: string) => receiptsByRun(state).get(runId) ?? new Map<string, ValopayRecord>();
function runView(state: DomainState, run: ValopayRecord, latest: Map<string, ValopayRecord>) {
  const receipts = [...latest.values()];
  const successful = receipts.filter(receipt => ['deleted', 'already_absent'].includes(receipt.data.result)).length;
  const candidates: unknown[] = Array.isArray(run.data.candidates) ? run.data.candidates : [];
  return contractAnswer(lifecycleRunViewSchema, { id: run.id, merchantId: state.merchant.id, status: run.status, updatedAt: run.updatedAt, createdAt: run.createdAt, expiresAt: storedInstant(run.data.expiresAt), previewDigest: run.data.previewDigest, policyRevision: run.data.policyRevision, candidates: candidates.map(storedCandidate), candidateCount: candidates.length, moreEligible: run.data.moreEligible || 0, preparedBy: typeof run.data.preparedBy === 'string' ? run.data.preparedBy : null, approvedBy: run.data.approvedBy || null, approvedAt: run.data.approvedAt ? storedInstant(run.data.approvedAt) : null, receipts: receipts.map(receipt => ({ id: receipt.id, kind: receipt.data.kind, sourceId: receipt.data.sourceId, status: receipt.data.result, at: receipt.createdAt, detail: receipt.data.detail, actor: receipt.data.actor })), successful, remaining: candidates.length - successful, auditRetained: true, financialRecordsRetained: true, syntheticOnly: true });
}
export function lifecycleRunView(state: DomainState, run: ValopayRecord) { return runView(state, run, latestReceipts(state, run.id)); }
export function lifecycleView(state: DomainState, ctx: Context, external: LifecycleExternalCandidate[] = [], targetOffset = 0, journal?: JournalWindow) {
  admin(ctx);
  if (!Number.isInteger(targetOffset) || targetOffset < 0 || targetOffset > 100000) refuse('This page of the retention list does not exist. Go back to the first page.', 400);
  const { policy, revision } = lifecyclePolicy(state), holds = lifecycleHolds(state), candidates = lifecycleCandidates(state, external), rules = rulesOf(state, ctx, policy, holds), receipts = receiptsByRun(state);
  // With a window of the journal, the payloads it leaves out are counted, and the page starts that many in.
  const unlisted = journal ? unlistedJournal(candidates, rules, journal) : { total: 0, eligible: 0 }, start = targetOffset - (journal?.skipped ?? 0);
  if (start < 0) throw new Error('The journal window starts after the page it lists.');
  return contractAnswer(lifecycleViewSchema, { merchantId: state.merchant.id, lenderName: state.merchant.name, actor: ctx.actor, asOf: ctx.now, policy, minimumDays: minimumOf(ctx), secondApprover: ctx.accessMode === 'staff', policyRevision: revision, holdRevision: holds.revision, eligibleCount: candidates.filter(candidate => eligible(rules, candidate)).length + unlisted.eligible, evidenceTotal: candidates.filter(candidate => evidenceFor(rules, candidate).length).length, targets: candidates.slice(start, start + 100).map(candidate => ({ ...candidate, held: rules.held.has(candidateKey(candidate)), evidence: evidenceFor(rules, candidate) })), targetTotal: candidates.length + unlisted.total, targetOffset, holds: holds.active.slice(0, 100).map(record => ({ kind: record.data.kind, sourceId: record.data.sourceId, reason: record.data.reason, actor: record.data.actor, at: record.createdAt })), holdTotal: holds.active.length, runs: rows(state, 'retention-runs').sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, 10).map(run => runView(state, run, receipts.get(run.id) ?? new Map())), auditRetained: true, financialRecordsRetained: true, syntheticOnly: true });
}
export function saveLifecyclePolicy(state: DomainState, ctx: Context, raw: unknown) {
  admin(ctx); const input = retentionPolicyInputSchema.parse(raw), minimum = minimumOf(ctx);
  if (input.expectedRevision !== lifecyclePolicy(state).revision) refuse(changedText('retention policy'));
  const keys = Object.keys(minimum) as Array<keyof RetentionMinimum>;
  if (keys.some(key => input.policy[key] !== null && input.policy[key]! < minimum[key])) refuse(`${ctx.accessMode === 'staff'
    ? `Keep original import files and export files for at least ${daysText(minimum.rawCsvDays)}, and saved request details for at least ${daysText(minimum.journalPayloadDays)}. Import files and exports are evidence the pilot documents require for six years; saved request details are kept for one yearly audit.`
    : `Keep each category for at least ${daysText(minimum.rawCsvDays)}, the time an inactive sandbox is kept.`} Raise the shorter periods, or switch a category off.`, 400);
  makeRecord(state, 'retention-policies', { name: 'Retention policy saved', status: 'recorded', createdAt: ctx.now, updatedAt: ctx.now, data: { policy: input.policy, actor: ctx.actor, reason: input.reason, sequence: nextSequence(state, 'retention-policies'), synthetic: true } });
  return lifecyclePolicy(state);
}
export function setLifecycleHold(state: DomainState, ctx: Context, raw: unknown, external: LifecycleExternalCandidate[] = []) {
  admin(ctx); const input = retentionHoldInputSchema.parse(raw), holds = lifecycleHolds(state);
  if (holds.revision !== input.expectedHoldRevision) refuse('The retention holds changed after you opened them. Reload the page and try again.');
  const existing = holds.active.find(record => record.data.kind === input.kind && record.data.sourceId === input.sourceId);
  if (!lifecycleCandidates(state, external).some(candidate => candidate.kind === input.kind && candidate.sourceId === input.sourceId) && !existing) refuse(notFoundText('file'), 404);
  if (Boolean(existing) === input.held) return holds;
  makeRecord(state, 'retention-holds', { name: input.held ? 'Retention hold placed' : 'Retention hold released', status: 'recorded', createdAt: ctx.now, updatedAt: ctx.now, data: { ...input, actor: ctx.actor, sequence: nextSequence(state, 'retention-holds'), synthetic: true } });
  return lifecycleHolds(state);
}
export function lifecyclePreview(state: DomainState, ctx: Context, raw: unknown, external: LifecycleExternalCandidate[] = [], journal?: JournalWindow) {
  admin(ctx); const input = lifecyclePreviewInputSchema.parse(raw), policy = lifecyclePolicy(state);
  if (input.expectedPolicyRevision !== policy.revision) refuse(changedText('retention policy'));
  const rules = rulesOf(state, ctx, policy.policy), listed = lifecycleCandidates(state, external), all = listed.filter(candidate => eligible(rules, candidate));
  if (!all.length) refuse('Nothing is due for deletion under the current retention policy and holds.', 400);
  const candidates = all.slice(0, 100), previewDigest = hash({ merchantId: state.merchant.id, policyRevision: policy.revision, candidates });
  const moreEligible = all.length + (journal ? unlistedJournal(listed, rules, journal).eligible : 0) - candidates.length;
  const run = makeRecord(state, 'retention-runs', { name: 'Retention deletion preview', status: 'preview', createdAt: ctx.now, updatedAt: ctx.now, data: { candidates, previewDigest, policyRevision: policy.revision, moreEligible, expiresAt: new Date(Date.parse(ctx.now) + 15 * 60 * 1000).toISOString(), preparedBy: ctx.actor, synthetic: true } });
  return lifecycleRunView(state, run);
}
export function approveLifecycleRun(state: DomainState, ctx: Context, id: string, raw: unknown, external: LifecycleExternalCandidate[] = []) {
  admin(ctx); const input = lifecycleApproveInputSchema.parse(raw), run = runOf(state, id);
  if (run.status !== 'preview' || input.expectedUpdatedAt !== run.updatedAt || input.previewDigest !== run.data.previewDigest) refuse('This deletion preview changed or has already been approved. Reload the page to see its status.');
  // A staff pilot needs a second person: its actor is the verified Clerk user the principal is derived from, so a different actor is a
  // different person. The anonymous sandbox has one person playing every role, so there the console explains the rule instead.
  if (ctx.accessMode === 'staff' && run.data.preparedBy === ctx.actor) refuse('A different Admin must approve this deletion run. If your pilot has only one Admin, ask the Valo Pay 1 team to add a second.', 403);
  if (Date.parse(ctx.now) >= Date.parse(run.data.expiresAt)) refuse('This deletion preview has expired. Prepare a new preview and review its files.');
  const policy = lifecyclePolicy(state);
  if (policy.revision !== run.data.policyRevision) refuse('The retention policy changed. Prepare a new deletion preview.');
  const current = new Map(lifecycleCandidates(state, external).map(item => [candidateKey(item), item])), rules = rulesOf(state, ctx, policy.policy);
  for (const candidate of run.data.candidates as LifecycleCandidate[]) {
    const found = current.get(candidateKey(candidate));
    if (!found || !sameJson(found, candidate) || !eligible(rules, found)) refuse('A file in this preview has changed, is on hold or can no longer be deleted. Prepare a new preview.');
  }
  run.status = 'approved'; Object.assign(run.data, { approvedBy: ctx.actor, approvedAt: ctx.now, approvalReason: input.reason }); advanceRun(run, ctx.now);
  return lifecycleRunView(state, run);
}
/**
 * The check the store's worker makes, while holding the lender lock,
 * immediately before each irreversible operation of one approved run. What it
 * compares (the run's receipts, the current policy, sources, holds and
 * evidence) is read from the lender once, when first needed, so checking every
 * source of a run costs a lookup each. The check answers false for a source
 * the run already removed, true for one that may be removed now, and refuses
 * anything else. Removing the run's own sources changes nothing it compares
 * for the others, so an executor keeps one for a request (lifecycle-run.ts);
 * prepare it again after any other change to the state.
 */
export function lifecycleCandidateCheck(state: DomainState, ctx: Context, runId: string, external: LifecycleExternalCandidate[] = []) {
  admin(ctx); const run = runOf(state, runId), latest = latestReceipts(state, runId), manifest = new Set((run.data.candidates as LifecycleCandidate[]).map(saved => canonicalJson(saved)));
  let revision: string | undefined, current: Map<string, LifecycleCandidate> | undefined, rules: Rules | undefined;
  return (candidate: LifecycleCandidate): boolean => {
    if (!['approved', 'running', 'attention', 'completed'].includes(run.status) || !run.data.approvedBy) refuse('Approve this deletion preview before you run it.');
    if (!manifest.has(canonicalJson(candidate))) refuse('This file was not part of the approved preview.');
    if (settled(latest.get(candidateKey(candidate)))) return false;
    revision ??= lifecyclePolicy(state).revision;
    if (revision !== run.data.policyRevision) refuse('The retention policy changed after approval. Prepare a new preview before deleting anything else.');
    current ??= new Map(lifecycleCandidates(state, external).map(item => [candidateKey(item), item]));
    rules ??= rulesOf(state, ctx);
    const found = current.get(candidateKey(candidate));
    if (!found || !sameJson(found, candidate) || !eligible(rules, found)) refuse('This file has changed, is on hold or can no longer be deleted. Nothing was deleted.');
    return true;
  };
}
/** One source's check on its own, prepared for it alone. */
export function assertLifecycleCandidate(state: DomainState, ctx: Context, runId: string, candidate: LifecycleCandidate, external: LifecycleExternalCandidate[] = []) {
  return lifecycleCandidateCheck(state, ctx, runId, external)(candidate);
}
/**
 * Raw CSV is the only artifact erased in this pure domain service. Imported records, identity provenance and audit are
 * retained. A run's executor passes the check it prepared for the request, so each source is not checked against the
 * whole lender again.
 */
export function eraseLifecycleRawCsv(state: DomainState, ctx: Context, runId: string, candidate: LifecycleCandidate, check?: (candidate: LifecycleCandidate) => boolean) {
  if (candidate.kind !== 'raw_csv') refuse('This file is deleted by the storage service, not here.', 400);
  if (!(check ?? lifecycleCandidateCheck(state, ctx, runId))(candidate)) return;
  const batch = rows(state, 'import-batches').find(record => record.id === candidate.sourceId)!;
  delete batch.data.csv;
  if (batch.data.check) delete batch.data.check.preview;
  batch.data.rawCsvRemovedAt = ctx.now;
  batch.data.rawCsvRetentionRunId = runId;
  touch(batch, ctx.now);
}
/** Only a verified executor outcome may be recorded; the UI cannot submit deletion receipts. */
export function recordLifecycleReceipt(state: DomainState, ctx: Context, runId: string, candidate: LifecycleCandidate, result: 'deleted' | 'already_absent' | 'blocked' | 'failed', detail: string) {
  admin(ctx); contractAnswer(lifecycleReceiptStatusSchema, result); const run = runOf(state, runId);
  if (!run.data.approvedBy || !['approved', 'running', 'attention', 'completed'].includes(run.status)) refuse('Approve this deletion run first.');
  if (!run.data.candidates.some((saved: LifecycleCandidate) => sameJson(saved, candidate))) refuse('This deletion record does not match a file in the approved run.');
  const prior = latestReceipts(state, runId).get(candidateKey(candidate));
  if (prior && ['deleted', 'already_absent'].includes(prior.data.result)) return lifecycleRunView(state, run);
  makeRecord(state, 'retention-receipts', { name: 'Deletion record', status: 'recorded', createdAt: ctx.now, updatedAt: ctx.now, data: { runId, kind: candidate.kind, sourceId: candidate.sourceId, sourceDigest: candidate.digest, version: candidate.version, result, detail: detail.slice(0, 500), actor: ctx.actor, sequence: nextSequence(state, 'retention-receipts'), synthetic: true } });
  const receipts = [...latestReceipts(state, runId).values()];
  run.status = receipts.filter(record => ['deleted', 'already_absent'].includes(record.data.result)).length === run.data.candidates.length ? 'completed' : receipts.some(record => ['blocked', 'failed'].includes(record.data.result)) ? 'attention' : 'running';
  advanceRun(run, ctx.now); return lifecycleRunView(state, run);
}
