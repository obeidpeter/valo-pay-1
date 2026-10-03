import type { Request } from "express";
import type { z, ZodError, ZodIssue } from "zod";
import { IDEMPOTENCY_KEY_HEADER, idempotencyKeyHeaderSchema, lenderPageQuerySchema, lenderQuerySchema } from "@workspace/valo-pay-1-schema";
import { markKeyed } from "./refused-operations";

/**
 * The request and answer rules every route shares, as the contract
 * (lib/api-spec/openapi.json) states them. It imports neither the store nor
 * the database, so the error handler and the offline suites can load it.
 */

/** The paths that failed and their zod codes, never their values: what the log records of an answer that did not match. */
const failedPaths = (error: ZodError) => error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join("."), code: issue.code }));

/**
 * An answer that does not match the schema its contract gives it: a fault in
 * the service, never in the request. The error handler answers it as a 500 in
 * general words (saying nothing was saved when the transaction was rolled
 * back, as it is when the answer is checked before COMMIT) and logs the paths
 * that failed, never their values. `saved` marks the stored answer of a
 * request saved earlier: rolling back its repeat does not undo that request,
 * so the answer never says nothing was saved, and says it was saved.
 */
export class ResponseContractError extends Error {
  readonly issues: ReadonlyArray<{ path: string; code: string }>;
  readonly saved: boolean;
  constructor(error: ZodError, options: { saved?: boolean } = {}) {
    super("An answer did not match its contract.");
    this.name = "ResponseContractError";
    this.issues = failedPaths(error);
    this.saved = options.saved === true;
  }
}

/** The answer as its schema parses it, or a ResponseContractError. Check it before COMMIT, so an invalid answer saves nothing. */
export function contractAnswer<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ResponseContractError(parsed.error);
  return parsed.data;
}

/** A copy of a stored answer without the keys the issues name as unrecognised. */
function withoutUnrecognisedKeys(value: unknown, issues: ZodIssue[]): unknown {
  const copy = structuredClone(value);
  for (const issue of issues) {
    if (issue.code !== "unrecognized_keys") continue;
    let target: unknown = copy;
    for (const key of issue.path) target = target && typeof target === "object" ? (target as Record<string | number, unknown>)[key] : undefined;
    if (target && typeof target === "object") for (const key of issue.keys) delete (target as Record<string, unknown>)[key];
  }
  return copy;
}

/**
 * The stored answer (an idempotency receipt, or a new lender) of a request
 * saved earlier, for a repeat of that request with its key. It was checked
 * when it was saved, but an earlier build may have stored fields this build's
 * contract no longer lists: those are left out, which keeps the answer within
 * the contract (whose answers allow no other fields), and the log records
 * response.invalid as a warning with the paths that carried them. A stored
 * answer that fails in any other way cannot be given within the contract: a
 * ResponseContractError marked saved, answered as a 500 that says the request
 * was saved, never as "nothing was saved".
 */
export function replayedAnswer<S extends z.ZodTypeAny>(req: Request, schema: S, stored: unknown): z.output<S> {
  const parsed = schema.safeParse(stored);
  if (parsed.success) return parsed.data;
  if (parsed.error.issues.every((issue) => issue.code === "unrecognized_keys")) {
    const trimmed = schema.safeParse(withoutUnrecognisedKeys(stored, parsed.error.issues));
    if (trimmed.success) {
      (req as { log?: { warn?(fields: object, message: string): void } }).log?.warn?.({ event: "response.invalid", replayed: true, issues: failedPaths(parsed.error) }, "A replayed answer carried fields its contract no longer lists; it was answered without them");
      return trimmed.data;
    }
  }
  throw new ResponseContractError(parsed.error, { saved: true });
}

/** The lender a request is scoped to. Every lender-scoped route reads it first, so a missing merchantId is the same 400, naming the field, everywhere. */
export function lenderQuery(req: Request): z.output<typeof lenderQuerySchema> {
  return lenderQuerySchema.parse(req.query);
}
/** The lender and the rows to skip, for the routes that page by 25. */
export function lenderPage(req: Request): z.output<typeof lenderPageQuerySchema> {
  return lenderPageQuerySchema.parse(req.query);
}

/** The Idempotency-Key a write must carry, refused by name (400) when it is missing or is not 8 to 200 characters.
 * A request whose key a route reads is answered for its key when it fails (lib/error-handler.ts). */
export function requiredKey(req: Request): string {
  const key = idempotencyKeyHeaderSchema.parse({ [IDEMPOTENCY_KEY_HEADER]: req.header(IDEMPOTENCY_KEY_HEADER) })[IDEMPOTENCY_KEY_HEADER];
  markKeyed(req);
  return key;
}
/** The Idempotency-Key of a write that may carry one: undefined when absent or empty, refused by name when it is not 8 to 200 characters. */
export function optionalKey(req: Request): string | undefined {
  return req.header(IDEMPOTENCY_KEY_HEADER) ? requiredKey(req) : undefined;
}
