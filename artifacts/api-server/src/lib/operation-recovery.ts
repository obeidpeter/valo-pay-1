import type { RequestHandler } from "express";
import { parse } from "csv-parse/sync";
import { definitiveRefusalStatuses, pathId, recoverableOperation } from "@workspace/valo-pay-1-schema";
import { lenderQuery, optionalKey } from "./contract";
import { assertNoRealBankDetails } from "../domain/records";
import { markKeyed, markKeyUnused, registerRefusalCloser, type OperationState } from "./refused-operations";
import {
  bindOperation,
  boundOperation,
  inWorkspace,
  prepareOperation,
  readOperation,
  rejectOperation,
  type StoredRequest,
} from "./valo-pay-1-store";

// Only routes whose writes and receipt commit in one workspace transaction.
// No URLs, headers, provider calls, team invitations or arbitrary HTTP replay.
// A path is matched as the router matches it (routes/index.ts): each literal
// segment exactly, in its case, with no trailing slash, and a parameter as any
// segment, still percent-encoded. So a keyed write reaches a journaled route
// only journaled, however its path is spelled.
export const recoverableRequest = recoverableOperation;
// Statuses that mean the same request would be refused again (shared with the
// console, which then drops the key). A 401 or 429 leaves the entry pending;
// a failure is settled for the key (closeRejectedOperation).
const definitive = new Set<number>(definitiveRefusalStatuses);
/** Whether an HTTP status is a definitive refusal of the request that received it. */
export const definitiveRejection = (status: number) => definitive.has(status);
/** Settles the request's journal entry after a refusal or failure, and resolves
 * to its state afterwards, which the answer then names. A definitive refusal
 * closes the entry: the same request would be refused again. A failure that
 * saved nothing closes it only when this attempt created the entry and no other
 * attempt is running it (rejectOperation), so a repeat's failure never cancels
 * the request its original attempt is still running and never says nothing was
 * saved for a request that was. Any other failure only reads the entry. A 401
 * or 429 is not final: its entry is left pending and unread, and nothing is
 * returned, so the refusal is answered at once. A failure to settle the entry
 * is logged and leaves it as it was, the safe direction, and its state unknown. */
export function closeRejectedOperation(req: Parameters<RequestHandler>[0], status: number, message: string, notSaved = false): Promise<OperationState | undefined> | undefined {
  const bound = boundOperation(req), definitive = definitiveRejection(status);
  if (!bound || !(definitive || status >= 500)) return undefined;
  const close = definitive ? "refused" : notSaved && bound.created ? "unsaved" : undefined;
  return rejectOperation(req, bound, { status, message }, close).catch((error: unknown) => {
    req.log?.warn?.({ event: "operation.rejection_unrecorded", err: error instanceof Error ? error : new Error(String(error)) }, "A refused request's journal entry could not be settled and stays as it was");
    return undefined;
  });
}
export const recoveryMiddleware: RequestHandler = async (req, res, next) => {
  try {
    // The id is any one segment, as the router matches a parameter, read as every route reads an id (pathId): an
    // empty or over-long one is a 400 naming id, and one no journal entry has is not found (404), as for a cancel.
    const replay = /^\/v1\/operations\/([^/]+)\/retry$/.exec(req.path);
    if (req.method === "POST" && replay) {
      // A retry repeats a request with its key: however it ends, it is answered for that key.
      markKeyed(req);
      const { merchantId } = lenderQuery(req);
      const id = pathId(decodeURIComponent(replay[1]!));
      const stored = await inWorkspace(
        req,
        res,
        (ctx) => readOperation(ctx, merchantId, id),
        "read",
      );
      if (
        !recoverableRequest(
          stored.request.method,
          stored.request.path,
          stored.request.body,
        )
      )
        throw Object.assign(
          new Error("This request cannot be repeated automatically."),
          { status: 409 },
        );
      // Re-enter the ordinary route and all current validation/authorisation.
      req.method = stored.request.method;
      req.url = `${stored.request.path}?merchantId=${encodeURIComponent(merchantId)}`;
      req.body = structuredClone(stored.request.body);
      req.headers["idempotency-key"] = stored.request_key;
    }
    if (recoverableRequest(req.method, req.path, req.body)) {
      const { merchantId } = lenderQuery(req);
      // Legacy API callers without keys retain their existing contract. Every
      // console mutation supplies a key; unkeyed writes cannot be recovered.
      // A key is refused by name when it is not 8 to 200 characters.
      const key = optionalKey(req);
      if (key) {
        assertNoRealBankDetails(req.body);
        if (typeof req.body?.csv === "string") {
          if (req.body.syntheticOnly !== true)
            throw Object.assign(
              new Error("Only sample source rows can be saved."),
              { status: 403 },
            );
          try {
            assertNoRealBankDetails(
              parse(req.body.csv, {
                columns: true,
                bom: true,
                trim: true,
                skip_empty_lines: true,
                max_record_size: 20000,
              }),
            );
          } catch (error) {
            throw Object.assign(
              new Error(
                error instanceof Error
                  ? error.message
                  : "The source rows could not be checked.",
              ),
              { status: 400 },
            );
          }
        }
        const request: StoredRequest = {
          method: req.method as StoredRequest["method"],
          path: req.path,
          body: req.body ?? {},
        };
        const { id, created } = await inWorkspace(req, res, (ctx) =>
          prepareOperation(ctx, merchantId, key, request, () => markKeyUnused(req)),
        );
        bindOperation(req, id, merchantId, created);
        // From here the entry, not what the key held before, says what became of the request.
        markKeyUnused(req, false);
        registerRefusalCloser(req, (status, message, notSaved) => closeRejectedOperation(req, status, message, notSaved));
        res.setHeader("X-Valopay-Operation", id);
      }
    }
    next();
  } catch (error) {
    next(error);
  }
};
