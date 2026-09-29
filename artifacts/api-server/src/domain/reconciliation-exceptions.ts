/**
 * Exception lifecycle rules shared by reconciliation and financial guards.
 * These functions mutate only the supplied domain records; persistence and
 * audit publication remain at the caller's transaction boundary.
 */
import { conditionClearedCode, counted, exceptionCatalogue, hasFeeSchedule, isOpenException, paymentRefundedKobo, paymentUnappliedKobo, providerIdentityConfirmedCode, providerIdentityOf, resolveExceptionType, unseenReversalCondition, type ExceptionType } from "@workspace/valopay-schema";
import { makeRecord, recordsOf, touch } from "./records";
import { recordsOfKind, recordsWhere } from "./record-index";
import { addBusinessDays, watDate } from "./calendar";
import { currencyOf, outstanding, paymentReversed } from "./reconciliation-values";
import type { Context, DomainState, TypedRecord, ValopayRecord } from "./types";

/** Looks up a payment or payment evidence by id: the kinds whose money may be in another currency than naira. */
export type MoneyLookup = (kind: "payments" | "observations", id: string) => ValopayRecord | undefined;
/** The lender's payments and payment evidence by id, through the pass's index when there is one. */
export const moneyIn = (state: DomainState): MoneyLookup => (kind, id) => recordsWhere(state, kind, "id", id)[0];

/**
 * The money an exception is about, whose currency its amountKobo is in: the payment or payment evidence it links to,
 * or, for a report of a collection counted in two settlement batches or of a settlement line in another currency than
 * its batch (linked to the batch that reports it), the payment its condition names, itself
 * (settlement_variance:<batch>:counted:<payment>) or through the settlement line (settlement_variance:<batch>:line:<line>
 * or settlement_variance:<batch>:currency:<line>). Undefined for an exception about anything else, whose amount is naira.
 */
function exceptionMoney(data: { linkedRecordId?: unknown; condition?: unknown }, find: MoneyLookup): ValopayRecord | undefined {
  const linked = String(data.linkedRecordId ?? "");
  const own = linked ? find("payments", linked) ?? find("observations", linked) : undefined;
  if (own) return own;
  const [type, batchId, report, id] = String(data.condition ?? "").split(":");
  if (type !== "settlement_variance" || !linked || batchId !== linked || !id) return undefined;
  if (report === "counted") return find("payments", id);
  const line = report === "line" || report === "currency" ? find("observations", id) : undefined;
  return line && find("payments", String(line.data.paymentId ?? ""));
}
/** The currency of the money an exception is about (exceptionMoney), in capitals: naira when it is about none. */
export function moneyCurrency(data: { linkedRecordId?: unknown; condition?: unknown }, find: MoneyLookup): string {
  const money = exceptionMoney(data, find);
  return money ? currencyOf(money) : "NGN";
}

/** The currency an exception's amountKobo is in, in capitals: the one it names (data.currency), else that of the money it is about (exceptionMoney). */
export function exceptionCurrency(exception: ValopayRecord, find: MoneyLookup): string {
  return exception.data.currency ? currencyOf(exception) : moneyCurrency(exception.data, find);
}

/**
 * Decision on exceptions an earlier build raised for money in another currency: it stored that money's minor units in
 * amountKobo and no currency, so they read as naira. Each reconciliation gives an exception that names no currency the
 * currency of the money it is about (exceptionMoney), when that is not naira, so each is written once, resolved or
 * not; every read then finds it stored. Returns how many it gave one.
 */
export function recordExceptionCurrencies(state: DomainState, ctx: Context): number {
  const find = moneyIn(state);
  let recorded = 0;
  for (const exception of recordsOfKind(state, "exceptions")) {
    if (exception.data.currency) continue;
    const currency = moneyCurrency(exception.data, find);
    if (currency === "NGN") continue;
    exception.data.currency = currency;
    touch(exception, ctx.now);
    recorded += 1;
  }
  return recorded;
}

/**
 * Appendix A: one open exception per (type, linked record), with the
 * catalogue's owner, severity and business-day SLA.
 *
 * Checks the close repeats pass the `condition` that raised the exception.
 * A resolution is then durable: while the same condition holds on the same
 * record, it is not raised again, so a resolved exception does not come back
 * at every close. A changed condition, such as a different fee variance, is
 * new work and raises a new exception. Event-driven raises pass no condition
 * and keep the one-open-exception rule only. `settledBy` names other
 * conditions that describe the same state, such as the spelling an earlier
 * check recorded, so their resolution also holds. An exception the platform
 * closed because its condition cleared settles nothing: the condition coming
 * back later is new work. `owner` replaces the catalogue's owner and
 * `linkedKind` names the linked record's kind where the type does not. The
 * reports of a collection counted in two batches, and of a settlement line in
 * another currency than its batch, that an exception carries (carriedReports)
 * are settled by its resolution too. An exception about
 * money in another currency than naira (exceptionMoney), whose amountKobo is
 * that money's minor units, names that currency (data.currency); `currency`
 * names it where the money is not yet linked, as for a settlement line reported
 * before it records its payment.
 */
export function raiseException(state: DomainState, ctx: Context, type: ExceptionType, options: { linkedRecordId?: string; customerId?: string; amountKobo?: number; notes: string; condition?: string; settledBy?: readonly string[]; owner?: string; linkedKind?: string; currency?: string }): TypedRecord<"exceptions"> {
  const definition = exceptionCatalogue[type];
  const linkedRecordId = options.linkedRecordId || "";
  const linked = recordsWhere(state, "exceptions", "data.linkedRecordId", linkedRecordId);
  const sameType = (item: TypedRecord<"exceptions">) => resolveExceptionType(item.data.type) === type;
  // A settlement batch's provider identity hold has exceptions of its own (keepHoldException): they carry no other report.
  const existing = linked.find((item) => isOpenException(item.status) && sameType(item) && !(type === "settlement_variance" && providerIdentityOf(item.data.condition) !== undefined));
  if (existing) return existing;
  if (options.condition !== undefined) {
    // A resolution with no stored condition (an event-driven raise, or one recorded before conditions were stored) settles the record.
    // Confirming whose payout a held batch is settles no report its exception carried: the report is raised again on its own.
    const settles = (item: TypedRecord<"exceptions">) => item.data.condition === undefined || item.data.condition === options.condition || (options.settledBy ?? []).includes(String(item.data.condition))
      || (carriedReports(item).includes(options.condition!) && item.data.resolutionCode !== providerIdentityConfirmedCode);
    const settled = linked.find((item) => sameType(item) && item.data.resolutionCode !== conditionClearedCode && settles(item));
    if (settled) return settled;
  }
  const currency = options.currency ?? moneyCurrency({ linkedRecordId, condition: options.condition }, moneyIn(state));
  return makeRecord(state, "exceptions", {
    name: definition.title, status: "open", customerId: options.customerId || "", amountKobo: options.amountKobo || 0, createdAt: ctx.now,
    data: {
      type, severity: definition.severity, owner: options.owner ?? definition.owner, slaBusinessDays: definition.slaBusinessDays, dueBy: addBusinessDays(state, ctx.now, definition.slaBusinessDays), notes: options.notes, linkedRecordId,
      ...(options.condition !== undefined ? { condition: options.condition } : {}), ...(options.linkedKind ? { linkedKind: options.linkedKind } : {}),
      ...(currency !== "NGN" ? { currency } : {}),
    },
  });
}

/** Adds a dated line to an exception's notes, once, so what it was raised for is not read as the current state. */
export function noteUpdate(exception: TypedRecord<"exceptions">, ctx: Context, text: string): void {
  if (String(exception.data.notes ?? "").includes(text)) return;
  exception.data.notes = `${exception.data.notes ? `${exception.data.notes}\n` : ""}Update on ${watDate(Date.parse(ctx.now))} (WAT): ${text}`;
  touch(exception, ctx.now);
}

/** The conditions of the reports of a collection counted in two batches that a settlement_variance exception carries beside its own. */
export const countedTwiceReports = (exception: TypedRecord<"exceptions">): string[] => Array.isArray(exception.data.countedTwice) ? exception.data.countedTwice.map(String) : [];
/** The conditions of the reports of a settlement line in another currency than its batch that a settlement_variance exception carries beside its own. */
export const otherCurrencyReports = (exception: TypedRecord<"exceptions">): string[] => Array.isArray(exception.data.otherCurrencyLines) ? exception.data.otherCurrencyLines.map(String) : [];
/** Every report a settlement_variance exception carries beside its own condition. */
export const carriedReports = (exception: TypedRecord<"exceptions">): string[] => [...countedTwiceReports(exception), ...otherCurrencyReports(exception)];

/**
 * Decision on a collection the provider reports in two settlement batches, and
 * on a settlement line in another currency than its batch: the report stays
 * with Finance until Finance resolves it. An exception already open for the
 * batch gains it as a dated line and lists its condition, in countedTwice or
 * otherCurrencyLines, so the batch leaving variance does not close it
 * (clearedCondition) and Finance's resolution settles the report too
 * (raiseException).
 */
export function carryReport(exception: TypedRecord<"exceptions">, ctx: Context, condition: string, notes: string): void {
  if (exception.data.condition !== condition && !carriedReports(exception).includes(condition)) {
    if (condition.split(":")[2] === "currency") exception.data.otherCurrencyLines = [...otherCurrencyReports(exception), condition];
    else exception.data.countedTwice = [...countedTwiceReports(exception), condition];
    touch(exception, ctx.now);
  }
  noteUpdate(exception, ctx, notes);
}

/**
 * Console decision on exceptions whose condition clears: the platform closes
 * the exception in the action that cleared it, with the reason, who acted
 * and when. The request's audit entry commits to the change, and a closed
 * exception is never reopened.
 */
export function closeClearedException(exception: TypedRecord<"exceptions">, ctx: Context, reason: string): void {
  exception.status = "closed";
  exception.data.resolutionCode = conditionClearedCode;
  exception.data.resolvedBy = ctx.actor;
  exception.data.resolvedAt = ctx.now;
  exception.data.conditionCleared = { at: ctx.now, by: ctx.actor, reason };
  exception.data.notes = `${exception.data.notes ? `${exception.data.notes}\n` : ""}Condition cleared on ${watDate(Date.parse(ctx.now))} (WAT): ${reason}, so this exception was closed.`;
  touch(exception, ctx.now);
}

/**
 * Why an open exception's condition no longer holds, or undefined while it
 * holds: money on a payment that no longer waits (allocated in full,
 * refunded or reversed), payment evidence held for Finance that has since
 * resolved (a gross that now agrees with its payment), an instalment a
 * payment was waiting for that is now paid, or an outcome that is now known.
 * Evidence of a reversal that waited for a payment no connection had seen
 * stops waiting once a payment with its reference is recorded (it then applies
 * or is held with an exception of its own), and a settlement batch's variance,
 * raised for its statement credit or its fees, clears once the batch is no
 * longer in variance, unless it also carries a report of a collection counted
 * in two batches or of a line in another currency (carriedReports), which stays
 * for Finance to resolve.
 * `recorded` says whether a payment has a reference.
 * A dispute's condition clears only when its instalment leaves dispute
 * (releaseDispute), since a lender may record a dispute for an instalment
 * that was never in dispute.
 */
function clearedCondition(exception: TypedRecord<"exceptions">, byId: ReadonlyMap<string, ValopayRecord>, recorded: (reference: string) => boolean): string | undefined {
  const type = resolveExceptionType(exception.data.type);
  const linked = byId.get(String(exception.data.linkedRecordId || ""));
  if (!type || !linked) return undefined;
  if (exception.data.legacyResolutionReview) return undefined; // Only an explicit renewed Finance decision settles ambiguous historical authority.
  if (linked.kind === "observations" && type === "suspected_duplicate") {
    if (linked.status !== "resolved") return undefined;
    const payment = byId.get(String(linked.data.paymentId ?? ""));
    return `payment evidence ${linked.reference} is now resolved${payment ? ` to payment ${payment.reference}` : ""}`;
  }
  if (linked.kind === "observations" && type === "provider_status_mismatch" && exception.data.condition === unseenReversalCondition(linked.id)) {
    const payment = byId.get(String(linked.data.paymentId ?? ""));
    if (linked.status === "resolved") return `reversal evidence ${linked.reference} is now resolved${payment ? ` to payment ${payment.reference}` : ""}`;
    return recorded(linked.reference) ? `a payment with reference ${linked.reference} is now recorded` : undefined;
  }
  if (linked.kind === "settlement-batches" && type === "settlement_variance") {
    const condition = String(exception.data.condition ?? "");
    if (linked.status === "variance" || carriedReports(exception).length || ![`settlement_variance:${linked.id}:statement:`, `settlement_variance:${linked.id}:fees:`].some((state) => condition.startsWith(state))) return undefined;
    return linked.status === "reconciled" ? `settlement batch ${linked.reference} is now reconciled` : hasFeeSchedule(currencyOf(linked)) ? `the fees of settlement batch ${linked.reference} are now within the schedule` : `settlement batch ${linked.reference} now waits for its statement credit`;
  }
  if (linked.kind === "payments" && (type === "unallocated_payment" || type === "overpayment" || type === "suspected_duplicate")) {
    const held = linked as TypedRecord<"payments">;
    if (paymentUnappliedKobo(held) > 0) return undefined;
    if (paymentReversed(held)) return `payment ${held.reference} was reversed`;
    if (paymentRefundedKobo(held) > 0) return Number(held.data.allocatedKobo || 0) > 0 ? `payment ${held.reference} is allocated and the rest was refunded` : `payment ${held.reference} was refunded`;
    return `payment ${held.reference} is allocated in full`;
  }
  if (linked.kind === "due-items" && type === "unallocated_payment") return outstanding(linked as TypedRecord<"due-items">) === 0 ? `instalment ${linked.reference} is paid` : undefined;
  if (type === "unknown_outcome" && (linked.kind === "attempts" || linked.kind === "connected-intents") && linked.status !== "unknown") return `the ${linked.kind === "attempts" ? "debit's" : "pay-by-bank payment's"} outcome is now recorded as ${linked.status}`;
  return undefined;
}

/** Closes every open exception whose condition cleared (clearedCondition) and returns them. */
export function clearSettledExceptions(state: DomainState, ctx: Context): TypedRecord<"exceptions">[] {
  const open = recordsOf(state, "exceptions").filter((item) => isOpenException(item.status));
  if (!open.length) return [];
  const byId = new Map(state.records.map((record) => [record.id, record]));
  let references: Set<string> | undefined;
  const recorded = (reference: string) => Boolean(reference) && (references ??= new Set(recordsOf(state, "payments").flatMap((payment) => [payment.reference, String(payment.data.providerReference ?? "")]))).has(reference);
  const cleared: TypedRecord<"exceptions">[] = [];
  for (const exception of open) {
    const reason = clearedCondition(exception, byId, recorded);
    if (!reason) continue;
    closeClearedException(exception, ctx, reason);
    cleared.push(exception);
  }
  return cleared;
}

/** What an audit entry adds for exceptions closed because their condition cleared: how many, of which types, for the first few reasons. */
export function clearedExceptionsNote(cleared: readonly TypedRecord<"exceptions">[]): string | undefined {
  if (!cleared.length) return undefined;
  const reasons = cleared.slice(0, 3).map((item) => `${exceptionCatalogue[resolveExceptionType(item.data.type)!]?.title.toLowerCase() ?? "exception"}: ${item.data.conditionCleared?.reason}`);
  const more = cleared.length > 3 ? `; and ${counted(cleared.length - 3, "more", "more")}` : "";
  return `Closed ${counted(cleared.length, "exception")} whose condition cleared (${reasons.join("; ")}${more}).`;
}

/** An audit entry's summary: the reason, then what the action established (its answer's auditNote), such as the exceptions it closed. */
export function withAuditNote(reason: string, note: unknown): string {
  return typeof note === "string" && note ? `${reason}${/[.!?]$/.test(reason) ? "" : "."} ${note}` : reason;
}

const confirmedOutcomes: Record<string, "failed" | "succeeded" | "cancelled"> = { resolved_failed: "failed", resolved_succeeded: "succeeded", provider_confirmed_no_debit: "cancelled" };

/**
 * Appendix A, unknown_outcome: the outcome Operations confirmed with the
 * provider becomes the attempt's status, so the instalment stops waiting as
 * in flight and the retry rules see a failed, succeeded or cancelled attempt.
 * A failure without a confirmed code is recorded as UNKNOWN, which is never
 * retried. What the attempt showed before is kept on it. Returns the new
 * status, or undefined when the attempt no longer waits on this resolution.
 */
export function confirmAttemptOutcome(state: DomainState, ctx: Context, exception: TypedRecord<"exceptions">): "failed" | "succeeded" | "cancelled" | undefined {
  const status = confirmedOutcomes[String(exception.data.resolutionCode)];
  const attempt = recordsOf(state, "attempts").find((item) => item.id === exception.data.linkedRecordId);
  if (!status || !attempt || attempt.status !== "unknown") return undefined;
  attempt.data.outcomeConfirmation = {
    exceptionId: exception.id, resolutionCode: String(exception.data.resolutionCode), previousStatus: attempt.status,
    ...(attempt.data.failureCode ? { previousFailureCode: String(attempt.data.failureCode) } : {}),
    ...(attempt.data.rawFailureCode ? { previousRawFailureCode: String(attempt.data.rawFailureCode) } : {}),
    confirmedAt: ctx.now, confirmedBy: String(exception.data.resolvedBy || ctx.actor),
  };
  attempt.status = status;
  const confirmedCode = typeof exception.data.confirmedFailureCode === "string" && exception.data.confirmedFailureCode ? exception.data.confirmedFailureCode : undefined;
  if (status === "failed") attempt.data.failureCode = confirmedCode ?? "UNKNOWN";
  else delete attempt.data.failureCode;
  // The provider's raw code was the timeout; a confirmed code replaces it, so no mapping exception is raised for it.
  if (status === "failed" && confirmedCode) attempt.data.rawFailureCode = confirmedCode; else delete attempt.data.rawFailureCode;
  if (status === "cancelled") attempt.data.cancellationReason = "The provider confirmed that no debit took place.";
  touch(attempt, ctx.now);
  return status;
}
