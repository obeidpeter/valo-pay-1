import { sumMoney, WAT_OFFSET_MS, closeRules, closeTimeOf, deadlinePassed, isOpenException, nextCloseInstant, paymentAwaitsAllocation, paymentUnappliedKobo, type CloseReport } from "@workspace/valo-pay-1-schema";
import { recordsOf } from "./records";
import type { Context, DomainState, TypedRecord, ValopayRecord } from "./types";
import { allocationConfirmedAt, currencyOf, paymentObservedAt } from "./reconciliation";
import { watDate } from "./calendar";

const DAY_MS = 24 * 60 * 60 * 1000, MINUTE_MS = 60 * 1000;

/** REC-01: the daily close schedule as the console, the alerts and the scheduler see it. */
export interface CloseSchedule {
  /** Configured WAT time, HH:MM. */
  time: string;
  /** Whether the automatic close is on (settings.scheduledCloseEnabled, default true). */
  enabled: boolean;
  /** The next scheduled instant: the stored cursor, or derived from the time for a merchant that has none yet. */
  nextAt: string;
  /** True when the automatic close is on and its scheduled instant passed more than closeRules.lateAfterMinutes ago without a close. */
  missed: boolean;
  overdueMinutes: number;
  lateAfterMinutes: number;
  lastAt: string | null;
  lastTrigger: string | null;
  /** Failed scheduled attempts at the pending close time; 0 when none failed or the automatic close is off. */
  failedAttempts: number;
  /** When the scheduler tries the pending close again after a failure; null when it is not waiting to retry. */
  retryAt: string | null;
  /** When the scheduler switched the automatic close off because nobody changed the sandbox; null unless it is still off for that reason. */
  pausedForInactivityAt: string | null;
}

/**
 * The scheduler's record of failed attempts at one pending close time
 * (settings.closeRetry): that time, how many attempts failed, when to try
 * again and when the last one failed.  It never holds the error, because the
 * lender's settings are shown to its users; the error stays in the log.
 */
export interface CloseRetry { cursor: string; failures: number; retryAt: string; lastFailedAt: string }

const validInstant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

/** The scheduler cursor the merchant carries (settings.nextCloseAt), when it is a valid instant. */
export function storedCloseCursor(state: DomainState): string | null {
  const value = state.settings.nextCloseAt;
  return validInstant(value) ? value : null;
}

/**
 * The WAT business date a scheduled close closes, whose source files it
 * checks: the day before the WAT date of its scheduled time, the last whole
 * day (the 07:00 close of 29 June closes 28 June), whatever the time of day.
 */
export function scheduledCloseBusinessDate(scheduledFor: string): string {
  return watDate(Date.parse(scheduledFor) - DAY_MS);
}

/**
 * The scheduled time after the one a close covered: the configured time on
 * the next WAT day.  A missed time is never skipped: when this one has passed
 * too, the lender is still due and the next close catches it up, so every
 * business date gets its own close.
 */
export function followingCloseInstant(covered: string, closeTime: string): string {
  const nextDay = Date.parse(`${watDate(Date.parse(covered))}T00:00:00.000Z`) - WAT_OFFSET_MS + DAY_MS;
  return nextCloseInstant(nextDay - 1, closeTime);
}

/**
 * The business dates whose scheduled close is still owed at `now`, oldest
 * first: the pending time's, and one for each configured time since.  Nothing
 * is owed while the automatic close is off.  At most `limit` dates are
 * listed; `total` counts them all.
 */
export function owedCloseDates(state: DomainState, now: string, limit = 31): { dates: string[]; total: number } {
  const cursor = storedCloseCursor(state), nowMs = Date.parse(now);
  if (state.settings.scheduledCloseEnabled === false || cursor === null || Date.parse(cursor) > nowMs) return { dates: [], total: 0 };
  const next = Date.parse(followingCloseInstant(cursor, closeTimeOf(state.settings)));
  // After the first, the configured times are a whole day apart: WAT keeps no daylight saving.
  const total = 1 + (next <= nowMs ? Math.floor((nowMs - next) / DAY_MS) + 1 : 0);
  const dates = [scheduledCloseBusinessDate(cursor)];
  for (let at = next; dates.length < Math.min(total, limit); at += DAY_MS) dates.push(scheduledCloseBusinessDate(new Date(at).toISOString()));
  return { dates, total };
}

/** The recorded retry, only while it belongs to the pending close time: one left from an earlier time is inert. */
export function closeRetryOf(settings: Record<string, unknown>): CloseRetry | null {
  const retry = settings.closeRetry as Partial<CloseRetry> | null | undefined;
  if (!retry || typeof retry !== "object" || !validInstant(settings.nextCloseAt) || retry.cursor !== settings.nextCloseAt) return null;
  if (!Number.isInteger(retry.failures) || Number(retry.failures) < 1 || !validInstant(retry.retryAt)) return null;
  return retry as CloseRetry;
}

/**
 * The retry to record after a scheduled attempt failed at `now`: one more
 * failure at the pending close time, and the next attempt after
 * min(retryMaxMinutes, retryBaseMinutes × 2^(failures−1)) minutes.  Null when
 * nothing is pending (no cursor, or its time has not come), so a close that
 * moved the cursor meanwhile is never marked as failing.
 */
export function nextCloseRetry(settings: Record<string, unknown>, now: string): CloseRetry | null {
  const cursor = settings.nextCloseAt;
  if (!validInstant(cursor) || Date.parse(cursor) > Date.parse(now)) return null;
  const failures = (closeRetryOf(settings)?.failures ?? 0) + 1;
  const minutes = Math.min(closeRules.retryMaxMinutes, closeRules.retryBaseMinutes * 2 ** Math.min(failures - 1, 20));
  return { cursor, failures, retryAt: new Date(Date.parse(now) + minutes * MINUTE_MS).toISOString(), lastFailedAt: now };
}

/**
 * Whether the scheduled close is due now: the automatic close is on, the
 * stored cursor is at or before `now`, and no retry is waiting.  The retry
 * wait is part of the check, so another instance cannot try a failing lender
 * again before its time.
 */
export function scheduledCloseDue(state: DomainState, now: string): boolean {
  const cursor = storedCloseCursor(state), retry = closeRetryOf(state.settings);
  return state.settings.scheduledCloseEnabled !== false && cursor !== null && Date.parse(cursor) <= Date.parse(now)
    && (retry === null || Date.parse(retry.retryAt) <= Date.parse(now));
}

/**
 * An anonymous sandbox nobody has changed for closeRules.idleSandboxDays: the
 * scheduler switches its automatic close off instead of closing it, and says
 * when, so the console can explain it.  Switching it on again in Settings
 * resumes from the next configured time (rescheduleAfterSettings).
 */
export function pauseIdleSandboxClose(state: DomainState, now: string): void {
  state.settings.scheduledCloseEnabled = false;
  state.settings.closePausedForInactivityAt = now;
  delete state.settings.closeRetry;
}

/**
 * After a settings change, the cursor restarts from the next occurrence only
 * when the close time changed or the automatic close was switched on, and a
 * retry recorded for the old time goes with it.  Saving unchanged settings
 * never moves it, so a pending missed or failing close stays pending and is
 * still caught up; switching the close off leaves the cursor for the next
 * switch-on to replace.  Switching on also ends a pause for inactivity.
 */
export function rescheduleAfterSettings(state: DomainState, previous: { time: string; enabled: boolean }, now: string): boolean {
  const time = closeTimeOf(state.settings), enabled = state.settings.scheduledCloseEnabled !== false;
  if (enabled) delete state.settings.closePausedForInactivityAt;
  if (time === previous.time && (!enabled || previous.enabled)) return false;
  state.settings.nextCloseAt = nextCloseInstant(now, time);
  delete state.settings.closeRetry;
  return true;
}

export function closeSchedule(state: DomainState, now: string): CloseSchedule {
  const time = closeTimeOf(state.settings);
  const enabled = state.settings.scheduledCloseEnabled !== false;
  const cursor = storedCloseCursor(state);
  const overdueMinutes = cursor ? Math.max(0, Math.floor((Date.parse(now) - Date.parse(cursor)) / MINUTE_MS)) : 0;
  const last = recordsOf(state, "closes").sort((a, b) => String(a.data.closedAt || a.createdAt).localeCompare(String(b.data.closedAt || b.createdAt))).at(-1);
  const retry = enabled ? closeRetryOf(state.settings) : null, pausedAt = state.settings.closePausedForInactivityAt;
  return {
    time, enabled, nextAt: cursor ?? nextCloseInstant(now, time),
    missed: enabled && overdueMinutes > closeRules.lateAfterMinutes, overdueMinutes, lateAfterMinutes: closeRules.lateAfterMinutes,
    lastAt: last ? String(last.data.closedAt || last.createdAt) : null, lastTrigger: last ? String(last.data.schedule?.trigger ?? "manual") : null,
    failedAttempts: retry?.failures ?? 0, retryAt: retry?.retryAt ?? null,
    pausedForInactivityAt: !enabled && validInstant(pausedAt) ? pausedAt : null,
  };
}

/** REC-05: a customer position is derived from due items, confirmed allocations and payments; no stored balance is authoritative. */
export interface CustomerPosition {
  customerId: string;
  obligationsKobo: number;
  allocatedKobo: number;
  outstandingKobo: number;
  unallocatedKobo: number;
}

/** Rebuild once per state snapshot. Values are copied totals, never a cache
 * across mutations: a close takes separate opening and closing snapshots. */
function positionIndex(state: DomainState) {
  const positions = new Map<string, CustomerPosition>();
  const appliedByDue = new Map<string, number>();
  for (const record of state.records) {
    if (record.kind === "customers") positions.set(record.id, { customerId: record.id, obligationsKobo: 0, allocatedKobo: 0, outstandingKobo: 0, unallocatedKobo: 0 });
  }
  for (const record of state.records) {
    const position = positions.get(record.customerId);
    if (record.kind === "due-items" && record.status !== "cancelled" && position) position.obligationsKobo = sumMoney([position.obligationsKobo, record.amountKobo]);
    if (record.kind === "allocations" && record.status === "confirmed") {
      if (position) position.allocatedKobo = sumMoney([position.allocatedKobo, record.amountKobo]);
      const dueId = record.data.dueItemId;
      if (typeof dueId === "string") appliedByDue.set(dueId, sumMoney([appliedByDue.get(dueId) ?? 0, record.amountKobo]));
    }
    // Instalments are owed in naira: money in another currency is held for Finance, never a customer's naira credit.
    if (record.kind === "payments" && position && currencyOf(record) === "NGN") position.unallocatedKobo = sumMoney([position.unallocatedKobo, paymentUnappliedKobo(record)]);
  }
  for (const position of positions.values()) position.outstandingKobo = Math.max(0, position.obligationsKobo - position.allocatedKobo);
  return { positions, appliedByDue };
}

export function positionFor(state: DomainState, customerId: string): CustomerPosition {
  const related = state.records.filter((record) => record.customerId === customerId);
  const obligationsKobo = sumMoney(related.filter((record) => record.kind === "due-items" && record.status !== "cancelled").map((record) => record.amountKobo));
  const allocatedKobo = sumMoney(related.filter((record) => record.kind === "allocations" && record.status === "confirmed").map((record) => record.amountKobo));
  const unallocatedKobo = sumMoney(related.filter((record) => record.kind === "payments" && currencyOf(record) === "NGN").map((record) => paymentUnappliedKobo(record)));
  return { customerId, obligationsKobo, allocatedKobo, outstandingKobo: Math.max(0, obligationsKobo - allocatedKobo), unallocatedKobo };
}

/** REC-05: rebuild each due item's outstanding balance from confirmed allocations and compare it with the stored view. */
export function positionMismatches(state: DomainState, appliedByDue = positionIndex(state).appliedByDue): Array<{ dueItemId: string; reference: string; customerId: string; storedOutstandingKobo: number; rebuiltOutstandingKobo: number }> {
  return recordsOf(state, "due-items").flatMap((due) => {
    if (due.data.outstandingKobo === undefined || due.status === "cancelled") return [];
    const applied = appliedByDue.get(due.id) ?? 0;
    const rebuilt = Math.max(0, due.amountKobo - applied);
    return rebuilt === Number(due.data.outstandingKobo) ? [] : [{ dueItemId: due.id, reference: due.reference, customerId: due.customerId, storedOutstandingKobo: Number(due.data.outstandingKobo), rebuiltOutstandingKobo: rebuilt }];
  });
}

export function positionSnapshot(state: DomainState): Map<string, CustomerPosition> {
  return positionIndex(state).positions;
}

const sumOf = (items: ValopayRecord[]) => ({ count: items.length, kobo: sumMoney(items.map((item) => item.amountKobo)) });
/** Money in another currency than naira, by currency code: how many payments and their amount in that currency's minor unit, as the payment stores it. */
export type OtherCurrencies = Record<string, { count: number; amount: number }>;
/**
 * Payments, or settlement batches, by the money each holds (`amount`), by one
 * rule: the count takes every one, whatever its currency, since each is work
 * for Finance; the kobo sums naira only, and money in any other currency is
 * listed beside it by its code (otherCurrencies, only when there is some: how
 * many and their amount in that currency's minor unit), never added to a naira
 * total.
 */
export function inNaira(items: readonly ValopayRecord[], amount: (item: ValopayRecord) => number): { count: number; kobo: number; otherCurrencies?: OtherCurrencies } {
  let kobo = 0;
  const other = new Map<string, { count: number; amount: number }>();
  for (const item of items) {
    const currency = currencyOf(item);
    if (currency === "NGN") { kobo = sumMoney([kobo, amount(item)]); continue; }
    const row = other.get(currency) ?? { count: 0, amount: 0 };
    row.count += 1; row.amount = sumMoney([row.amount, amount(item)]);
    other.set(currency, row);
  }
  return { count: items.length, kobo, ...(other.size ? { otherCurrencies: Object.fromEntries([...other].sort(([a], [b]) => (a < b ? -1 : 1))) } : {}) };
}
/**
 * What a customer's payments in currencies other than naira hold unapplied, by
 * currency (how many payments and their amount in that currency's minor
 * unit), which the customer's positions list beside the naira credit
 * (unallocatedKobo), never in it: the dispute pack, the customer timeline and
 * the customer history. Undefined when there is none.
 */
export function unallocatedOtherCurrencies(payments: readonly ValopayRecord[]): OtherCurrencies | undefined {
  return inNaira(payments.filter((payment) => paymentUnappliedKobo(payment) > 0), (payment) => paymentUnappliedKobo(payment)).otherCurrencies;
}
/** Payments waiting for Finance (paymentAwaitsAllocation) by the money they hold: the unapplied rest of one applied in part is waiting, what a refund of part of one returned is not. */
const heldOf = (items: TypedRecord<"payments">[]) => inNaira(items, (item) => paymentUnappliedKobo(item));
const inPeriod = (at: string | undefined, from: string | null, to: string) => Boolean(at) && (from === null || String(at) > from) && String(at) <= to;

/** What the close needs to remember from before reconciliation ran. */
export interface OpeningSnapshot {
  since: string | null;
  unallocated: { count: number; kobo: number; otherCurrencies?: OtherCurrencies };
  positions: Map<string, CustomerPosition>;
}

export function openingSnapshot(state: DomainState): OpeningSnapshot {
  const closes = recordsOf(state, "closes").map((close) => String(close.data.closedAt || close.createdAt)).sort();
  return { since: closes.at(-1) ?? null, unallocated: heldOf(recordsOf(state, "payments").filter(paymentAwaitsAllocation)), positions: positionSnapshot(state) };
}

/**
 * REC-07 daily close report: opening unallocated, observations received by
 * source and the Payments they resolved to, allocated by rule, proposed,
 * unallocated, variances, exceptions opened and closed, and the customer
 * positions that changed, plus the REC-05 position rebuild check.
 */
export function buildCloseReport(state: DomainState, ctx: Context, opening: OpeningSnapshot, reconciled: Record<string, any>): CloseReport {
  const to = ctx.now, from = opening.since;
  const payments = recordsOf(state, "payments"), dueItems = recordsOf(state, "due-items");

  const received = recordsOf(state, "observations").filter((item) => inPeriod(item.createdAt, from, to));
  const bySource: Record<string, { received: number; resolved: number; unresolved: number; paymentsResolvedTo: number; batchesResolvedTo: number }> = {};
  for (const observation of received) {
    const source = String(observation.data.source || "manual");
    const row = (bySource[source] ||= { received: 0, resolved: 0, unresolved: 0, paymentsResolvedTo: 0, batchesResolvedTo: 0 });
    row.received += 1;
    if (observation.status === "resolved") row.resolved += 1; else row.unresolved += 1;
  }
  for (const source of Object.keys(bySource)) {
    const rows = received.filter((item) => String(item.data.source || "manual") === source && item.status === "resolved");
    bySource[source]!.paymentsResolvedTo = new Set(rows.map((item) => item.data.paymentId).filter(Boolean)).size;
    bySource[source]!.batchesResolvedTo = new Set(rows.map((item) => item.data.resolvedTo).filter((value) => typeof value === "string" && value.startsWith("batch:"))).size;
  }
  const paymentsResolved = new Set(received.filter((item) => item.status === "resolved" && item.data.paymentId).map((item) => item.data.paymentId)).size;

  // A match counts in the close whose period confirmed it; a later review or edit moves updatedAt, not the confirmation.
  const confirmed = recordsOf(state, "allocations").filter((item) => item.status === "confirmed" && inPeriod(allocationConfirmedAt(item), from, to));
  const allocatedByRule: Record<string, { count: number; kobo: number; automatic: number }> = {};
  for (const allocation of confirmed) {
    const row = (allocatedByRule[String(allocation.data.rule)] ||= { count: 0, kobo: 0, automatic: 0 });
    row.count += 1; row.kobo = sumMoney([row.kobo, allocation.amountKobo]); if (allocation.data.automatic === true) row.automatic += 1;
  }

  const unallocated = payments.filter(paymentAwaitsAllocation);
  // Each batch in its own currency, whose smallest unit its amounts are in; their fee variance is summed in naira only.
  const varianceBatches = recordsOf(state, "settlement-batches").filter((item) => item.status === "variance");
  const variances = varianceBatches.map((batch) => ({
    batchId: batch.id, reference: batch.reference, currency: currencyOf(batch), feeVarianceKobo: Number(batch.data.feeVarianceKobo || 0), netKobo: Number(batch.data.netKobo || 0),
    statementNetKobo: batch.data.statementNetKobo ?? null, explanation: batch.data.explanation ?? null,
  }));
  const varianceTotals = inNaira(varianceBatches, (batch) => Number(batch.data.feeVarianceKobo || 0));

  const exceptions = recordsOf(state, "exceptions");
  const opened = exceptions.filter((item) => inPeriod(item.createdAt, from, to));
  const closed = exceptions.filter((item) => !isOpenException(item.status) && inPeriod(String(item.data.resolvedAt || item.updatedAt), from, to));
  const byType = (items: TypedRecord<"exceptions">[]) => items.reduce<Record<string, number>>((acc, item) => { acc[String(item.data.type)] = (acc[String(item.data.type)] || 0) + 1; return acc; }, {});

  const { positions: after, appliedByDue } = positionIndex(state);
  const customers = new Map(recordsOf(state, "customers").map((customer) => [customer.id, customer.name]));
  const positionsChanged = [...after.entries()].flatMap(([customerId, position]) => {
    const before = opening.positions.get(customerId);
    const changed = !before || (["obligationsKobo", "allocatedKobo", "outstandingKobo", "unallocatedKobo"] as const).some((key) => before[key] !== position[key]);
    return changed ? [{ customerId, customerName: customers.get(customerId) ?? "", before: before ?? null, after: position }] : [];
  });
  const mismatches = positionMismatches(state, appliedByDue);

  return {
    period: { from, to },
    openingUnallocated: opening.unallocated,
    observations: { received: received.length, bySource, paymentsResolvedTo: paymentsResolved, canonicalPaymentsCreated: Number(reconciled.canonicalPayments || 0) },
    allocatedByRule,
    allocated: sumOf(confirmed),
    proposed: sumOf(payments.filter((item) => item.status === "proposed")),
    unallocated: { ...heldOf(unallocated), olderThan24Hours: unallocated.filter((item) => Date.parse(to) - paymentObservedAt(item) >= DAY_MS).length },
    possibleDuplicates: inNaira(payments.filter((item) => item.status === "possible_duplicate"), (item) => item.amountKobo),
    variances: { count: variances.length, feeVarianceKobo: varianceTotals.kobo, ...(varianceTotals.otherCurrencies ? { otherCurrencies: varianceTotals.otherCurrencies } : {}), batches: variances },
    exceptions: {
      opened: { count: opened.length, byType: byType(opened) }, closed: { count: closed.length, byType: byType(closed) },
      openAtClose: exceptions.filter((item) => isOpenException(item.status)).length,
      overdueAtClose: exceptions.filter((item) => isOpenException(item.status) && deadlinePassed(item.data.dueBy, to)).length,
    },
    retryDecisions: { recorded: Number(reconciled.retryDecisionsRecorded || 0), finalAttempts: Number(reconciled.finalAttemptExceptions || 0), disputesFrozen: Number(reconciled.disputesFrozen || 0), noticesNotEvidenced: Number(reconciled.noticesNotEvidenced || 0) },
    customerPositionsChanged: positionsChanged,
    positionRebuild: { customersChecked: after.size, dueItemsChecked: dueItems.length, mismatches, alert: mismatches.length > 0 },
    reconciliation: reconciled,
  };
}
