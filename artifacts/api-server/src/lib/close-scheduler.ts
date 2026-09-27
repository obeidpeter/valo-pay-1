/**
 * REC-01: the daily close runs at each merchant's configured WAT time.  This
 * scheduler, which the API runs on its background worker thread
 * (background.ts) so a long close never holds up a request, looks for due
 * closes every tick and runs each one in its own system transaction through
 * the scoped repository, so a close never bypasses the tenant predicate or the
 * merchant lock, and one lender's failure never touches another.  A close
 * missed while the process was down runs at the first tick after recovery and
 * is recorded as late (NFR-AVA-02); when several business dates were missed,
 * each gets its own catch-up close, one per pass, oldest first.  Every run
 * carries a correlation id in its log lines (NFR-OBS-01).
 *
 * A pass reads due lenders in batches until none is left or its time budget
 * is spent, in a fair order (dueScheduledCloses): staff and signed-in lenders
 * before anonymous sandboxes and, within each, lenders being retried after
 * the rest, then one lender per workspace per turn.  A
 * failed close is recorded on the lender and retried after 2, 4, 8 … minutes,
 * at most hourly, so a lender that keeps failing never holds the others back;
 * the close stays pending until an attempt succeeds.  An anonymous sandbox
 * nobody has changed for closeRules.idleSandboxDays has its automatic close
 * switched off instead of run.  A stop ends the pass after the lender in
 * progress; the rest are still due at the next start.
 *
 * After its closes, the pass checks the whole audit chain
 * (checkAuditChainDaily) of each lender it gave its first close of the WAT
 * day, once a day however many missed business dates it catches up, and of
 * each lender a person closed meanwhile in this process (auditChecks), while
 * its budget lasts: the checks it leaves wait for the next pass.  Last, it
 * reads from the database what is still owed (scheduledCloseBacklog): the
 * lenders whose close is failing or overdue, which /api/healthz reports, so
 * a failing lender stays visible until its own close succeeds, whatever
 * other lenders' passes do and across a restart.  Public anonymous sandboxes,
 * whose visitors' own synthetic data can make a close fail, are counted apart
 * there and in the pass's failures, and never fail a one-shot run.
 */
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { closeRules } from "@workspace/valopay-schema";
import { SYSTEM_ACTOR_PREFIX, appendAudit, checkAuditChainDaily, dailyAuditCheckDue, dueScheduledCloses, inMerchantAsSystem, initialiseCloseCursors, loadState, recordScheduledCloseFailure, sandboxInactiveFor, saveState, scheduledCloseBacklog, settleChanges, writeAuditCheck, type OwedCloses } from "./valopay-store";
import { runDailyClose } from "../domain/actions";
import { pauseIdleSandboxClose, scheduledCloseDue } from "../domain/close";
import { enrolEligibleFailures } from "../domain/policy-engine";
import { withAuditNote } from "../domain/reconciliation";
import { bindCloseReviewBasis } from '../domain/close-review';

/** The system actor recorded on a scheduled close. */
export const SCHEDULED_CLOSE_ACTOR = `${SYSTEM_ACTOR_PREFIX}scheduled close`;

/** One lender closed by a pass. */
export interface ClosedMerchant { merchantId: string; closeId: string; late: boolean; delayMinutes: number | null }

/**
 * What the scheduled close still owes, as a pass read it from the database: durable facts, so a lender whose close
 * failed stays counted until its own close succeeds, whatever other lenders' passes do, and a restarted process's
 * first pass reads it again. Counts only: no lender is named.
 */
export interface CloseBacklog extends OwedCloses {
  /** When the pass read it, on this process's clock, as lastSuccessAt. */
  checkedAt: string;
  /** Lenders other than public anonymous sandboxes whose automatic close is on and whose pending close is more than lateAfterMinutes past its time: missed. */
  overdue: number;
  /** Lenders other than public anonymous sandboxes with a failed scheduled attempt recorded at their pending close time (settings.closeRetry), which only their close, or a change to their schedule, ends. */
  failing: number;
  /** The same two counts for public anonymous sandboxes, a visitor's synthetic lenders, whose own data can make a close fail. */
  publicSandboxes: { overdue: number; failing: number };
  /** How long after its time a close counts as overdue (closeRules.lateAfterMinutes). */
  lateAfterMinutes: number;
}

/**
 * What the scheduler is doing, for /api/healthz: whether it ticks, when it last looked, what its last pass that
 * found work did, and what its latest pass read as still owed. `off` and `external` both mean this process schedules
 * no closes; `external` says a separate scheduled job runs them (the one-shot close pass), so a close it misses still
 * counts as missed.
 */
export interface SchedulerStatus {
  state: "not_started" | "running" | "off" | "external" | "stopped";
  intervalMs: number | null;
  ticks: number;
  lastTickAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastRun: { runId: string; at: string; durationMs: number; initialised: number; batches: number; examined: number; closed: number; skipped: number; paused: number; failed: number } | null;
  /** Null until this process's first pass has read it; kept while the scheduler is stopped or failing, as last read. */
  backlog: CloseBacklog | null;
}
const status: SchedulerStatus = { state: "not_started", intervalMs: null, ticks: 0, lastTickAt: null, lastSuccessAt: null, lastErrorAt: null, lastRun: null, backlog: null };
/** A copy of the scheduler's state, for the health answer. */
export function schedulerStatus(): SchedulerStatus & { observedAt: string } { return { ...structuredClone(status), observedAt: new Date().toISOString() }; }
/**
 * One change to the scheduler's state: it started, a pass began, a pass
 * returned (with its counts when it found work, and what it read as still
 * owed unless it was told to stop) or failed, it stopped, or this process
 * schedules no closes.
 */
export type SchedulerEvent =
  | { type: "started"; intervalMs: number }
  | { type: "ticked"; at: string }
  | { type: "succeeded"; at: string; run: SchedulerStatus["lastRun"]; backlog?: CloseBacklog | null }
  | { type: "failed"; at: string }
  | { type: "stopped" }
  | { type: "off" | "external" };
const observers = new Set<(event: SchedulerEvent) => void>();
/**
 * Applies a change to this thread's scheduler state and passes it to the
 * observers. The scheduler runs on the background worker thread, which
 * observes its own changes and posts them to the main thread; the main thread
 * applies them here, so /api/healthz and the console read the state where they
 * answer (background-worker.ts).
 */
export function applySchedulerEvent(event: SchedulerEvent): void {
  if (event.type === "started") { status.state = "running"; status.intervalMs = event.intervalMs; }
  else if (event.type === "ticked") { status.ticks += 1; status.lastTickAt = event.at; }
  else if (event.type === "succeeded") { status.lastSuccessAt = event.at; status.lastErrorAt = null; if (event.run) status.lastRun = event.run; if (event.backlog) status.backlog = event.backlog; }
  else if (event.type === "failed") status.lastErrorAt = event.at;
  else if (event.type === "stopped") status.state = "stopped";
  else status.state = event.type;
  for (const observer of observers) observer(event);
}
/** Calls `observer` with every later change to this thread's scheduler state; returns what ends that. */
export function observeScheduler(observer: (event: SchedulerEvent) => void): () => void {
  observers.add(observer);
  return () => { observers.delete(observer); };
}
/** Recorded when the process is told not to schedule closes (VALOPAY_CLOSE_SCHEDULER=off, or external where a scheduled job runs them), so the health answer says so. */
export function markSchedulerOff(state: "off" | "external" = "off"): void { applySchedulerEvent({ type: state }); }
/** What one scheduler pass did. */
export interface CloseRun {
  runId: string;
  /** Legacy merchants given a cursor on this pass. */
  initialised: number;
  /** Batches of due lenders read. */
  batches: number;
  /** Due lenders the pass took up; each ends closed, skipped, paused or failed. */
  examined: number;
  closed: ClosedMerchant[];
  /** Due when read, but closed meanwhile, waiting for a retry, or locked by a request or another instance. */
  skipped: string[];
  /** Lenders of idle anonymous sandboxes whose automatic close was switched off instead of run. */
  paused: string[];
  /**
   * Failed closes; once recorded, `failures` counts the failed attempts at this close time and `retryAt` is the next.
   * `publicSandbox` marks a public anonymous sandbox's, which the pass's log lines count apart.
   */
  failed: Array<{ merchantId: string; error: string; failures?: number; retryAt?: string; publicSandbox?: true }>;
  /** Whether the time budget ended the pass before it had taken up every lender due, so some may still be due; false for a pass told to stop. */
  budgetSpent: boolean;
  /** What was still owed when the pass ended, read from the database (scheduledCloseBacklog); null for a pass told to stop. */
  backlog: OwedCloses | null;
}

/**
 * A pass's failures and what it read as still owed, as its log lines give them: the lenders' counts, and beside them
 * the public anonymous sandboxes' own (their failed closes, and unless the pass was told to stop, their failing and
 * overdue ones), which never raise an incident or fail a one-shot run.
 */
function passCounts(run: CloseRun) {
  const sandboxFailures = run.failed.filter((item) => item.publicSandbox).length;
  return {
    failed: run.failed.length - sandboxFailures,
    ...(run.backlog && { overdue: run.backlog.overdue, failing: run.backlog.failing }),
    publicSandboxes: { failed: sandboxFailures, ...run.backlog?.publicSandboxes },
  };
}

/** How a pass runs.  `onlyMerchantIds` limits it to the lenders named, for tests and operator tooling. */
export interface CloseRunOptions {
  batchSize?: number;
  log?: Logger;
  /** No lender's close starts after this long; default closeRules.passBudgetSeconds. */
  budgetMs?: number;
  /** Once aborted, the pass ends after the lender in progress. */
  signal?: AbortSignal;
  onlyMerchantIds?: readonly string[];
  /**
   * The lenders whose daily audit check is still to run: those a person closed in this process, to which the pass adds
   * those it closes. After its closes, the pass runs each one's check while its budget lasts, taking them from the set;
   * the rest stay for the next pass (a one-shot pass, which has none, leaves them to each lender's next close).
   */
  auditChecks?: Set<string>;
}

type Outcome = (Omit<ClosedMerchant, "merchantId"> & { auditCheckDue: boolean }) | { paused: true };

/**
 * Runs the daily check of the lender's whole audit chain and logs what it
 * found (`audit.daily_check`, an error when the chain is broken), or why it
 * could not (`audit.daily_check_failed`); it never throws. A check that
 * fails, or finds the day's check already run, leaves the lender as it was.
 */
export async function runDailyAuditCheck(merchantId: string, log?: Logger): Promise<void> {
  const started = Date.now();
  try {
    const found = await checkAuditChainDaily(merchantId);
    if (!found) return;
    const fields = { event: "audit.daily_check", merchantId, ...found, durationMs: Date.now() - started };
    if (found.valid) log?.info(fields, found.cleared ? "Daily audit log check: every entry intact, and the recorded break is cleared" : "Daily audit log check: every entry intact");
    else log?.error(fields, `Daily audit log check: the chain is broken at entry ${found.brokenAt}`);
  } catch (error) {
    log?.error({ event: "audit.daily_check_failed", merchantId, err: error, durationMs: Date.now() - started }, "Daily audit log check could not run; the lender's next daily close runs it");
  }
}

/**
 * One pass: give legacy merchants a cursor, then close due merchants batch
 * after batch, each in its own transaction, until none is due, the budget is
 * spent or the pass is told to stop.  Paused and failed lenders leave the due
 * set by themselves (a failure is recorded with its retry time); a skipped
 * lender, or a failure that could not be recorded, is left out of the pass's
 * later batches.  So is a closed lender: one still owed missed business dates
 * stays due, and gets one catch-up close per pass, the oldest date first.
 */
export async function runDueCloses(options: CloseRunOptions = {}): Promise<CloseRun> {
  const run: CloseRun = { runId: randomUUID(), initialised: 0, batches: 0, examined: 0, closed: [], skipped: [], paused: [], failed: [], budgetSpent: false, backlog: null };
  const started = Date.now();
  const batchSize = options.batchSize ?? closeRules.batchSize, budgetMs = options.budgetMs ?? closeRules.passBudgetSeconds * 1000;
  const log = options.log?.child({ job: "scheduled_close", runId: run.runId });
  const spent = () => options.signal?.aborted === true || Date.now() - started >= budgetMs;
  const auditChecks = options.auditChecks ?? new Set<string>();
  run.initialised = await initialiseCloseCursors();
  const exclude = new Set<string>();
  // Whether the pass saw the end of what was due: a batch shorter than batchSize, every lender of it taken up.
  let drained = false;
  while (!spent()) {
    const due = await dueScheduledCloses(batchSize, { exclude: [...exclude], only: options.onlyMerchantIds });
    run.batches += 1;
    const takenBefore = run.examined;
    for (const { id: merchantId, publicSandbox } of due) {
      if (spent()) break;
      run.examined += 1;
      try {
        const outcome = await inMerchantAsSystem<Outcome | null>(merchantId, SCHEDULED_CLOSE_ACTOR, async (ctx) => {
          const state = await loadState(ctx, merchantId, "update");
          // Re-checked under the lock: a person or another instance may have closed since the batch was read, or recorded a failure.
          if (!scheduledCloseDue(state, ctx.now)) return null;
          if (state.settings.anonymousWorkspace === true && await sandboxInactiveFor(ctx, closeRules.idleSandboxDays)) {
            pauseIdleSandboxClose(state, ctx.now);
            appendAudit(state, ctx, "daily_close.paused", "settings", `Automatic daily close paused: nobody changed this sandbox for ${closeRules.idleSandboxDays} days. Switch it on again in Settings to resume.`, settleChanges(ctx, state));
            await saveState(ctx, state);
            return { paused: true };
          }
          // The close lists a broken audit chain as its own write checked it; the day's check of the whole chain follows the pass's closes.
          const result = runDailyClose(state, ctx, "scheduled", undefined, writeAuditCheck(ctx, state));
          const auditCheckDue = dailyAuditCheckDue(state.settings, ctx.now);
          enrolEligibleFailures(state, ctx);
          if(result.record?.kind==='closes')bindCloseReviewBasis(state,result.record);
          // As for a close run by hand, the audit entry names the exceptions the close closed because their condition cleared.
          appendAudit(state, ctx, "daily_close", result.record!.id, withAuditNote(result.message, result.data.auditNote), settleChanges(ctx, state));
          await saveState(ctx, state);
          const schedule = result.data.schedule as { late?: boolean; delayMinutes?: number | null } | undefined;
          return { closeId: result.record!.id, late: schedule?.late === true, delayMinutes: schedule?.delayMinutes ?? null, auditCheckDue };
        });
        if (!outcome) {
          run.skipped.push(merchantId);
          exclude.add(merchantId);
        } else if ("paused" in outcome) {
          run.paused.push(merchantId);
          log?.info({ merchantId, idleDays: closeRules.idleSandboxDays }, "scheduled daily close paused for an idle sandbox");
        } else {
          const { auditCheckDue, ...closed } = outcome;
          run.closed.push({ merchantId, ...closed });
          exclude.add(merchantId);
          log?.info({ merchantId, ...closed }, "scheduled daily close completed");
          // Checked after the pass's closes, so no lender's close waits for another's walk.
          if (auditCheckDue) auditChecks.add(merchantId);
        }
      } catch (error) {
        const retry = await recordScheduledCloseFailure(merchantId).catch((recordError: unknown) => {
          log?.error({ merchantId, err: recordError }, "scheduled close failure could not be recorded");
          return undefined;
        });
        if (!retry) exclude.add(merchantId);
        run.failed.push({ merchantId, error: error instanceof Error ? error.message : String(error), ...(retry ? { failures: retry.failures, retryAt: retry.retryAt } : {}), ...(publicSandbox ? { publicSandbox } : {}) });
        log?.error({ merchantId, err: error, failures: retry?.failures, retryAt: retry?.retryAt, ...(publicSandbox ? { publicSandbox } : {}) }, "scheduled daily close failed");
      }
    }
    if (due.length < batchSize) { drained = run.examined - takenBefore === due.length; break; }
  }
  // The day's audit checks, one at a time on the pass's connection, while the budget lasts: the rest stay in the set for
  // the next pass, and a stop, or a one-shot pass, leaves them to each lender's next close.
  for (const merchantId of auditChecks) {
    if (spent()) break;
    auditChecks.delete(merchantId);
    await runDailyAuditCheck(merchantId, log);
  }
  // Ended by its budget rather than by a stop or the end of what was due: the lenders it did not take up are still due.
  run.budgetSpent = !drained && options.signal?.aborted !== true;
  // What is still owed, read afresh whatever the pass did, so neither another lender's close nor a restart hides a
  // failing one; a pass told to stop leaves it to the next.
  if (options.signal?.aborted !== true) run.backlog = await scheduledCloseBacklog(closeRules.lateAfterMinutes, { only: options.onlyMerchantIds });
  if (run.initialised) log?.info({ initialised: run.initialised }, "close cursors initialised for merchants that had none");
  // One line per pass that found work, with its duration, the audit checks its budget left and what is still owed, public
  // anonymous sandboxes apart; a quiet pass is a debug line so the log is not a metronome.
  const summary = { event: "close.run", durationMs: Date.now() - started, initialised: run.initialised, batches: run.batches, examined: run.examined, closed: run.closed.length, skipped: run.skipped.length, paused: run.paused.length, ...passCounts(run), auditChecksLeft: auditChecks.size };
  if (run.examined || run.failed.length || auditChecks.size) log?.info(summary, "scheduled close pass finished"); else log?.debug(summary, "scheduled close pass found nothing due");
  return run;
}

/**
 * How long a one-shot pass (close-pass.ts) may keep starting closes. A host
 * that runs no in-process scheduler runs it every few minutes, so it can
 * drain a longer backlog than an in-process pass, which must finish before
 * the next tick; a close that has started is always finished.
 */
export const ONE_SHOT_PASS_BUDGET_MS = 10 * 60_000;
/** What a one-shot pass did, and the exit status that says so. */
export interface OneShotCloseRun {
  /**
   * 0: the pass took up every lender due, and each was closed, paused or left to another process, and no lender's
   * close is failing or overdue; 2: the pass ran, but at least one close failed (recorded and retried by a later
   * pass), its budget ran out before it had taken up every lender due (still due for the next run), or a lender's
   * close is still failing, or overdue, from an earlier run; 1: the pass could not run, or was stopped before it
   * finished. A public anonymous sandbox's failed, failing or overdue close is counted apart and never makes it 2.
   */
  exitCode: 0 | 1 | 2;
  run: CloseRun | null;
}

/**
 * The scheduled daily close run once, for a host that runs no in-process
 * scheduler (VALOPAY_CLOSE_SCHEDULER=external), such as a Replit Scheduled
 * Deployment next to an Autoscale deployment: the same pass the tick loop
 * runs (runDueCloses), through the same repository, locks and audit, with a
 * longer budget, ending with one close.one_shot line that carries its exit
 * status. A lender whose close is still failing or overdue fails every run
 * until its close succeeds, whether or not that run tried it, so the job's
 * history shows it; a public anonymous sandbox's, which its visitor's own
 * synthetic data can cause, is only counted on the line. Another process
 * closing at the same time never closes the same lender twice (SKIP LOCKED,
 * and each close re-checks under its lock).
 */
export async function runClosePassOnce(options: CloseRunOptions = {}, pass: (options: CloseRunOptions) => Promise<CloseRun> = runDueCloses): Promise<OneShotCloseRun> {
  const started = Date.now();
  try {
    const run = await pass({ ...options, budgetMs: options.budgetMs ?? ONE_SHOT_PASS_BUDGET_MS });
    const stopped = options.signal?.aborted === true;
    // Public anonymous sandboxes' counts are on the line, apart: a visitor's own data never fails the job.
    const counts = passCounts(run), owed = Boolean(run.backlog?.failing || run.backlog?.overdue);
    const exitCode = stopped ? 1 : counts.failed || run.budgetSpent || owed ? 2 : 0;
    const fields = { event: "close.one_shot", exitCode, runId: run.runId, durationMs: Date.now() - started, stopped, budgetSpent: run.budgetSpent, examined: run.examined, closed: run.closed.length, skipped: run.skipped.length, paused: run.paused.length, ...counts };
    if (exitCode === 0) options.log?.info(fields, "One-shot close pass finished");
    else options.log?.error(fields, stopped ? "One-shot close pass stopped before it finished; the lenders it did not reach are still due"
      : run.budgetSpent ? `One-shot close pass ran out of time with lenders still due${counts.failed ? ", and some closes failed" : ""}; the next run takes them up`
      : counts.failed ? "One-shot close pass finished, but some closes failed; each is retried by a later pass"
      : "One-shot close pass finished, but some lenders' closes are still failing or overdue; a later run takes each up");
    return { exitCode, run };
  } catch (error) {
    options.log?.error({ event: "close.one_shot", exitCode: 1, durationMs: Date.now() - started, err: error }, "One-shot close pass could not read what was due, or what is still owed");
    return { exitCode: 1, run: null };
  }
}

/** The running scheduler: stop it, run a pass now, wait for the pass in progress, or ask for a lender's daily audit check. */
export interface CloseScheduler {
  /** Stops the timers and ends the pass in progress after the lender it is closing. */
  stop(): void;
  /** Runs a pass now, or joins the pass already running. */
  tick(): Promise<CloseRun | null>;
  /** Waits for the pass in progress, if any, without starting one: what a shutdown does before it ends the pool. */
  settle(): Promise<void>;
  /** Runs the lender's daily audit check after a person's close, in a pass started now or at the end of the pass in progress (or, once that has run its checks, of the next tick's). */
  checkAudit(merchantId: string): void;
}

/**
 * Starts the tick loop.  Ticks never overlap, and the timers are unreferenced
 * so they never hold the process open.  A pass's budget is at most three
 * quarters of the interval, so it has finished by the next tick.
 */
export function startCloseScheduler(options: { intervalMs?: number; firstDelayMs?: number } & Omit<CloseRunOptions, "signal"> = {}): CloseScheduler {
  const intervalMs = options.intervalMs ?? closeRules.tickSeconds * 1000;
  const budgetMs = options.budgetMs ?? Math.min(closeRules.passBudgetSeconds * 1000, Math.round(intervalMs * 0.75));
  const stopping = new AbortController();
  const auditChecks = new Set<string>();
  let running: Promise<CloseRun | null> | null = null;
  const tick = (): Promise<CloseRun | null> => {
    if (running) return running;
    applySchedulerEvent({ type: "ticked", at: new Date().toISOString() });
    const started = Date.now();
    running = runDueCloses({ batchSize: options.batchSize, log: options.log, onlyMerchantIds: options.onlyMerchantIds, budgetMs, signal: stopping.signal, auditChecks })
      .then((run) => {
        const at = new Date().toISOString();
        applySchedulerEvent({ type: "succeeded", at, run: run.examined || run.failed.length ? { runId: run.runId, at, durationMs: Date.now() - started, initialised: run.initialised, batches: run.batches, examined: run.examined, closed: run.closed.length, skipped: run.skipped.length, paused: run.paused.length, failed: run.failed.length } : null,
          backlog: run.backlog && { checkedAt: at, ...run.backlog, lateAfterMinutes: closeRules.lateAfterMinutes } });
        return run;
      })
      .catch((error: unknown) => { applySchedulerEvent({ type: "failed", at: new Date().toISOString() }); options.log?.error({ event: "close.tick_failed", err: error }, "scheduled close tick failed"); return null; })
      .finally(() => { running = null; });
    return running;
  };
  // The first look comes soon after start, so a close missed while the process was down catches up (NFR-AVA-02).
  const first = setTimeout(tick, options.firstDelayMs ?? Math.min(intervalMs, 5_000));
  const timer = setInterval(tick, intervalMs);
  first.unref();
  timer.unref();
  applySchedulerEvent({ type: "started", intervalMs });
  options.log?.info({ event: "scheduler.started", intervalMs, batchSize: options.batchSize ?? closeRules.batchSize, passBudgetMs: budgetMs }, "scheduled daily close running");
  return {
    stop() { clearTimeout(first); clearInterval(timer); stopping.abort(); applySchedulerEvent({ type: "stopped" }); },
    tick,
    settle() { return running ? running.then(() => undefined) : Promise.resolve(); },
    checkAudit(merchantId) {
      if (stopping.signal.aborted) return;
      auditChecks.add(merchantId);
      void tick();
    },
  };
}
