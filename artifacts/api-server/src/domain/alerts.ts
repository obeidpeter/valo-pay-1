import { sumMoney } from "@workspace/valopay-schema";
/**
 * NFR-OBS-02 alerts computed from the lender's state: the conditions the TRD
 * routes to the on-call phone that this sandbox can observe.  Alerts are
 * derived on every read and frozen into each daily close; they are never
 * stored on their own.
 */
import { counted, alertRules, dayText, deadlinePassed, durationText, isBillableChannel, isOpenException, nairaText, paymentAwaitsAllocation, type AlertSeverity } from "@workspace/valopay-schema";
import { recordsOf } from "./records";
import type { DomainState } from "./types";
import { UNKNOWN_OUTCOME_AGE_MS, checkoutUnknownSince, paymentObservedAt } from "./reconciliation";
import { closeSchedule, owedCloseDates, positionMismatches } from "./close";
import { attemptTime } from "./policy-engine";
import { collectionSucceeded, monthOf } from "./billing";
import { exportHealth } from '../lib/export-jobs';

const DAY_MS = 24 * 60 * 60 * 1000, HOUR_MS = 60 * 60 * 1000;

export interface Alert {
  key: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  count?: number;
  since?: string;
  linkedRecordId?: string;
}
/**
 * A check of the lender's audit chain, as the overview or a write made it:
 * whether the chain holds, the entries it counted, its head hash, and
 * verifiedSequence, the last entry it verified, which is always before the
 * first entry that breaks the chain. `kept` says the lender has recorded the
 * break: a completed write, verify_audit or the daily check stored it, and it
 * stays until a check of the whole chain finds the chain valid again. A break
 * only a read has found is not kept: it clears if the chain is repaired
 * before one of them records it.
 */
export interface AuditVerification { valid: boolean; count: number; headHash: string; verifiedSequence: number; kept?: boolean }

const order: Record<AlertSeverity, number> = { critical: 0, high: 1, medium: 2, info: 3 };
const setting = (state: DomainState, key: string, fallback: number): number => {
  const value = Number(state.settings[key]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

export function buildAlerts(state: DomainState, now: string, audit?: AuditVerification | null): Alert[] {
  const alerts: Alert[] = [];
  const nowMs = Date.parse(now);
  const stalledExports = recordsOf(state, 'exports').filter(record => exportHealth(record, now).stalled);
  if (stalledExports.length) alerts.push({ key: 'exports_stalled', severity: 'medium', title: 'Exports need a status check', detail: `${counted(stalledExports.length, 'saved export has', 'saved exports have')} stopped making progress. Open Saved exports to check ${stalledExports.length === 1 ? 'it, and retry it' : 'each one, and retry it'} there when you can. Do not create a new export to replace one whose outcome is unclear.`, count: stalledExports.length, linkedRecordId: stalledExports[0]!.id, since: exportHealth(stalledExports[0]!, now).lastProgressAt });
  if (audit && !audit.valid) {
    // The chain holds up to the last verified entry, so the entry after it is the first that breaks it: changed, missing, out of order or claimed twice.
    // A recorded break is cleared only by a check of the whole chain (verify_audit, Check audit log, or the daily check after the close).
    const clears = audit.kept
      ? "This alert stays until a full check finds every entry intact: select Check audit log on the Audit log page, or wait for the daily check after the daily close."
      : "The next change, Check audit log or the daily check after the daily close will record this break. After that, the alert stays until a full check finds every entry intact. Until then, it clears if the log is repaired.";
    alerts.push({ key: "audit_chain_broken", severity: "critical", title: "Audit log verification failed", detail: `Entry ${audit.verifiedSequence + 1} of the audit log is missing, out of order or changed. Ask an Admin to investigate. ${clears}`, count: audit.count });
  }
  // An instruction dispatched in observation mode must never happen (NFR-OBS-02, DEB-10).
  if (state.merchant.mode !== "instruction") {
    const handedBack = recordsOf(state, "cutovers").filter((item) => item.status === "handed_back").map((item) => String(item.data.handedBackAt || item.createdAt)).sort().at(-1) ?? "";
    const dispatched = recordsOf(state, "attempts").filter((item) => item.data.source === "valo" && ["sent", "succeeded", "failed", "unknown", "reversed"].includes(item.status) && attemptTime(item) > handedBack);
    if (dispatched.length) alerts.push({ key: "instruction_in_observation_mode", severity: "critical", title: "Collection attempt recorded in ‘Records payments only’ mode", detail: `${counted(dispatched.length, "Valo Pay collection attempt was", "Valo Pay collection attempts were")} recorded while this lender is set to ‘Records payments only’. In this mode Valo Pay must not send collection instructions. Ask an Admin to investigate before you continue.`, count: dispatched.length, linkedRecordId: dispatched[0]!.id, since: attemptTime(dispatched[0]!) });
  }
  const drift = positionMismatches(state);
  if (drift.length) alerts.push({ key: "position_drift", severity: "high", title: "Saved balances do not match allocations", detail: `${counted(drift.length, "instalment has", "instalments have")} an unpaid amount that does not match the confirmed allocations. Open Reconciliation to investigate.`, count: drift.length, linkedRecordId: drift[0]!.dueItemId });
  const threshold = setting(state, "unallocatedAlertThreshold", alertRules.unallocatedThreshold);
  // Money waiting for Finance as the Finance queue and the daily close count it: an unallocated payment, or the unapplied rest of one applied in part.
  const aged = recordsOf(state, "payments").filter((item) => paymentAwaitsAllocation(item) && nowMs - paymentObservedAt(item) >= DAY_MS);
  if (aged.length > threshold) alerts.push({ key: "unallocated_over_threshold", severity: "high", title: "Too many payments are waiting for allocation", detail: `${counted(aged.length, "payment has", "payments have")} money that has waited at least 24 hours to be allocated to an instalment, including the rest of a payment allocated in part. The lender’s alert limit is ${threshold}. Review the waiting payments in Reconciliation.`, count: aged.length });
  // A date-only deadline lasts its whole WAT day, as in the queues (deadlinePassed).
  const overdue = recordsOf(state, "exceptions").filter((item) => isOpenException(item.status) && deadlinePassed(item.data.dueBy, nowMs));
  if (overdue.length) alerts.push({ key: "exceptions_overdue", severity: "medium", title: "Exceptions past their deadline", detail: `${counted(overdue.length, "open exception is", "open exceptions are")} overdue. Review each exception with its owner. Deadlines are counted in business days.`, count: overdue.length, linkedRecordId: overdue[0]!.id });
  // Item 10: a pay-by-bank checkout whose outcome stays unknown holds its instalment until Finance records the outcome.
  const heldCheckouts = recordsOf(state, "connected-intents").filter((item) => item.status === "unknown" && nowMs - Date.parse(checkoutUnknownSince(item)) >= UNKNOWN_OUTCOME_AGE_MS)
    .sort((a, b) => checkoutUnknownSince(a).localeCompare(checkoutUnknownSince(b)));
  if (heldCheckouts.length) alerts.push({ key: "pay_by_bank_outcome_unknown", severity: "high", title: "Pay by Bank outcomes unknown for over 24 hours", detail: `${counted(heldCheckouts.length, "Pay by Bank checkout has", "Pay by Bank checkouts have")} had an unknown outcome for at least 24 hours. Each one holds its instalment: no new checkout or retry is planned until Finance confirms the payment with its evidence or marks it failed. The daily close raises an exception for Finance for each one.`, count: heldCheckouts.length, linkedRecordId: heldCheckouts[0]!.id, since: checkoutUnknownSince(heldCheckouts[0]!) });
  const deferred = recordsOf(state, "exceptions").filter((item) => isOpenException(item.status) && item.data.type === "notice_not_evidenced");
  if (deferred.length) alerts.push({ key: "attempts_deferred", severity: "medium", title: "Collection attempts delayed: notice evidence missing", detail: `${counted(deferred.length, "planned attempt passed its", "planned attempts passed their")} notice deadline without a record that the provider accepted the customer notice. Review the missing evidence before a retry.`, count: deferred.length, linkedRecordId: deferred[0]!.id });
  // This WAT month's message cost per collection: a direct debit collected by webhook or settlement line counts.
  const month = monthOf(now);
  const cost = sumMoney(recordsOf(state, "notifications").filter((item) => monthOf(String(item.data.submittedAt || item.createdAt)) === month).map((item) => Number(item.data.costKobo || 0)));
  const collections = recordsOf(state, "payments").filter((item) => monthOf(String(item.data.observedAt || item.createdAt)) === month && isBillableChannel(item.data.channel) && collectionSucceeded(item)).length;
  const costCeiling = setting(state, "notificationCostAlertKobo", alertRules.notificationCostPerCollectionKobo);
  if (collections > 0 && cost / collections > costCeiling) alerts.push({ key: "notification_cost", severity: "medium", title: "Message cost exceeds the alert limit", detail: `Message costs average ${nairaText(Math.round(cost / collections))} per successful collection this month, above the alert limit of ${nairaText(Math.round(costCeiling))}. Review message costs in Settings.`, count: collections });
  const lastClose = recordsOf(state, "closes").map((item) => String(item.data.closedAt || item.createdAt)).sort().at(-1);
  if (!lastClose) alerts.push({ key: "close_overdue", severity: "medium", title: "No daily close yet", detail: "A daily close reconciles payment records and saves a dated summary. Run one to check whether the books are complete." });
  else if (nowMs - Date.parse(lastClose) > alertRules.closeOverdueHours * HOUR_MS) alerts.push({ key: "close_overdue", severity: "medium", title: "Daily close overdue", detail: `The last close was ${durationText((nowMs - Date.parse(lastClose)) / 60_000)} ago. A close is due every day at the time set for this lender. Review the schedule, or run a daily close.`, since: lastClose });
  // A scheduled close that has not run well past its time is the close analogue of a missed execution window (NFR-OBS-02).
  const schedule = closeSchedule(state, now);
  if (schedule.missed) {
    // Each missed business date gets its own catch-up close, oldest first; the alert names the dates still owed.
    const owed = owedCloseDates(state, now, 5), days = owed.dates.map((date) => dayText(date));
    const dates = new Intl.ListFormat("en-GB").format(owed.total > owed.dates.length ? [...days, `${owed.total - owed.dates.length} more`] : days);
    alerts.push({ key: "close_missed", severity: "high", title: "Scheduled daily close missed", detail: `The scheduled close due at ${schedule.time} WAT is ${durationText(schedule.overdueMinutes)} late. ${owed.total === 1 ? "Business date" : "Business dates"} still to close: ${dates}. Scheduled closes may have stopped, or the close failed. Check the schedule, and run a daily close if needed.`, count: owed.total, since: schedule.nextAt });
  }
  const switches = Object.entries((state.settings.policyKillSwitches || {}) as Record<string, unknown>).filter(([, on]) => on === true).map(([id]) => id);
  if (state.merchant.killSwitch || switches.length) alerts.push({ key: "kill_switch_active", severity: "info", title: state.merchant.killSwitch ? "Lender emergency stop is on" : "A retry policy emergency stop is on", detail: state.merchant.killSwitch ? "No collection instructions will be planned until an Admin turns off the emergency stop." : `The emergency stop is on for ${counted(switches.length, "retry policy version")}. No collection instructions will be planned under those versions until an Admin turns it off.`, count: switches.length || undefined });
  return alerts.sort((a, b) => order[a.severity] - order[b.severity] || a.key.localeCompare(b.key));
}
