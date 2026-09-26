import { isDeepStrictEqual } from "node:util";
import { providerConnectionKey, sumMoney, nonnegativeMoney, validMoneyBps } from "@workspace/valopay-schema";
import { DEFAULT_PROVIDER_FEE, SETTLEMENT_BATCH_TOLERANCE_KOBO, SETTLEMENT_ITEM_TOLERANCE_KOBO, WAT_OFFSET_MS, allocationClosedStatuses, conditionClearedCode, counted, exceptionCatalogue, hasFeeSchedule, heldEvidenceCodes, heldEvidenceCondition, heldEvidenceOf, isKobo, isOpenException, moneyText, nairaText, normaliseFailureCode, normaliseRefundStatus, normaliseReversalStatus, otherCurrenciesText, paymentAwaitsAllocation, paymentMoneyReturned, paymentRefundedKobo, paymentUnappliedKobo, providerFeeKobo, resolveExceptionType, unseenReversalCodes, unseenReversalCondition, unseenReversalOf, type ExceptionType, type ProviderFeeSchedule, type PaymentChannel } from "@workspace/valopay-schema";
import { findRecord, makeRecord, recordsOf, touch } from "./records";
import { indexedPass, recordById, recordsOfKind, recordsWhere } from "./record-index";
import type { Context, DomainState, TypedRecord, ValopayRecord } from "./types";
import { addBusinessDays, watDate } from "./calendar";
import { validateRecord } from "./validation";
import { approvedPolicyFor, attemptTime, attemptsFor, countedAttempts, enrolEligibleFailures, evaluateRetry, recordRetryDecision } from "./policy-engine";
import { dueNeedsReversalReview, latestEvidenceResolution, paymentNeedsReversalReview } from "./reversal-review";

const DAY_MS = 24 * 60 * 60 * 1000;
/** ING-05: a second Payment for the same payer and amount inside this window is held as a possible duplicate. */
export const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
/** REC-04: unallocated Payments older than this become exceptions. */
export const UNALLOCATED_AGE_MS = DAY_MS;
/** Decision on a reversal of a payment no connection has seen: after waiting this long for its payment, it is an exception for Finance. */
export const UNSEEN_REVERSAL_AGE_MS = DAY_MS;
/** Appendix A, unknown_outcome: a debit attempt's or a pay-by-bank checkout's outcome still unknown this long after it became unknown is an exception. */
export const UNKNOWN_OUTCOME_AGE_MS = DAY_MS;

export const paymentReversed = (payment: TypedRecord<"payments">): boolean => normaliseReversalStatus(payment.data.reversalStatus) === "reversed";
export const paymentRefunded = (payment: TypedRecord<"payments">): boolean => normaliseRefundStatus(payment.data.refundStatus) === "refunded";
/** Reversed, or refunded in full: the money went back to the payer, so nothing it has not already applied can be allocated or held as credit. */
export const paymentReturned = (payment: TypedRecord<"payments">): boolean => paymentMoneyReturned(payment);
export const paymentObservedAt = (payment: TypedRecord<"payments">): number => Date.parse(String(payment.data.observedAt || payment.createdAt));
/** When an allocation was applied (REC-07, REC-09): confirmedAt, or its creation for records written before confirmedAt was kept. A review or a reinstatement never moves it. */
export const allocationConfirmedAt = (allocation: TypedRecord<"allocations">): string => String(allocation.data.confirmedAt || allocation.createdAt);
/** The currency evidence or a payment is in, in capitals; one that names none is in naira. */
export const currencyOf = (record: ValopayRecord): string => String(record.data.currency || "NGN").trim().toUpperCase();
/** ING-03: the provider connection evidence came through, or a payment was observed on; one that names none came through the lender's own. */
export const connectionOf = (state: DomainState, record: ValopayRecord): string => String(record.data.providerConnection || record.data.provider || state.merchant.provider);
/** Connection names are free text: they are compared without case or surrounding spaces. */
const connectionKey = providerConnectionKey;
const settlementIdentity = (state: DomainState, record: ValopayRecord, reference = record.reference): string => JSON.stringify([connectionKey(connectionOf(state, record)), reference]);
const batchIdentity = (state: DomainState, batch: TypedRecord<"settlement-batches">): string => String(batch.data.providerIdentityKey || settlementIdentity(state, batch));

/** The four independent status dimensions of a Payment (TRD 4.2), written in one vocabulary; legacy spellings are normalised. */
export function paymentDimensions(payment: TypedRecord<"payments">): void {
  payment.data.collectionStatus ||= "received";
  payment.data.settlementStatus ||= "unsettled";
  payment.data.reversalStatus = normaliseReversalStatus(payment.data.reversalStatus);
  payment.data.refundStatus = normaliseRefundStatus(payment.data.refundStatus);
  if (!isKobo(payment.data.allocatedKobo)) payment.data.allocatedKobo = 0;
}

/** CON-09: the provider fee schedule for a connection, falling back to the merchant's default provider, then the plan's sourced rail fee. */
export function feeScheduleFor(state: DomainState, provider: unknown): ProviderFeeSchedule {
  const schedules = (state.settings.providerFeeSchedule || {}) as Record<string, { bps?: unknown; capKobo?: unknown }>;
  const configured = schedules[String(provider)] || schedules[state.merchant.provider];
  if (configured) {
    return { bps: validMoneyBps(configured.bps as number), capKobo: configured.capKobo === undefined ? Number.MAX_SAFE_INTEGER : nonnegativeMoney(configured.capKobo as number) };
  }
  if (state.settings.providerFeeBps !== undefined) return { bps: validMoneyBps(state.settings.providerFeeBps as number), capKobo: Number.MAX_SAFE_INTEGER };
  return DEFAULT_PROVIDER_FEE;
}

/** The fee schedule for money in `currency` through a connection: none outside naira, whose schedules they all are (hasFeeSchedule). */
function feeScheduleIn(state: DomainState, provider: unknown, currency: string): ProviderFeeSchedule | undefined {
  return hasFeeSchedule(currency) ? feeScheduleFor(state, provider) : undefined;
}

/** The condition an exception type raises for when it names only its record: the record itself. */
const identityCondition = (type: ExceptionType, linkedRecordId: string): string => `${type}:${linkedRecordId}`;

/** Looks up a payment or payment evidence by id: the kinds whose money may be in another currency than naira. */
export type MoneyLookup = (kind: "payments" | "observations", id: string) => ValopayRecord | undefined;
/** The lender's payments and payment evidence by id, through the pass's index when there is one. */
const moneyIn = (state: DomainState): MoneyLookup => (kind, id) => recordsWhere(state, kind, "id", id)[0];

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
function moneyCurrency(data: { linkedRecordId?: unknown; condition?: unknown }, find: MoneyLookup): string {
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
function recordExceptionCurrencies(state: DomainState, ctx: Context): number {
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
  const existing = linked.find((item) => isOpenException(item.status) && sameType(item));
  if (existing) return existing;
  if (options.condition !== undefined) {
    // A resolution with no stored condition (an event-driven raise, or one recorded before conditions were stored) settles the record.
    const settles = (item: TypedRecord<"exceptions">) => item.data.condition === undefined || item.data.condition === options.condition || (options.settledBy ?? []).includes(String(item.data.condition)) || carriedReports(item).includes(options.condition!);
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
function noteUpdate(exception: TypedRecord<"exceptions">, ctx: Context, text: string): void {
  if (String(exception.data.notes ?? "").includes(text)) return;
  exception.data.notes = `${exception.data.notes ? `${exception.data.notes}\n` : ""}Update on ${watDate(Date.parse(ctx.now))} (WAT): ${text}`;
  touch(exception, ctx.now);
}

/** The conditions of the reports of a collection counted in two batches that a settlement_variance exception carries beside its own. */
const countedTwiceReports = (exception: TypedRecord<"exceptions">): string[] => Array.isArray(exception.data.countedTwice) ? exception.data.countedTwice.map(String) : [];
/** The conditions of the reports of a settlement line in another currency than its batch that a settlement_variance exception carries beside its own. */
const otherCurrencyReports = (exception: TypedRecord<"exceptions">): string[] => Array.isArray(exception.data.otherCurrencyLines) ? exception.data.otherCurrencyLines.map(String) : [];
/** Every report a settlement_variance exception carries beside its own condition. */
const carriedReports = (exception: TypedRecord<"exceptions">): string[] => [...countedTwiceReports(exception), ...otherCurrencyReports(exception)];

/**
 * Decision on a collection the provider reports in two settlement batches, and
 * on a settlement line in another currency than its batch: the report stays
 * with Finance until Finance resolves it. An exception already open for the
 * batch gains it as a dated line and lists its condition, in countedTwice or
 * otherCurrencyLines, so the batch leaving variance does not close it
 * (clearedCondition) and Finance's resolution settles the report too
 * (raiseException).
 */
function carryReport(exception: TypedRecord<"exceptions">, ctx: Context, condition: string, notes: string): void {
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
function closeClearedException(exception: TypedRecord<"exceptions">, ctx: Context, reason: string): void {
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

function outstanding(due: TypedRecord<"due-items">): number {
  return Number.isInteger(due.data.outstandingKobo) ? Number(due.data.outstandingKobo) : due.amountKobo;
}

function eligibleForAutomaticMatching(due: TypedRecord<"due-items">): boolean {
  return outstanding(due) > 0 && !["in_dispute", "unpaid_final", "cancelled", "closed"].includes(due.status);
}

function channelFor(source: unknown): PaymentChannel {
  switch (source) {
    case "webhook": case "settlement": return "direct_debit";
    case "transfer": return "transfer";
    case "card": return "card";
    case "statement": return "statement";
    default: return "manual";
  }
}

function cancelUnsentAttempts(state: DomainState, dueItemId: string, now: string): void {
  recordsWhere(state, "attempts", "data.dueItemId", dueItemId).filter((item) => item.status === "scheduled").forEach((item) => {
    item.status = "cancelled";
    item.data.cancellationReason = "Due item settled by another channel; no instruction was sent.";
    touch(item, now);
  });
}

/** What a settlement line adds to its batch's totals. */
interface LineTotals { grossKobo: number; feeKobo: number; expectedFeeKobo: number }

/**
 * The one fee schedule a settlement line is checked against, at its first count
 * (settlementBatch) and at every recount (completeLineGross, recountEarlierLines,
 * countDisplacedLines): the schedule of the provider it names (data.provider),
 * else of its payment's connection, else of the lender's provider, for money in
 * its currency (none outside naira). Every build before 26 September counted
 * lines this way, and a line records the expected fee it was counted with, so
 * counts already saved stay as they are. The batch the line counts in is still
 * found by its connection (settlementIdentity), which its provider does not change.
 */
const lineSchedule = (state: DomainState, line: TypedRecord<"observations">, payment: TypedRecord<"payments">): ProviderFeeSchedule | undefined =>
  feeScheduleIn(state, String(line.data.provider || payment.data.providerConnection || state.merchant.provider), currencyOf(line));

/**
 * ING-07: what a settlement line adds to its batch. A line whose gross is
 * known, because it states one or its payment's gross is complete, adds that
 * gross, its stated fee (else the gross less what it paid out, else the
 * schedule's fee) and the schedule's fee on the gross. A line that states only
 * what it paid out, for a payment whose gross is not yet known, adds that as
 * its net: a stated fee makes its gross with it, and without one it adds no fee
 * and no expected fee, so a gross not yet known never puts its batch in
 * variance. The debit's gross completes it later (completeLineGross). A line
 * in a currency with no fee schedule adds no expected fee.
 */
function lineTotals(line: TypedRecord<"observations">, payment: TypedRecord<"payments">, schedule: ProviderFeeSchedule | undefined): LineTotals {
  const stated = isKobo(line.data.feeKobo) ? line.data.feeKobo : undefined;
  const scheduleFee = (grossKobo: number) => schedule ? providerFeeKobo(grossKobo, schedule) : 0;
  if (line.data.grossAmountKobo === undefined && payment.data.grossUnstated === true) {
    const grossKobo = sumMoney([line.amountKobo, stated ?? 0]);
    return { grossKobo, feeKobo: stated ?? 0, expectedFeeKobo: stated === undefined ? 0 : scheduleFee(grossKobo) };
  }
  const grossKobo = payment.amountKobo, expectedFeeKobo = scheduleFee(grossKobo);
  return { grossKobo, feeKobo: stated ?? (grossKobo > line.amountKobo ? grossKobo - line.amountKobo : expectedFeeKobo), expectedFeeKobo };
}

/** Whether a batch's fees are checked: there is a fee schedule for its currency (hasFeeSchedule). */
const feesChecked = (batch: ValopayRecord): boolean => hasFeeSchedule(currencyOf(batch));

/**
 * Moves a batch's totals from what a line added before (`was`) to what it
 * adds now, and records that on the line (countedGrossKobo, assumedFeeKobo,
 * expectedFeeKobo, and feeVarianceKobo while its fee differs from the schedule's).
 * A batch whose fees are not checked, and its lines, keep no expected fee and no
 * fee variance.
 */
function countLine(batch: TypedRecord<"settlement-batches">, line: TypedRecord<"observations">, now: LineTotals, was: LineTotals): void {
  batch.data.grossKobo = sumMoney([Number(batch.data.grossKobo || 0), now.grossKobo, -was.grossKobo]);
  batch.data.feeKobo = sumMoney([Number(batch.data.feeKobo || 0), now.feeKobo, -was.feeKobo]);
  if (feesChecked(batch)) batch.data.expectedFeeKobo = sumMoney([Number(batch.data.expectedFeeKobo || 0), now.expectedFeeKobo, -was.expectedFeeKobo]);
  batch.data.netKobo = sumMoney([Number(batch.data.grossKobo), -Number(batch.data.feeKobo)]);
  line.data.countedGrossKobo = now.grossKobo;
  line.data.assumedFeeKobo = now.feeKobo;
  if (!feesChecked(batch)) {
    for (const record of [batch, line]) { delete record.data.expectedFeeKobo; delete record.data.feeVarianceKobo; }
    return;
  }
  batch.data.feeVarianceKobo = sumMoney([Number(batch.data.feeKobo), -Number(batch.data.expectedFeeKobo)]);
  line.data.expectedFeeKobo = now.expectedFeeKobo;
  if (Math.abs(now.feeKobo - now.expectedFeeKobo) > SETTLEMENT_ITEM_TOLERANCE_KOBO) line.data.feeVarianceKobo = now.feeKobo - now.expectedFeeKobo;
  else delete line.data.feeVarianceKobo;
}

/**
 * Decision on a settlement line that stated only what it paid out: once the
 * debit's own gross completes its payment, the batch that counts the line takes
 * the line's gross and fee as they now are and the schedule's fee on that gross,
 * so its expected fee and variance follow at this reconciliation. A line counted
 * before it recorded its gross added its payment's amount then, `previousKobo`.
 */
function completeLineGross(state: DomainState, ctx: Context, payment: TypedRecord<"payments">, previousKobo: number, lines: SettlementLines): void {
  const batch = lines.batchOf(payment.id);
  if (!batch || batch.data.providerIdentityReview || !Array.isArray(batch.data.lineObservationIds)) return;
  const line = batch.data.lineObservationIds.map((id) => recordsWhere(state, "observations", "id", String(id))[0]).find((item) => item?.data.paymentId === payment.id);
  if (!line) return;
  const schedule = lineSchedule(state, line, payment);
  const grossKobo = isKobo(line.data.countedGrossKobo) ? line.data.countedGrossKobo : previousKobo;
  const expectedFeeKobo = isKobo(line.data.expectedFeeKobo) ? line.data.expectedFeeKobo : schedule ? providerFeeKobo(grossKobo, schedule) : 0;
  const was = { grossKobo, expectedFeeKobo, feeKobo: isKobo(line.data.assumedFeeKobo) ? line.data.assumedFeeKobo : isKobo(line.data.feeKobo) ? line.data.feeKobo : grossKobo > line.amountKobo ? grossKobo - line.amountKobo : expectedFeeKobo };
  const now = lineTotals(line, payment, schedule);
  if (now.grossKobo === was.grossKobo && now.feeKobo === was.feeKobo && now.expectedFeeKobo === was.expectedFeeKobo) return;
  countLine(batch, line, now, was);
  touch(batch, ctx.now); touch(line, ctx.now);
}

/** A settlement line that made its payment, from what it paid out when it stated no gross. */
const madeItsPayment = (line: TypedRecord<"observations">): boolean => line.data.resolutionKey === "new_canonical_provider_reference" || line.data.resolutionKey === "separate_payment_after_review";

/** A line's payment. */
type PaymentOf = (line: TypedRecord<"observations">) => TypedRecord<"payments"> | undefined;
/** What a counted line added to its batch: the gross it recorded, else stated, else the payout it made its payment from, else its payment's amount, and the fees it recorded. */
function lineAdded(line: TypedRecord<"observations">, paymentOf: PaymentOf): LineTotals {
  const grossKobo = isKobo(line.data.countedGrossKobo) ? line.data.countedGrossKobo : line.data.grossAmountKobo !== undefined ? Number(line.data.grossAmountKobo) : madeItsPayment(line) ? line.amountKobo : Number(paymentOf(line)?.amountKobo);
  return { grossKobo, feeKobo: Number(line.data.assumedFeeKobo), expectedFeeKobo: isKobo(line.data.expectedFeeKobo) ? line.data.expectedFeeKobo : 0 };
}
/**
 * Whether a batch's totals are still the ones its lines added (lineAdded): a
 * batch Finance has corrected by hand, or one with a line missing or counted
 * with no recorded fee, is not.
 */
function totalsFromLines(batch: TypedRecord<"settlement-batches">, lines: readonly (TypedRecord<"observations"> | undefined)[], paymentOf: PaymentOf): boolean {
  let grossKobo = 0, feeKobo = 0, expectedFeeKobo = 0;
  for (const line of lines) {
    if (!line || !isKobo(line.data.assumedFeeKobo)) return false;
    const added = lineAdded(line, paymentOf);
    grossKobo = sumMoney([grossKobo, added.grossKobo]); feeKobo = sumMoney([feeKobo, added.feeKobo]); expectedFeeKobo = sumMoney([expectedFeeKobo, added.expectedFeeKobo]);
  }
  return grossKobo === batch.data.grossKobo && feeKobo === batch.data.feeKobo && expectedFeeKobo === Number(batch.data.expectedFeeKobo ?? 0);
}

/**
 * Decision on batches an earlier build counted: it counted a settlement line
 * that stated only what it paid out, and made its payment, as a gross of that
 * payout with the schedule's fee taken off it (the line's assumedFeeKobo and
 * expectedFeeKobo, and no countedGrossKobo), and never gave the batch the gross
 * that later completed the payment. Once that gross is known, such a line is
 * counted again, once, as this build counts it (lineTotals), while its batch's
 * totals are still the ones its lines added: a batch Finance has corrected by
 * hand keeps the totals Finance typed. The batch's variance and exception then
 * follow at the same reconciliation.
 */
function recountEarlierLines(state: DomainState, ctx: Context): void {
  const paymentOf: PaymentOf = (line) => recordsWhere(state, "payments", "id", String(line.data.paymentId ?? ""))[0];
  for (const batch of recordsOfKind(state, "settlement-batches")) {
    if (batch.data.providerIdentityReview) continue;
    if (!Array.isArray(batch.data.lineObservationIds)) continue;
    const lines = batch.data.lineObservationIds.map((id) => recordsWhere(state, "observations", "id", String(id))[0]);
    const earlier = lines.filter((line): line is TypedRecord<"observations"> => {
      const payment = line && paymentOf(line);
      return !!payment && !isKobo(line.data.countedGrossKobo) && line.data.grossAmountKobo === undefined && madeItsPayment(line) && payment.data.grossUnstated !== true && payment.amountKobo > line.amountKobo;
    });
    if (!earlier.length || !totalsFromLines(batch, lines, paymentOf)) continue;
    for (const line of earlier) {
      const payment = paymentOf(line)!;
      countLine(batch, line, lineTotals(line, payment, lineSchedule(state, line, payment)), { grossKobo: line.amountKobo, feeKobo: Number(line.data.assumedFeeKobo), expectedFeeKobo: isKobo(line.data.expectedFeeKobo) ? line.data.expectedFeeKobo : 0 });
      touch(line, ctx.now);
    }
    touch(batch, ctx.now);
  }
}

/**
 * Decision on batches an earlier build saved, which added lines in any currency
 * to one gross, fee and net and checked their fees against the naira schedule.
 * At each reconciliation a batch that names no currency takes its first counted
 * line's, else, counting none, the first line linked to it (as a batch this
 * build makes takes the currency of the line that made it), and records it when
 * that is not naira or its lines mix currencies (one that names none is in
 * naira). A counted line in another currency than its batch is taken out of its
 * lines and, while its totals are still the ones its lines added
 * (totalsFromLines), out of its totals, and is reported as a line in another
 * currency is (separateOtherCurrencyLine); a batch whose currency has no fee
 * schedule loses the expected fee and fee variance the naira schedule gave it
 * and its lines. The provider's other lines of a collection no batch counts any
 * more are then read again (countDisplacedLines). It runs before the pass counts
 * any line, so each batch is corrected once. Returns the lines taken out, each
 * with its batch and the batch that now counts its collection instead.
 */
function separateEarlierCurrencies(state: DomainState, ctx: Context): SeparatedLine[] {
  const paymentOf: PaymentOf = (line) => recordsWhere(state, "payments", "id", String(line.data.paymentId ?? ""))[0];
  const separated: SeparatedLine[] = [], displaced: SeparatedLine[] = [];
  let linked: Map<string, TypedRecord<"observations">> | undefined;
  // The first settlement line linked to each batch, read once and only for an earlier batch that counts no line.
  const firstLinked = (batchId: string) => (linked ??= recordsOfKind(state, "observations").reduce((map, item) => {
    if (item.data.source === "settlement" && typeof item.data.settlementBatchId === "string" && !map.has(item.data.settlementBatchId)) map.set(item.data.settlementBatchId, item);
    return map;
  }, new Map<string, TypedRecord<"observations">>())).get(batchId);
  for (const batch of recordsOfKind(state, "settlement-batches")) {
    if (batch.data.providerIdentityReview) continue;
    const lines = Array.isArray(batch.data.lineObservationIds) ? batch.data.lineObservationIds.map((id) => recordsWhere(state, "observations", "id", String(id))[0]) : [];
    const first = lines.find(Boolean) ?? (!batch.data.currency && Array.isArray(batch.data.lineObservationIds) ? firstLinked(batch.id) : undefined);
    const currency = batch.data.currency || !first ? currencyOf(batch) : currencyOf(first);
    const other = lines.filter((line): line is TypedRecord<"observations"> => !!line && currencyOf(line) !== currency);
    if (!batch.data.currency && (currency !== "NGN" || other.length)) { batch.data.currency = currency; touch(batch, ctx.now); }
    if (other.length) {
      const fromLines = totalsFromLines(batch, lines, paymentOf);
      for (const line of other) {
        const payment = paymentOf(line), added = lineAdded(line, paymentOf);
        if (fromLines) {
          batch.data.grossKobo = Number(batch.data.grossKobo) - added.grossKobo;
          batch.data.feeKobo = Number(batch.data.feeKobo) - added.feeKobo;
          if (batch.data.expectedFeeKobo !== undefined) batch.data.expectedFeeKobo = Number(batch.data.expectedFeeKobo) - added.expectedFeeKobo;
        }
        batch.data.lineObservationIds = (batch.data.lineObservationIds as string[]).filter((id) => id !== line.id);
        const kept = lines.some((item) => item && item !== line && !other.includes(item) && item.data.paymentId === line.data.paymentId);
        if (!kept) batch.data.linePaymentIds = ((batch.data.linePaymentIds ?? []) as string[]).filter((id) => id !== line.data.paymentId);
        for (const key of ["countedGrossKobo", "assumedFeeKobo", "expectedFeeKobo", "feeVarianceKobo"]) delete line.data[key];
        separateOtherCurrencyLine(state, ctx, batch, line, payment?.amountKobo ?? line.amountKobo, fromLines
          ? " An earlier build added it to the batch's totals; it is now taken out of them."
          : " An earlier build added it to the batch's totals, which no longer show what its lines added (Finance may have typed them by hand), so they are left as they are: check that they leave this line out.");
        separated.push({ line, batch });
        if (!kept && payment) displaced.push(separated.at(-1)!);
      }
      if (fromLines) {
        batch.data.netKobo = sumMoney([Number(batch.data.grossKobo), -Number(batch.data.feeKobo)]);
        if (batch.data.expectedFeeKobo !== undefined) batch.data.feeVarianceKobo = sumMoney([Number(batch.data.feeKobo), -Number(batch.data.expectedFeeKobo)]);
      }
    }
    if (!feesChecked(batch) && ["expectedFeeKobo", "feeVarianceKobo", "feeSchedule"].some((key) => batch.data[key] !== undefined)) {
      for (const key of ["expectedFeeKobo", "feeVarianceKobo", "feeSchedule"]) delete batch.data[key];
      for (const line of lines) if (line && (line.data.expectedFeeKobo !== undefined || line.data.feeVarianceKobo !== undefined)) { delete line.data.expectedFeeKobo; delete line.data.feeVarianceKobo; touch(line, ctx.now); }
      touch(batch, ctx.now);
    }
  }
  // Every batch now names the currency it holds, so the lines of a collection no batch counts any more are read in it.
  for (const entry of displaced) {
    entry.countedIn = countDisplacedLines(state, ctx, entry.batch, entry.line, paymentOf(entry.line)!);
    if (entry.countedIn) noteOpenReport(state, ctx, entry.batch, otherCurrencyLineCondition(entry.batch.id, entry.line.id), `its collection is now counted in settlement batch ${entry.countedIn.reference}, where the provider lists it too.`);
  }
  return separated;
}

/** A line separateEarlierCurrencies took out of its batch, and the batch that now counts its collection instead, if one does. */
interface SeparatedLine { line: TypedRecord<"observations">; batch: TypedRecord<"settlement-batches">; countedIn?: TypedRecord<"settlement-batches"> }

/**
 * Adds a dated line to the open settlement_variance exception of a batch that
 * reports `condition`, as its own or carried, or, for an earlier build's
 * carrier, by the dated line it added for `line`.
 */
function noteOpenReport(state: DomainState, ctx: Context, batch: ValopayRecord, condition: string, text: string, line?: ValopayRecord): void {
  const open = recordsWhere(state, "exceptions", "data.linkedRecordId", batch.id).find((item) => isOpenException(item.status) && resolveExceptionType(item.data.type) === "settlement_variance"
    && (item.data.condition === condition || carriedReports(item).includes(condition) || (!!line && String(item.data.notes ?? "").includes(`(WAT): Settlement line ${line.reference} (`))));
  if (open) noteUpdate(open, ctx, text);
}

/**
 * Decision on a collection an earlier build counted in a batch of another
 * currency, whose line there separateEarlierCurrencies took out (`taken`, from
 * batch `from`): that build reported the provider's other lines of it as
 * counted in `from` (countedInBatchId), which no longer counts it. They are
 * read again in order, as settlementBatch reads a line: one in a batch that
 * counts the collection in another line repeats it there; one in a batch whose
 * lines are in another currency is a line in another currency there; one whose
 * collection another batch counts is counted twice with that batch; and the
 * first left is counted in its batch, which takes its currency if it counts no
 * line yet. Each report still open gains a dated line. Returns the batch that
 * counts the collection now, when this counted it.
 */
function countDisplacedLines(state: DomainState, ctx: Context, from: TypedRecord<"settlement-batches">, taken: TypedRecord<"observations">, payment: TypedRecord<"payments">): TypedRecord<"settlement-batches"> | undefined {
  const lines = recordsOfKind(state, "observations").filter((item) => item.data.source === "settlement" && item.data.countedInBatchId === from.id && item.data.paymentId === payment.id);
  if (!lines.length) return undefined;
  const why = `settlement batch ${from.reference} no longer counts its collection, as its line there is in ${currencyOf(taken)} and the batch in ${currencyOf(from)}`;
  let counting = recordsOfKind(state, "settlement-batches").find((batch) => Array.isArray(batch.data.linePaymentIds) && batch.data.linePaymentIds.map(String).includes(payment.id));
  let countedNow: TypedRecord<"settlement-batches"> | undefined;
  for (const line of lines) {
    const batch = recordsWhere(state, "settlement-batches", "id", String(line.data.settlementBatchId ?? ""))[0];
    if (!batch || batch.data.providerIdentityReview || batch.id === from.id || !Array.isArray(batch.data.lineObservationIds)) continue;
    const lineIds = batch.data.lineObservationIds as string[], linePaymentIds = (batch.data.linePaymentIds ||= []) as string[];
    delete line.data.countedInBatchId;
    let now: string;
    if (linePaymentIds.includes(payment.id)) now = "is still not counted in this batch, as this batch counts its collection in another line";
    else if (lineIds.length && currencyOf(line) !== currencyOf(batch)) {
      delete line.data.duplicateSettlementLine;
      separateOtherCurrencyLine(state, ctx, batch, line, payment.amountKobo, ` An earlier build reported it as counted in settlement batch ${from.reference}, which no longer counts it.`);
      now = "is reported as a line in another currency than this batch";
    } else if (counting) {
      line.data.countedInBatchId = counting.id;
      now = `is still not counted in this batch, as settlement batch ${counting.reference} now counts its collection`;
    } else {
      const schedule = lineSchedule(state, line, payment);
      if (!lineIds.length) takeLineCurrency(batch, currencyOf(line), schedule);
      delete line.data.duplicateSettlementLine;
      linePaymentIds.push(payment.id); lineIds.push(line.id);
      countLine(batch, line, lineTotals(line, payment, schedule), { grossKobo: 0, feeKobo: 0, expectedFeeKobo: 0 });
      touch(batch, ctx.now);
      counting = countedNow = batch;
      now = "is now counted in this batch";
    }
    touch(line, ctx.now);
    noteOpenReport(state, ctx, batch, lineCountedTwiceCondition(batch.id, line.id), `${why}, so settlement line ${line.reference} ${now}.`, line);
  }
  return countedNow;
}

/** Freeze an earlier merged payout for review instead of redistributing historical amounts by guesswork. */
function holdEarlierSettlementIdentities(state: DomainState, ctx: Context): number {
  const batches = recordsOf(state, "settlement-batches"), evidence = new Map<string, TypedRecord<"observations">[]>();
  const byKey = new Map<string, string[]>();
  for (const batch of batches) { const key = batchIdentity(state, batch), ids = byKey.get(key) ?? []; ids.push(batch.id); byKey.set(key, ids); }
  for (const observation of recordsOf(state, "observations")) {
    const id = observation.data.source === "settlement" ? observation.data.settlementBatchId
      : observation.data.source === "statement" && String(observation.data.resolvedTo ?? "").startsWith("batch:") ? String(observation.data.resolvedTo).slice(6) : undefined;
    if (typeof id === "string") { const rows = evidence.get(id) ?? []; rows.push(observation); evidence.set(id, rows); }
  }
  let held = 0;
  for (const batch of batches) {
    const linked = new Map((evidence.get(batch.id) ?? []).map((item) => [item.id, item]));
    const recordedEvidence = [...(Array.isArray(batch.data.lineObservationIds) ? batch.data.lineObservationIds : []), ...(Array.isArray(batch.data.otherCurrencyLineIds) ? batch.data.otherCurrencyLineIds : []), ...(batch.data.statementObservationId ? [batch.data.statementObservationId] : [])];
    for (const id of recordedEvidence) {
      const line = recordsWhere(state, "observations", "id", String(id))[0];
      if (line) linked.set(line.id, line);
    }
    const identity = batchIdentity(state, batch);
    const identities = [...new Set([identity, ...[...linked.values()].map((item) => settlementIdentity(state, item, String(item.data.batchReference || batch.reference)))])].sort();
    const conflicting = identities.length > 1 || (byKey.get(identity)?.length ?? 0) > 1;
    if (conflicting && !batch.data.providerIdentityReview) {
      batch.data.providerIdentityReview = {
        detectedAt: ctx.now, identities, observationIds: [...linked.keys()].sort(),
        previous: { status: batch.status, grossKobo: batch.data.grossKobo, feeKobo: batch.data.feeKobo, netKobo: batch.data.netKobo, currency: currencyOf(batch), statementObservationId: batch.data.statementObservationId ?? null, statementNetKobo: batch.data.statementNetKobo ?? null },
      };
      touch(batch, ctx.now);
    }
    if (batch.data.providerIdentityReview) { held += 1; continue; }
    if (!batch.data.providerIdentityKey) {
      batch.data.providerIdentityKey = identity;
      batch.data.providerConnection = connectionOf(state, batch);
      touch(batch, ctx.now);
    }
  }
  return held;
}

/** A batch's first counted line gives it its currency, and the fee schedule for that currency when there is one. */
function takeLineCurrency(batch: TypedRecord<"settlement-batches">, currency: string, schedule: ProviderFeeSchedule | undefined): void {
  batch.data.currency = currency;
  if (schedule) { batch.data.feeSchedule ??= schedule; batch.data.expectedFeeKobo ??= 0; return; }
  for (const key of ["feeSchedule", "expectedFeeKobo", "feeVarianceKobo"]) delete batch.data[key];
}

/**
 * ING-07: a settlement line counts in the batch its batch reference names.
 * Decision on currencies: a batch holds one currency, its first counted line's,
 * and its totals are in that currency's smallest unit; a line in another
 * currency is linked to it as evidence and never counted (separateOtherCurrencyLine).
 */
function settlementBatch(state: DomainState, ctx: Context, observation: TypedRecord<"observations">, payment: TypedRecord<"payments">, lines: SettlementLines): void {
  const batchReference = String(observation.data.batchReference || "");
  if (!batchReference) return;
  const provider = connectionOf(state, observation);
  const currency = currencyOf(observation), schedule = lineSchedule(state, observation, payment);
  const identity = settlementIdentity(state, observation, batchReference);
  let batch = recordsWhere(state, "settlement-batches", "reference", batchReference).find((item) => batchIdentity(state, item) === identity || (item.data.providerIdentityReview as { identities?: string[] } | undefined)?.identities?.includes(identity));
  if (!batch) {
    batch = makeRecord(state, "settlement-batches", {
      name: `Settlement batch ${batchReference}`, status: "pending", reference: batchReference, createdAt: ctx.now,
      data: { provider, batchReference, providerConnection: provider, providerIdentityKey: identity, currency, lineObservationIds: [], linePaymentIds: [], grossKobo: 0, feeKobo: 0, netKobo: 0, ...(schedule ? { expectedFeeKobo: 0, feeSchedule: schedule } : {}) },
    });
  }
  if (batch.data.providerIdentityReview) {
    // Retain new evidence beside the quarantined historical total; never silently mix it into that total.
    observation.data.settlementBatchId = batch.id;
    observation.data.providerIdentityHeld = true;
    return;
  }
  if (!Array.isArray(batch.data.lineObservationIds)) {
    // A batch Finance entered by hand: the provider's lines now build its totals, in their currency, and the typed totals are kept beside them.
    batch.data.enteredTotals = { grossKobo: Number(batch.data.grossKobo || 0), feeKobo: Number(batch.data.feeKobo || 0), netKobo: Number(batch.data.netKobo || 0), currency: currencyOf(batch) };
    Object.assign(batch.data, { lineObservationIds: [], linePaymentIds: [], grossKobo: 0, feeKobo: 0, netKobo: 0 });
  }
  const lineIds = batch.data.lineObservationIds as string[];
  const linePaymentIds = (batch.data.linePaymentIds ||= []) as string[];
  if (lineIds.includes(observation.id)) return;
  observation.data.settlementBatchId = batch.id;
  // ING-05: a repeated settlement line for a Payment already in the batch is evidence, and adds nothing to the batch totals.
  if (linePaymentIds.includes(payment.id)) { observation.data.duplicateSettlementLine = true; return; }
  if (lineIds.length && currency !== currencyOf(batch)) { separateOtherCurrencyLine(state, ctx, batch, observation, payment.amountKobo); return; }
  // A collection is paid out once: a line for a payment another batch already counts is not counted again, and
  // Finance is asked about the second payout. An exception already open for the batch carries it (carryReport).
  const counted = lines.batchOf(payment.id);
  if (counted && counted.id !== batch.id) {
    observation.data.duplicateSettlementLine = true;
    observation.data.countedInBatchId = counted.id;
    reportLineCountedTwice(state, ctx, batch, observation, counted, payment);
    return;
  }
  if (!lineIds.length) takeLineCurrency(batch, currency, schedule);
  linePaymentIds.push(payment.id);
  lines.count(payment.id, batch);
  lineIds.push(observation.id);
  countLine(batch, observation, lineTotals(observation, payment, schedule), { grossKobo: 0, feeKobo: 0, expectedFeeKobo: 0 });
  touch(batch, ctx.now);
}

/** The condition a settlement line in another currency than its batch is reported with on the batch. */
const otherCurrencyLineCondition = (batchId: string, lineId: string): string => `settlement_variance:${batchId}:currency:${lineId}`;

/**
 * Decision on a settlement line in another currency than its batch: a batch
 * holds one currency, so the line is never added to its totals. It is linked to
 * the batch as evidence (settlementBatchId, and otherCurrencyLineIds on the
 * batch, which names its own currency from then on, as an earlier one may not),
 * marked otherCurrencyLine, and reported to Finance with a
 * settlement_variance exception of its own that names the batch, the line and
 * both currencies (condition settlement_variance:<batch>:currency:<line>; an
 * exception already open for the batch carries it, carryReport), which stays
 * open until Finance resolves it. Its payment, `amount` in the line's currency,
 * is reconciled as any payment is. `note` says what an earlier build did with it.
 */
function separateOtherCurrencyLine(state: DomainState, ctx: Context, batch: TypedRecord<"settlement-batches">, line: TypedRecord<"observations">, amount: number, note = ""): void {
  line.data.settlementBatchId = batch.id;
  line.data.otherCurrencyLine = true;
  batch.data.currency ||= currencyOf(batch);
  const ids = Array.isArray(batch.data.otherCurrencyLineIds) ? batch.data.otherCurrencyLineIds.map(String) : [];
  if (!ids.includes(line.id)) batch.data.otherCurrencyLineIds = [...ids, line.id];
  touch(batch, ctx.now); touch(line, ctx.now);
  const currency = currencyOf(line), condition = otherCurrencyLineCondition(batch.id, line.id);
  const notes = `Settlement line ${line.reference} (${moneyText(amount, currency)}) is in ${currency}, and settlement batch ${batch.reference} is in ${currencyOf(batch)}: a batch holds one currency, so the line is not counted in its totals.${note} Its payment is reconciled as any payment is. Check with the provider which batch pays it out, then resolve this exception.`;
  const raised = raiseException(state, ctx, "settlement_variance", { linkedRecordId: batch.id, amountKobo: amount, notes, condition, currency });
  if (isOpenException(raised.status)) carryReport(raised, ctx, condition, notes);
}

/** The condition a settlement line whose collection another batch already counts is reported with on its own batch. */
const lineCountedTwiceCondition = (batchId: string, lineId: string): string => `settlement_variance:${batchId}:line:${lineId}`;

/** Reports on its batch a settlement line whose collection batch `counted` already counts, for Finance to check both payouts. */
function reportLineCountedTwice(state: DomainState, ctx: Context, batch: TypedRecord<"settlement-batches">, line: TypedRecord<"observations">, counted: ValopayRecord, payment: TypedRecord<"payments">): void {
  const notes = `Settlement line ${line.reference} (${moneyText(payment.amountKobo, currencyOf(payment))}) is already counted in settlement batch ${counted.reference}: the provider reports the same collection in two batches. It is not counted again in ${batch.reference}. Check both payouts with the provider.`;
  const condition = lineCountedTwiceCondition(batch.id, line.id);
  const raised = raiseException(state, ctx, "settlement_variance", { linkedRecordId: batch.id, amountKobo: payment.amountKobo, notes, condition, currency: currencyOf(payment) });
  if (isOpenException(raised.status)) carryReport(raised, ctx, condition, notes);
}

/**
 * A report that a settlement line's collection is counted in another batch
 * stays with Finance until Finance resolves it: one an earlier build closed
 * with its batch's statement or fee variance, as its condition cleared, is
 * raised again at the next reconciliation. An earlier build carried the
 * report on the batch's open exception as a dated line only: while that
 * exception is open, it lists the report in countedTwice from now on, so it
 * stays open and its resolution settles the report (carryReport). Once
 * Finance resolved it, the resolution replaced those notes: a report that no
 * exception carries any more was settled by it, since every build raised the
 * report as it marked the line (countedInBatchId), and the platform's own
 * closing keeps the notes.
 */
function keepLinesCountedTwiceReported(state: DomainState, ctx: Context): void {
  for (const line of recordsOfKind(state, "observations")) {
    const batchId = line.data.settlementBatchId, countedIn = line.data.countedInBatchId;
    if (line.status !== "resolved" || typeof batchId !== "string" || typeof countedIn !== "string" || line.data.source !== "settlement") continue;
    const condition = lineCountedTwiceCondition(batchId, line.id);
    const reports = recordsWhere(state, "exceptions", "data.linkedRecordId", batchId).filter((item) => resolveExceptionType(item.data.type) === "settlement_variance"
      && (item.data.condition === condition || countedTwiceReports(item).includes(condition) || String(item.data.notes ?? "").includes(`Settlement line ${line.reference} (`)));
    // An earlier build's carrier holds the report as a dated line; one this build raised for another line names it in its own text.
    const listed = reports.some((item) => item.data.condition === condition || countedTwiceReports(item).includes(condition));
    const carrier = listed ? undefined : reports.find((item) => isOpenException(item.status) && String(item.data.notes ?? "").includes(`(WAT): Settlement line ${line.reference} (`));
    if (carrier) { carrier.data.countedTwice = [...countedTwiceReports(carrier), condition]; touch(carrier, ctx.now); }
    if (!reports.length || reports.some((item) => isOpenException(item.status) || item.data.resolutionCode !== conditionClearedCode)) continue;
    const batch = recordsWhere(state, "settlement-batches", "id", batchId)[0], counted = recordsWhere(state, "settlement-batches", "id", countedIn)[0];
    const payment = recordsWhere(state, "payments", "id", String(line.data.paymentId ?? ""))[0];
    if (batch && counted && payment) reportLineCountedTwice(state, ctx, batch, line, counted, payment);
  }
}

const STATEMENT_DIFFERS = "Statement credit differs from gross settlement lines less recorded fees.";
const STATEMENT_MATCHED = "Statement credit matched the settlement batch net total; it was not allocated to a customer.";

/**
 * ING-03 and ING-07: what a settlement batch's current lines and linked
 * statement credit show. It waits for its statement credit unless the fees
 * already differ from the schedule; it is reconciled when the credit equals the
 * net total and the fees are within tolerance, and a variance otherwise. The
 * condition names the state a settlement_variance exception is raised for;
 * `settledBy` is the other spelling earlier builds recorded for the same state.
 * `credits` is how many statement credits the linked total sums. Decision on
 * currencies: the fees of a batch in a currency with no fee schedule are not
 * checked, and its explanation says so, whatever its state; a statement credit
 * in another currency than the batch (statementOtherCurrencies) never matches
 * it, so while one names the batch it is in variance.
 */
export function settlementBatchState(batch: TypedRecord<"settlement-batches">, credits = 1): { status: "pending" | "reconciled" | "variance"; explanation?: string; condition?: string; settledBy?: string[] } {
  if (batch.data.providerIdentityReview) return { status: "variance", condition: `settlement_variance:${batch.id}:provider_identity`, explanation: "Historical settlement evidence mixes or conflicts with provider connections. Totals and prior links are preserved for Finance review and cannot certify a reconciled payout. An operator-reviewed repair using verified provider-scoped evidence is required; rerunning reconciliation or reimporting the same batch does not clear this hold." };
  const currency = currencyOf(batch), checked = hasFeeSchedule(currency);
  const net = Number(batch.data.netKobo || 0), variance = checked ? Number(batch.data.feeVarianceKobo || 0) : 0;
  const feesDiffer = Math.abs(variance) > SETTLEMENT_BATCH_TOLERANCE_KOBO;
  const unchecked = checked ? "" : ` Its fees were not checked, because there is no fee schedule for ${currency}.`;
  const feeText = `Provider fees of ${batch.data.feeKobo} kobo differ from the schedule's ${batch.data.expectedFeeKobo} kobo by ${variance} kobo.`;
  const feeCondition = `settlement_variance:${batch.id}:fees:${batch.data.feeKobo}:${batch.data.expectedFeeKobo}`;
  const others = Object.entries((batch.data.statementOtherCurrencies ?? {}) as Record<string, { count: number; amount: number }>).sort(([a], [b]) => (a < b ? -1 : 1));
  const otherCredits = others.reduce((sum, [, row]) => sum + row.count, 0);
  const otherText = otherCredits ? `${otherCredits === 1 ? "A statement credit" : `${otherCredits} statement credits`} of ${otherCurrenciesText(Object.fromEntries(others))} ${otherCredits === 1 ? "names" : "name"} the batch in another currency than its ${currency}, and a credit in another currency never matches its net total.` : "";
  const statement = typeof batch.data.statementObservationId === "string" && Number.isSafeInteger(batch.data.statementNetKobo) ? Number(batch.data.statementNetKobo) : null;
  if (statement === null && !otherCredits) return feesDiffer ? { status: "variance", explanation: feeText, condition: feeCondition } : { status: "pending", ...(unchecked ? { explanation: `It waits for its statement credit.${unchecked}` } : {}) };
  const statementCondition = `settlement_variance:${batch.id}:statement:${statement ?? "none"}:${batch.data.netKobo}:${batch.data.feeKobo}${others.map(([code, row]) => `:${code}=${row.amount}`).join("")}`;
  const differs = statement === null || statement === net ? "" : credits > 1 ? `The batch's ${credits} statement credits together differ from gross settlement lines less recorded fees.` : STATEMENT_DIFFERS;
  if (differs || otherCredits) return { status: "variance", explanation: [differs, otherText, feesDiffer ? feeText : ""].filter(Boolean).join(" ") + unchecked, condition: statementCondition };
  if (feesDiffer) return { status: "variance", explanation: feeText, condition: feeCondition, settledBy: [statementCondition] };
  return { status: "reconciled", explanation: STATEMENT_MATCHED + unchecked };
}

/** Why an open exception of a batch that left variance stays open: the reports it was raised for, or carries, that only Finance settles. */
function stillReported(exception: TypedRecord<"exceptions">): string {
  const [, , report] = String(exception.data.condition ?? "").split(":");
  const countedTwice = countedTwiceReports(exception).length > 0 || report === "line" || report === "counted", otherCurrency = otherCurrencyReports(exception).length > 0 || report === "currency";
  return `${countedTwice ? " It stays open for the collection the provider reports in two batches: resolve it once you have checked both payouts with the provider." : ""}${otherCurrency ? " It stays open for the settlement line in another currency than the batch: resolve it once you have checked with the provider which batch pays it out." : ""}`;
}

/**
 * Every batch is re-evaluated from its current totals at every reconciliation,
 * so a line imported after its statement credit matched, or an edit, moves it.
 * Only what changed is written. A variance is a settlement_variance exception,
 * never forced; an exception raised for an earlier state stays for Finance,
 * and its notes gain a dated line whenever the batch moves, so the text it was
 * raised with is not read as the batch's current state.
 * A collection is counted in its first batch (SettlementLines): a later batch
 * that lists it too, as an earlier build could leave it, counts it twice, and
 * raises a settlement_variance exception that names both batches, once per
 * collection counted again. Returns the number of batches in variance.
 * `credits` is how many statement credits each batch's linked total sums.
 */
function evaluateSettlementBatches(state: DomainState, ctx: Context, credits: ReadonlyMap<string, number>): number {
  let variances = 0;
  const countedIn = new Map<string, TypedRecord<"settlement-batches">>();
  for (const batch of recordsOf(state, "settlement-batches")) {
    let changed = false;
    // A batch edited by hand keeps its fee variance in step with its stated and expected fees, where they are checked.
    if (!batch.data.providerIdentityReview && feesChecked(batch) && Number.isSafeInteger(batch.data.feeKobo) && Number.isSafeInteger(batch.data.expectedFeeKobo)) {
      const variance = sumMoney([Number(batch.data.feeKobo), -Number(batch.data.expectedFeeKobo)]);
      if (batch.data.feeVarianceKobo !== variance) { batch.data.feeVarianceKobo = variance; changed = true; }
    }
    const next = settlementBatchState(batch, credits.get(batch.id));
    const previous = batch.status;
    const moved = previous !== next.status || (next.explanation !== undefined && batch.data.explanation !== next.explanation);
    if (previous !== next.status) { batch.status = next.status; changed = true; }
    if (next.explanation !== undefined && batch.data.explanation !== next.explanation) { batch.data.explanation = next.explanation; changed = true; }
    // Back to waiting for its statement credit: the variance explanation no longer applies.
    if (next.explanation === undefined && previous !== next.status && batch.data.explanation !== undefined) { delete batch.data.explanation; changed = true; }
    if (changed) touch(batch, ctx.now);
    // The exception raised for an earlier state stays open for Finance; a dated line says where the batch now stands, and
    // why one that reports a collection counted in two batches, or a line in another currency, stays open once the batch leaves variance.
    const open = moved ? recordsOf(state, "exceptions").find((item) => isOpenException(item.status) && item.data.linkedRecordId === batch.id && resolveExceptionType(item.data.type) === "settlement_variance") : undefined;
    if (open) {
      const current = `the batch is now ${next.status === "variance" ? "in variance" : next.status}. ${next.explanation ?? "Its fees are within the schedule and it waits for its statement credit."}${next.status !== "variance" ? stillReported(open) : ""}`;
      open.data.notes = `${open.data.notes ? `${open.data.notes}\n` : ""}Update on ${watDate(Date.parse(ctx.now))} (WAT): ${current}`;
      touch(open, ctx.now);
    }
    if (next.status === "variance") {
      raiseException(state, ctx, "settlement_variance", { linkedRecordId: batch.id, notes: next.explanation!, condition: next.condition, settledBy: next.settledBy });
      variances += 1;
    }
    for (const paymentId of Array.isArray(batch.data.linePaymentIds) ? batch.data.linePaymentIds.map(String) : []) {
      const first = countedIn.get(paymentId);
      if (!first) { countedIn.set(paymentId, batch); continue; }
      const payment = recordsWhere(state, "payments", "id", paymentId)[0];
      if (first.id === batch.id || !payment) continue;
      const notes = `Settlement batch ${batch.reference} counts payment ${payment.reference} (${moneyText(payment.amountKobo, currencyOf(payment))}), which settlement batch ${first.reference} already counts: the same collection is in both batches' totals. Check both payouts with the provider.`;
      const condition = `settlement_variance:${batch.id}:counted:${paymentId}`;
      const raised = raiseException(state, ctx, "settlement_variance", { linkedRecordId: batch.id, amountKobo: payment.amountKobo, notes, condition });
      // An exception already open for the batch carries it.
      if (isOpenException(raised.status)) carryReport(raised, ctx, condition, notes);
    }
  }
  return variances;
}

/**
 * ING-03 (3): a statement credit whose reference matches a settlement batch
 * resolves to the batch, never to a customer; the batch is evaluated
 * afterwards. Every credit that names a batch counts: statementNetKobo is
 * their sum and statementObservationId the first, so a second credit is
 * compared with the batch's net total rather than replacing the first. A
 * credit with the reference and amount of one already counted is the same
 * bank line delivered again and adds nothing. A batch linked before credits
 * were summed is brought to the sum at the next reconciliation. Decision on
 * currencies: a credit in another currency than the batch is linked to it and
 * marked otherCurrencyCredit, but never summed with its credits: the batch
 * lists such credits by currency (statementOtherCurrencies), and they never
 * match it (settlementBatchState). Returns how many credits were linked now and
 * how many each batch counts in its own currency.
 */
/** Money by currency code, as otherCurrencies lists it: how many records and their amount in that currency's minor unit; undefined for none. */
function inCurrencies(records: readonly ValopayRecord[]): Record<string, { count: number; amount: number }> | undefined {
  const rows = new Map<string, { count: number; amount: number }>();
  for (const record of records) { const row = rows.get(currencyOf(record)) ?? { count: 0, amount: 0 }; row.count += 1; row.amount = sumMoney([row.amount, record.amountKobo]); rows.set(currencyOf(record), row); }
  return rows.size ? Object.fromEntries([...rows].sort(([a], [b]) => (a < b ? -1 : 1))) : undefined;
}

function linkSettlementStatements(state: DomainState, ctx: Context): { linked: number; credits: Map<string, number> } {
  const statements = recordsOf(state, "observations").filter((item) => item.data.source === "statement" && item.data.batchReference && (item.status === "unresolved" || String(item.data.resolvedTo ?? "").startsWith("batch:")));
  const credits = new Map<string, number>();
  if (!statements.length) return { linked: 0, credits };
  const batches = new Map<string, TypedRecord<"settlement-batches">>(), byId = new Map<string, TypedRecord<"settlement-batches">>();
  for (const batch of recordsOf(state, "settlement-batches")) { if (!batch.data.providerIdentityReview) batches.set(batchIdentity(state, batch), batch); byId.set(batch.id, batch); }
  const linkedTo = new Map<string, TypedRecord<"observations">[]>();
  let linked = 0;
  for (const statement of statements) {
    const batch = statement.status === "unresolved" ? batches.get(settlementIdentity(state, statement, String(statement.data.batchReference))) : byId.get(String(statement.data.resolvedTo).slice("batch:".length));
    if (!batch || batch.data.providerIdentityReview || batchIdentity(state, batch) !== settlementIdentity(state, statement, String(statement.data.batchReference))) continue; // Its own provider's batch may arrive later; a same-named foreign payout never matches.
    if (statement.status === "unresolved") {
      statement.status = "resolved";
      statement.data.resolvedTo = `batch:${batch.id}`;
      statement.data.resolutionKey = "settlement_batch_net_credit";
      touch(statement, ctx.now);
      linked += 1;
    }
    linkedTo.set(batch.id, [...(linkedTo.get(batch.id) ?? []), statement]);
  }
  for (const [batchId, linkedCredits] of linkedTo) {
    const batch = byId.get(batchId)!, currency = currencyOf(batch);
    const counted: TypedRecord<"observations">[] = [], elsewhere: TypedRecord<"observations">[] = [];
    for (const credit of linkedCredits) {
      const foreign = currencyOf(credit) !== currency, distinct = foreign ? elsewhere : counted;
      const repeat = distinct.some((item) => item.reference === credit.reference && item.amountKobo === credit.amountKobo && currencyOf(item) === currencyOf(credit));
      if (repeat !== (credit.data.duplicateStatementCredit === true) || foreign !== (credit.data.otherCurrencyCredit === true)) {
        if (repeat) credit.data.duplicateStatementCredit = true; else delete credit.data.duplicateStatementCredit;
        if (foreign) credit.data.otherCurrencyCredit = true; else delete credit.data.otherCurrencyCredit;
        touch(credit, ctx.now);
      }
      if (!repeat) distinct.push(credit);
    }
    const total = sumMoney(counted.map((item) => item.amountKobo)), other = inCurrencies(elsewhere);
    credits.set(batchId, counted.length);
    if (!isDeepStrictEqual(batch.data.statementOtherCurrencies, other)) {
      if (other) batch.data.statementOtherCurrencies = other; else delete batch.data.statementOtherCurrencies;
      touch(batch, ctx.now);
    }
    if (!counted.length) {
      if (batch.data.statementObservationId !== undefined || batch.data.statementNetKobo !== undefined) { delete batch.data.statementObservationId; delete batch.data.statementNetKobo; touch(batch, ctx.now); }
    } else if (batch.data.statementObservationId !== counted[0]!.id || batch.data.statementNetKobo !== total) {
      batch.data.statementObservationId = counted[0]!.id;
      batch.data.statementNetKobo = total;
      touch(batch, ctx.now);
    }
  }
  return { linked, credits };
}

/**
 * Creates an allocation: a proposal for Finance when `confidence` is
 * probable, otherwise applied at once. A payment whose evidence named no payer
 * is applied only by Finance, with `payerReason`: that allocation identifies
 * the payer. A proposal for such a payment carries no customer until then.
 */
export function allocatePayment(
  state: DomainState,
  ctx: Context,
  payment: TypedRecord<"payments">,
  due: TypedRecord<"due-items">,
  amount: number,
  rule: string,
  confidence: "certain" | "probable" | "manual",
  automatic: boolean,
  explanation?: string,
  payerReason?: string,
): TypedRecord<"allocations"> {
  assertAllocationEligible(state, due);
  assertPaymentAllocatable(state, payment, amount);
  assertSamePayer(state, payment, due, confidence === "probable" ? undefined : { automatic, reason: payerReason });
  if (!Number.isInteger(amount) || amount <= 0 || amount > paymentUnappliedKobo(payment)) {
    throw new Error("Enter a positive whole number in kobo, no more than the payment has left to allocate.");
  }
  const remaining = outstanding(due);
  if (amount > remaining) throw new Error("This allocation exceeds the outstanding instalment balance. Enter a lower amount.");
  const allocation = makeRecord(state, "allocations", {
    name: `Allocation ${rule}`, status: "proposed",
    customerId: payment.customerId, amountKobo: amount, createdAt: ctx.now,
    data: { paymentId: payment.id, dueItemId: due.id, rule, confidence, automatic, explanation: explanation ?? `Matching rule ${rule} linked this payment to the instalment.`, reviewed: null },
  });
  if (confidence === "probable") {
    payment.status = "proposed";
    payment.data.proposedDueItemId = due.id;
    payment.data.proposedAmountKobo = amount;
  } else {
    applyConfirmedAllocation(state, ctx, allocation, payerReason);
  }
  touch(payment, ctx.now);
  return allocation;
}

/**
 * A payment is applied only to its payer's instalments. One whose evidence
 * named no payer is applied only by Finance with a reason, never by
 * automatic matching (`applied`; a proposal passes none), and not against an
 * instalment its own evidence says is another customer's.
 */
function assertSamePayer(state: DomainState, payment: TypedRecord<"payments">, due: TypedRecord<"due-items">, applied?: { automatic: boolean; reason?: string }): void {
  if (payment.customerId && payment.customerId !== due.customerId) {
    throw Object.assign(new Error(`Payment ${payment.reference} is from another customer than instalment ${due.reference}'s. Choose one of the payer's instalments.`), { status: 409 });
  }
  if (payment.customerId || !applied) return;
  if (applied.automatic || !applied.reason?.trim()) {
    throw Object.assign(new Error(`Payment ${payment.reference} names no payer. Automatic matching never applies it: Finance identifies the payer by allocating it to one of their instalments, with a reason.`), { status: 409 });
  }
  const linked = payment.data.dueItemId && payment.data.dueItemId !== due.id ? recordsOf(state, "due-items").find((item) => item.id === payment.data.dueItemId) : undefined;
  if (linked && linked.customerId !== due.customerId) throw Object.assign(new Error(`Payment ${payment.reference}'s evidence names instalment ${linked.reference} of another customer. Choose one of that customer's instalments, or review the evidence.`), { status: 409 });
}

/**
 * Whose instalments a manual allocation of a payment accepts, by the rules
 * that allocation applies (assertPaymentAllocatable and assertSamePayer): its
 * payer's; for a payment whose evidence named no payer, those of the customer
 * of the instalment its evidence names (`instalmentCustomer`, when that
 * instalment exists), or any customer's while it names none. Null when it takes
 * no allocation at all: it is in another currency than naira, its money went
 * back, or nothing of it is left to allocate. The allocation picker's list
 * applies it (`paymentId`).
 */
export function allocationPayer(payment: ValopayRecord, instalmentCustomer: string | undefined): { customerId?: string } | null {
  if (currencyOf(payment) !== "NGN" || paymentMoneyReturned(payment) || paymentUnappliedKobo(payment) <= 0) return null;
  if (payment.customerId) return { customerId: payment.customerId };
  return instalmentCustomer === undefined ? {} : { customerId: instalmentCustomer };
}

/**
 * Decision on evidence with no payer: Finance identifies the payer by applying
 * the payment to one of that customer's instalments. The payment takes the
 * customer in the same action, with who identified it, when, why and through
 * which allocation; a proposal of it for another customer is withdrawn.
 */
function identifyPayer(state: DomainState, ctx: Context, payment: TypedRecord<"payments">, due: TypedRecord<"due-items">, allocation: TypedRecord<"allocations">, reason: string): void {
  payment.customerId = due.customerId;
  payment.data.payerIdentification = { customerId: due.customerId, identifiedBy: ctx.actor, identifiedAt: ctx.now, reason: reason.trim(), dueItemId: due.id, allocationId: allocation.id };
  for (const proposal of recordsOf(state, "allocations").filter((item) => item.id !== allocation.id && item.status === "proposed" && item.data.paymentId === payment.id)) {
    if (recordsOf(state, "due-items").find((item) => item.id === proposal.data.dueItemId)?.customerId === due.customerId) continue;
    proposal.status = "superseded";
    proposal.data.supersededReason = "Superseded: Finance identified another customer as the payer.";
    touch(proposal, ctx.now);
  }
  touch(payment, ctx.now);
}

/**
 * Decision on a payer identified through a wrong match: once a precision
 * review (or a rejection) has taken the allocation that identified the payer
 * (payerIdentification.allocationId) out of use and nothing of the payment
 * stays applied, the identification is withdrawn. The payment has no payer
 * again, so Finance can apply it to its real payer's instalment, and the
 * withdrawn identification stays in payerIdentificationHistory with who
 * withdrew it, when and why. A proposal of the payment for that customer,
 * which rested on the identification, is withdrawn with it. A payer its
 * evidence named, one that evidence resolved to the payment since names (the
 * evidence confirms Finance's identification), or money that went back, keeps
 * its payer. Returns the customer the identification named, or undefined when
 * it stands.
 */
export function withdrawPayerIdentification(state: DomainState, ctx: Context, payment: TypedRecord<"payments">, reason: string): string | undefined {
  const identification = payment.data.payerIdentification;
  if (!identification || identification.customerId !== payment.customerId || paymentReturned(payment) || Number(payment.data.allocatedKobo || 0) > 0) return undefined;
  const allocations = recordsWhere(state, "allocations", "data.paymentId", payment.id);
  if (allocations.some((item) => item.status === "confirmed") || allocations.find((item) => item.id === identification.allocationId)?.status !== "superseded") return undefined;
  // Evidence of the payment that names the payer confirms it, whoever identified it first.
  if (recordsOf(state, "observations").some((item) => item.status === "resolved" && item.data.paymentId === payment.id && item.customerId === identification.customerId)) return undefined;
  const history = Array.isArray(payment.data.payerIdentificationHistory) ? payment.data.payerIdentificationHistory : [];
  payment.data.payerIdentificationHistory = [...history, { ...identification, withdrawnBy: ctx.actor, withdrawnAt: ctx.now, withdrawnReason: reason }];
  delete payment.data.payerIdentification;
  payment.customerId = "";
  touch(payment, ctx.now);
  const proposals = allocations.filter((item) => item.status === "proposed" && item.customerId === identification.customerId);
  for (const proposal of proposals) {
    proposal.status = "superseded";
    proposal.data.supersededReason = "Superseded: the payer Finance identified was withdrawn.";
    touch(proposal, ctx.now);
  }
  if (proposals.length) settlePaymentStatus(state, ctx, payment);
  return identification.customerId;
}

/**
 * Reversed or refunded money went back to the payer: no proposal, confirmation
 * or manual allocation may apply it. After a refund of part of a payment, such
 * as an overpayment's excess, only the money that stayed can be applied.
 * Instalments are owed in naira, so money in another currency is never applied.
 */
function assertPaymentAllocatable(state: DomainState, payment: TypedRecord<"payments">, amount: number): void {
  if (paymentNeedsReversalReview(state, payment)) throw Object.assign(new Error("This payment is held for renewed Finance review of an earlier reversal decision. Resolve that review and run reconciliation before allocating it."), { status: 409 });
  if (currencyOf(payment) !== "NGN") {
    throw Object.assign(new Error(`Payment ${payment.reference} is in ${currencyOf(payment)}. Instalments are owed in naira, so it cannot be applied to one. Record its refund or resolve it with Finance.`), { status: 409 });
  }
  if (paymentReturned(payment)) {
    const how = paymentReversed(payment) ? "reversed by the provider" : "refunded to the payer";
    throw Object.assign(new Error(`Payment ${payment.reference} was ${how}. Its money went back, so it cannot be allocated to an instalment.`), { status: 409 });
  }
  const refunded = paymentRefundedKobo(payment), left = paymentUnappliedKobo(payment);
  if (refunded > 0 && amount > left) {
    throw Object.assign(new Error(`Payment ${payment.reference} was refunded to the payer in part: ${nairaText(refunded)} went back, so ${left > 0 ? `only ${nairaText(left)} is` : "nothing is"} left to allocate to an instalment.`), { status: 409 });
  }
}

function assertAllocationEligible(state: DomainState, due: TypedRecord<'due-items'>): void {
  if (dueNeedsReversalReview(state, due)) throw Object.assign(new Error("This instalment is held for renewed Finance review of an earlier reversal decision. Resolve that review and run reconciliation before allocating a payment."), { status: 409 });
  if ((allocationClosedStatuses as readonly string[]).includes(due.status)) throw Object.assign(new Error('This instalment is cancelled, closed or in dispute. Refresh the queue and review its status before allocating a payment.'), { status: 409 });
}

/**
 * Applies an allocation. For a payment whose evidence named no payer,
 * `payerReason` is Finance's reason, and applying it identifies the payer.
 */
export function applyConfirmedAllocation(state: DomainState, ctx: Context, allocation: TypedRecord<"allocations">, payerReason?: string): void {
  const payment = recordById(state, String(allocation.data.paymentId), "payments");
  const due = recordById(state, String(allocation.data.dueItemId), "due-items");
  assertAllocationEligible(state, due);
  assertPaymentAllocatable(state, payment, allocation.amountKobo);
  assertSamePayer(state, payment, due, { automatic: allocation.data.automatic === true, reason: payerReason });
  if (allocation.status === "superseded") throw new Error("This allocation is no longer applied and cannot be confirmed. Review the payment to create a new match.");
  if (allocation.status === "confirmed") throw Object.assign(new Error("This allocation is already applied. Refresh the payment to see its current position."), { status: 409 });
  const amount = allocation.amountKobo;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > paymentUnappliedKobo(payment)) {
    throw new Error("This allocation is more than the payment has left to allocate. Refresh the payment and review the proposed amount.");
  }
  if (amount > outstanding(due)) throw Object.assign(new Error("The proposed allocation exceeds the instalment balance now outstanding. Refresh the queue and review the changed balances."), { status: 409 });
  if (!payment.customerId) identifyPayer(state, ctx, payment, due, allocation, payerReason!);
  allocation.customerId = payment.customerId;
  allocation.status = "confirmed";
  allocation.data.confirmedAt ||= ctx.now;
  paymentDimensions(payment);
  payment.data.allocatedKobo = sumMoney([Number(payment.data.allocatedKobo || 0), amount]);
  const remaining = Math.max(0, outstanding(due) - amount);
  due.data.outstandingKobo = remaining;
  due.status = remaining === 0 ? "paid" : "partially_paid";
  const unapplied = paymentUnappliedKobo(payment);
  if (unapplied === 0) payment.status = "allocated";
  else if (remaining === 0) {
    // 7.3: the excess is unapplied credit on the customer position and an exception; never auto-applied elsewhere.
    payment.status = "overpaid";
    raiseException(state, ctx, "overpayment", { linkedRecordId: payment.id, customerId: payment.customerId, amountKobo: unapplied, notes: `${unapplied} kobo remains unapplied after due item ${due.reference} was settled.` });
  } else payment.status = "partial";
  if (!payment.data.proposedDueItemId || payment.data.proposedDueItemId === due.id) { delete payment.data.proposedDueItemId; delete payment.data.proposedAmountKobo; }
  touch(allocation, ctx.now); touch(payment, ctx.now); touch(due, ctx.now);
  if (remaining === 0) cancelUnsentAttempts(state, due.id, ctx.now);
  // Another proposal on the same payment either still fits what is left or is superseded now.
  settlePaymentStatus(state, ctx, payment);
}

/** REC-09: a wrong automatic allocation is superseded and the due item and payment are reopened. */
export function supersedeAllocation(state: DomainState, ctx: Context, allocation: TypedRecord<"allocations">, reason: string): void {
  if (allocation.status !== "confirmed") {
    // A proposal applied nothing; its payment is re-derived so it does not stay "proposed" with no proposal.
    allocation.status = "superseded"; allocation.data.supersededReason ||= reason; touch(allocation, ctx.now);
    settlePaymentStatus(state, ctx, findRecord(state, String(allocation.data.paymentId), "payments"));
    return;
  }
  const payment = findRecord(state, String(allocation.data.paymentId), "payments");
  const due = findRecord(state, String(allocation.data.dueItemId), "due-items");
  allocation.status = "superseded";
  allocation.data.supersededReason = reason;
  payment.data.allocatedKobo = Math.max(0, Number(payment.data.allocatedKobo || 0) - allocation.amountKobo);
  const restored = Math.min(due.amountKobo, sumMoney([outstanding(due), allocation.amountKobo]));
  due.data.outstandingKobo = restored;
  settleDueStatus(state, ctx, due, true);
  touch(allocation, ctx.now); touch(due, ctx.now);
  settlePaymentStatus(state, ctx, payment);
}

/** Statuses a workflow sets rather than the balance: an edit, a repair or a returned allocation keeps them. */
const heldDueStatuses: readonly string[] = ["in_dispute", "cancelled", "closed"];

/** The status the balance alone gives an instalment: paid, part-paid, or else scheduled or in collection by its attempts. */
function balanceStatus(state: DomainState, due: TypedRecord<"due-items">): TypedRecord<"due-items">["status"] {
  const left = outstanding(due);
  if (left === 0) return "paid";
  if (left < due.amountKobo) return "partially_paid";
  if (due.status === "scheduled" || due.status === "in_collection") return due.status;
  return attemptsFor(state, due.id).length ? "in_collection" : "scheduled";
}

/**
 * The status an instalment's balance implies: paid with nothing outstanding,
 * part-paid while some but not all of it is paid, and otherwise scheduled or
 * in collection, by its attempts. A dispute, cancellation or closure is kept,
 * and so is a final failure while money is still owed, unless `reopenFinal`
 * (a superseded allocation gives the engine money to collect again).
 */
export function derivedDueStatus(state: DomainState, due: TypedRecord<"due-items">, reopenFinal = false): TypedRecord<"due-items">["status"] {
  if (heldDueStatuses.includes(due.status)) return due.status;
  if (due.status === "unpaid_final" && outstanding(due) > 0 && !reopenFinal) return "unpaid_final";
  return balanceStatus(state, due);
}

/**
 * Decision on leaving a dispute: a customer dispute resolved as not upheld,
 * or Finance's release with a reason, takes the instalment out of dispute.
 * Its status then follows its balance, as after any other change (paid,
 * part-paid, or scheduled or in collection by its attempts; the collections
 * queue reads overdue from the due date), and a paid one has its unsent
 * attempts cancelled. The release is recorded on the instalment with the
 * last counted attempt, whose disputed debit then does not freeze it again,
 * and each open dispute exception for it is closed as its condition cleared.
 * Returns those exceptions.
 */
export function releaseDispute(state: DomainState, ctx: Context, due: TypedRecord<"due-items">, release: { via: "not_upheld" | "finance_release"; reason: string; exceptionId?: string }): TypedRecord<"exceptions">[] {
  if (dueNeedsReversalReview(state, due)) throw Object.assign(new Error("Resolve the renewed reversal review and run reconciliation before releasing this instalment."), { status: 409 });
  if (due.status !== "in_dispute") throw Object.assign(new Error(`Instalment ${due.reference} is not in dispute, so there is nothing to release. Refresh it to see its current status.`), { status: 409 });
  const status = balanceStatus(state, due);
  due.status = status;
  if (status === "paid") cancelUnsentAttempts(state, due.id, ctx.now);
  due.data.disputeRelease = {
    via: release.via, releasedAt: ctx.now, releasedBy: ctx.actor, reason: release.reason, ...(release.exceptionId ? { exceptionId: release.exceptionId } : {}),
    attemptId: countedAttempts(state, due.id).at(-1)?.id ?? null, status, outstandingKobo: outstanding(due),
  };
  touch(due, ctx.now);
  const disputes = recordsOf(state, "exceptions").filter((item) => isOpenException(item.status) && item.data.linkedRecordId === due.id && resolveExceptionType(item.data.type) === "customer_dispute");
  disputes.forEach((item) => closeClearedException(item, ctx, `instalment ${due.reference} left dispute`));
  return disputes;
}

/** An instalment's status in words, for messages. */
export const dueStatusText = (status: string): string => ({ in_collection: "in collection", partially_paid: "part-paid", unpaid_final: "unpaid after its final attempt", in_dispute: "in dispute" } as Record<string, string>)[status] ?? status;

/**
 * Decision on reversals: money that went back after it was applied leaves its
 * instalment owing that amount again, in dispute, and a customer_dispute
 * exception names the reversal so someone owns the instalment. One already
 * open for it gains the reversal as a dated line and the amount now owed.
 */
function disputeReversal(state: DomainState, ctx: Context, due: TypedRecord<"due-items">, payment: TypedRecord<"payments">, appliedKobo: number, how: string): void {
  if (due.status !== "in_dispute") { due.status = "in_dispute"; touch(due, ctx.now); }
  const notes = `Payment ${payment.reference} (${nairaText(appliedKobo)} applied to instalment ${due.reference}) was reversed: ${how}. The instalment owes ${nairaText(outstanding(due))} again and is in dispute, so collection and allocation are paused. Find out why the money went back, then resolve this exception as not upheld to collect the instalment again, or ask Finance to release it from dispute with a reason.`;
  const exception = raiseException(state, ctx, "customer_dispute", { linkedRecordId: due.id, customerId: due.customerId, amountKobo: outstanding(due), notes });
  if (exception.data.notes === notes) return;
  exception.amountKobo = outstanding(due);
  noteUpdate(exception, ctx, notes);
}

/** Moves an instalment to the status its balance implies; a settled one has its unsent attempts cancelled. True when the status changed. */
export function settleDueStatus(state: DomainState, ctx: Context, due: TypedRecord<"due-items">, reopenFinal = false): boolean {
  const status = derivedDueStatus(state, due, reopenFinal);
  if (status === "paid") cancelUnsentAttempts(state, due.id, ctx.now);
  if (status === due.status) return false;
  due.status = status; touch(due, ctx.now);
  return true;
}

/**
 * An instalment edited through the record API. Its outstanding balance is
 * rebuilt from the confirmed allocations and its status follows that balance,
 * so a paid instalment whose amount rises is part-paid again and a part-paid
 * one reduced to what was paid is paid. The status is derived after
 * validation, which refuses a status set by the caller.
 */
export function amendDueItem(state: DomainState, ctx: Context, due: TypedRecord<"due-items">, input: TypedRecord<"due-items">): TypedRecord<"due-items"> {
  const allocated = sumMoney(recordsOf(state, "allocations").filter((item) => item.status === "confirmed" && item.data.dueItemId === due.id).map((item) => item.amountKobo));
  if (input.amountKobo < allocated) throw new Error("Due amount cannot be reduced below confirmed allocations.");
  for (const key of ["experimentId", "experimentArm", "firstFailureAt"] as const) {
    if (JSON.stringify(input.data[key]) !== JSON.stringify(due.data[key])) throw new Error("Experiment assignment is immutable.");
  }
  // The engine reads the release to leave a released disputed debit alone; compared by value, as jsonb reorders keys.
  if (!isDeepStrictEqual(input.data.disputeRelease, due.data.disputeRelease)) throw new Error("A release from dispute is recorded by its action and cannot be changed here.");
  input.data.outstandingKobo = input.amountKobo - allocated;
  // RET-10: an obligation amended after its first failure leaves the experiment's eligible set.
  if (input.amountKobo !== due.amountKobo || String(input.data.dueDate) !== String(due.data.dueDate)) input.data.amendedAt = ctx.now;
  validateRecord(state, ctx, "due-items", input, true);
  Object.assign(due, input);
  settleDueStatus(state, ctx, due);
  return due;
}

/** The reason a precision review records when it takes a match out of use; older records carry only this text. */
export const REVIEW_SUPERSESSION = "Precision audit marked this allocation wrong";

/** True when a precision review, not a reversal or a rejected proposal, took this allocation out of use. */
export function supersededByReview(allocation: TypedRecord<"allocations">): boolean {
  return allocation.status === "superseded" && (allocation.data.supersededByReview === true || String(allocation.data.supersededReason || "").startsWith(REVIEW_SUPERSESSION));
}

/**
 * REC-09: a match a review had marked wrong is reviewed as correct, so it is
 * applied again, provided the payment still holds that money and the
 * instalment still owes it, and the payment is not now recorded as another
 * customer's. Otherwise the verdict is refused, because a "correct" match
 * that is not applied would misstate the false-match rate. A payment whose
 * identified payer was withdrawn with the match has its payer identified
 * again by it, for the reviewer's reason.
 */
export function reinstateAllocation(state: DomainState, ctx: Context, allocation: TypedRecord<"allocations">, reason: string): void {
  const payment = findRecord(state, String(allocation.data.paymentId), "payments");
  const due = findRecord(state, String(allocation.data.dueItemId), "due-items");
  const left = paymentUnappliedKobo(payment);
  const blocker = paymentReturned(payment) ? `payment ${payment.reference} was ${paymentReversed(payment) ? "reversed" : "refunded"}`
    : ["cancelled", "closed", "in_dispute"].includes(due.status) ? `instalment ${due.reference} is ${due.status.replace(/_/g, " ")}`
    : payment.customerId && payment.customerId !== due.customerId ? `payment ${payment.reference} is now recorded as another customer's`
    : allocation.amountKobo > left ? `payment ${payment.reference} no longer has that much left to allocate`
    : allocation.amountKobo > outstanding(due) ? `instalment ${due.reference} no longer has that much outstanding`
    : null;
  if (blocker) throw Object.assign(new Error(`This match cannot be applied again because ${blocker}. Allocate the payment manually if it belongs to an instalment.`), { status: 409 });
  forgetRejectedMatch(payment, due.id);
  delete allocation.data.supersededReason; delete allocation.data.supersededByReview;
  allocation.data.reinstatedAt = ctx.now;
  allocation.status = "proposed"; // applyConfirmedAllocation applies an allocation that is not yet applied
  applyConfirmedAllocation(state, ctx, allocation, reason);
}

/**
 * Re-derives a payment's allocation status from its own records after a
 * proposal, allocation, refund or reversal changes it. A payment with money
 * applied is never "unallocated"; one whose money went back is "returned"; a
 * held possible duplicate keeps its hold. A proposal that no longer fits what
 * the payment has left is superseded here, rather than failing a later close.
 */
export function settlePaymentStatus(state: DomainState, ctx: Context, payment: TypedRecord<"payments">, reason = "Superseded: the proposal no longer fits what the payment has left."): void {
  paymentDimensions(payment);
  const allocated = Number(payment.data.allocatedKobo || 0);
  // What it still holds: a refund of part of it, such as an overpayment's excess, is not left to allocate.
  const left = paymentUnappliedKobo(payment);
  const returned = paymentReturned(payment);
  const proposals = recordsWhere(state, "allocations", "data.paymentId", payment.id).filter((item) => item.status === "proposed");
  for (const proposal of proposals) {
    if (!returned && proposal.amountKobo <= left) continue;
    proposal.status = "superseded";
    proposal.data.supersededReason = reason;
    touch(proposal, ctx.now);
  }
  const live = proposals.find((item) => item.status === "proposed");
  const previous = payment.status;
  if (previous === "possible_duplicate" && allocated === 0 && !returned) return;
  if (live) {
    payment.status = "proposed";
    payment.data.proposedDueItemId = String(live.data.dueItemId);
    payment.data.proposedAmountKobo = live.amountKobo;
  } else {
    delete payment.data.proposedDueItemId; delete payment.data.proposedAmountKobo;
    if (allocated === 0) payment.status = returned ? "returned" : "unallocated";
    // Refunded after part of it was applied: the rest went back, so what stayed is all applied.
    else if (left <= 0) payment.status = "allocated";
    else payment.status = previous === "overpaid" ? "overpaid" : "partial";
  }
  touch(payment, ctx.now);
}

/**
 * Records a refund made outside Valo Pay: it returns what the payment has not
 * applied, and data.refundedKobo keeps that amount for billing and reports. A
 * caller that returns applied money, such as the pay-by-bank refund, takes the
 * allocations off their instalments first, so the whole receipt is recorded.
 */
export function recordPaymentRefund(state: DomainState, ctx: Context, payment: TypedRecord<"payments">, reason: string): number {
  paymentDimensions(payment);
  const refundedKobo = Math.max(0, payment.amountKobo - Number(payment.data.allocatedKobo || 0));
  payment.data.refundStatus = "refunded";
  payment.data.refundedKobo = refundedKobo;
  touch(payment, ctx.now);
  // Its money went back: open proposals are withdrawn and the payment leaves the allocation queues.
  settlePaymentStatus(state, ctx, payment, reason);
  return refundedKobo;
}

/**
 * ING-05: Finance resolved a suspected duplicate as "distinct_payments": the
 * payment it held is money of its own. It leaves the hold now, and the rule
 * ladder matches it from the next reconciliation without holding it again for
 * the same reason. A confirmed duplicate stays held until its refund is
 * recorded. Evidence held because it conflicts with the payment its reference
 * names becomes a payment of its own at the next reconciliation instead
 * (canonicalPayment). Returns the payment released, if any.
 */
export function releaseDuplicateHold(state: DomainState, ctx: Context, exception: TypedRecord<"exceptions">): TypedRecord<"payments"> | undefined {
  if (exception.data.resolutionCode !== "distinct_payments") return undefined;
  const payment = recordsOf(state, "payments").find((item) => item.id === exception.data.linkedRecordId);
  if (!payment) return undefined;
  payment.data.duplicateReview = { exceptionId: exception.id, resolutionCode: "distinct_payments", reviewedBy: ctx.actor, reviewedAt: ctx.now };
  if (payment.status === "possible_duplicate") {
    payment.status = "unallocated";
    payment.data.explanation = "Finance resolved the suspected duplicate as a separate payment, so it is no longer held.";
    settlePaymentStatus(state, ctx, payment);
  }
  touch(payment, ctx.now);
  return payment;
}

/** Finance said this payment does not belong to the instalment: automatic matching never proposes the pair again. */
export function rememberRejectedMatch(payment: TypedRecord<"payments">, dueItemId: unknown): void {
  if (typeof dueItemId !== "string" || !dueItemId) return;
  const rejected = new Set(Array.isArray(payment.data.rejectedDueItemIds) ? payment.data.rejectedDueItemIds.map(String) : []);
  rejected.add(dueItemId);
  payment.data.rejectedDueItemIds = [...rejected].sort();
}

/** A reversed rejection: Finance now says the pair was right. */
export function forgetRejectedMatch(payment: TypedRecord<"payments">, dueItemId: unknown): void {
  if (!Array.isArray(payment.data.rejectedDueItemIds)) return;
  const kept = payment.data.rejectedDueItemIds.map(String).filter((id) => id !== dueItemId);
  if (kept.length) payment.data.rejectedDueItemIds = kept; else delete payment.data.rejectedDueItemIds;
}

const rejectedMatches = (payment: TypedRecord<"payments">): Set<string> => new Set(Array.isArray(payment.data.rejectedDueItemIds) ? payment.data.rejectedDueItemIds.map(String) : []);

/**
 * Payments whose status contradicts their records: "unallocated" with money
 * applied, "proposed" with no live proposal, money returned while still
 * waiting in an allocation queue, carrying a proposal, or shown as holding
 * unapplied money ("partial" or "overpaid" after a refund), or "returned"
 * while it holds money a refund of part of it did not return.
 */
function paymentsToSettle(state: DomainState): TypedRecord<"payments">[] {
  const proposed = new Set(recordsOf(state, "allocations").filter((item) => item.status === "proposed").map((item) => String(item.data.paymentId)));
  return recordsOf(state, "payments").filter((payment) => {
    if (paymentReturned(payment)) return ["unallocated", "proposed", "possible_duplicate", "partial", "overpaid"].includes(payment.status) || proposed.has(payment.id);
    if (payment.status === "returned") return true;
    if (payment.status === "unallocated") return Number(payment.data.allocatedKobo || 0) > 0 || proposed.has(payment.id);
    return payment.status === "proposed" && !proposed.has(payment.id);
  });
}

/**
 * A payment's money went back through a reversal, once: its confirmed
 * allocations are taken off their instalments, each of which owes that
 * amount again and is put in dispute with an exception (disputeReversal),
 * and the payment leaves every allocation queue. `reason` supersedes the
 * allocations and proposals; `how` says who reported the reversal.
 */
export function reversePayment(state: DomainState, ctx: Context, payment: TypedRecord<"payments">, reason = "Payment reversed by the provider.", how = "the provider reported it"): void {
  if (payment.data.reversalApplied) return;
  payment.data.reversalStatus = "reversed";
  payment.data.reversedAt = ctx.now;
  payment.data.reversalApplied = true;
  recordsOf(state, "allocations").filter((item) => item.data.paymentId === payment.id && item.status === "confirmed").forEach((allocation) => {
    const due = findRecord(state, String(allocation.data.dueItemId), "due-items");
    due.data.outstandingKobo = Math.min(due.amountKobo, sumMoney([outstanding(due), allocation.amountKobo]));
    allocation.status = "superseded";
    allocation.data.supersededReason = reason;
    touch(allocation, ctx.now); touch(due, ctx.now);
    disputeReversal(state, ctx, due, payment, allocation.amountKobo, how);
  });
  payment.data.allocatedKobo = 0;
  // Proposals on reversed money are superseded and the payment leaves every unallocated queue.
  settlePaymentStatus(state, ctx, payment, reason);
}

/** The gross evidence states: its stated gross, else its amount. A settlement line that states only what it paid out gives the least the gross can be. */
function statedGross(observation: TypedRecord<"observations">): { kobo: number; atLeast: boolean } {
  const stated = observation.data.grossAmountKobo;
  return stated !== undefined ? { kobo: Number(stated), atLeast: false } : { kobo: observation.amountKobo, atLeast: observation.data.source === "settlement" };
}

/**
 * ING-03 and ING-05: why evidence under a payment's key is someone else's
 * money rather than more evidence of that payment: it names another payer (or
 * the payment is already tied to another payer's instalment), it is in another
 * currency, or it states another gross amount. Undefined when it agrees. A
 * settlement line that states only what it paid out agrees with any gross at
 * least that large, and a gross completes a payment made from such a line,
 * whatever of it is applied, unless its money went back (a refund or a
 * reversal).
 */
function evidenceConflict(payment: TypedRecord<"payments">, observation: TypedRecord<"observations">, index: CanonicalPaymentIndex): string | undefined {
  const payer = observation.customerId;
  if (payer && payment.customerId && payer !== payment.customerId) return "it names another payer";
  if (payer && !payment.customerId && index.tiedPayers(payment).some((customerId) => customerId !== payer)) return "it names another payer than the instalment the payment is tied to";
  if (currencyOf(observation) !== currencyOf(payment)) return `it is in ${currencyOf(observation)} and the payment is in ${currencyOf(payment)}`;
  const { kobo, atLeast } = statedGross(observation);
  const agrees = atLeast ? kobo <= payment.amountKobo : kobo === payment.amountKobo || (payment.data.grossUnstated === true && kobo > payment.amountKobo && !paymentRefunded(payment) && !paymentReversed(payment));
  return agrees ? undefined : `it states ${moneyText(kobo, currencyOf(payment))}${atLeast ? " paid out" : ""} and the payment is ${moneyText(payment.amountKobo, currencyOf(payment))}`;
}

/** Evidence that reports a reversal of the payment it names. */
export const reportsReversal = (observation: TypedRecord<"observations">): boolean => observation.data.reversed === true || observation.data.reversalStatus === "reversed";

/**
 * Decision on evidence Finance must look at before it becomes a payment:
 * evidence that disagrees with the payment its key names (evidenceConflict),
 * or evidence through a connection where no payment has its reference while
 * another connection's payment does (a disputes or settlement report may spell
 * the connection another way). Neither is merged or dropped: the evidence
 * stays unresolved with a suspected_duplicate exception that names the
 * payment, and the connections when they differ, and says what each resolution
 * does. Evidence held only because of its connection (`connectionOnly`) can be
 * joined to that payment as more evidence of it (same_payment); any held
 * evidence can be set aside as not money (not_money). An open hold follows its
 * evidence: when the hold as it stands now differs from the condition its
 * exception records (the payment changed, or an earlier build recorded it
 * otherwise), the exception takes the current condition and a dated line says
 * where the hold now stands, so it offers the codes that apply now. Returns
 * that exception and the payment, or undefined when no payment has its
 * reference.
 */
function holdForReview(state: DomainState, ctx: Context, observation: TypedRecord<"observations">, candidates: TypedRecord<"payments">[], payments: CanonicalPaymentIndex, gross: number): { exception: TypedRecord<"exceptions">; other: TypedRecord<"payments">; connectionOnly: boolean } | undefined {
  const other = candidates[0] ?? payments.withReference(observation)[0];
  if (!other) return undefined;
  const ref = observation.reference, source = String(observation.data.source), reversal = reportsReversal(observation);
  const conflict = evidenceConflict(other, observation, payments), connectionOnly = !candidates.length && !conflict;
  const through = connectionOf(state, observation), otherThrough = connectionOf(state, other);
  const what = `${reversal ? "Reversal evidence" : "Payment evidence"} ${ref} (${source}, ${moneyText(gross, currencyOf(observation))})`;
  const lead = candidates.length
    ? `${what} shares its provider reference with payment ${other.reference}, but ${conflict}. It was not ${reversal ? "applied to" : "merged into"} that payment.`
    : `${what} came through ${through}, where no payment has its reference, but payment ${other.reference} was observed through ${otherThrough}${conflict ? `, and ${conflict}` : ""}. It was not ${reversal ? "applied to" : "merged into"} that payment, and no payment was made for it.`;
  const join = connectionOnly
    ? reversal
      ? ` Resolve this exception as the same payment if it reverses payment ${other.reference}: the next reconciliation applies it to that payment, which is reversed, and keys the payment under ${through} too.`
      : ` Resolve this exception as the same payment if it is more evidence of payment ${other.reference} under another spelling of its connection: the next reconciliation joins it to that payment and keys the payment under ${through} too, so later evidence through either finds it.`
    : "";
  // A reversal never becomes a payment of its own, which would only be reversed at once.
  const next = reversal
    ? `It reports a reversal, so no payment is made from it only to be reversed.${join} ${connectionOnly ? "Resolve it any other way" : "Resolve this exception"} once you have checked it, and the next reconciliation sets it aside: it then reverses nothing, whatever payment it later finds.`
    : `${join.trim()}${join ? " " : ""}Resolve ${join ? "it" : "this exception"} as not money if it records no money: the next reconciliation sets it aside and makes no payment from it, nor merges it into one. Resolve it as distinct payments if it is money of its own${candidates.length ? "" : ` through ${through}`}: the next reconciliation records it as a separate payment. Resolve it as a confirmed duplicate if the payer was charged twice: it is recorded as a separate payment held for its refund.`;
  const condition = heldEvidenceCondition(observation.id, other.id, connectionOnly);
  const exception = raiseException(state, ctx, "suspected_duplicate", { linkedRecordId: observation.id, customerId: observation.customerId, amountKobo: gross, notes: `${lead} ${next}`, condition });
  if (isOpenException(exception.status) && exception.data.condition !== condition) {
    exception.data.condition = condition;
    exception.data.notes = `${exception.data.notes ? `${exception.data.notes}\n` : ""}Update on ${watDate(Date.parse(ctx.now))} (WAT): the hold now stands as follows. ${lead} ${next}`;
    touch(exception, ctx.now);
  }
  return { exception, other, connectionOnly };
}

/**
 * Decision on the codes held evidence offers: an open hold is re-derived from
 * its evidence as it stands now (holdForReview) by every reconciliation,
 * before resolve_exception checks the code Finance chose, and after every
 * action that can change the payment a hold names. So same_payment is offered
 * and accepted only while the hold is for the connection alone, whatever
 * condition an earlier state or an earlier build recorded. `only` limits it to
 * one exception.
 */
export function refreshHeldEvidence(state: DomainState, ctx: Context, only?: TypedRecord<"exceptions">): void {
  const open = (only ? [only] : recordsOf(state, "exceptions")).filter((item) => isOpenException(item.status) && resolveExceptionType(item.data.type) === "suspected_duplicate" && heldEvidenceOf(item.data.condition));
  if (!open.length) return;
  indexedPass(state, () => {
    const payments = new CanonicalPaymentIndex(state);
    for (const exception of open) {
      const observation = recordsWhere(state, "observations", "id", String(exception.data.linkedRecordId))[0];
      if (!observation || observation.status !== "unresolved") continue;
      const candidates = payments.candidates(observation);
      const own = candidates.find((item) => !evidenceConflict(item, observation, payments));
      if (!own) { holdForReview(state, ctx, observation, candidates, payments, statedGross(observation).kobo); continue; }
      // Evidence that now agrees with a payment under its own key resolves to it at the next reconciliation; until then the
      // join its exception offers stands only while it still agrees with the payment the exception names.
      const held = heldEvidenceOf(exception.data.condition)!, named = payments.payment(held.paymentId);
      const conflict = named ? evidenceConflict(named, observation, payments) : "that payment is no longer recorded";
      if (!held.connectionOnly || !conflict) continue;
      exception.data.condition = heldEvidenceCondition(observation.id, held.paymentId, false);
      exception.data.notes = `${exception.data.notes ? `${exception.data.notes}\n` : ""}Update on ${watDate(Date.parse(ctx.now))} (WAT): the hold now stands as follows. Payment evidence ${observation.reference} no longer agrees with payment ${named?.reference ?? observation.reference}: ${conflict}, so it cannot be joined to it. The next reconciliation resolves it to payment ${own.reference}, which has its reference through ${connectionOf(state, own)}, unless you resolve this exception first.`;
      touch(exception, ctx.now);
    }
  });
}

/**
 * Decision on a reversal reported for a payment no connection has seen: it is
 * never made a payment only to be reversed. It stays unresolved, waiting for
 * its payment: the reconciliation that sees a payment with its reference
 * applies it through its key, or holds it for Finance when that payment came
 * through another connection. Once it has waited UNSEEN_REVERSAL_AGE_MS since
 * the time its evidence gives, a Finance-owned provider_status_mismatch
 * exception says the provider reported a reversal of a payment the platform
 * has not seen, and what each resolution does (financeDecision).
 */
function awaitReversedPayment(state: DomainState, ctx: Context, observation: TypedRecord<"observations">, gross: number): void {
  // The time its evidence gives, else when it was recorded; a time that does not read as one never stops the close.
  const since = [observation.data.occurredAt, observation.createdAt].map((value) => Date.parse(String(value))).find(Number.isFinite) ?? Date.parse(ctx.now);
  if (Date.parse(ctx.now) - since < UNSEEN_REVERSAL_AGE_MS) return;
  const received = new Date(since + WAT_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");
  raiseException(state, ctx, "provider_status_mismatch", {
    linkedRecordId: observation.id, customerId: observation.customerId, amountKobo: gross, owner: "Finance", linkedKind: "observations", condition: unseenReversalCondition(observation.id),
    notes: `The provider reported a reversal of payment ${observation.reference} (${String(observation.data.source)}, ${moneyText(gross, currencyOf(observation))}) through ${connectionOf(state, observation)} at ${received} WAT, but no payment with that reference has been seen through any connection, so there is nothing to reverse. No payment is made from it only to be reversed: it waits for its payment, and the reconciliation that sees that payment reverses it through the same connection, or holds it for you when the payment came through another. Check with the provider which collection it reverses. Leave this exception open while you check: if the payment arrives meanwhile, the reversal applies to it as above and this exception closes. Resolve it as platform state confirmed if the provider says it reverses nothing of this lender's: the next reconciliation sets the reversal aside, and it reverses nothing, even if its payment arrives later. Resolve it as provider state adopted if the provider confirms the reversal: it keeps waiting for its payment with no new exception, and the reconciliation that records that payment reverses it, whichever spelling of the connection the payment comes through.`,
  });
}

/** Held evidence Finance resolved without making it a payment: it is resolved to its exception, never to a payment. */
function setAside(ctx: Context, observation: TypedRecord<"observations">, exception: TypedRecord<"exceptions">, resolutionKey: string): void {
  observation.status = "resolved";
  observation.data.resolvedTo = `exception:${exception.id}`;
  observation.data.resolutionKey = resolutionKey;
  touch(observation, ctx.now);
}

/** What Finance's resolution of evidence decides for it (financeDecision). */
interface FinanceDecision {
  exception: TypedRecord<"exceptions">;
  /** Earlier builds assigned conflicting meanings to unversioned decisions. Neither meaning is safe to infer. */
  needsReview?: boolean;
  /** Set aside for good: no payment is made from it, and it is applied to none. */
  setAside?: boolean;
  /** The payment its hold named, while the evidence still agrees with it: it is joined to that payment. */
  join?: TypedRecord<"payments">;
  /** A payment of its own. */
  separate?: { paymentId: string; exceptionId: string; resolutionCode: string };
  /** A reversal Finance adopted: it keeps waiting, and reverses its payment through any spelling of the connection. */
  adopted?: boolean;
}

/** Several releases omitted the marker, so absence cannot identify a historical rule. */
const earlierResolution = (exception: TypedRecord<"exceptions">): boolean => exception.data.resolutionRuleVersion === undefined;

/**
 * What one resolved exception of a piece of evidence decides for it (see
 * financeDecision). `other` is the payment a hold names when its exception
 * records no held-evidence condition, as one written by hand may not.
 */
function decisionOf(exception: TypedRecord<"exceptions">, observation: TypedRecord<"observations">, payments: CanonicalPaymentIndex, other?: TypedRecord<"payments">): FinanceDecision {
  const code = String(exception.data.resolutionCode);
  if (resolveExceptionType(exception.data.type) === "provider_status_mismatch") return earlierResolution(exception) ? { exception, needsReview: true } : code === unseenReversalCodes.setAside ? { exception, setAside: true } : { exception, adopted: code === unseenReversalCodes.adopted };
  const paymentId = heldEvidenceOf(exception.data.condition)?.paymentId ?? other?.id ?? "", named = payments.payment(paymentId);
  if (code === heldEvidenceCodes.samePayment) return { exception, join: named && !evidenceConflict(named, observation, payments) ? named : undefined };
  if (reportsReversal(observation) || code === heldEvidenceCodes.notMoney) return { exception, setAside: true };
  return { exception, separate: { paymentId, exceptionId: exception.id, resolutionCode: code } };
}

/**
 * Decision on a Finance resolution already recorded for evidence: its latest
 * resolution, of a suspected_duplicate that held it or of the
 * provider_status_mismatch raised while its reversal waited for a payment no
 * connection had seen, decides what happens to it before any payment is looked
 * up, whatever order and pass the evidence and its payment arrive in. Held
 * evidence resolved as the same payment joins the payment its exception names
 * only while the hold is still for the connection alone, the evidence agreeing
 * with that payment; otherwise it is looked at afresh, and held again. Resolved
 * as not money it is set aside for good, and resolved any other way it becomes
 * a payment of its own, except evidence of a reversal, which is set aside. A
 * waiting reversal resolved as platform state confirmed is set aside for good;
 * resolved as provider state adopted it keeps waiting, with no new exception,
 * and reverses its payment when that arrives, through any spelling of the
 * connection. An unversioned resolution has ambiguous historical meaning and
 * requires a new explicit review; the old decision remains unchanged. Undefined when
 * Finance has resolved neither.
 */
function financeDecision(state: DomainState, observation: TypedRecord<"observations">, payments: CanonicalPaymentIndex): FinanceDecision | undefined {
  const latest = latestEvidenceResolution(state, observation);
  return latest && decisionOf(latest, observation, payments);
}

/** Quarantine ambiguous persisted decisions without rewriting either the decision or its previous disposition. */
function reviewEarlierReversalDecisions(state: DomainState, ctx: Context): TypedRecord<"exceptions">[] {
  const payments = new CanonicalPaymentIndex(state);
  for (const observation of recordsOf(state, "observations").filter(reportsReversal)) {
    const decision = financeDecision(state, observation, payments);
    if (!decision?.needsReview) continue;
    const condition = `${unseenReversalCondition(observation.id)}:review:${decision.exception.id}`;
    let review = recordsWhere(state, "exceptions", "data.linkedRecordId", observation.id).find((item) => item.data.condition === condition);
    if (review) continue;
    const notes = `Earlier decision ${decision.exception.id} recorded ${decision.exception.data.resolutionCode} without a rule version. Releases used different meanings for that code, so Valo Pay cannot infer whether reversal ${observation.reference} should be adopted or set aside. Its earlier decision and evidence disposition are preserved. Finance must check the provider evidence and record a new explicit decision: provider state adopted applies the reversal to its payment; platform state confirmed sets unprocessed reversal evidence aside. Existing allocations and previously applied reversals are not changed until reviewed. Related payments cannot receive new allocations and related instalments are paused. After reconciliation, review any historical effects and release the instalments explicitly.`;
    // Do not let an old resolution without a condition suppress this new review.
    review = recordsWhere(state, "exceptions", "data.linkedRecordId", observation.id).find((item) => isOpenException(item.status) && resolveExceptionType(item.data.type) === "provider_status_mismatch")
      ?? makeRecord(state, "exceptions", { name: "Review earlier reversal decision", status: "open", customerId: observation.customerId, amountKobo: statedGross(observation).kobo, createdAt: ctx.now, data: { type: "provider_status_mismatch", owner: "Finance", severity: "high", slaBusinessDays: 1, dueBy: addBusinessDays(state, ctx.now, 1), linkedRecordId: observation.id, linkedKind: "observations", ...(currencyOf(observation) !== "NGN" ? { currency: currencyOf(observation) } : {}) } });
    Object.assign(review.data, { condition, notes, owner: "Finance", severity: "high", legacyResolutionReview: {
      priorExceptionId: decision.exception.id,
      priorObservation: { status: observation.status, resolutionKey: observation.data.resolutionKey ?? null, resolvedTo: observation.data.resolvedTo ?? null, paymentId: observation.data.paymentId ?? null },
    } });
    touch(review, ctx.now);
  }
  const reviews = recordsOf(state, "exceptions").filter((item) => item.data.legacyResolutionReview);
  for (const review of reviews.filter((item) => !isOpenException(item.status) && !earlierResolution(item))) {
    const observation = recordsWhere(state, "observations", "id", String(review.data.linkedRecordId))[0];
    // A prior applied reversal is historical financial activity, never silently undone. An earlier set-aside
    // disposition may be reconsidered only by this newly authorised decision; its snapshot stays on the review.
    if (!observation || observation.data.paymentId || observation.data.legacyReversalReviewAppliedId === review.id) continue;
    observation.status = "unresolved";
    observation.data.legacyReversalReviewAppliedId = review.id;
    touch(observation, ctx.now);
  }
  return reviews;
}

/** A hold does not undo allocations. It prevents new applications/collections until the explicit review completes. */
function holdEarlierReversalPayments(state: DomainState, ctx: Context, reviews: readonly TypedRecord<"exceptions">[]): void {
  if (!reviews.length) return;
  const active = reviews.filter((item) => isOpenException(item.status));
  const byReference = new Map<string, string[]>();
  for (const review of active) {
    const observation = recordsWhere(state, "observations", "id", String(review.data.linkedRecordId))[0];
    if (observation) byReference.set(observation.reference, [...(byReference.get(observation.reference) ?? []), review.id]);
  }
  const dueHolds = new Map<string, Set<string>>();
  for (const payment of recordsOf(state, "payments")) {
    const ids = [...new Set([...(byReference.get(payment.reference) ?? []), ...(byReference.get(String(payment.data.providerReference)) ?? [])])].sort();
    if (!isDeepStrictEqual(payment.data.legacyReversalReviewIds ?? [], ids)) {
      if (ids.length) payment.data.legacyReversalReviewIds = ids; else delete payment.data.legacyReversalReviewIds;
      touch(payment, ctx.now);
    }
    if (!ids.length) continue;
    const dues = new Set(recordsWhere(state, "allocations", "data.paymentId", payment.id).map((item) => String(item.data.dueItemId)));
    if (payment.data.dueItemId) dues.add(String(payment.data.dueItemId));
    if (payment.data.proposedDueItemId) dues.add(String(payment.data.proposedDueItemId));
    const intended = intendedDueItem(state, payment);
    if (intended) dues.add(intended.due.id);
    for (const id of dues) dueHolds.set(id, new Set([...(dueHolds.get(id) ?? []), ...ids]));
  }
  // A reversal can name an instalment/attempt before its receipt arrives.
  for (const review of active) {
    const observation = recordsWhere(state, "observations", "id", String(review.data.linkedRecordId))[0];
    if (!observation) continue;
    const ids = [observation.data.dueItemId, ...recordsOf(state, "attempts").filter((item) => item.data.providerReference === observation.reference || item.reference === observation.reference).map((item) => item.data.dueItemId)];
    for (const id of ids.filter((id): id is string => typeof id === "string" && !!id)) dueHolds.set(id, new Set([...(dueHolds.get(id) ?? []), review.id]));
  }
  for (const due of recordsOf(state, "due-items")) {
    const ids = [...(dueHolds.get(due.id) ?? [])].sort();
    if (!isDeepStrictEqual(due.data.legacyReversalReviewIds ?? [], ids)) {
      if (ids.length) due.data.legacyReversalReviewIds = ids; else delete due.data.legacyReversalReviewIds;
      touch(due, ctx.now);
    }
    if (ids.length && !["cancelled", "closed", "in_dispute"].includes(due.status)) { due.status = "in_dispute"; touch(due, ctx.now); }
  }
}

/**
 * ING-03: every observation resolves to one canonical Payment by its key, the
 * provider connection and reference, so the same reference through another
 * connection is another payment once Finance says so; the batch leg of a
 * statement never becomes a customer Payment. A resolution Finance has
 * recorded for the evidence decides first (financeDecision). Evidence Finance
 * must look at (holdForReview) stays unresolved with a suspected_duplicate
 * exception until Finance resolves it, and a reversal of a payment no
 * connection has seen waits for it (awaitReversedPayment).
 */
function canonicalPayment(state: DomainState, ctx: Context, observation: TypedRecord<"observations">, payments: CanonicalPaymentIndex, lines: SettlementLines): TypedRecord<"payments"> | undefined {
  const source = String(observation.data.source);
  const ref = observation.reference;
  if (source === "statement" && (observation.data.batchReference || observation.data.resolutionKey === "batch")) return undefined;
  const { kobo: gross, atLeast } = statedGross(observation);
  const reversal = reportsReversal(observation);
  let decision = financeDecision(state, observation, payments), prior: TypedRecord<"payments"> | undefined, key: string | undefined;
  if (decision?.needsReview) return undefined;
  if (!decision?.setAside && !decision?.join && !decision?.separate) {
    const candidates = payments.candidates(observation);
    prior = candidates.find((item) => !evidenceConflict(item, observation, payments));
    // A reversal Finance adopted reverses its payment through another spelling of the connection too, with no hold.
    const named = !prior && !candidates.length && decision?.adopted ? payments.withReference(observation)[0] : undefined;
    if (named && !evidenceConflict(named, observation, payments)) { prior = named; key = "adopted_after_review"; }
    decision = undefined;
    if (!prior) {
      const held = holdForReview(state, ctx, observation, candidates, payments, gross);
      if (!held && reversal) { awaitReversedPayment(state, ctx, observation, gross); return undefined; }
      if (held && isOpenException(held.exception.status)) return undefined;
      // An earlier resolution of this very hold stands where the latest one no longer applies.
      if (held) decision = decisionOf(held.exception, observation, payments, held.other);
      if (decision && !decision.setAside && !decision.join && !decision.separate) return undefined;
    }
  }
  if (decision?.setAside) {
    setAside(ctx, observation, decision.exception, reversal ? "reversal_set_aside_after_review" : "set_aside_after_review");
    return undefined;
  }
  if (decision?.join) { prior = decision.join; key = "joined_after_review"; }
  const separate = decision?.separate;
  // Evidence Finance joined to a payment keys it under the evidence's connection too, so later evidence through either finds it.
  if (prior && key) payments.addConnection(prior, connectionOf(state, observation));
  const observedAt = String(observation.data.occurredAt || observation.createdAt);
  const payment = prior || makeRecord(state, "payments", {
    name: "Canonical payment", status: "unallocated", reference: ref, customerId: observation.customerId, createdAt: ctx.now,
    amountKobo: gross,
    data: {
      providerReference: ref, providerConnection: connectionOf(state, observation), currency: currencyOf(observation), channel: channelFor(source),
      narration: observation.data.narration, virtualAccountCustomerId: observation.data.virtualAccountCustomerId, dueItemId: observation.data.dueItemId,
      observedAt, collectionStatus: source === "webhook" ? "succeeded" : "received", settlementStatus: "unsettled", reversalStatus: "none", refundStatus: "none",
      allocatedKobo: 0, canonical: true, ...(atLeast ? { grossUnstated: true } : {}), ...(separate ? { evidenceConflict: separate } : {}),
    },
  });
  if (!prior) payments.add(payment);
  if (separate?.resolutionCode === "confirmed_duplicate_refund") {
    payment.status = "possible_duplicate";
    payment.data.explanation = `Finance confirmed this evidence duplicates payment ${payments.payment(separate.paymentId)?.reference ?? ref}; it is held until its refund is recorded.`;
  }
  paymentDimensions(payment);
  // A settlement line's net made this payment; the debit's own gross completes it. What the gross adds to money
  // already applied is unapplied money for Finance, so the payment's status follows it.
  if (prior && !atLeast && payment.data.grossUnstated === true) {
    const previous = payment.amountKobo, raised = gross > previous;
    payment.amountKobo = Math.max(previous, gross); delete payment.data.grossUnstated;
    if (raised && Number(payment.data.allocatedKobo || 0) > 0) settlePaymentStatus(state, ctx, payment);
    completeLineGross(state, ctx, payment, previous, lines);
  }
  if (!payment.data.observedAt || Date.parse(observedAt) < Date.parse(String(payment.data.observedAt))) payment.data.observedAt = observedAt;
  if (!payment.customerId && observation.customerId) payment.customerId = observation.customerId;
  // The instalment evidence names is kept only while it is the payer's.
  if (!payment.data.dueItemId && observation.data.dueItemId && (!payment.customerId || payments.dueCustomer(observation.data.dueItemId) === payment.customerId)) payment.data.dueItemId = observation.data.dueItemId;
  if (observation.data.narration) payment.data.narration = observation.data.narration;
  if (observation.data.virtualAccountCustomerId) payment.data.virtualAccountCustomerId = observation.data.virtualAccountCustomerId;
  if (source === "webhook") payment.data.collectionStatus = "succeeded";
  if (source === "settlement") {
    payment.data.settlementStatus = "settled";
    payment.data.settledAt ||= observedAt;
    // A settlement line pays out a debit that was collected, so it succeeded even when its webhook never arrived.
    if (payment.data.channel === "direct_debit" && payment.data.collectionStatus !== "failed") payment.data.collectionStatus = "succeeded";
    settlementBatch(state, ctx, observation, payment, lines);
  }
  if (reversal) reversePayment(state, ctx, payment);
  observation.status = "resolved";
  observation.data.paymentId = payment.id;
  observation.data.resolutionKey = key ?? (prior ? "canonical_provider_reference" : separate ? "separate_payment_after_review" : "new_canonical_provider_reference");
  touch(observation, ctx.now); touch(payment, ctx.now);
  return payment;
}

/**
 * Canonical payments by their key, the provider connection and a reference
 * (the payment's reference or its provider reference). Lookups keep the
 * first-record-wins semantics across colliding keys, including legacy rows. A
 * key holds more than one payment once Finance has said conflicting evidence
 * is money of its own. New payments are registered as they are made, so
 * repeated evidence in one run resolves to one payment. A payment is also
 * keyed on the connections of the evidence resolved to it: an earlier build
 * keyed a payment on its evidence's provider (or the lender's), whatever
 * connection the evidence named, and Finance may join evidence through
 * another connection to a payment (same_payment), so later evidence through
 * that connection still finds it.
 */
class CanonicalPaymentIndex {
  private byKey = new Map<string, TypedRecord<"payments">[]>();
  private byReference = new Map<string, TypedRecord<"payments">[]>();
  private byId = new Map<string, TypedRecord<"payments">>();
  private order = new Map<string, number>();
  private dues?: Map<string, TypedRecord<"due-items">>;
  constructor(private state: DomainState) {
    const evidenceConnections = new Map<string, Set<string>>();
    for (const observation of recordsOfKind(state, "observations")) {
      if (observation.status !== "resolved" || typeof observation.data.paymentId !== "string") continue;
      const connections = evidenceConnections.get(observation.data.paymentId) ?? new Set<string>();
      evidenceConnections.set(observation.data.paymentId, connections.add(connectionKey(connectionOf(state, observation))));
    }
    for (const payment of recordsOf(state, "payments")) this.add(payment, evidenceConnections.get(payment.id));
  }
  private key(connection: string, reference: unknown) { return `${connectionKey(connection)}\u0000${String(reference)}`; }
  add(payment: TypedRecord<"payments">, evidenceConnections: Iterable<string> = []) {
    this.order.set(payment.id, this.order.size);
    this.byId.set(payment.id, payment);
    const connections = new Set([connectionKey(connectionOf(this.state, payment)), ...evidenceConnections]);
    for (const reference of new Set([payment.reference, payment.data.providerReference].filter(Boolean))) {
      for (const connection of connections) {
        const key = this.key(connection, reference);
        this.byKey.set(key, [...(this.byKey.get(key) ?? []), payment]);
      }
      this.byReference.set(String(reference), [...(this.byReference.get(String(reference)) ?? []), payment]);
    }
  }
  /** Keys a payment under another connection too, once Finance joined evidence through it to the payment, so later evidence in this pass finds it. */
  addConnection(payment: TypedRecord<"payments">, connection: string) {
    for (const reference of new Set([payment.reference, payment.data.providerReference].filter(Boolean))) {
      const key = this.key(connection, reference), group = this.byKey.get(key) ?? [];
      if (!group.includes(payment)) this.byKey.set(key, [...group, payment]);
    }
  }
  /** The payments an observation's key names, with one it names by id, first made first. */
  candidates(observation: TypedRecord<"observations">): TypedRecord<"payments">[] {
    const named = this.byId.get(String(observation.data.paymentId));
    const group = this.byKey.get(this.key(connectionOf(this.state, observation), observation.reference)) ?? [];
    return [...new Set(named ? [named, ...group] : group)].sort((a, b) => this.order.get(a.id)! - this.order.get(b.id)!);
  }
  /** The payments with an observation's reference under any connection, first made first: for evidence its own key finds none of, the ones another connection holds. */
  withReference(observation: TypedRecord<"observations">): TypedRecord<"payments">[] {
    if (!observation.reference) return [];
    return [...new Set(this.byReference.get(observation.reference) ?? [])].sort((a, b) => this.order.get(a.id)! - this.order.get(b.id)!);
  }
  /** A payment by id. */
  payment(id: string): TypedRecord<"payments"> | undefined { return this.byId.get(id); }
  /** The customer of an instalment, by id. */
  dueCustomer(id: unknown): string | undefined {
    this.dues ??= new Map(recordsOf(this.state, "due-items").map((due) => [due.id, due]));
    return this.dues.get(String(id))?.customerId;
  }
  /** The payers of the instalments a payment with no payer is tied to: the one its evidence names and the one it is proposed for. */
  tiedPayers(payment: TypedRecord<"payments">): string[] {
    return [payment.data.dueItemId, payment.data.proposedDueItemId].map((id) => (id ? this.dueCustomer(id) : undefined)).filter((customerId): customerId is string => !!customerId);
  }
}

/** Which settlement batch counts each payment's line, across every batch, so a collection is counted in one payout only. */
class SettlementLines {
  private counted = new Map<string, TypedRecord<"settlement-batches">>();
  constructor(state: DomainState) {
    for (const batch of recordsOf(state, "settlement-batches")) {
      for (const id of Array.isArray(batch.data.linePaymentIds) ? batch.data.linePaymentIds.map(String) : []) if (!this.counted.has(id)) this.counted.set(id, batch);
    }
  }
  batchOf(paymentId: string) { return this.counted.get(paymentId); }
  count(paymentId: string, batch: TypedRecord<"settlement-batches">) { if (!this.counted.has(paymentId)) this.counted.set(paymentId, batch); }
}

/** Built after canonicalisation; records are live references so later payments
 * see earlier allocations/duplicate holds. No lookup survives a reconcile call. */
class MatchIndex {
  attempts = new Map<string, TypedRecord<"attempts">>();
  dues = new Map<string, TypedRecord<"due-items">>();
  duesByCustomer = new Map<string, TypedRecord<"due-items">[]>();
  paymentsByCustomer = new Map<string, TypedRecord<"payments">[]>();
  /** Every instalment of the lender by its reference's words (referenceWords), and the most words a reference has. */
  duesByReference = new Map<string, TypedRecord<"due-items">[]>();
  longestReference = 0;
  constructor(state: DomainState) {
    for (const attempt of recordsOf(state, "attempts")) {
      const key = attempt.data.providerReference || attempt.reference;
      if (key && !this.attempts.has(key)) this.attempts.set(key, attempt);
    }
    for (const due of recordsOf(state, "due-items")) {
      this.dues.set(due.id, due);
      const group = this.duesByCustomer.get(due.customerId) ?? [];
      group.push(due); this.duesByCustomer.set(due.customerId, group);
      const words = referenceWords(due.reference);
      if (!words.length) continue;
      this.duesByReference.set(words.join(" "), [...(this.duesByReference.get(words.join(" ")) ?? []), due]);
      this.longestReference = Math.max(this.longestReference, words.length);
    }
    for (const payment of recordsOf(state, "payments")) {
      const group = this.paymentsByCustomer.get(payment.customerId) ?? [];
      group.push(payment); this.paymentsByCustomer.set(payment.customerId, group);
    }
  }
}

/** A reference or narration as its words: letters and digits, lower case, split at anything else, so LN0042-10 is "ln0042 10". */
const referenceWords = (text: unknown): string[] => String(text ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * R4: the instalments a narration names, read on word boundaries across the
 * whole lender. Where references overlap the longest wins, so "LN0042-10" is
 * not also "LN0042"; references that read alike name every instalment they fit.
 */
function narrationInstalments(index: MatchIndex, narration: unknown): TypedRecord<"due-items">[] {
  const words = referenceWords(narration), found: { start: number; end: number; dues: TypedRecord<"due-items">[] }[] = [];
  for (let start = 0; start < words.length; start++) {
    for (let end = start + 1; end <= Math.min(words.length, start + index.longestReference); end++) {
      const dues = index.duesByReference.get(words.slice(start, end).join(" "));
      if (dues) found.push({ start, end, dues });
    }
  }
  const longest = found.filter((span) => !found.some((other) => other.end - other.start > span.end - span.start && other.start <= span.start && other.end >= span.end));
  return [...new Set(longest.flatMap((span) => span.dues))];
}

/** The due item a Payment was collected for, by its strong keys: the attempt's provider debit reference, then the observation's explicit link. */
export function intendedDueItem(state: DomainState, payment: TypedRecord<"payments">, index?: MatchIndex): { due: TypedRecord<"due-items">; key: string } | undefined {
  const byAttempt = index ? index.attempts.get(payment.reference) : recordsOf(state, "attempts").find((attempt) => attempt.data.providerReference ? attempt.data.providerReference === payment.reference : Boolean(attempt.reference) && attempt.reference === payment.reference);
  const candidate = byAttempt
    ? { id: String(byAttempt.data.dueItemId), key: byAttempt.data.providerReference ? "attempt_provider_reference" : "attempt_reference" }
    : payment.data.dueItemId ? { id: String(payment.data.dueItemId), key: "observation_due_item" } : undefined;
  if (!candidate) return undefined;
  const due = index ? index.dues.get(candidate.id) : recordsOf(state, "due-items").find((record) => record.id === candidate.id);
  if (!due || (payment.customerId && due.customerId !== payment.customerId)) return undefined;
  return { due, key: candidate.key };
}

/** Section 7.2 rule ladder, applied to canonical Payments, never to observations. A payment with nothing to allocate, such as one an earlier build made from a line whose gross was 0, is left alone. */
function matchPayment(state: DomainState, ctx: Context, payment: TypedRecord<"payments">, index: MatchIndex): void {
  if (payment.status !== "unallocated" || paymentReturned(payment) || paymentUnappliedKobo(payment) === 0) return;
  if (Array.isArray(payment.data.legacyReversalReviewIds) && payment.data.legacyReversalReviewIds.length) return;
  const connection = connectionOf(state, payment), currency = currencyOf(payment);
  const rejected = rejectedMatches(payment);
  const intended = intendedDueItem(state, payment, index);
  // A payment left for Finance is rewritten only when its explanation changes, so a daily close does not rewrite it every day.
  const leaveForFinance = (explanation: string) => {
    if (payment.data.explanation === explanation) return;
    payment.data.explanation = explanation;
    touch(payment, ctx.now);
  };
  // Decision on R1's currency and connection: such a payment stays unallocated, with an exception for Finance.
  const holdForFinance = (explanation: string) => {
    leaveForFinance(explanation);
    raiseException(state, ctx, "unallocated_payment", { linkedRecordId: payment.id, customerId: payment.customerId, amountKobo: paymentUnappliedKobo(payment), notes: explanation, condition: identityCondition("unallocated_payment", payment.id) });
  };
  // Instalments are owed in naira: money in another currency is never matched, by any rule.
  if (currency !== "NGN") {
    holdForFinance(`Payment ${payment.reference} is in ${currency}, observed through ${connection}. Instalments are owed in naira, so it is not matched automatically and cannot be applied to one. Record its refund or resolve it with Finance.`);
    return;
  }
  // The rules compare the gross amount, which a payment refunded in part no longer holds.
  const refunded = paymentRefundedKobo(payment);
  if (refunded > 0) {
    leaveForFinance(`A refund returned ${nairaText(refunded)} of this payment. Automatic matching leaves the ${nairaText(paymentUnappliedKobo(payment))} it still holds for Finance to allocate.`);
    return;
  }
  // Finance's "this is the wrong instalment" stands: a strong reference to a
  // rejected instalment is not matched anywhere else automatically either.
  if (intended && rejected.has(intended.due.id)) {
    leaveForFinance(`Finance said this payment does not belong to instalment ${intended.due.reference}. It stays unallocated for Finance to allocate.`);
    return;
  }
  // Finance resolved a suspected duplicate as a separate payment: it is not held again for the same reason.
  const distinct = payment.data.duplicateReview?.resolutionCode === "distinct_payments";
  // ING-05 (b): a second Payment for a due item that is already paid is held, never allocated.
  if (intended && outstanding(intended.due) === 0 && !distinct) {
    payment.status = "possible_duplicate";
    payment.data.explanation = `Due item ${intended.due.reference} is already paid; this second payment is held for Finance (${intended.key}).`;
    raiseException(state, ctx, "suspected_duplicate", { linkedRecordId: payment.id, customerId: payment.customerId, amountKobo: payment.amountKobo, notes: payment.data.explanation });
    return;
  }
  // ING-05 (a): the later of two near-identical Payments from the same payer inside two minutes is held, never allocated.
  const observedBefore = (item: TypedRecord<"payments">) => {
    const delta = paymentObservedAt(item) - paymentObservedAt(payment);
    return delta < 0 || (delta === 0 && `${item.createdAt}${item.id}` < `${payment.createdAt}${payment.id}`);
  };
  const twin = !distinct && (index.paymentsByCustomer.get(payment.customerId) ?? []).find((item) =>
    item.id !== payment.id && item.reference !== payment.reference && payment.customerId && item.customerId === payment.customerId &&
    item.amountKobo === payment.amountKobo && item.status !== "possible_duplicate" && !paymentReturned(item) &&
    observedBefore(item) && paymentObservedAt(payment) - paymentObservedAt(item) <= DUPLICATE_WINDOW_MS,
  );
  if (twin) {
    payment.status = "possible_duplicate";
    payment.data.explanation = `Near-identical to payment ${twin.reference} from the same payer within two minutes; held for Finance.`;
    raiseException(state, ctx, "suspected_duplicate", { linkedRecordId: payment.id, customerId: payment.customerId, amountKobo: payment.amountKobo, notes: payment.data.explanation });
    return;
  }
  // A strong reference to a stopped instalment must not be redirected to a
  // different obligation, or abort the whole batch at the allocation guard.
  // Keep it in the existing unallocated Finance queue (and its ageing SLA).
  if (intended && !eligibleForAutomaticMatching(intended.due)) {
    leaveForFinance(`Linked instalment ${intended.due.reference} is ${intended.due.status.replace(/_/g, " ")}; this payment remains unallocated for Finance review.`);
    return;
  }
  // R1 needs the lender's own connection: a strong reference seen through another provider is not our debit's evidence.
  if (intended && connectionKey(connection) !== connectionKey(String(state.merchant.provider))) {
    holdForFinance(`Provider reference ${payment.reference} names instalment ${intended.due.reference}, but this payment was observed through ${connection}, not the lender's ${state.merchant.provider} connection. It is not matched automatically.`);
    return;
  }
  const dues = (index.duesByCustomer.get(payment.customerId) ?? []).filter((due) => eligibleForAutomaticMatching(due) && !rejected.has(due.id));
  // R1: provider reference, same tenant and connection, NGN, gross amount equals the attempt (due) amount.
  if (intended && payment.amountKobo === intended.due.amountKobo && outstanding(intended.due) >= payment.amountKobo) {
    const matched = `Provider reference ${payment.reference} resolved to instalment ${intended.due.reference} by ${intended.key}; currency and gross amount match.`;
    // Decision on evidence with no payer: R1 proposes it, and Finance's confirmation identifies the payer.
    if (!payment.customerId) allocatePayment(state, ctx, payment, intended.due, payment.amountKobo, "R1", "probable", false, `${matched} The payment evidence names no payer, so Finance confirms the payer before it is applied.`);
    else allocatePayment(state, ctx, payment, intended.due, payment.amountKobo, "R1", "certain", true, matched);
    return;
  }
  // R2: dedicated virtual account, exact amount of the oldest outstanding due item.
  const virtualAccountDues = dues.filter((due) => String(payment.data.virtualAccountCustomerId || "") === due.customerId).sort((a, b) => String(a.data.dueDate).localeCompare(String(b.data.dueDate)));
  if (virtualAccountDues.length && virtualAccountDues[0]!.amountKobo === payment.amountKobo && outstanding(virtualAccountDues[0]!) === payment.amountKobo) {
    allocatePayment(state, ctx, payment, virtualAccountDues[0]!, payment.amountKobo, "R2", "certain", true, "Dedicated virtual account credit equals the oldest outstanding instalment.");
    return;
  }
  // R3: dedicated virtual account, different amount: proposed as partial or overpayment against the oldest outstanding item.
  if (virtualAccountDues.length && payment.amountKobo !== virtualAccountDues[0]!.amountKobo) {
    const oldest = virtualAccountDues[0]!;
    allocatePayment(state, ctx, payment, oldest, Math.min(payment.amountKobo, outstanding(oldest)), "R3", "probable", false, payment.amountKobo < oldest.amountKobo ? "Virtual account credit is less than the oldest instalment; proposed as a partial payment." : "Virtual account credit exceeds the oldest instalment; proposed with the excess as unapplied credit.");
    return;
  }
  // R4: an instalment reference in the narration, on word boundaries and the longest where references overlap. It is
  // certain only when the narration names one instalment across the lender, and that one is this payer's, open and
  // owed this amount. A narration naming several, or a reference that is not unique, is never matched automatically.
  const named = narrationInstalments(index, payment.data.narration);
  const [only] = named;
  if (named.length === 1 && dues.includes(only!) && only!.amountKobo === payment.amountKobo && outstanding(only!) >= payment.amountKobo) {
    allocatePayment(state, ctx, payment, only!, payment.amountKobo, "R4", "certain", true, `Narration carries the unique reference ${only!.reference} and the amount matches.`);
    return;
  }
  // R5: amount, payer and a five-day window around the due date.
  const near = dues.filter((due) => due.amountKobo === payment.amountKobo && outstanding(due) >= payment.amountKobo && Math.abs(Date.parse(String(due.data.dueDate)) - paymentObservedAt(payment)) <= 5 * DAY_MS);
  if (near.length === 1) allocatePayment(state, ctx, payment, near[0]!, payment.amountKobo, "R5", "probable", false, "Amount and payer match one instalment within five days of its due date; Finance confirmation required.");
}

/**
 * Section 6.3, applied by the close to every open obligation under an approved
 * policy: the arm is assigned at the first eligible failure, every decision is
 * recorded (RET-03), give-up rows become exceptions so the LMS can be told
 * (REC-04), and a notice not evidenced by its deadline defers the attempt.
 */
function applyDecisions(state: DomainState, ctx: Context): { finalFailures: number; disputes: number; decisionsRecorded: number; deferred: number } {
  let finalFailures = 0, disputes = 0, decisionsRecorded = 0, deferred = 0;
  enrolEligibleFailures(state, ctx);
  for (const due of recordsOf(state, "due-items").filter((item) => ["scheduled", "in_collection", "partially_paid"].includes(item.status))) {
    const policy = approvedPolicyFor(state, due);
    if (!policy) continue;
    const decision = evaluateRetry(state, ctx, due, policy);
    if (decision.decision === "not_eligible") continue; // Nothing happened to this item; there is no decision to record.
    if (recordRetryDecision(state, ctx, due, decision)) decisionsRecorded += 1;
    if (decision.decision === "give_up") {
      due.status = "unpaid_final"; due.data.giveUpRule = decision.rule; touch(due, ctx.now);
      const type: ExceptionType = decision.inputs.code === "MANDATE_LIMIT_EXCEEDED" ? "mandate_limit_exceeded" : "unpaid_after_final_attempt";
      raiseException(state, ctx, type, { linkedRecordId: due.id, customerId: due.customerId, amountKobo: outstanding(due), notes: `${due.reference}: ${decision.reason}` });
      finalFailures += 1;
    } else if (decision.decision === "stop" && decision.rule === "customer_disputed") {
      // A debit whose dispute was not upheld, or that Finance released, is dispute_released instead and does not freeze it again.
      due.status = "in_dispute"; touch(due, ctx.now);
      raiseException(state, ctx, "customer_dispute", { linkedRecordId: due.id, customerId: due.customerId, amountKobo: outstanding(due), notes: `${due.reference}: the customer disputed the debit.` });
      disputes += 1;
    } else if (decision.decision === "defer") {
      // One exception per failed attempt whose notice was not evidenced: the deferred slot moves every close, the attempt does not.
      raiseException(state, ctx, "notice_not_evidenced", { linkedRecordId: due.id, customerId: due.customerId, amountKobo: outstanding(due), notes: `${due.reference}: ${decision.reason}`, condition: `notice_not_evidenced:${due.id}:${decision.attemptId ?? ""}` });
      deferred += 1;
    }
  }
  return { finalFailures, disputes, decisionsRecorded, deferred };
}

/**
 * One reconciliation pass over the lender's records, run with its lookups
 * indexed (indexedPass): a close that confirms many matches, or evaluates many
 * instalments, costs what its records do rather than their number times the
 * items it handles.
 */
export function reconcile(state: DomainState, ctx: Context): { message: string; data: Record<string, any> } {
  return indexedPass(state, () => reconcileRecords(state, ctx));
}

function reconcileRecords(state: DomainState, ctx: Context): { message: string; data: Record<string, any> } {
  const exceptionsBefore = recordsOf(state, "exceptions").length;
  const legacyReviews = reviewEarlierReversalDecisions(state, ctx);
  const observations = recordsOf(state, "observations").filter((item) => item.status === "unresolved");
  // Exceptions an earlier build raised for money in another currency name it from now on.
  const currenciesRecorded = recordExceptionCurrencies(state, ctx);
  const identityHolds = holdEarlierSettlementIdentities(state, ctx);
  // Batches an earlier build saved in several currencies hold one from now on, before any line is counted.
  const separated = separateEarlierCurrencies(state, ctx);
  const canonicalPayments = new CanonicalPaymentIndex(state), settlementLines = new SettlementLines(state);
  // Evidence of a reversal is read after every other piece of evidence, so the payment it reverses, arriving in the same
  // import or close, is recorded first whatever order the evidence arrived in.
  const ordered = [...observations.filter((item) => !reportsReversal(item)), ...observations.filter(reportsReversal)];
  const resolved = ordered.map((item) => canonicalPayment(state, ctx, item, canonicalPayments, settlementLines)).filter(Boolean) as TypedRecord<"payments">[];
  holdEarlierReversalPayments(state, ctx, legacyReviews);
  recountEarlierLines(state, ctx);
  const statements = linkSettlementStatements(state, ctx);
  const batchVariances = evaluateSettlementBatches(state, ctx, statements.credits);
  keepLinesCountedTwiceReported(state, ctx);
  const allocationsBefore = new Set(recordsOf(state, "allocations").map((item) => item.id));
  // Statuses written before these rules, or by a path that did not settle the
  // payment, are re-derived first, so the rule ladder only sees whole,
  // unapplied payments that still hold their money.
  const repaired = paymentsToSettle(state);
  repaired.forEach((payment) => settlePaymentStatus(state, ctx, payment));
  // Instalment statuses that contradict their stored balance, as an amount edit
  // could leave them before this rule, are re-derived before matching and before
  // the engine evaluates them. A record without a stored balance is left alone.
  const duesRepaired = recordsOf(state, "due-items")
    .filter((due) => Number.isInteger(due.data.outstandingKobo) && derivedDueStatus(state, due) !== due.status)
    .filter((due) => settleDueStatus(state, ctx, due)).length;
  const matches = new MatchIndex(state);
  let paymentsSkipped = 0;
  for (const payment of recordsOf(state, "payments").filter((item) => item.status === "unallocated")) {
    try {
      matchPayment(state, ctx, payment, matches);
    } catch (error) {
      // A payment the ladder cannot apply is held for Finance with the reason and an exception; one record never stops the close.
      if (!(error instanceof Error) || error.constructor !== Error) throw error;
      const explanation = `Automatic matching left this payment for Finance: ${error.message}`;
      if (payment.data.explanation !== explanation) { payment.data.explanation = explanation; touch(payment, ctx.now); }
      raiseException(state, ctx, "unallocated_payment", { linkedRecordId: payment.id, customerId: payment.customerId, amountKobo: paymentUnappliedKobo(payment), notes: explanation, condition: identityCondition("unallocated_payment", payment.id) });
      paymentsSkipped += 1;
    }
  }
  const now = Date.parse(ctx.now);
  // REC-04: money waiting for Finance ages into an exception: an unallocated payment, and the unapplied rest of one
  // applied in part. An overpayment's excess has its own exception already.
  const aged = recordsOf(state, "payments").filter((item) => ["unallocated", "partial"].includes(item.status) && paymentAwaitsAllocation(item) && !paymentReturned(item) && now - paymentObservedAt(item) >= UNALLOCATED_AGE_MS);
  aged.forEach((payment) => {
    const left = paymentUnappliedKobo(payment), rest = payment.status === "partial";
    raiseException(state, ctx, "unallocated_payment", {
      linkedRecordId: payment.id, customerId: payment.customerId, amountKobo: left,
      notes: rest ? `${moneyText(left, currencyOf(payment))} of this payment is still not applied to an instalment after 24 hours.` : "No certain or confirmed allocation after 24 hours.",
      condition: rest ? `unallocated_payment:${payment.id}:unapplied:${left}` : identityCondition("unallocated_payment", payment.id),
    });
  });
  // Outcomes resolved before resolutions updated the attempt are applied now, the latest resolution first,
  // so those instalments stop waiting as in flight.
  const unknownAttempts = new Set(recordsOf(state, "attempts").filter((attempt) => attempt.status === "unknown").map((attempt) => attempt.id));
  const resolvedAt = (item: TypedRecord<"exceptions">) => String(item.data.resolvedAt || item.updatedAt);
  const outcomesConfirmed = recordsOf(state, "exceptions")
    .filter((item) => unknownAttempts.has(String(item.data.linkedRecordId)) && resolveExceptionType(item.data.type) === "unknown_outcome" && !isOpenException(item.status))
    .sort((a, b) => resolvedAt(b).localeCompare(resolvedAt(a)))
    .filter((item) => confirmAttemptOutcome(state, ctx, item)).length;
  const giveUps = applyDecisions(state, ctx);
  const unknownOutcomes = recordsOf(state, "attempts").filter((attempt) => attempt.status === "unknown" && now - Date.parse(attemptTime(attempt)) >= UNKNOWN_OUTCOME_AGE_MS);
  unknownOutcomes.forEach((attempt) => raiseException(state, ctx, "unknown_outcome", { linkedRecordId: attempt.id, customerId: attempt.customerId, amountKobo: attempt.amountKobo, notes: "TIMEOUT_UNKNOWN unresolved for 24 hours; the provider must confirm the outcome by reference.", condition: identityCondition("unknown_outcome", attempt.id) }));
  const checkoutsUnknown = ageUnknownCheckouts(state, ctx, now);
  const mappingNeeded = recordsOf(state, "attempts").filter((attempt) => attempt.status === "failed" && normaliseFailureCode(attempt.data.failureCode) === "UNKNOWN" && attempt.data.rawFailureCode);
  mappingNeeded.forEach((attempt) => raiseException(state, ctx, "mapping_needed", { linkedRecordId: attempt.id, customerId: attempt.customerId, amountKobo: attempt.amountKobo, notes: `Provider code "${attempt.data.rawFailureCode}" is not in the failure-code mapping.`, condition: `mapping_needed:${attempt.id}:${attempt.data.rawFailureCode}` }));
  // Matching may have tied a payment a hold names to an instalment: the holds are re-derived as the payments now stand.
  refreshHeldEvidence(state, ctx);
  // Last, so nothing raised above is left open once its condition cleared.
  const cleared = clearSettledExceptions(state, ctx);
  const newAllocations = recordsOf(state, "allocations").filter((item) => !allocationsBefore.has(item.id));
  const allocationsByRule: Record<string, number> = {};
  for (const allocation of newAllocations) allocationsByRule[String(allocation.data.rule)] = (allocationsByRule[String(allocation.data.rule)] || 0) + 1;
  const observationsBySource: Record<string, number> = {};
  for (const observation of observations.filter((item) => item.status === "resolved")) observationsBySource[String(observation.data.source)] = (observationsBySource[String(observation.data.source)] || 0) + 1;
  return {
    message: "Reconciliation complete. Payment evidence has been checked for matches. No money was moved and no collection instruction was sent.",
    data: {
      observationsResolved: observations.filter((item) => item.status === "resolved").length, observationsBySource, canonicalPayments: resolved.length,
      settlementStatementsMatched: statements.linked, settlementVariances: batchVariances, allocationsByRule, paymentStatusesRepaired: repaired.length, dueStatusesRepaired: duesRepaired, paymentsSkipped, attemptOutcomesConfirmed: outcomesConfirmed,
      proposed: recordsOf(state, "payments").filter((item) => item.status === "proposed").length,
      unallocated: recordsOf(state, "payments").filter((item) => paymentAwaitsAllocation(item)).length,
      possibleDuplicates: recordsOf(state, "payments").filter((item) => item.status === "possible_duplicate").length,
      agedUnallocated: aged.length, finalAttemptExceptions: giveUps.finalFailures, disputesFrozen: giveUps.disputes, noticesNotEvidenced: giveUps.deferred, retryDecisionsRecorded: giveUps.decisionsRecorded, unknownOutcomes: unknownOutcomes.length,
      checkoutOutcomesUnknown: checkoutsUnknown, exceptionsOpened: recordsOf(state, "exceptions").length - exceptionsBefore, exceptionsCleared: cleared.length,
      ...(currenciesRecorded ? { exceptionCurrenciesRecorded: currenciesRecorded } : {}),
      ...(identityHolds ? { settlementProviderIdentityHolds: identityHolds } : {}),
      ...(legacyReviews.some((item) => isOpenException(item.status)) ? { legacyReversalReviewsPending: legacyReviews.filter((item) => isOpenException(item.status)).length } : {}),
      ...(separated.length ? { settlementLinesSeparated: separated.length } : {}),
      ...(cleared.length || legacyReviews.length || separated.length ? { auditNote: [separatedLinesNote(separated), clearedExceptionsNote(cleared), legacyReviews.some((item) => isOpenException(item.status)) ? "Earlier unversioned reversal decisions are held for renewed Finance review; historical decisions and financial activity were not reinterpreted." : undefined].filter(Boolean).join(" ") } : {}),
    },
  };
}

/** What the audit entry adds for settlement lines an earlier build counted in a batch of another currency: each line, its batch, both currencies and the batch that now counts its collection instead. */
function separatedLinesNote(separated: readonly SeparatedLine[]): string | undefined {
  if (!separated.length) return undefined;
  const named = separated.slice(0, 3).map(({ line, batch, countedIn }) => `${line.reference} (${currencyOf(line)}) from settlement batch ${batch.reference} (${currencyOf(batch)})${countedIn ? `, now counted in settlement batch ${countedIn.reference}, where the provider lists it too` : ""}`);
  const more = separated.length > 3 ? `; and ${counted(separated.length - 3, "more", "more")}` : "";
  return `Took ${counted(separated.length, "settlement line")} in another currency than its batch out of the batch, as a batch holds one currency: ${named.join("; ")}${more}.`;
}

/** When a pay-by-bank checkout's outcome became unknown: its first unknown event, else its last change. */
export function checkoutUnknownSince(intent: TypedRecord<"connected-intents">): string {
  const events = Array.isArray(intent.data.events) ? intent.data.events : [];
  return String(events.find((event) => event.status === "unknown")?.at ?? intent.updatedAt);
}

/**
 * Item 10: a pay-by-bank checkout whose outcome stays unknown holds its
 * instalment, with no new checkout and no retry. Once it has been unknown for
 * UNKNOWN_OUTCOME_AGE_MS it is an unknown_outcome exception for Finance,
 * linked to the checkout, which names it. Finance records the outcome by
 * resolving it (resolveUnknownCheckout), and a late outcome from the
 * provider clears it. Returns how many checkouts wait that long.
 */
function ageUnknownCheckouts(state: DomainState, ctx: Context, now: number): number {
  const waiting = recordsOf(state, "connected-intents").filter((intent) => intent.status === "unknown" && now - Date.parse(checkoutUnknownSince(intent)) >= UNKNOWN_OUTCOME_AGE_MS);
  if (!waiting.length) return 0;
  const dues = new Map(recordsOf(state, "due-items").map((due) => [due.id, due]));
  for (const intent of waiting) {
    const since = new Date(Date.parse(checkoutUnknownSince(intent)) + WAT_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");
    const exception = raiseException(state, ctx, "unknown_outcome", {
      linkedRecordId: intent.id, customerId: intent.customerId, amountKobo: intent.amountKobo, owner: "Finance", linkedKind: "connected-intents", condition: identityCondition("unknown_outcome", intent.id),
      notes: `The outcome of the pay-by-bank payment of ${nairaText(intent.amountKobo)} for instalment ${dues.get(String(intent.data.dueItemId))?.reference ?? intent.data.dueItemId} has been unknown since ${since} WAT, for more than 24 hours. Until it is known the instalment is held: no new checkout and no retry is planned. Check with the bank, then resolve this exception as confirmed successful, with the masked reference of the evidence that the money arrived, or as confirmed failed.`,
    });
    if (isOpenException(exception.status) && intent.data.outcomeExceptionId !== exception.id) { intent.data.outcomeExceptionId = exception.id; touch(intent, ctx.now); }
  }
  return waiting.length;
}
