// First, before any module that reads a setting (see lib/startup-config.ts).
import "./lib/close-pass-settings";
import { logger } from "./lib/logger";
import { runClosePassOnce } from "./lib/close-scheduler";
import { closeDatabase, watchDatabase } from "./lib/valopay-store";

/**
 * The one-shot close pass: runs the scheduled daily closes that are due once
 * and exits with the pass's status (0 all done, 2 some closes failed and are
 * retried next time, the budget ran out with lenders still due for the next
 * run, or a lender's close is still failing or overdue, 1 it could not run or
 * was stopped; a public anonymous sandbox's close never makes it 2), for a
 * host whose API process runs no scheduler, such as Autoscale with
 * VALOPAY_CLOSE_SCHEDULER=external and a Replit Scheduled Deployment running
 * `node artifacts/api-server/dist/close-pass.mjs`.
 * A stop signal ends the pass after the lender close in progress.
 */
watchDatabase(logger);
const stop = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => stop.abort());
// As in index.ts: a failure nothing caught is a structured line before the exit, not a bare stack.
process.on("unhandledRejection", (reason) => {
  logger.fatal({ event: "process.unhandled_rejection", err: reason instanceof Error ? reason : new Error(String(reason)) }, "Unhandled promise rejection");
  process.exit(1);
});
process.on("uncaughtException", (error) => {
  logger.fatal({ event: "process.uncaught_exception", err: error }, "Uncaught exception");
  process.exit(1);
});
const { exitCode } = await runClosePassOnce({ log: logger, signal: stop.signal });
await closeDatabase().catch(() => { /* the pass's outcome is already logged */ });
process.exit(exitCode);
