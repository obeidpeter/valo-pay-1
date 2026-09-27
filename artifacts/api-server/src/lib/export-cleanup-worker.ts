import { runExportCleanupPass } from './valopay-store';

/** Retry committed sandbox cleanup independently of new visitors. One bounded pass at a time; shutdown waits
 * for the current guarded removal only. Unfinished work remains in PostgreSQL for this or another instance. */
export function startExportCleanupWorker(options: { intervalMs?: number; log?: { warn(fields: object, message: string): void } } = {}) {
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> = Promise.resolve();
  const tick = () => {
    if (stopped) return;
    active = runExportCleanupPass({ stopped: () => stopped, log: options.log }).then(() => undefined).catch(() => {
      options.log?.warn({ event: 'workspace.sweep_cleanup_unavailable' }, 'Private export cleanup could not run; its queued files will be retried');
    }).finally(() => { if (!stopped) { timer = setTimeout(tick, options.intervalMs ?? 60_000); timer.unref(); } });
  };
  tick();
  return { stop() { stopped = true; if (timer) clearTimeout(timer); }, settle: () => active };
}
