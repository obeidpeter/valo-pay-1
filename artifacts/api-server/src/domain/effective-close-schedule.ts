import { closeSchedule } from "./close";
import type { DomainState } from "./types";

/**
 * Only process health is exposed here; no other lender's runs or errors. `external`: this process runs no scheduled
 * close because a separate scheduled job does (VALO_PAY_1_CLOSE_SCHEDULER=external), which it cannot observe.
 */
export interface CloseRuntime {
  state: "not_started" | "running" | "off" | "external" | "stopped";
  intervalMs: number | null;
  lastTickAt: string | null;
  lastSuccessAt?: string | null;
  lastErrorAt?: string | null;
  /** Clock from the process that owns this heartbeat, separate from the database schedule clock. */
  observedAt?: string;
}

/** A requested lender schedule is effective only while its service is healthy. */
export function effectiveCloseSchedule(state: DomainState, now: string, runtime: CloseRuntime) {
  const schedule = closeSchedule(state, now);
  const lastSuccessAt = runtime.lastSuccessAt ?? null;
  const failed = Boolean(runtime.lastErrorAt && (!lastSuccessAt || runtime.lastErrorAt >= lastSuccessAt));
  const stale = lastSuccessAt !== null && Date.parse(runtime.observedAt ?? now) - Date.parse(lastSuccessAt) > Math.max(120_000, (runtime.intervalMs ?? 60_000) * 3);
  const serviceIssue = runtime.state !== "running" ? null : failed ? "failed" : !lastSuccessAt ? "starting" : stale ? "delayed" : null;
  const automatic = schedule.enabled && runtime.state === "running" && serviceIssue === null;
  return {
    ...schedule,
    runtimeState: runtime.state,
    automatic,
    nextAt: automatic ? schedule.nextAt : null,
    // A retry time is a promise of an automatic attempt, so it is shown only while one can run.
    retryAt: automatic ? schedule.retryAt : null,
    // Preserve overdue work when the service is unhealthy or its closes run from a separate job, as for a running
    // service, but not when scheduling is deliberately off: nobody runs automatic closes there.
    missed: schedule.missed && runtime.state !== "off",
    serviceIssue,
    lastCheckedAt: lastSuccessAt,
    lastErrorAt: runtime.lastErrorAt ?? null,
  };
}
