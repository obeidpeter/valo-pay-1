import { runExportCleanupPass, exportCleanupStatus } from './valo-pay-1-store';
import { EXPORT_CLEANUP_INTERVAL_MS, type CleanupResult } from './background-health';

/** Retry committed sandbox cleanup independently of new visitors. One bounded pass at a time; shutdown waits
 * for the current guarded removal only. Unfinished work remains in PostgreSQL for this or another instance. */
export function startExportCleanupWorker(options: { intervalMs?: number; log?: { warn(fields: object, message: string): void }; observed?: (result: CleanupResult | null) => void } = {}, runPass = runExportCleanupPass, readStatus: () => Promise<{ failed: number; parked?: number }> = exportCleanupStatus) {
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> = Promise.resolve();
  const tick = () => {
    if (stopped) return;
    const observed = (result: CleanupResult | null) => { try { options.observed?.(result); } catch { /* Observability never changes cleanup or its retries. */ } };
    active = runPass({ stopped: () => stopped, log: options.log }).then(async (result) => {
      // A quiet due poll cannot clear a failed file waiting in backoff, nor one parked for an operator's review, which
      // is counted apart. Read aggregate durable evidence, with the repository's normal bounded service transaction;
      // no connection is held during the removal above.
      const status = await readStatus();
      observed({ ...result, pendingFailures: status.failed, ...(status.parked === undefined ? {} : { parked: status.parked }) });
    }).catch(() => {
      observed(null);
      options.log?.warn({ event: 'workspace.sweep_cleanup_unavailable' }, 'Private export cleanup could not run; its queued files will be retried');
    }).finally(() => { if (!stopped) { timer = setTimeout(tick, options.intervalMs ?? EXPORT_CLEANUP_INTERVAL_MS); timer.unref(); } });
  };
  tick();
  return { stop() { stopped = true; if (timer) clearTimeout(timer); }, settle: () => active };
}
