// What an operator can see: every request named on its answer and in its log
// lines, refusals and failures as structured events with the stack where it
// belongs, nothing secret in the log, a liveness answer that says what runs
// and a readiness answer that says whether the database does.
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The log goes to a file this test reads back; the store needs an address and Clerk a pair of placeholder keys, none of which is used.
const logFile = join(tmpdir(), `valopay-observability-${process.pid}.log`);
process.env["LOG_FILE"] = logFile;
process.env["LOG_LEVEL"] = "info";
process.env["DATABASE_URL"] ??= "postgres://postgres@127.0.0.1:1/valopay-unused";
process.env["CLERK_SECRET_KEY"] ??= "sk_test_placeholder";
process.env["CLERK_PUBLISHABLE_KEY"] ??= `pk_test_${Buffer.from("clerk.example.test$").toString("base64")}`;
const { default: app, requestIdFor } = await import("../src/app.js");
const { errorHandler } = await import("../src/lib/error-handler.js");
const { DatabaseLimitError } = await import("../src/lib/database-limits.js");
const { markRolledBack } = await import("../src/lib/transaction-outcome.js");
const { applySchedulerEvent, schedulerStatus, markSchedulerOff } = await import("../src/lib/close-scheduler.js");
const { BUILD } = await import("../src/lib/build-info.js");
const { readinessAnswer, readinessWarning } = await import("../src/routes/health.js");

let checks = 0;
const lines = (): Array<Record<string, any>> => readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

// ---- Request ids: kept when the deployment's edge sets them and they are plain, replaced otherwise ----
assert.match(requestIdFor({ headers: {} }), /^[0-9a-f]{16}$/, "a fresh id is 16 hex characters");
assert.match(requestIdFor({ headers: { "x-request-id": "edge-7f3a9c2b" } }), /^[0-9a-f]{16}$/, "a client's id is replaced unless the edge is said to set it");
assert.equal(requestIdFor({ headers: { "x-request-id": "edge-7f3a9c2b" } }, true), "edge-7f3a9c2b", "a plain id from an edge that sets it is kept");
assert.equal(requestIdFor({ headers: { "x-request-id": ["edge-first-of-two", "edge-second"] } }, true), "edge-first-of-two");
for (const bad of ["<script>", "a b", "short", "x".repeat(65), ""]) assert.match(requestIdFor({ headers: { "x-request-id": bad } }, true), /^[0-9a-f]{16}$/, `"${bad}" is replaced`);
checks += 8;

// ---- The error handler: the id in every body, the stack for a failure, the reason for a rejection ----
const handled = (error: unknown) => {
  const logged: Array<{ level: string; fields: Record<string, unknown> }> = [];
  const out: { status?: number; body?: any; headers: Record<string, string> } = { headers: {} };
  const req = { id: "req-abc12345", log: { error: (fields: Record<string, unknown>) => logged.push({ level: "error", fields }), warn: (fields: Record<string, unknown>) => logged.push({ level: "warn", fields }), info: (fields: Record<string, unknown>) => logged.push({ level: "info", fields }) } };
  const res = { headersSent: false, setHeader(name: string, value: string) { out.headers[name] = value; return this; }, status(code: number) { out.status = code; return this; }, json(body: unknown) { out.body = body; return this; } };
  errorHandler(error, req as any, res as any, () => {});
  return { ...out, logged };
};
const crash = handled(new TypeError("Cannot read properties of undefined (reading 'kobo')"));
assert.equal(crash.status, 500);
assert.equal(crash.body.requestId, "req-abc12345", "a failure names the request");
assert.equal(crash.logged[0]!.level, "error");
assert.equal(crash.logged[0]!.fields["event"], "request.failed");
assert.ok((crash.logged[0]!.fields["err"] as Error).stack?.includes("TypeError"), "the failure is logged with its stack");
assert.ok(!JSON.stringify(crash.body).includes("undefined (reading"), "the answer stays general");
const refused = handled(Object.assign(new Error("Live instruction is not permitted in observation mode."), { status: 403 }));
assert.equal(refused.status, 403);
assert.equal(refused.body.requestId, "req-abc12345", "a rejection names the request too");
assert.deepEqual(refused.logged[0], { level: "info", fields: { event: "request.rejected", status: 403, reason: "Live instruction is not permitted in observation mode." } });
const thrownValue = handled("not even an error");
assert.equal(thrownValue.status, 500);
assert.equal(thrownValue.logged[0]!.fields["event"], "request.failed");
// A request turned away at a database limit is one request.busy line: a warning while a lender is busy, an error when a statement, a connection or the pool failed.
const lockWait = new Error("canceling statement due to lock timeout");
const busy = handled(markRolledBack(new DatabaseLimitError("lock_timeout", { cause: lockWait })));
assert.equal(busy.status, 503);
assert.equal(busy.body.requestId, "req-abc12345", "a busy answer names the request");
assert.equal(busy.logged.length, 1);
assert.deepEqual({ level: busy.logged[0]!.level, event: busy.logged[0]!.fields["event"], status: busy.logged[0]!.fields["status"], limit: busy.logged[0]!.fields["limit"] }, { level: "warn", event: "request.busy", status: 503, limit: "lock_timeout" }, "a busy lender is a warning");
assert.equal(busy.logged[0]!.fields["err"], lockWait, "with the database's own error");
const stopped = handled(markRolledBack(new DatabaseLimitError("statement_timeout")));
assert.deepEqual([stopped.logged[0]!.level, stopped.logged[0]!.fields["limit"], stopped.headers["Retry-After"]], ["error", "statement_timeout", "5"], "a stopped statement is an error line");
const waitedChange = handled(markRolledBack(new DatabaseLimitError("workspace_busy")));
assert.deepEqual([waitedChange.status, waitedChange.headers["Retry-After"], waitedChange.body.committed, waitedChange.logged[0]!.level, waitedChange.logged[0]!.fields["limit"]], [503, "2", false, "warn", "workspace_busy"], "a team or persona change that could not start is a warning, retried, with nothing saved");
checks += 18;

// ---- Readiness: a database that answers but lacks a table or column this build needs is not ready; one that lacks only an index is ready and says so; names stay in the log ----
const complete = readinessAnswer({ status: "ok", latencyMs: 3, schema: { status: "ok", missing: [] } });
assert.deepEqual([complete.httpStatus, complete.body.status, complete.body.checks.schema], [200, "ok", { status: "ok" }]);
const missingColumn = "column valopay_operations.receipt: apply lib/db/migrations/003_pilot_workflow.sql";
const incomplete = readinessAnswer({ status: "ok", latencyMs: 3, schema: { status: "incomplete", missing: [missingColumn] } });
assert.deepEqual([incomplete.httpStatus, incomplete.body.status, incomplete.body.checks.database.status], [503, "degraded", "ok"], "an answering database without a table or column the build uses is not ready");
assert.deepEqual(incomplete.body.checks.schema, { status: "incomplete" }, "and the public answer says only that, not what is missing");
const missingIndex = "index valopay_operations_pending: apply lib/db/migrations/007_journal_and_lender_indexes.sql";
const slower = readinessAnswer({ status: "ok", latencyMs: 3, schema: { status: "indexes_missing", missing: [missingIndex] } });
assert.deepEqual([slower.httpStatus, slower.body.status, slower.body.checks.schema], [200, "ok", { status: "indexes_missing" }], "a missing index leaves the instance in rotation, marked");
assert.ok(!JSON.stringify([incomplete.body, slower.body]).includes("valopay_operations"), "no table, column or index is named publicly");
const unreachable = readinessAnswer({ status: "failed", latencyMs: 2000, error: "connect ECONNREFUSED 127.0.0.1:5432", schema: { status: "unchecked", missing: [] } });
assert.deepEqual([unreachable.httpStatus, unreachable.body.status, unreachable.body.checks.database.status, unreachable.body.checks.schema.status], [503, "degraded", "failed", "unchecked"]);
assert.ok(!JSON.stringify(unreachable.body).includes("ECONNREFUSED"), "the connection error stays in the log");
// The log names what is missing: a failing check every time, missing indexes once until the set changes, so a host polling every few seconds does not repeat it.
const warned = (database: Parameters<typeof readinessWarning>[0]) => readinessWarning(database)?.fields;
const indexesOnly = { status: "ok" as const, latencyMs: 3, schema: { status: "indexes_missing" as const, missing: [missingIndex] } };
assert.deepEqual(warned(indexesOnly), { event: "readiness.indexes_missing", schema: "search_path", missing: [missingIndex] });
assert.equal(warned(indexesOnly), undefined, "the same missing index is not written again");
const bothIndexes = { ...indexesOnly, schema: { status: "indexes_missing" as const, missing: [missingIndex, "index valopay_merchants_workspace: apply lib/db/migrations/007_journal_and_lender_indexes.sql"] } };
assert.equal(warned(bothIndexes)?.["event"], "readiness.indexes_missing", "a changed set is written");
assert.equal(warned({ status: "ok", latencyMs: 3, schema: { status: "ok", missing: [] } }), undefined, "a complete schema writes nothing");
assert.equal(warned(indexesOnly)?.["event"], "readiness.indexes_missing", "and an index missing again after that is written again");
const incompleteCheck = { status: "ok" as const, latencyMs: 3, schema: { status: "incomplete" as const, missing: [missingColumn] } };
assert.deepEqual([warned(incompleteCheck), warned(incompleteCheck)].map((fields) => [fields?.["event"], fields?.["reason"], fields?.["missing"]]), [["readiness.failed", "schema incomplete", [missingColumn]], ["readiness.failed", "schema incomplete", [missingColumn]]], "a missing column fails every check and is written every time");
assert.equal(warned({ ...incompleteCheck, searched: "valopay_runtime_staging" })?.["schema"], "valopay_runtime_staging", "and the line names the isolated schema it read");
assert.deepEqual(warned({ status: "failed", latencyMs: 2000, error: "connect ECONNREFUSED 127.0.0.1:5432", schema: { status: "unchecked", missing: [] } }), { event: "readiness.failed", latencyMs: 2000, reason: "connect ECONNREFUSED 127.0.0.1:5432" });
checks += 16;

// ---- Over HTTP: liveness, readiness, ids on answers, refusals in the log, nothing secret written ----
const server = app.listen(0);
try {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  const health = await fetch(`${base}/api/healthz?token=should-not-be-logged`);
  const healthBody = await health.json() as { status: string; build: string; startedAt: string; uptimeSeconds: number; scheduler: { state: string; ticks: number; backlog: unknown } };
  assert.equal(health.status, 200);
  assert.equal(healthBody.status, "ok");
  assert.equal(healthBody.build, BUILD);
  assert.equal(BUILD, "source", "run from the source tree, the build is named as such");
  assert.ok(typeof healthBody.uptimeSeconds === "number" && healthBody.uptimeSeconds >= 0);
  assert.match(healthBody.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(healthBody.scheduler.state, "not_started", "nothing started the scheduler in this process");
  assert.equal(healthBody.scheduler.backlog, null, "what is still owed is unknown until a pass reads it");
  assert.equal(health.headers.get("cache-control"), "no-store");
  assert.match(health.headers.get("x-request-id") ?? "", /^[0-9a-f]{16}$/, "every answer names its request");
  markSchedulerOff();
  assert.equal(schedulerStatus().state, "off");
  assert.equal(((await (await fetch(`${base}/api/healthz`)).json()) as { scheduler: { state: string } }).scheduler.state, "off", "the health answer says when closes are not scheduled here");
  // What the latest pass read as still owed, as counts: the answer names no lender, and counts public anonymous sandboxes apart.
  const owed = { checkedAt: "2026-09-26T06:01:00.000Z", overdue: 2, failing: 1, lateAfterMinutes: 30, publicSandboxes: { overdue: 1, failing: 1 } };
  applySchedulerEvent({ type: "succeeded", at: owed.checkedAt, run: null, backlog: owed });
  assert.deepEqual(((await (await fetch(`${base}/api/healthz`)).json()) as { scheduler: { backlog: unknown } }).scheduler.backlog, owed, "the health answer carries the lenders still owed a close");
  checks += 12;

  const started = Date.now();
  const ready = await fetch(`${base}/api/readyz`);
  const readyBody = await ready.json() as { status: string; build: string; checks: { database: { status: string; latencyMs: number }; schema: { status: string } } };
  assert.equal(ready.status, 503, "no database behind the placeholder address: not ready");
  assert.equal(readyBody.status, "degraded");
  assert.equal(readyBody.checks.database.status, "failed");
  assert.ok(typeof readyBody.checks.database.latencyMs === "number");
  assert.deepEqual(readyBody.checks.schema, { status: "unchecked" }, "a database that does not answer has its schema unchecked");
  assert.ok(Date.now() - started < 5_000, "the readiness check is bounded");
  assert.ok(!JSON.stringify(readyBody).includes("127.0.0.1"), "the answer does not describe the database");
  checks += 7;

  // A request that needs the database while it cannot be reached is turned away with a 503 that says when to retry.
  const unreachable = await fetch(`${base}/api/v1/workspace`);
  const unreachableBody = await unreachable.json() as { error: string; committed?: boolean; requestId: string };
  assert.equal(unreachable.status, 503, "an unreachable database is a 503, not a general 500");
  assert.equal(unreachable.headers.get("retry-after"), "10");
  assert.deepEqual(unreachableBody, { error: "The database is not available. Try again shortly.", committed: false, requestId: unreachable.headers.get("x-request-id") }, "in plain words, naming the request");
  checks += 3;

  const quoted = await fetch(`${base}/api/healthz`, { headers: { "X-Request-Id": "support-ticket-4711" } });
  assert.match(quoted.headers.get("x-request-id") ?? "", /^[0-9a-f]{16}$/, "by default a client's id is never taken");
  process.env["VALOPAY_EDGE_REQUEST_ID"] = "on";
  const kept = await fetch(`${base}/api/healthz`, { headers: { "X-Request-Id": "edge-0123456789" } });
  assert.equal(kept.headers.get("x-request-id"), "edge-0123456789", "with VALOPAY_EDGE_REQUEST_ID=on the edge's id comes back on the answer");
  const replaced = await fetch(`${base}/api/healthz`, { headers: { "X-Request-Id": "<not a token>" } });
  assert.match(replaced.headers.get("x-request-id") ?? "", /^[0-9a-f]{16}$/);
  delete process.env["VALOPAY_EDGE_REQUEST_ID"];
  checks += 3;

  const unknown = await fetch(`${base}/api/v1/no-such-resource`, { headers: { Cookie: "valopay_sandbox=SECRET-COOKIE-VALUE" } });
  const unknownBody = await unknown.json() as { error: string; requestId: string };
  assert.equal(unknown.status, 404);
  assert.equal(unknownBody.error, "Unknown resource.");
  assert.equal(unknownBody.requestId, unknown.headers.get("x-request-id"), "the body's id is the answer's id");
  const foreign = await fetch(`${base}/api/v1/webhooks/test`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}" });
  const foreignBody = await foreign.json() as { requestId: string };
  assert.equal(foreign.status, 403);
  assert.equal(foreignBody.requestId, foreign.headers.get("x-request-id"));
  checks += 5;

  const written = lines();
  // A request line ("request completed", or "request errored" for a 5xx) carries the response time; the request's other lines (a refusal, a failed readiness) carry req too.
  const requestLines = written.filter((line) => typeof line["responseTime"] === "number");
  assert.ok(requestLines.length >= 6, `one line per request (${requestLines.length})`);
  for (const line of requestLines) {
    assert.equal(line["service"], "valopay-api");
    assert.equal(line["build"], BUILD);
    assert.ok(typeof line["req"]["id"] === "string" && line["req"]["id"].length >= 8, "the request line carries the id");
    assert.ok(typeof line["responseTime"] === "number", "and its time");
    assert.ok(typeof line["res"]["statusCode"] === "number");
  }
  assert.ok(requestLines.some((line) => line["req"]["url"] === "/api/healthz" && line["req"]["id"] === "edge-0123456789"), "the kept id is the one in the log");
  assert.ok(!readFileSync(logFile, "utf8").includes("should-not-be-logged"), "a query string is not written");
  assert.ok(!readFileSync(logFile, "utf8").includes("SECRET-COOKIE-VALUE"), "a cookie is not written");
  const refusal = written.find((line) => line["event"] === "request.refused" && line["reason"] === "origin");
  assert.ok(refusal, "a cross-origin refusal is a named event");
  assert.equal(refusal!["req"]["id"], foreign.headers.get("x-request-id"), "on the request's own id");
  const notReady = written.find((line) => line["event"] === "readiness.failed");
  assert.ok(notReady && typeof notReady["reason"] === "string", "a failed readiness check says why, in the log");
  const failed = requestLines.find((line) => line["req"]["url"] === "/api/readyz");
  assert.equal(failed?.["level"], 50, "a 5xx answer is an error line");
  const turnedAway = requestLines.find((line) => line["req"]["url"] === "/api/v1/workspace");
  assert.equal(turnedAway?.["level"], 40, "a 503 that says when to retry is a warning line, so busy moments do not page anyone");
  const busyLine = written.find((line) => line["event"] === "request.busy");
  assert.deepEqual([busyLine?.["level"], busyLine?.["limit"], busyLine?.["req"]?.["id"]], [50, "database_unavailable", unreachable.headers.get("x-request-id")], "the handler's own line says which limit, at error level when the database is unreachable");
  assert.ok(requestLines.filter((line) => line["res"]["statusCode"] < 500).every((line) => line["level"] === 30), "every other answer is an info line");
  checks += 14 + requestLines.length * 5;
} finally {
  server.close();
  rmSync(logFile, { force: true });
}

console.log(`Observability tests passed (${checks} checks): request ids kept or replaced and returned, ids in error bodies, stacks and reasons in the log, liveness with build and scheduler, bounded readiness, query strings and cookies never written.`);
