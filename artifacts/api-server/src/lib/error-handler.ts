import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { ERROR_DETAIL_LIMIT, MONEY_REFUSAL_MESSAGE, MoneyArithmeticError } from "@workspace/valopay-schema";
import { PilotAccessError } from './pilot-access';
import { closeRefusedOperation, operationStateOf, requestKey, type OperationState } from './refused-operations';
import { wasRolledBack } from './transaction-outcome';
import { DatabaseLimitError } from './database-limits';
import { ResponseContractError } from './contract';

/**
 * One place that turns a thrown error into an HTTP answer.
 *
 * Validation failures name their fields, at most 20 of them, with how many
 * there were. A client error a library marks safe to expose (the body
 * parser's, a body that cannot be decompressed) and the router's refusal of a
 * path it cannot decode are the request's fault: they keep their 4xx, in
 * plain words, and are logged as refusals, before anything is taken for a
 * programming error. Database safety constraints are a conflict; text
 * PostgreSQL cannot store is a 400. An error the application raised is
 * answered in its own words with the status it carries: a refusal without one
 * is a 400, whatever its wording, and a service the application found
 * unavailable keeps its 502, 503 or 504. A service the request depends on
 * that could not be reached (object storage, the identity provider) is a 503
 * with Retry-After. A programming error (a TypeError, a ReferenceError and
 * their kin), an error a dependency raised without a status (its stack starts
 * in node_modules, such as a missing identity-provider key), an answer that
 * does not match its contract (ResponseContractError, lib/contract.ts) or
 * anything that is not an Error at all is answered as a 500 in general words:
 * its message describes the code, not the request, and belongs in the log, not
 * in the response (security review). An invalid answer is never a validation
 * 400: the request was not at fault. A money calculation that cannot be done
 * exactly within the supported amount and rate limits (MoneyArithmeticError,
 * whatever the route: billing, reconciliation, a close, a report, the Cash
 * Desk) is a 422 naming its code, logged as `money.calculation_refused` with
 * the code alone, never an amount: the same request would be refused again,
 * so it is a definitive refusal (definitiveRefusalStatuses).
 *
 * When the store rolled back the request's transaction before committing, a
 * 5xx answer says `committed: false`: nothing was saved, so the console need
 * not hold the request as unconfirmed. For a request with an Idempotency-Key
 * (lib/refused-operations.ts) that is decided for the key, not for this
 * attempt alone: only when its journal entry is cancelled, or this attempt
 * found nothing saved under the key before it failed. Otherwise the answer
 * never says nothing was saved: it names the entry's state (`operation`
 * completed, running or pending) and says in its words that the request was
 * saved, is still running or is not confirmed. A read that fails is a 500 in a
 * read's words, without `committed`: a read saves nothing either way.
 *
 * A request the store turned away at a database limit (a busy lender or
 * workspace, a lock or statement past its limit, an idle or lost connection,
 * no free connection, the same request still running) is a 503 with
 * Retry-After in plain words. A raw PostgreSQL code is never guessed at here:
 * the store translates it where it knows whether COMMIT was sent. A 429
 * always says when to try again: the seconds its refusal carries
 * (`retryAfterSeconds`), or 60.
 *
 * Before a refusal or failure of a journaled request is answered, its
 * operations-journal entry is settled (the recovery middleware registers how;
 * this module never imports the store or the database, so the offline suites
 * can load it): a definitive refusal closes it, a failure that saved nothing
 * closes it only for the attempt that created it while no other attempt runs
 * it, and the answer names the state the entry is in afterwards. A repeat
 * turned away because its request is still running leaves the entry alone. A
 * cancelled entry never completes, so neither this request nor any earlier
 * one with its key was saved or can be: the console may release a request it
 * holds as unconfirmed.
 */
const programmingErrors = [TypeError, RangeError, ReferenceError, SyntaxError, URIError, EvalError];
const databaseCodes = ["23503", "23505", "23514", "P0001"];
/** PostgreSQL could not store a character: a NUL in text (22021) or in a JSON string (22P05). */
const characterCodes = ["22021", "22P05"];
/** Network failures on the way to a service the request depends on: it could not be reached. */
const networkCodes = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNABORTED", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"]);
const GENERAL_FAILURE = "We could not confirm this action. Check Operations or retry the same request before submitting a new one.";
const NOT_SAVED = "This action failed and nothing was saved. Try again, and quote this reference if it happens again.";
const READ_FAILURE = "The service could not prepare this answer. Try again, and quote this reference if it happens again.";
const SAVED_FAILURE = "This request was saved, but the service could not give its answer. Retry the same request, or check Operations, to see its saved result.";
const RUNNING_FAILURE = "This request is still running. Wait a moment, then retry the same request or check Operations to see its result.";
const UNREACHABLE = "A service this request depends on could not be reached. Try again shortly.";
const MALFORMED_PATH = "The address is not valid: it holds a malformed percent-encoded character. Check the link and try again.";
/** What became of a request whose key may have saved something, in one sentence. */
const outcome = (state: OperationState | undefined) => state === "completed" ? "This request was saved." : state === "running" ? "This request is still running." : "Its outcome is not confirmed yet.";
/** The wait a 429 names when its refusal carries none of its own: the request limit's minute. */
const DEFAULT_RETRY_AFTER_SECONDS = 60;
/** The wait after a service the request depends on could not be reached, as for an unavailable database. */
const OUTAGE_RETRY_AFTER_SECONDS = 10;
/** The body parser's refusals, in the words a person needs. */
const bodyRefusals: Record<string, { status: number; error: string }> = {
  "entity.parse.failed": { status: 400, error: "The request body is not valid JSON. Check its format and try again." },
  "entity.too.large": { status: 413, error: "The request body is too large. Send a smaller request." },
  "encoding.unsupported": { status: 415, error: "The request body's encoding is not supported. Send UTF-8 JSON." },
  "charset.unsupported": { status: 415, error: "The request body's character set is not supported. Send UTF-8 JSON." },
  "request.aborted": { status: 400, error: "The request was cancelled before its body arrived." },
};
type Body = Record<string, unknown> & { error: string };
type Answer = {
  status: number; headers?: Record<string, string>; body: Body;
  /** This attempt's transaction was rolled back before COMMIT: it saved nothing. */
  notSaved?: boolean;
  /** The words for a request whose key may have saved something, by its journal entry's state (lib/refused-operations.ts). */
  keyed?: (state: OperationState | undefined) => string;
  /** The same request is still running elsewhere: its journal entry is left to that attempt, and neither closed nor read. */
  running?: boolean;
};
type Raised = Error & { code?: unknown; status?: unknown; expose?: unknown; type?: unknown };

/** A client error that is safe to name: a 4xx a library marks safe to expose (the body parser's, with its type, or
 * a body that cannot be decompressed), or a path whose percent-encoding the router cannot decode (it marks that 400). */
function clientRefusal(error: unknown): { status: number; error: string; reason: string } | undefined {
  if (!(error instanceof Error)) return undefined;
  const raised = error as Raised, status = Number(raised.status);
  if (!(status >= 400 && status < 500)) return undefined;
  if (error instanceof URIError) return { status: 400, error: MALFORMED_PATH, reason: "path.malformed" };
  if (raised.expose !== true) return undefined;
  if (typeof raised.type === "string") return { ...(bodyRefusals[raised.type] ?? { status, error: "The request body could not be read." }), reason: raised.type };
  if (typeof raised.code === "string" && raised.code.startsWith("Z_")) return { status, error: "The request body could not be decompressed. Check its Content-Encoding and try again.", reason: raised.code };
  return { status, error: raised.message || "The request was refused.", reason: typeof raised.code === "string" ? raised.code : "refused" };
}

/** A service the request depends on failed on the way: it could not be reached (a network failure, here or as the
 * error's cause), or the identity provider's API answered with no status (its SDK could not send the request) or as
 * overloaded. Only the API's own answers count (they carry a list of errors): a runtime or configuration error of its
 * SDK is a failure of this service, not an outage. */
function unreachable(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && networkCodes.has(code)) return true;
  }
  const answer = error as { clerkError?: unknown; errors?: unknown; status?: unknown } | null;
  if (!answer || typeof answer !== "object" || answer.clerkError !== true || !Array.isArray(answer.errors)) return false;
  const status = Number(answer.status);
  return answer.status === undefined || status === 429 || status >= 500;
}

/** Whether an error was raised inside a dependency (the first frame of its stack is in node_modules), never by a rule of the application. */
function raisedByDependency(error: Error): boolean {
  const frame = error.stack?.split("\n").find((line) => /^\s+at /.test(line));
  return frame !== undefined && /[\\/]node_modules[\\/]/.test(frame);
}

function describe(error: unknown, req: Parameters<ErrorRequestHandler>[1]): Answer {
  const requestId = req.id;
  if (error instanceof PilotAccessError) return { status: error.status, body: { error: error.message, code: error.code, requestId } };
  // Only the typed financial refusal is exposed. A generic RangeError is still
  // a programming failure, even if someone attaches a matching code to it.
  if (error instanceof MoneyArithmeticError) {
    req.log.warn({ event: "money.calculation_refused", code: error.code }, "An amount or calculation exceeded the supported financial limits");
    return { status: 422, body: { error: MONEY_REFUSAL_MESSAGE, code: error.code, requestId } };
  }
  if (error instanceof ZodError) {
    req.log.info({ event: "request.rejected", status: 400, issues: error.issues.length }, "Validation failed");
    const details = error.issues.slice(0, ERROR_DETAIL_LIMIT).map((issue) => ({ field: issue.path.join("."), message: issue.message }));
    return { status: 400, body: { error: "Validation failed.", details, detailCount: error.issues.length, requestId } };
  }
  // Checked before programming errors and codes: the parser's JSON failure is a SyntaxError, a bad gzip body carries
  // zlib's code and an undecodable path is a URIError, all about the request.
  const refused = clientRefusal(error);
  if (refused) {
    req.log.info({ event: "request.rejected", status: refused.status, reason: refused.reason }, "Request refused");
    return { status: refused.status, body: { error: refused.error, requestId } };
  }
  const notSaved = wasRolledBack(error);
  if (error instanceof DatabaseLimitError) {
    // A busy lender or workspace, a lock wait or the same request still running is load, not a fault: a warning. A stopped statement, a lost connection or a full pool is an error.
    const level = ["lender_busy", "lock_timeout", "lock_conflict", "workspace_busy", "workspace_changing", "operation_running"].includes(error.limit) ? "warn" : "error";
    req.log[level]({ event: "request.busy", status: 503, limit: error.limit, reason: error.message, ...(error.cause === undefined ? {} : { err: error.cause }) }, "Request turned away: a database limit was reached");
    const headers = { "Retry-After": String(error.retryAfterSeconds) };
    if (error.limit === "operation_running") return { status: 503, headers, body: { error: error.message, operation: "running", requestId }, running: true };
    return { status: 503, headers, body: { error: error.message, requestId }, notSaved, keyed: (state) => `${error.situation} ${outcome(state)} ${error.advice}` };
  }
  const reading = req.method === "GET" || req.method === "HEAD";
  // A read's words never mention saving; a write's say what became of it, for its key when it has one.
  const general = (unsaved = notSaved): Answer => reading ? { status: 500, body: { error: READ_FAILURE, requestId } }
    : { status: 500, body: { error: unsaved ? NOT_SAVED : GENERAL_FAILURE, requestId }, notSaved: unsaved, keyed: (state) => state === "completed" ? SAVED_FAILURE : state === "running" ? RUNNING_FAILURE : GENERAL_FAILURE };
  const unavailable = (status: number, message: string, headers?: Record<string, string>): Answer => ({ status, ...(headers ? { headers } : {}), body: { error: message, requestId }, notSaved, keyed: (state) => `${message} ${outcome(state)}` });
  if (error instanceof ResponseContractError) {
    // The paths that failed locate the fault; the values stay out of the log.
    req.log.error({ event: "response.invalid", issues: error.issues, ...(error.saved ? { replayed: true } : {}), err: error }, error.saved ? "A saved request's stored answer did not match its contract" : "An answer did not match its contract");
    // A repeat whose stored answer cannot be given was saved when that answer was: its rolled-back transaction proves nothing.
    return general(notSaved && !error.saved);
  }
  if (unreachable(error)) {
    req.log.error({ event: "request.unavailable", status: 503, reason: UNREACHABLE, err: error instanceof Error ? error : new Error(String(error)) }, "Request refused: a service it depends on could not be reached");
    return unavailable(503, UNREACHABLE, { "Retry-After": String(OUTAGE_RETRY_AFTER_SECONDS) });
  }
  // A failure is logged with its stack, which is what locates it; the answer stays general.
  if (!(error instanceof Error) || programmingErrors.some((kind) => error instanceof kind)) {
    req.log.error({ event: "request.failed", err: error instanceof Error ? error : new Error(String(error)) }, "Valopay operation failed");
    return general();
  }
  const failure = error as Raised;
  const code = typeof failure.code === "string" ? failure.code : undefined;
  if (code && databaseCodes.includes(code)) {
    req.log.warn({ event: "request.rejected", status: 409, code }, "Database safety constraint rejected operation");
    return { status: 409, body: { error: "This change conflicts with an existing record, protected evidence or an allocation limit. Refresh the record and check the details before trying again.", requestId } };
  }
  if (code && characterCodes.includes(code)) {
    req.log.info({ event: "request.rejected", status: 400, code }, "Text PostgreSQL cannot store was refused");
    return { status: 400, body: { error: "Text cannot contain the NUL character (\\u0000). Remove it and try again.", requestId } };
  }
  const status = Number(failure.status) || 0;
  const upstream = Number((failure as { statusCode?: unknown }).statusCode);
  // A service the application found unavailable, or a check it failed on purpose, keeps its status and words; one
  // relaying the service's own outage (a status it answered with) says when to try again.
  if (failure.code === undefined && ((status >= 502 && status <= 504) || (status >= 500 && status <= 599 && failure.expose === true))) {
    req.log.error({ event: "request.unavailable", status, reason: failure.message, err: failure }, "Request refused: a service is unavailable or a check failed");
    return unavailable(status, failure.message, status === 503 && upstream >= 400 ? { "Retry-After": String(OUTAGE_RETRY_AFTER_SECONDS) } : undefined);
  }
  if (failure.code !== undefined || status >= 500) {
    req.log.error({ event: "request.failed", code: failure.code, err: failure }, "Valopay operation failed");
    return general();
  }
  // An upstream status (storage, identity) with none of our own is never the request's fault.
  if (!status && upstream >= 400) {
    req.log.error({ event: "request.failed", upstreamStatus: upstream, err: failure }, "A service this request depends on failed");
    return unavailable(502, "A service this request depends on did not respond as expected. Try again shortly.");
  }
  // A dependency's error without a status is never the request's fault: a failure of the service, logged with its stack.
  if (!status && raisedByDependency(failure)) {
    req.log.error({ event: "request.failed", err: failure }, "A dependency failed without a status");
    return general();
  }
  // A refusal without a status is a 400: its wording is never read to choose one.
  const answered = status >= 400 && status < 500 ? status : 400;
  // A rejection is the rule doing its job: one info line with the reason, for the question "why was this refused?".
  req.log.info({ event: "request.rejected", status: answered, reason: failure.message }, "Request rejected");
  const wait = Number((failure as { retryAfterSeconds?: unknown }).retryAfterSeconds);
  const retry = answered === 429 ? { headers: { "Retry-After": String(Number.isInteger(wait) && wait > 0 ? wait : DEFAULT_RETRY_AFTER_SECONDS) } } : {};
  return { status: answered, ...retry, body: { error: failure.message || "The operation was rejected.", requestId } };
}

/**
 * The answer as the request's key makes it: the journal entry's state is named,
 * and a failure says nothing was saved (`committed: false`) only when nothing
 * sent with the key was or can be saved: its entry is cancelled, or this attempt
 * found nothing saved under the key before it failed. Without a key, that this
 * attempt saved nothing is enough.
 */
function forKey(answer: Answer, key: { readonly unused: boolean } | undefined, state: OperationState | undefined): Answer {
  if (state) answer.body.operation = state;
  if (answer.status < 500 || answer.running) return answer;
  const unsaved = key ? state === "cancelled" || (answer.notSaved === true && state === undefined && key.unused) : answer.notSaved === true;
  if (unsaved) {
    answer.body.committed = false;
    // A request whose key's entry is cancelled saved nothing, even when this attempt's own outcome was unconfirmed.
    if (answer.body.error === GENERAL_FAILURE) answer.body.error = NOT_SAVED;
  } else if (key && answer.keyed) answer.body.error = answer.keyed(state);
  return answer;
}

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (res.headersSent) return;
  // Every error body carries the request id, so the reference a person quotes finds the request's log lines.
  const answer = describe(error, req);
  const key = requestKey(req);
  const send = (state?: OperationState) => {
    if (res.headersSent) return;
    const final = forKey(answer, key, state ?? operationStateOf(error));
    for (const [name, value] of Object.entries(final.headers ?? {})) res.setHeader(name, value);
    res.status(final.status).json(final.body);
  };
  // A refusal or failure with a journal entry waits for the entry to settle; every other refusal is answered at once.
  const settling = answer.running ? undefined : closeRefusedOperation(req, answer.status, answer.body.error, answer.notSaved === true);
  if (settling) void settling.then((state) => send(state), () => send());
  else send();
};
