// The background worker thread's supervision, offline: a thread that crashes,
// ends unasked or cannot start is logged and started again after a wait that
// doubles to its maximum, and a thread that stayed up long enough starts the
// waits again; its crash marks the scheduler failed without touching the
// process; its log lines and scheduler changes reach the main thread; a stop
// ends the thread, or cancels a start still waiting; and the real thread
// (background.ts) runs the close scheduler and the export worker against an
// unreachable database, reports both through the main thread and stops
// cleanly. The fixture threads are data: modules; nothing connects to a
// database.
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const logFile = join(tmpdir(), `valopay-background-offline-${process.pid}.log`);
process.env["LOG_FILE"] = logFile;
process.env["LOG_LEVEL"] = "info";
process.env["DATABASE_URL"] ??= "postgres://unused:unused@127.0.0.1:1/unused";
const { BACKGROUND_POOL_SIZE, backgroundRestartDelay, startBackgroundWorker } = await import("../src/lib/background-worker");
const { schedulerStatus } = await import("../src/lib/close-scheduler");
const { logger } = await import("../src/lib/logger");

let checks = 0, since = 0;
/** The log's lines since the last mark(): the logger keeps the file open, so it is read on from a mark, never removed midway. */
const lines = (): Array<Record<string, any>> => readFileSync(logFile, "utf8").split("\n").filter(Boolean).slice(since).map((line) => JSON.parse(line));
const mark = () => { since += lines().length; };
const events = (event: string) => lines().filter((line) => line.event === event);
const fixture = (source: string) => new URL(`data:text/javascript,${encodeURIComponent(`import { parentPort } from "node:worker_threads";\n${source}`)}`);
/** Answers a stop by closing its port, so the thread ends, as background.ts does once its work has settled. */
const stoppable = `parentPort.on("message", (message) => { if (message?.type === "stop") parentPort.close(); });`;
async function waitFor(condition: () => boolean, what: string, ms = 10_000) {
  for (const until = Date.now() + ms; !condition(); await delay(10)) assert.ok(Date.now() < until, `timed out waiting for ${what}`);
}

try {
  // ---- The waits: a second doubling to a minute; the pool: a close and two export slots ----
  assert.deepEqual([1, 2, 3, 4, 6, 7, 8, 40].map((crashes) => backgroundRestartDelay(crashes)), [1_000, 2_000, 4_000, 8_000, 32_000, 60_000, 60_000, 60_000]);
  assert.equal(BACKGROUND_POOL_SIZE, 3);
  // The bundle carries the thread's entry beside the server, under the name the built server starts it by.
  const build = readFileSync(new URL("../build.mjs", import.meta.url), "utf8");
  assert.match(build, /entryPoints: \[[^\]]*"src\/background\.ts"/);
  assert.match(build, /outExtension: \{ "\.js": "\.mjs" \}/);
  assert.match(build, /__VALOPAY_BACKGROUND_ENTRY__: JSON\.stringify\("\.\/background\.mjs"\)/);
  checks += 5;

  // ---- Log lines and scheduler changes reach the main thread; a stop ends the thread ----
  const relaying = startBackgroundWorker({ log: logger, closes: {}, exports: null, entry: fixture(`
    parentPort.postMessage({ type: "log", line: JSON.stringify({ level: 30, thread: "background", event: "fixture.line", msg: "from the thread" }) + "\\n" });
    parentPort.postMessage({ type: "scheduler", event: { type: "started", intervalMs: 60000 } });
    parentPort.postMessage({ type: "scheduler", event: { type: "ticked", at: "2026-09-23T06:00:00.000Z" } });
    parentPort.postMessage({ type: "scheduler", event: { type: "succeeded", at: "2026-09-23T06:00:01.000Z", run: null, backlog: { checkedAt: "2026-09-23T06:00:01.000Z", overdue: 1, failing: 2, lateAfterMinutes: 30 } } });
    ${stoppable}`) });
  await waitFor(() => schedulerStatus().lastSuccessAt === "2026-09-23T06:00:01.000Z", "the relayed pass");
  assert.equal(schedulerStatus().state, "running");
  assert.equal(schedulerStatus().lastTickAt, "2026-09-23T06:00:00.000Z");
  assert.deepEqual(schedulerStatus().backlog, { checkedAt: "2026-09-23T06:00:01.000Z", overdue: 1, failing: 2, lateAfterMinutes: 30 }, "what the thread's pass read as still owed reaches the health answer");
  assert.deepEqual(events("fixture.line").map((line) => [line.thread, line.msg]), [["background", "from the thread"]], "the thread's line is written as it formatted it");
  assert.deepEqual(events("background.started").map((line) => [line.closes, line.exports, line.poolSize, line.crashes]), [[true, false, 3, 0]]);
  relaying.stop();
  await relaying.settle();
  assert.equal(events("background.stopped").length, 1);
  assert.equal(events("background.crashed").length, 0, "a thread asked to stop has not crashed");
  checks += 7;

  // ---- A crash is logged, marks the scheduler failed and starts the thread again, the waits doubling to their maximum ----
  const crashing = startBackgroundWorker({ log: logger, closes: {}, exports: null, restartMs: 20, maxRestartMs: 80, entry: fixture(`throw new Error("Synthetic background failure");`) });
  await waitFor(() => events("background.crashed").length >= 5, "five crashes");
  crashing.stop();
  await crashing.settle();
  const crashed = events("background.crashed").slice(0, 5);
  assert.deepEqual(crashed.map((line) => [line.crashes, line.retryInMs]), [[1, 20], [2, 40], [3, 80], [4, 80], [5, 80]]);
  assert.ok(crashed.every((line) => line.level === 50 && line.exitCode === 1 && /Synthetic background failure/.test(line.err.message) && line.err.stack), "each crash is an error line with the thread's own error and stack");
  assert.ok(schedulerStatus().lastErrorAt, "a crash is a failed scheduler check, so the console stops advertising the next close");
  assert.equal(schedulerStatus().state, "stopped", "stopped while it waited to start again");
  const started = events("background.started").length;
  await delay(150);
  assert.equal(events("background.started").length, started, "a stop cancels the start that was waiting");
  checks += 5;

  // ---- A thread that ends without being asked is a crash too; one that stayed up long enough starts the waits again ----
  mark();
  const ending = startBackgroundWorker({ log: logger, closes: null, exports: {}, restartMs: 20, maxRestartMs: 80, steadyMs: 100, entry: fixture(`setTimeout(() => parentPort.close(), 150);`) });
  await waitFor(() => events("background.crashed").length >= 3, "three unasked ends");
  ending.stop();
  await ending.settle();
  assert.deepEqual(events("background.crashed").slice(0, 3).map((line) => [line.exitCode, line.crashes, line.retryInMs, line.err.message]), Array.from({ length: 3 }, () => [0, 1, 20, "The background worker thread ended without being asked to stop."]));
  checks += 1;

  // ---- A thread Node refuses to start is a crash too: logged and tried again, never thrown into the process ----
  mark();
  const refused = startBackgroundWorker({ log: logger, closes: null, exports: {}, restartMs: 20, maxRestartMs: 20, entry: new URL("https://example.test/background.mjs") });
  await waitFor(() => events("background.crashed").length >= 3, "three refused starts");
  refused.stop();
  await refused.settle();
  assert.ok(events("background.crashed").every((line) => line.exitCode === undefined && line.err.code === "ERR_INVALID_URL_SCHEME"));
  assert.equal(events("background.started").length, 0, "a thread that never started is not logged as started");
  checks += 2;

  // ---- The real thread: the scheduler and the export worker against an unreachable database, reported here, stopped cleanly ----
  mark();
  const before = schedulerStatus();
  const real = startBackgroundWorker({ log: logger, closes: { intervalMs: 60_000, firstDelayMs: 10 }, exports: { intervalMs: 50, maxBackoffMs: 400 } });
  await waitFor(() => events("close.tick_failed").length > 0 && events("export.queue_error").length > 0, "the real thread's first close pass and queue look", 30_000);
  await waitFor(() => schedulerStatus().ticks > before.ticks && schedulerStatus().lastErrorAt !== before.lastErrorAt, "the relayed failed pass");
  assert.equal(schedulerStatus().state, "running");
  real.stop();
  await real.settle();
  const thread = lines().filter((line) => line.thread === "background");
  assert.deepEqual(["scheduler.started", "close.tick_failed", "export.queue_error"].map((event) => thread.some((line) => line.event === event)), [true, true, true], "the thread's events are its own lines, written by the main thread");
  assert.ok(thread.every((line) => line.service === "valopay-api" && line.pid === process.pid), "with the logger's base fields");
  assert.equal(schedulerStatus().state, "stopped", "the thread's scheduler reported its stop");
  assert.deepEqual(lines().filter((line) => line.event?.startsWith("background.")).map((line) => line.event), ["background.started", "background.stopped"], "it stopped when asked, without a crash");
  checks += 5;

  console.log(`Background worker tests passed (${checks} checks): crashes, unasked ends and refused starts logged and the thread started again after doubling waits, reset after a steady run; the scheduler marked failed meanwhile; log lines and scheduler changes relayed to the main thread; a stop that ends the thread or cancels a waiting start; and the real thread running both jobs and stopping cleanly.`);
} finally {
  rmSync(logFile, { force: true });
}
