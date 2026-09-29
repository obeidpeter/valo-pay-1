/** Process-local observations only: no database, tenant identifiers, storage paths or error bodies. */
export const BACKGROUND_HEARTBEAT_MS = 10_000;
export const BACKGROUND_STALE_MS = 45_000;
export const EXPORT_CLEANUP_INTERVAL_MS = 60_000;
export type CleanupResult = { attempted: number; removed: number; deferred: number; pendingFailures: number };
export type BackgroundObservation = { type: "heartbeat" } | { type: "cleanup"; result: CleanupResult | null };
type Jobs = { closes: boolean; backlog: boolean; exports: boolean; cleanup: boolean };
type Lifecycle = "not_started" | "starting" | "running" | "restarting" | "stopping" | "stopped";

/** The main thread timestamps received messages, so a blocked thread cannot keep its own heartbeat fresh. */
export function createBackgroundHealth(clock: () => number = Date.now) {
  let lifecycle: Lifecycle = "not_started", jobs: Jobs = { closes: false, backlog: false, exports: false, cleanup: false };
  let starts = 0, crashCount = 0, startedAt: number | null = null, heartbeatAt: number | null = null, crashAt: number | null = null;
  let cleanupInterval: number | null = null, checkedAt: number | null = null, successAt: number | null = null, errorAt: number | null = null;
  let lastResult: CleanupResult | null = null, cleanupFailed = false, currentCheck = false;
  const iso = (at: number | null) => at === null ? null : new Date(at).toISOString();
  return {
    configure(enabled: Jobs, intervalMs = EXPORT_CLEANUP_INTERVAL_MS) { jobs = { ...enabled }; cleanupInterval = jobs.cleanup ? intervalMs : null; },
    starting() { lifecycle = "starting"; starts += 1; startedAt = clock(); heartbeatAt = null; currentCheck = false; },
    crashed() { lifecycle = "restarting"; crashCount += 1; crashAt = clock(); },
    stopping() { lifecycle = "stopping"; },
    stopped() { lifecycle = "stopped"; },
    observe(message: BackgroundObservation) {
      if (lifecycle !== "starting" && lifecycle !== "running") return;
      if (message.type === "heartbeat") { heartbeatAt = clock(); lifecycle = "running"; }
      else if (jobs.cleanup) {
        checkedAt = clock(); currentCheck = true; lastResult = message.result ? { attempted: message.result.attempted, removed: message.result.removed, deferred: message.result.deferred, pendingFailures: message.result.pendingFailures } : null;
        cleanupFailed = !message.result || message.result.deferred > 0 || message.result.pendingFailures > 0;
        if (cleanupFailed) errorAt = checkedAt;
        else successAt = checkedAt;
      }
    },
    status() {
      const now = clock(), origin = heartbeatAt ?? startedAt;
      const state = (lifecycle === "running" || lifecycle === "starting") && origin !== null && now - origin > BACKGROUND_STALE_MS ? "stale" : lifecycle;
      // Cleanup has one bounded pass in flight, then waits its interval. Allow three intervals plus startup margin.
      const cleanupStaleAfterMs = cleanupInterval === null ? null : 3 * cleanupInterval + 15_000;
      const cleanupOrigin = currentCheck ? checkedAt : startedAt;
      const cleanupState = !jobs.cleanup ? "disabled" : cleanupOrigin !== null && now - cleanupOrigin > cleanupStaleAfterMs! ? "stale"
        : !currentCheck ? "pending" : cleanupFailed ? "failed" : "ok";
      return {
        state, jobs: { ...jobs }, heartbeatIntervalMs: BACKGROUND_HEARTBEAT_MS, staleAfterMs: BACKGROUND_STALE_MS,
        startedAt: iso(startedAt), lastHeartbeatAt: iso(heartbeatAt), crashCount, restartCount: Math.max(0, starts - 1), lastCrashAt: iso(crashAt),
        cleanup: { state: cleanupState, intervalMs: cleanupInterval, staleAfterMs: cleanupStaleAfterMs, lastCheckedAt: iso(checkedAt), lastSuccessAt: iso(successAt), lastErrorAt: iso(errorAt), lastResult: lastResult ? { ...lastResult } : null },
      };
    },
  };
}

/** Shared by the supervisor and /healthz; importing it starts no worker or timers. */
export const backgroundHealth = createBackgroundHealth();
