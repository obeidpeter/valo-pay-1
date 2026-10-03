import type { Request } from "express";
import type { operationStates } from "@workspace/valo-pay-1-schema";

/**
 * Where a request's Idempotency-Key stands once the request was refused or
 * failed, as its journal entry says: `pending` (nothing confirmed it),
 * `running` (another attempt holds it and may still save it), `completed` (a
 * request with the key was saved) or `cancelled` (nothing sent with the key was
 * saved, or can be). Kept apart from the store so the error handler, which
 * every route and offline test loads, never imports the database.
 */
export type OperationState = (typeof operationStates)[number];

/** How to settle the journal entry bound to a request once the request is refused or failed: it closes the entry
 * when it may be closed and resolves to the entry's state afterwards, or undefined when that is unknown. Nothing is
 * returned when the entry is left as it is and unread (a 401 or 429, which are not final). */
type RefusalCloser = (status: number, message: string, notSaved: boolean) => Promise<OperationState | undefined> | undefined;
const closers = new WeakMap<Request, RefusalCloser>();

/** The recovery middleware registers, for a request it journaled, how to settle that entry after a refusal or failure. */
export function registerRefusalCloser(req: Request, closer: RefusalCloser) { closers.set(req, closer); }

/** Settles the journal entry bound to this request after a refusal or failure, when there is one to settle, and
 * resolves to its state afterwards; returns nothing otherwise, so an ordinary refusal is answered at once. */
export function closeRefusedOperation(req: Request, status: number, message: string, notSaved = false): Promise<OperationState | undefined> | undefined {
  return closers.get(req)?.(status, message, notSaved);
}

/**
 * Requests whose outcome is decided by their Idempotency-Key, not by their own
 * attempt alone (the key a route reads, lib/contract.ts; a retry from
 * Operations): a failure of one says nothing was saved (`committed: false`)
 * only when nothing sent with its key was or can be saved. `unused` records that
 * this attempt found nothing saved under the key (no journal entry, no stored
 * answer) before it failed.
 */
const keyed = new WeakMap<Request, { unused: boolean }>();
/** Records that the request carries an Idempotency-Key a route uses. */
export function markKeyed(req: Request) { if (!keyed.has(req)) keyed.set(req, { unused: false }); }
/** Records that nothing is saved under the request's key yet (no journal entry and no stored answer), or, once the
 * request holds a journal entry, that its entry, not this mark, says what became of the key. */
export function markKeyUnused(req: Request, unused = true) { keyed.set(req, { unused }); }
/** The request's key as its failure is answered for it, or undefined when it carries none a route uses. */
export function requestKey(req: Request): { readonly unused: boolean } | undefined { return keyed.get(req); }

const knownStates = new WeakMap<object, OperationState>();
/** Records that this refusal is of a request key whose journal entry is in the given state, when no entry is bound to
 * the request to read it from (a cancelled key refused before its request ran, a retry whose stored request cannot
 * be opened). Returns the error. */
export function markOperationState<T>(error: T, state: OperationState): T {
  if (error !== null && typeof error === "object") knownStates.set(error, state);
  return error;
}
/** The state markOperationState recorded for this refusal, if any. */
export function operationStateOf(error: unknown): OperationState | undefined {
  return error !== null && typeof error === "object" ? knownStates.get(error) : undefined;
}
/** Records that this refusal is of a request key whose journal entry is
 * already cancelled: no request with this key completed or can complete.
 * Returns the error. */
export function markOperationClosed<T>(error: T): T { return markOperationState(error, "cancelled"); }
/** Whether this refusal is of a request key whose journal entry is already
 * cancelled: no request with this key completed or can complete. */
export function operationClosed(error: unknown): boolean { return operationStateOf(error) === "cancelled"; }
