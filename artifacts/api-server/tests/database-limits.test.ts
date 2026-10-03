import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { beginStatement, checkOut, databaseLimitOf, databaseLimits, DatabaseLimitError, failedTransaction, overrideDatabaseLimits } from "../src/lib/database-limits.js";
import { createLenderGate } from "../src/lib/lender-gate.js";
import { markRolledBack, wasRolledBack } from "../src/lib/transaction-outcome.js";
import { errorHandler } from "../src/lib/error-handler.js";

// What bounds every database transaction, without a database: the connection
// gate's lanes, the transaction-local limits each BEGIN sets, how PostgreSQL and pool
// failures become a 503 that says nothing was saved, and the error listener
// that keeps a lost connection from ending the process. The limits against a
// real database are in workspace-concurrency.integration.test.ts.
let checks = 0;
const eq = (actual: unknown, expected: unknown, message: string) => { assert.deepEqual(actual, expected, message); checks++; };
const ok = (value: unknown, message: string) => { assert.ok(value, message); checks++; };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** Settles a promise into what it resolved with, or the error it rejected with, without waiting. */
const state = <T>(promise: Promise<T>) => { const seen: { value?: T; error?: unknown; settled: boolean } = { settled: false }; promise.then(value => { seen.value = value; seen.settled = true; }, error => { seen.error = error; seen.settled = true; }); return seen; };

// ---- The lender gate: one lender holds at most its capacity; others are untouched ----
{
  const gate = createLenderGate({ capacity: 2, waitMs: () => 1_000 });
  const first = await gate.enter("lender-a", true), second = await gate.enter("lender-a", false);
  eq(gate.load("lender-a"), { active: 2, waiting: 0 }, "two requests hold the lender's two slots");
  const third = state(gate.enter("lender-a", false)), fourth = state(gate.enter("lender-a", true));
  await sleep(10);
  ok(!third.settled && !fourth.settled, "the third and fourth wait without a slot");
  eq(gate.load("lender-a"), { active: 2, waiting: 2 }, "and are counted as waiting");
  const other = await gate.enter("lender-b", true);
  eq(gate.load("lender-b"), { active: 1, waiting: 0 }, "another lender is not held up by a full one");
  first(); await sleep(0);
  ok(third.settled && !fourth.settled, "a released slot goes to the longest waiter first");
  first();
  eq(gate.load("lender-a"), { active: 2, waiting: 1 }, "a second release of the same slot frees nothing");
  second(); await sleep(0);
  ok(fourth.settled, "the next release admits the fourth");
  third.value!(); fourth.value!(); other();
  eq([gate.load("lender-a"), gate.load("lender-b")], [{ active: 0, waiting: 0 }, { active: 0, waiting: 0 }], "nothing is held once every request has left");
}
{
  const gate = createLenderGate({ capacity: 1, waitMs: () => 50, maxWaiting: 1 });
  const holder = await gate.enter("lender-a", true);
  const waiting = gate.enter("lender-a", true).then(() => undefined, (error: unknown) => error);
  const refusal = state(gate.enter("lender-a", false));
  await sleep(0);
  ok(refusal.settled && refusal.error instanceof DatabaseLimitError && refusal.error.limit === "lender_busy", "past the waiting limit a request is turned away at once, not after the wait limit");
  const refused = refusal.error;
  const started = Date.now();
  const error = await waiting;
  ok(Date.now() - started < 1_000, "a waiter gives up after the wait limit");
  ok(error instanceof DatabaseLimitError, "with a database limit error");
  const busy = error as DatabaseLimitError;
  eq([busy.limit, busy.status, busy.retryAfterSeconds, wasRolledBack(busy)], ["lender_busy", 503, 2, true], "lender_busy is a 503, retried after 2 s, and nothing was saved");
  eq(busy.message, "This lender is busy with other requests. Nothing was saved. Try again in a moment.", "a change is told nothing was saved");
  eq((refused as DatabaseLimitError).message, "This lender is busy with other requests. Try again in a moment.", "a read is not told about saving");
  eq(gate.load("lender-a"), { active: 1, waiting: 0 }, "a waiter that gave up leaves the queue");
  holder();
  eq(gate.load("lender-a"), { active: 0, waiting: 0 }, "and the last release empties the lane");
}
{
  // A request that already waited in its lender's lane waits in its tenant's only for what is left of its limit (enterGate).
  const gate = createLenderGate({ capacity: 1, waitMs: () => 5_000 });
  const holder = await gate.enter("tenant-a", true);
  const started = Date.now();
  const error = await gate.enter("tenant-a", false, 30).then(() => undefined, (refusal: unknown) => refusal);
  ok(error instanceof DatabaseLimitError && error.limit === "lender_busy" && Date.now() - started < 1_000, "a wait given to one request bounds that request's wait");
  holder();
}
// ---- The workspace lock's own words ----
{
  const change = new DatabaseLimitError("workspace_busy");
  eq([change.status, change.retryAfterSeconds, change.message], [503, 2, "Other requests in this workspace are still finishing. Nothing was saved. Try this change again in a moment."], "a change that could not start says the workspace's requests are still finishing");
  eq(new DatabaseLimitError("workspace_changing", { write: false }).message, "This workspace is busy with a team or role change. Try again in a moment.", "a request queued behind a change says so");
  eq(databaseLimitOf(change), "workspace_busy", "the limit is named");
}

// ---- The limits every BEGIN sets ----
{
  eq(databaseLimits(), { request: { statementMs: 15_000, lockMs: 5_000, idleMs: 30_000 }, system: { statementMs: 30_000, lockMs: 5_000, idleMs: 60_000 }, worker: { statementMs: 5_000, lockMs: 1_000, idleMs: 5_000 } }, "requests, system transactions and the export worker have their own limits");
  eq(beginStatement(databaseLimits().request), "BEGIN; SET LOCAL statement_timeout = 15000; SET LOCAL lock_timeout = 5000; SET LOCAL idle_in_transaction_session_timeout = 30000", "one round trip opens the transaction with its limits");
  eq(beginStatement(databaseLimits().worker, "ISOLATION LEVEL REPEATABLE READ"), "BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL statement_timeout = 5000; SET LOCAL lock_timeout = 1000; SET LOCAL idle_in_transaction_session_timeout = 5000", "with an isolation level");
  eq(beginStatement(databaseLimits().worker, "READ ONLY").startsWith("BEGIN READ ONLY; SET LOCAL"), true, "or read only");
  const restore = overrideDatabaseLimits({ request: { lockMs: 400 } });
  eq(databaseLimits().request, { statementMs: 15_000, lockMs: 400, idleMs: 30_000 }, "a test may shorten one limit");
  eq(databaseLimits().system.lockMs, 5_000, "without touching the others");
  restore();
  eq(databaseLimits().request.lockMs, 5_000, "and restores it");
  for (const bad of [0, -1, 1.5, Number.NaN, 3_600_001]) assert.throws(() => overrideDatabaseLimits({ request: { statementMs: bad } }), /whole number of milliseconds/, `${bad} is refused`);
  assert.throws(() => beginStatement({ statementMs: 1, lockMs: 1, idleMs: "1; DROP TABLE x" as unknown as number }), /whole number of milliseconds/, "only whole numbers reach the SQL");
  checks += 6;
}

// ---- PostgreSQL and pg failures, by limit ----
{
  const coded = (code: string) => Object.assign(new Error(code), { code });
  eq(["55P03", "57014", "25P03", "40P01", "40001", "57P01", "08006", "57P03", "53300", "ECONNRESET"].map(code => databaseLimitOf(coded(code))),
    ["lock_timeout", "statement_timeout", "idle_timeout", "lock_conflict", "lock_conflict", "connection_lost", "connection_lost", "database_unavailable", "database_unavailable", "connection_lost"], "each PostgreSQL code maps to its limit");
  eq(["Connection terminated unexpectedly", "Connection terminated", "Client has encountered a connection error and is not queryable"].map(message => databaseLimitOf(new Error(message))), ["connection_lost", "connection_lost", "connection_lost"], "pg's own lost-connection errors carry no code");
  eq([databaseLimitOf(coded("23505")), databaseLimitOf(new Error("A reason is required.")), databaseLimitOf(Object.assign(new Error("x"), { code: "__proto__" })), databaseLimitOf("text")], [undefined, undefined, undefined, undefined], "a constraint, a domain refusal or anything else is not a limit");
  eq(new DatabaseLimitError("statement_timeout").message, "This request took too long and was stopped. Nothing was saved. Try again in a moment, and quote this reference if it happens again.", "a stopped statement asks for the reference");
  eq([new DatabaseLimitError("lock_conflict").retryAfterSeconds, new DatabaseLimitError("idle_timeout").retryAfterSeconds, new DatabaseLimitError("database_unavailable").retryAfterSeconds], [1, 5, 10], "each limit says when to retry");
}

// ---- The checkout: a pool that cannot give a connection, and a connection that is lost ----
{
  const failing = (error: Error) => () => Promise.reject(error);
  const timedOut = await checkOut(failing(new Error("timeout exceeded when trying to connect"))).then(() => undefined, (error: unknown) => error) as DatabaseLimitError;
  eq([timedOut.limit, wasRolledBack(timedOut), timedOut.message], ["pool_timeout", true, "Valo Pay 1 is busy. Nothing was saved. Try again in a moment."], "no free connection within the wait is pool_timeout, and nothing was saved");
  const read = await checkOut(failing(new Error("timeout exceeded when trying to connect")), false).then(() => undefined, (error: unknown) => error) as DatabaseLimitError;
  eq(read.message, "Valo Pay 1 is busy. Try again in a moment.", "a read is not told about saving");
  const refused = await checkOut(failing(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }))).then(() => undefined, (error: unknown) => error) as DatabaseLimitError;
  eq([refused.limit, refused.retryAfterSeconds], ["database_unavailable", 10], "an unreachable database is database_unavailable");

  class FakeClient extends EventEmitter { released: unknown[] = []; release(error?: Error | boolean) { this.released.push(error); } }
  const bare = new FakeClient();
  assert.throws(() => bare.emit("error", Object.assign(new Error("terminating connection due to idle-in-transaction timeout"), { code: "25P03" })), /idle-in-transaction/, "an unheard client error throws: in the API, that ended the process");
  const client = new FakeClient();
  const guard = await checkOut(async () => client);
  const idle = Object.assign(new Error("terminating connection due to idle-in-transaction timeout"), { code: "25P03" });
  client.emit("error", idle);
  client.emit("error", new Error("Connection terminated unexpectedly"));
  eq(guard.lost(), idle, "a checked-out client's error is heard and kept, the first one");
  guard.release(); guard.release();
  eq(client.released, [idle], "release hands the error to the pool once, so the broken connection is destroyed");
  eq(client.listenerCount("error"), 0, "and removes the listener");
  const healthy = new FakeClient(), kept = await checkOut(async () => healthy);
  kept.release();
  eq([kept.lost(), healthy.released], [undefined, [undefined]], "a healthy connection goes back to the pool");
}

// ---- A failed transaction, as the store translates it ----
{
  const lockWait = failedTransaction(Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }), { committing: false, write: true }) as DatabaseLimitError;
  eq([lockWait instanceof DatabaseLimitError, lockWait.limit, wasRolledBack(lockWait), lockWait.message], [true, "lock_timeout", true, "This lender is busy with another change. Nothing was saved. Try again in a moment."], "a lock wait past the limit is a 503 and nothing was saved");
  eq((lockWait.cause as { code: string }).code, "55P03", "the PostgreSQL error stays as the cause, for the log");
  const idleKill = failedTransaction(new Error("Client has encountered a connection error and is not queryable"), { committing: false, lost: Object.assign(new Error("terminating connection due to idle-in-transaction timeout"), { code: "25P03" }), write: false }) as DatabaseLimitError;
  eq([idleKill.limit, idleKill.message], ["idle_timeout", "This request took too long and was stopped. Try again in a moment, and quote this reference if it happens again."], "a connection lost to the idle limit says the request took too long");
  const terminated = failedTransaction(new Error("Client has encountered a connection error and is not queryable"), { committing: false, lost: new Error("Connection terminated unexpectedly"), write: true }) as DatabaseLimitError;
  eq(terminated.limit, "connection_lost", "any other lost connection is connection_lost");
  const busy = markRolledBack(new DatabaseLimitError("pool_timeout", { write: false }));
  eq(failedTransaction(busy, { committing: false, write: false }), busy, "an error that already names its limit passes through");
  const answer = (error: unknown) => {
    const answered: { status?: number; retryAfter?: unknown; body?: { error: string; committed?: boolean } } = {};
    errorHandler(error, { id: "req-commit", log: { error() {}, warn() {}, info() {} } } as never, { headersSent: false, setHeader(name: string, value: unknown) { if (name === "Retry-After") answered.retryAfter = value; }, status(code: number) { answered.status = code; return this; }, json(body: { error: string }) { answered.body = body; return this; } } as never, () => undefined);
    return answered;
  };
  const atCommit = failedTransaction(new Error("Connection terminated unexpectedly"), { committing: true, lost: new Error("Connection terminated unexpectedly"), write: true });
  ok(!(atCommit instanceof DatabaseLimitError) && !wasRolledBack(atCommit), "a connection lost during COMMIT is not a 503: the change may have been saved");
  const unconfirmed = answer(atCommit);
  eq([unconfirmed.status, unconfirmed.body?.committed], [500, undefined], "it is answered as the general, unconfirmed 500");
  // The server ended the session as the COMMIT reached it: it may have been read, so the outcome stays unconfirmed.
  const endedAtCommit = failedTransaction(Object.assign(new Error("terminating connection due to idle-in-transaction timeout"), { code: "25P03" }), { committing: true, write: true });
  ok(!(endedAtCommit instanceof DatabaseLimitError) && !wasRolledBack(endedAtCommit), "a COMMIT that reached the server and then failed stays unconfirmed");
  // The idle limit ended the session after the last statement: pg refuses the COMMIT without sending it, so nothing can have been saved.
  const notQueryable = new Error("Client has encountered a connection error and is not queryable");
  const unsent = failedTransaction(notQueryable, { committing: true, lost: Object.assign(new Error("terminating connection due to idle-in-transaction timeout"), { code: "25P03" }), write: true }) as DatabaseLimitError;
  eq([unsent instanceof DatabaseLimitError, unsent.limit, wasRolledBack(unsent), unsent.cause], [true, "idle_timeout", true, notQueryable], "a COMMIT refused before it was sent is the idle limit's 503, and nothing was saved");
  const unsentAnswer = answer(unsent);
  eq([unsentAnswer.status, unsentAnswer.retryAfter, unsentAnswer.body?.committed, unsentAnswer.body?.error], [503, "5", false, "This request took too long and was stopped. Nothing was saved. Try again in a moment, and quote this reference if it happens again."], "answered 503 with Retry-After and committed: false");
  const unsentLost = failedTransaction(notQueryable, { committing: true, lost: new Error("Connection terminated unexpectedly"), write: true }) as DatabaseLimitError;
  eq([unsentLost instanceof DatabaseLimitError, unsentLost.limit, wasRolledBack(unsentLost)], [true, "connection_lost", true], "and so is a COMMIT refused after any other lost connection");
  const refusal = Object.assign(new Error("This record changed."), { status: 409 });
  eq(failedTransaction(refusal, { committing: false, write: true }), refusal, "a domain refusal is returned unchanged");
  eq(failedTransaction(Object.assign(new Error("duplicate key"), { code: "23505" }), { committing: false, write: true }) instanceof DatabaseLimitError, false, "and so is a constraint");
}

console.log(`Database limit tests passed (${checks} checks): the connection gate's lanes, the limits every transaction sets, PostgreSQL and pool failures as a 503 that says nothing was saved, and lost connections heard instead of ending the process.`);
