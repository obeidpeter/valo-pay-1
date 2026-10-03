import type { Logger } from 'pino';
import { exportJobRepository } from './export-job-store';
import { EXPORT_CONCURRENCY, processExportJob, type ExportAttemptResult, type ExportJobRepository, type ExportJobStorage, type ClaimedExport, type ExportArtifact, type ExportQueueCursor } from './export-jobs';
import { exportJobStorage, generateExportArtifact } from './valo-pay-1-exports';

export interface ExportQueueScan { after?: ExportQueueCursor; through?: ExportQueueCursor }
type Dependencies = { repository?: ExportJobRepository; storage?: ExportJobStorage; generate?: (claim: ClaimedExport, signal?: AbortSignal) => Promise<{ bytes: Buffer; artifact: ExportArtifact }>; log?: Logger; signal?: AbortSignal; scan?: ExportQueueScan };
/** At most two generation/uploads per process. Durable queue rows, not in-memory promises, own outstanding work. */
export async function runExportPass(deps: Dependencies = {}) {
  if (deps.signal?.aborted) return [];
  const repository = deps.repository || exportJobRepository;
  const scan = deps.scan ?? {};
  // A fixed high-water mark makes each sweep finite even if new jobs keep
  // arriving. Reaching it wraps to earlier busy lenders; the next sweep then
  // includes arrivals. Every page reads at most twenty jobs, with no OFFSET.
  scan.through ??= await repository.queueEnd();
  let targets = await repository.candidates(20, scan.after, scan.through);
  if (!targets.length && scan.after) {
    scan.after = undefined;
    scan.through = await repository.queueEnd();
    targets = await repository.candidates(20, undefined, scan.through);
  }
  const last = targets.at(-1);
  const atEnd = last && scan.through && last.createdAt === scan.through.createdAt && last.id === scan.through.id;
  scan.after = targets.length === 20 && last && !atEnd ? { createdAt: last.createdAt, id: last.id } : undefined;
  if (!scan.after) scan.through = undefined;
  const results: ExportAttemptResult[]=[];
  let next=0;
  await Promise.all(Array.from({length:EXPORT_CONCURRENCY},async()=>{
   while(next<targets.length && !deps.signal?.aborted){
    const target=targets[next++]!;
    try {
      const status = await processExportJob(repository, deps.storage || exportJobStorage, deps.generate || generateExportArtifact, target, { signal: deps.signal });
      deps.log?.info({ event: 'export.job', exportId: target.id, status }, 'Export worker attempt completed');
      results.push(status);
    } catch (error) {
      deps.log?.error({ event: 'export.worker_error', exportId: target.id, err: error }, 'Export worker could not claim a job');
      results.push('failed');
    }
   }
  }));
  return results;
}
/** The longest wait between looks at a queue that keeps failing. */
export const EXPORT_QUEUE_MAX_BACKOFF_MS = 60_000;
/** The wait before the next look at the queue: the interval while it answers; after n failed looks in a row, the interval doubled n times, at most the maximum. */
export function exportQueueDelay(failures: number, intervalMs: number, maxBackoffMs = EXPORT_QUEUE_MAX_BACKOFF_MS): number {
  return failures ? Math.max(intervalMs, Math.min(maxBackoffMs, intervalMs * 2 ** Math.min(failures, 30))) : intervalMs;
}
/**
 * Looks at the queue now and then after each pass. While the queue cannot be
 * read (the database unavailable, say) the looks slow down (exportQueueDelay)
 * and the log has two lines, not one per look: export.queue_error when the
 * first look fails and export.queue_recovered when one succeeds again.
 * stop() cancels the attempts in progress, which hand their jobs back to the
 * queue; settle() waits for those writes.
 */
export function startExportWorker(deps: Dependencies & { intervalMs?: number; maxBackoffMs?: number } = {}) {
  const cancellation = new AbortController();
  const scan = deps.scan ?? {};
  const intervalMs = deps.intervalMs ?? 1500, maxBackoffMs = deps.maxBackoffMs ?? EXPORT_QUEUE_MAX_BACKOFF_MS;
  let running: Promise<unknown> | null = null, stopped = false, failures = 0, failingSince = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => { void tick(); }, exportQueueDelay(failures, intervalMs, maxBackoffMs));
    timer.unref();
  };
  const tick = () => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = runExportPass({ ...deps, scan, signal: deps.signal ? AbortSignal.any([deps.signal, cancellation.signal]) : cancellation.signal })
      .then(() => {
        if (failures) deps.log?.info({ event: 'export.queue_recovered', failures, unavailableMs: Date.now() - failingSince }, 'Export queue can be checked again');
        failures = 0;
      }, error => {
        if (!failures) {
          failingSince = Date.now();
          deps.log?.error({ event: 'export.queue_error', err: error, retryInMs: exportQueueDelay(1, intervalMs, maxBackoffMs) }, 'Export queue could not be checked; looking again less often until it answers');
        }
        failures += 1;
      })
      .finally(() => { running = null; schedule(); });
    return running;
  };
  void tick();
  return { stop: () => { stopped = true; clearTimeout(timer); cancellation.abort(new Error('Export worker is stopping.')); }, settle: async () => { await running; }, tick };
}
