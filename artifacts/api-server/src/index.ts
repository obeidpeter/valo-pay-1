// First, before any module that reads a setting: the settings are checked
// together and a bad value ends the process with one fatal line.
import { serverSettings } from "./lib/server-settings";
import app from "./app";
import { logger } from "./lib/logger";
import { BUILD } from "./lib/build-info";
import { markSchedulerOff } from "./lib/close-scheduler";
import { closeDatabase, watchDatabase, verifyProductDatabaseBinding } from "./lib/valo-pay-1-store";
import { signInConfiguration } from "./lib/staff-access";
import { startBackgroundWorker, type BackgroundWorker } from "./lib/background-worker";
import { runtimeIsolationEnabled } from './lib/runtime-isolation';

const port = serverSettings.port!;

// A host with Clerk but no origin to accept sessions from runs with sign-in off, and says so. (A staff host
// without Clerk never gets here: the start-up check refused it.)
const signIn = signInConfiguration();
if (signIn.warning) logger.warn({ event: "sign_in.off" }, signIn.warning);

// A connection that fails while idle is a log line, not the end of the process.
watchDatabase(logger);
try { await verifyProductDatabaseBinding(); }
catch (error) {
  logger.fatal({ event: "identity.refused", err: error }, "Valo Pay 1 resource identity verification failed; no requests or workers were started");
  await closeDatabase();
  process.exit(1);
}

let background: BackgroundWorker | undefined;
const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ event: "server.started", port, build: BUILD, node: process.version }, "Server listening");
  // REC-01: the daily close runs at each lender's configured time unless this process is told not to schedule it
  // (VALO_PAY_1_CLOSE_SCHEDULER=off, or external where a separate scheduled job runs the one-shot close pass, in any
  // case; any other value was refused at startup). The scheduled closes and the export worker run on the background
  // worker thread, off the event loop that answers requests; with external the thread reads what is still owed instead.
  if (serverSettings.closeScheduler === "off") {
    markSchedulerOff();
    logger.warn({ event: "scheduler.off" }, "VALO_PAY_1_CLOSE_SCHEDULER=off: this process runs no scheduled close; run closes by hand or with the one-shot close pass.");
  } else if (serverSettings.closeScheduler === "external") {
    markSchedulerOff("external");
    logger.info({ event: "scheduler.external" }, "VALO_PAY_1_CLOSE_SCHEDULER=external: this process runs no scheduled close; a scheduled job runs them with the one-shot close pass. This process reads the lenders still owed a close every minute, which /api/healthz reports, and a close the job misses still raises the missed-close alert.");
  }
  background = startBackgroundWorker({ log: logger, closes: serverSettings.closeScheduler === "on" ? {} : null, backlog: serverSettings.closeScheduler === "external" ? {} : null, exports: {}, cleanup: runtimeIsolationEnabled() ? null : {} });
});

/**
 * A stop signal drains rather than drops: no new connections, the requests in
 * flight finish, and the background worker thread stops: a scheduled close
 * pass ends after the lender close in progress, then the thread's pool ends,
 * then the requests' pool. The lenders the pass had not reached are still due
 * and close as a catch-up after restart (NFR-AVA-02). A close that will not
 * finish in time is abandoned by the deadline; its transaction rolls back with
 * the connection and it runs again after restart the same way. An export
 * attempt in progress is cancelled and its job handed back to the queue for
 * the next worker, never failed; if that write cannot be made before the
 * deadline, the job keeps its lease and a later poll recovers it when the
 * lease expires.
 */
let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ event: "server.stopping", signal }, "Shutting down: finishing requests and any close in progress; unfinished exports return to the queue");
  const deadline = setTimeout(() => { logger.error({ event: "server.stop_timeout" }, "Shutdown deadline passed; exiting"); process.exit(1); }, 10_000);
  deadline.unref();
  background?.stop();
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeIdleConnections(); });
  // The thread ends after the close in progress and the hand-back writes of the cancelled exports, which need its
  // pool: ending it sooner would leave every stopped export 'interrupted', waiting up to five minutes for its lease.
  await background?.settle();
  await closeDatabase();
  logger.info({ event: "server.stopped" }, "Shutdown complete");
  process.exit(0);
}
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT", () => { void shutdown("SIGINT"); });

// A failure nothing caught is written as a structured line before the process ends, not as a bare stack on stderr.
// One on the background worker thread ends only that thread, which is started again (lib/background-worker.ts).
process.on("unhandledRejection", (reason) => {
  logger.fatal({ event: "process.unhandled_rejection", err: reason instanceof Error ? reason : new Error(String(reason)) }, "Unhandled promise rejection");
  process.exit(1);
});
process.on("uncaughtException", (error) => {
  logger.fatal({ event: "process.uncaught_exception", err: error }, "Uncaught exception");
  process.exit(1);
});
