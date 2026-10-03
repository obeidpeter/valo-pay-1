import { hostname } from "node:os";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import pino from "pino";
import { BUILD } from "./build-info";

/**
 * The process's one logger. Lines are JSON on stdout for the host to collect;
 * a developer gets them pretty-printed (NODE_ENV=development, or LOG_FORMAT=pretty
 * anywhere); LOG_FILE writes them synchronously to a file instead, so a test or a
 * local run can read them back. LOG_LEVEL sets the level. Every line names the
 * service and the build. Cookies and authorisation headers are never written.
 *
 * On the background worker thread (background.ts) the logger formats its lines
 * there, marked `thread: "background"`, and posts each to the main thread, which
 * writes it where it writes its own (writeLogLine): one writer for the
 * process's output, so the two threads' lines never interleave.
 */
const pretty = process.env.LOG_FORMAT === "pretty" || (process.env.LOG_FORMAT === undefined && process.env.NODE_ENV === "development");

const options: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  base: { pid: process.pid, hostname: hostname(), service: "valo-pay-1-api", build: BUILD },
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
};

/** A line the background thread's logger formatted, posted to the main thread (background-worker.ts). */
export interface LogLineMessage { type: "log"; line: string }
/** The background thread's name, which the main thread gives it (background-worker.ts); any other thread writes its own lines. */
const toMainThread = !isMainThread && (workerData as { thread?: unknown } | null)?.thread === "background" ? parentPort : null;

export const logger = toMainThread
  ? pino({ ...options, base: { ...options.base, thread: "background" } }, { write: (line: string) => toMainThread.postMessage({ type: "log", line } satisfies LogLineMessage) })
  : process.env.LOG_FILE
  ? pino(options, pino.destination({ dest: process.env.LOG_FILE, sync: true, mkdir: true }))
  : pino(pretty ? { ...options, transport: { target: "pino-pretty", options: { colorize: true } } } : options);

/** Writes a line the background thread's logger formatted, as this logger writes its own. */
export function writeLogLine(line: string): void {
  (logger as unknown as Record<symbol, { write(line: string): unknown }>)[pino.symbols.streamSym]!.write(line);
}
