import assert from 'node:assert/strict';
import { ZodError } from 'zod';
import { retentionPolicySchema, lifecycleRunViewSchema, type LifecycleCandidate, type LifecycleExternalCandidate, type RetentionPolicy } from '@workspace/valopay-schema';
import { seedMerchant } from '../src/lib/valopay-seed';
import { makeRecord } from '../src/domain/records';
import { ResponseContractError } from '../src/lib/contract';
import { createHash } from 'node:crypto';
import { lifecycleView, lifecycleRunView, lifecyclePolicy, lifecycleHolds, lifecyclePreview, approveLifecycleRun, saveLifecyclePolicy, setLifecycleHold, assertLifecycleCandidate, lifecycleCandidateCheck, eraseLifecycleRawCsv, recordLifecycleReceipt, journalPayloadRule } from '../src/domain/lifecycle';
import type { DomainState } from '../src/domain/types';

const ctx = { actor: 'Clerk:admin', role: 'Admin', now: '2026-09-25T10:00:00.000Z' };
const policy = { rawCsvDays: 30, journalPayloadDays: 30, exportFileDays: 30, auditTrail: 'retain' as const };
let checks = 0;
const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks += 1; };
const refuses = (fn: () => unknown, status: number) => { assert.throws(fn, (error: any) => error.status === status); checks += 1; };
function fixture(id = 'retention-test') {
  const state = seedMerchant(id, true);
  const batch = makeRecord(state, 'import-batches', { name: 'Imported source', status: 'committed', createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-01T10:00:00.000Z', data: { csv: 'reference,name\nROW-1,Synthetic person', committedAt: '2026-08-01T10:00:00.000Z', rowIds: ['ROW-1'], recordIds: ['financial-1'], source: 'lms', sourceBatchId: 'feed-1', check: { valid: 1, invalid: 0, imported: 1, rows: [{ row: 1, status: 'valid', message: 'Imported' }], preview: [{ row: 1, values: { reference: 'ROW-1', name: 'Synthetic person' } }] } } });
  return { state, batch };
}
function enable(state: DomainState) { return saveLifecyclePolicy(state, ctx, { policy, expectedRevision: lifecyclePolicy(state).revision, reason: 'Agreed source retention for the synthetic rehearsal.' }); }
function preview(state: DomainState, external: LifecycleExternalCandidate[] = []) { return lifecyclePreview(state, ctx, { expectedPolicyRevision: lifecyclePolicy(state).revision }, external); }
function approve(state: DomainState, run: ReturnType<typeof preview>, external: LifecycleExternalCandidate[] = []) { return approveLifecycleRun(state, ctx, run.id, { expectedUpdatedAt: run.updatedAt, previewDigest: run.previewDigest, reason: 'Reviewed the exact eligible sample source artifacts.' }, external); }
function hold(state: DomainState, sourceId: string, held: boolean) { return setLifecycleHold(state, ctx, { kind: 'raw_csv', sourceId, held, expectedHoldRevision: lifecycleHolds(state).revision, reason: held ? 'Keep this source for an unresolved sample case.' : 'The sample review is complete; release the source hold.' }); }
/** The same lender, counting every record read, so a test can see how many passes over the lender a call makes. */
function counted(state: DomainState) {
  let reads = 0;
  const records = new Proxy(state.records, { get(target, key, receiver) { if (typeof key === 'string' && /^[0-9]+$/.test(key)) reads += 1; return Reflect.get(target, key, receiver); } });
  return { state: { ...state, records }, reads: () => reads, reset() { reads = 0; } };
}
{
  // Retention screens need the committed CSV itself: a batch the route did not open is refused, not left out of the inventory.
  for (const field of ['csv', 'check']) {
    const { state, batch } = fixture(`sealed-${field}`); enable(state);
    batch.data[field] = { protectedPayload: 1 };
    refuses(() => lifecycleView(state, ctx), 500);
    refuses(() => preview(state), 500);
  }
}
{
  // What the views read back from storage (audit item 24, review). A timestamp an earlier build stored with an offset
  // names the same instant, so the views answer it in UTC; a value that is no instant at all is the service's fault,
  // a ResponseContractError (a 500 logged as response.invalid), never a ZodError the handler would answer as a 400.
  const { state } = fixture('stored-offsets'); enable(state);
  const run = preview(state), stored = state.records.find(record => record.id === run.id)!;
  stored.data.expiresAt = '2026-09-25T11:15:00+01:00';
  stored.data.candidates = stored.data.candidates.map((candidate: LifecycleCandidate) => ({ ...candidate, createdAt: candidate.createdAt.replace('Z', '+00:00') }));
  const view = lifecycleView(state, ctx);
  check(view.runs[0]!.expiresAt === '2026-09-25T10:15:00.000Z', 'an expiry stored with an offset is answered as its UTC instant');
  check(view.runs[0]!.candidates.every(candidate => candidate.createdAt === '2026-08-01T10:00:00.000Z'), 'so is a stored source identity');
  check(lifecycleRunView(state, stored).expiresAt === '2026-09-25T10:15:00.000Z', 'by the run view too');
  // The stored manifest no longer matches the inventory word for word, so it is prepared again rather than approved.
  refuses(() => approve(state, run), 409);
  stored.data.expiresAt = 'next Tuesday';
  const failure = (() => { try { lifecycleView(state, ctx); return undefined; } catch (error) { return error; } })();
  check(failure instanceof ResponseContractError && !(failure instanceof ZodError) && failure.issues.some(issue => issue.path === 'expiresAt'), 'a stored expiry that is no instant is a fault in the run view, naming its path');
  const policy = state.records.find(record => record.kind === 'retention-policies')!;
  policy.data.policy = { ...policy.data.policy, rawCsvDays: 'thirty' };
  check((() => { try { lifecyclePolicy(state); return false; } catch (error) { return error instanceof ResponseContractError; } })(), 'so is a stored policy the view cannot read');
}
{
  const { state } = fixture();
  const view = lifecycleView(state, ctx);
  check(view.eligibleCount === 0 && view.policy.rawCsvDays === null && view.policy.journalPayloadDays === null && view.policy.exportFileDays === null, 'all deletion policies start disabled');
  check(view.auditRetained && view.financialRecordsRetained && view.policy.auditTrail === 'retain', 'audit and financial records are expressly retained');
  refuses(() => preview(state), 400);
  refuses(() => lifecycleView(state, { ...ctx, role: 'Operations' }), 403);
  refuses(() => saveLifecyclePolicy(state, { ...ctx, role: 'Read-only' }, { policy, expectedRevision: view.policyRevision, reason: 'An unauthorised policy edit.' }), 403);
  check(!retentionPolicySchema.safeParse({ ...policy, auditTrail: 'delete' }).success, 'there is no audit deletion policy');
  check(!retentionPolicySchema.safeParse({ ...policy, rawCsvDays: 0 }).success, 'zero-day immediate deletion cannot be configured');
  enable(state);
  refuses(() => saveLifecyclePolicy(state, ctx, { policy, expectedRevision: view.policyRevision, reason: 'The policy has already changed.' }), 409);
  check(lifecycleView(state, ctx).eligibleCount === 1 && state.records.some(record => record.kind === 'retention-policies'), 'an explicit versioned policy makes only aged terminal artifacts eligible');
}
{
  const { state, batch } = fixture('age'); enable(state);
  batch.data.committedAt = '2026-09-01T10:00:00.000Z';
  check(lifecycleView(state, ctx).eligibleCount === 0, 'raw retention age starts at commitment, not original batch creation');
  batch.status = 'ready'; batch.data.committedAt = '2026-08-01T10:00:00.000Z';
  check(lifecycleView(state, ctx).targets.length === 0, 'draft and correction-ready source CSV never enters retention inventory');
}
{
  const { state, batch } = fixture('holds'); enable(state);
  hold(state, batch.id, true);
  check(lifecycleView(state, ctx).eligibleCount === 0 && lifecycleView(state, ctx).holds.length === 1, 'per-source hold takes precedence over policy');
  refuses(() => preview(state), 400);
  hold(state, batch.id, false);
  const run = preview(state);
  const before = JSON.stringify(batch);
  check(run.status === 'preview' && JSON.stringify(batch) === before, 'preview persists identity but deletes nothing');
  hold(state, batch.id, true);
  refuses(() => approve(state, run), 409);
  check(typeof batch.data.csv === 'string', 'hold placed after preview prevents approval without deleting source');
  hold(state, batch.id, false);
  const fresh = approve(state, preview(state));
  hold(state, batch.id, true);
  refuses(() => assertLifecycleCandidate(state, ctx, fresh.id, fresh.candidates[0]!), 409);
  check(typeof batch.data.csv === 'string', 'hold placed after approval prevents execution');
  refuses(() => setLifecycleHold(state, ctx, { kind: 'raw_csv', sourceId: batch.id, held: false, expectedHoldRevision: 'a'.repeat(64), reason: 'Attempt a stale hold release.' }), 409);
  refuses(() => setLifecycleHold(state, ctx, { kind: 'raw_csv', sourceId: 'foreign-record', held: true, expectedHoldRevision: lifecycleHolds(state).revision, reason: 'Hold a source that does not belong here.' }), 404);
}
{
  const { state, batch } = fixture('freshness'); enable(state);
  const run = preview(state);
  refuses(() => approveLifecycleRun(state, { ...ctx, now: '2026-09-25T10:15:00.000Z' }, run.id, { expectedUpdatedAt: run.updatedAt, previewDigest: run.previewDigest, reason: 'An expired preview must be refreshed.' }), 409);
  refuses(() => approveLifecycleRun(state, ctx, run.id, { expectedUpdatedAt: run.updatedAt, previewDigest: 'b'.repeat(64), reason: 'A different manifest is not approved.' }), 409);
  refuses(() => approveLifecycleRun(state, { ...ctx, role: 'Finance' }, run.id, { expectedUpdatedAt: run.updatedAt, previewDigest: run.previewDigest, reason: 'Only the administrator can approve this.' }), 403);
  batch.data.csv += '\nROW-2,A changed source';
  refuses(() => approve(state, run), 409);
  check(typeof batch.data.csv === 'string', 'a changed raw source digest prevents old preview approval');
  const approved = approve(state, preview(state));
  saveLifecyclePolicy(state, ctx, { policy: { ...policy, rawCsvDays: 90 }, expectedRevision: lifecyclePolicy(state).revision, reason: 'Extend raw source retention for this rehearsal.' });
  refuses(() => assertLifecycleCandidate(state, ctx, approved.id, approved.candidates[0]!), 409);
  check(typeof batch.data.csv === 'string', 'policy changes after approval block execution');
}
{
  const { state, batch } = fixture('delete'); enable(state);
  const protectedRecords = JSON.stringify(state.records.filter(record => !record.kind.startsWith('retention-') && record.id !== batch.id));
  const previewed = preview(state), candidate = previewed.candidates[0]!;
  refuses(() => eraseLifecycleRawCsv(state, ctx, previewed.id, candidate), 409);
  const approved = approve(state, previewed);
  check(approved.updatedAt > previewed.updatedAt && lifecycleRunViewSchema.safeParse(approved).success, 'approval response exposes the advanced source version before transactional validation');
  check(assertLifecycleCandidate(state, ctx, approved.id, candidate), 'approved unchanged unheld source passes the executor check');
  eraseLifecycleRawCsv(state, ctx, approved.id, candidate);
  const completed = recordLifecycleReceipt(state, ctx, approved.id, candidate, 'deleted', 'Committed source CSV and preview removed; imported records retained.');
  check(!('csv' in batch.data) && !('preview' in batch.data.check!), 'only raw CSV and its raw preview were erased');
  check(batch.data.rowIds![0] === 'ROW-1' && batch.data.recordIds![0] === 'financial-1' && batch.status === 'committed', 'source-row provenance, financial links and batch commitment remain');
  check(JSON.stringify(state.records.filter(record => !record.kind.startsWith('retention-') && record.id !== batch.id)) === protectedRecords, 'underlying financial, case and audit records are unchanged');
  check(completed.status === 'completed' && completed.successful === 1 && completed.remaining === 0 && completed.receipts[0]!.status === 'deleted', 'verified deletion receipt completes exact run');
  check(assertLifecycleCandidate(state, ctx, approved.id, candidate) === false, 'successful receipts prevent repeated physical deletion');
  const repeat = recordLifecycleReceipt(state, ctx, approved.id, candidate, 'deleted', 'Repeated receipt');
  check(repeat.receipts.length === 1 && state.records.filter(record => record.kind === 'retention-receipts').length === 1, 'repeated completion does not invent duplicate receipts');
  check(lifecycleView(state, ctx).targets.length === 0, 'removed raw CSV is absent from future inventory');
}
{
  const { state } = fixture('external'); enable(state);
  const external: LifecycleExternalCandidate[] = [
    { kind: 'journal_payload', merchantId: state.merchant.id, sourceId: 'terminal-operation', version: 'v1', createdAt: '2026-08-01T00:00:00.000Z', label: 'Completed sample request', digest: 'a'.repeat(64), status: 'completed' },
    { kind: 'export_file', merchantId: state.merchant.id, sourceId: 'retained-file', version: 'generation-1', createdAt: '2026-08-02T00:00:00.000Z', label: 'Generated sample export', digest: 'b'.repeat(64), status: 'ready' },
    { kind: 'export_file', merchantId: 'different-lender', sourceId: 'foreign-export', version: 'generation-9', createdAt: '2026-08-02T00:00:00.000Z', label: 'Foreign export', digest: 'c'.repeat(64), status: 'ready' },
  ];
  const run = approve(state, preview(state, external), external);
  check(run.candidateCount === 3 && !JSON.stringify(run).includes('foreign-export'), 'external inventory is scoped to this lender');
  check(!JSON.stringify(run).includes('bucket') && !JSON.stringify(run).includes('objectName'), 'manifest exposes no internal storage locations');
  const file = run.candidates.find(candidate => candidate.kind === 'export_file')!;
  refuses(() => eraseLifecycleRawCsv(state, ctx, run.id, file), 400);
  const changed = external.map(candidate => candidate.sourceId === file.sourceId ? { ...candidate, version: 'generation-2' } : candidate);
  refuses(() => assertLifecycleCandidate(state, ctx, run.id, file, changed), 409);
  refuses(() => assertLifecycleCandidate(state, ctx, run.id, { ...file, sourceId: 'not-reviewed' }, external), 409);
  const failed = recordLifecycleReceipt(state, ctx, run.id, file, 'failed', 'Storage service did not confirm deletion.');
  check(failed.status === 'attention' && failed.successful === 0 && failed.remaining === 3, 'unconfirmed external deletion is never counted as success');
  check(assertLifecycleCandidate(state, ctx, run.id, file, external), 'failed candidate can resume after current identity and holds are checked');
  assert.throws(() => lifecycleView(state, ctx, [{ ...external[0]!, status: 'pending' } as any])); checks += 1;
  check(!state.records.some(record => record.kind === 'retention-receipts' && record.data.result === 'deleted'), 'pure domain never claims an external file or journal payload was deleted');
}
{
  const { state, batch } = fixture('bound'); enable(state);
  for (let i = 0; i < 104; i++) makeRecord(state, 'import-batches', { ...batch, id: `batch-${i}`, data: structuredClone(batch.data) });
  const run = preview(state);
  check(run.candidateCount === 100 && run.moreEligible === 5, 'each approved deletion manifest is bounded to100 exact artifacts');
  check(lifecycleView(state, ctx).targets.length === 100 && lifecycleView(state, ctx, [], 100).targets.length === 5, 'inventory has bounded pages');
  refuses(() => approveLifecycleRun(state, ctx, 'different-run', { expectedUpdatedAt: run.updatedAt, previewDigest: run.previewDigest, reason: 'Not a run in this lender.' }), 404);
}
{
  // Checking sources against the policy, the holds and the evidence reads the lender a fixed number of times, however
  // many sources there are. The view, a preview, an approval and the executor's check each used to read every record
  // again for every source: 5,010 journal entries on a 25,000-record lender took about 4 s a request.
  const { state, batch } = fixture('scale'); enable(state);
  for (let i = 0; i < 1500; i++) state.records.push({ id: `scale-customer-${i}`, merchantId: state.merchant.id, kind: 'customers', name: `Synthetic customer ${i}`, status: 'active', reference: `SCALE-${i}`, amountKobo: 0, customerId: '', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', data: { synthetic: true } });
  const external: LifecycleExternalCandidate[] = Array.from({ length: 1500 }, (_, i) => ({ kind: 'journal_payload', merchantId: state.merchant.id, sourceId: `operation-${String(i).padStart(4, '0')}`, version: 'v1', createdAt: '2026-08-01T12:00:00.000Z', label: 'Completed sample request', digest: 'a'.repeat(64), status: 'completed' }));
  setLifecycleHold(state, ctx, { kind: 'journal_payload', sourceId: 'operation-0000', held: true, expectedHoldRevision: lifecycleHolds(state).revision, reason: 'Keep one request for a sample dispute.' }, external);
  const size = state.records.length + external.length, bound = 25 * size, probe = counted(state);
  const view = lifecycleView(probe.state, ctx, external);
  check(view.targetTotal === 1501 && view.eligibleCount === 1500 && view.targets[0]!.sourceId === batch.id, 'every source is listed, and the held one is not eligible');
  check(probe.reads() <= bound, `the view reads the lender a fixed number of times (${probe.reads()} reads for ${size} records and sources)`);
  probe.reset(); const run = lifecyclePreview(probe.state, ctx, { expectedPolicyRevision: lifecyclePolicy(state).revision }, external);
  check(run.candidateCount === 100 && run.moreEligible === 1400 && probe.reads() <= bound, `a preview reads the lender a fixed number of times (${probe.reads()} reads)`);
  probe.reset(); const approved = approveLifecycleRun(probe.state, ctx, run.id, { expectedUpdatedAt: run.updatedAt, previewDigest: run.previewDigest, reason: 'Reviewed the exact eligible sample source artifacts.' }, external);
  check(approved.status === 'approved' && probe.reads() <= bound, `an approval reads the lender a fixed number of times (${probe.reads()} reads)`);
  probe.reset(); const executorCheck = lifecycleCandidateCheck(probe.state, ctx, approved.id, external);
  check(approved.candidates.every(candidate => executorCheck(candidate)) && probe.reads() <= bound, `the executor's check of a whole run reads the lender a fixed number of times (${probe.reads()} reads)`);
}
{
  // The store lists a window of a lender's journal payloads and counts the rest (lifecycleInventory; the third review of
  // the audit fixes, edge finding 1), so a retention request costs the same however many requests the lender's people
  // have made. Every page of the view, its counts and a preview are exactly what the whole journal gives. The store's
  // window starts at the page less the lender's import batches and exports, which bound the other sources, and holds
  // that many and 100; a preview's holds the first 100 and one more for each held request.
  const { state } = fixture('window'); enable(state);
  const at = (minute: number) => new Date(Date.parse('2026-07-01T00:00:00.000Z') + minute * 60_000).toISOString();
  // Other sources among the journal's, some retained at the same instant as a request.
  for (let i = 0; i < 6; i++) makeRecord(state, 'import-batches', { name: `Window batch ${i}`, status: 'committed', createdAt: at(i * 37), data: { csv: 'reference,name\nROW-1,Synthetic person', committedAt: at(i * 37), check: { valid: 1, invalid: 0, imported: 1 } } });
  for (let i = 0; i < 5; i++) makeRecord(state, 'exports', { name: `Window export ${i}`, status: 'ready', createdAt: at(i * 41 + 3), data: {} });
  const files: LifecycleExternalCandidate[] = Array.from({ length: 5 }, (_, i) => ({ kind: 'export_file', merchantId: state.merchant.id, sourceId: `window-file-${i}`, version: 'generation-1', createdAt: at(i * 41 + 3), label: 'Private export file', digest: 'b'.repeat(64), status: 'ready' }));
  // 700 requests, three a minute; the last 100 are too recent to delete.
  const journal: LifecycleExternalCandidate[] = Array.from({ length: 700 }, (_, i) => ({ kind: 'journal_payload', merchantId: state.merchant.id, sourceId: createHash('sha256').update(`window-${i}`).digest('hex'), version: at(i), createdAt: i < 600 ? at(Math.floor(i / 3)) : '2026-09-20T00:00:00.000Z', label: 'Terminal operation payload', digest: 'a'.repeat(64), status: i % 4 ? 'completed' : 'cancelled' }));
  for (const index of [2, 5, 150]) setLifecycleHold(state, ctx, { kind: 'journal_payload', sourceId: journal[index]!.sourceId, held: true, expectedHoldRevision: lifecycleHolds(state).revision, reason: 'Keep this request for a sample dispute.' }, journal);
  const order = [...journal].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sourceId.localeCompare(b.sourceId));
  const rule = journalPayloadRule(state, ctx), held = new Set(rule.held);
  check(rule.oldEnough === '2026-08-26T10:00:00.000Z' && held.size === 3, 'the rule is the policy\'s age and the held requests');
  const counts = { total: journal.length, eligible: journal.filter(candidate => rule.oldEnough !== null && candidate.createdAt <= rule.oldEnough && !held.has(candidate.sourceId)).length };
  const others = state.records.filter(record => record.kind === 'import-batches' || record.kind === 'exports').length;
  for (const offset of [0, 1, 99, 100, 237, 500, 599, 600, 650, 700, 711, 800]) {
    const skipped = Math.max(0, offset - others), window = order.slice(skipped, skipped + others + 100);
    assert.deepEqual(lifecycleView(state, ctx, [...window, ...files], offset, { ...counts, skipped }), lifecycleView(state, ctx, [...journal, ...files], offset), `the page at ${offset}`); checks += 1;
  }
  const whole = lifecycleView(state, ctx, [...journal, ...files]);
  check(whole.targetTotal === 712 && whole.eligibleCount === 597 + 12, 'the whole journal: 700 requests and 12 other sources, of which 597 requests and all 12 others are old enough and not held');
  const prepared = (lender: DomainState, external: LifecycleExternalCandidate[], journalWindow?: { total: number; eligible: number; skipped: number }) => lifecyclePreview(lender, ctx, { expectedPolicyRevision: lifecyclePolicy(lender).revision }, external, journalWindow);
  const expected = prepared(structuredClone(state), [...journal, ...files]), windowed = prepared(structuredClone(state), [...order.slice(0, 100 + rule.held.length), ...files], { ...counts, skipped: 0 });
  assert.deepEqual([windowed.candidates, windowed.moreEligible, windowed.previewDigest], [expected.candidates, expected.moreEligible, expected.previewDigest], 'a preview from the first requests is the whole journal\'s'); checks += 1;
  check(expected.moreEligible === 509, 'and it counts the eligible sources it leaves for a later preview');
}
{
  // Export files the lender relies on as evidence are never offered for deletion, and the view says why: one linked to
  // a case that is still open, and the reviewed-close export of an approved Finance review. They used to be listed as
  // eligible with nothing to prompt a hold.
  const { state, batch } = fixture('evidence'); enable(state);
  const exportFile = (name: string, data: Record<string, unknown> = {}) => makeRecord(state, 'exports', { name, status: 'ready', createdAt: '2026-08-02T00:00:00.000Z', data: { kind: 'customer-pack', format: 'json', bucket: 'synthetic-private', objectName: `exports/${name}.json`, checksum: 'c'.repeat(64), generatedAt: '2026-08-02T00:00:00.000Z', ...data } });
  const review = makeRecord(state, 'close-reviews', { name: 'Approved sample close review', status: 'approved', createdAt: '2026-08-02T00:00:00.000Z', data: { closeId: 'sample-close', snapshotDigest: 'e'.repeat(64) } });
  const caseFile = exportFile('case-evidence'), reviewFile = exportFile('reviewed-close', { kind: 'reviewed-close', closeReviewId: review.id, closeSnapshotDigest: 'e'.repeat(64) }), plainFile = exportFile('unlinked');
  const caseData = { assignee: ctx.actor, assigneeName: 'Sample administrator', nextAction: 'Review the linked export', nextActionAt: '2026-10-01T10:00:00.000Z', evidenceIds: [caseFile.id] };
  const openCase = makeRecord(state, 'exceptions', { name: 'Open sample case', status: 'in_progress', createdAt: '2026-08-02T00:00:00.000Z', data: { type: 'unmatched_payment', case: caseData } });
  const external = (): LifecycleExternalCandidate[] => [caseFile, reviewFile, plainFile].map(file => ({ kind: 'export_file', merchantId: state.merchant.id, sourceId: file.id, version: file.updatedAt, createdAt: '2026-08-02T00:00:00.000Z', label: 'Private export file', digest: 'd'.repeat(64), status: 'ready' }));
  const view = lifecycleView(state, ctx, external()), target = (id: string) => view.targets.find(item => item.sourceId === id)!;
  assert.deepEqual(target(caseFile.id).evidence, [{ reason: 'open_case', recordId: openCase.id }], 'an export linked to an open case says so'); checks += 1;
  assert.deepEqual(target(reviewFile.id).evidence, [{ reason: 'approved_close_review', recordId: review.id }], 'the reviewed-close export of an approved review says so'); checks += 1;
  check(target(plainFile.id).evidence.length === 0 && target(batch.id).evidence.length === 0, 'other sources carry no evidence reason');
  check(view.eligibleCount === 2 && view.evidenceTotal === 2, 'evidence files are not eligible; the raw CSV and the unlinked export are');
  const run = preview(state, external());
  assert.deepEqual(run.candidates.map(candidate => candidate.sourceId).sort(), [batch.id, plainFile.id].sort(), 'a preview leaves evidence out'); checks += 1;
  // Linked as evidence after the preview, approval is refused; after the approval, the executor's check blocks deletion.
  caseData.evidenceIds = [caseFile.id, plainFile.id];
  refuses(() => approve(state, run, external()), 409);
  caseData.evidenceIds = [caseFile.id];
  const approved = approve(state, preview(state, external()), external()), file = approved.candidates.find(candidate => candidate.sourceId === plainFile.id)!;
  caseData.evidenceIds = [caseFile.id, plainFile.id];
  refuses(() => assertLifecycleCandidate(state, ctx, approved.id, file, external()), 409);
  // A resolved case no longer keeps its evidence; an approved review's export stays evidence.
  openCase.status = 'resolved';
  const after = lifecycleView(state, ctx, external());
  check(after.targets.every(item => item.sourceId === reviewFile.id || item.evidence.length === 0) && after.evidenceTotal === 1, 'resolving the case releases its evidence');
  check(assertLifecycleCandidate(state, ctx, approved.id, file, external()), 'and the approved file may then be deleted');
}
{
  // A staff pilot (audit decision): the administrator who prepared a preview cannot approve it, and a policy keeps the
  // documented minimums: six years for original source files and export files, which are evidence, and a year for recovery payloads.
  const first = { ...ctx, principalId: 'principal:admin', accessMode: 'staff' as const }, second = { actor: 'Clerk:second', principalId: 'principal:second', role: 'Admin', now: ctx.now, accessMode: 'staff' as const };
  const { state, batch } = fixture('staff-approval');
  batch.data.committedAt = '2019-09-01T10:00:00.000Z';
  const save = (actor: typeof first, days: RetentionPolicy) => saveLifecyclePolicy(state, actor, { policy: days, expectedRevision: lifecyclePolicy(state).revision, reason: 'Agreed source retention for the staff rehearsal.' });
  assert.throws(() => save(first, policy), (error: any) => error.status === 400 && /original import files and export files for at least 2,192 days \(six years\)/.test(error.message)); checks += 1;
  assert.throws(() => save(first, { ...policy, rawCsvDays: 2192, exportFileDays: 2192 }), (error: any) => error.status === 400 && /saved request details for at least 366 days/.test(error.message)); checks += 1;
  save(first, { rawCsvDays: 2192, journalPayloadDays: 366, exportFileDays: null, auditTrail: 'retain' });
  const view = lifecycleView(state, first);
  check(view.secondApprover === true && view.minimumDays?.rawCsvDays === 2192 && view.minimumDays?.journalPayloadDays === 366 && view.minimumDays?.exportFileDays === 2192, 'the view names the staff minimums and the second approver');
  const run = lifecyclePreview(state, first, { expectedPolicyRevision: lifecyclePolicy(state).revision });
  check(run.preparedBy === 'Clerk:admin', 'the run names who prepared it');
  const approval = { expectedUpdatedAt: run.updatedAt, previewDigest: run.previewDigest, reason: 'Reviewed the exact eligible sample source artifacts.' };
  assert.throws(() => approveLifecycleRun(state, first, run.id, approval), (error: any) => error.status === 403 && /A different Admin must approve this deletion run/.test(error.message)); checks += 1;
  // The same person in another session is still the preparer: the verified staff actor decides.
  refuses(() => approveLifecycleRun(state, { ...first, principalId: 'principal:another-session' }, run.id, approval), 403);
  check(approveLifecycleRun(state, second, run.id, approval).approvedBy === 'Clerk:second', 'a second administrator approves it');
}
{
  // The sandbox keeps 30 days in every category: a one-day policy is refused, and one stored before the minimum existed is read with it.
  const { state, batch } = fixture('sandbox-minimum');
  assert.throws(() => saveLifecyclePolicy(state, ctx, { policy: { ...policy, rawCsvDays: 1 }, expectedRevision: lifecyclePolicy(state).revision, reason: 'Delete sample sources the next day.' }), (error: any) => error.status === 400 && /each category for at least 30 days, the time an inactive sandbox is kept/.test(error.message)); checks += 1;
  check(lifecycleView(state, ctx).secondApprover === false && lifecycleView(state, ctx).minimumDays?.rawCsvDays === 30, 'the sandbox explains the rule without a second approver');
  makeRecord(state, 'retention-policies', { name: 'Retention policy saved', status: 'recorded', createdAt: '2026-09-01T10:00:00.000Z', data: { policy: { ...policy, rawCsvDays: 1 }, actor: ctx.actor, reason: 'Saved before the minimum.', sequence: 1 } });
  batch.data.committedAt = '2026-09-15T10:00:00.000Z';
  check(lifecycleView(state, ctx).eligibleCount === 0, 'a stored one-day policy deletes nothing younger than 30 days');
  batch.data.committedAt = '2026-08-20T10:00:00.000Z';
  check(lifecycleView(state, ctx).eligibleCount === 1, 'and a source older than 30 days stays eligible');
  // One person plays every role in the sandbox, so the preparer may approve there.
  const run = preview(state);
  check(approve(state, run).status === 'approved' && run.preparedBy === ctx.actor, 'the sandbox preparer approves their own preview');
}
console.log(`Lifecycle retention: ${checks} checks passed.`);
