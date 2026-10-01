// Golden tests for the scheduled daily close: the configurable WAT time
// (REC-01, default 07:00), the cursor every close moves, a manual close before
// or after the time, a close that runs late after an outage (NFR-AVA-02), the
// missed-close alert (NFR-OBS-02), the backoff after a failed scheduled attempt
// and the pause of an idle sandbox's automatic close.
import assert from "node:assert/strict";
import { closeRules, closeTimeOf, isCloseTime, nextCloseInstant } from "@workspace/valopay-schema";
import { ctxAt, liveFixture, wat } from "./helpers.js";
import { executeAction, runDailyClose } from "../src/domain/actions.js";
import { closeRetryOf, closeSchedule, nextCloseRetry, owedCloseDates, pauseIdleSandboxClose, rescheduleAfterSettings, scheduledCloseDue, storedCloseCursor } from "../src/domain/close.js";
import { bindCloseReviewBasis, closeReviewCurrentProblem } from "../src/domain/close-review.js";
import { buildAlerts } from "../src/domain/alerts.js";
import { buildOverview, buildReports } from "../src/domain/reports.js";
import { recordsOf } from "../src/domain/records.js";
import { seedMerchant } from "../src/lib/valopay-seed.js";
import { effectiveCloseSchedule, type CloseRuntime } from "../src/domain/effective-close-schedule.js";
import { buildConsoleOverview, buildConsoleReports, buildConsoleSettings } from "../src/lib/valopay-close-views.js";
import * as S from "@workspace/api-zod";

let checks = 0;

// The public API must reflect effective service state, not only the lender preference.
{
  const state = seedMerchant('effective-schedule');
  const now = wat('2027-06-28T08:00:00');
  state.settings.nextCloseAt = wat('2027-06-28T07:00:00');
  const runtime: CloseRuntime = { state: 'off', intervalMs: null, lastTickAt: null, lastSuccessAt: null, lastErrorAt: null };
  const audit = { valid: true, count: 0, headHash: 'GENESIS', verifiedSequence: 0 };
  for (const status of ['off', 'external', 'not_started', 'stopped'] as const) {
    runtime.state = status;
    const overview = S.GetOverviewResponse.parse(buildConsoleOverview(state, now, audit, runtime));
    const reports = S.GetReportsResponse.parse(buildConsoleReports(state, now, runtime));
    const settings = S.GetSettingsResponse.parse(buildConsoleSettings(state, 'Admin', now, runtime));
    assert.equal(overview.nextClose, '', `${status}: no false upcoming automatic run`);
    assert.equal(overview.closeSchedule?.automatic, false);
    assert.equal(overview.closeSchedule?.runtimeState, status);
    assert.equal((reports.operational.closeSchedule as any).nextAt, null);
    assert.equal(settings.closeSchedule?.nextAt, null);
    checks += 5;
  }
  // external: a separate scheduled job runs the closes (VALOPAY_CLOSE_SCHEDULER=external). This process promises no
  // automatic run it cannot see, but a close that job has not run is still missed: the overview raises close_missed
  // and names the date still owed, where scheduling deliberately off does neither.
  {
    const overview = S.GetOverviewResponse.parse(buildConsoleOverview(state, now, audit, { ...runtime, state: 'external' }));
    assert.deepEqual([overview.closeSchedule?.runtimeState, overview.closeSchedule?.serviceIssue, overview.closeSchedule?.missed, overview.closeSchedule?.overdueMinutes], ['external', null, true, 60]);
    assert.match(overview.alerts.find((alert) => alert.key === 'close_missed')?.detail ?? '', /Business date still to close: 27 Jun 2027\./, 'the missed-close alert names the date owed');
    assert.equal((S.GetReportsResponse.parse(buildConsoleReports(state, now, { ...runtime, state: 'external' })).operational.closeSchedule as any).missed, true);
    assert.equal(S.GetSettingsResponse.parse(buildConsoleSettings(state, 'Admin', now, { ...runtime, state: 'external' })).closeSchedule?.missed, true);
    const off = S.GetOverviewResponse.parse(buildConsoleOverview(state, now, audit, { ...runtime, state: 'off' }));
    assert.equal(off.closeSchedule?.missed, false);
    assert.equal(off.alerts.some((alert) => alert.key === 'close_missed'), false, 'with scheduling off nobody runs automatic closes, so none is missed');
    checks += 6;
  }
  runtime.state = 'running';
  assert.equal(effectiveCloseSchedule(state, now, runtime).serviceIssue, 'starting'); checks++;
  runtime.lastSuccessAt = now;
  let view = effectiveCloseSchedule(state, now, runtime);
  assert.equal(view.automatic, true); assert.equal(view.missed, true); assert.equal(view.nextAt, state.settings.nextCloseAt); checks += 3;
  runtime.lastErrorAt = now;
  view = effectiveCloseSchedule(state, now, runtime);
  assert.equal(view.serviceIssue, 'failed'); assert.equal(view.nextAt, null); checks += 2;
  runtime.lastErrorAt = null;
  runtime.lastSuccessAt = wat('2027-06-28T07:00:00');
  view = effectiveCloseSchedule(state, now, runtime);
  assert.equal(view.serviceIssue, 'delayed'); assert.equal(view.automatic, false); checks += 2;
  runtime.lastSuccessAt = now;
  runtime.observedAt = now;
  view = effectiveCloseSchedule(state, wat('2027-06-28T09:00:00'), runtime);
  assert.equal(view.automatic, true, 'heartbeat freshness uses its process clock even when the database schedule clock is ahead');
  assert.equal(view.overdueMinutes, 120, 'the due schedule still uses the database clock'); checks += 2;
  delete runtime.observedAt;
  state.settings.scheduledCloseEnabled = false;
  view = effectiveCloseSchedule(state, now, runtime);
  assert.equal(view.automatic, false); assert.equal(view.nextAt, null); assert.equal(view.missed, false); checks += 3;
}
const quietDeadlines = (state: ReturnType<typeof seedMerchant>) => { for (const exception of recordsOf(state, "exceptions")) exception.data.dueBy = "2028-01-01T00:00:00.000Z"; };

// ---------- The schedule arithmetic: WAT wall clock, strictly after now ----------
{
  assert.equal(closeRules.defaultTime, "07:00", "REC-01 default");
  assert.equal(closeRules.lateAfterMinutes, 30, "7.5: a close has 30 minutes");
  assert.equal(nextCloseInstant(wat("2027-06-28T06:59:59")), wat("2027-06-28T07:00:00"), "before the time: today");
  assert.equal(nextCloseInstant(wat("2027-06-28T07:00:00")), wat("2027-06-29T07:00:00"), "exactly at the time: tomorrow, the next instant is strictly after now");
  assert.equal(nextCloseInstant(wat("2027-06-28T15:30:00")), wat("2027-06-29T07:00:00"), "after the time: tomorrow");
  assert.equal(nextCloseInstant(wat("2027-06-28T23:50:00"), "00:15"), wat("2027-06-29T00:15:00"), "a time just past WAT midnight, computed on the WAT date not the UTC date");
  assert.equal(nextCloseInstant(wat("2027-06-30T00:30:00"), "00:15"), wat("2027-07-01T00:15:00"), "rolls across a month end");
  assert.equal(nextCloseInstant(wat("2027-12-31T09:00:00"), "07:00"), wat("2028-01-01T07:00:00"), "and a year end");
  assert.equal(nextCloseInstant(Date.parse(wat("2027-06-28T06:00:00")), "06:00"), wat("2027-06-29T06:00:00"), "an epoch-millisecond instant is accepted");
  assert.equal(nextCloseInstant(wat("2027-06-28T06:00:00"), "7am"), wat("2027-06-28T07:00:00"), "a malformed time falls back to the default, an hour later that day");
  assert.throws(() => nextCloseInstant("yesterday"), /valid instant/);
  checks += 11;
  assert.equal(isCloseTime("07:00"), true); assert.equal(isCloseTime("23:59"), true); assert.equal(isCloseTime("00:00"), true);
  assert.equal(isCloseTime("24:00"), false); assert.equal(isCloseTime("7:00"), false); assert.equal(isCloseTime("07:60"), false); assert.equal(isCloseTime(7), false);
  assert.equal(closeTimeOf({ closeTime: "09:30" }), "09:30"); assert.equal(closeTimeOf({ closeTime: "" }), "07:00"); assert.equal(closeTimeOf({}), "07:00"); assert.equal(closeTimeOf(undefined), "07:00");
  checks += 11;
}

// ---------- The seed carries the time and the switch; the cursor is set by the repository from the database clock ----------
{
  const state = seedMerchant("schedule-seed");
  assert.equal(state.settings.closeTime, "07:00"); assert.equal(state.settings.scheduledCloseEnabled, true);
  assert.equal(storedCloseCursor(state), null, "no cursor until the repository seeds one");
  const view = closeSchedule(state, wat("2027-06-28T09:00:00"));
  assert.equal(view.nextAt, wat("2027-06-29T07:00:00"), "without a cursor the next instant is derived for display");
  assert.equal(view.missed, false); assert.equal(view.lastAt, null); assert.equal(view.lastTrigger, null);
  assert.equal(scheduledCloseDue(state, wat("2027-06-29T09:00:00")), false, "a merchant without a cursor is never due");
  state.settings.nextCloseAt = "not an instant";
  assert.equal(storedCloseCursor(state), null, "a malformed cursor is ignored");
  checks += 9;
}

// ---------- A manual close before the time leaves the scheduled close pending; the scheduled close runs on time; a manual close after covers a missed one ----------
{
  const { state } = liveFixture({ merchantId: "schedule-manual", withFailure: false });
  quietDeadlines(state);
  state.settings.nextCloseAt = wat("2027-06-28T07:00:00");
  const early = executeAction(state, ctxAt(wat("2027-06-28T06:30:00"), "Finance"), { action: "daily_close" }).record!;
  assert.equal(early.name, "Daily close 28 Jun 2027");
  assert.deepEqual(early.data.schedule, { trigger: "manual", scheduledFor: null, delayMinutes: null, late: false, nextAt: wat("2027-06-28T07:00:00") }, "the 07:00 close is still to come");
  assert.equal(state.settings.nextCloseAt, wat("2027-06-28T07:00:00"), "a manual close before the time does not move the cursor past it");
  assert.equal(scheduledCloseDue(state, wat("2027-06-28T06:59:00")), false);
  assert.equal(scheduledCloseDue(state, wat("2027-06-28T07:00:00")), true, "due at the instant itself");
  checks += 5;

  const onTime = runDailyClose(state, ctxAt(wat("2027-06-28T07:00:30"), "Operations"), "scheduled");
  assert.equal(onTime.record!.name, "Daily close 28 Jun 2027 · scheduled · business date 27 Jun 2027");
  assert.equal(onTime.record!.data.sourceBusinessDate, "2027-06-27", "decision 1: the 07:00 close of 28 June checks the files of 27 June, the day it closes");
  assert.deepEqual(onTime.record!.data.schedule, { trigger: "scheduled", scheduledFor: wat("2027-06-28T07:00:00"), delayMinutes: 0, late: false, nextAt: wat("2027-06-29T07:00:00") });
  assert.equal(onTime.message, "Scheduled daily close of 27 Jun 2027 completed. No data was fetched from the provider or sent to the loan management system.");
  assert.deepEqual(onTime.data.schedule, onTime.record!.data.schedule, "the action result carries the schedule block");
  assert.equal(state.settings.nextCloseAt, wat("2027-06-29T07:00:00"), "the cursor moved to the next 07:00");
  assert.equal(scheduledCloseDue(state, wat("2027-06-28T07:01:00")), false, "not due again until tomorrow");
  assert.equal(onTime.record!.data.period.from, early.data.closedAt, "the period starts where the manual close ended");
  assert.equal(closeSchedule(state, wat("2027-06-28T08:00:00")).lastTrigger, "scheduled");
  checks += 9;

  // The next day the platform is down at 07:00 and a person closes at 07:45: that manual close covers the missed instant, late.
  const catchUp = executeAction(state, ctxAt(wat("2027-06-29T07:45:00"), "Admin"), { action: "daily_close" }).record!;
  assert.deepEqual(catchUp.data.schedule, { trigger: "manual", scheduledFor: wat("2027-06-29T07:00:00"), delayMinutes: 45, late: true, nextAt: wat("2027-06-30T07:00:00") });
  assert.equal(state.settings.nextCloseAt, wat("2027-06-30T07:00:00"));
  assert.equal(scheduledCloseDue(state, wat("2027-06-29T08:00:00")), false, "the scheduler has nothing left to run today");
  checks += 3;
}

// ---------- Recovery: a scheduled close missed while the platform was down runs late and says so (NFR-AVA-02) ----------
{
  const { state } = liveFixture({ merchantId: "schedule-late", withFailure: false });
  quietDeadlines(state);
  state.settings.nextCloseAt = wat("2027-06-28T07:00:00");
  const late = runDailyClose(state, ctxAt(wat("2027-06-28T15:10:00"), "Operations"), "scheduled");
  assert.equal(late.record!.data.schedule.delayMinutes, 490); assert.equal(late.record!.data.schedule.late, true);
  assert.equal(late.message, "Scheduled daily close of 27 Jun 2027 completed about 8 hours after its scheduled time of 07:00 WAT. No data was fetched from the provider or sent to the loan management system.");
  assert.equal(late.record!.data.report.alerts.some((alert: { key: string }) => alert.key === "close_missed"), true, "the report freezes the missed-close alert as it stood when the late close started");
  assert.equal(state.settings.nextCloseAt, wat("2027-06-29T07:00:00"), "the cursor moves to the next day, not to another close today");
  checks += 5;
  // Exactly 30 minutes is not late; 31 is.
  state.settings.nextCloseAt = wat("2027-06-29T07:00:00");
  assert.equal(runDailyClose(state, ctxAt(wat("2027-06-29T07:30:00"), "Operations"), "scheduled").record!.data.schedule.late, false);
  state.settings.nextCloseAt = wat("2027-06-30T07:00:00");
  const justLate = runDailyClose(state, ctxAt(wat("2027-06-30T07:31:00"), "Operations"), "scheduled").record!.data.schedule;
  assert.equal(justLate.late, true); assert.equal(justLate.delayMinutes, 31);
  checks += 3;
}

// ---------- Decision 2: missed scheduled closes are caught up one business date at a time, oldest first, each with its own source evidence and review ----------
{
  const { state } = liveFixture({ merchantId: "schedule-catch-up", withFailure: false });
  quietDeadlines(state);
  state.settings.nextCloseAt = wat("2027-06-28T07:00:00");
  const back = wat("2027-07-01T09:00:00"); // the platform was down from before 07:00 on 28 June
  assert.deepEqual(owedCloseDates(state, back), { dates: ["2027-06-27", "2027-06-28", "2027-06-29", "2027-06-30"], total: 4 }, "the closes of 28, 29 and 30 June and 1 July are owed");
  const missed = buildAlerts(state, back).find((alert) => alert.key === "close_missed")!;
  assert.equal(missed.count, 4);
  assert.match(missed.detail, /Business dates still to close: 27 Jun 2027, 28 Jun 2027, 29 Jun 2027 and 30 Jun 2027\./, "the alert names the dates still owed");
  const closes = [0, 1, 2, 3].map((minute) => {
    const at = new Date(Date.parse(back) + minute * 60_000).toISOString();
    assert.equal(scheduledCloseDue(state, at), true, "still due until every owed date is closed");
    const result = runDailyClose(state, ctxAt(at, "Operations"), "scheduled");
    bindCloseReviewBasis(state, result.record!);
    return result;
  });
  const records = closes.map((result) => result.record!);
  assert.deepEqual(records.map((close) => close.data.sourceBusinessDate), ["2027-06-27", "2027-06-28", "2027-06-29", "2027-06-30"], "one close per missed business date, oldest first");
  assert.deepEqual(records.map((close) => close.data.reviewBasis.sourceCompleteness.businessDate), ["2027-06-27", "2027-06-28", "2027-06-29", "2027-06-30"], "each checks its own date's source files");
  assert.deepEqual(records.map((close) => close.data.schedule.scheduledFor), ["2027-06-28", "2027-06-29", "2027-06-30", "2027-07-01"].map((day) => wat(`${day}T07:00:00`)), "and covers its own scheduled time");
  assert.equal(records[0]!.name, "Daily close 1 Jul 2027 · scheduled · business date 27 Jun 2027");
  assert.equal(new Set(records.map((close) => close.name)).size, 4, "each has its own name");
  assert.equal(closes[0]!.message, "Scheduled daily close of 27 Jun 2027 completed about 3 days after its scheduled time of 07:00 WAT. 3 missed business dates are still to close. No data was fetched from the provider or sent to the loan management system.");
  assert.equal(closes[3]!.message, "Scheduled daily close of 30 Jun 2027 completed about 2 hours after its scheduled time of 07:00 WAT. No data was fetched from the provider or sent to the loan management system.");
  assert.equal(state.settings.nextCloseAt, wat("2027-07-02T07:00:00"), "caught up: the next close is tomorrow's");
  assert.equal(scheduledCloseDue(state, wat("2027-07-01T09:04:00")), false);
  assert.equal(buildAlerts(state, wat("2027-07-01T09:04:00")).some((alert) => alert.key === "close_missed"), false, "the missed-close alert clears once every owed date is closed");
  assert.equal(closeReviewCurrentProblem(state, records[0]!), null, "a later date's close does not stop Finance reviewing an earlier date's");
  const again = executeAction(state, ctxAt(wat("2027-07-01T09:10:00"), "Finance"), { action: "daily_close", data: { sourceBusinessDate: "2027-06-27" } }).record!;
  bindCloseReviewBasis(state, again);
  assert.match(String(closeReviewCurrentProblem(state, records[0]!)), /newer close exists for this business date/, "a newer close of the same date does");
  checks += 16;
}

// ---------- A person's close while scheduled closes are owed takes the place of the oldest; one for another date leaves them owed ----------
{
  const { state } = liveFixture({ merchantId: "schedule-manual-catch-up", withFailure: false });
  quietDeadlines(state);
  state.settings.nextCloseAt = wat("2027-06-29T07:00:00");
  const close = (at: string, sourceBusinessDate?: string) => executeAction(state, ctxAt(wat(at), "Finance"), { action: "daily_close", ...(sourceBusinessDate ? { data: { sourceBusinessDate } } : {}) });
  const other = close("2027-06-30T09:00:00", "2027-06-30");
  assert.deepEqual([other.record!.data.sourceBusinessDate, other.record!.data.schedule.scheduledFor], ["2027-06-30", null], "a close for another date leaves the owed ones owed");
  assert.equal(other.message, "Daily close completed. 2 missed business dates are still to close. No data was fetched from the provider or sent to the loan management system.");
  assert.equal(state.settings.nextCloseAt, wat("2027-06-29T07:00:00"));
  const manual = close("2027-06-30T09:05:00");
  assert.deepEqual([manual.record!.data.sourceBusinessDate, manual.record!.data.schedule.scheduledFor, manual.record!.data.schedule.late], ["2027-06-28", wat("2027-06-29T07:00:00"), true]);
  assert.equal(manual.message, "Daily close of 28 Jun 2027 completed in place of its scheduled close, about 26 hours after its scheduled time of 07:00 WAT. 1 missed business date is still to close. No data was fetched from the provider or sent to the loan management system.");
  assert.equal(state.settings.nextCloseAt, wat("2027-06-30T07:00:00"), "the next owed date is still pending");
  const named = close("2027-06-30T09:10:00", "2027-06-29");
  assert.deepEqual([named.record!.data.sourceBusinessDate, named.record!.data.schedule.scheduledFor], ["2027-06-29", wat("2027-06-30T07:00:00")], "naming the owed date covers it too");
  assert.equal(state.settings.nextCloseAt, wat("2027-07-01T07:00:00"));
  // With the automatic close off nothing is owed, and a close never covers its stale time.
  state.settings.nextCloseAt = wat("2027-06-01T07:00:00"); state.settings.scheduledCloseEnabled = false;
  const off = close("2027-06-30T10:00:00");
  assert.deepEqual([off.record!.data.sourceBusinessDate, off.record!.data.schedule.scheduledFor], ["2027-06-30", null]);
  assert.equal(state.settings.nextCloseAt, wat("2027-06-01T07:00:00"), "switching the close on again replaces the cursor");
  assert.deepEqual(owedCloseDates(state, wat("2027-06-30T10:00:00")), { dates: [], total: 0 });
  checks += 11;
}

// ---------- Audit item 16: a close is named by its WAT date ----------
{
  const { state } = liveFixture({ merchantId: "schedule-wat-name", withFailure: false });
  quietDeadlines(state);
  state.settings.nextCloseAt = wat("2027-07-01T07:00:00");
  const early = executeAction(state, ctxAt(wat("2027-07-01T00:30:00"), "Finance"), { action: "daily_close" }).record!;
  assert.equal(early.name, "Daily close 1 Jul 2027", "00:30 WAT on 1 July is still 30 June in UTC");
  assert.equal(early.data.sourceBusinessDate, "2027-07-01");
  checks += 2;
}

// ---------- The alert, the schedule view, the overview and the report ----------
{
  const { state } = liveFixture({ merchantId: "schedule-alert", withFailure: false });
  quietDeadlines(state);
  state.settings.nextCloseAt = wat("2027-06-28T07:00:00");
  const keys = (now: string) => buildAlerts(state, now).map((alert) => alert.key);
  assert.deepEqual(keys(wat("2027-06-28T07:30:00")), ["close_overdue"], "30 minutes past its time is not yet missed");
  assert.deepEqual(keys(wat("2027-06-28T07:31:00")), ["close_missed", "close_overdue"], "31 minutes past: missed, high before medium");
  const alert = buildAlerts(state, wat("2027-06-28T09:00:00")).find((item) => item.key === "close_missed")!;
  assert.equal(alert.severity, "high"); assert.equal(alert.since, wat("2027-06-28T07:00:00")); assert.match(alert.detail, /07:00 WAT is 2 hours late/);
  checks += 5;
  state.settings.scheduledCloseEnabled = false;
  assert.deepEqual(keys(wat("2027-06-28T09:00:00")), ["close_overdue"], "no missed-close alert when the automatic close is off");
  assert.equal(scheduledCloseDue(state, wat("2027-06-28T09:00:00")), false, "and nothing is due");
  assert.equal(buildOverview(state, wat("2027-06-28T09:00:00")).nextClose, "", "the overview shows no next close when the automatic close is off");
  state.settings.scheduledCloseEnabled = true;
  assert.deepEqual(closeSchedule(state, wat("2027-06-28T09:00:00")), { time: "07:00", enabled: true, nextAt: wat("2027-06-28T07:00:00"), missed: true, overdueMinutes: 120, lateAfterMinutes: 30, lastAt: null, lastTrigger: null, failedAttempts: 0, retryAt: null, pausedForInactivityAt: null });
  checks += 4;
  // A configured time other than the default: the route recomputes the cursor from the new time.
  state.settings.closeTime = "09:30";
  state.settings.nextCloseAt = nextCloseInstant(wat("2027-06-28T09:00:00"), closeTimeOf(state.settings));
  assert.equal(state.settings.nextCloseAt, wat("2027-06-28T09:30:00"));
  const overview = buildOverview(state, wat("2027-06-28T09:00:00"));
  assert.equal(overview.nextClose, wat("2027-06-28T09:30:00")); assert.equal(overview.closeTime, "09:30");
  assert.equal(buildReports(state, wat("2027-06-28T09:00:00")).operational.closeSchedule.nextAt, wat("2027-06-28T09:30:00"));
  runDailyClose(state, ctxAt(wat("2027-06-28T09:30:00"), "Operations"), "scheduled");
  const after = closeSchedule(state, wat("2027-06-28T09:31:00"));
  assert.equal(after.lastTrigger, "scheduled"); assert.equal(after.lastAt, wat("2027-06-28T09:30:00")); assert.equal(after.nextAt, wat("2027-06-29T09:30:00")); assert.equal(after.missed, false);
  assert.equal(recordsOf(state, "closes").at(-1)!.data.schedule!.nextAt, wat("2027-06-29T09:30:00"));
  checks += 9;
}

// ---------- Settings changes: only a changed time or a switch-on moves the cursor; an unchanged save leaves a missed close pending ----------
{
  const state = seedMerchant("schedule-settings");
  const now = wat("2027-06-28T09:00:00");
  state.settings.nextCloseAt = wat("2027-06-28T07:00:00"); // missed two hours ago
  const previous = () => ({ time: closeTimeOf(state.settings), enabled: state.settings.scheduledCloseEnabled !== false });
  let before = previous();
  Object.assign(state.settings, { closeTime: "07:00", scheduledCloseEnabled: true, contactRoute: "Call the branch" });
  assert.equal(rescheduleAfterSettings(state, before, now), false, "the console saves the whole form; unchanged close fields do not move the cursor");
  assert.equal(state.settings.nextCloseAt, wat("2027-06-28T07:00:00"), "the missed close is still pending for the scheduler to catch up");
  before = previous(); state.settings.closeTime = "09:30";
  assert.equal(rescheduleAfterSettings(state, before, now), true, "a new time reschedules");
  assert.equal(state.settings.nextCloseAt, wat("2027-06-28T09:30:00"));
  before = previous(); state.settings.scheduledCloseEnabled = false;
  assert.equal(rescheduleAfterSettings(state, before, now), false, "switching off leaves the cursor");
  assert.equal(scheduledCloseDue(state, wat("2027-06-28T10:00:00")), false, "but nothing is due while off");
  state.settings.nextCloseAt = wat("2027-06-20T09:30:00"); // a week passes while off
  before = previous(); state.settings.scheduledCloseEnabled = true;
  assert.equal(rescheduleAfterSettings(state, before, now), true, "switching on restarts from the next occurrence, not the stale cursor");
  assert.equal(state.settings.nextCloseAt, wat("2027-06-28T09:30:00"));
  before = previous(); state.settings.scheduledCloseEnabled = true;
  assert.equal(rescheduleAfterSettings(state, before, now), false, "already on: no change");
  checks += 9;
}

// ---------- A failed scheduled attempt backs off; any close or a rescheduling save clears it; an idle sandbox is paused ----------
{
  const { state } = liveFixture({ merchantId: "schedule-retry", withFailure: false });
  quietDeadlines(state);
  const at = wat("2027-06-28T07:00:00");
  state.settings.nextCloseAt = at;
  const first = nextCloseRetry(state.settings, wat("2027-06-28T07:05:00"));
  assert.deepEqual(first, { cursor: at, failures: 1, retryAt: wat("2027-06-28T07:07:00"), lastFailedAt: wat("2027-06-28T07:05:00") }, "the first failure waits two minutes");
  state.settings.closeRetry = first;
  assert.equal(scheduledCloseDue(state, wat("2027-06-28T07:06:00")), false, "not due again before its retry time, whichever instance looks");
  assert.equal(scheduledCloseDue(state, wat("2027-06-28T07:07:00")), true, "due again at its retry time");
  const retrying = closeSchedule(state, wat("2027-06-28T07:06:00"));
  assert.equal(retrying.failedAttempts, 1); assert.equal(retrying.retryAt, wat("2027-06-28T07:07:00")); assert.equal(retrying.pausedForInactivityAt, null);
  assert.equal(retrying.nextAt, at, "the close stays pending at its own time");
  assert.equal(closeSchedule(state, wat("2027-06-28T07:40:00")).missed, true, "a close still failing past 30 minutes is missed");
  checks += 8;

  // The delay doubles from two minutes and stops at an hour; it never gives up.
  let settings: Record<string, unknown> = { nextCloseAt: at }, now = wat("2027-06-28T07:05:00");
  const delays: number[] = [];
  for (let attempt = 1; attempt <= 7; attempt += 1) {
    const retry = nextCloseRetry(settings, now)!;
    assert.equal(retry.failures, attempt); assert.equal(retry.cursor, at);
    delays.push((Date.parse(retry.retryAt) - Date.parse(now)) / 60_000);
    settings = { ...settings, closeRetry: retry };
    now = retry.retryAt;
  }
  assert.deepEqual(delays, [2, 4, 8, 16, 32, 60, 60]);
  checks += 15;

  // A retry belongs to one close time: once the cursor moves, it is inert and the count restarts.
  assert.equal(closeRetryOf({ nextCloseAt: wat("2027-06-29T07:00:00"), closeRetry: first }), null, "a retry left from an earlier time is ignored");
  assert.equal(nextCloseRetry({ nextCloseAt: wat("2027-06-29T07:00:00"), closeRetry: first }, wat("2027-06-29T07:03:00"))!.failures, 1, "and the count restarts");
  assert.equal(nextCloseRetry({ nextCloseAt: wat("2027-06-29T07:00:00") }, wat("2027-06-28T09:00:00")), null, "a close not yet due has nothing to retry");
  assert.equal(nextCloseRetry({}, wat("2027-06-28T09:00:00")), null, "nor has a lender without a cursor");
  assert.equal(closeRetryOf({ nextCloseAt: at, closeRetry: { ...first!, failures: 0 } }), null, "a malformed count is ignored");
  assert.equal(closeRetryOf({ nextCloseAt: at, closeRetry: { ...first!, retryAt: "soon" } }), null, "and so is a malformed time");
  checks += 6;

  // Any close ends the retry, scheduled or manual.
  runDailyClose(state, ctxAt(wat("2027-06-28T07:07:00"), "Operations"), "scheduled");
  assert.equal(state.settings.closeRetry, undefined, "a scheduled close clears the retry");
  const closed = closeSchedule(state, wat("2027-06-28T07:08:00"));
  assert.equal(closed.failedAttempts, 0); assert.equal(closed.retryAt, null);
  state.settings.nextCloseAt = wat("2027-06-29T07:00:00");
  state.settings.closeRetry = nextCloseRetry(state.settings, wat("2027-06-29T07:02:00"));
  executeAction(state, ctxAt(wat("2027-06-29T07:03:00"), "Finance"), { action: "daily_close" });
  assert.equal(state.settings.closeRetry, undefined, "a manual close clears it too");
  checks += 4;

  // An unchanged save keeps a pending retry; a new close time starts afresh without it.
  state.settings.nextCloseAt = wat("2027-06-30T07:00:00");
  state.settings.closeRetry = nextCloseRetry(state.settings, wat("2027-06-30T07:02:00"));
  const previous = () => ({ time: closeTimeOf(state.settings), enabled: state.settings.scheduledCloseEnabled !== false });
  let before = previous();
  assert.equal(rescheduleAfterSettings(state, before, wat("2027-06-30T07:03:00")), false);
  assert.equal(closeRetryOf(state.settings)?.failures, 1, "an unchanged save keeps the retry");
  before = previous(); state.settings.closeTime = "08:00";
  assert.equal(rescheduleAfterSettings(state, before, wat("2027-06-30T07:03:00")), true);
  assert.equal(state.settings.closeRetry, undefined, "a new time drops the retry");
  assert.equal(state.settings.nextCloseAt, wat("2027-06-30T08:00:00"));
  checks += 5;

  // An idle sandbox: the automatic close is switched off, recorded and explained; switching it on resumes from the next time.
  state.settings.nextCloseAt = wat("2027-07-01T08:00:00");
  state.settings.closeRetry = nextCloseRetry(state.settings, wat("2027-07-01T08:01:00"));
  pauseIdleSandboxClose(state, wat("2027-07-01T08:02:00"));
  assert.equal(state.settings.scheduledCloseEnabled, false); assert.equal(state.settings.closePausedForInactivityAt, wat("2027-07-01T08:02:00"));
  assert.equal(state.settings.closeRetry, undefined, "a paused close has nothing to retry");
  const paused = closeSchedule(state, wat("2027-07-01T10:00:00"));
  assert.equal(paused.enabled, false); assert.equal(paused.missed, false, "a paused close is not missed");
  assert.equal(paused.pausedForInactivityAt, wat("2027-07-01T08:02:00")); assert.equal(paused.failedAttempts, 0); assert.equal(paused.retryAt, null);
  assert.equal(scheduledCloseDue(state, wat("2027-07-01T10:00:00")), false);
  before = previous(); state.settings.scheduledCloseEnabled = true;
  assert.equal(rescheduleAfterSettings(state, before, wat("2027-07-03T09:00:00")), true, "switching on again reschedules");
  assert.equal(state.settings.closePausedForInactivityAt, undefined, "and ends the pause");
  assert.equal(state.settings.nextCloseAt, wat("2027-07-04T08:00:00"), "from the next configured time, not the stale one");
  assert.equal(closeSchedule(state, wat("2027-07-03T09:00:00")).pausedForInactivityAt, null);
  checks += 13;

  // The effective view shows the retry time only while the automatic close is available.
  state.settings.nextCloseAt = wat("2027-07-04T08:00:00");
  state.settings.closeRetry = nextCloseRetry(state.settings, wat("2027-07-04T08:01:00"));
  const nowRetrying = wat("2027-07-04T08:02:00");
  const runtime: CloseRuntime = { state: "running", intervalMs: 60_000, lastTickAt: nowRetrying, lastSuccessAt: nowRetrying, lastErrorAt: null, observedAt: nowRetrying };
  const effective = effectiveCloseSchedule(state, nowRetrying, runtime);
  assert.equal(effective.automatic, true); assert.equal(effective.failedAttempts, 1); assert.equal(effective.retryAt, wat("2027-07-04T08:03:00"));
  assert.equal(effectiveCloseSchedule(state, nowRetrying, { ...runtime, state: "off" }).retryAt, null, "no retry is promised while the service is off");
  checks += 4;

  // The public schemas carry the new fields, and a settings answer saved by an earlier build (without them) still replays.
  const answer = buildConsoleSettings(state, "Admin", nowRetrying, runtime);
  const parsed = S.GetSettingsResponse.parse(answer).closeSchedule!;
  assert.equal(parsed.failedAttempts, 1); assert.equal(parsed.retryAt, wat("2027-07-04T08:03:00")); assert.equal(parsed.pausedForInactivityAt, null);
  const stored = structuredClone(answer) as { closeSchedule: Record<string, unknown> };
  for (const field of ["failedAttempts", "retryAt", "pausedForInactivityAt"]) delete stored.closeSchedule[field];
  assert.doesNotThrow(() => S.UpdateSettingsResponse.parse(stored), "an earlier build's stored receipt still parses");
  checks += 4;
}

console.log(`Close schedule golden tests passed (${checks} checks): WAT arithmetic, seed, manual and scheduled closes, catch-up, lateness, missed-close alert, overview and report views, settings changes, retry backoff and the idle pause.`);
