// The one-shot close pass a host without an in-process scheduler runs on a
// schedule (a Replit Scheduled Deployment next to an Autoscale deployment):
// the scheduler's own pass run once, with a longer budget, ending with one
// close.one_shot line and an exit status that says how it went: 0 done, 2
// some closes failed (each recorded and retried by a later pass), the budget
// ran out with lenders still due, or a lender's close is still failing or
// overdue from an earlier run, 1 it could not run or was stopped. Offline:
// the pass is a stand-in here, and the process is started against an unusable
// loopback database. The pass against PostgreSQL is in
// close-scheduler.integration.test.ts.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

process.env["DATABASE_URL"] ??= "postgres://unused:unused@127.0.0.1:1/unused";
const { ONE_SHOT_PASS_BUDGET_MS, runClosePassOnce } = await import("../src/lib/close-scheduler");
type Pass = NonNullable<Parameters<typeof runClosePassOnce>[1]>;
type Run = Awaited<ReturnType<Pass>>;

let checks = 0;
const lines: Array<Record<string, any>> = [];
const log = { info: (fields: object, msg: string) => lines.push({ level: "info", ...fields, msg }), error: (fields: object, msg: string) => lines.push({ level: "error", ...fields, msg }) } as any;
const run = (change: Partial<Run> = {}): Run => ({ runId: "run-1", initialised: 0, batches: 1, examined: 2, closed: [{ merchantId: "a", closeId: "c", late: false, delayMinutes: 0 }], skipped: ["b"], paused: [], failed: [], budgetSpent: false, backlog: { overdue: 0, failing: 0, publicSandboxes: { overdue: 0, failing: 0 } }, ...change });
let given: Parameters<Pass>[0] | undefined;

// Everything due closed, paused or left to another process: 0, with the counts, and the longer budget.
let result = await runClosePassOnce({ log }, async (options) => { given = options; return run(); });
assert.equal(result.exitCode, 0);
assert.equal(given?.budgetMs, ONE_SHOT_PASS_BUDGET_MS, "a one-shot pass may drain a longer backlog than an in-process tick");
assert.equal(ONE_SHOT_PASS_BUDGET_MS, 600_000);
assert.deepEqual([lines[0]!.level, lines[0]!.event, lines[0]!.exitCode, lines[0]!.examined, lines[0]!.closed, lines[0]!.skipped, lines[0]!.failed, lines[0]!.budgetSpent, lines[0]!.overdue, lines[0]!.failing], ["info", "close.one_shot", 0, 2, 1, 1, 0, false, 0, 0]);
checks += 4;

// A close that failed: 2, at error level, so the scheduled run shows as failed while the retry is recorded.
lines.length = 0;
result = await runClosePassOnce({ log }, async () => run({ failed: [{ merchantId: "a", error: "synthetic", failures: 1, retryAt: "2026-09-23T07:02:00.000Z" }] }));
assert.deepEqual([result.exitCode, lines[0]!.level, lines[0]!.failed], [2, "error", 1]);
checks += 1;

// The budget ran out before the pass had taken up every due lender: 2 as well, never 0, and the line says so; the
// lenders it did not reach are still due for the next run.
lines.length = 0;
result = await runClosePassOnce({ log }, async () => run({ examined: 0, closed: [], skipped: [], budgetSpent: true }));
assert.deepEqual([result.exitCode, lines[0]!.level, lines[0]!.budgetSpent, lines[0]!.failed], [2, "error", true, 0]);
assert.match(lines[0]!.msg, /ran out of time/);
lines.length = 0;
result = await runClosePassOnce({ log }, async () => run({ budgetSpent: true, failed: [{ merchantId: "a", error: "synthetic" }] }));
assert.deepEqual([result.exitCode, lines[0]!.budgetSpent, lines[0]!.failed], [2, true, 1]);
checks += 3;

// A lender's close still failing from an earlier run, or one more than 30 minutes past its time, makes the run fail
// too, though this run tried neither: the job's history shows it until that lender's close succeeds (K).
lines.length = 0;
result = await runClosePassOnce({ log }, async () => run({ examined: 0, closed: [], skipped: [], backlog: { overdue: 0, failing: 1, publicSandboxes: { overdue: 0, failing: 0 } } }));
assert.deepEqual([result.exitCode, lines[0]!.level, lines[0]!.failed, lines[0]!.failing, lines[0]!.overdue], [2, "error", 0, 1, 0]);
assert.match(lines[0]!.msg, /still failing or overdue/);
lines.length = 0;
result = await runClosePassOnce({ log }, async () => run({ backlog: { overdue: 3, failing: 0, publicSandboxes: { overdue: 0, failing: 0 } } }));
assert.deepEqual([result.exitCode, lines[0]!.overdue], [2, 3]);
checks += 3;

// A public anonymous sandbox's failed close, and its failing or overdue count, never fail the run: a visitor's own
// synthetic data can make its close fail. The line counts them apart, beside the lenders' counts.
lines.length = 0;
result = await runClosePassOnce({ log }, async () => run({ failed: [{ merchantId: "v", error: "synthetic", failures: 1, retryAt: "2026-09-23T07:02:00.000Z", publicSandbox: true }], backlog: { overdue: 0, failing: 0, publicSandboxes: { overdue: 2, failing: 1 } } }));
assert.deepEqual([result.exitCode, lines[0]!.level, lines[0]!.failed, lines[0]!.failing, lines[0]!.overdue, lines[0]!.publicSandboxes], [0, "info", 0, 0, 0, { failed: 1, overdue: 2, failing: 1 }]);
lines.length = 0;
result = await runClosePassOnce({ log }, async () => run({ failed: [{ merchantId: "a", error: "synthetic" }, { merchantId: "v", error: "synthetic", publicSandbox: true }] }));
assert.deepEqual([result.exitCode, lines[0]!.failed, lines[0]!.publicSandboxes], [2, 1, { failed: 1, overdue: 0, failing: 0 }], "a lender's failure beside a sandbox's still fails the run");
checks += 2;

// Stopped before it finished: 1, whatever it managed; the lenders it did not reach are still due.
lines.length = 0;
const stop = new AbortController();
result = await runClosePassOnce({ log, signal: stop.signal }, async () => { stop.abort(); return run({ backlog: null }); });
assert.deepEqual([result.exitCode, lines[0]!.stopped, lines[0]!.level], [1, true, "error"]);
checks += 1;

// The pass could not read what was due: 1, with the error on the line.
lines.length = 0;
const outage = new Error("connect ECONNREFUSED 127.0.0.1:1");
result = await runClosePassOnce({ log }, async () => { throw outage; });
assert.deepEqual([result.exitCode, result.run, lines[0]!.event, lines[0]!.err], [1, null, "close.one_shot", outage]);
checks += 1;

// The command itself, as a scheduled deployment runs it: the database is unreachable, so it exits 1 with its line, not a stack.
const root = path.resolve(import.meta.dirname, "..", "..", "..");
const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:VALOPAY_|LOG_|PORT$|DATABASE_URL$|NODE_ENV$)/.test(name)));
const child = spawn(process.execPath, [path.join(root, "scripts", "node_modules", "tsx", "dist", "cli.mjs"), path.join(root, "artifacts", "api-server", "src", "close-pass.ts")],
  { cwd: root, env: { ...clean, DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused", LOG_FORMAT: "json" } });
let stdout = "", stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
assert.equal(status, 1, stdout + stderr);
const events = stdout.split("\n").filter((text) => text.startsWith("{")).map((text) => JSON.parse(text));
const summary = events.find((line) => line.event === "close.one_shot");
assert.deepEqual([summary?.level, summary?.exitCode], [50, 1], stdout);
assert.doesNotMatch(stderr, /\n\s+at /, "no bare stack");
checks += 3;

console.log(`One-shot close pass checks passed (${checks}): exit 0 when every due close ran, 2 when a close failed and was left for its retry, the budget ran out with lenders still due or a lender's close is still failing or overdue, never for a public sandbox's, 1 when the pass was stopped or could not read what was due, one close.one_shot line each time, and the command's own exit against an unreachable database.`);
