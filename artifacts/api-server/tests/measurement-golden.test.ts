// Golden tests for the spec gaps closed after the first review: RET-03 decision
// records, REC-07 close report, RET-06 uplift report with its 90% interval and
// BIL-01 billable collections (TRD v1.1 sections 5.6, 5.8, 5.15, 6.6 and 7.5).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DAY, HOUR, addAttempt, addHoliday, addNotice, addObservation, ctxAt, liveFixture, toWat, wat } from "./helpers.js";
import { reconcile } from "../src/domain/reconciliation.js";
import { executeAction } from "../src/domain/actions.js";
import { armStatistics, buildReports, precisionAudit, timeToClose, upliftReport, billableCollection } from "../src/domain/reports.js";
import { monthOf } from "../src/domain/billing.js";
import { decisionFingerprint, evaluateRetry, latestDecisionFor, type RetryDecision } from "../src/domain/policy-engine.js";
import { positionFor } from "../src/domain/close.js";
import { makeRecord, recordsOf } from "../src/domain/records.js";
import { seedMerchant } from "../src/lib/valo-pay-1-seed.js";
import { customerTimeline } from "../src/domain/timeline.js";
import type { DomainState, ValopayRecord } from "../src/domain/types.js";

const { assertFinalState } = await import("../src/lib/valo-pay-1-store.js");
let checks = 0;
const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks += 1; };
const decisionsFor = (state: DomainState, due: ValopayRecord) => recordsOf(state, "retry-decisions").filter((item) => item.data.dueItemId === due.id);
/**
 * Every record read back as the store reads it: the data is jsonb, which
 * leaves out undefined values and gives every object's keys back shorter
 * first, then by their bytes, not in the order they were written.
 */
const throughDatabase = (state: DomainState) => {
  const jsonbOrder = ([a]: [string, unknown], [b]: [string, unknown]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
  state.records = state.records.map((record) => ({ ...record, data: JSON.parse(JSON.stringify(record.data), (_key, value: unknown) => (
    value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(jsonbOrder)) : value)) }));
};

// ---------- RET-03: every close records the decision with its version, row, inputs, time and notice; unchanged decisions are not repeated ----------
{
  const { state, due, policy } = liveFixture({ merchantId: "decisions" });
  const failed = recordsOf(state, "attempts").find((item) => item.data.dueItemId === due.id)!;
  const notice = addNotice(state, due, wat("2027-06-28T09:00:08"));
  failed.data.noticeId = notice.id;
  const first = reconcile(state, ctxAt(wat("2027-06-28T09:01:00"), "Finance"));
  const recorded = decisionsFor(state, due);
  assert.equal(recorded.length, 1, "one decision record after the first close");
  const decision = recorded[0]!;
  assert.equal(decision.status, "recorded");
  assert.equal(decision.customerId, due.customerId, "the decision sits on the customer timeline");
  assert.equal(decision.data.decision, "would_schedule");
  assert.equal(decision.data.rule, "plan");
  assert.equal(decision.data.policyId, policy.id);
  assert.equal(decision.data.policyVersion, 1, "policy version recorded");
  assert.equal(decision.data.attemptId, failed.id, "the failed attempt it follows");
  assert.equal(toWat(decision.data.nextAt), "2027-06-30T06:16:00", "scheduled time recorded");
  assert.equal(decision.data.inputs.code, "INSUFFICIENT_FUNDS");
  assert.equal(decision.data.inputs.attemptNumber, 1);
  assert.equal(decision.data.inputs.ceiling, 3);
  assert.deepEqual(decision.data.inputs.noticeEvidence, { noticeId: notice.id, acceptedAt: notice.data.acceptedAt }, "notice evidence recorded");
  assert.deepEqual((decision.data.inputs.calendar as { holidaysApplied: string[] }).holidaysApplied, [], "calendar inputs recorded");
  assert.equal(decision.data.noticeRequired!.purpose, "failed_debit");
  assert.equal(decision.data.noticeRequired!.evidenced, true);
  assert.equal(toWat(decision.data.noticeRequired!.requiredBy), "2027-06-29T06:16:00", "the notice it requires, due 24 hours before the attempt");
  assert.equal(decision.data.experimentArm, null, "no experiment enrolled: the arm is recorded as null");
  assert.equal(first.data.retryDecisionsRecorded >= 1, true);
  checks += 17;

  reconcile(state, ctxAt(wat("2027-06-28T12:00:00"), "Finance"));
  assert.equal(decisionsFor(state, due).length, 1, "the same decision at a later close is not written twice");
  addHoliday(state, "2027-06-30");
  reconcile(state, ctxAt(wat("2027-06-29T07:00:00"), "Finance"));
  const moved = decisionsFor(state, due);
  assert.equal(moved.length, 2, "a changed plan is a new decision");
  assert.equal(toWat(moved[1]!.data.nextAt), "2027-07-01T06:00:00", "the holiday rolls the plan to Thursday at the window start");
  assert.deepEqual((moved[1]!.data.inputs.calendar as { holidaysApplied: string[] }).holidaysApplied, ["2027-06-30"], "the holiday that moved the plan is recorded");
  assert.equal(moved[1]!.data.previousDecisionId, moved[0]!.id, "decisions chain to the one they replace");
  assert.equal(latestDecisionFor(state, due.id)?.id, moved[1]!.id);
  check(customerTimeline(state, due.customerId).events.some((event) => event.kind === "retry-decisions"), "AUD-01: the timeline carries every retry decision");
  const before = structuredClone(state);
  moved[0]!.data.reason = "edited";
  assert.throws(() => assertFinalState(before, state, state.merchant.id), /Saved evidence cannot be changed\. Reload the page and try again\./, "decision records are immutable evidence");
  checks += 7;
}

// ---------- RET-03 (audit item 13): new notice evidence, or any other changed input, is a new decision; the evaluation clock is not ----------
{
  const { state, due, policy } = liveFixture({ merchantId: "decision-evidence" });
  const failed = recordsOf(state, "attempts").find((item) => item.data.dueItemId === due.id)!;
  reconcile(state, ctxAt(wat("2027-06-28T09:01:00"), "Finance"));
  const [pending] = decisionsFor(state, due);
  assert.equal(pending!.data.noticeRequired!.evidenced, false, "planned before the failed-debit notice was accepted");
  failed.data.noticeId = addNotice(state, due, wat("2027-06-28T10:00:00")).id;
  reconcile(state, ctxAt(wat("2027-06-28T11:00:00"), "Finance"));
  const evidenced = decisionsFor(state, due);
  assert.equal(evidenced.length, 2, "the provider's acceptance of the notice is a new decision");
  assert.equal(evidenced[1]!.data.nextAt, pending!.data.nextAt, "even though the planned time is the same");
  assert.deepEqual([evidenced[1]!.data.noticeRequired!.evidenced, evidenced[1]!.data.noticeRequired!.noticeId], [true, failed.data.noticeId], "the new record carries the evidence");
  assert.equal(evidenced[1]!.data.previousDecisionId, pending!.id, "and chains to the decision it replaces");
  reconcile(state, ctxAt(wat("2027-06-28T12:00:00"), "Finance"));
  assert.equal(decisionsFor(state, due).length, 2, "nothing changed afterwards, so nothing is written");
  checks += 6;

  // What makes two evaluations the same decision, compared at every depth.
  const base = evaluateRetry(state, ctxAt(wat("2027-06-28T12:00:00")), due, policy);
  const same = (variant: RetryDecision) => decisionFingerprint(variant) === decisionFingerprint(base);
  assert.equal(same({ ...base, inputs: { ...base.inputs, code: "ACCOUNT_CLOSED" } }), false, "a different failure code");
  assert.equal(same({ ...base, inputs: { ...base.inputs, attemptNumber: 2 } }), false, "a different attempt number");
  assert.equal(same({ ...base, noticeRequired: { ...base.noticeRequired!, evidenced: false, noticeId: null, acceptedAt: null } }), false, "notice evidence withdrawn");
  assert.equal(same({ ...base, evaluatedAt: wat("2027-06-28T13:00:00"), reason: "Reworded." }), true, "the evaluation time and wording are not part of the decision");
  assert.equal(same({ ...base, inputs: { ...base.inputs, calendar: { earliestAt: wat("2027-06-28T13:00:00"), rolledForward: true } } }), true, "nor is the calendar working, which follows the evaluation clock");
  checks += 5;
}
{
  // Outside the collection window the calendar working moves with the clock, but the plan does not: one decision.
  const { state, due } = liveFixture({ merchantId: "decision-clock", failureAt: wat("2027-06-25T06:16:00") });
  const failed = recordsOf(state, "attempts").find((item) => item.data.dueItemId === due.id)!;
  failed.data.noticeId = addNotice(state, due, wat("2027-06-25T07:00:00")).id;
  reconcile(state, ctxAt(wat("2027-06-28T11:00:00"), "Finance"));
  reconcile(state, ctxAt(wat("2027-06-28T15:00:00"), "Finance"));
  assert.equal(decisionsFor(state, due).length, 1, "a close later the same day reaches the same decision");
  checks += 1;
}
{
  // A decision recorded by an earlier build carries the fingerprint that left out nested inputs; after the database round trip, which reorders its keys, it is still recognised.
  const { state, due } = liveFixture({ merchantId: "decision-legacy" });
  reconcile(state, ctxAt(wat("2027-06-28T09:01:00"), "Finance"));
  const stored = decisionsFor(state, due)[0]!;
  const { evaluatedAt: _evaluatedAt, reason: _reason, fingerprint: _fingerprint, previousDecisionId: _previous, synthetic: _synthetic, ...rest } = stored.data;
  stored.data.fingerprint = createHash("sha256").update(JSON.stringify(rest, Object.keys(rest).sort())).digest("hex");
  throughDatabase(state);
  assert.notDeepEqual(Object.keys(decisionsFor(state, due)[0]!.data.inputs), Object.keys(rest.inputs), "the round trip gives the inputs back in another key order");
  reconcile(state, ctxAt(wat("2027-06-28T12:00:00"), "Finance"));
  assert.equal(decisionsFor(state, due).length, 1, "the stored decision is not written again");
  // An input left undefined (the code of an attempt still in flight) is absent after the round trip, and is the same decision.
  addAttempt(state, due, { status: "unknown", occurredAt: wat("2027-06-30T07:00:00") });
  reconcile(state, ctxAt(wat("2027-06-30T09:00:00"), "Finance"));
  const inFlight = decisionsFor(state, due);
  assert.equal(inFlight.at(-1)!.data.rule, "in_flight", "an attempt in flight blocks the plan");
  throughDatabase(state);
  reconcile(state, ctxAt(wat("2027-06-30T09:30:00"), "Finance"));
  assert.equal(decisionsFor(state, due).length, inFlight.length, "and is not written again after the round trip");
  checks += 4;
}

// ---------- RET-03 and 6.3 row 8: a notice deadline that passes unevidenced defers the attempt and raises the exception ----------
{
  const { state, due } = liveFixture({ merchantId: "deferral" });
  reconcile(state, ctxAt(wat("2027-06-28T10:00:00"), "Finance"));
  assert.equal(decisionsFor(state, due).at(-1)!.data.decision, "would_schedule", "planned, notice pending");
  assert.equal(recordsOf(state, "exceptions").filter((item) => item.data.type === "notice_not_evidenced" && item.data.linkedRecordId === due.id).length, 0, "no exception before the deadline");
  reconcile(state, ctxAt(wat("2027-06-29T06:17:00"), "Finance"));
  const deferred = decisionsFor(state, due).at(-1)!;
  assert.equal(deferred.data.decision, "defer");
  assert.equal(deferred.data.rule, "notice_not_evidenced");
  assert.equal(recordsOf(state, "exceptions").filter((item) => item.data.type === "notice_not_evidenced" && item.data.linkedRecordId === due.id).length, 1, "one notice-not-evidenced exception with the Operations owner");
  reconcile(state, ctxAt(wat("2027-06-29T08:00:00"), "Finance"));
  assert.equal(recordsOf(state, "exceptions").filter((item) => item.data.type === "notice_not_evidenced" && item.data.linkedRecordId === due.id).length, 1, "the exception is not duplicated by the next close");
  checks += 6;
}

// ---------- RET-05: the arm is recorded on the decision once enrolment assigns it ----------
{
  const { state, due, policy } = liveFixture({ merchantId: "arm-on-decision" });
  makeRecord(state, "experiments", { name: "Test 2", status: "preregistered", data: { policyId: policy.id, holdoutShare: 0.5, minPerArm: 1, seed: "seed", baselineRate: 0.4, analysisDate: "2028-01-31", enrolmentClose: "2027-12-31", preregisteredAt: "2027-02-01T00:00:00.000Z" } });
  reconcile(state, ctxAt(wat("2027-06-28T10:00:00"), "Finance"));
  const decision = decisionsFor(state, due).at(-1)!;
  assert.ok(["engine", "holdout"].includes(String(decision.data.experimentArm)), "the arm assigned at the first failure is on the decision");
  assert.equal(decision.data.experimentArm, due.data.experimentArm);
  checks += 2;
}

// ---------- REC-07: the daily close report ----------
{
  const { state, due, customer } = liveFixture({ withFailure: false, merchantId: "close-report" });
  const finance = ctxAt(wat("2027-06-30T07:00:00"), "Finance");
  const openingUnallocated = recordsOf(state, "payments").filter((item) => item.status === "unallocated").length;
  const outstandingBefore = positionFor(state, customer.id).outstandingKobo;
  // The first close covers the seeded history too, so the seeded webhook observations and R1 allocations are in its period.
  const seededWebhook = recordsOf(state, "observations").filter((item) => item.data.source === "webhook").length;
  const seededR1 = recordsOf(state, "allocations").filter((item) => item.status === "confirmed" && item.data.rule === "R1");
  const seededR1Kobo = seededR1.reduce((sum, item) => sum + item.amountKobo, 0);
  addObservation(state, { reference: "PSK-88213", amountKobo: due.amountKobo, source: "webhook", customerId: customer.id, dueItemId: due.id, eventId: "evt-1", occurredAt: wat("2027-06-30T06:20:00"), createdAt: wat("2027-06-30T06:20:01") });
  const first = executeAction(state, finance, { action: "daily_close" });
  const close = recordsOf(state, "closes").at(-1)!;
  assert.equal(first.record?.id, close.id);
  const report = close.data.report;
  assert.equal(close.data.period!.from, null, "the first close covers everything before it");
  assert.equal(close.data.period!.to, finance.now);
  assert.equal(report.openingUnallocated.count, openingUnallocated, "opening unallocated is the count before reconciliation ran");
  assert.equal(report.observations.bySource.webhook.received, seededWebhook + 1, "observations received by source");
  assert.equal(report.observations.bySource.webhook.paymentsResolvedTo, seededWebhook + 1, "and the Payments they resolved to");
  assert.equal(report.observations.bySource.webhook.unresolved, 0);
  assert.equal(report.allocatedByRule.R1.count, seededR1.length + 1, "allocated by rule");
  assert.equal(report.allocatedByRule.R1.kobo, seededR1Kobo + due.amountKobo);
  assert.equal(report.allocatedByRule.R1.automatic, seededR1.filter((item) => item.data.automatic === true).length + 1);
  assert.equal(typeof report.proposed.count, "number");
  assert.equal(typeof report.unallocated.olderThan24Hours, "number");
  assert.equal(typeof report.variances.count, "number");
  assert.equal(typeof report.exceptions.opened.count, "number");
  assert.equal(typeof report.exceptions.closed.count, "number");
  const changed = report.customerPositionsChanged.find((item) => item.customerId === customer.id);
  assert.ok(changed, "the customer whose position changed is listed");
  assert.equal(changed.before!.outstandingKobo, outstandingBefore);
  assert.equal(changed.after.outstandingKobo, outstandingBefore - due.amountKobo, "before and after positions");
  assert.equal(report.positionRebuild.alert, false, "REC-05: the rebuilt positions agree with the stored view");
  assert.equal(report.positionRebuild.mismatches.length, 0);
  checks += 19;

  const second = executeAction(state, ctxAt(wat("2027-07-01T07:00:00"), "Finance"), { action: "daily_close" });
  const next = recordsOf(state, "closes").at(-1)!;
  assert.notEqual(next.id, close.id);
  assert.equal(next.data.period!.from, close.data.closedAt, "the next close starts where the last one ended");
  assert.equal(next.data.report.observations.received, 0, "nothing new arrived");
  assert.equal(next.data.report.customerPositionsChanged.length, 0, "no position changed");
  assert.equal(second.data.positionAlert, false);
  const stored = structuredClone(state);
  next.data.summary = "edited";
  assert.throws(() => assertFinalState(stored, state, state.merchant.id), /Saved evidence cannot be changed\. Reload the page and try again\./, "close reports are immutable evidence");
  // A stored outstanding balance that drifts from the allocations is an alert on the next close.
  next.data.summary = stored.records.find((item) => item.id === next.id)!.data.summary;
  due.data.outstandingKobo = 100;
  executeAction(state, ctxAt(wat("2027-07-02T07:00:00"), "Finance"), { action: "daily_close" });
  const drifted = recordsOf(state, "closes").at(-1)!;
  assert.equal(drifted.data.positionAlert, true, "REC-05: a rebuild that differs from the stored view is an alert");
  assert.equal(drifted.data.report.positionRebuild.mismatches[0].dueItemId, due.id);
  assert.equal(buildReports(state, wat("2027-08-01T09:00:00")).operational.timeToClose?.month, "2027-07", "MEA-01 time to close looks at the last month end");
  assert.equal(buildReports(state, wat("2027-08-01T00:30:00")).operational.timeToClose?.month, "2027-07", "July has ended at 00:30 WAT on 1 August, though it is still July in UTC");
  checks += 10;
}

// ---------- MEA-01 and REC-09 count months in West Africa Time ----------
{
  const { state, customer, due } = liveFixture({ withFailure: false, merchantId: "wat-months" });
  // A clean close at 00:30 WAT on 1 August is the first close after July's month end.
  makeRecord(state, "closes" as string, { name: "Synthetic close", status: "completed", data: { closedAt: wat("2027-08-01T00:30:00"), report: { unallocated: { count: 0, kobo: 0, olderThan24Hours: 0 } } } });
  const closed = timeToClose(state, wat("2027-08-02T09:00:00"))!;
  assert.deepEqual([closed.month, closed.days], ["2027-07", 0.02], "July's books closed half an hour after its WAT month end");
  // An automatic match confirmed at 00:30 WAT on 1 July is July's; one at 00:15 WAT on 1 August is August's.
  const confirmed = (confirmedAt: string) => makeRecord(state, "allocations", { name: "R1", status: "confirmed", customerId: customer.id, amountKobo: 100, createdAt: confirmedAt, data: { paymentId: "p", dueItemId: due.id, rule: "R1", confidence: "certain", automatic: true, confirmedAt } });
  const july = confirmed(wat("2027-07-01T00:30:00"));
  confirmed(wat("2027-08-01T00:15:00"));
  const audit = precisionAudit(state, wat("2027-08-01T00:30:00"));
  assert.deepEqual([audit.month, audit.sampledAllocationIds], ["2027-07", [july.id]], "at 00:30 WAT on 1 August the audit month is July, and it holds July's WAT matches");
  checks += 2;
}

// ---------- REC-07: a close counts the matches confirmed in its period, not matches reviewed or edited in it ----------
{
  const { state, due, customer } = liveFixture({ withFailure: false, merchantId: "close-confirmed-at" });
  const finance = (now: string) => ctxAt(now, "Finance");
  const close = (now: string) => executeAction(state, finance(now), { action: "daily_close" }).record!.data.report;
  addObservation(state, { reference: "PSK-CONF-1", amountKobo: due.amountKobo, source: "webhook", customerId: customer.id, dueItemId: due.id, eventId: "conf-1", occurredAt: wat("2027-06-30T06:20:00"), createdAt: wat("2027-06-30T06:20:01") });
  close(wat("2027-06-30T07:00:00"));
  const matched = recordsOf(state, "allocations").find((item) => item.status === "confirmed" && item.data.dueItemId === due.id)!;
  assert.equal(matched.data.confirmedAt, wat("2027-06-30T07:00:00"), "the automatic match records when it was confirmed");
  // A proposal made in one period and confirmed in the next counts in the period it was confirmed in.
  const other = recordsOf(state, "due-items").find((item) => item.amountKobo === 6_000_000)!;
  other.data.dueDate = "2027-07-01";
  addObservation(state, { reference: "TRF-CONF-2", amountKobo: 6_000_000, source: "transfer", customerId: other.customerId, eventId: "conf-2", occurredAt: wat("2027-07-01T09:00:00"), createdAt: wat("2027-07-01T09:00:01") });
  const proposing = close(wat("2027-07-01T10:00:00"));
  const proposal = recordsOf(state, "allocations").find((item) => item.data.dueItemId === other.id)!;
  assert.deepEqual([proposal.status, proposal.data.rule, proposing.allocated.count], ["proposed", "R5", 0], "a proposal is not an allocation");
  const payment = recordsOf(state, "payments").find((item) => item.reference === "TRF-CONF-2")!;
  executeAction(state, finance(wat("2027-07-02T09:00:00")), { action: "confirm_allocation", recordId: payment.id, reason: "Payer confirmed by phone", data: { proposalId: proposal.id, proposalUpdatedAt: proposal.updatedAt } });
  const confirming = close(wat("2027-07-03T07:00:00"));
  assert.deepEqual([confirming.allocated, confirming.allocatedByRule], [{ count: 1, kobo: 6_000_000 }, { R5: { count: 1, kobo: 6_000_000, automatic: 0 } }], "the confirmation counts once, in its own period");
  // Reviewing earlier matches changes them, but confirms nothing new.
  executeAction(state, finance(wat("2027-07-03T09:00:00")), { action: "review_allocation", recordId: matched.id, reason: "Checked against the bank line", data: { correct: true } });
  executeAction(state, finance(wat("2027-07-03T09:05:00")), { action: "review_allocation", recordId: proposal.id, reason: "Checked against the bank line", data: { correct: true } });
  const reviewed = close(wat("2027-07-04T07:00:00"));
  assert.deepEqual([reviewed.allocated, reviewed.allocatedByRule], [{ count: 0, kobo: 0 }, {}], "a review in this period is not a match confirmed in it");
  assert.match(String(recordsOf(state, "closes").at(-1)!.data.summary), /0 allocations confirmed/);
  // A match marked wrong and later applied again keeps its original confirmation time.
  executeAction(state, finance(wat("2027-07-04T09:00:00")), { action: "review_allocation", recordId: matched.id, reason: "Wrong instalment", data: { correct: false } });
  assert.equal(close(wat("2027-07-05T07:00:00")).allocated.count, 0, "a superseded match is not counted");
  executeAction(state, finance(wat("2027-07-05T09:00:00")), { action: "review_allocation", recordId: matched.id, reason: "It was right after all", data: { correct: true } });
  const reinstated = close(wat("2027-07-06T07:00:00"));
  assert.equal(matched.status, "confirmed", "the reviewed match is applied again");
  assert.equal(reinstated.allocated.count, 0, "applying it again does not count as a new confirmation");
  checks += 8;
}

// ---------- RET-06: uplift report with the ratio-estimator interval, evaluated against the pre-registered rule ----------
function enrolledDue(state: DomainState, experiment: ValopayRecord, arm: "engine" | "holdout", amountKobo: number, firstFailureAt: string, index: number): ValopayRecord {
  const customer = recordsOf(state, "customers")[index % 8]!;
  return makeRecord(state, "due-items", { name: `enrolled ${arm} ${index}`, status: "in_collection", customerId: customer.id, amountKobo, reference: `EXP-${arm}-${index}`, data: { dueDate: firstFailureAt.slice(0, 10), owner: "valopay", outstandingKobo: amountKobo, experimentId: experiment.id, experimentArm: arm, firstFailureAt } });
}
function settle(state: DomainState, due: ValopayRecord, amountKobo: number, settledAt: string, reversed = false): void {
  const payment = makeRecord(state, "payments", { name: "settled", status: "allocated", customerId: due.customerId, amountKobo, reference: `PAY-${due.reference}`, data: { channel: "direct_debit", collectionStatus: "succeeded", settlementStatus: "settled", settledAt, observedAt: settledAt, reversalStatus: reversed ? "reversed" : "none", refundStatus: "none", allocatedKobo: amountKobo } });
  makeRecord(state, "allocations", { name: "R1", status: "confirmed", customerId: due.customerId, amountKobo, data: { paymentId: payment.id, dueItemId: due.id, rule: "R1", confidence: "certain", automatic: true } });
}
{
  const { state, policy } = liveFixture({ withFailure: false, merchantId: "uplift" });
  const experiment = makeRecord(state, "experiments", { name: "Test 2", status: "preregistered", data: { policyId: policy.id, holdoutShare: 0.5, minPerArm: 3, seed: "seed", baselineRate: 0.4, analysisDate: "2028-01-31", enrolmentClose: "2027-12-31", preregisteredAt: "2027-02-01T00:00:00.000Z", passRule: "rule" } });
  const failedAt = wat("2027-09-01T06:16:00");
  const amounts = [1_000_000, 2_000_000, 3_000_000, 4_000_000];
  const engine = amounts.map((amount, index) => enrolledDue(state, experiment, "engine", amount, failedAt, index));
  const holdout = amounts.map((amount, index) => enrolledDue(state, experiment, "holdout", amount, failedAt, index + 4));
  settle(state, engine[0]!, 1_000_000, wat("2027-09-05T10:00:00"));
  settle(state, engine[1]!, 2_000_000, wat("2027-09-20T10:00:00"));
  settle(state, engine[2]!, 1_500_000, wat("2027-09-25T10:00:00")); // partial counts by value only
  settle(state, engine[3]!, 4_000_000, wat("2027-10-15T10:00:00")); // outside the 30-day window
  settle(state, holdout[0]!, 1_000_000, wat("2027-09-10T10:00:00"));
  settle(state, holdout[1]!, 2_000_000, wat("2027-09-12T10:00:00"), true); // reversed inside the window reverses the outcome
  const immature = enrolledDue(state, experiment, "engine", 1_000_000, wat("2028-01-20T06:16:00"), 9);
  settle(state, immature, 1_000_000, wat("2028-01-21T10:00:00"));
  const report = upliftReport(state, experiment, "2028-02-01T09:00:00.000Z");
  assert.equal(report.engine.enrolled, 5); assert.equal(report.engine.mature, 4, "an item inside its 30-day window is not counted");
  assert.equal(report.holdout.mature, 4);
  assert.equal(report.engine.recoveryByValue, 0.45, "engine: 45,000 of 100,000 recovered by value");
  assert.equal(report.engine.recoveryByCount, 0.5, "two of four settled in full");
  assert.equal(report.holdout.recoveryByValue, 0.1, "holdout: the reversed payment does not count");
  assert.equal(report.holdout.recoveryByCount, 0.25);
  assert.equal(report.differenceByValue, 0.35);
  assert.equal(report.differenceByCount, 0.25);
  assert.ok(Math.abs(report.engine.varianceByValue! - 0.063667) < 1e-5, `engine ratio-estimator variance ${report.engine.varianceByValue}`);
  assert.ok(Math.abs(report.holdout.varianceByValue! - 0.014667) < 1e-5, `holdout ratio-estimator variance ${report.holdout.varianceByValue}`);
  assert.ok(Math.abs(report.confidenceInterval90!.low - -0.11037) < 1e-4, `lower bound ${report.confidenceInterval90!.low}`);
  assert.ok(Math.abs(report.confidenceInterval90!.high - 0.81037) < 1e-4, `upper bound ${report.confidenceInterval90!.high}`);
  assert.ok(Math.abs(report.confidenceInterval90ByCount!.low - -0.29402) < 1e-4, `count lower bound ${report.confidenceInterval90ByCount!.low}`);
  assert.deepEqual(report.checks, { effectAtLeastEightPoints: true, intervalExcludesZero: false, sampleMet: true, analysisDateReached: true });
  assert.equal(report.result, "not_proven", "an interval that includes zero is not proven, however large the point estimate");
  assert.match(report.reason, /90% confidence interval does not show a positive improvement/);
  assert.equal(report.minimumPerArm, 3);
  assert.equal(report.passRule, "rule");
  checks += 19;

  // A consistent effect on the minimum sample passes, but only once the analysis date is reached.
  const { state: proven, policy: policy2 } = liveFixture({ withFailure: false, merchantId: "uplift-proven" });
  const experiment2 = makeRecord(proven, "experiments", { name: "Test 2", status: "preregistered", data: { policyId: policy2.id, holdoutShare: 0.5, minPerArm: 3, seed: "seed", baselineRate: 0.4, analysisDate: "2028-01-31", enrolmentClose: "2027-12-31", preregisteredAt: "2027-02-01T00:00:00.000Z" } });
  for (let index = 0; index < 4; index++) {
    settle(proven, enrolledDue(proven, experiment2, "engine", 2_500_000, failedAt, index), 2_500_000, wat("2027-09-05T10:00:00"));
    enrolledDue(proven, experiment2, "holdout", 2_500_000, failedAt, index + 4);
  }
  settle(proven, enrolledDue(proven, experiment2, "holdout", 2_500_000, failedAt, 8), 2_500_000, wat("2027-09-05T10:00:00"));
  const early = upliftReport(proven, experiment2, "2027-12-01T09:00:00.000Z");
  assert.equal(early.differenceByValue, 0.8);
  assert.equal(early.checks.intervalExcludesZero, true);
  assert.equal(early.checks.analysisDateReached, false);
  assert.equal(early.result, "not_proven", "no result before the pre-registered analysis date");
  const final = upliftReport(proven, experiment2, "2028-02-01T09:00:00.000Z");
  assert.equal(final.result, "proven");
  assert.ok(final.confidenceInterval90!.low > 0);
  const reports = buildReports(proven, "2028-02-01T09:00:00.000Z");
  assert.equal(reports.experiment.result, "proven");
  assert.equal(reports.experiment.results[0].experimentId, experiment2.id);
  checks += 8;
  // The analysis date is a WAT date (audit item 16): it is reached at midnight WAT, 23:00 UTC the evening before.
  assert.equal(upliftReport(proven, experiment2, wat("2028-01-30T23:59:00")).checks.analysisDateReached, false, "the last minute of 30 January WAT");
  assert.equal(upliftReport(proven, experiment2, wat("2028-01-31T00:30:00")).checks.analysisDateReached, true, "00:30 WAT on 31 January, still 30 January in UTC");
  checks += 2;
}

// ---------- RET-11 (audit item 17): each arm is held to its own pre-computed minimum sample ----------
{
  const { state, policy } = liveFixture({ withFailure: false, merchantId: "uplift-arms" });
  const registered = recordsOf(state, "experiments")[0]!;
  Object.assign(registered.data, { policyId: policy.id, holdoutShare: 0.2, minPerArm: 0, baselineRate: 0.4, enrolmentClose: "2027-08-01", analysisDate: "2027-10-01" });
  executeAction(state, ctxAt(wat("2027-06-01T09:00:00"), "Admin"), { action: "preregister_experiment", recordId: registered.id, reason: "Register the plan" });
  assert.deepEqual(upliftReport(state, registered, wat("2027-10-02T09:00:00")).minimumByArm, { engine: 1172, holdout: 293 }, "a 20% comparison group needs 293; the retry group four times as many");
  // A plan whose computed minimums are small enough to fill here: two in the comparison group, eight in the retry group.
  const experiment = makeRecord(state, "experiments", { name: "Test 2", status: "preregistered", data: { policyId: policy.id, holdoutShare: 0.2, minPerArm: 2, seed: "seed", baselineRate: 0.4, analysisDate: "2028-01-31", enrolmentClose: "2027-12-31", preregisteredAt: "2027-02-01T00:00:00.000Z", sampleCalculation: { holdoutMinimum: 2, engineMinimum: 8, confidence: 0.9, power: 0.8, effect: 0.08 } } });
  const failedAt = wat("2027-09-01T06:16:00");
  for (let index = 0; index < 2; index++) enrolledDue(state, experiment, "holdout", 2_500_000, failedAt, index);
  for (let index = 0; index < 7; index++) settle(state, enrolledDue(state, experiment, "engine", 2_500_000, failedAt, index + 2), 2_500_000, wat("2027-09-05T10:00:00"));
  const short = upliftReport(state, experiment, "2028-02-01T09:00:00.000Z");
  assert.deepEqual([short.engine.mature, short.holdout.mature, short.minimumByArm], [7, 2, { engine: 8, holdout: 2 }]);
  assert.equal(short.checks.sampleMet, false, "seven in the retry group is below its own minimum of eight, though above the comparison group's two");
  settle(state, enrolledDue(state, experiment, "engine", 2_500_000, failedAt, 9), 2_500_000, wat("2027-09-05T10:00:00"));
  assert.equal(upliftReport(state, experiment, "2028-02-01T09:00:00.000Z").checks.sampleMet, true, "eight meets it");
  checks += 4;
}

{
  // A refund of an overpayment's excess leaves the recovery on the money that stayed.
  const { state, policy } = liveFixture({ withFailure: false, merchantId: "uplift-refund" });
  const experiment = makeRecord(state, "experiments", { name: "Test 2", status: "preregistered", data: { policyId: policy.id, holdoutShare: 0.5, minPerArm: 1, seed: "seed", baselineRate: 0.4, analysisDate: "2027-12-31", enrolmentClose: "2027-12-31", preregisteredAt: "2027-02-01T00:00:00.000Z" } });
  const due = enrolledDue(state, experiment, "engine", 2_500_000, wat("2027-06-01T06:16:00"), 0);
  const transfer = makeRecord(state, "payments", { name: "Canonical payment", status: "unallocated", customerId: due.customerId, amountKobo: 3_000_000, reference: "TRF-EXCESS", data: { channel: "transfer", collectionStatus: "succeeded", settlementStatus: "settled", settledAt: wat("2027-06-05T10:00:00"), observedAt: wat("2027-06-05T10:00:00"), reversalStatus: "none", refundStatus: "none", allocatedKobo: 0 } });
  const finance = (now: string) => ctxAt(now, "Finance");
  executeAction(state, finance(wat("2027-06-05T11:00:00")), { action: "manual_allocate", recordId: transfer.id, reason: "The customer paid the instalment and a little more", data: { dueItemId: due.id, amountKobo: 2_500_000 } });
  executeAction(state, finance(wat("2027-06-06T10:00:00")), { action: "record_refund", recordId: transfer.id, reason: "Excess returned to the payer", data: { reference: "RF-EXCESS" } });
  assert.equal(armStatistics(state, recordsOf(state, "due-items").filter((item) => item.id === due.id), wat("2027-07-15T09:00:00")).recoveredKobo, 2_500_000, "the NGN 25,000 applied to the instalment is still recovered");
  checks += 1;
}

// ---------- BIL-01: only direct-debit attempts that succeeded are billable; transfers and card receipts are reported, never billed ----------
{
  const state = seedMerchant("billing");
  const payments = recordsOf(state, "payments");
  const ada = payments.find((item) => item.reference === "SBX-PAY-1001")!; // direct debit, allocated, settled
  const tunde = payments.find((item) => item.reference === "SBX-PAY-1002")!; // transfer, allocated, settled
  const observed = Date.parse(ada.createdAt);
  state.settings.billingPeriod = monthOf(ada.createdAt);
  const afterWindow = new Date(observed + 10 * DAY).toISOString();
  const insideWindow = new Date(observed + 3 * DAY).toISOString();
  assert.equal(billableCollection(state, ada, afterWindow), true, "a settled direct debit past the reversal window is billable");
  assert.equal(billableCollection(state, tunde, afterWindow), false, "a transfer is reconciled but never billed as a collection");
  assert.equal(billableCollection(state, ada, insideWindow), false, "inside the provider's reversal window nothing is billed yet");
  state.settings.providerReversalWindowDays = { "Sandbox Rail": 2 };
  assert.equal(billableCollection(state, ada, insideWindow), true, "the provider's own reversal window applies when configured");
  delete state.settings.providerReversalWindowDays;
  const billing = buildReports(state, afterWindow).billing;
  assert.equal(billing.successfulCollections, 1, "one billable collection in the period");
  assert.equal(billing.usageFeeKobo, 7_500, "0.3% of NGN 25,000 is NGN 75, under the NGN 150 cap");
  assert.equal(billing.channelBreakdown.direct_debit.count, 2, "the proposed direct debit is counted but not billable");
  assert.equal(billing.channelBreakdown.direct_debit.billable, 1);
  assert.equal(billing.channelBreakdown.transfer.billable, 0);
  assert.equal(billing.channelBreakdown.transfer.count, 2);
  assert.deepEqual(billing.billableChannels, ["direct_debit"]);
  assert.equal(buildReports(state, insideWindow).billing.withheldInsideReversalWindow, 1, "collections inside the window are shown as withheld");
  ada.data.reversalStatus = "reversed";
  assert.equal(buildReports(state, afterWindow).billing.successfulCollections, 0, "a reversal at the invoice date removes the collection");
  checks += 13;
}

// ---------- MEA-01: packs generated and marked used are counted from the export records ----------
{
  const state = seedMerchant("packs");
  makeRecord(state, "exports", { name: "pack", status: "ready", data: { kind: "customer-pack", format: "pdf", usedInRealCase: false, checksum: "x" } });
  makeRecord(state, "exports", { name: "pack", status: "ready", data: { kind: "gate-pack", format: "pdf", usedInRealCase: false, checksum: "y" } });
  makeRecord(state, "exports", { name: "csv", status: "ready", data: { kind: "billing", format: "csv", usedInRealCase: false, checksum: "z" } });
  const operational = buildReports(state, new Date().toISOString()).operational;
  assert.equal(operational.packsGenerated, 2);
  assert.equal(operational.disputePacksGenerated, 1);
  assert.equal(operational.realCasesUsed, 0);
  checks += 3;
}

void HOUR; void addAttempt;
console.log(`Measurement golden tests passed (${checks} checks): decision records and what makes a new one, deferral deadline, arm on decision, close report and the matches it counts, position rebuild, uplift interval and rule, each arm's own minimum, the WAT analysis date, billable channels, pack counts.`);
