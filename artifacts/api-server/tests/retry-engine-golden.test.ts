// Golden tests for the retry engine against TRD v1.1 sections 4.4, 6.2, 6.3, 6.4 and 10.4.
import assert from "node:assert/strict";
import { DAY, HOUR, addAttempt, addHoliday, addNotice, ctxAt, liveFixture, toWat, wat } from "./helpers.js";
import { assignArm, enrolEligibleFailures, evaluateRetry, nextExecutionSlot, preregisterSample, minimumTicketKobo } from "../src/domain/policy-engine.js";
import { executeAction } from "../src/domain/actions.js";
import { makeRecord, recordsOf } from "../src/domain/records.js";
import { validateRecord } from "../src/domain/validation.js";

const { assertFinalState } = await import("../src/lib/valo-pay-1-store.js");
let checks = 0;
const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks += 1; };

// ---------- TRD 6.4 worked timeline: the retry lands inside the 06:00–10:00 WAT window ----------
{
  const { state, policy, due } = liveFixture();
  const failed = recordsOf(state, "attempts").find((item) => item.data.dueItemId === due.id)!;
  failed.data.noticeId = addNotice(state, due, wat("2027-06-28T09:00:08")).id; // failed-debit notice accepted Monday 09:00:08 WAT
  const decision = evaluateRetry(state, ctxAt(wat("2027-06-28T09:01:00")), due, policy);
  assert.equal(decision.decision, "would_schedule", JSON.stringify(decision));
  assert.equal(toWat(decision.nextAt), "2027-06-30T06:16:00", "48-hour spacing from a 06:16 failure lands on Wednesday 06:16 WAT, inside the default window");
  assert.equal(decision.rule, "plan");
  checks += 3;
}

// ---------- Execution window hard bounds: never before 06:00 or after 20:00 WAT, whatever the settings say ----------
{
  const { state } = liveFixture();
  state.settings.executionStart = 4; state.settings.executionEnd = 23;
  assert.equal(toWat(new Date(nextExecutionSlot(state, Date.parse(wat("2027-06-30T03:00:00")))).toISOString()), "2027-06-30T06:00:00", "03:00 WAT rolls forward to 06:00, not 04:00");
  assert.equal(toWat(new Date(nextExecutionSlot(state, Date.parse(wat("2027-06-30T20:30:00")))).toISOString()), "2027-07-01T06:00:00", "20:30 WAT is outside the hard ceiling and rolls to the next day");
  assert.equal(toWat(new Date(nextExecutionSlot(state, Date.parse(wat("2027-06-30T19:59:00")))).toISOString()), "2027-06-30T19:59:00", "19:59 WAT is inside the hard ceiling");
  state.settings.executionStart = 6; state.settings.executionEnd = 10;
  assert.equal(toWat(new Date(nextExecutionSlot(state, Date.parse(wat("2027-06-30T10:00:00")))).toISOString()), "2027-07-01T06:00:00", "the window is [start, end)");
  state.settings.executionStart = 9; state.settings.executionEnd = 9;
  assert.ok(Number.isNaN(nextExecutionSlot(state, Date.parse(wat("2027-06-30T07:00:00")))), "an empty window plans nothing");
  checks += 5;
}

// ---------- Business calendar: weekends and holidays roll forward to the next banking day at the window start ----------
{
  const { state } = liveFixture();
  assert.equal(toWat(new Date(nextExecutionSlot(state, Date.parse(wat("2027-07-03T08:00:00")))).toISOString()), "2027-07-05T06:00:00", "Saturday rolls to Monday 06:00 WAT");
  addHoliday(state, "2027-07-05");
  assert.equal(toWat(new Date(nextExecutionSlot(state, Date.parse(wat("2027-07-03T08:00:00")))).toISOString()), "2027-07-06T06:00:00", "a Monday holiday rolls to Tuesday");
  checks += 2;
}

// ---------- Notice evidence boundary (10.4): accepted 24h00m before executes; 23h59m before is deferred ----------
{
  const planned = wat("2027-06-30T06:16:00");
  for (const [acceptedAt, expectNext, label] of [
    [wat("2027-06-29T06:16:00"), planned, "accepted exactly 24 hours before executes at the planned time"],
    [wat("2027-06-29T06:17:00"), wat("2027-06-30T06:17:00"), "accepted 23h59m before is deferred past the planned time"],
  ] as const) {
    const { state, policy, due } = liveFixture();
    const failed = recordsOf(state, "attempts").find((item) => item.data.dueItemId === due.id)!;
    failed.data.noticeId = addNotice(state, due, acceptedAt).id;
    const decision = evaluateRetry(state, ctxAt(wat("2027-06-28T10:00:00")), due, policy);
    assert.equal(decision.decision, "would_schedule");
    assert.equal(decision.nextAt, expectNext, label);
    checks += 1;
  }
  // A notice that was submitted but never accepted, or a simulated one, is not evidence (6.3 row 8):
  // the plan stands with the notice required by the deadline, and only a deadline that passes unevidenced defers the attempt.
  const { state, policy, due } = liveFixture();
  const failed = recordsOf(state, "attempts").find((item) => item.data.dueItemId === due.id)!;
  const notice = addNotice(state, due, wat("2027-06-29T06:16:00"));
  notice.data.synthetic = true;
  failed.data.noticeId = notice.id;
  const pending = evaluateRetry(state, ctxAt(wat("2027-06-28T10:00:00")), due, policy);
  assert.equal(pending.decision, "would_schedule", "before the deadline the plan stands and the notice is scheduled");
  assert.equal(toWat(pending.nextAt), "2027-06-30T06:16:00");
  assert.equal(pending.noticeRequired?.evidenced, false);
  assert.equal(toWat(pending.noticeRequired?.requiredBy ?? null), "2027-06-29T06:16:00", "the failed-debit notice is required 24 hours before the planned attempt (6.4)");
  const lapsed = evaluateRetry(state, ctxAt(wat("2027-06-29T06:17:00")), due, policy);
  assert.equal(lapsed.decision, "defer", "a deadline that passes without provider acceptance defers the attempt");
  assert.equal(lapsed.rule, "notice_not_evidenced");
  assert.equal(toWat(lapsed.nextAt), "2027-06-30T06:17:00", "deferred to the first slot a notice accepted now could satisfy");
  checks += 7;
}

// ---------- The retry notice follows the failure (audit item 9): a notice accepted before it announced an earlier debit ----------
{
  const { state, policy, due } = liveFixture({ withFailure: false, merchantId: "notice-order" });
  const preDebit = addNotice(state, due, wat("2027-06-25T09:00:00"), "pre_debit");
  const failed = addAttempt(state, due, { status: "failed", failureCode: "INSUFFICIENT_FUNDS", occurredAt: wat("2027-06-28T06:16:00"), noticeId: preDebit.id });
  due.status = "in_collection";
  const linkedEarly = evaluateRetry(state, ctxAt(wat("2027-06-29T08:00:00")), due, policy);
  assert.deepEqual([linkedEarly.decision, linkedEarly.rule, linkedEarly.noticeRequired?.evidenced, linkedEarly.noticeRequired?.noticeId], ["defer", "notice_not_evidenced", false, null], "the pre-debit notice of 25 June is not the notice for the failure of 28 June");
  assert.equal(linkedEarly.inputs.noticeEvidence, null);
  failed.data.noticeId = addNotice(state, due, wat("2027-06-28T06:15:00")).id;
  assert.equal(evaluateRetry(state, ctxAt(wat("2027-06-29T08:00:00")), due, policy).noticeRequired?.evidenced, false, "nor is a failed-debit notice accepted a minute before the failure");
  const after = addNotice(state, due, wat("2027-06-29T09:00:00"));
  failed.data.noticeId = after.id;
  const evidenced = evaluateRetry(state, ctxAt(wat("2027-06-29T09:30:00")), due, policy);
  assert.deepEqual([evidenced.decision, evidenced.noticeRequired?.evidenced, evidenced.noticeRequired?.noticeId], ["would_schedule", true, after.id], "a notice accepted after the failure is evidence");
  assert.equal(toWat(evidenced.nextAt), "2027-06-30T09:00:00", "and the retry waits the full 24 hours after its acceptance");
  checks += 5;
}

// ---------- RET-10 enrolment window (audit item 16): it closes at the end of the WAT day, not at midnight UTC ----------
{
  const enrolled = (failureAt: string) => {
    const { state, policy, due } = liveFixture({ withFailure: false, merchantId: `enrolment-${failureAt}` });
    const experiment = recordsOf(state, "experiments")[0]!;
    Object.assign(experiment.data, { policyId: policy.id, preregisteredAt: "2027-01-01T00:00:00.000Z", enrolmentClose: "2027-06-30", analysisDate: "2027-08-15" });
    experiment.status = "preregistered";
    addAttempt(state, due, { status: "failed", failureCode: "INSUFFICIENT_FUNDS", occurredAt: failureAt });
    due.status = "in_collection";
    enrolEligibleFailures(state, ctxAt(wat("2027-07-01T07:00:00")));
    return due.data.experimentId === experiment.id;
  };
  assert.equal(enrolled(wat("2027-06-30T23:59:00")), true, "a first failure in the last minute of 30 June WAT is inside the window");
  assert.equal(enrolled(wat("2027-07-01T00:30:00")), false, "one at 00:30 WAT on 1 July (23:30 UTC on 30 June) is after it closed");
  checks += 2;
}

// ---------- Backtest of a new version (audit item 15): a draft is simulated on the instalments its policy governs ----------
{
  const { state, policy, due, mandate } = liveFixture({ merchantId: "backtest-draft" });
  mandate.data.consentPolicyId = policy.id; mandate.data.consentPolicyVersion = 1;
  const failed = recordsOf(state, "attempts").find((item) => item.data.dueItemId === due.id)!;
  failed.data.noticeId = addNotice(state, due, wat("2027-06-28T09:00:08")).id;
  const ctx = ctxAt(wat("2027-06-28T09:01:00"));
  const approved = executeAction(state, ctx, { action: "backtest_policy", recordId: policy.id, reason: "Baseline" });
  const draftId = executeAction(state, ctx, { action: "new_policy_version", recordId: policy.id, reason: "Longer spacing" }).record!.id;
  const draft = recordsOf(state, "policies").find((item) => item.id === draftId)!;
  draft.data.spacingHours = 72;
  const run = executeAction(state, ctx, { action: "backtest_policy", recordId: draft.id, reason: "What would version 2 do?" });
  assert.equal(run.data.decisions.length, approved.data.decisions.length, "the draft is tried on every instalment its policy governs");
  const decision = run.data.decisions.find((item: { dueItemId: string }) => item.dueItemId === due.id)!;
  assert.deepEqual([decision.decision, decision.rule, decision.policyVersion], ["would_schedule", "plan", 2], decision.reason);
  assert.equal(toWat(decision.nextAt), "2027-07-01T06:16:00", "72-hour spacing from a Monday 06:16 failure lands on Thursday");
  assert.match(run.message, /not approved/);
  assert.equal(toWat(approved.data.decisions.find((item: { dueItemId: string }) => item.dueItemId === due.id)!.nextAt), "2027-06-30T06:16:00", "the approved version's own result is unchanged");
  assert.equal(evaluateRetry(state, ctx, due, draft).rule, "unapproved_policy", "outside a backtest the engine never plans with an unapproved version");
  assert.equal(recordsOf(state, "retry-decisions").length, 0, "a backtest records nothing");
  checks += 7;
}

// ---------- Quiet hours (10.4): the adapter refuses a message at 21:00:01 and accepts one at 08:00:00 WAT ----------
{
  const { state, mandate } = liveFixture();
  mandate.status = "pending_activation"; mandate.data.workflow = "transfer_to_activate"; mandate.data.reminderCount = 0;
  const remind = (now: string) => executeAction(state, ctxAt(now, "Operations"), { action: "activation_reminder", recordId: mandate.id, reason: "test" });
  assert.throws(() => remind(wat("2027-06-28T21:00:01")), /quiet hours, from 21:00 to 08:00 WAT/);
  assert.throws(() => remind(wat("2027-06-29T07:59:59")), /quiet hours, from 21:00 to 08:00 WAT/);
  assert.doesNotThrow(() => remind(wat("2027-06-29T08:00:00")));
  assert.doesNotThrow(() => remind(wat("2027-06-29T20:59:59")));
  assert.equal(recordsOf(state, "notifications").filter((item) => item.data.mandateId === mandate.id).length, 2, "every send is logged");
  remind(wat("2027-06-30T09:00:00")); remind(wat("2027-07-01T09:00:00"));
  assert.throws(() => remind(wat("2027-07-02T09:00:00")), /This mandate has had the most activation reminders allowed \(4\)\. Reissue the mandate if the customer still needs to activate it\./, "MAN-05: at most four reminders on a transfer-to-activate flow");
  mandate.data.workflow = "hosted_consent"; mandate.data.reminderCount = 0;
  remind(wat("2027-07-02T09:00:00")); remind(wat("2027-07-03T09:00:00"));
  assert.throws(() => remind(wat("2027-07-04T09:00:00")), /This mandate has had the most activation reminders allowed \(2\)\./, "MAN-05: at most two reminders on a hosted-consent flow");
  mandate.data.reminderCount = 0; mandate.data.consentGiven = true;
  assert.throws(() => remind(wat("2027-07-04T09:00:00")), /customer has already given consent/, "none once the provider reports consent given");
  mandate.status = "active";
  assert.throws(() => remind(wat("2027-07-04T09:00:00")), /awaiting activation/);
  checks += 9;
}

// ---------- Attempt ceiling across sources (10.4): two external + one Valo attempt leave one under a 4-ceiling; cancelled attempts never count ----------
{
  const { state, policy, due } = liveFixture({ withFailure: false });
  policy.data.maxAttempts = 4;
  addAttempt(state, due, { status: "failed", failureCode: "INSUFFICIENT_FUNDS", occurredAt: wat("2027-06-01T06:10:00"), source: "external" });
  addAttempt(state, due, { status: "failed", failureCode: "INSUFFICIENT_FUNDS", occurredAt: wat("2027-06-08T06:10:00"), source: "external" });
  const cancelled = addAttempt(state, due, { status: "scheduled", occurredAt: wat("2027-06-10T06:10:00"), source: "valo" });
  cancelled.status = "cancelled";
  const valo = addAttempt(state, due, { status: "failed", failureCode: "BANK_UNAVAILABLE", occurredAt: wat("2027-06-15T06:10:00"), source: "valo" });
  valo.data.noticeId = addNotice(state, due, wat("2027-06-15T09:00:00")).id;
  due.status = "in_collection";
  const third = evaluateRetry(state, ctxAt(wat("2027-06-15T10:00:00")), due, policy);
  assert.equal(third.decision, "would_schedule", "three counted attempts leave one under the ceiling of four");
  assert.equal(third.inputs.attemptNumber, 3, "the cancelled attempt is not counted");
  addAttempt(state, due, { status: "failed", failureCode: "INSUFFICIENT_FUNDS", occurredAt: wat("2027-06-17T06:10:00"), source: "valo" });
  const fourth = evaluateRetry(state, ctxAt(wat("2027-06-17T10:00:00")), due, policy);
  assert.equal(fourth.decision, "give_up"); assert.equal(fourth.rule, "ceiling");
  policy.data.maxAttempts = 9;
  assert.equal(evaluateRetry(state, ctxAt(wat("2027-06-17T10:00:00")), due, policy).decision, "give_up", "no policy may exceed the hard ceiling of four");
  checks += 5;
}

// ---------- Failure-code catalogue (4.4) ----------
{
  const cases: Array<[string, string, string]> = [
    ["INVALID_ACCOUNT", "give_up", "non_retryable"],
    ["MANDATE_INACTIVE", "give_up", "non_retryable"],
    ["MANDATE_LIMIT_EXCEEDED", "give_up", "non_retryable"],
    ["DUPLICATE", "give_up", "non_retryable"],
    ["UNKNOWN", "give_up", "non_retryable"],
    ["ACCOUNT_CLOSED", "give_up", "non_retryable"], // legacy alias of INVALID_ACCOUNT
    ["CUSTOMER_DISPUTED", "stop", "customer_disputed"],
    ["PROVIDER_ERROR", "would_schedule", "plan"],
    ["TECHNICAL_FAILURE", "would_schedule", "plan"], // legacy alias of PROVIDER_ERROR
    ["BANK_UNAVAILABLE", "would_schedule", "plan"],
    ["ACCOUNT_RESTRICTED", "would_schedule", "plan"],
  ];
  for (const [code, expectedDecision, expectedRule] of cases) {
    const { state, policy, due } = liveFixture({ failureCode: code });
    const failed = recordsOf(state, "attempts").find((item) => item.data.dueItemId === due.id)!;
    failed.data.noticeId = addNotice(state, due, wat("2027-06-28T09:00:00")).id;
    const decision = evaluateRetry(state, ctxAt(wat("2027-06-28T10:00:00")), due, policy);
    assert.equal(decision.decision, expectedDecision, `${code}: ${decision.reason}`);
    assert.equal(decision.rule, expectedRule, code);
    checks += 1;
  }
  // ACCOUNT_RESTRICTED: once.  The second restricted failure gives up.
  const { state, policy, due } = liveFixture({ failureCode: "ACCOUNT_RESTRICTED" });
  const second = addAttempt(state, due, { status: "failed", failureCode: "ACCOUNT_RESTRICTED", occurredAt: wat("2027-06-30T06:20:00") });
  second.data.noticeId = addNotice(state, due, wat("2027-06-30T09:00:00")).id;
  const decision = evaluateRetry(state, ctxAt(wat("2027-06-30T10:00:00")), due, policy);
  assert.equal(decision.decision, "give_up"); assert.equal(decision.rule, "restricted_once");
  // TIMEOUT_UNKNOWN is an unknown outcome: resolved by status query before anything else happens to the item.
  const unknown = liveFixture({ withFailure: false });
  addAttempt(unknown.state, unknown.due, { status: "unknown", failureCode: "TIMEOUT_UNKNOWN", occurredAt: wat("2027-06-28T06:16:00") });
  const blocked = evaluateRetry(unknown.state, ctxAt(wat("2027-06-28T10:00:00")), unknown.due, unknown.policy);
  assert.equal(blocked.decision, "blocked"); assert.equal(blocked.rule, "in_flight");
  checks += 3;
}

// ---------- Kill switches (DEB-06): merchant and policy version, each stopping new instructions and cancelling scheduled attempts ----------
{
  const { state, policy, due } = liveFixture();
  const failed = recordsOf(state, "attempts").find((item) => item.data.dueItemId === due.id)!;
  failed.data.noticeId = addNotice(state, due, wat("2027-06-28T09:00:00")).id;
  const ctx = ctxAt(wat("2027-06-28T10:00:00"));
  assert.equal(evaluateRetry(state, ctx, due, policy).decision, "would_schedule");
  const otherDue = recordsOf(state, "due-items").find((item) => item.id !== due.id && item.status === "scheduled")!;
  const otherPolicy = makeRecord(state, "policies", { name: "other", status: "approved", data: { version: 1, author: "a", reviewer: "b", maxAttempts: 3 } });
  otherDue.data.policyId = otherPolicy.id;
  const scheduledUnderPolicy = addAttempt(state, due, { status: "scheduled", occurredAt: wat("2027-06-30T06:00:00"), source: "valo" });
  const scheduledElsewhere = addAttempt(state, otherDue, { status: "scheduled", occurredAt: wat("2027-06-30T06:00:00"), source: "valo" });
  const result = executeAction(state, ctx, { action: "kill_switch", reason: "regulator query", data: { enabled: true, policyId: policy.id } });
  assert.deepEqual(result.data.cancelledScheduledAttemptIds, [scheduledUnderPolicy.id], "only attempts under the switched policy version are cancelled");
  assert.equal(scheduledElsewhere.status, "scheduled");
  assert.equal(state.settings.policyKillSwitches[policy.id], true, "the switch lives in settings because approved versions are immutable");
  const switched = evaluateRetry(state, ctx, due, policy);
  assert.equal(switched.decision, "blocked"); assert.equal(switched.rule, "kill_switch");
  executeAction(state, ctx, { action: "kill_switch", reason: "released", data: { enabled: false, policyId: policy.id } });
  assert.equal(evaluateRetry(state, ctx, due, policy).decision, "would_schedule", "releasing the switch recomputes the plan");
  executeAction(state, ctx, { action: "kill_switch", reason: "stop sign 5", data: { enabled: true } });
  assert.equal(evaluateRetry(state, ctx, due, policy).rule, "kill_switch");
  assert.equal(scheduledElsewhere.status, "cancelled", "the merchant switch cancels every scheduled attempt");
  assert.doesNotThrow(() => assertFinalState({ merchant: structuredClone(state.merchant), settings: {}, records: [] }, state, state.merchant.id));
  checks += 8;
}

// ---------- Merchant minimum ticket (MAN-07): settings drive the override band; the ₦5,000 floor never moves ----------
{
  const { state, policy, due } = liveFixture();
  const failed = recordsOf(state, "attempts").find((item) => item.data.dueItemId === due.id)!;
  failed.data.noticeId = addNotice(state, due, wat("2027-06-28T09:00:00")).id;
  const ctx = ctxAt(wat("2027-06-28T10:00:00"));
  state.settings.minimumTicketKobo = 3_000_000; // ₦30,000 merchant minimum; the due item is ₦25,000
  assert.equal(minimumTicketKobo(state), 3_000_000);
  const blocked = evaluateRetry(state, ctx, due, policy);
  assert.equal(blocked.rule, "minimum_ticket", blocked.reason);
  due.data.overrideReason = "Admin accepted the low-ticket warning";
  assert.equal(evaluateRetry(state, ctx, due, policy).decision, "would_schedule");
  state.settings.minimumTicketKobo = 100; // cannot go below the floor
  assert.equal(minimumTicketKobo(state), 500_000);
  const input = (amountKobo: number, overrideReason?: string) => ({ name: "d", status: "scheduled", customerId: due.customerId, amountKobo, data: { dueDate: "2027-08-01", owner: "lms", overrideReason } });
  state.settings.minimumTicketKobo = 2_000_000;
  assert.throws(() => validateRecord(state, ctx, "due-items", input(1_500_000)), /below the lender’s minimum of ₦20,000\.00\. An Admin must record a reason to allow it\./);
  assert.doesNotThrow(() => validateRecord(state, ctx, "due-items", input(1_500_000, "recorded")));
  assert.throws(() => validateRecord(state, ctx, "due-items", input(499_999, "recorded")), /Amounts below this cannot be approved/);
  checks += 6;
}

// ---------- Stable assignment and RET-10 eligibility ----------
{
  assert.equal(assignArm("seed", "m", "due-1", 0.5), assignArm("seed", "m", "due-1", 0.5), "the same seed and id always land in the same arm");
  const arms = new Set(Array.from({ length: 200 }, (_, i) => assignArm("seed", "m", `due-${i}`, 0.5)));
  assert.deepEqual([...arms].sort(), ["engine", "holdout"], "both arms are populated");
  const { state, policy, due } = liveFixture();
  const experiment = recordsOf(state, "experiments")[0]!;
  experiment.status = "preregistered"; experiment.data.preregisteredAt = "2027-01-01T00:00:00.000Z"; experiment.data.enrolmentClose = "2027-12-31"; experiment.data.policyId = policy.id;
  const ctx = ctxAt(wat("2027-06-28T10:00:00"));
  // Excluded: owner not valo.
  due.data.owner = "lms"; enrolEligibleFailures(state, ctx);
  assert.equal(due.data.experimentId, undefined, "RET-10: owner-not-valo items are excluded");
  // Excluded: mandate not active.
  due.data.owner = "valopay"; const mandate = recordsOf(state, "mandates").find((item) => item.id === due.data.mandateId)!; mandate.status = "suspended"; enrolEligibleFailures(state, ctx);
  assert.equal(due.data.experimentId, undefined, "RET-10: inactive mandates are excluded");
  // Excluded: amended after the failure.
  mandate.status = "active"; due.data.amendedAt = wat("2027-06-29T00:00:00"); enrolEligibleFailures(state, ctx);
  assert.equal(due.data.experimentId, undefined, "RET-10: items amended after their first failure are excluded");
  delete due.data.amendedAt; enrolEligibleFailures(state, ctx);
  assert.equal(due.data.experimentId, experiment.id, "an owner-valo item with an active mandate is enrolled at its first retryable failure");
  const arm = due.data.experimentArm;
  assert.ok(arm === "engine" || arm === "holdout");
  // Stable through three further failures and a new policy version.
  for (const day of [30, 2, 5]) addAttempt(state, due, { status: "failed", failureCode: "INSUFFICIENT_FUNDS", occurredAt: wat(`2027-0${day > 10 ? 6 : 7}-${String(day).padStart(2, "0")}T06:16:00`) });
  const version2 = executeAction(state, ctx, { action: "new_policy_version", recordId: policy.id, reason: "v2" }).record!;
  mandate.data.policyId = version2.id;
  enrolEligibleFailures(state, ctx);
  assert.equal(due.data.experimentArm, arm, "the arm never changes after assignment");
  assert.equal(due.data.experimentId, experiment.id);
  // A holdout item is handed to the lender's process; an engine item continues under policy.
  const forced = liveFixture({ merchantId: "holdout-merchant" });
  forced.due.data.experimentArm = "holdout"; forced.due.data.experimentId = "x";
  assert.equal(evaluateRetry(forced.state, ctx, forced.due, forced.policy).decision, "holdout");
  checks += 9;
}

// ---------- Section 6.6 sample sizes: one-sided 5% at 80% power for an 8-point difference ----------
{
  assert.deepEqual(preregisterSample(0.4, 0.5), { holdoutMinimum: 473, engineMinimum: 473, confidence: 0.9, power: 0.8, effect: 0.08 });
  const twenty = preregisterSample(0.4, 0.2);
  assert.equal(twenty.holdoutMinimum, 293); assert.equal(twenty.engineMinimum, 1172);
  assert.throws(() => preregisterSample(0.4, 0.05), /and a comparison group of 10% to 50%\./);
  checks += 3;
}

console.log(`Retry engine golden tests passed (${checks} checks): worked timeline, window bounds, calendar, notice clock, notice after the failure, WAT enrolment window, backtests of new versions, quiet hours, ceilings, failure codes, kill switches, minimum ticket, stable assignment, sample sizes.`);
