// Offline checks that the contract (lib/api-spec/openapi.json) says what the
// routes do (audit item 24): which writes need an Idempotency-Key, that a
// missing merchantId is the same 400 everywhere, that date-times with an
// offset are accepted, and that every error answer has the documented body
// and status. The app runs against an unreachable database, so every request
// here is answered before any query or by the database-limit answer.
import assert from "node:assert/strict";
import { answerErrors, contractErrors, contractOperations, loadContract } from "./contract-schema.js";

process.env["DATABASE_URL"] ??= "postgres://postgres@127.0.0.1:1/valopay-unused";
process.env["LOG_LEVEL"] ??= "silent";
process.env["CLERK_SECRET_KEY"] ??= "sk_test_placeholder";
process.env["CLERK_PUBLISHABLE_KEY"] ??= `pk_test_${Buffer.from("clerk.example.test$").toString("base64")}`;
// Loaded after the placeholder database address is set: the store reads it on import (no query is ever made).
const { recoverableRequest } = await import("../src/lib/operation-recovery.js");

let checks = 0;
const failures: string[] = [];
/** Runs one group of checks; a failure is recorded and the next group still runs, so every gap shows at once. */
async function section(title: string, run: () => void | Promise<void>) {
  try { await run(); } catch (error) { failures.push(`${title}: ${error instanceof Error ? error.message : String(error)}`); }
}
const spec = loadContract();
const operations = contractOperations(spec);
const schemas = spec.components.schemas as Record<string, any>;
const label = (entry: { method: string; path: string }) => `${entry.method} ${entry.path}`;
const parameter = (operation: Record<string, any>, name: string) => (operation.parameters ?? []).find((item: any) => item.name === name);
const lenderScoped = (operation: Record<string, any>) => parameter(operation, "merchantId")?.required === true;
const writes = operations.filter((entry) => entry.method === "POST" || entry.method === "PATCH");
/** Operations answered without a workspace transaction: they never meet a database limit. */
const noDatabase = new Set(["GET /healthz", "GET /v1/openapi.json", "POST /v1/webhooks/{provider}", "POST /v1/team/verify"]);
/** A concrete path for a template: the first value of an enumerated parameter, a customer kind, or a 64-character hex id. */
function concrete(entry: { path: string; operation: Record<string, any> }): string {
  return entry.path.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const schema = parameter(entry.operation, name)?.schema ?? {};
    if (schema.enum) return String(schema.enum[0]);
    return name === "kind" ? "customers" : "a".repeat(64);
  });
}
/** A body the journal treats as recoverable, where the route needs one to be. */
const journalBody = (path: string) => path === "/v1/imports" ? { commit: true } : path === "/v1/actions" ? { action: "run_reconciliation" } : {};

// ---- 1. The error body and the statuses every operation can return ----
await section("error body and statuses", () => {
  const error = schemas.ErrorBody;
  assert.ok(error, "the contract describes the error body every refusal and failure carries");
  assert.deepEqual([...error.required].sort(), ["error", "requestId"]);
  assert.deepEqual(Object.keys(error.properties).sort(), ["code", "committed", "detailCount", "details", "error", "operation", "requestId"]);
  assert.deepEqual(error.properties.committed.const, false, "committed is only ever false: nothing was saved");
  assert.deepEqual(error.properties.operation.enum, ["pending", "running", "completed", "cancelled"], "operation names the journal entry's state");
  assert.equal(error.properties.details.maxItems, 20, "a validation refusal names at most 20 fields");
  checks += 6;
  for (const entry of operations) {
    const { responses } = entry.operation;
    assert.ok(responses["500"], `${label(entry)} lists the 500 every route can answer`);
    for (const [status, response] of Object.entries(responses as Record<string, any>)) {
      if (Number(status) < 400) continue;
      const schema = response.content?.["application/json"]?.schema;
      // Readiness answers its own body, and staff re-verification answers the identity provider's instruction.
      const own = (label(entry) === "GET /readyz" && status === "503") || (label(entry) === "POST /v1/team/verify" && status === "403");
      if (!own) assert.deepEqual(schema, { $ref: "#/components/schemas/ErrorBody" }, `${label(entry)} ${status} names the error body`);
    }
    if (entry.path.startsWith("/v1/")) {
      assert.ok(responses["429"]?.headers?.["Retry-After"], `${label(entry)} lists 429 with Retry-After`);
      assert.ok(responses["403"], `${label(entry)} lists 403: another origin is refused`);
    }
    if (!noDatabase.has(label(entry)) && label(entry) !== "GET /readyz") assert.ok(responses["503"]?.headers?.["Retry-After"], `${label(entry)} lists the database-limit 503 with Retry-After`);
    if (lenderScoped(entry.operation)) {
      assert.ok(responses["400"] && responses["404"], `${label(entry)} lists 400 and 404 for its lender`);
      assert.deepEqual({ minLength: parameter(entry.operation, "merchantId").schema.minLength, maxLength: parameter(entry.operation, "merchantId").schema.maxLength }, { minLength: 1, maxLength: 100 }, `${label(entry)}: merchantId is 1 to 100 characters`);
    }
    // The body parser reads every POST and PATCH, whether or not the operation takes a body.
    if (entry.method === "POST" || entry.method === "PATCH") assert.ok(responses["400"] && responses["413"] && responses["415"], `${label(entry)} lists the body refusals 400, 413 and 415`);
    checks += 1;
  }
  for (const path of ["/v1/operations/{id}/retry", "/v1/operations/{id}/cancel"]) assert.ok(spec.paths[path].post.responses["410"], `${path} lists 410 for a request whose stored payload expired`);
  // An export whose file retention deleted can be neither downloaded nor retried.
  assert.ok(spec.paths["/v1/exports/{id}/download"].get.responses["410"], "the export download lists 410 for a file retention deleted");
  assert.ok(spec.paths["/v1/exports/{id}/retry"].post.responses["410"], "the export retry lists 410 for a file retention deleted");
  // The export queue's 429 is described, with its Retry-After.
  assert.match(spec.paths["/v1/exports"].post.responses["429"].description, /ten exports waiting or running/);
  assert.match(spec.paths["/v1/exports"].post.responses["429"].headers["Retry-After"].description, /30 when the lender's export queue is full/);
  checks += 6;
});

// ---- 1a. A removed export file: the run holding its deletion receipt, and the two ways a file goes ----
await section("removed export files", () => {
  const result = schemas.ExportResult;
  assert.deepEqual(result.properties.retentionRunId, { type: "string" }, "ExportResult names the retention run that removed its file");
  assert.match(result.description, /retentionRunId names that run, whose deletion receipt an administrator opens with GET \/v1\/lifecycle\/runs\/\{id\}/);
  // The expiry sweep removes an idle anonymous sandbox's files with it, with no retention run.
  assert.match(result.description, /apart from an idle anonymous sandbox, which the expiry sweep deletes whole with its files/);
  checks += 3;
});

// ---- 1b. A repeat after retention: every write whose key the journal records lists 410, and only those ----
await section("410 on repeated keys", () => {
  for (const entry of writes) {
    const key = parameter(entry.operation, "Idempotency-Key");
    if (!key) continue;
    // The journal keeps the request; retention may remove its stored result, and a repeat with the key is then gone.
    const journaled = recoverableRequest(entry.method, concrete(entry), journalBody(entry.path));
    if (journaled) assert.ok(entry.operation.responses["410"], `${label(entry)} is journaled when it carries a key, so a repeat after retention can answer 410`);
    // The new lender's key names the lender; nothing retention removes answers its repeat.
    else assert.equal(entry.operation.responses["410"], undefined, `${label(entry)} is not journaled, so it never answers 410`);
    assert.equal(/journal entry is closed|410/.test(key.description), journaled, `${label(entry)}: the key's description says what the journal does with it`);
    checks += 2;
  }
});

// ---- 1c. A money refusal: the operations that compute money list 422, naming its code in the error body ----
await section("money refusals", () => {
  const computesMoney = ["GET /v1/overview", "GET /v1/customers/{id}/timeline", "GET /v1/reports", "GET /v1/customers/{id}/history", "GET /v1/connected", "POST /v1/connected/actions", "POST /v1/actions", "POST /v1/operations/{id}/retry"];
  for (const entry of operations) {
    const refusal = entry.operation.responses["422"];
    assert.equal(Boolean(refusal), computesMoney.includes(label(entry)), `${label(entry)} ${computesMoney.includes(label(entry)) ? "computes money, so it lists" : "computes no money, so it never lists"} 422`);
    if (refusal) assert.match(refusal.description, /INVALID_MONEY_AMOUNT.*INVALID_MONEY_RATE.*MONEY_OUT_OF_RANGE/, `${label(entry)} 422 names the codes`);
    checks += 1;
  }
  assert.deepEqual(schemas.ErrorBody.properties.code.enum.filter((code: string) => /MONEY/.test(code)), ["INVALID_MONEY_AMOUNT", "INVALID_MONEY_RATE", "MONEY_OUT_OF_RANGE"], "the error body's code names a money refusal");
  assert.match(spec.paths["/v1/connected"].get.responses["422"].description, /A read saves nothing either way/);
  assert.match(spec.paths["/v1/actions"].post.responses["422"].description, /journal entry is closed/);
  checks += 3;
});

// ---- 2. Every write says exactly what its route does with an Idempotency-Key ----
await section("keys in the contract", () => {
  for (const entry of operations) {
    const key = parameter(entry.operation, "Idempotency-Key");
    if (entry.method === "GET") { assert.equal(key, undefined, `${label(entry)} is a read: no key`); continue; }
    if (recoverableRequest(entry.method, concrete(entry), journalBody(entry.path))) assert.ok(key, `${label(entry)} is journaled when it carries a key, so the contract lists the header`);
    if (key) assert.deepEqual({ minLength: key.schema.minLength, maxLength: key.schema.maxLength }, { minLength: 8, maxLength: 200 }, `${label(entry)}: a key is 8 to 200 characters`);
    checks += 1;
  }
});

// ---- 2b. The health answer's cleanup result counts files parked for review apart, and an older answer without the count still parses ----
await section("parked cleanup files", async () => {
  const result = schemas.CleanupPassResult;
  assert.deepEqual(result.properties.parked, { type: "integer", minimum: 0 }, "the cleanup result counts files parked for an operator's review");
  assert.ok(!result.required.includes("parked"), "the count is optional: an older build's answer has none");
  const { HealthCheckResponse } = await import("@workspace/api-zod");
  const cleanup = (lastResult: object) => ({ status: "ok", build: "fixture", startedAt: "2026-09-29T10:00:00.000Z", uptimeSeconds: 1, scheduler: { state: "off", intervalMs: null, ticks: 0, lastTickAt: null, lastRun: null },
    background: { state: "running", jobs: { closes: false, backlog: false, exports: true, cleanup: true }, heartbeatIntervalMs: 10_000, staleAfterMs: 45_000, startedAt: null, lastHeartbeatAt: null, crashCount: 0, restartCount: 0, lastCrashAt: null,
      cleanup: { state: "failed", intervalMs: 60_000, staleAfterMs: 195_000, lastCheckedAt: null, lastSuccessAt: null, lastErrorAt: null, lastResult } } });
  assert.equal(HealthCheckResponse.parse(cleanup({ attempted: 0, removed: 0, deferred: 0, pendingFailures: 1 })).background?.cleanup.lastResult?.parked, undefined, "an older build's answer parses");
  assert.equal(HealthCheckResponse.parse(cleanup({ attempted: 0, removed: 0, deferred: 0, pendingFailures: 0, parked: 2 })).background?.cleanup.lastResult?.parked, 2, "and a newer one keeps its count");
  assert.equal(HealthCheckResponse.safeParse(cleanup({ attempted: 0, removed: 0, deferred: 0, pendingFailures: 0, parked: -1 })).success, false);
  checks += 5;
});

// ---- 3. The routes, answered before any query ----
const { default: app } = await import("../src/app.js");
const server = app.listen(0);
try {
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/api`;
  const send = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
    const text = await response.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, headers: response.headers };
  };
  const fields = (data: any): string[] => (data?.details ?? []).map((detail: { field: string }) => detail.field);
  const documented = (method: string, path: string, answer: { status: number; data: unknown }) => {
    const problems = answerErrors(spec, method, path, answer.status, answer.data);
    assert.deepEqual(problems, [], `${method} ${path} answered as the contract documents`);
  };

  // A missing merchantId is a 400 naming the field on every lender-scoped operation.
  await section("missing merchantId", async () => { for (const entry of operations.filter((item) => lenderScoped(item.operation))) {
    const others = (entry.operation.parameters as any[]).filter((item) => item.in === "query" && item.required && item.name !== "merchantId").map((item) => `${item.name}=a`);
    const path = `${concrete(entry)}${others.length ? `?${others.join("&")}` : ""}`;
    const answer = await send(entry.method, path, entry.method === "GET" ? undefined : journalBody(entry.path));
    assert.equal(answer.status, 400, `${label(entry)} without merchantId: ${JSON.stringify(answer.data)}`);
    assert.ok(fields(answer.data).includes("merchantId"), `${label(entry)} names merchantId: ${JSON.stringify(answer.data)}`);
    documented(entry.method, path, answer);
    const empty = await send(entry.method, `${path}${path.includes("?") ? "&" : "?"}merchantId=`, entry.method === "GET" ? undefined : journalBody(entry.path));
    assert.equal(empty.status, 400, `${label(entry)} with an empty merchantId`);
    assert.ok(fields(empty.data).includes("merchantId"));
    // Sent twice, it is the same refusal, never the two values joined into one lender's name.
    const twice = await send(entry.method, `${path}${path.includes("?") ? "&" : "?"}merchantId=offline-lender&merchantId=other-lender`, entry.method === "GET" ? undefined : journalBody(entry.path));
    assert.equal(twice.status, 400, `${label(entry)} with merchantId sent twice: ${JSON.stringify(twice.data)}`);
    assert.ok(fields(twice.data).includes("merchantId"));
    checks += 7;
  } });

  // A write whose contract requires a key refuses a request without one, naming the header, before reading
  // its body; a write whose key is optional never asks for one. A key of the wrong length is refused by name.
  await section("keys the routes take", async () => { for (const entry of writes) {
    const key = parameter(entry.operation, "Idempotency-Key");
    const path = `${concrete(entry)}${lenderScoped(entry.operation) ? "?merchantId=offline-lender" : ""}`;
    const answer = await send(entry.method, path, journalBody(entry.path));
    if (key?.required) {
      assert.equal(answer.status, 400, `${label(entry)} requires a key: ${JSON.stringify(answer.data)}`);
      assert.deepEqual(fields(answer.data), ["Idempotency-Key"], `${label(entry)} names the missing header`);
    } else assert.ok(!fields(answer.data).includes("Idempotency-Key"), `${label(entry)} does not require a key: ${JSON.stringify(answer.data)}`);
    documented(entry.method, path, answer);
    if (key) {
      const short = await send(entry.method, path, journalBody(entry.path), { "Idempotency-Key": "short" });
      assert.equal(short.status, 400, `${label(entry)} refuses a short key`);
      assert.deepEqual(fields(short.data), ["Idempotency-Key"], `${label(entry)} names the short key: ${JSON.stringify(short.data)}`);
    }
    checks += 3;
  } });

  // The body parser reads every POST and PATCH: one that takes no body still refuses a body it cannot read, as its
  // contract says. From another client address, so the request limit these checks share stays clear.
  await section("body refusals without a request body", async () => {
    const elsewhere = { "X-Forwarded-For": "198.51.100.24" };
    for (const entry of writes.filter((item) => !item.operation.requestBody)) {
      const path = `${concrete(entry)}${lenderScoped(entry.operation) ? "?merchantId=offline-lender" : ""}`;
      const bodies: Array<[string, Record<string, string>, number]> = [["x".repeat(2_100_000), elsewhere, 413], ["{}", { ...elsewhere, "Content-Type": "application/json; charset=latin1" }, 415], ['{"', elsewhere, 400]];
      for (const [body, headers, status] of bodies) {
        const answer = await send(entry.method, path, body, headers);
        assert.equal(answer.status, status, `${label(entry)} with an unreadable body: ${JSON.stringify(answer.data)}`);
        documented(entry.method, path, answer);
        checks += 2;
      }
    }
    // The Paystack test ingress reads its own raw body, and refuses an encoding it cannot read.
    const ingress = `/v1/providers/paystack/${"a".repeat(64)}/events`;
    const encoded = await send("POST", ingress, "{}", { ...elsewhere, "Content-Encoding": "x-unknown" });
    assert.equal(encoded.status, 415, JSON.stringify(encoded.data));
    documented("POST", ingress, encoded);
    checks += 2;
  });

  // Date-times with an offset pass validation and reach the lender (here, the database-limit answer).
  await section("offset date-times", async () => {
  const offset = await send("POST", `/v1/pilot/batches/${"b".repeat(64)}/commit?merchantId=offline-lender`, { expectedUpdatedAt: "2026-09-23T11:00:00.000+01:00" });
  assert.ok(!fields(offset.data).includes("expectedUpdatedAt"), `an offset date-time is accepted: ${JSON.stringify(offset.data)}`);
  assert.equal(offset.status, 503);
  checks += 2;
  });

  // An edit names the version it was made on (UX-B01-GEN). The version is checked in the lender's transaction, once a
  // keyed repeat has been answered from its stored result, so an edit with it, without it or with an empty one reaches
  // the lender (here, the database-limit answer); the rest of the body is checked before the lender is read.
  // allocation-decisions.integration.test.ts pins the refusal by name and the repeat. From another client address, so
  // the request limit these checks share stays clear.
  await section("versions edits require", async () => {
    const elsewhere = { "X-Forwarded-For": "198.51.100.25" };
    const edits: Array<[string, Record<string, unknown>, string, string, Record<string, unknown>, string]> = [
      ["/v1/records/customers/a?merchantId=offline-lender", { name: "Renamed customer" }, "expectedUpdatedAt", "2026-09-19T12:00:00.000+01:00", { name: "" }, "name"],
      ["/v1/settings?merchantId=offline-lender", { closeTime: "07:00" }, "expectedRevision", "a".repeat(64), { executionStart: "nine" }, "executionStart"],
    ];
    for (const [path, body, field, version, invalid, named] of edits) {
      for (const [label, sent] of [["without", body], ["with an empty", { ...body, [field]: "" }], ["with", { ...body, [field]: version }]] as const) {
        const answer = await send("PATCH", path, sent, elsewhere);
        assert.equal(answer.status, 503, `PATCH ${path} ${label} ${field} reaches the lender: ${JSON.stringify(answer.data)}`);
      }
      const refused = await send("PATCH", path, invalid, elsewhere);
      assert.deepEqual([refused.status, fields(refused.data)], [400, [named]], `PATCH ${path} with an invalid ${named} and no ${field} is refused before the lender is read, naming only ${named}: ${JSON.stringify(refused.data)}`);
      documented("PATCH", path, refused);
      checks += 5;
    }
    // The contract says so, and names the data an allocation decision requires.
    assert.deepEqual(schemas.RecordUpdate.required, ["expectedUpdatedAt"], "a record edit requires expectedUpdatedAt");
    assert.deepEqual(schemas.SettingsInput.required, ["expectedRevision"], "a settings edit requires expectedRevision");
    assert.deepEqual(schemas.AllocationDecisionData?.required, ["proposalId", "proposalUpdatedAt"], "an allocation decision's data requires the proposal and its version");
    assert.match(spec.paths["/v1/actions"].post.description, /confirm_allocation and reject_allocation require data\.proposalId and data\.proposalUpdatedAt/, "the action's description names the pair");
    checks += 4;
  });

  // The service's own refusals carry the documented error body.
  await section("documented refusals", async () => {
  assert.ok(schemas.ErrorBody, "the contract describes the error body");
  const refusals: Array<[string, string, unknown, Record<string, string>, number]> = [
    ["GET", "/v1/nowhere", undefined, {}, 404],
    ["POST", "/v1/webhooks/test", {}, {}, 403],
    ["GET", "/v1/workspace", undefined, { Origin: "https://elsewhere.example" }, 403],
    ["POST", "/v1/pilot/lenders", '{"name":', {}, 400],
    ["POST", "/v1/pilot/lenders", { name: "Nul\u0000" }, {}, 400],
    ["POST", "/v1/pilot/lenders", "x".repeat(2_100_000), {}, 413],
    ["POST", "/v1/pilot/lenders", "{}", { "Content-Type": "application/json; charset=latin1" }, 415],
    ["GET", "/v1/overview?merchantId=offline-lender", undefined, {}, 503],
  ];
  for (const [method, path, body, headers, status] of refusals) {
    const answer = await send(method, path, body, headers);
    assert.equal(answer.status, status, `${method} ${path}: ${JSON.stringify(answer.data)}`);
    assert.deepEqual(contractErrors(spec, schemas.ErrorBody, answer.data), [], `${method} ${path} answers the error body: ${JSON.stringify(answer.data)}`);
    if (!path.startsWith("/v1/nowhere")) documented(method, path, answer);
    checks += 2;
  }
  const busy = await send("GET", "/v1/overview?merchantId=offline-lender");
  assert.ok(Number(busy.headers.get("Retry-After")) > 0, "a database-limit 503 says when to retry");
  checks += 1;
  });
} finally {
  server.close();
}
if (failures.length) {
  console.error(failures.join("\n\n"));
  console.error(`API contract checks failed: ${failures.length} group(s).`);
  process.exit(1);
}

console.log(`API contract checks passed (${checks} checks): the error body and statuses, the 422 of an operation that computes money, the Idempotency-Key each write takes and the 410 of a repeat after retention, the health answer's optional count of parked cleanup files, a missing merchantId, unreadable bodies on writes without one, offset date-times, the versions edits require and the documented refusals.`);
process.exit(0);
