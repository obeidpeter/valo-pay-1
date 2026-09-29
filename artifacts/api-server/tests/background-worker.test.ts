// The background worker thread's supervision, offline: a thread that crashes,
// ends unasked or cannot start is logged and started again after a wait that
// doubles to its maximum, and a thread that stayed up long enough starts the
// waits again; its crash marks the scheduler failed without touching the
// process; its log lines and scheduler changes reach the main thread; a stop
// ends the thread, or cancels a start still waiting; the real thread
// (background.ts) runs the close scheduler, export worker and enabled cleanup against an
// unreachable database, reports their failures through the main thread and stops
// cleanly; and where a scheduled job runs the closes, the thread's reads of
// what is still owed reach the main thread, and a read that fails is logged
// and keeps the last one. The fixture threads are data: modules; nothing
// connects to a database.
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
const { backgroundHealth, createBackgroundHealth, BACKGROUND_STALE_MS } = await import("../src/lib/background-health");
const { startExportCleanupWorker } = await import("../src/lib/export-cleanup-worker");
const { HealthCheckResponse } = await import("@workspace/api-zod");

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
  // ---- Public observations use the receiving clock, survive worker retries, and never invent cleanup success ----
  let time = Date.parse("2026-09-29T10:00:00.000Z");
  const health = createBackgroundHealth(() => time);
  assert.equal(health.status().state, "not_started");
  health.configure({ closes: false, backlog: false, exports: true, cleanup: true });
  health.starting();
  assert.deepEqual([health.status().state, health.status().cleanup.state], ["starting", "pending"]);
  time += BACKGROUND_STALE_MS + 1;
  assert.equal(health.status().state, "stale", "a thread that never finishes loading is stale too");
  health.observe({ type: "heartbeat" });
  health.observe({ type: "cleanup", result: { attempted: 0, removed: 0, deferred: 0, pendingFailures: 0 } });
  const emptySuccess = health.status().cleanup.lastSuccessAt;
  assert.deepEqual([health.status().state, health.status().cleanup.state, emptySuccess], ["running", "ok", new Date(time).toISOString()], "an empty completed poll proves the worker checked the queue");
  time += 1;
  health.observe({ type: "cleanup", result: { attempted: 2, removed: 1, deferred: 1, pendingFailures: 1 } });
  assert.deepEqual([health.status().cleanup.state, health.status().cleanup.lastSuccessAt, health.status().cleanup.lastErrorAt], ["failed", emptySuccess, new Date(time).toISOString()], "a deferred removal never advances last success");
  health.observe({ type: "cleanup", result: { attempted: 0, removed: 0, deferred: 0, pendingFailures: 1 } });
  assert.deepEqual([health.status().cleanup.state, health.status().cleanup.lastSuccessAt], ["failed", emptySuccess], "an empty poll while a failed file backs off is not recovery");
  health.observe({ type: "cleanup", result: { attempted: 1, removed: 1, deferred: 0, pendingFailures: 1 } });
  assert.equal(health.status().cleanup.state, "failed", "another file's successful deletion cannot clear the remaining failure");
  time += 1;
  health.observe({ type: "cleanup", result: null });
  assert.deepEqual([health.status().cleanup.state, health.status().cleanup.lastResult, health.status().cleanup.lastSuccessAt], ["failed", null, emptySuccess], "a rejected check has no invented result");
  health.crashed();
  assert.deepEqual([health.status().state, health.status().crashCount], ["restarting", 1], "scheduler off does not hide a worker crash");
  health.starting();
  assert.deepEqual([health.status().restartCount, health.status().crashCount, health.status().lastHeartbeatAt, health.status().cleanup.state, health.status().cleanup.lastSuccessAt], [1, 1, null, "pending", emptySuccess], "a retry needs its own heartbeat and check, but retains historical evidence");
  time += 195_001;
  health.observe({ type: "heartbeat" });
  assert.deepEqual([health.status().state, health.status().cleanup.state], ["running", "stale"], "a working event loop cannot hide stalled cleanup");
  health.observe({ type: "cleanup", result: { attempted: 1, removed: 1, deferred: 0, pendingFailures: 0 } });
  assert.equal(health.status().cleanup.state, "ok");
  const snapshot = health.status();
  snapshot.jobs.exports = false; snapshot.cleanup.lastResult!.removed = 999;
  assert.deepEqual([health.status().jobs.exports, health.status().cleanup.lastResult!.removed], [true, 1], "readers cannot mutate the observations");
  assert.ok(HealthCheckResponse.safeParse({ status: "ok", build: "fixture", startedAt: new Date(time).toISOString(), uptimeSeconds: 1, scheduler: schedulerStatus(), background: health.status() }).success, "the public contract preserves worker evidence");
  health.stopping(); health.observe({ type: "heartbeat" }); health.stopped();
  assert.equal(health.status().state, "stopped", "late heartbeat messages cannot undo shutdown");
  checks += 14;

  // Exercise the cleanup loop's observation boundary, including a quiet poll and storage retry, without private storage.
  const cleanupResults: Array<{ attempted: number; removed: number; deferred: number; pendingFailures: number } | null> = [];
  let calls = 0;
  const cleanup = startExportCleanupWorker({ intervalMs: 5, observed: result => cleanupResults.push(result) }, async () => {
    calls += 1;
    if (calls === 1) return { attempted: 0, removed: 0, deferred: 0 };
    if (calls === 2) return { attempted: 2, removed: 1, deferred: 1 };
    throw new Error("Synthetic unavailable queue");
  }, async () => ({ failed: calls === 1 ? 0 : 1 }));
  await waitFor(() => cleanupResults.length >= 3, "successful, deferred and rejected cleanup checks");
  cleanup.stop(); await cleanup.settle();
  assert.deepEqual(cleanupResults.slice(0, 3), [{ attempted: 0, removed: 0, deferred: 0, pendingFailures: 0 }, { attempted: 2, removed: 1, deferred: 1, pendingFailures: 1 }, null]);
  const failedQueueRead: unknown[] = [];
  const unavailableEvidence = startExportCleanupWorker({ observed: result => failedQueueRead.push(result) }, async () => ({ attempted: 0, removed: 0, deferred: 0 }), async () => { throw new Error("Synthetic status unavailable"); });
  await unavailableEvidence.settle(); unavailableEvidence.stop();
  assert.deepEqual(failedQueueRead, [null], "a completed pass without durable queue evidence never reports success");
  let observerCalls = 0;
  const noisyObserver = startExportCleanupWorker({ intervalMs: 5, observed: () => { observerCalls++; throw new Error("Synthetic observer failure"); } }, async () => ({ attempted: 0, removed: 0, deferred: 0 }), async () => ({ failed: 0 }));
  await waitFor(() => observerCalls >= 2, "cleanup retry after an observation failed");
  noisyObserver.stop(); await noisyObserver.settle();
  assert.ok(observerCalls >= 2, "observability failure cannot stop cleanup");
  checks += 2;
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
    parentPort.postMessage({ type: "heartbeat" });
    parentPort.postMessage({ type: "log", line: JSON.stringify({ level: 30, thread: "background", event: "fixture.line", msg: "from the thread" }) + "\\n" });
    parentPort.postMessage({ type: "scheduler", event: { type: "started", intervalMs: 60000 } });
    parentPort.postMessage({ type: "scheduler", event: { type: "ticked", at: "2026-09-23T06:00:00.000Z" } });
    parentPort.postMessage({ type: "scheduler", event: { type: "succeeded", at: "2026-09-23T06:00:01.000Z", run: null, backlog: { checkedAt: "2026-09-23T06:00:01.000Z", overdue: 1, failing: 2, lateAfterMinutes: 30 } } });
    ${stoppable}`) });
  await waitFor(() => schedulerStatus().lastSuccessAt === "2026-09-23T06:00:01.000Z", "the relayed pass");
  assert.equal(schedulerStatus().state, "running");
  assert.equal(backgroundHealth.status().state, "running", "the real message channel forwards a worker heartbeat");
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
  assert.ok(backgroundHealth.status().crashCount >= 3, "process-lifetime crash count is not reset by a steady run with closes disabled");
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

  // ---- The real thread: scheduler, exports and cleanup run, report failures and stop cleanly ----
  mark();
  const before = schedulerStatus();
  const real = startBackgroundWorker({ log: logger, closes: { intervalMs: 60_000, firstDelayMs: 10 }, exports: { intervalMs: 50, maxBackoffMs: 400 }, cleanup: { intervalMs: 50 } });
  try {
    await waitFor(() => events("close.tick_failed").length > 0 && events("export.queue_error").length > 0, "the real thread's first close pass and queue look", 30_000);
    // Two failures prove background.ts started cleanup and received its short test interval. A missing
    // workerData option starts nothing; losing intervalMs leaves the second pass a minute away.
    await waitFor(() => events("workspace.sweep_cleanup_unavailable").length >= 2, "the real cleanup worker's first pass and retry", 10_000);
    await waitFor(() => backgroundHealth.status().cleanup.state === "failed", "the real cleanup failure's public observation");
    assert.equal(backgroundHealth.status().state, "running", "worker liveness and cleanup failure are independent");
    assert.ok(backgroundHealth.status().lastHeartbeatAt);
    assert.equal(backgroundHealth.status().cleanup.lastSuccessAt, null, "unavailable database checks have no successful cleanup timestamp");
    await waitFor(() => schedulerStatus().ticks > before.ticks && schedulerStatus().lastErrorAt !== before.lastErrorAt, "the relayed failed pass");
    assert.equal(schedulerStatus().state, "running");
  } finally {
    real.stop();
    await real.settle();
  }
  const thread = lines().filter((line) => line.thread === "background");
  assert.deepEqual(["scheduler.started", "close.tick_failed", "export.queue_error", "workspace.sweep_cleanup_unavailable"].map((event) => thread.some((line) => line.event === event)), [true, true, true, true], "the thread's events are its own lines, written by the main thread");
  assert.deepEqual(events("background.started").map((line) => line.cleanup), [true], "service cleanup is visible in the worker start record");
  assert.ok(thread.every((line) => line.service === "valopay-api" && line.pid === process.pid), "with the logger's base fields");
  assert.equal(schedulerStatus().state, "stopped", "the thread's scheduler reported its stop");
  assert.deepEqual(lines().filter((line) => line.event?.startsWith("background.")).map((line) => line.event), ["background.started", "background.stopped"], "it stopped when asked, without a crash");
  checks += 6;

  // ---- External mode: no pass runs here, so the thread reads what is still owed itself, and each read reaches the main thread ----
  mark();
  const relayingReads = startBackgroundWorker({ log: logger, closes: null, backlog: {}, exports: null, entry: fixture(`
    parentPort.postMessage({ type: "scheduler", event: { type: "external", intervalMs: 60000 } });
    parentPort.postMessage({ type: "scheduler", event: { type: "backlog", backlog: { checkedAt: "2026-09-23T07:00:00.000Z", overdue: 3, failing: 0, lateAfterMinutes: 30, publicSandboxes: { overdue: 1, failing: 1 } } } });
    ${stoppable}`) });
  await waitFor(() => schedulerStatus().backlog?.checkedAt === "2026-09-23T07:00:00.000Z", "the relayed read");
  assert.deepEqual([schedulerStatus().state, schedulerStatus().intervalMs, schedulerStatus().backlog], ["external", 60_000, { checkedAt: "2026-09-23T07:00:00.000Z", overdue: 3, failing: 0, lateAfterMinutes: 30, publicSandboxes: { overdue: 1, failing: 1 } }], "what the thread read reaches the health answer, with how often it reads");
  relayingReads.stop();
  await relayingReads.settle();
  checks += 1;

  // ---- The real thread in external mode, against an unreachable database: a read that fails is logged and keeps the last one ----
  mark();
  const lastRead = schedulerStatus();
  const reader = startBackgroundWorker({ log: logger, closes: null, backlog: { intervalMs: 60_000, firstDelayMs: 10 }, exports: null, cleanup: null });
  await waitFor(() => events("close.backlog_failed").length > 0, "the real thread's first read", 30_000);
  reader.stop();
  await reader.settle();
  const failedRead = events("close.backlog_failed")[0]!;
  assert.deepEqual([failedRead.level, failedRead.thread, typeof failedRead.err?.message], [50, "background", "string"], "a failed read is an error line of the thread's, with the error");
  const afterFailedRead = schedulerStatus();
  assert.deepEqual([afterFailedRead.state, afterFailedRead.intervalMs, afterFailedRead.backlog, afterFailedRead.lastErrorAt, afterFailedRead.ticks], ["external", 60_000, lastRead.backlog, lastRead.lastErrorAt, lastRead.ticks], "it keeps the last read, whose checkedAt ages, and is not a failed pass");
  assert.deepEqual(events("background.started").map((line) => [line.closes, line.backlog, line.exports]), [[false, true, false]], "the thread reads the backlog and schedules no close");
  assert.deepEqual(events("background.started").map((line) => line.cleanup), [false]);
  assert.equal(events("workspace.sweep_cleanup_unavailable").length, 0, "an explicit null leaves service cleanup disabled");
  assert.deepEqual(lines().filter((line) => line.event?.startsWith("background.")).map((line) => line.event), ["background.started", "background.stopped"], "and stops when asked, without a crash");
  checks += 6;

  console.log(`Background worker tests passed (${checks} checks): crashes, unasked ends and refused starts logged and the thread started again after doubling waits, reset after a steady run; the scheduler marked failed meanwhile; log lines and scheduler changes relayed to the main thread; a stop that ends the thread or cancels a waiting start; the real thread running scheduler, exports and enabled cleanup with retry and stopping cleanly; explicit null disabling cleanup; and in external mode the thread's reads of what is still owed relayed, a failed read logged and the last read kept.`);
} finally {
  rmSync(logFile, { force: true });
}
