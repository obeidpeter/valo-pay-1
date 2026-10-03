// Executing an approved retention run (23 September 2026 audit, item 10): one
// request removes source after source until the run completes, a source is
// blocked or its deletion fails, or its time budget is spent; each source is
// checked again just before it goes and gets its own receipt.
import assert from 'node:assert/strict';
import type { LifecycleCandidate, LifecycleExternalCandidate } from '@workspace/valo-pay-1-schema';
import { seedMerchant } from '../src/lib/valo-pay-1-seed';
import { makeRecord } from '../src/domain/records';
import { approveLifecycleRun, lifecycleHolds, lifecyclePolicy, lifecyclePreview, saveLifecyclePolicy, setLifecycleHold } from '../src/domain/lifecycle';
import { executeApprovedRun, LIFECYCLE_STEP_BUDGET_MS } from '../src/domain/lifecycle-run';
import type { DomainState } from '../src/domain/types';

const ctx = { actor: 'Clerk:admin', role: 'Admin', now: '2026-09-25T10:00:00.000Z' };
let checks = 0;
const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks += 1; };
/** A lender with `count` committed batches old enough for a 30-day raw CSV policy, and that policy saved. */
function lender(id: string, count: number) {
  const state = seedMerchant(id, true);
  const batches = Array.from({ length: count }, (_, i) => makeRecord(state, 'import-batches', { name: `Imported source ${i + 1}`, status: 'committed', createdAt: `2026-08-01T10:00:0${i}.000Z`, updatedAt: `2026-08-01T10:00:0${i}.000Z`, data: { csv: `reference,name\nROW-${i},Synthetic person ${i}`, committedAt: `2026-08-01T10:00:0${i}.000Z`, rowIds: [`ROW-${i}`], recordIds: [`financial-${i}`], source: 'lms', sourceBatchId: `feed-${i}`, check: { valid: 1, invalid: 0, imported: 1, rows: [], preview: [{ row: 2, values: { reference: `ROW-${i}` } }] } } }));
  saveLifecyclePolicy(state, ctx, { policy: { rawCsvDays: 30, journalPayloadDays: 30, exportFileDays: 30, auditTrail: 'retain' }, expectedRevision: lifecyclePolicy(state).revision, reason: 'Agreed source retention for the synthetic rehearsal.' });
  return { state, batches };
}
function approved(state: DomainState, external: LifecycleExternalCandidate[] = []) {
  const run = lifecyclePreview(state, ctx, { expectedPolicyRevision: lifecyclePolicy(state).revision }, external);
  return approveLifecycleRun(state, ctx, run.id, { expectedUpdatedAt: run.updatedAt, previewDigest: run.previewDigest, reason: 'Reviewed the exact eligible sample source artifacts.' }, external);
}
const hold = (state: DomainState, sourceId: string, held: boolean) => setLifecycleHold(state, ctx, { kind: 'raw_csv', sourceId, held, expectedHoldRevision: lifecycleHolds(state).revision, reason: held ? 'Keep this source for an unresolved sample case.' : 'The sample case is resolved; release the source.' });
const unexpected = async (): Promise<'deleted'> => { throw new Error('Only raw CSV sources are in this run.'); };
const csvLeft = (batches: Array<{ data: Record<string, unknown> }>) => batches.filter(batch => typeof batch.data.csv === 'string').length;

{
  // Within its budget one request removes every source of the run; it used to remove one and stop.
  const { state, batches } = lender('run-whole', 3), run = approved(state);
  const result = await executeApprovedRun(state, ctx, run.id, [], unexpected);
  check(result.status === 'completed' && result.successful === 3 && result.remaining === 0, 'one request completes a three-source run');
  check(csvLeft(batches) === 0 && result.receipts.every(receipt => receipt.status === 'deleted'), 'each source is removed with its own receipt');
  check(LIFECYCLE_STEP_BUDGET_MS > 0 && LIFECYCLE_STEP_BUDGET_MS <= 2_000, 'the budget stays well inside the 5 s other requests wait for the lender');
  const again = await executeApprovedRun(state, ctx, run.id, [], unexpected);
  check(again.status === 'completed' && again.receipts.length === 3, 'executing a completed run changes nothing');
}
{
  // A spent budget answers with the run still running; the next request carries on where it stopped.
  const { state, batches } = lender('run-budget', 3), run = approved(state);
  const first = await executeApprovedRun(state, ctx, run.id, [], unexpected, { budgetMs: 0 });
  check(first.status === 'running' && first.successful === 1 && csvLeft(batches) === 2, 'with no budget left after the first source, the request answers');
  const second = await executeApprovedRun(state, ctx, run.id, [], unexpected, { budgetMs: 0 });
  check(second.successful === 2 && second.receipts.length === 2, 'the next request removes the next source, not the first again');
  const clock = [0, 10, 20, 30];
  const last = await executeApprovedRun(state, ctx, run.id, [], unexpected, { budgetMs: 15, clock: () => clock.shift() ?? 99 });
  check(last.status === 'completed' && last.successful === 3, 'and the last completes the run');
}
{
  // A blocked source stops the run with its reason: the sources after it wait until it is resolved.
  const { state, batches } = lender('run-blocked', 3), run = approved(state);
  hold(state, run.candidates[1]!.sourceId, true);
  const stopped = await executeApprovedRun(state, ctx, run.id, [], unexpected);
  check(stopped.status === 'attention' && stopped.successful === 1 && stopped.receipts.length === 2, 'the source before is removed, the held one is blocked and the one after is not attempted');
  const blocked = stopped.receipts.find(receipt => receipt.status === 'blocked')!;
  check(blocked.sourceId === run.candidates[1]!.sourceId && /is on hold/.test(blocked.detail), 'the blocked receipt names the source and says why');
  check(csvLeft(batches) === 2, 'nothing held or unattempted was removed');
  hold(state, run.candidates[1]!.sourceId, false);
  const resumed = await executeApprovedRun(state, ctx, run.id, [], unexpected);
  check(resumed.status === 'completed' && resumed.successful === 3 && csvLeft(batches) === 0, 'resumed once the hold is released, the run completes');
  check(resumed.receipts.find(receipt => receipt.sourceId === run.candidates[1]!.sourceId)!.status === 'deleted', 'the source that was blocked is removed last');
}
{
  // A deletion that cannot be confirmed stops the run as failed; a database error ends the request instead.
  const { state } = lender('run-external', 1);
  const external: LifecycleExternalCandidate[] = ['file-a', 'file-b'].map(sourceId => ({ kind: 'export_file', merchantId: state.merchant.id, sourceId, version: 'generation-1', createdAt: '2026-08-02T10:00:00.000Z', label: 'Private export file', digest: 'd'.repeat(64), status: 'ready' }));
  const run = approved(state, external), removed: string[] = [];
  const failing = async (candidate: LifecycleCandidate): Promise<'deleted'> => { removed.push(candidate.sourceId); throw new Error('Storage timed out.'); };
  const failed = await executeApprovedRun(state, ctx, run.id, external, failing);
  check(failed.status === 'attention' && failed.receipts.some(receipt => receipt.status === 'failed' && /could not confirm the deletion/.test(receipt.detail)), 'a failed deletion is recorded and stops the run');
  check(removed.length === 1, 'nothing after the failed source is attempted');
  const fatal = Object.assign(new Error('could not serialize access'), { code: '40001' });
  await assert.rejects(executeApprovedRun(state, ctx, run.id, external, async () => { throw fatal; }, { fatal: error => (error as { code?: unknown }).code === '40001' }), error => error === fatal);
  checks += 1;
  const absent = await executeApprovedRun(state, ctx, run.id, external, async () => 'already_absent');
  check(absent.status === 'completed' && absent.receipts.filter(receipt => receipt.status === 'already_absent').length === 2, 'a file already gone completes as already absent');
}
{
  // The sources are checked once per request: each batch's CSV is read a few times, however many sources the run has.
  const { state, batches } = lender('run-reads', 9), run = approved(state);
  const reads = new Map<string, number>();
  for (const batch of batches) {
    let csv = batch.data.csv as string | undefined;
    Object.defineProperty(batch.data, 'csv', { configurable: true, enumerable: true, get() { reads.set(batch.id, (reads.get(batch.id) ?? 0) + 1); return csv; }, set(value) { csv = value; } });
  }
  const result = await executeApprovedRun(state, ctx, run.id, [], unexpected);
  check(result.status === 'completed', 'the nine-source run completes');
  const counts = [...reads.values()];
  check(counts.length === 9 && Math.max(...counts) === Math.min(...counts) && Math.max(...counts) < 9, `every batch's CSV is read the same few times (${counts.join(', ')}), not again for every other source removed`);
}

console.log(`Retention run execution checks passed (${checks} checks).`);
