import { z } from "zod";
import { moneyRefusalCodes } from "./money";

/**
 * Building blocks the API and the console share for requests and answers: the
 * date-time a caller sends, the lender query value, the Idempotency-Key header,
 * the error body, and the stored record, lender and assignee shapes that many
 * answers carry. The contract (scripts/create-valopay-spec.cjs) is generated
 * from these, so the routes, the console and the contract read one definition.
 */

/**
 * An RFC 3339 date and time a caller sends: Z or an offset such as +01:00,
 * with any fraction of a second. It becomes the UTC instant the service stores
 * and compares (milliseconds and Z, as every stored timestamp is written), so
 * a version sent with an offset matches the stored version it names.
 */
export const instantInputSchema = z
  .string()
  .datetime({ offset: true, message: "Use a date and time such as 2026-09-18T07:00:00Z or 2026-09-18T08:00:00+01:00." })
  .transform((value, context) => {
    const instant = new Date(value);
    const utc = Number.isFinite(instant.getTime()) ? instant.toISOString() : "";
    // PostgreSQL has no year 0, so the year 0000 is refused with the rest.
    if (!/^\d{4}-/.test(utc) || utc.startsWith("0000")) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Use a date and time between the years 0001 and 9999." });
      return z.NEVER;
    }
    return utc;
  })
  .describe("An RFC 3339 date and time with Z or an offset, such as 2026-09-18T08:00:00+01:00. The service stores and compares the UTC instant.");

const utcInstant = z.string().datetime();
/**
 * A timestamp read back from storage in the form every answer gives it. One
 * already in UTC is returned exactly as stored, since stored values are also
 * compared word for word. One with an offset (as data written by an earlier
 * build may hold it) names the same instant, so it becomes that UTC instant,
 * as instantInputSchema makes an input. Anything else is returned unchanged,
 * so the answer's own check refuses it as the fault it is.
 */
export function storedInstant(value: unknown): unknown {
  if (utcInstant.safeParse(value).success) return value;
  const parsed = instantInputSchema.safeParse(value);
  return parsed.success ? parsed.data : value;
}

/** The lender a request is scoped to, as its merchantId query value. */
export const merchantIdSchema = z
  .string({ required_error: "Choose a lender.", invalid_type_error: "Choose one lender." })
  .min(1, "Choose a lender.")
  .max(100, "Choose a lender from the list.");
/** The id an address names (a record, run, batch, case, review, correction, export, member or invitation): 1 to 100 characters. */
export const pathIdSchema = z
  .string({ required_error: "This link does not name a record. Open the record from its list.", invalid_type_error: "This link names more than one record. Open the record from its list." })
  .min(1, "This link does not name a record. Open the record from its list.")
  .max(100, "This link is too long. Open the record from its list.");
/** The id an address names, parsed so that a refusal names the parameter `id`: the same 400 on every route, before its body is read. */
export function pathId(value: unknown): string {
  return pathIdSchema.parse(value, { path: ["id"] });
}
/** The query of a lender-scoped request: every route reads it first, so a missing merchantId is the same 400 everywhere. */
export const lenderQuerySchema = z.object({ merchantId: merchantIdSchema });
/** A lender-scoped page of 25 rows: merchantId and the rows to skip. */
export const lenderPageQuerySchema = lenderQuerySchema.extend({ offset: z.coerce.number().int().min(0).max(100000).default(0) });

/** The header that makes a write repeatable and recoverable. */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
/** One key per unchanged intention: 8 to 200 characters. */
export const idempotencyKeySchema = z
  .string({ required_error: "Send an Idempotency-Key header: one key of 8 to 200 characters for each unchanged request.", invalid_type_error: "Send one Idempotency-Key header." })
  .min(8, "An Idempotency-Key is 8 to 200 characters.")
  .max(200, "An Idempotency-Key is 8 to 200 characters.");
/** The header parsed under its own name, so a refusal names the header. */
export const idempotencyKeyHeaderSchema = z.object({ [IDEMPOTENCY_KEY_HEADER]: idempotencyKeySchema });

/** The staff-access refusals a code names (PilotAccessError). */
export const pilotAccessFailureCodes = ["pilot_disabled", "configuration_invalid", "authentication_required", "session_invalid", "membership_required", "membership_inactive", "role_not_permitted", "mfa_required", "reverification_required"] as const;
/** A staff-access refusal's code. */
export type PilotAccessFailureCode = (typeof pilotAccessFailureCodes)[number];

/** One field a request got wrong, as a validation refusal names it. */
export const errorDetailSchema = z.object({
  field: z.string().describe("The field, query value or header, as a dotted path; empty for the body as a whole."),
  message: z.string(),
}).strict();
/** A validation refusal names at most this many fields, and says how many there were (detailCount). */
export const ERROR_DETAIL_LIMIT = 20;
/**
 * The state of a request's operations-journal entry, as a refusal or failure
 * names it: `completed` (a request with its Idempotency-Key was saved),
 * `running` (another attempt with the key is still running it), `pending` (its
 * outcome is not confirmed yet) or `cancelled` (nothing sent with the key was
 * saved, or can be).
 */
export const operationStates = ["pending", "running", "completed", "cancelled"] as const;
/** The body of every refusal and failure the service answers (lib/error-handler.ts and the app's own refusals). */
export const errorBodySchema = z.object({
  error: z.string().describe("What happened, in plain words: a refusal in its rule's own wording, a failure in general words."),
  requestId: z.string().describe("The request's reference, also sent as X-Request-Id; quoting it finds the request in the log."),
  details: z.array(errorDetailSchema).max(ERROR_DETAIL_LIMIT).optional().describe("Present when validation failed: the first 20 fields at most, each with what is wrong with it."),
  detailCount: z.number().int().min(0).optional().describe("Present with details: how many problems validation found, which may be more than details lists."),
  code: z.enum([...pilotAccessFailureCodes, ...moneyRefusalCodes]).optional().describe("Present when staff access was refused (why), or with a 422 when a money calculation the request needs was refused: INVALID_MONEY_AMOUNT (an amount that is not a safe whole number of minor units), INVALID_MONEY_RATE (a rate outside its bounds) or MONEY_OUT_OF_RANGE (a result beyond the safe-integer minor-unit range)."),
  committed: z.literal(false).optional().describe("Present on a failure that saved nothing: the transaction was rolled back, so the request may be sent again as new. For a request with an Idempotency-Key it is decided for the key: present only when nothing sent with the key was or can be saved (its journal entry is cancelled, or nothing was saved under it before this request failed), never while a request with the key was saved or is still running. A read's 500 never carries it."),
  operation: z.enum(operationStates).optional().describe("Present when the request's Idempotency-Key has an operations-journal entry whose state is known: completed (a request with the key was saved), running (another attempt with the key is still running it), pending (its outcome is not confirmed yet) or cancelled (nothing sent with the key was or can be saved)."),
}).strict();
/** A refusal or failure as the service answers it. */
export type ErrorBody = z.infer<typeof errorBodySchema>;

/** A record's data: the fields its kind declares and anything else a caller stored. */
export const recordDataSchema = z.record(z.unknown());
/** A stored record of any kind, exactly as an answer carries it. */
export const valopayRecordSchema = z.object({
  id: z.string(), merchantId: z.string(), kind: z.string(), name: z.string(), status: z.string(), reference: z.string(),
  amountKobo: z.number().int(), customerId: z.string(), createdAt: z.string(), updatedAt: z.string(), data: recordDataSchema,
}).strict();
/** A stored record as an answer carries it. */
export type ValopayRecordView = z.infer<typeof valopayRecordSchema>;
/** A lender (a merchant in the API): its mode, provider, volume, emergency stop and readiness flags. */
export const merchantSchema = z.object({
  id: z.string(), name: z.string(), shortName: z.string(), segment: z.string(), mode: z.string(), status: z.string(), provider: z.string(),
  monthlyVolume: z.number().int(), killSwitch: z.boolean(), preDataReady: z.boolean(), preLiveReady: z.boolean(),
}).strict();
/** A lender as an answer carries it. */
export type MerchantView = z.infer<typeof merchantSchema>;
/** A confirmation in plain words, when nothing else changed that the caller needs to read back. */
export const messageSchema = z.object({ message: z.string() }).strict();
/**
 * The data confirm_allocation and reject_allocation require (POST /v1/actions,
 * whose recordId names the payment): the proposed match the decision was made
 * on, by its id and the version it was read with. A request without either is
 * refused, naming it, once the lender is loaded and before the payment or its
 * proposal is read, so nothing is saved.
 */
export const allocationDecisionDataSchema = z.object({
  proposalId: z.string().min(1, "Reload the page and choose the match again.").describe("The id of the proposed allocation reviewed (the allocation record, not the payment)."),
  proposalUpdatedAt: instantInputSchema.describe("The proposed allocation's updatedAt as it was read: an RFC 3339 date and time with Z or an offset. It is compared as an instant, so the same instant written another way names the same version."),
});
/** A person who can own a case or review a close: a demo role in the sandbox, an active staff member with lender access on a staff host. */
export const assigneeSchema = z.object({ actor: z.string(), name: z.string(), role: z.string() }).strict();
/** A possible case owner or reviewer. */
export type Assignee = z.infer<typeof assigneeSchema>;
