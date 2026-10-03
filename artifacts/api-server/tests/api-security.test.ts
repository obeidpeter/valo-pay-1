// Offline security regression checks for the API shell (see docs/security-review.md):
// how a thrown error is answered, and the headers and origin rule on every /api/v1 answer.
// No database: the webhook ingress routes answer without one, and the error handler is
// exercised with a fake request and response.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { ZodError } from "zod";
import { errorHandler } from "../src/lib/error-handler.js";
import { requestFingerprint } from "../src/lib/digests.js";
import { validateRecord } from "../src/domain/validation.js";
import { markRolledBack } from "../src/lib/transaction-outcome.js";
import { storageFailure } from "../src/lib/export-download.js";
import { DatabaseLimitError } from "../src/lib/database-limits.js";
import { markKeyed, markKeyUnused, markOperationClosed, operationClosed, registerRefusalCloser, type OperationState } from "../src/lib/refused-operations.js";
import { parsePublishableKey } from "@clerk/shared/keys";
import { ClerkAPIResponseError, ClerkRuntimeError } from "@clerk/shared/error";
import { ResponseContractError, replayedAnswer } from "../src/lib/contract.js";
import { connectedActionResultFor, MoneyArithmeticError } from "@workspace/valo-pay-1-schema";

let checks = 0;
type Answer = { status?: number; body?: unknown; headers?: Record<string, string> };
function answer(error: unknown): Answer {
  const out: Answer = {};
  const logged: unknown[] = [];
  const req = { id: "test-request", log: { error: (...args: unknown[]) => logged.push(args), warn: (...args: unknown[]) => logged.push(args), info: (...args: unknown[]) => logged.push(args) } };
  const res = { headersSent: false, setHeader(name: string, value: string) { out.headers = { ...out.headers, [name]: value }; return this; }, status(code: number) { out.status = code; return this; }, json(body: unknown) { out.body = body; return this; } };
  errorHandler(error, req as never, res as never, () => undefined);
  return out;
}

{
  const raised = Object.assign(new Error("Only an Admin can change lender settings."), { status: 403 });
  assert.deepEqual(answer(raised), { status: 403, body: { error: "Only an Admin can change lender settings.", requestId: "test-request" } }, "an error raised with a status is answered in its own words, with the request id");
  assert.deepEqual(answer(new Error("A reason is required for this business or destructive action.")), { status: 400, body: { error: "A reason is required for this business or destructive action.", requestId: "test-request" } }, "a domain rule without a status is a 400 in its own words");
  assert.equal(answer(new Error("Execution is not permitted in observation mode.")).status, 400, "a refusal without a status is a 400, whatever its wording");
  assert.equal(answer(new Error("Unsupported domain action: open_gate.")).status, 400, "words from the request never choose the status");
  const typeError = answer(new TypeError("Cannot read properties of undefined (reading 'merchant')"));
  assert.equal(typeError.status, 500, "a programming error is a 500");
  assert.equal((typeError.body as { error: string }).error, "We do not know yet whether Valo Pay 1 saved this. Check the original request in Request history before you change anything.", "a programming error's message stays out of the response and does not claim an unconfirmed write was rolled back");
  assert.equal(answer(new ReferenceError("x is not defined")).status, 500);
  const moneyRefusal = answer(new MoneyArithmeticError("MONEY_OUT_OF_RANGE", "private calculation context must not escape"));
  assert.equal(moneyRefusal.status, 422);
  assert.equal((moneyRefusal.body as { code: string }).code, "MONEY_OUT_OF_RANGE");
  assert.doesNotMatch(JSON.stringify(moneyRefusal), /private calculation/);
  assert.equal(answer(Object.assign(new RangeError("private runtime failure"), { code: "MONEY_OUT_OF_RANGE" })).status, 500);
  checks += 4;
  assert.equal(answer("a string thrown by mistake").status, 500, "something that is not an Error is a 500");
  assert.equal(answer(Object.assign(new Error("duplicate key"), { code: "23505" })).status, 409, "a database safety constraint is a conflict");
  assert.equal(answer(Object.assign(new Error("resource busy"), { code: "EBUSY" })).status, 500, "an error with a code the application does not own is a 500");
  // The body parser's errors are the request's fault, even the JSON SyntaxError.
  const parserError = (type: string, status: number) => Object.assign(new SyntaxError("Unexpected token } in JSON at position 9"), { type, status, statusCode: status, expose: true });
  assert.deepEqual(answer(parserError("entity.parse.failed", 400)), { status: 400, body: { error: "The request body is not valid JSON. Check its format and try again.", requestId: "test-request" } }, "malformed JSON is a 400 in plain words");
  assert.equal(answer(parserError("entity.too.large", 413)).status, 413);
  assert.equal(answer(parserError("charset.unsupported", 415)).status, 415);
  assert.equal(answer(Object.assign(new Error("invalid byte sequence"), { code: "22021" })).status, 400, "a NUL that reached PostgreSQL text is the request's fault");
  assert.equal((answer(Object.assign(new Error("unsupported Unicode escape sequence"), { code: "22P05" })).body as { error: string }).error, "Text cannot contain the NUL character (\\u0000). Remove it and try again.");
  // A service the application found unavailable keeps its status and words; the store says when nothing was saved.
  const unconfigured = answer(Object.assign(new Error("Private export storage is not configured. Contact the workspace administrator."), { status: 503 }));
  assert.deepEqual(unconfigured, { status: 503, body: { error: "Private export storage is not configured. Contact the workspace administrator.", requestId: "test-request" } }, "an application 503 is not flattened to a general 500");
  const rolledBack = answer(markRolledBack(Object.assign(new Error("Protected data cannot be opened. Ask the administrator to check the configured encryption key."), { status: 503 })));
  assert.equal((rolledBack.body as { committed?: boolean }).committed, false, "a refusal inside a rolled-back transaction says nothing was saved");
  const rolledBackBug = answer(markRolledBack(new TypeError("Cannot read properties of undefined")));
  assert.deepEqual(rolledBackBug, { status: 500, body: { error: "This action failed and nothing was saved. Try again, and quote this reference if it happens again.", committed: false, requestId: "test-request" } }, "a programming error whose transaction rolled back says nothing was saved, still in general words");
  // Storage failures and integrity failures are server-side, never a 400.
  assert.equal(answer(storageFailure(503)).status, 503, "a storage outage is a 503");
  assert.equal(answer(storageFailure(404)).status, 502, "a missing export object is the service's failure");
  assert.equal(answer(storageFailure(403)).status, 502);
  assert.equal(answer(Object.assign(new Error("Export object could not be downloaded."), { statusCode: 500 })).status, 502, "an upstream status alone is never the request's fault");
  const integrity = answer(Object.assign(new Error("This export file has changed since it was made, so it was not sent. Create the export again, and quote this reference if it happens again."), { status: 500, expose: true }));
  assert.equal(integrity.status, 500);
  assert.match((integrity.body as { error: string }).error, /has changed since it was made, so it was not sent/, "an integrity failure explains itself");
  const zod = answer(new ZodError([{ code: "custom", path: ["data", "amountKobo"], message: "Expected number" }]));
  assert.equal(zod.status, 400);
  assert.deepEqual((zod.body as { details: unknown[] }).details, [{ field: "data.amountKobo", message: "Expected number" }], "validation failures name their fields");
  // A database limit (a busy lender, a lock or statement past its limit, a lost connection) is a 503 that says when to retry.
  assert.deepEqual(answer(markRolledBack(new DatabaseLimitError("lock_timeout", { write: true }))), { status: 503, headers: { "Retry-After": "2" }, body: { error: "This lender is busy with another change. Nothing was saved. Try again in a moment.", committed: false, requestId: "test-request" } }, "a lock wait past its limit is a 503 with Retry-After, and nothing was saved");
  assert.equal(answer(markRolledBack(new DatabaseLimitError("statement_timeout"))).headers?.["Retry-After"], "5", "a stopped statement waits longer before a retry");
  assert.deepEqual(answer(new DatabaseLimitError("pool_timeout", { write: false })), { status: 503, headers: { "Retry-After": "2" }, body: { error: "Valo Pay 1 is busy. Try again in a moment.", requestId: "test-request" } }, "committed: false only when the store says nothing was saved");
  assert.equal(answer(Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" })).status, 500, "a raw PostgreSQL code is translated by the store, never guessed here");
  assert.equal((unconfigured as Answer).headers, undefined, "an application 503 sets no Retry-After");
  checks += 34;
}

{
  // A refusal whose request's journal entry is cancelled says so: neither this request nor an earlier one with its key was or can be saved.
  const answered = (error: unknown, closer?: () => Promise<OperationState | undefined>) => new Promise<Answer>((resolve) => {
    const out: Answer = {};
    const quiet = () => undefined;
    const req = { id: "test-request", log: { error: quiet, warn: quiet, info: quiet } };
    if (closer) registerRefusalCloser(req as never, closer);
    const res = { headersSent: false, setHeader(name: string, value: string) { out.headers = { ...out.headers, [name]: value }; return this; }, status(code: number) { out.status = code; return this; }, json(body: unknown) { out.body = body; resolve(out); return this; } };
    errorHandler(error, req as never, res as never, () => undefined);
  });
  const stale = () => Object.assign(new Error("The workspace changed. Refresh and review before trying again."), { status: 409 });
  assert.deepEqual(await answered(stale(), async () => "cancelled"), { status: 409, body: { error: "The workspace changed. Refresh and review before trying again.", requestId: "test-request", operation: "cancelled" } }, "a refusal that leaves its journal entry cancelled says so");
  assert.deepEqual(await answered(stale(), async () => "completed"), { status: 409, body: { error: "The workspace changed. Refresh and review before trying again.", requestId: "test-request", operation: "completed" } }, "a refusal whose entry an earlier attempt completed says so: that request was saved");
  assert.deepEqual(await answered(stale(), async () => undefined), { status: 409, body: { error: "The workspace changed. Refresh and review before trying again.", requestId: "test-request" } }, "a refusal whose entry could not be read carries no marker");
  assert.deepEqual(await answered(stale(), () => Promise.reject(new Error("pool closed"))), { status: 409, body: { error: "The workspace changed. Refresh and review before trying again.", requestId: "test-request" } }, "a closer that fails never marks the refusal");
  assert.deepEqual(await answered(markOperationClosed(Object.assign(new Error("This request was cancelled before it completed and saved nothing."), { status: 409 }))), { status: 409, body: { error: "This request was cancelled before it completed and saved nothing.", requestId: "test-request", operation: "cancelled" } }, "a refusal of a key whose entry was already cancelled says so without a closer");
  assert.equal(operationClosed(new Error("unmarked")), false);
  // A write the store rolled back at a database limit: the not-saved 503 closes the entry and says both.
  assert.deepEqual(await answered(markRolledBack(new DatabaseLimitError("lock_timeout", { write: true })), async () => "cancelled"), { status: 503, headers: { "Retry-After": "2" }, body: { error: "This lender is busy with another change. Nothing was saved. Try again in a moment.", committed: false, requestId: "test-request", operation: "cancelled" } }, "a not-saved 503 whose entry closed carries both committed:false and the marker");
  assert.equal(((await answered(Object.assign(new Error("The gateway timed out."), { status: 504 }))).body as { operation?: string }).operation, undefined, "a failure with no closed entry is never marked");
  checks += 8;
}

{
  // An answer that does not match its contract is the service's 500, in the words of what was asked (audit item 24, review).
  const answerTo = (error: unknown, method: string) => {
    const out: Answer & { logged: Array<{ level: string; fields: Record<string, unknown> }> } = { logged: [] };
    const log = (level: string) => (fields: Record<string, unknown>) => out.logged.push({ level, fields });
    const req = { id: "test-request", method, log: { error: log("error"), warn: log("warn"), info: log("info") } };
    const res = { headersSent: false, setHeader(name: string, value: string) { out.headers = { ...out.headers, [name]: value }; return this; }, status(code: number) { out.status = code; return this; }, json(body: unknown) { out.body = body; return this; } };
    errorHandler(error, req as never, res as never, () => undefined);
    return out;
  };
  const mismatch = () => new ZodError([{ code: "invalid_type", expected: "string", received: "undefined", path: ["record", "kind"], message: "Required" }]);
  const write = answerTo(markRolledBack(new ResponseContractError(mismatch())), "POST");
  assert.deepEqual([write.status, write.body], [500, { error: "This action failed and nothing was saved. Try again, and quote this reference if it happens again.", committed: false, requestId: "test-request" }], "a write's invalid answer, checked before COMMIT, saved nothing");
  const read = answerTo(markRolledBack(new ResponseContractError(mismatch())), "GET");
  assert.deepEqual([read.status, read.body], [500, { error: "Valo Pay 1 could not load this. Try again, and quote this reference if it happens again.", requestId: "test-request" }], "a read's invalid answer is a read's failure: no action, nothing to save");
  assert.deepEqual(answerTo(markRolledBack(new TypeError("x is undefined")), "GET").body, { error: "Valo Pay 1 could not load this. Try again, and quote this reference if it happens again.", requestId: "test-request" }, "so is a read's programming error");
  const replay = answerTo(markRolledBack(new ResponseContractError(mismatch(), { saved: true })), "POST");
  assert.deepEqual([replay.status, replay.body], [500, { error: "We do not know yet whether Valo Pay 1 saved this. Check the original request in Request history before you change anything.", requestId: "test-request" }], "a saved request's stored answer that cannot be given never says nothing was saved, though the repeat's transaction rolled back");
  assert.deepEqual(replay.logged.map((line) => [line.level, line.fields["event"], line.fields["replayed"]]), [["error", "response.invalid", true]], "and the log says which answer failed");
  // A 429 says when to try again: the refusal's own wait, or a minute.
  const queue = answerTo(Object.assign(new Error("Ten exports are already waiting or running for this lender."), { status: 429, retryAfterSeconds: 30 }), "POST");
  assert.deepEqual([queue.status, queue.headers], [429, { "Retry-After": "30" }], "a refusal's own Retry-After is sent");
  assert.deepEqual(answerTo(Object.assign(new Error("Slow down."), { status: 429 }), "POST").headers, { "Retry-After": "60" }, "every 429 says when to try again");
  assert.equal(answerTo(Object.assign(new Error("Refused."), { status: 409, retryAfterSeconds: 30 }), "POST").headers, undefined, "only a 429 carries it");
  checks += 10;
}

{
  // A repeated request's stored answer: fields an earlier build stored and the contract no longer lists are left out,
  // with a warning; any other mismatch cannot be answered within the contract, and is marked as saved.
  const logged: Array<{ event?: unknown; replayed?: unknown }> = [];
  const req = { log: { warn: (fields: { event?: unknown; replayed?: unknown }) => logged.push(fields) } } as never;
  const record = { id: "consent-1", merchantId: "lender-1", kind: "connected-consents", name: "Consent", status: "active", reference: "", amountKobo: 0, customerId: "", createdAt: "2026-09-21T10:00:00.000Z", updatedAt: "2026-09-21T10:00:00.000Z", data: {} };
  const receipt = { message: "Sample workspace updated.", record, mode: "synthetic", externalInstructionPerformed: false };
  const schema = connectedActionResultFor("consent.grant", "lender-1");
  assert.deepEqual(replayedAnswer(req, schema, { ...receipt, record: { ...record, effectiveStatus: "active" } }), receipt, "a field the contract no longer lists is left out of the replayed answer");
  assert.deepEqual(logged, [{ event: "response.invalid", replayed: true, issues: [{ path: "record", code: "unrecognized_keys" }] }], "and logged as a warning with its path");
  const { kind: _kind, ...incomplete } = record;
  assert.throws(() => replayedAnswer(req, schema, { ...receipt, record: incomplete }), (error: unknown) => error instanceof ResponseContractError && error.saved, "a receipt missing a field cannot be answered, and is marked saved");
  assert.throws(() => replayedAnswer(req, schema, { ...receipt, record: { ...record, merchantId: "lender-2", note: "added" } }), (error: unknown) => error instanceof ResponseContractError && error.saved, "an addition does not excuse a record of another lender");
  checks += 4;
}

{
  // Malformed input is the request's fault, never a server failure (audit 23 September, items 3 and 4; security item 7):
  // a library's own 4xx it marks safe to expose, a body that cannot be decompressed and a path the router cannot decode
  // keep their 4xx, in plain words, and are logged as refusals at info, never as failures at error.
  type Logged = Array<{ level: string; fields: Record<string, unknown> }>;
  const handled = (error: unknown, method = "POST") => {
    const out: Answer & { logged: Logged } = { logged: [] };
    const log = (level: string) => (fields: Record<string, unknown>) => out.logged.push({ level, fields });
    const req = { id: "test-request", method, log: { error: log("error"), warn: log("warn"), info: log("info") } };
    const res = { headersSent: false, setHeader(name: string, value: string) { out.headers = { ...out.headers, [name]: value }; return this; }, status(code: number) { out.status = code; return this; }, json(body: unknown) { out.body = body; return this; } };
    errorHandler(error, req as never, res as never, () => undefined);
    return out;
  };
  const levels = (answered: { logged: Logged }) => answered.logged.map((line) => [line.level, line.fields["event"]]);
  // The router's decodeParam marks a path parameter it cannot decode 400, as a URIError.
  const undecodable = handled(Object.assign(new URIError("Failed to decode param '%E0%A4%A'"), { status: 400 }), "GET");
  assert.deepEqual([undecodable.status, undecodable.body], [400, { error: "This address is not valid. Check the link and try again.", requestId: "test-request" }], "a path the router cannot decode is a 400, not a programming error's 500");
  assert.deepEqual(levels(undecodable), [["info", "request.rejected"]], "logged as a refusal at info");
  assert.equal(handled(new URIError("URI malformed")).status, 500, "a URIError the application raised without a status is still a programming error");
  // body-parser answers a body zlib cannot inflate with zlib's own error, marked 400 and safe to expose, without a type.
  const gzip = handled(Object.assign(new Error("incorrect header check"), { code: "Z_DATA_ERROR", errno: -3, status: 400, statusCode: 400, expose: true }));
  assert.deepEqual([gzip.status, gzip.body], [400, { error: "The request body could not be decompressed. Check its Content-Encoding and try again.", requestId: "test-request" }], "a body that cannot be decompressed is a 400");
  assert.deepEqual(gzip.logged, [{ level: "info", fields: { event: "request.rejected", status: 400, reason: "Z_DATA_ERROR" } }]);
  const exposed = handled(Object.assign(new Error("Range Not Satisfiable"), { status: 416, expose: true }));
  assert.deepEqual([exposed.status, (exposed.body as { error: string }).error, levels(exposed)], [416, "Range Not Satisfiable", [["info", "request.rejected"]]], "any 4xx a library marks safe to expose keeps its status and words");
  assert.equal(handled(Object.assign(new TypeError("Converting circular structure to JSON"), { status: 400 })).status, 500, "a 4xx not marked safe to expose is not honoured before the programming-error check");
  checks += 9;

  // A validation refusal names at most 20 fields and says how many there were.
  const many = handled(new ZodError(Array.from({ length: 120 }, (_, index) => ({ code: "custom" as const, path: ["files", index, "kind"], message: "Unknown kind" }))));
  const manyBody = many.body as { details: Array<{ field: string }>; detailCount: number };
  assert.equal(many.status, 400);
  assert.deepEqual([manyBody.details.length, manyBody.detailCount, manyBody.details[0]?.field, manyBody.details[19]?.field], [20, 120, "files.0.kind", "files.19.kind"], "the first 20 fields and the count of all");
  assert.equal(JSON.stringify(many.body).length < 2_000, true, "so the answer stays small whatever the request holds");
  checks += 3;

  // A service the request depends on that could not be reached is an outage: 503 with Retry-After, never a general 500.
  const unreachable = handled(Object.assign(new Error("request to http://127.0.0.1:1106/credential failed, reason: connect ECONNREFUSED 127.0.0.1:1106"), { name: "GaxiosError", code: "ECONNREFUSED" }), "GET");
  assert.deepEqual([unreachable.status, unreachable.headers, unreachable.body], [503, { "Retry-After": "10" }, { error: "Valo Pay 1 could not reach a system this request needs. Try again shortly.", requestId: "test-request" }], "object storage out of reach is a 503 that says when to try again");
  assert.deepEqual(levels(unreachable), [["error", "request.unavailable"]], "and an error line: the outage needs attention");
  const fetchFailed = handled(new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }) }));
  assert.deepEqual([fetchFailed.status, fetchFailed.headers?.["Retry-After"]], [503, "10"], "so is a fetch that failed on the network, though it is a TypeError");
  // The identity provider's SDK answers a request it could not send as an API error without a status.
  const identity = (status?: number) => new ClerkAPIResponseError("", { data: [{ code: "unexpected_error", message: "fetch failed" }], status: status as number });
  assert.deepEqual([handled(identity()).status, handled(identity(503)).status, handled(identity(429)).status], [503, 503, 503], "an identity-provider call that got no answer, or an overloaded one, is an outage");
  const misconfigured = handled(new ClerkRuntimeError("clerkMiddleware() was not run", { code: "middleware_not_run" }), "GET");
  assert.deepEqual([misconfigured.status, levels(misconfigured)], [500, [["error", "request.failed"]]], "while the SDK's own runtime error is a failure of this service, not an outage");
  assert.equal(handled(storageFailure(503)).headers?.["Retry-After"], "10", "storage that answered it is unavailable says when to try again");
  assert.equal(handled(Object.assign(new Error("Private export storage is not configured. Contact the workspace administrator."), { status: 503 })).headers, undefined, "a service that is not configured does not");
  checks += 8;

  // A dependency's error without a status is never the request's fault: the identity provider's missing key is a 500 at error level.
  let missingKey: unknown;
  try { parsePublishableKey("", { fatal: true }); } catch (error) { missingKey = error; }
  assert.ok(missingKey instanceof Error && !("status" in missingKey) && !("code" in missingKey), "a real dependency error: a plain Error without a status or code");
  const dependency = handled(missingKey, "GET");
  assert.deepEqual([dependency.status, (dependency.body as { error: string }).error], [500, "Valo Pay 1 could not load this. Try again, and quote this reference if it happens again."], "it is the service's 500 in general words, never a 400 that blames the request");
  assert.deepEqual(levels(dependency), [["error", "request.failed"]], "logged at error level with its stack, not as a rejection at info");
  const rule = handled(new Error("A reason is required for this business or destructive action."));
  assert.deepEqual([rule.status, levels(rule)], [400, [["info", "request.rejected"]]], "while the application's own rule without a status stays a 400");
  checks += 4;
}

{
  // A request with an Idempotency-Key is answered for its key, not for this attempt alone (audit 23 September, items 1
  // and 2): nothing was saved (committed false) only when nothing sent with the key was or can be saved.
  const keyedAnswer = (error: unknown, options: { unused?: boolean; closer?: () => Promise<OperationState | undefined> } = {}) => new Promise<Answer & { closed: number }>((resolve) => {
    const out: Answer & { closed: number } = { closed: 0 };
    const quiet = () => undefined;
    const req = { id: "test-request", method: "POST", log: { error: quiet, warn: quiet, info: quiet } };
    markKeyed(req as never);
    if (options.unused) markKeyUnused(req as never);
    if (options.closer) registerRefusalCloser(req as never, () => { out.closed++; return options.closer!(); });
    const res = { headersSent: false, setHeader(name: string, value: string) { out.headers = { ...out.headers, [name]: value }; return this; }, status(code: number) { out.status = code; return this; }, json(body: unknown) { out.body = body; resolve(out); return this; } };
    errorHandler(error, req as never, res as never, () => undefined);
  });
  const busy = () => markRolledBack(new DatabaseLimitError("lock_timeout", { write: true }));
  const saved = await keyedAnswer(busy(), { closer: async () => "completed" });
  assert.deepEqual([saved.status, saved.headers, saved.body], [503, { "Retry-After": "2" }, { error: "This lender is busy with another change. This request was saved. Try again in a moment.", operation: "completed", requestId: "test-request" }], "a repeat of a saved request turned away by a busy lender never says nothing was saved: it says the request was saved");
  const running = await keyedAnswer(busy(), { closer: async () => "running" });
  assert.deepEqual([running.body, running.status], [{ error: "This lender is busy with another change. This request is still running. Try again in a moment.", operation: "running", requestId: "test-request" }, 503], "nor while another attempt is still running it");
  const pending = await keyedAnswer(busy(), { closer: async () => "pending" });
  assert.deepEqual(pending.body, { error: "This lender is busy with another change. We do not know yet whether it was saved. Try again in a moment.", operation: "pending", requestId: "test-request" }, "nor while its entry waits for confirmation");
  assert.deepEqual((await keyedAnswer(busy())).body, { error: "This lender is busy with another change. We do not know yet whether it was saved. Try again in a moment.", requestId: "test-request" }, "nor when what the key holds is unknown (it failed before its journal entry was read)");
  assert.deepEqual((await keyedAnswer(busy(), { unused: true })).body, { error: "This lender is busy with another change. Nothing was saved. Try again in a moment.", committed: false, requestId: "test-request" }, "a key this attempt found unused saved nothing");
  assert.deepEqual((await keyedAnswer(busy(), { closer: async () => "cancelled" })).body, { error: "This lender is busy with another change. Nothing was saved. Try again in a moment.", committed: false, operation: "cancelled", requestId: "test-request" }, "and so did a key whose entry is cancelled");
  const unopened = await keyedAnswer(markRolledBack(Object.assign(new Error("Protected data cannot be opened. Ask the administrator to check the configured encryption key."), { status: 503 })), { closer: async () => "completed" });
  assert.deepEqual([unopened.status, unopened.body], [503, { error: "Protected data cannot be opened. Ask the administrator to check the configured encryption key. This request was saved.", operation: "completed", requestId: "test-request" }], "a saved request whose stored answer cannot be opened says it was saved");
  const failed = await keyedAnswer(markRolledBack(new TypeError("x is undefined")), { closer: async () => "completed" });
  assert.deepEqual([failed.status, failed.body], [500, { error: "Valo Pay 1 saved this request but could not send its answer. Check the original request in Request history to see the saved result.", operation: "completed", requestId: "test-request" }], "so does a general failure of a repeat of a saved request");
  // A repeat turned away because its request is still running leaves the entry to the attempt running it.
  const stillRunning = await keyedAnswer(markRolledBack(new DatabaseLimitError("operation_running")), { closer: async () => "cancelled" });
  assert.deepEqual([stillRunning.status, stillRunning.headers, stillRunning.body, stillRunning.closed], [503, { "Retry-After": "2" }, { error: "This request is still running. Wait a moment, then check the original request to see its result.", operation: "running", requestId: "test-request" }, 0], "a duplicate of a running request is a non-definitive 503 with Retry-After that never touches the entry");
  assert.equal(new DatabaseLimitError("operation_running", { write: true }).message.includes("Nothing was saved"), false, "and never says nothing was saved");
  checks += 12;
}

{
  // A record's data cannot smuggle a key that names an object's own machinery.
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const data = JSON.parse(`{"${key}": {"polluted": true}, "note": "x"}`) as Record<string, unknown>;
    assert.throws(() => validateRecord({} as never, { role: "Admin" } as never, "customers", { data }), /^Error: This request has a field Valo Pay 1 does not accept\. Reload the page and try again\.$/, `${key} is refused before anything else looks at the data`);
  }
  checks += 3;
}

// The shell over HTTP: placeholder Clerk keys make the middleware compute "signed out" locally, and a
// placeholder database address satisfies the store's start-up check; no query is ever made here.
process.env["DATABASE_URL"] ??= "postgres://postgres@127.0.0.1:1/valo-pay-1-unused";
// The log is not this test's subject; the observability test reads it back.
process.env["LOG_LEVEL"] ??= "silent";
process.env["CLERK_SECRET_KEY"] ??= "sk_test_placeholder";
process.env["CLERK_PUBLISHABLE_KEY"] ??= `pk_test_${Buffer.from("clerk.example.test$").toString("base64")}`;
const { default: app, bodyProblem, rawBodyProblem, MAX_BODY_VALUES } = await import("../src/app.js");
const errorOf = async (response: Response) => ((await response.json()) as { error: string }).error;
const server = app.listen(0);
try {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  const same = await fetch(`${base}/api/v1/webhooks/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(same.status, 403, "provider webhook ingress fails closed");
  assert.match(await errorOf(same), /ingress is disabled/);
  for (const [header, value] of [["cache-control", "private, no-store"], ["x-content-type-options", "nosniff"], ["referrer-policy", "no-referrer"], ["x-frame-options", "DENY"], ["cross-origin-resource-policy", "same-origin"]]) {
    assert.equal(same.headers.get(header!), value, `${header} on every /api/v1 answer`);
  }
  assert.equal(same.headers.get("x-powered-by"), null, "no server fingerprint");
  const own = await fetch(`${base}/api/v1/webhooks/test`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: "{}" });
  assert.match(await errorOf(own), /ingress is disabled/, "the console's own origin passes the origin rule");
  const foreign = await fetch(`${base}/api/v1/webhooks/test`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}" });
  assert.equal(foreign.status, 403);
  assert.equal(await errorOf(foreign), "Cross-origin requests are not permitted.", "a request from another origin is refused before any route runs");
  const malformed = await fetch(`${base}/api/v1/webhooks/test`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "not a url" }, body: "{}" });
  assert.equal(await errorOf(malformed), "Invalid request origin.");
  const tooLarge = await fetch(`${base}/api/v1/webhooks/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: `{"pad":"${"x".repeat(2 * 1024 * 1024 + 10)}"}` });
  assert.equal(tooLarge.status, 413, "a body over the 2 MB limit is refused");
  assert.equal(tooLarge.headers.get("x-content-type-options"), "nosniff", "an oversized body is answered with the security headers");
  const brokenJson = await fetch(`${base}/api/v1/webhooks/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"action":' });
  assert.equal(brokenJson.status, 400, "malformed JSON is a 400, not a server failure");
  assert.equal(await errorOf(brokenJson), "The request body is not valid JSON. Check its format and try again.");
  for (const [header, value] of [["x-content-type-options", "nosniff"], ["x-frame-options", "DENY"], ["cache-control", "private, no-store"]]) assert.equal(brokenJson.headers.get(header!), value, `${header} on a malformed-body answer`);
  const foreignBroken = await fetch(`${base}/api/v1/webhooks/test`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: '{"action":' });
  assert.equal(await errorOf(foreignBroken), "Cross-origin requests are not permitted.", "the origin rule runs before the body is read");
  const nul = await fetch(`${base}/api/v1/webhooks/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: { name: "Ada\u0000" } }) });
  assert.equal(nul.status, 400, "a NUL character is refused at the edge");
  assert.equal(await errorOf(nul), "Text cannot contain the NUL character (\\u0000). Remove it from data.name and try again.");
  checks += 21;

  // Malformed input is refused before anything runs or is journaled, never answered as a server failure (audit
  // 23 September, items 3, 7 and 9). The database is unreachable here, so a request that reached a transaction
  // would be a 503: each 4xx below was answered first.
  const raw = (method: string, path: string, body: string | Buffer, headers: Record<string, string>) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const sent = http.request({ host: "127.0.0.1", port, method, path, headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) } }, (answer) => {
      const chunks: Buffer[] = [];
      answer.on("data", (chunk: Buffer) => chunks.push(chunk));
      answer.on("end", () => resolve({ status: answer.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    sent.on("error", reject);
    sent.end(body);
  });
  const post = (body: string, headers: Record<string, string> = {}) => fetch(`${base}/api/v1/webhooks/test`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
  const undecodable = await fetch(`${base}/api/v1/customers/%E0%A4%A/history?merchantId=offline-lender`);
  assert.deepEqual([undecodable.status, await errorOf(undecodable)], [400, "This address is not valid. Check the link and try again."], "a path that cannot be decoded is a 400");
  const keyedUndecodable = await fetch(`${base}/api/v1/records/customers/%25%?merchantId=offline-lender`, { method: "PATCH", headers: { "Content-Type": "application/json", "Idempotency-Key": "edge-inputs-0001" }, body: JSON.stringify({ name: "x", expectedUpdatedAt: "2026-09-19T12:00:00.000Z" }) });
  assert.equal(keyedUndecodable.status, 400, "a keyed write to such a path is refused before its journal entry is made");
  // A compressed body is refused before it is read, 415 with Accept-Encoding: identity (RFC 9110): the parser never
  // inflates one, so two kilobytes on the wire can no longer become two megabytes to parse (the review of 4edd897,
  // finding 1).
  const compressed = (text: string, coding = "gzip") => fetch(`${base}/api/v1/webhooks/test`, { method: "POST", headers: { "Content-Type": "application/json", "Content-Encoding": coding }, body: coding === "gzip" ? gzipSync(text) : text });
  const gzipped = await compressed(JSON.stringify({ name: "Compressed" }));
  assert.deepEqual([gzipped.status, gzipped.headers.get("accept-encoding"), await errorOf(gzipped)], [415, "identity", "Send the request body uncompressed, without a Content-Encoding."], "a compressed body is refused, saying how to send it");
  assert.equal(gzipped.headers.get("x-content-type-options"), "nosniff", "with the security headers");
  assert.equal((await compressed(`${"[".repeat(1_048_000)}${"]".repeat(1_048_000)}`)).status, 415, "as is the review's 2 KB of gzip that inflates to 2 MB of brackets");
  assert.equal((await compressed("not gzip")).status, 415, "whatever it holds");
  assert.equal((await compressed('{"name":"Plain"}', "identity")).status, 403, "identity is no encoding at all");
  // Only UTF-8 is read: the bytes are checked before they are decoded, so a body in another character set is refused.
  const wide = await raw("POST", "/api/v1/webhooks/test", Buffer.from('{"name":"Wide"}', "utf16le"), { "Content-Type": "application/json; charset=utf-16le" });
  assert.deepEqual([wide.status, JSON.parse(wide.body).error], [415, "The request body's character set is not supported. Send UTF-8 JSON."], "a UTF-16 body is refused");
  assert.equal((await post('{"name":"Named"}', { "Content-Type": "application/json; charset=UTF-8" })).status, 403, "UTF-8, named or not, is read");
  checks += 8;
  const nested = (levels: number) => `{"name":"Deep","junk":${"[".repeat(levels - 1)}${"]".repeat(levels - 1)}}`;
  assert.equal((await post(nested(32))).status, 403, "32 levels of nesting reach the route");
  const tooDeep = await post(nested(33));
  assert.equal(tooDeep.status, 400, "33 levels are refused");
  assert.match(await errorOf(tooDeep), /^The request body is nested more than 32 levels deep, at junk(\.0)+\. Send a flatter body\.$/, "naming where");
  const keyedDeep = await fetch(`${base}/api/v1/records/customers?merchantId=offline-lender`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "edge-inputs-0002" }, body: nested(3000) });
  assert.deepEqual([keyedDeep.status, (await errorOf(keyedDeep)).startsWith("The request body is nested more than 32 levels deep")], [400, true], "a keyed write 3,000 levels deep is refused before anything walks it");
  const surrogate = await post('{"name":"x\\udfff y"}');
  assert.deepEqual([surrogate.status, await errorOf(surrogate)], [400, "Text must be valid Unicode: name holds an unpaired surrogate (\\ud800 to \\udfff). Remove it and try again."], "an unpaired surrogate is refused, naming the field");
  const surrogateKey = await post('{"data":{"\\ud800":"x"}}');
  assert.deepEqual([surrogateKey.status, await errorOf(surrogateKey)], [400, "Text must be valid Unicode: data holds an unpaired surrogate (\\ud800 to \\udfff). Remove it and try again."], "also in a field name, naming the object that holds it");
  assert.equal((await post('{"name":"Ada \\ud83d\\ude00"}')).status, 403, "a surrogate pair is ordinary text");
  // The walk visits a list by its index and an object by its fields, and builds a dotted path only for the value it
  // refuses; a body holding more than 10,000 values, far more than any request needs, is refused (413) before the
  // rest is walked, fingerprinted or journaled (the reviews of b9b10ef, finding 2, and 4edd897, finding 1).
  const values = (count: number) => `{"name":"Many","junk":[${Array(count).fill(0).join(",")}]}`;
  const keys = (count: number, key = (index: number) => `k${index}`) => `{"name":"Keys","junk":{${Array.from({ length: count }, (_, index) => `"${key(index)}":0`).join(",")}}}`;
  assert.equal(MAX_BODY_VALUES, 10_000);
  assert.equal((await post(values(9_997))).status, 403, "10,000 values, the body and its list among them, reach the route");
  const tooMany = await post(values(9_998));
  assert.deepEqual([tooMany.status, await errorOf(tooMany)], [413, "The request body holds more than 10,000 values. Send a smaller request."], "one more is refused, naming the limit");
  assert.deepEqual([(await post(keys(9_997))).status, (await post(keys(9_998))).status], [403, 413], "an object's fields count as a list's items do");
  assert.deepEqual(bodyProblem({ rows: [...Array<number>(5_000).fill(0), { note: "x\u0000" }] }), { field: "rows.5000.note", problem: "nul" }, "the refused value is named by its path, a list's item by its index");
  checks += 5;
  // Nesting deeper than 32 levels, and more than 10,000 values, are refused from the body's bytes before JSON.parse
  // reads them: parsing takes about 300 ms for 2 MB of nested brackets and about 100 ms for 2 MB of field names, and
  // the walk could refuse them only afterwards. The scan skips text, so a bracket, comma or escaped quote in a string
  // is text, and names the path the walk would.
  const parse = JSON.parse;
  let parsedLarge = 0;
  JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => { if (typeof text === "string" && text.length > 100_000) parsedLarge++; return parse(text, reviver); }) as typeof JSON.parse;
  try {
    const unparsed: Array<[string, number, RegExp]> = [
      [`${"[".repeat(1_048_000)}${"]".repeat(1_048_000)}`, 400, /^The request body is nested more than 32 levels deep, at 0(\.0){31}\. Send a flatter body\.$/],
      [`${'{"a":'.repeat(349_000)}0${"}".repeat(349_000)}`, 400, /, at a(\.a){31}\. Send a flatter body\.$/],
      [`{"name":"Deep","junk":${"[".repeat(1_048_000)}${"]".repeat(1_048_000)}}`, 400, /, at junk(\.0){31}\. Send a flatter body\.$/],
      [`{"na\\u006De":${"[".repeat(40)}${"]".repeat(40)},"pad":"${"x".repeat(200_000)}"}`, 400, /, at name(\.0){31}\. Send a flatter body\.$/],
      [`{${Array.from({ length: 150_000 }, (_, index) => `"${index.toString(36)}":0`).join(",")}}`, 413, /^The request body holds more than 10,000 values\. Send a smaller request\.$/],
      [values(1_000_000), 413, /^The request body holds more than 10,000 values\./],
    ];
    for (const [body, status, answer] of unparsed) {
      const refused = await post(body);
      assert.equal(refused.status, status, `${body.slice(0, 40)}… is refused`);
      assert.match(await errorOf(refused), answer);
    }
    assert.equal(parsedLarge, 0, "and none of them is parsed");
    assert.equal((await post(JSON.stringify({ name: `${"[".repeat(40)}\\"${"{".repeat(40)},`, note: "x".repeat(200_000) }))).status, 403, "brackets, an escaped quote and a comma in text are text: the body reaches the route");
    assert.equal(parsedLarge, 1, "parsed, as the spy counts");
  } finally {
    JSON.parse = parse;
  }
  checks += 15;
  // The bytes' count is the walk's: at the cap both pass, and one value more both refuse.
  const shapes: Array<[string, (items: number) => string, number]> = [
    ["a list", (items) => values(items), 3],
    ["an object's fields", (items) => keys(items), 3],
    ["empty lists and objects", (items) => `[${Array.from({ length: items }, (_, index) => (index % 2 ? "{}" : "[ ]")).join(",")}]`, 1],
    ["text holding commas, brackets and escaped quotes", (items) => `[${Array(items).fill('"a,[{\\"},\\\\"').join(",")}]`, 1],
    ["whitespace between values", (items) => JSON.stringify({ name: "Many", junk: Array(items).fill({}) }, null, 2), 3],
  ];
  for (const [label, body, around] of shapes) {
    for (const [items, found] of [[MAX_BODY_VALUES - around, undefined], [MAX_BODY_VALUES - around + 1, { field: "", problem: "values" }]] as const) {
      const text = body(items);
      assert.deepEqual([rawBodyProblem(Buffer.from(text)), bodyProblem(JSON.parse(text))], [found, found], `${label}: ${items + around} values`);
      checks += 1;
    }
  }
  // What a body costs the API's one thread, whatever its shape (the review of 4edd897, finding 1): refusing nesting
  // costs a small part of parsing it; the checks of a list, an object's keys or a long text cost about what reading or
  // writing the body as JSON does (an object of sparse integer keys costs any reader about four times its parse); and at
  // the value cap, fingerprinting a keyed write's body costs less than parsing the largest ordinary body the 2 MB limit
  // accepts.
  const fastest = (run: () => unknown, runs = 5) => Math.min(...Array.from({ length: runs }, () => { const started = performance.now(); run(); return performance.now() - started; }));
  const deep = `${"[".repeat(200_000)}${"]".repeat(200_000)}`, deepBytes = Buffer.from(deep);
  const scanned = fastest(() => rawBodyProblem(deepBytes)), parsedDeep = fastest(() => JSON.parse(deep), 2);
  assert.ok(scanned * 20 < parsedDeep, `refusing nesting from the bytes costs a small part of parsing it (${scanned.toFixed(2)} ms to scan, ${parsedDeep.toFixed(1)} ms to parse)`);
  const largest = values(1_000_000), reference = fastest(() => JSON.parse(largest));
  const costed: Array<[string, string, boolean]> = [
    ["a list at the cap", values(MAX_BODY_VALUES - 3), true],
    ["an object's keys at the cap", keys(MAX_BODY_VALUES - 3), true],
    ["an object's integer keys at the cap", keys(MAX_BODY_VALUES - 3, (index) => String(index * 7)), true],
    ["an object's sparse integer keys at the cap", keys(MAX_BODY_VALUES - 3, (index) => String(4_000_000_000 - index * 37)), true],
    ["2 MB of long text", JSON.stringify({ name: "Text", note: "é😀".repeat(330_000) }), false],
  ];
  for (const [shape, text, capped] of costed) {
    const bytes = Buffer.from(text), parsed = JSON.parse(text) as unknown;
    const checked = fastest(() => { rawBodyProblem(bytes); bodyProblem(parsed); });
    const handled = Math.max(fastest(() => JSON.parse(text)), fastest(() => JSON.stringify(parsed)));
    assert.ok(checked < 3 * handled + 1, `${shape}: the checks cost about what reading or writing the body does (${checked.toFixed(1)} ms to check, ${handled.toFixed(1)} ms)`);
    checks += 1;
    if (!capped) continue;
    const fingerprinted = fastest(() => requestFingerprint({ method: "POST", path: "/v1/records/customers", body: parsed }));
    assert.ok(fingerprinted < reference, `${shape}: fingerprinting costs less than parsing 2 MB (${fingerprinted.toFixed(1)} ms, ${reference.toFixed(1)} ms)`);
    checks += 1;
  }
  checks += 1;
  // Outside /api/v1 no body is read and no session checked: any other address under /api is unknown, answered before the
  // parser runs, whatever the body holds (the review of b9b10ef, finding 1).
  for (const path of ["/api/nowhere", "/api/healthz/", "/api/V1x/anything"]) {
    for (const body of ['{"broken', JSON.stringify({ name: "x\u0000" }), values(1_000_000), `{"pad":"${"x".repeat(2 * 1024 * 1024 + 10)}"}`]) {
      const unknown = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      assert.deepEqual([unknown.status, await errorOf(unknown)], [404, "Unknown resource."], `${path} is unknown, and its body is never read`);
    }
  }
  checks += 17;
  const form = await raw("POST", "/api/v1/webhooks/test", "action=verify_audit&reason=form", { "Content-Type": "application/x-www-form-urlencoded" });
  assert.deepEqual([form.status, JSON.parse(form.body).error], [415, "Send the request body as JSON, with the Content-Type application/json."], "a form body is refused: the service reads JSON only");
  assert.equal((await raw("POST", "/api/v1/webhooks/test", "{}", { "Content-Type": "text/plain" })).status, 415, "as is any other format");
  assert.equal((await raw("POST", "/api/v1/webhooks/test", "", { "Content-Type": "application/x-www-form-urlencoded" })).status, 403, "an empty body in any format is no body");
  const readBody = await raw("GET", "/api/healthz", '{"broken', { "Content-Type": "application/json" });
  assert.equal(readBody.status, 200, "a read's body is ignored, not parsed");
  assert.equal((await raw("GET", "/api/healthz", nested(3000), { "Content-Type": "application/json; charset=latin1" })).status, 200, "nor checked");
  checks += 16;

  // Routing is strict and case-sensitive: another spelling of a path is not a route (audit 23 September, item 7).
  for (const variant of ["/api/v1/Webhooks/test", "/api/v1/webhooks/test/"]) {
    const answer = await fetch(`${base}${variant}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.deepEqual([answer.status, await errorOf(answer)], [404, "Unknown resource."], `${variant} is not the route`);
    checks += 1;
  }

  // In staff mode a change must come from a configured pilot origin: without one, or from another, it is refused first.
  const staffNames = ["VALO_PAY_1_STAFF_ACCESS", "VALO_PAY_1_STAFF_ORIGINS"] as const;
  const staffSaved = Object.fromEntries(staffNames.map((name) => [name, process.env[name]]));
  try {
    process.env["VALO_PAY_1_STAFF_ACCESS"] = "staging";
    process.env["VALO_PAY_1_STAFF_ORIGINS"] = base;
    for (const origin of [undefined, "https://pilot.example"]) {
      const refused = await fetch(`${base}/api/v1/webhooks/test`, { method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: "{}" });
      assert.equal(refused.status, 403);
      assert.equal(await errorOf(refused), "Open Valo Pay 1 from your pilot’s usual address to make changes.", `refused from ${origin ?? "no origin"}`);
    }
    const configured = await fetch(`${base}/api/v1/webhooks/test`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: "{}" });
    assert.match(await errorOf(configured), /ingress is disabled/, "a change from the configured origin reaches its route");
  } finally {
    for (const name of staffNames) { if (staffSaved[name] === undefined) delete process.env[name]; else process.env[name] = staffSaved[name]; }
  }
  checks += 5;

  // The Paystack test ingress checks a delivery's signature on its raw bytes before it touches a lender:
  // with the database unreachable, a forged delivery to a mapped connection is still a 401, not a 500.
  const paystackNames = ["VALO_PAY_1_PAYSTACK_INGRESS", "PAYSTACK_TEST_SECRET_KEY", "VALO_PAY_1_PAYSTACK_CONNECTIONS"] as const;
  const paystackSaved = Object.fromEntries(paystackNames.map((name) => [name, process.env[name]]));
  try {
    const key = ["sk", "test", "OFFLINE", "0".repeat(20)].join("_"), connection = "c".repeat(64);
    process.env["VALO_PAY_1_PAYSTACK_INGRESS"] = "test";
    process.env["PAYSTACK_TEST_SECRET_KEY"] = key;
    process.env["VALO_PAY_1_PAYSTACK_CONNECTIONS"] = JSON.stringify({ [connection]: { workspaceId: "unreachable-workspace", merchantId: "unreachable-lender" } });
    const event = JSON.stringify({ event: "charge.success", data: { domain: "test", id: "800001", status: "success", amount: 10000, currency: "NGN", reference: "OFFLINE-INGRESS-001", channel: "direct_debit" } });
    const deliver = (bytes: string, signature: string) => fetch(`${base}/api/v1/providers/paystack/${connection}/events`, { method: "POST", headers: { "Content-Type": "application/json", "X-Paystack-Signature": signature }, body: bytes });
    const forged = await deliver(event, "f".repeat(128));
    assert.equal(forged.status, 401, "a forged delivery is refused before the lender is locked or read");
    assert.equal(await errorOf(forged), "The Paystack webhook signature is invalid.");
    assert.equal(forged.headers.get("cache-control"), "no-store");
    assert.equal(forged.headers.get("x-content-type-options"), "nosniff");
    const live = event.replace('"domain":"test"', '"domain":"live"');
    assert.equal((await deliver(live, createHmac("sha512", key).update(live).digest("hex"))).status, 400, "a signed live-mode event is refused before the lender is opened");
    checks += 5;
  } finally {
    for (const name of paystackNames) { const value = paystackSaved[name]; if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log(`API security tests passed (${checks} checks): error answers and statuses, body-parser and NUL refusals, unavailable services and storage failures, prototype keys, response headers, origin rule before the body, the staff pilot origin for changes, compressed and non-UTF-8 bodies refused unread, nesting and values refused from the bytes before parsing, body limits of size and values with checks and fingerprints bounded for lists, object keys and long text, no body read outside /api/v1, webhook ingress, Paystack signature before any lender work.`);
