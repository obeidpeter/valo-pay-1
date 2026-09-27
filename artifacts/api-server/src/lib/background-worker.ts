import { Worker, type WorkerOptions } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import type { Logger } from "pino";
import { closeRules } from "@workspace/valopay-schema";
import { applySchedulerEvent, type SchedulerEvent } from "./close-scheduler";
import { EXPORT_CONCURRENCY } from "./export-jobs";
import { writeLogLine, type LogLineMessage } from "./logger";

declare const __VALOPAY_BACKGROUND_ENTRY__: string | undefined;

/**
 * The background worker thread's own database connections: one for the
 * scheduled close, which closes one lender at a time (or, where a scheduled
 * job runs the closes, reads what is still owed), and one for each export
 * slot. Cleanup shares this bound for its short, timed transactions and holds
 * no connection during private-storage I/O. With the request pool (VALOPAY_DATABASE_POOL_SIZE) and readiness's one
 * connection, an API process holds at most that size plus four.
 */
export const BACKGROUND_POOL_SIZE = 1 + EXPORT_CONCURRENCY;
/** The wait before a thread that crashed starts again; it doubles with each crash in a row, up to the maximum. */
export const BACKGROUND_RESTART_MS = 1_000;
export const BACKGROUND_MAX_RESTART_MS = 60_000;
/** A thread that ran this long before it crashed starts its waits again from the first. */
export const BACKGROUND_STEADY_MS = 60_000;

/** What the thread runs, sent as its workerData with its name (`thread`, by which its logger writes through this thread). */
export interface BackgroundOptions {
  /** The scheduled daily close, with its options (tests narrow it to their own lenders), or null when this process schedules none. */
  closes: { intervalMs?: number; firstDelayMs?: number; batchSize?: number; budgetMs?: number; onlyMerchantIds?: string[] } | null;
  /** Where a scheduled job runs the closes (VALOPAY_CLOSE_SCHEDULER=external), the read of what is still owed at the scheduler's interval (startBacklogWatch), with its options; null or absent otherwise. */
  backlog?: { intervalMs?: number; firstDelayMs?: number; onlyMerchantIds?: string[] } | null;
  /** The export worker, with its options, or null (tests of the close alone). */
  exports: { intervalMs?: number; maxBackoffMs?: number } | null;
  /** Service-only expired sandbox file cleanup, sharing the bounded background pool. */
  cleanup?: { intervalMs?: number } | null;
}
/** What the thread posts to the main thread: a log line to write, or a change of the scheduler's state. */
export type BackgroundMessage = LogLineMessage | { type: "scheduler"; event: SchedulerEvent };
/** What the main thread posts to the thread: stop, or run a lender's daily audit check after a person's close. */
export type BackgroundRequest = { type: "stop" } | { type: "audit_check"; merchantId: string };

/** The thread now running, which a person's close asks for the lender's daily audit check. */
let running: Worker | undefined;
/**
 * Asks the background worker thread to check the lender's whole audit chain,
 * as it does after a scheduled close, once a person's close has committed:
 * the day's check runs on the thread, never on the thread that answers
 * requests. Nothing is asked while no thread runs (a process that runs none,
 * or one waiting to start again after a crash): the lender's next close asks
 * again. Returns whether the thread was asked.
 */
export function requestDailyAuditCheck(merchantId: string): boolean {
  if (!running) return false;
  running.postMessage({ type: "audit_check", merchantId } satisfies BackgroundRequest);
  return true;
}

/** The running thread, as the process's shutdown sees it. */
export interface BackgroundWorker {
  /** Asks the thread to stop: nothing new starts, the lender close in progress finishes, unfinished exports return to the queue and its pool ends. A thread waiting to start again after a crash is not started. */
  stop(): void;
  /** Resolves once the thread has ended after stop(). */
  settle(): Promise<void>;
}

/** The wait before the thread starts again after `crashes` crashes in a row, the first included. */
export function backgroundRestartDelay(crashes: number, firstMs = BACKGROUND_RESTART_MS, maxMs = BACKGROUND_MAX_RESTART_MS): number {
  return Math.min(maxMs, firstMs * 2 ** Math.min(Math.max(crashes - 1, 0), 30));
}

/** The thread's entry: dist/background.mjs beside the bundle (build.mjs names it), or background.ts in the source tree. */
function backgroundEntry(): URL {
  return new URL(typeof __VALOPAY_BACKGROUND_ENTRY__ === "string" ? __VALOPAY_BACKGROUND_ENTRY__ : "../background.ts", import.meta.url);
}

const tsxFile = /[\\/]tsx[\\/]dist[\\/](?:loader\.mjs|preflight\.cjs)$/;
/**
 * Starts a TypeScript entry from the source tree, as the tests run the API
 * under tsx. Node passes tsx's loader on to worker threads only from 22.22.3
 * and 24.11.1, so the thread starts without tsx's flags and registers the
 * loader itself, once, whatever the version. Undefined for anything else.
 */
function sourceWorker(entry: URL, options: WorkerOptions): Worker | undefined {
  const loader = process.execArgv.find((arg) => /[\\/]tsx[\\/]dist[\\/]loader\.mjs$/.test(arg));
  if (!loader || !entry.pathname.endsWith(".ts")) return undefined;
  const api = new URL("esm/api/index.mjs", /^file:/.test(loader) ? loader : pathToFileURL(loader)).href;
  const start = `const tsx = await import(${JSON.stringify(api)}); tsx.register(); await import(${JSON.stringify(entry.href)});`;
  const execArgv = process.execArgv.filter((arg, index, all) => !tsxFile.test(arg) && !tsxFile.test(all[index + 1] ?? ""));
  return new Worker(new URL(`data:text/javascript,${encodeURIComponent(start)}`), { ...options, execArgv });
}

/**
 * Starts the background worker thread (background.ts) and looks after it.
 * The thread's log lines are written here, and its scheduler changes applied
 * to the state /api/healthz and the console read. A thread that crashes is
 * logged (`background.crashed`) and started again after a wait that doubles
 * with each crash in a row, from a second to a minute; meanwhile the
 * scheduler's state records the failure, so the console stops advertising
 * the next automatic close. The API itself carries on. `entry` and the waits
 * are for tests.
 */
export function startBackgroundWorker(options: BackgroundOptions & { log: Logger; entry?: URL; restartMs?: number; maxRestartMs?: number; steadyMs?: number }): BackgroundWorker {
  const { log } = options, entry = options.entry ?? backgroundEntry();
  const workerData: BackgroundOptions & { thread: "background" } = { thread: "background", closes: options.closes, backlog: options.backlog ?? null, exports: options.exports };
  // The database module sizes its pool from this setting when the thread loads it: the thread's pool, not the requests'.
  const settings: WorkerOptions = { workerData, env: { ...process.env, VALOPAY_DATABASE_POOL_SIZE: String(BACKGROUND_POOL_SIZE) } };
  let current: Worker | undefined, restart: ReturnType<typeof setTimeout> | undefined;
  let stopping = false, crashes = 0;
  let ended!: () => void;
  const settled = new Promise<void>((resolve) => { ended = resolve; });

  /** Logs a thread that ended unasked, or could not start, and starts another after the wait. */
  const crashed = (err: unknown, exitCode: number | undefined, startedAt: number) => {
    if (Date.now() - startedAt >= (options.steadyMs ?? BACKGROUND_STEADY_MS)) crashes = 0;
    crashes += 1;
    const retryInMs = backgroundRestartDelay(crashes, options.restartMs, options.maxRestartMs);
    log.error({ event: "background.crashed", err, exitCode, durationMs: Date.now() - startedAt, crashes, retryInMs }, "The background worker thread crashed; starting it again after a wait");
    if (options.closes) applySchedulerEvent({ type: "failed", at: new Date().toISOString() });
    restart = setTimeout(spawn, retryInMs);
    restart.unref();
  };
  // The scheduler counts as started with its thread, as it did in the process, rather than as not started while the
  // thread loads; the thread reports the same when its scheduler starts.
  if (options.closes) applySchedulerEvent({ type: "started", intervalMs: options.closes.intervalMs ?? closeRules.tickSeconds * 1000 });
  // Likewise where the thread reads what is still owed instead: the health answer says how often from the start.
  if (options.backlog) applySchedulerEvent({ type: "external", intervalMs: options.backlog.intervalMs ?? closeRules.tickSeconds * 1000 });
  function spawn(): void {
    restart = undefined;
    const startedAt = Date.now();
    let worker: Worker, failure: unknown;
    // A thread Node refuses to start (an execArgv flag threads do not take, say) is a crash like any other.
    try { worker = sourceWorker(entry, settings) ?? new Worker(entry, settings); }
    catch (error) { crashed(error, undefined, startedAt); return; }
    current = running = worker;
    worker.on("message", (message: BackgroundMessage) => {
      if (message?.type === "log") writeLogLine(message.line);
      else if (message?.type === "scheduler") applySchedulerEvent(message.event);
    });
    // An exception nothing in the thread caught ends the thread, never the process: it is heard here, then 'exit' follows.
    worker.on("error", (error) => { failure = error; });
    worker.on("exit", (exitCode) => {
      current = undefined;
      if (running === worker) running = undefined;
      const err = failure ?? (exitCode ? new Error(`The background worker thread exited with status ${exitCode}.`) : new Error("The background worker thread ended without being asked to stop."));
      if (!stopping) return crashed(err, exitCode, startedAt);
      if (failure || exitCode) log.error({ event: "background.crashed", err, exitCode, durationMs: Date.now() - startedAt }, "The background worker thread failed while it stopped");
      else log.info({ event: "background.stopped", durationMs: Date.now() - startedAt }, "Background worker thread stopped");
      ended();
    });
    log.info({ event: "background.started", threadId: worker.threadId, closes: options.closes !== null, backlog: Boolean(options.backlog), exports: options.exports !== null, poolSize: BACKGROUND_POOL_SIZE, crashes }, "Background worker thread started");
  }
  spawn();

  return {
    stop() {
      if (stopping) return;
      stopping = true;
      if (running === current) running = undefined;
      if (current) { current.postMessage({ type: "stop" } satisfies BackgroundRequest); return; }
      // Waiting to start again after a crash: nothing runs, so nothing is left to stop.
      clearTimeout(restart);
      if (options.closes) applySchedulerEvent({ type: "stopped" });
      ended();
    },
    settle: () => settled,
  };
}
