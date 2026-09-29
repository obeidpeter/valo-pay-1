import { markRolledBack } from './transaction-outcome';

/**
 * Every database transaction the API opens is bounded. Its BEGIN sets how long
 * one statement may run, how long it may wait for a lock and how long it may
 * sit idle between statements, all transaction-local (SET LOCAL), so nothing
 * outlives the transaction on a pooled connection. A connection is checked out
 * with an error listener, so a connection the server ends (the idle limit, a
 * restart, an administrator) is a failed request, not an uncaught error that
 * ends the process. A limit reached before COMMIT is a 503 with Retry-After
 * that says nothing was saved (for a request with an Idempotency-Key, only when
 * nothing sent with its key was: lib/error-handler.ts).
 *
 * Kept free of database imports, so the error handler and the offline suites
 * can load it.
 */

/** How long, in milliseconds, one transaction may run a statement, wait for a lock and stay idle between statements. */
export interface TransactionLimits { readonly statementMs: number; readonly lockMs: number; readonly idleMs: number }
/** A request; a system transaction (the scheduled close, Paystack test deliveries, service reads); the export worker. */
export interface DatabaseLimits { readonly request: TransactionLimits; readonly system: TransactionLimits; readonly worker: TransactionLimits }
type LimitKind = keyof DatabaseLimits;
const kinds: readonly LimitKind[] = ['request', 'system', 'worker'];
const fields: ReadonlyArray<keyof TransactionLimits> = ['statementMs', 'lockMs', 'idleMs'];
const defaults: DatabaseLimits = Object.freeze({
  request: Object.freeze({ statementMs: 15_000, lockMs: 5_000, idleMs: 30_000 }),
  system: Object.freeze({ statementMs: 30_000, lockMs: 5_000, idleMs: 60_000 }),
  worker: Object.freeze({ statementMs: 5_000, lockMs: 1_000, idleMs: 5_000 }),
});
let current = defaults;

/** The limits transactions open with now. */
export function databaseLimits(): DatabaseLimits { return current; }

const wholeMilliseconds = (value: unknown, name: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 3_600_000) throw new Error(`${name} must be a whole number of milliseconds from 1 to 3600000.`);
  return value;
};

/** For tests and rehearsals only: shortens or lengthens some limits, and returns what restores the previous ones. */
export function overrideDatabaseLimits(overrides: { [K in LimitKind]?: Partial<TransactionLimits> }): () => void {
  const previous = current, next: Record<LimitKind, TransactionLimits> = { ...current };
  for (const kind of kinds) {
    const given = overrides[kind];
    if (!given) continue;
    for (const [field, value] of Object.entries(given)) {
      if (!fields.includes(field as keyof TransactionLimits)) throw new Error(`${kind}.${field} is not a database limit.`);
      wholeMilliseconds(value, `${kind}.${field}`);
    }
    next[kind] = Object.freeze({ ...current[kind], ...given });
  }
  current = Object.freeze(next);
  return () => { current = previous; };
}

/** One round trip that opens a transaction with its limits; the values are whole milliseconds, never text. */
export function beginStatement(limits: TransactionLimits, mode?: 'ISOLATION LEVEL REPEATABLE READ' | 'READ ONLY'): string {
  return `BEGIN${mode ? ` ${mode}` : ''}; SET LOCAL statement_timeout = ${wholeMilliseconds(limits.statementMs, 'statementMs')}; SET LOCAL lock_timeout = ${wholeMilliseconds(limits.lockMs, 'lockMs')}; SET LOCAL idle_in_transaction_session_timeout = ${wholeMilliseconds(limits.idleMs, 'idleMs')}`;
}

/**
 * Why a request was turned away without an answer from the database. The two
 * workspace limits are the workspace lock's lock limit: a team, lender-access,
 * invitation or persona change that the requests already running in its
 * workspace kept waiting (`workspace_busy`), and a request queued behind such
 * a change (`workspace_changing`). `operation_running` is a repeat of a
 * journaled request (its Idempotency-Key) while another attempt of it still
 * holds its journal entry: it is turned away at once, and the entry is left
 * to the attempt running it.
 */
export type DatabaseLimit = 'lender_busy' | 'lock_timeout' | 'lock_conflict' | 'workspace_busy' | 'workspace_changing' | 'statement_timeout' | 'idle_timeout' | 'connection_lost' | 'pool_timeout' | 'database_unavailable' | 'operation_running';
const described: Record<DatabaseLimit, { what: string; next: string; retryAfterSeconds: number }> = {
  lender_busy: { what: 'This lender is busy with other requests.', next: 'Try again in a moment.', retryAfterSeconds: 2 },
  workspace_busy: { what: 'Other requests in this workspace are still finishing.', next: 'Try this change again in a moment.', retryAfterSeconds: 2 },
  workspace_changing: { what: 'This workspace is busy with a team or role change.', next: 'Try again in a moment.', retryAfterSeconds: 2 },
  lock_timeout: { what: 'This lender is busy with another change.', next: 'Try again in a moment.', retryAfterSeconds: 2 },
  lock_conflict: { what: 'This lender is busy with another change.', next: 'Try again in a moment.', retryAfterSeconds: 1 },
  statement_timeout: { what: 'This request took too long and was stopped.', next: 'Try again in a moment, and quote this reference if it happens again.', retryAfterSeconds: 5 },
  idle_timeout: { what: 'This request took too long and was stopped.', next: 'Try again in a moment, and quote this reference if it happens again.', retryAfterSeconds: 5 },
  connection_lost: { what: 'The connection to the database was lost.', next: 'Try again in a moment.', retryAfterSeconds: 2 },
  pool_timeout: { what: 'Valo Pay is busy.', next: 'Try again in a moment.', retryAfterSeconds: 2 },
  database_unavailable: { what: 'The database is not available.', next: 'Try again shortly.', retryAfterSeconds: 10 },
  operation_running: { what: 'This request is still running.', next: 'Wait a moment, then check the original request to see its result.', retryAfterSeconds: 2 },
};

/** A request turned away at a database limit: a 503 in plain words, with how many seconds to wait before a retry. */
export class DatabaseLimitError extends Error {
  readonly status = 503;
  readonly limit: DatabaseLimit;
  readonly retryAfterSeconds: number;
  /** The message's two halves, what happened and what to do next, so an answer can say between them what
   * became of a request whose Idempotency-Key may have saved something (lib/error-handler.ts). */
  readonly situation: string;
  readonly advice: string;
  /** `write` says the request would have changed something, so its answer says nothing was saved. A request
   * still running elsewhere is never told that: the attempt running it may save it. */
  constructor(limit: DatabaseLimit, options: { write?: boolean; cause?: unknown } = {}) {
    const { what, next, retryAfterSeconds } = described[limit];
    super(`${what} ${options.write === false || limit === 'operation_running' ? '' : 'Nothing was saved. '}${next}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DatabaseLimitError';
    this.limit = limit;
    this.retryAfterSeconds = retryAfterSeconds;
    this.situation = what;
    this.advice = next;
  }
}

const codeLimits = new Map<string, DatabaseLimit>([
  ['55P03', 'lock_timeout'], ['57014', 'statement_timeout'], ['25P03', 'idle_timeout'],
  // A deadlock or serialisation failure rolled the transaction back; the same request can simply run again.
  ['40P01', 'lock_conflict'], ['40001', 'lock_conflict'],
  // The server ended the session (an administrator, a shutdown, a crash) or the socket broke.
  ['57P01', 'connection_lost'], ['57P02', 'connection_lost'], ['08000', 'connection_lost'], ['08003', 'connection_lost'], ['08006', 'connection_lost'], ['ECONNRESET', 'connection_lost'], ['EPIPE', 'connection_lost'],
  // Starting up or out of connections.
  ['57P03', 'database_unavailable'], ['53300', 'database_unavailable'],
]);
/** pg's refusal of a query on a connection it already knows is gone: the query was never sent. */
const NOT_SENT = 'Client has encountered a connection error and is not queryable';
/** pg's own errors for a connection that has gone, which carry no code. */
const lostConnection = new Set(['Connection terminated unexpectedly', 'Connection terminated', NOT_SENT]);

/** The limit a failure reached, or undefined when it is anything else (a constraint, a domain refusal, a bug). */
export function databaseLimitOf(error: unknown): DatabaseLimit | undefined {
  if (error instanceof DatabaseLimitError) return error.limit;
  if (!(error instanceof Error)) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') return codeLimits.get(code);
  return lostConnection.has(error.message) ? 'connection_lost' : undefined;
}

/** What a checkout needs of a pooled client. */
export interface PooledClient {
  on(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(event: 'error', listener: (error: Error) => void): unknown;
  release(error?: Error | boolean): void;
}
/** A checked-out client, the first error the connection raised while checked out, and a release that runs once. */
export interface Checkout<C> { readonly client: C; lost(): Error | undefined; release(): void }

const POOL_TIMEOUT = 'timeout exceeded when trying to connect';
/**
 * Takes a connection from the pool. The pool waits a bounded time for one; a
 * pool that cannot give one is a 503 before anything ran. While checked out,
 * the connection's errors are heard: pg-pool listens only to idle clients, and
 * an unheard 'error' event ended the process. Release hands a broken
 * connection back as broken, so the pool destroys it.
 */
export async function checkOut<C extends PooledClient>(connect: () => Promise<C>, write = true): Promise<Checkout<C>> {
  let client: C;
  try { client = await connect(); }
  catch (error) {
    throw markRolledBack(new DatabaseLimitError(error instanceof Error && error.message === POOL_TIMEOUT ? 'pool_timeout' : 'database_unavailable', { write, cause: error }));
  }
  let lost: Error | undefined, released = false;
  const heard = (error: Error) => { lost ??= error; };
  client.on('error', heard);
  return {
    client,
    lost: () => lost,
    release() {
      if (released) return;
      released = true;
      client.removeListener('error', heard);
      client.release(lost);
    },
  };
}

/**
 * What a failed transaction throws. A limit reached before COMMIT was sent is
 * a 503 that says nothing was saved; a connection lost to the idle limit says
 * so rather than "lost". A COMMIT that pg refused without sending it, because
 * the connection was already gone (the idle limit struck after the last
 * statement), cannot have saved anything either. A limit reached once COMMIT
 * was sent (a connection lost while it was on its way or being run) is
 * answered as the general, unconfirmed 500: the server may have committed.
 * Anything else is returned unchanged.
 */
export function failedTransaction(error: unknown, outcome: { committing: boolean; lost?: Error; write: boolean }): unknown {
  if (error instanceof DatabaseLimitError) return error;
  let limit = databaseLimitOf(error);
  if (limit === 'connection_lost' && outcome.lost) limit = databaseLimitOf(outcome.lost) ?? 'connection_lost';
  if (!limit) return error;
  const sent = !(error instanceof Error && error.message === NOT_SENT && (error as { code?: unknown }).code === undefined);
  if (outcome.committing && sent) return Object.assign(new Error('The database did not confirm whether this change was saved.', { cause: error }), { status: 500 });
  return markRolledBack(new DatabaseLimitError(limit, { write: outcome.write, cause: error }));
}
