/**
 * The background worker thread: the scheduled daily close and the export
 * worker, off the event loop that answers requests and health probes, so a
 * month-end close or a large export never holds them up. Where a scheduled
 * job runs the closes (VALOPAY_CLOSE_SCHEDULER=external), the thread reads
 * what is still owed at the scheduler's interval instead, for /api/healthz.
 * The main thread starts it, starts it again after a crash and stops it on
 * shutdown (lib/background-worker.ts). It has its own database pool, which the main
 * thread sizes (BACKGROUND_POOL_SIZE), and it keeps to the same repository
 * modules and limits as before; its log lines go through the main thread
 * (lib/logger.ts), and it posts each change of the scheduler's state there,
 * where /api/healthz and the console read it. After a person's close the main
 * thread asks it for the lender's daily audit check, which the scheduler runs
 * after its closes, or, where this process schedules none, the thread runs
 * one at a time, in turn with its reads of what is still owed. A stop ends a
 * close pass after the lender close in progress, lets the audit check or read
 * in progress finish, and hands every unfinished export back to the queue,
 * then ends the pool, and with it the thread.
 */
import { parentPort, workerData } from "node:worker_threads";
import { logger } from "./lib/logger";
import { observeScheduler, runDailyAuditCheck, startBacklogWatch, startCloseScheduler } from "./lib/close-scheduler";
import { startExportWorker } from "./lib/export-worker";
import { closeDatabase, watchDatabase } from "./lib/valopay-store";
import type { BackgroundMessage, BackgroundOptions, BackgroundRequest } from "./lib/background-worker";

if (!parentPort) throw new Error("background.ts runs as the API's worker thread (lib/background-worker.ts), not on its own.");
const port = parentPort, options = workerData as BackgroundOptions;
const post = (message: BackgroundMessage) => port.postMessage(message);

// As on the main thread: an idle connection that fails is a log line, not the end of the thread.
watchDatabase(logger);
let stopping: Promise<void> | undefined;
// Without a scheduler, the close's connection serves one thing at a time, in the order asked for: the daily audit
// checks a person's closes ask for and, where a scheduled job runs the closes, the reads of what is still owed. Work
// whose turn comes once the thread is stopping is not started.
let closeConnection: Promise<void> = Promise.resolve();
function inTurn(work: () => Promise<void>): Promise<void> {
  const turn = closeConnection.then(() => (stopping ? undefined : work()));
  closeConnection = turn.catch(() => undefined);
  return turn;
}
if (options.closes || options.backlog) observeScheduler((event) => post({ type: "scheduler", event }));
const scheduler = options.closes ? startCloseScheduler({ ...options.closes, log: logger }) : undefined;
const backlogWatch = options.backlog ? startBacklogWatch({ ...options.backlog, log: logger, queue: inTurn }) : undefined;
const exportWorker = options.exports ? startExportWorker({ ...options.exports, log: logger }) : undefined;

async function stop(): Promise<void> {
  try {
    scheduler?.stop();
    backlogWatch?.stop();
    exportWorker?.stop();
    // The close, read or audit check in progress finishes and the stopped exports' hand-back writes are made before the pool ends.
    await Promise.all([scheduler?.settle(), backlogWatch?.settle(), exportWorker?.settle(), closeConnection]);
    await closeDatabase();
  } finally {
    // Nothing else holds the thread open, so it ends here.
    port.close();
  }
}
port.on("message", (message: BackgroundRequest) => {
  if (message?.type === "stop") stopping ??= stop();
  else if (message?.type === "audit_check" && typeof message.merchantId === "string" && !stopping) {
    const { merchantId } = message;
    if (scheduler) scheduler.checkAudit(merchantId);
    else void inTurn(() => runDailyAuditCheck(merchantId, logger));
  }
});
