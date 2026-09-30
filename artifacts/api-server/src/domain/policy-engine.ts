import { createHash } from "node:crypto";
import {
  ABSOLUTE_TICKET_FLOOR_KOBO, DEFAULT_MINIMUM_TICKET_KOBO, PLATFORM_OWNER, WAT_OFFSET_MS,
  clampExecutionHour, counted as countedText, executionWindow, experimentRules, nairaText, normaliseFailureCode, optionText, policyGuardrails, retryRuleFor, valueWords,
  type ExperimentArm, type FailureCode, type RetryDecisionKind,
} from "@workspace/valopay-schema";
import type { Context, DomainState, TypedRecord, ValopayRecord } from "./types";
import { makeRecord, recordsOf } from "./records";
import { indexedPass, recordsWhere } from "./record-index";
import { holidaySet, isBusinessDay, nonBusinessDaysBetween, watDate } from "./calendar";
import { canonicalDigest } from "../lib/digests";
import { dueNeedsReversalReview } from "./reversal-review";

const HOUR = 60 * 60 * 1000;
export type { RetryDecisionKind };

/** The notice a decision requires (TRD 6.3 row 8 and 6.4): its purpose, lead time, deadline and the evidence found. */
export interface NoticeRequirement {
  purpose: "failed_debit" | "final_attempt";
  leadHours: number;
  requiredBy: string | null;
  noticeId: string | null;
  acceptedAt: string | null;
  evidenced: boolean;
}

/** RET-03: everything a decision must record; persisted by `recordRetryDecision` and shown on the customer timeline. */
export interface RetryDecision {
  dueItemId: string;
  /** The failed attempt the decision follows, when there is one. */
  attemptId: string | null;
  decision: RetryDecisionKind;
  /** The decision-table row that fired (TRD 6.3). */
  rule: string;
  reason: string;
  /** The scheduled time of the next attempt, when one is planned or deferred. */
  nextAt: string | null;
  policyId: string;
  policyVersion: number;
  /** RET-05: the arm is recorded on the decision. */
  experimentArm: ExperimentArm | null;
  evaluatedAt: string;
  /** Code, attempt number, ceiling, calendar and notice evidence the row used. */
  inputs: Record<string, unknown>;
  noticeRequired?: NoticeRequirement;
}

/** The policy parameters as a sentence: what a consent record stores as the policy text as it stood (MAN-02, RET-07). */
export function policySummary(policy: TypedRecord<"policies">): string {
  const d = policy.data;
  return `Version ${d.version ?? 1}: up to ${countedText(Number(d.maxAttempts ?? policyGuardrails.defaultMaxAttempts), "attempt")} in total across all collection systems; at least ${d.spacingHours ?? policyGuardrails.defaultSpacingHours} hours between attempts; first notice ${d.firstNoticeHours ?? policyGuardrails.defaultFirstNoticeHours} hours before the first attempt; notice of a failed attempt ${d.retryNoticeHours ?? policyGuardrails.defaultRetryNoticeHours} hours before any retry; partial debits ${d.partialAllowed ? "allowed" : "not allowed"}.`;
}

/** Two policy records are versions of the same policy when their previousVersionId chains share a root, or they carry the same name. */
export function samePolicyLineage(state: DomainState, aId: string, bId: string): boolean {
  if (aId === bId) return true;
  const root = (id: string): string => {
    const seen = new Set<string>();
    let current = id;
    while (!seen.has(current)) {
      seen.add(current);
      const previous = recordsOf(state, "policies").find((item) => item.id === current)?.data.previousVersionId;
      if (!previous) break;
      current = String(previous);
    }
    return current;
  };
  if (root(aId) === root(bId)) return true;
  const a = recordsOf(state, "policies").find((item) => item.id === aId), b = recordsOf(state, "policies").find((item) => item.id === bId);
  return Boolean(a && b && a.name === b.name);
}

/** Every version of the same policy as this one (samePolicyLineage), itself included, whatever its status. */
export function policyLineage(state: DomainState, policy: TypedRecord<"policies">): TypedRecord<"policies">[] {
  return recordsOf(state, "policies").filter((item) => samePolicyLineage(state, policy.id, item.id));
}

/** A policy version's number; a record written before versions were numbered is version 1. */
export const policyVersionOf = (policy: TypedRecord<"policies">): number => Number(policy.data.version || 1);

export function policyIdFor(state: DomainState, due: TypedRecord<"due-items">): string | undefined {
  return due.data.policyId || recordsWhere(state, "mandates", "id", due.data.mandateId)[0]?.data.policyId;
}

export function approvedPolicyFor(state: DomainState, due: TypedRecord<"due-items">): TypedRecord<"policies"> | undefined {
  const id = policyIdFor(state, due);
  return id ? recordsWhere(state, "policies", "id", id).find((policy) => policy.status === "approved") : undefined;
}

export const attemptTime = (attempt: TypedRecord<"attempts">): string => String(attempt.data.occurredAt || attempt.createdAt);

export function attemptsFor(state: DomainState, dueItemId: string): TypedRecord<"attempts">[] {
  return recordsWhere(state, "attempts", "data.dueItemId", dueItemId).sort((a, b) => attemptTime(a).localeCompare(attemptTime(b)));
}

/** Attempts the customer experienced.  Cancelled and not-yet-sent attempts never count toward the ceiling (DEB-05). */
export const countedAttemptStatuses: ReadonlySet<string> = new Set(["sent", "succeeded", "failed", "unknown", "reversed"]);
export function countedAttempts(state: DomainState, dueItemId: string): TypedRecord<"attempts">[] {
  return attemptsFor(state, dueItemId).filter((attempt) => countedAttemptStatuses.has(attempt.status));
}

/** MAN-07: the merchant's minimum (default ₦10,000) can never sit below the absolute ₦5,000 floor. */
export function minimumTicketKobo(state: DomainState): number {
  const configured = Number(state.settings.minimumTicketKobo);
  const minimum = Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MINIMUM_TICKET_KOBO;
  return Math.max(ABSOLUTE_TICKET_FLOOR_KOBO, minimum);
}

/** DEB-06: policy-version switches live in merchant settings because approved policy versions are immutable. */
export function policyKillSwitchOn(state: DomainState, policyId: string | undefined): boolean {
  return !!policyId && state.settings.policyKillSwitches?.[policyId] === true;
}

export function policyCeiling(policy: TypedRecord<"policies">): number {
  const configured = Number(policy.data.maxAttempts);
  const maximum = Number.isInteger(configured) && configured >= 1 ? configured : policyGuardrails.defaultMaxAttempts;
  return Math.min(policyGuardrails.maxAttemptsCeiling, maximum);
}

export function executionWindowFor(state: DomainState): { start: number; end: number } {
  return {
    start: clampExecutionHour(state.settings.executionStart, executionWindow.defaultStartHour),
    end: clampExecutionHour(state.settings.executionEnd, executionWindow.defaultEndHour),
  };
}

/**
 * Earliest instant at or after `earliestMs` that falls on a business day inside
 * the merchant's execution window (DEB-01, SCH-04).  Returns NaN when the window
 * is empty.  The window is [start, end) in WAT hours and is hard-bounded to
 * 06:00–20:00 whatever the settings say.
 */
export function nextExecutionSlot(state: DomainState, earliestMs: number): number {
  const holidays = holidaySet(state);
  const { start, end } = executionWindowFor(state);
  if (start >= end || !Number.isFinite(earliestMs)) return NaN;
  const atHour = (wat: Date, hour: number) => { wat.setUTCHours(hour, 0, 0, 0); return wat.getTime() - WAT_OFFSET_MS; };
  let time = earliestMs;
  for (let day = 0; day < 370; day++) {
    const wat = new Date(time + WAT_OFFSET_MS);
    if (!isBusinessDay(time, holidays) || wat.getUTCHours() >= end) {
      wat.setUTCDate(wat.getUTCDate() + 1);
      time = atHour(wat, start);
      continue;
    }
    if (wat.getUTCHours() < start) return atHour(wat, start);
    return time;
  }
  return NaN;
}

function overrideRecorded(due: TypedRecord<"due-items">): boolean {
  return Boolean(due.data.overrideReason || due.data.adminOverrideReason);
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * TRD 6.3 decision table, applied after a failed attempt.  Rows fire in the
 * documented order; ownership and mode are evaluated last so a backtest can
 * show what the policy would have done while the merchant observes.  A
 * backtest is a `simulation`: it tries a version, approved or not, as if it
 * were approved and applied, so the approval and consented-version rows are
 * left out.  Its decisions are never recorded.
 */
export function evaluateRetry(state: DomainState, ctx: Context, due: TypedRecord<"due-items">, policy: TypedRecord<"policies">, options: { simulation?: boolean } = {}): RetryDecision {
  const attempts = attemptsFor(state, due.id);
  const counted = countedAttempts(state, due.id);
  const last = counted.at(-1);
  const code: FailureCode | undefined = last?.status === "failed" ? normaliseFailureCode(last.data.failureCode) : undefined;
  const inputs: Record<string, unknown> = { code, attemptNumber: counted.length, ceiling: policyCeiling(policy), owner: due.data.owner, mode: state.merchant.mode };
  const arm: ExperimentArm | null = due.data.experimentArm === "engine" || due.data.experimentArm === "holdout" ? due.data.experimentArm : null;
  const explain = (decision: RetryDecisionKind, rule: string, reason: string, nextAt: string | null = null, noticeRequired?: NoticeRequirement): RetryDecision => ({
    dueItemId: due.id, attemptId: last?.id ?? null, decision, rule, reason, nextAt,
    policyId: policy.id, policyVersion: Number(policy.data.version || 1), experimentArm: arm, evaluatedAt: ctx.now, inputs,
    ...(noticeRequired ? { noticeRequired } : {}),
  });
  const finalNotice: NoticeRequirement = { purpose: "final_attempt", leadHours: 0, requiredBy: null, noticeId: null, acceptedAt: null, evidenced: false };
  if (dueNeedsReversalReview(state, due)) return explain("blocked", "reversal_review", "Collection is paused while Finance reviews an earlier reversal decision again. Resolve that review and run reconciliation before a retry is planned.");
  if(recordsWhere(state,'connected-intents','data.dueItemId',due.id).some(r=>['authorised','pending','unknown'].includes(r.status))) return explain('blocked','in_flight','A pay-by-bank payment is pending or has an unknown outcome. Reconcile it before scheduling another collection.');

  // Row 1: settled by any channel, or the obligation is frozen or closed.
  const outstanding = Number.isInteger(due.data.outstandingKobo) ? Number(due.data.outstandingKobo) : due.amountKobo;
  if (["paid", "cancelled", "closed"].includes(due.status) || outstanding === 0) return explain("stop", "settled", "This instalment is paid or closed. Any planned retry is cancelled.");
  if (due.status === "in_dispute") return explain("stop", "disputed", "Collection is paused while the customer dispute is open.");
  if (due.status === "unpaid_final") return explain("stop", "final", "No attempts remain. Follow up through the exception and the loan management system.");
  // Row 2: kill switches.  No exception for the switch itself; the item waits for release.
  if (state.merchant.killSwitch) return explain("blocked", "kill_switch", "The lender’s emergency stop is on. No collection instruction is planned.");
  if (policyKillSwitchOn(state, policy.id)) return explain("blocked", "kill_switch", "The emergency stop for this retry policy version is on. No collection instruction is planned.");
  // Unknown or in-flight outcome: resolve by status query before anything else happens to the due item (DEB-04).
  if (attempts.some((attempt) => ["scheduled", "sent", "unknown"].includes(attempt.status))) {
    return explain("blocked", "in_flight", "An earlier attempt is still pending or has an unknown outcome. Check its status with the provider before taking further action on this instalment.");
  }
  if (!last || last.status !== "failed" || !code) return explain("not_eligible", "no_failure", "There is no failed collection attempt to retry.");
  inputs.rawCode = last.data.failureCode;
  inputs.attemptAt = attemptTime(last);
  const retry = retryRuleFor(code);
  // A disputed debit is never retried; once its dispute was not upheld or Finance released the instalment, it no longer freezes it.
  if (retry === "never") return due.data.disputeRelease?.attemptId === last.id
    ? explain("stop", "dispute_released", "The customer’s dispute of this debit was not upheld, or Finance released the instalment from dispute. A disputed debit is never retried automatically: collect the instalment through another channel.")
    : explain("stop", "customer_disputed", "The customer disputed the debit. Collection is paused and a dispute exception is raised with a one-business-day deadline.");
  if (retry === "unresolved") return explain("blocked", "timeout_unknown", "The outcome is unknown. Check with the provider using the payment reference. An exception is raised after 24 hours without a confirmed outcome.");
  // Row 3: non-retryable code.
  if (retry === "no") return explain("give_up", "non_retryable", `${optionText(code)} cannot be retried. Follow-up needs a final notice, an exception and an update to the loan management system.`, null, finalNotice);
  // Row 4: attempt ceiling across every source.
  if (counted.length >= policyCeiling(policy)) return explain("give_up", "ceiling", `The limit of ${countedText(policyCeiling(policy), "attempt")} has been reached across all collection systems. Follow-up requires a final notice, an exception and an update to the loan management system.`, null, finalNotice);
  // Row 5: ACCOUNT_RESTRICTED is retried once only.
  if (retry === "once" && counted.filter((attempt) => attempt.status === "failed" && normaliseFailureCode(attempt.data.failureCode) === code).length >= 2) {
    return explain("give_up", "restricted_once", `${optionText(code)} allows one retry, and it has been used. Follow-up needs a final notice, an exception and an update to the loan management system.`, null, finalNotice);
  }
  // RET-01: only an approved version by a reviewer who is not its author may plan a retry.
  if (!options.simulation && (policy.status !== "approved" || !policy.data.reviewer || policy.data.reviewer === policy.data.author)) return explain("blocked", "unapproved_policy", "A Compliance reviewer who is not the policy’s author must approve it before a retry can be planned.");
  const mandate = recordsWhere(state, "mandates", "id", due.data.mandateId)[0];
  // RET-07: the engine applies the version the consent covers until a notice, and fresh consent where required, moves the mandate to a newer one.
  if (!options.simulation && mandate?.data.consentPolicyId && mandate.data.consentPolicyId !== policy.id) {
    inputs.consentPolicyVersion = mandate.data.consentPolicyVersion;
    return explain("blocked", "policy_version_not_consented", `The customer’s consent covers version ${mandate.data.consentPolicyVersion}. Before applying version ${policy.data.version ?? "?"}, record the policy change notice and any new consent the lender’s terms require.`);
  }
  // MAN-07: the absolute floor and the merchant minimum.
  if (due.amountKobo < ABSOLUTE_TICKET_FLOOR_KOBO) return explain("stop", "floor", `The amount is below the ${nairaText(ABSOLUTE_TICKET_FLOOR_KOBO)} minimum debit. This limit cannot be overridden.`);
  if (due.amountKobo < minimumTicketKobo(state) && !overrideRecorded(due)) return explain("blocked", "minimum_ticket", "The amount is below the lender’s minimum. An Admin must record a reason to allow it before a retry can be planned.");
  // MAN-08, MAN-09, MAN-14: the mandate must be active, cover the amount and carry consent.
  if (!mandate || mandate.status !== "active") return explain("blocked", "mandate_inactive", "The mandate is not active. Resume or reissue it before a retry can be planned.");
  if (due.amountKobo > mandate.amountKobo) return explain("blocked", "mandate_limit", "The instalment exceeds the mandate limit. Do not retry a lower amount unless the consent covers it.");
  if (!mandate.data.consentEvidence || (Array.isArray(mandate.data.consentGaps) && mandate.data.consentGaps.length)) return explain("blocked", "consent_gap", "Consent evidence is missing or incomplete. Resolve the gaps before proceeding.");
  // Row 6: stable experiment assignment (RET-05).  A holdout item still receives the failed-debit notice.
  if (arm === "holdout") return explain("holdout", "holdout", "This instalment is in the comparison group. The lender’s documented manual process is responsible for collection; automated retries are not allowed.", null, { purpose: "failed_debit", leadHours: 0, requiredBy: null, noticeId: null, acceptedAt: null, evidenced: false });
  // SCH-08 and DEB-10: only owner-valo obligations of a merchant in instruction mode are instructed.
  if (due.data.owner !== PLATFORM_OWNER) return explain("observation_only", "ownership", `Another collection system is responsible for this instalment (${valueWords(due.data.owner)}). Valo Pay cannot send its collection instructions.`);
  if (state.merchant.mode !== "instruction" || !state.merchant.preLiveReady) return explain("observation_only", "observation_mode", "Valo Pay only watches this lender’s collections, so no instruction can be sent. Sample data can never approve live collection instructions.");
  // Row 8: plan the earliest slot that satisfies spacing, the calendar and the window; the required notice must be evidenced the lead time before it.
  const spacingHours = Math.max(policyGuardrails.minSpacingHours, Number(policy.data.spacingHours) || policyGuardrails.defaultSpacingHours);
  const leadHours = Math.max(policyGuardrails.minRetryNoticeHours, Number(policy.data.retryNoticeHours) || policyGuardrails.defaultRetryNoticeHours);
  const now = Date.parse(ctx.now);
  const earliestBySpacing = Math.max(now, Date.parse(attemptTime(last)) + spacingHours * HOUR);
  const planned = nextExecutionSlot(state, earliestBySpacing);
  Object.assign(inputs, { spacingHours, leadHours, window: executionWindowFor(state) });
  if (!Number.isFinite(planned)) return explain("blocked", "window", "There is no available business-day time within the configured collection hours.");
  const calendar = (fromMs: number, toMs: number) => ({ earliestAt: iso(fromMs), rolledForward: toMs > fromMs, ...nonBusinessDaysBetween(state, fromMs, toMs) });
  // NOT-10: the notice clock runs from provider acceptance, never from submission or simulation.  The notice for a
  // retry follows the failure it reports: one accepted before the failure announced an earlier debit.
  const failedAt = Date.parse(attemptTime(last));
  const notice = recordsWhere(state, "notifications", "id", last.data.noticeId).find((record) => ["pre_debit", "failed_debit"].includes(String(record.data.purpose)) && record.data.acceptedAt && record.data.synthetic !== true && Date.parse(String(record.data.acceptedAt)) > failedAt);
  if (notice) {
    const acceptedAt = Date.parse(String(notice.data.acceptedAt));
    const earliest = Math.max(earliestBySpacing, acceptedAt + leadHours * HOUR);
    const next = nextExecutionSlot(state, earliest);
    if (!Number.isFinite(next)) return explain("blocked", "window", "There is no available business-day time within the configured collection hours.");
    inputs.noticeEvidence = { noticeId: notice.id, acceptedAt: notice.data.acceptedAt };
    inputs.calendar = calendar(earliest, next);
    const requirement: NoticeRequirement = { purpose: "failed_debit", leadHours, requiredBy: iso(next - leadHours * HOUR), noticeId: notice.id, acceptedAt: String(notice.data.acceptedAt), evidenced: true };
    return explain("would_schedule", "plan", next > planned
      ? "The notice was accepted after the deadline. The attempt moves to the next available time that allows the full notice period. No instruction is sent."
      : "All policy checks passed in this simulation. No instruction is sent.", iso(next), requirement);
  }
  inputs.noticeEvidence = null;
  inputs.calendar = calendar(earliestBySpacing, planned);
  const deadline = planned - leadHours * HOUR;
  if (now < deadline) {
    // The plan stands and the notice is scheduled; execution is refused unless the evidence arrives by the deadline (SCH-05).
    return explain("would_schedule", "plan", "A retry can be planned if the provider confirms, by the deadline, that it accepted the notice of the failed collection attempt. No instruction is sent.", iso(planned),
      { purpose: "failed_debit", leadHours, requiredBy: iso(deadline), noticeId: null, acceptedAt: null, evidenced: false });
  }
  // The deadline passed without provider acceptance: defer to the next compliant slot and raise the exception.
  const deferred = nextExecutionSlot(state, now + leadHours * HOUR);
  const deferredAt = Number.isFinite(deferred) ? iso(deferred) : null;
  return explain("defer", "notice_not_evidenced", "The deadline passed without evidence that the provider accepted the required notice. The attempt is postponed to the next allowed time and an exception is raised for review.", deferredAt,
    { purpose: "failed_debit", leadHours, requiredBy: Number.isFinite(deferred) ? iso(deferred - leadHours * HOUR) : null, noticeId: null, acceptedAt: null, evidenced: false });
}

/** The fields of an evaluation, or of a stored decision record, that decide whether it is the same decision. */
type DecisionIdentity = Pick<RetryDecision, "dueItemId" | "decision" | "rule" | "policyId" | "policyVersion">
  & Partial<Pick<RetryDecision, "attemptId" | "nextAt" | "experimentArm" | "inputs" | "noticeRequired">>;

/**
 * What makes two evaluations the same decision: the same attempt, row, outcome,
 * planned time, policy version, arm, inputs and notice evidence, compared at
 * every depth. The evaluation time and the wording are not part of it, nor is
 * the calendar working, which follows the evaluation clock and whose effect is
 * the planned time.
 */
export function decisionFingerprint(decision: DecisionIdentity): string {
  const { calendar: _calendar, ...inputs } = decision.inputs ?? {};
  const identity = {
    dueItemId: decision.dueItemId, attemptId: decision.attemptId ?? null, decision: decision.decision, rule: decision.rule, nextAt: decision.nextAt ?? null,
    policyId: decision.policyId, policyVersion: Number(decision.policyVersion), experimentArm: decision.experimentArm ?? null, inputs, noticeRequired: decision.noticeRequired ?? null,
  };
  // The canonical form: keys sorted at every depth, an undefined object value left out and an undefined array element
  // null, as JSON.stringify writes them, so a decision read back from the database gives the same text as the value it
  // was written from.
  return canonicalDigest(identity);
}

export function latestDecisionFor(state: DomainState, dueItemId: string): TypedRecord<"retry-decisions"> | undefined {
  return recordsWhere(state, "retry-decisions", "data.dueItemId", dueItemId).sort((a, b) => String(a.data.evaluatedAt).localeCompare(String(b.data.evaluatedAt)) || a.createdAt.localeCompare(b.createdAt)).at(-1);
}

/** Why a retry decision was reached, in words for its record's name: "Retry decision · blocked (emergency stop on)". */
const retryRuleWords: Record<string, string> = {
  consent_gap: "consent evidence missing", in_flight: "attempt in progress", kill_switch: "emergency stop on", mandate_inactive: "mandate not active",
  mandate_limit: "above the mandate limit", minimum_ticket: "below the lender’s minimum", policy_version_not_consented: "new policy version not consented",
  reversal_review: "reversal review open", timeout_unknown: "outcome unknown", unapproved_policy: "policy not approved", window: "no collection time available",
  notice_not_evidenced: "notice not confirmed", ceiling: "attempt limit reached", non_retryable: "cannot be retried", restricted_once: "one retry used",
  holdout: "comparison group", no_failure: "no failed attempt", observation_mode: "watch only", ownership: "another collection system",
  customer_disputed: "customer disputed", dispute_released: "dispute released", disputed: "in dispute", final: "no attempts left",
  floor: "below the minimum debit", settled: "paid or closed", plan: "retry planned",
};

/** A retry decision's rule in words: "notice not confirmed", "attempt limit reached". */
export function retryRuleText(rule: unknown): string {
  const code = String(rule ?? "");
  return Object.hasOwn(retryRuleWords, code) ? retryRuleWords[code]! : code.replace(/_/g, " ") || "not recorded";
}

/**
 * RET-03: persist a decision as an immutable record on the customer's timeline.
 * A close that re-evaluates an item and reaches the same decision writes nothing;
 * any change of row, outcome, scheduled time, policy version, inputs or notice
 * evidence is a new record.
 */
export function recordRetryDecision(state: DomainState, ctx: Context, due: TypedRecord<"due-items">, decision: RetryDecision): TypedRecord<"retry-decisions"> | undefined {
  const fingerprint = decisionFingerprint(decision);
  const latest = latestDecisionFor(state, due.id);
  // Recomputed from the stored fields: a decision recorded before nested inputs counted carries an older fingerprint.
  if (latest && decisionFingerprint(latest.data as DecisionIdentity) === fingerprint) return undefined;
  const rowLabel = retryRuleWords[decision.rule] ?? decision.rule.replace(/_/g, " ");
  return makeRecord(state, "retry-decisions", {
    name: rowLabel === valueWords(decision.decision) ? `Retry decision · ${rowLabel}` : `Retry decision · ${valueWords(decision.decision)} (${rowLabel})`, status: "recorded", customerId: due.customerId, amountKobo: due.amountKobo,
    reference: `RD-${fingerprint.slice(0, 12)}`, createdAt: ctx.now, updatedAt: ctx.now,
    data: { ...decision, fingerprint, previousDecisionId: latest?.id ?? null, synthetic: true },
  });
}

/** Section 6.6 minimum sample per arm at 80% power for an 8-point difference, one-sided 5% (a 90% interval excluding zero). */
export function preregisterSample(baseline: number, holdout: number) {
  if (!(baseline > 0 && baseline < 1 - experimentRules.effectPoints && holdout >= experimentRules.minimumHoldoutShare && holdout <= experimentRules.maximumHoldoutShare)) {
    throw new Error(`Enter a baseline recovery rate above 0% and below ${Math.round((1 - experimentRules.effectPoints) * 100)}%, and a comparison group of ${Math.round(experimentRules.minimumHoldoutShare * 100)}% to ${Math.round(experimentRules.maximumHoldoutShare * 100)}%.`);
  }
  const ratio = (1 - holdout) / holdout;
  const z = experimentRules.zScore + 0.8416212335729143;
  const effect = experimentRules.effectPoints;
  const holdoutMinimum = Math.ceil((z * z * (baseline * (1 - baseline) + ((baseline + effect) * (1 - baseline - effect)) / ratio)) / (effect * effect));
  return { holdoutMinimum, engineMinimum: Math.ceil(holdoutMinimum * ratio), confidence: experimentRules.confidence, power: experimentRules.power, effect };
}

/** Seeded, stable arm assignment (RET-05): the same seed and due item always land in the same arm. */
export function assignArm(seed: string, merchantId: string, dueItemId: string, holdoutShare: number): "engine" | "holdout" {
  const hash = createHash("sha256").update(`${seed}:${merchantId}:${dueItemId}`).digest("hex");
  return parseInt(hash.slice(0, 8), 16) / 0x100000000 < holdoutShare ? "holdout" : "engine";
}

/**
 * RET-10 eligibility: an enrolled lender's due item whose first counted attempt
 * failed with a retryable code, owned by Valo Pay, with an active mandate and no
 * dispute, not amended after the failure, inside the enrolment window.
 */
export function enrolEligibleFailures(state: DomainState, ctx: Context): void {
  indexedPass(state, () => enrolFailures(state, ctx));
}
function enrolFailures(state: DomainState, ctx: Context): void {
  for (const due of recordsOf(state, "due-items")) {
    if (due.data.experimentId || due.data.owner !== PLATFORM_OWNER) continue;
    if (["cancelled", "closed", "in_dispute", "paid", "unpaid_final"].includes(due.status) || due.amountKobo < ABSOLUTE_TICKET_FLOOR_KOBO) continue;
    const counted = countedAttempts(state, due.id);
    const first = counted[0];
    if (!first || first.status !== "failed") continue;
    const retry = retryRuleFor(first.data.failureCode);
    if (retry !== "yes" && retry !== "once") continue;
    if (counted.some((attempt) => normaliseFailureCode(attempt.data.failureCode) === "CUSTOMER_DISPUTED")) continue;
    const mandate = recordsWhere(state, "mandates", "id", due.data.mandateId)[0];
    if (!mandate || mandate.status !== "active") continue;
    const failureAt = attemptTime(first);
    if (due.data.amendedAt && String(due.data.amendedAt) > failureAt) continue;
    // Enrolment closes at the end of its WAT day: a failure counts by its West Africa Time date.
    const experiment = recordsWhere(state, "experiments", "data.policyId", policyIdFor(state, due)).find((item) =>
      item.status === "preregistered" && failureAt >= String(item.data.preregisteredAt) && watDate(Date.parse(failureAt)) <= String(item.data.enrolmentClose).slice(0, 10),
    );
    if (!experiment) continue;
    due.data.experimentId = experiment.id;
    due.data.experimentArm = assignArm(String(experiment.data.seed), state.merchant.id, due.id, Number(experiment.data.holdoutShare));
    due.data.firstFailureAt = failureAt;
    due.data.assignmentAt = ctx.now;
    due.updatedAt = ctx.now;
  }
}
