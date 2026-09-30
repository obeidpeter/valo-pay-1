import {
  allocationDecisionDataSchema, counted, businessDateSchema, discountConfirmationDataSchema,
  DEFAULT_ACTIVATION_WINDOW_DAYS, PLATFORM_OWNER, activationReminderCaps, closeRules, failureCodeList, handBackFallbackOwner, isKnownFailureCode,
  heldEvidenceCodes, heldEvidenceOf, moneyText, nairaText, nextCloseInstant, normaliseFailureCode, otherCurrenciesText, passRuleText, paymentUnappliedKobo, providerIdentityConfirmedCode, providerIdentityOf, providerIdentityParts, resolutionCodesForException, resolutionRuleVersion, resolveExceptionType, unseenReversalCodes, unseenReversalOf, withinQuietHours, templateTextProblems,
  changedText, dayText, durationText, instantText, listText, monthText, optionText as option, policyGuardrails, valueLabel, valueWords,
  type CloseTrigger, type HandBackOwner,
} from "@workspace/valopay-schema";
import { findRecord, makeRecord, recordsOf, touch } from "./records";
import {
  REVIEW_SUPERSESSION, allocatePayment, applyConfirmedAllocation, clearSettledExceptions, clearedExceptionsNote, confirmAttemptOutcome, dueStatusText, forgetRejectedMatch,
  currencyOf, heldBatchToConfirm, identityExceptionHeld, paymentRefunded, paymentReversed, reconcile, recordPaymentRefund, refreshHeldEvidence, reinstateAllocation, releaseDispute, releaseDuplicateHold, rememberRejectedMatch, reportsReversal,
  settlePaymentStatus, supersedeAllocation, supersededByReview, withdrawPayerIdentification,
} from "./reconciliation";
import { resolveUnknownCheckout } from "./connected-checkout";
import { buildReports } from "./reports";
import { buildCloseReport, closeSchedule, followingCloseInstant, openingSnapshot, owedCloseDates, scheduledCloseBusinessDate, storedCloseCursor } from "./close";
import { watDate } from "./calendar";
import { issueInvoice } from "./billing";
import { confirmDiscountTerms } from "./commercial-terms";
import type { ActionInput, ActionResult, Context, DomainState, TypedRecord, ValopayRecord } from "./types";
import { assertActionRole, roleRefusal } from "./validation";
import { countedAttempts, evaluateRetry, policyIdFor, policyLineage, policySummary, policyVersionOf, preregisterSample, samePolicyLineage } from "./policy-engine";
import { buildAlerts, type AuditVerification } from "./alerts";

const requiresReason = new Set([
  "kill_switch", "approve_kill_switch_off", "mandate_suspend", "mandate_cancel", "mandate_reinstate", "mandate_reissue", "activation_reminder",
  "submit_policy", "approve_policy", "reject_policy", "new_policy_version", "submit_template", "approve_template", "reject_template", "new_template_version",
  "confirm_allocation", "reject_allocation", "manual_allocate", "review_allocation", "resolve_exception", "record_refund", "release_dispute",
  "simulate_failure", "backtest_policy", "preregister_experiment", "hand_back", "mark_pack_used", "issue_invoice", "confirm_discount_terms", "notify_policy_change", "apply_policy_version",
]);
const DAY_MS = 24 * 60 * 60 * 1000, MINUTE_MS = 60 * 1000;
/** An action this API does not run here, such as one another route handles. */
const UNAVAILABLE_ACTION = "This action is not available. Reload the page and try again.";
/** Customer messages wait out quiet hours. */
const QUIET_HOURS = "Customer messages cannot be sent during quiet hours, from 21:00 to 08:00 WAT. Try again after 08:00 WAT.";
/** A mandate's retry policy changes only to an approved version of the same policy. */
const SAME_POLICY = "Choose an approved version of this mandate’s retry policy.";
/** Who collection is returned to, in a sentence, as the console's Settings names them. */
const ownerPhrases: Record<HandBackOwner, string> = {
  lms: "the loan management system", merchant_manual: "the lender team", provider_auto: "the provider’s automatic collection",
};

/**
 * The lender's contact details as a customer message ends with them: "Questions? Contact our collections team."
 * Contact details saved as a whole instruction ("Contact your lender's collections team") lose their leading verb.
 */
function contactText(state: DomainState): string {
  const route = String(state.settings.contactRoute ?? "").trim().replace(/^contact\s+/i, "").replace(/[\s.]+$/, "");
  return `Questions? Contact ${route || state.merchant.name}.`;
}

/** A policy change notice as the customer reads it: short, in the second person, naming the lender. */
function policyChangeText(state: DomainState, policy: TypedRecord<"policies">): string {
  const d = policy.data;
  const tries = counted(Number(d.maxAttempts ?? policyGuardrails.defaultMaxAttempts), "try", "tries");
  const spacing = d.spacingHours ?? policyGuardrails.defaultSpacingHours;
  const first = d.firstNoticeHours ?? policyGuardrails.defaultFirstNoticeHours, retry = d.retryNoticeHours ?? policyGuardrails.defaultRetryNoticeHours;
  return `${state.merchant.name}: the rules for collecting your payments are changing. From now on, up to ${tries} to collect each payment, at least ${spacing} hours apart${d.partialAllowed ? "" : ", each for the full amount"}. You get a notice ${first} hours before the first try and ${retry} hours before any retry. ${contactText(state)}`;
}

function reason(input: ActionInput): string {
  if (!input.reason?.trim()) throw new Error("Enter a reason for this action. It will be saved in the audit log.");
  return input.reason.trim();
}

function result(message: string, record?: ValopayRecord, data: Record<string, any> = {}): ActionResult {
  // The store appends the canonical transaction-sequenced audit entry and digest.
  return { message, record, data: { ...data, synthetic: true, externalInstructionPerformed: false } };
}

/**
 * The answer to an allocation that identified a payment's payer: the message
 * says so, and data.auditNote, which the audit entry adds to Finance's reason,
 * names the payer by customer reference and the payment.
 */
function payerIdentified(state: DomainState, message: string, record: ValopayRecord, payment: TypedRecord<"payments">): ActionResult {
  const customer = recordsOf(state, "customers").find((item) => item.id === payment.customerId);
  const payer = customer?.reference || payment.customerId;
  return result(`${message} The payer is now recorded as ${customer?.name ? `${customer.name} (${payer})` : payer}.`, record, {
    payerCustomerId: payment.customerId, auditNote: `Payer identified as customer ${payer} for payment ${payment.reference}.`,
  });
}

/**
 * The answer to a review or rejection that withdrew the payer Finance had
 * identified through the match it took out of use (withdrawPayerIdentification):
 * the message says so, and data.auditNote names that customer and the payment.
 */
function payerWithdrawn(state: DomainState, message: string, record: ValopayRecord, payment: TypedRecord<"payments">, customerId: string): ActionResult {
  const customer = recordsOf(state, "customers").find((item) => item.id === customerId);
  const payer = customer?.reference || customerId;
  return result(`${message} The payer Finance identified through that match, ${customer?.name ? `${customer.name} (${payer})` : payer}, is withdrawn. Payment ${payment.reference} has no payer until Finance allocates it to the payer’s instalment.`, record, {
    auditNote: `Payer identification of customer ${payer} withdrawn for payment ${payment.reference}: the match that identified the payer is out of use.`,
  });
}

/** MAN-08 and DEB-06: scheduled attempts are cancelled and logged; in-flight ones complete and are recorded. */
function cancelScheduledAttempts(state: DomainState, now: string, cancellationReason: string, matches: (attempt: TypedRecord<"attempts">) => boolean): string[] {
  return recordsOf(state, "attempts").filter((attempt) => attempt.status === "scheduled" && matches(attempt)).map((attempt) => {
    attempt.status = "cancelled";
    attempt.data.cancellationReason = cancellationReason;
    touch(attempt, now);
    return attempt.id;
  });
}

/** Where a request to lift an emergency stop waits in settings.emergencyStopReleases: the lender's own stop, or a policy version's. */
const stopScope = (policyId?: string) => policyId ? `policy:${policyId}` : "lender";
/** Drops the waiting request to lift a stop, once the stop was set either way. */
function settleStopRelease(state: DomainState, policyId?: string): void {
  const { [stopScope(policyId)]: _settled, ...waiting } = state.settings.emergencyStopReleases || {};
  if (Object.keys(waiting).length) state.settings.emergencyStopReleases = waiting;
  else delete state.settings.emergencyStopReleases;
}
/**
 * Sets a lender's or policy version's emergency stop; turning it on cancels the scheduled attempts under it. Either way a
 * waiting request to lift it is settled: once the stop is on again, or off, there is nothing left to approve.
 */
function switchStop(state: DomainState, ctx: Context, policyId: string | undefined, enabled: boolean): ActionResult {
  if (policyId) state.settings.policyKillSwitches = { ...(state.settings.policyKillSwitches || {}), [policyId]: enabled };
  else state.merchant.killSwitch = enabled;
  settleStopRelease(state, policyId);
  const cancelled = enabled
    ? cancelScheduledAttempts(state, ctx.now, policyId ? "Emergency stop turned on for this retry policy version." : "Emergency stop turned on for this lender.", (attempt) => !policyId || policyIdFor(state, findRecord(state, String(attempt.data.dueItemId), "due-items")) === policyId)
    : [];
  return result(`${policyId ? "Retry policy" : "Lender"} emergency stop is ${enabled ? "on" : "off"}. No collection instruction was sent.`, undefined, { enabled, policyId, cancelledScheduledAttemptIds: cancelled });
}

function dueItemsUnderMandate(state: DomainState, mandateId: string): Set<string> {
  return new Set(recordsOf(state, "due-items").filter((due) => due.data.mandateId === mandateId).map((due) => due.id));
}

/**
 * 7.5: remember the opening position, run the close, then write the REC-07
 * report as immutable evidence.  Each scheduled time closes one business
 * date, the WAT day before it, and checks that date's source files.  A close
 * that starts at or after the oldest scheduled time still owed covers that
 * time alone (REC-01): a scheduled close always, a person's close unless it
 * names another business date.  The cursor then moves one day on, so after
 * an outage every missed business date gets its own catch-up close, oldest
 * first, and the lender stays due until none is owed.  Any close ends a retry
 * the scheduler recorded for failed attempts; a close that starts more than
 * closeRules.lateAfterMinutes after the time it covers is recorded as late.
 * Its alerts take `audit`, the lender's audit chain as the close's write
 * checked it, so a broken chain is listed, naming the entry the overview does.
 */
export function runDailyClose(state: DomainState, ctx: Context, trigger: CloseTrigger, sourceBusinessDate?: string, audit?: AuditVerification | null): ActionResult {
  const now = ctx.now;
  const schedule = closeSchedule(state, now);
  const cursor = storedCloseCursor(state);
  // Nothing is owed while the automatic close is off: switching it on again restarts from the next configured time.
  const pending = schedule.enabled && cursor && Date.parse(cursor) <= Date.parse(now) ? cursor : null;
  const pendingDate = pending ? scheduledCloseBusinessDate(pending) : null;
  const scheduledFor = pending && (trigger === "scheduled" || !sourceBusinessDate || sourceBusinessDate === pendingDate) ? pending : null;
  const runDate = watDate(Date.parse(now));
  const businessDate = scheduledFor ? pendingDate! : sourceBusinessDate ?? (trigger === "scheduled" ? scheduledCloseBusinessDate(now) : runDate);
  const delayMinutes = scheduledFor ? Math.floor((Date.parse(now) - Date.parse(scheduledFor)) / MINUTE_MS) : null;
  const late = delayMinutes !== null && delayMinutes > closeRules.lateAfterMinutes;
  const opening = openingSnapshot(state);
  const reconciled = reconcile(state, ctx);
  const report = buildCloseReport(state, ctx, opening, reconciled.data);
  report.alerts = buildAlerts(state, now, audit);
  const reports = buildReports(state, now);
  if (scheduledFor) state.settings.nextCloseAt = followingCloseInstant(scheduledFor, schedule.time);
  else if (!cursor) state.settings.nextCloseAt = nextCloseInstant(now, schedule.time);
  delete state.settings.closeRetry;
  const owed = owedCloseDates(state, now).total;
  // Waiting payments count in every currency; money in another currency than naira is named beside the count.
  const others = Object.keys(report.unallocated.otherCurrencies ?? {}).length;
  const otherMoney = others ? `, including ${otherCurrenciesText(report.unallocated.otherCurrencies)} in ${others === 1 ? "another currency" : "other currencies"}` : "";
  const summary = `${counted(report.observations.received, "payment evidence record")} received, ${counted(report.allocated.count, "allocation")} confirmed, ${report.unallocated.count} unallocated (${report.unallocated.olderThan24Hours} older than 24 hours)${otherMoney}, ${counted(report.exceptions.opened.count, "exception")} opened and ${report.exceptions.closed.count} closed, ${counted(report.customerPositionsChanged.length, "customer position")} changed.`;
  const close = makeRecord(state, "closes", {
    name: `Daily close ${dayText(runDate)}${trigger === "scheduled" ? " · scheduled" : ""}${businessDate === runDate ? "" : ` · business date ${dayText(businessDate)}`}`, status: "completed", createdAt: now,
    data: {
      summary, metrics: reports.metrics, closedAt: now, period: report.period, report, operational: reports.operational, positionAlert: report.positionRebuild.alert,
      sourceBusinessDate: businessDate, schedule: { trigger, scheduledFor, delayMinutes, late, nextAt: state.settings.nextCloseAt }, synthetic: true,
    },
  });
  const lateness = late ? ` ${durationText(delayMinutes)} after its ${schedule.time} WAT time` : "";
  const stillOwed = owed ? ` ${counted(owed, "missed business date is", "missed business dates are")} still to close.` : "";
  const message = trigger === "scheduled"
    ? `Scheduled daily close of ${dayText(businessDate)} completed${lateness}.${stillOwed} No data was fetched from the provider or sent to the loan management system.`
    : scheduledFor
      ? `Daily close of ${dayText(businessDate)} completed in place of its scheduled close${lateness ? `,${lateness}` : ""}.${stillOwed} No data was fetched from the provider or sent to the loan management system.`
      : `Daily close completed.${stillOwed} No data was fetched from the provider or sent to the loan management system.`;
  return result(message, close, { ...reconciled.data, closeId: close.id, positionAlert: report.positionRebuild.alert, schedule: close.data.schedule });
}

/** Actions that can settle what an open exception waits for: an exception whose condition cleared closes in the same action. */
const settlingActions = new Set(["confirm_allocation", "manual_allocate", "review_allocation", "resolve_exception", "record_refund", "release_dispute"]);

/**
 * Runs a domain action. After one that moves money or a dispute, each open
 * exception whose condition cleared is closed, and the audit entry names them
 * (data.auditNote, added to the reason); held evidence is re-derived as the
 * payments it names now stand (refreshHeldEvidence). A reconciliation or close
 * does the same itself. `audit` is the lender's audit chain as the write
 * checked it, which a daily close lists among its alerts.
 */
export function executeAction(state: DomainState, ctx: Context, input: ActionInput, options: { audit?: AuditVerification | null } = {}): ActionResult {
  const answer = runAction(state, ctx, input, options.audit);
  if (!settlingActions.has(input.action)) return answer;
  refreshHeldEvidence(state, ctx);
  const note = clearedExceptionsNote(clearSettledExceptions(state, ctx));
  if (!note) return answer;
  return { ...answer, data: { ...answer.data, auditNote: [answer.data.auditNote, note].filter(Boolean).join(" ") } };
}

/** The answer when an instalment left dispute: where it stands now, and the audit note that records how it left. */
function releasedAnswer(record: ValopayRecord, due: TypedRecord<"due-items">, via: "not_upheld" | "finance_release"): ActionResult {
  const standing = due.status === "paid" ? "paid" : `${dueStatusText(due.status)}, with ${nairaText(Number(due.data.outstandingKobo ?? due.amountKobo))} outstanding`;
  const next = due.status === "paid" ? "Nothing is outstanding." : "Collection and allocation can resume.";
  return result(`${via === "not_upheld" ? "Exception resolution recorded. " : ""}Instalment ${due.reference} is out of dispute and is now ${standing}. ${next}`, record, {
    dueStatus: due.status,
    auditNote: via === "not_upheld" ? `Dispute not upheld: instalment ${due.reference} is out of dispute, now ${standing}.` : `Instalment ${due.reference} released from dispute by Finance, now ${standing}.`,
  });
}

function runAction(state: DomainState, ctx: Context, input: ActionInput, audit?: AuditVerification | null): ActionResult {
  if (!input.action) throw new Error("This request names no action. Reload the page and try again.");
  if (requiresReason.has(input.action)) reason(input);
  const data = input.data || {};
  const now = ctx.now;
  if (input.action === "request_instruction") throw new Error("This sandbox can never send an instruction to a provider or bank. It only records sample payment evidence.");
  if (input.action === "set_role" || input.action === "verify_audit" || input.action === "create_export") throw new Error(UNAVAILABLE_ACTION);

  if (input.action === "kill_switch") {
    assertActionRole(ctx, ["Admin"], "turn the emergency stop on or off");
    if (typeof data.enabled !== "boolean") throw new Error("Choose whether the emergency stop is on or off.");
    // Approved policy versions are immutable, so a version's switch lives in merchant settings (DEB-06).
    const policyId = data.policyId ? findRecord(state, String(data.policyId), "policies").id : undefined;
    const scope = stopScope(policyId), on = policyId ? state.settings.policyKillSwitches?.[policyId] === true : state.merchant.killSwitch === true;
    if (!data.enabled && on && ctx.accessMode === "staff") {
      // A staff pilot lifts a stop only with a second administrator: this is the request, and the stop stays on (approve_kill_switch_off).
      state.settings.emergencyStopReleases = { ...(state.settings.emergencyStopReleases || {}), [scope]: { requestedBy: ctx.actor, requestedAt: now, reason: reason(input), policyId: policyId ?? null } };
      return result(`The ${policyId ? "retry policy" : "lender"} emergency stop stays on until a different Admin approves turning it off. Your request is saved. No collection instruction was sent.`, undefined, { enabled: true, policyId, releaseRequested: true, cancelledScheduledAttemptIds: [] });
    }
    return switchStop(state, ctx, policyId, data.enabled);
  }
  if (input.action === "approve_kill_switch_off") {
    assertActionRole(ctx, ["Admin"], "approve turning off the emergency stop");
    const policyId = data.policyId ? findRecord(state, String(data.policyId), "policies").id : undefined;
    const request = state.settings.emergencyStopReleases?.[stopScope(policyId)];
    if (!request) throw Object.assign(new Error(`No request to turn off the ${policyId ? "retry policy" : "lender"} emergency stop is waiting. Reload the page to see its current state: one Admin asks, then a different Admin approves.`), { status: 409 });
    // A staff actor is the verified Clerk user the principal is derived from, so a different actor is a different person.
    if (request.requestedBy === ctx.actor) throw Object.assign(new Error("A different Admin must approve turning off the emergency stop. If your pilot has only one Admin, ask the Valo Pay team to add a second."), { status: 403 });
    const lifted = switchStop(state, ctx, policyId, false);
    return { ...lifted, data: { ...lifted.data, requestedBy: request.requestedBy, requestedAt: request.requestedAt, auditNote: `Approved the request by ${request.requestedBy} at ${instantText(request.requestedAt)}: ${request.reason}` } };
  }
  if (["mandate_suspend", "mandate_cancel", "mandate_reinstate"].includes(input.action)) {
    assertActionRole(ctx, ["Admin", "Operations"], input.action === "mandate_suspend" ? "suspend a mandate" : input.action === "mandate_cancel" ? "cancel a mandate" : "resume a mandate");
    const mandate = findRecord(state, String(input.recordId), "mandates");
    const dues = dueItemsUnderMandate(state, mandate.id);
    if (input.action === "mandate_suspend") {
      if (mandate.status !== "active") throw new Error("Only an active mandate can be suspended.");
      mandate.status = "suspended"; mandate.data.suspendedAt = now;
    }
    if (input.action === "mandate_cancel") {
      if (!["draft", "submitted", "pending_activation", "active", "suspended"].includes(mandate.status)) throw new Error(`This mandate is ${valueWords(mandate.status)}, so it cannot be cancelled.`);
      mandate.status = "cancelled"; mandate.data.cancelledAt = now;
    }
    if (input.action === "mandate_reinstate") {
      if (mandate.status !== "suspended") throw new Error("Only a suspended mandate can be resumed.");
      mandate.status = "active"; mandate.data.reinstatedAt = now;
    }
    const cancelled = input.action === "mandate_reinstate" ? [] : cancelScheduledAttempts(state, now, `Mandate ${valueWords(mandate.status)}. No instruction was sent.`, (attempt) => dues.has(String(attempt.data.dueItemId)));
    mandate.data.lastActionReason = reason(input); touch(mandate, now);
    return result(`Mandate ${input.action === "mandate_reinstate" ? "resumed" : valueWords(mandate.status)}. An update for the loan management system has been recorded. No external instruction was sent.`, mandate, { cancelledScheduledAttemptIds: cancelled });
  }
  if (input.action === "mandate_reissue") {
    assertActionRole(ctx, ["Admin", "Operations"], "reissue a mandate");
    const old = findRecord(state, String(input.recordId), "mandates");
    if (!["pending_activation", "expired", "cancelled", "failed"].includes(old.status)) throw new Error("You can reissue a mandate only if it expired, was cancelled, failed or is still awaiting activation.");
    if (!data.consentEvidence || typeof data.consentEvidence !== "string") throw new Error("Enter a new consent evidence reference to reissue this mandate.");
    // MAN-02: the new consent may cover a new limit; the limit of an existing mandate never changes.
    const limitKobo = data.amountKobo === undefined || data.amountKobo === null || data.amountKobo === "" ? old.amountKobo : data.amountKobo;
    if (!Number.isSafeInteger(limitKobo) || Number(limitKobo) < 1) throw new Error("Enter the debit limit the new consent covers. It must be more than ₦0.");
    // RET-07: fresh consent covers the current approved version of the same policy, or the version named in data.policyId.
    const target = data.policyId ? findRecord(state, String(data.policyId), "policies") : recordsOf(state, "policies").find((item) => item.id === old.data.policyId);
    if (data.policyId && (target!.status !== "approved" || (old.data.policyId && !samePolicyLineage(state, String(old.data.policyId), target!.id)))) throw new Error(SAME_POLICY);
    // MAN-06: a new mandate and a new consent record; the old records are never edited.
    const fresh = makeRecord(state, "mandates", {
      name: `${old.name} · reissued`, status: "pending_activation", customerId: old.customerId, amountKobo: Number(limitKobo), createdAt: now,
      data: {
        workflow: old.data.workflow, frequency: old.data.frequency, policyId: target?.id ?? old.data.policyId, origin: "reissued", reissuedFrom: old.id,
        consentPolicyId: target?.id, consentPolicyVersion: target ? Number(target.data.version || 1) : undefined, consentPolicySummary: target ? policySummary(target) : undefined,
        consentEvidence: String(data.consentEvidence), consentGaps: [], consentCapturedAt: now, consentChannel: data.consentChannel || "merchant_staff",
        activationDeadline: new Date(Date.parse(now) + DEFAULT_ACTIVATION_WINDOW_DAYS * DAY_MS).toISOString(), reminderCount: 0, reissueReason: reason(input),
      },
    });
    if (old.status === "pending_activation") { old.status = "expired"; old.data.supersededBy = fresh.id; touch(old, now); }
    return result("A new mandate and consent record have been created. No instruction was sent to the provider.", fresh, { supersededMandateId: old.id });
  }
  if (input.action === "activation_reminder") {
    assertActionRole(ctx, ["Admin", "Operations"], "record an activation reminder");
    const mandate = findRecord(state, String(input.recordId), "mandates");
    if (mandate.status !== "pending_activation") throw new Error(`This mandate is ${valueWords(mandate.status)}. Activation reminders are only for mandates awaiting activation.`);
    const workflow = String(mandate.data.workflow) as keyof typeof activationReminderCaps;
    const cap = activationReminderCaps[workflow] ?? activationReminderCaps.hosted_consent;
    if (workflow === "hosted_consent" && mandate.data.consentGiven) throw new Error("The customer has already given consent. Activation is now with the bank, so no reminder is needed.");
    if (withinQuietHours(Date.parse(now))) throw new Error(QUIET_HOURS);
    const count = Number(mandate.data.reminderCount || 0);
    if (count >= cap) throw new Error(`This mandate has had the most activation reminders allowed (${cap}). Reissue the mandate if the customer still needs to activate it.`);
    mandate.data.reminderCount = count + 1; mandate.data.lastReminderAt = now; mandate.data.lastActionReason = reason(input); touch(mandate, now);
    const notification = makeRecord(state, "notifications", {
      name: "Activation reminder", status: "simulated", customerId: mandate.customerId, createdAt: now,
      data: { purpose: "activation_reminder", channel: "sms", class: "reminder", mandateId: mandate.id, sequence: count + 1, cap, submittedAt: now, acceptedAt: null, deliveredAt: null, renderedText: `${state.merchant.name}: please ${workflow === "hosted_consent" ? "use the consent link you were sent" : "make the activation transfer"} to set up your direct debit. This is reminder ${count + 1} of ${cap}.`, simulated: true },
    });
    return result(`Activation reminder ${count + 1} of ${cap} recorded as a simulation. No message left Valo Pay.`, mandate, { notificationId: notification.id });
  }
  if (["submit_policy", "approve_policy", "reject_policy", "new_policy_version"].includes(input.action)) {
    const policy = findRecord(state, String(input.recordId), "policies");
    if (input.action === "submit_policy") {
      assertActionRole(ctx, ["Admin"], "submit a retry policy");
      if (!["draft", "rejected"].includes(policy.status)) throw new Error(`This retry policy is ${valueWords(policy.status)}, so it cannot be submitted.`);
      policy.status = "submitted"; policy.data.author = ctx.actor; policy.data.submittedAt = now;
    }
    if (input.action === "approve_policy") {
      assertActionRole(ctx, ["Compliance reviewer"], "approve a retry policy");
      if (policy.status !== "submitted" || !policy.data.author || policy.data.author === ctx.actor) throw new Error("Submit the retry policy for review, then ask a Compliance reviewer other than its author to approve it.");
      // One approved number names one set of rules: consent records, notices and decisions quote it.
      const version = policyVersionOf(policy);
      if (policyLineage(state, policy).some((item) => item.id !== policy.id && item.status === "approved" && policyVersionOf(item) === version)) {
        throw Object.assign(new Error(`Version ${version} of this retry policy is already approved with its own rules. Reject this submission, then draft the next version from the approved one so it gets a new number.`), { status: 409 });
      }
      policy.status = "approved"; policy.data.reviewer = ctx.actor; policy.data.approvedAt = now;
    }
    if (input.action === "reject_policy") {
      assertActionRole(ctx, ["Compliance reviewer"], "reject a retry policy");
      if (policy.status !== "submitted") throw new Error("Only a submitted retry policy can be rejected.");
      policy.status = "rejected"; policy.data.reviewer = ctx.actor; policy.data.rejectedAt = now;
    }
    if (input.action === "new_policy_version") {
      assertActionRole(ctx, ["Admin"], "draft a new version of a retry policy");
      const { reviewer: _reviewer, approvedAt: _approvedAt, submittedAt: _submittedAt, rejectedAt: _rejectedAt, ...carried } = policy.data;
      // Numbered after every version of the policy, drafts and rejected ones included, so two drafts from one version never share a number.
      const versions = policyLineage(state, policy).map(policyVersionOf);
      if (versions.some((version) => !Number.isSafeInteger(version) || version < 1)) throw new Error("This retry policy’s history has an invalid version number. Ask the Valo Pay team to check it.");
      const latest = Math.max(...versions);
      if (latest >= Number.MAX_SAFE_INTEGER) throw new Error("This retry policy has reached the highest version number Valo Pay supports.");
      const copy = makeRecord(state, "policies", { name: policy.name, status: "draft", amountKobo: 0, createdAt: now, data: { ...carried, version: latest + 1, author: ctx.actor, previousVersionId: policy.id } });
      return result("Draft policy version created.", copy);
    }
    policy.data.lastActionReason = reason(input); touch(policy, now);
    return result(`Retry policy ${valueWords(policy.status)}.`, policy);
  }
  if (["submit_template", "approve_template", "reject_template", "new_template_version"].includes(input.action)) {
    const template = findRecord(state, String(input.recordId), "templates");
    if (input.action === "new_template_version") {
      assertActionRole(ctx, ["Admin"], "draft a new version of a message template");
      if (template.status !== "approved") throw new Error("Draft a new version only from an approved message template. Edit or finish reviewing the existing draft first.");
      const templates = recordsOf(state, "templates");
      const rootOf = (record: TypedRecord<"templates">): string => {
        const visited = new Set<string>();
        let current = record;
        while (current.data.previousVersionId) {
          if (visited.has(current.id)) throw new Error("This message template’s version history is broken, so a new draft cannot be created. Ask the Valo Pay team to check it.");
          visited.add(current.id);
          const previous = templates.find(item => item.id === current.data.previousVersionId);
          if (!previous) throw new Error("An earlier version of this message template is missing, so a new draft cannot be created. Ask the Valo Pay team to restore it.");
          current = previous;
        }
        return current.id;
      };
      const rootId = rootOf(template);
      const family = new Set([rootId]);
      let remaining = templates.filter(item => item.id !== rootId);
      while (true) {
        const children = remaining.filter(item => family.has(String(item.data.previousVersionId || '')));
        if (!children.length) break;
        children.forEach(item => family.add(item.id));
        remaining = remaining.filter(item => !family.has(item.id));
      }
      const versions = templates.filter(item => family.has(item.id)).map(item => Number(item.data.version || 1));
      if (versions.some(version => !Number.isSafeInteger(version) || version < 1)) throw new Error("This message template’s history has an invalid version number. Ask the Valo Pay team to check it.");
      if (Math.max(...versions) >= Number.MAX_SAFE_INTEGER) throw new Error("This message template has reached the highest version number Valo Pay supports.");
      const { reviewer: _reviewer, approvedAt: _approved, submittedAt: _submitted, rejectedAt: _rejected, rejectionReason: _rejection, reviewHistory: _history, lastActionReason: _reason, ...carried } = template.data;
      const copy = makeRecord(state, "templates", { name: template.name, status: "draft", createdAt: now, data: { ...carried, version: Math.max(...versions) + 1, author: ctx.actor, previousVersionId: template.id, templateRootId: rootId } });
      return result("Draft template version created. The approved version is unchanged.", copy);
    }
    if (input.action === "submit_template") {
      assertActionRole(ctx, ["Admin"], "submit a message template");
      if (!["draft", "rejected"].includes(template.status)) throw new Error(`This message template is ${valueWords(template.status)}, so it cannot be submitted.`);
      if (!template.data.author || template.data.author !== ctx.actor) throw new Error("Only the template’s author can submit it for review.");
      const problems = templateTextProblems(template.data.text);
      if (problems.length) throw new Error(problems.join(' '));
      template.status = "submitted"; template.data.submittedAt = now;
    } else {
      assertActionRole(ctx, ["Compliance reviewer"], input.action === "approve_template" ? "approve a message template" : "reject a message template");
      if (!template.data.author || template.data.author === ctx.actor || template.status !== "submitted") throw new Error("Submit the message template for review, then ask a Compliance reviewer other than its author to approve or reject it.");
      if (input.action === "approve_template") {
        const problems = templateTextProblems(template.data.text);
        if (problems.length) throw new Error(problems.join(' '));
        template.status = "approved"; template.data.approvedAt = now;
      } else {
        template.status = "rejected"; template.data.rejectedAt = now; template.data.rejectionReason = reason(input);
      }
      template.data.reviewer = ctx.actor;
      template.data.reviewHistory = [...(Array.isArray(template.data.reviewHistory) ? template.data.reviewHistory : []), { status: template.status, reviewer: ctx.actor, at: now, reason: reason(input) }];
    }
    template.data.lastActionReason = reason(input);
    touch(template, now); return result(`Message template ${valueWords(template.status)}.`, template);
  }
  if (input.action === "run_reconciliation") {
    assertActionRole(ctx, ["Admin", "Operations", "Finance"], "run reconciliation");
    const reconciled = reconcile(state, ctx);
    return result(reconciled.message, undefined, reconciled.data);
  }
  if (input.action === "daily_close") {
    assertActionRole(ctx, ["Admin", "Operations", "Finance"], "run a daily close");
    const sourceDate = data.sourceBusinessDate === undefined ? undefined : businessDateSchema.parse(data.sourceBusinessDate);
    if (sourceDate && sourceDate > watDate(Date.parse(ctx.now))) throw new Error("Choose today or an earlier business date. A daily close cannot cover a future date.");
    return runDailyClose(state, ctx, "manual", sourceDate, audit);
  }
  if (["confirm_allocation", "reject_allocation", "manual_allocate"].includes(input.action)) {
    assertActionRole(ctx, ["Admin", "Finance"], input.action === "manual_allocate" ? "allocate a payment" : "confirm or reject a match");
    // A decision names the proposal it was made on: without the pair it is refused, naming what it lacks, before the payment is read.
    const reviewed = input.action === "manual_allocate" ? undefined : allocationDecisionDataSchema.parse(data, { path: ["data"] });
    const payment = findRecord(state, String(input.recordId), "payments");
    // Evidence that named no payer is applied only here, and applying it identifies the payer in the same action.
    const identifying = !payment.customerId;
    if (input.action === "manual_allocate") {
      const due = findRecord(state, String(data.dueItemId), "due-items");
      const why = reason(input);
      const allocation = allocatePayment(state, ctx, payment, due, Number(data.amountKobo), "R7", "manual", false, identifying ? `Finance identified the payer and allocated manually: ${why}` : `Finance allocated manually: ${why}`, why);
      // Finance's own allocation outranks an earlier "not this instalment".
      forgetRejectedMatch(payment, due.id);
      return identifying ? payerIdentified(state, "Manual allocation recorded by Finance.", allocation, payment) : result("Manual allocation recorded by Finance.", allocation);
    }
    const allocation = recordsOf(state, "allocations").find((item) => item.data.paymentId === payment.id && item.status === "proposed");
    if (!allocation) throw new Error("This payment has no proposed match to review. Reload the page to see its current status.");
    // The decision is on the proposal reviewed, not whichever proposal happens to be current when its request
    // arrives; its version is compared as an instant, as a record's is (assertRecordVersion).
    if (reviewed!.proposalId !== allocation.id || Date.parse(reviewed!.proposalUpdatedAt) !== Date.parse(allocation.updatedAt)) {
      throw Object.assign(new Error(changedText("proposed match")), { status: 409 });
    }
    let withdrawn: string | undefined;
    if (input.action === "reject_allocation") {
      allocation.status = "superseded"; allocation.data.supersededReason = reason(input);
      // The rejection sticks: automatic matching does not propose this instalment for the payment again,
      // and the payment keeps whatever it has already applied elsewhere.
      rememberRejectedMatch(payment, allocation.data.dueItemId);
      settlePaymentStatus(state, ctx, payment);
      withdrawn = withdrawPayerIdentification(state, ctx, payment, reason(input));
    } else {
      applyConfirmedAllocation(state, ctx, allocation, reason(input));
      allocation.data.confirmedBy = ctx.actor;
    }
    touch(allocation, now); touch(payment, now);
    if (identifying && input.action === "confirm_allocation") return payerIdentified(state, "Allocation confirmed.", allocation, payment);
    if (withdrawn) return payerWithdrawn(state, "Allocation rejected.", allocation, payment, withdrawn);
    return result(`Allocation ${input.action === "reject_allocation" ? "rejected" : "confirmed"}.`, allocation);
  }
  if (input.action === "review_allocation") {
    assertActionRole(ctx, ["Admin", "Finance"], "review a match");
    const allocation = findRecord(state, String(input.recordId), "allocations");
    if (typeof data.correct !== "boolean") throw new Error("Choose whether the allocation is correct.");
    if (allocation.status === "proposed") throw Object.assign(new Error("This match is still a proposal. Confirm or reject it in Matches to review instead."), { status: 409 });
    const payment = findRecord(state, String(allocation.data.paymentId), "payments");
    const why = reason(input);
    // Applying the match again to a payment with no payer identifies the payer again.
    const identifying = !payment.customerId;
    let message: string, withdrawn: string | undefined, reinstated = false;
    if (data.correct) {
      if (supersededByReview(allocation)) {
        // A match this review had marked wrong is applied again, or refused while the records have moved on.
        reinstateAllocation(state, ctx, allocation, why);
        reinstated = true;
        message = "Allocation reviewed as correct. Its money is allocated to the instalment again.";
      } else {
        message = allocation.status === "superseded" ? "Allocation reviewed as correct. It stays out of use, because it was taken out of use for another reason, such as a reversal." : "Allocation reviewed as correct.";
      }
    } else {
      // REC-09: the wrong pair is remembered, so the next close does not recreate the same match.
      rememberRejectedMatch(payment, allocation.data.dueItemId);
      if (allocation.status === "confirmed") {
        supersedeAllocation(state, ctx, allocation, `${REVIEW_SUPERSESSION}: ${why}`);
        allocation.data.supersededByReview = true;
        message = "Allocation marked incorrect and no longer applied. The payment and instalment are open for review again, and automatic matching will not pair them again.";
      } else {
        touch(payment, now);
        message = "Allocation marked incorrect. It was already out of use, and automatic matching will not pair this payment and instalment again.";
      }
      // Decision on a payer identified through a wrong match: with nothing of the payment still applied, the identification goes too.
      withdrawn = withdrawPayerIdentification(state, ctx, payment, why);
    }
    allocation.data.reviewed = data.correct; allocation.data.reviewReason = why; allocation.data.reviewedBy = ctx.actor; allocation.data.reviewedAt = now;
    touch(allocation, now);
    if (withdrawn) return payerWithdrawn(state, message, allocation, payment, withdrawn);
    if (reinstated && identifying) return payerIdentified(state, message, allocation, payment);
    return result(message, allocation);
  }
  if (input.action === "release_dispute") {
    // Decision on leaving a dispute: Finance releases an instalment from dispute with a reason; its status then follows its balance.
    assertActionRole(ctx, ["Admin", "Finance"], "release an instalment from dispute");
    const due = findRecord(state, String(input.recordId), "due-items");
    const closed = releaseDispute(state, ctx, due, { via: "finance_release", reason: reason(input) });
    const answer = releasedAnswer(due, due, "finance_release");
    const note = clearedExceptionsNote(closed);
    return note ? { ...answer, data: { ...answer.data, auditNote: `${answer.data.auditNote} ${note}` } } : answer;
  }
  if (input.action === "resolve_exception") {
    assertActionRole(ctx, ["Admin", "Finance", "Operations"], "resolve an exception");
    const item = findRecord(state, String(input.recordId), "exceptions");
    if (item.data.legacyResolutionReview) assertActionRole(ctx, ["Admin", "Finance"], "resolve a reversal review");
    // FIN-03: a batch held for its provider identity is released only by Finance's, or an administrator's, confirmation of whose payout it is.
    const identityHold = resolveExceptionType(item.data.type) === "settlement_variance" && providerIdentityOf(item.data.condition) !== undefined;
    if (identityHold && !["Admin", "Finance"].includes(ctx.role)) throw Object.assign(new Error(roleRefusal(ctx, ["Admin", "Finance"], "resolve this exception", "resolving it confirms whose payout the settlement batch is")), { status: 403 });
    if (item.data.case?.assignee && item.data.case.assignee !== ctx.actor && ctx.role !== 'Admin') throw Object.assign(new Error("Only the person this case is assigned to, or an Admin, can resolve this exception. Financial review is a separate step."), { status: 409 });
    if (["resolved", "closed"].includes(item.status)) throw new Error("This exception is already resolved. Reload the page to see how it was resolved.");
    // Codes that apply to this exception as it stands now: held evidence is re-derived first, so joining it to its payment is
    // accepted only while it is held for its connection alone, whatever condition an earlier state or build recorded.
    if (resolveExceptionType(item.data.type) === "suspected_duplicate") refreshHeldEvidence(state, ctx, item);
    // A confirmation is checked against the batch as it stands now, before the codes: a batch no longer held, as when it was
    // released while the dialog was open, answers 409 so the person refreshes, and so does an identity another batch records
    // or claims, a collision only the data owner settles; an identity the batch was not held for answers 400.
    const identity = typeof data.confirmedProviderIdentity === "string" && data.confirmedProviderIdentity.trim() ? data.confirmedProviderIdentity : undefined;
    const heldBatch = identityHold && data.resolutionCode === providerIdentityConfirmedCode ? heldBatchToConfirm(state, item, identity) : undefined;
    // While its batch is held, any other code would close the exception while the batch stays held with its evidence
    // uncounted, with no way out. Once it is not, an earlier build's hold exception stays open only for the reports it carries.
    const identityHeldNow = identityHold && (heldBatch !== undefined || identityExceptionHeld(state, item));
    if (identityHeldNow && data.resolutionCode !== providerIdentityConfirmedCode) throw new Error(`Choose ${option(providerIdentityConfirmedCode)}: this settlement batch stays held until Finance or an Admin confirms whose payout it is. If the providers cannot say which connection it belongs to, leave this exception open until the data owner corrects the evidence. The next reconciliation then releases the batch and closes the exception.`);
    const allowed = resolutionCodesForException(item, { identityHeld: identityHeldNow });
    if (!allowed.includes(String(data.resolutionCode))) throw new Error(`This resolution is not available for this exception now. Choose one of these: ${listText(allowed.map(option))}.`);
    const type = resolveExceptionType(item.data.type);
    // Item 10: an unknown outcome of a pay-by-bank checkout is Finance's to record, with the evidence when it was paid.
    const checkout = type === "unknown_outcome" ? recordsOf(state, "connected-intents").find((record) => record.id === item.data.linkedRecordId) : undefined;
    const evidenceReference = typeof data.evidenceReference === "string" && data.evidenceReference.trim() ? data.evidenceReference.trim() : undefined;
    if (checkout) {
      if (!["Admin", "Finance"].includes(ctx.role)) throw Object.assign(new Error(roleRefusal(ctx, ["Admin", "Finance"], "record the outcome of a Pay by Bank checkout", "confirming it as received records a payment")), { status: 403 });
      if (data.confirmedFailureCode !== undefined && data.confirmedFailureCode !== null && data.confirmedFailureCode !== "") throw new Error(`A failure code is only for a collection attempt. For a Pay by Bank checkout, choose ${option("resolved_succeeded")} with its evidence reference, or ${option("resolved_failed")}.`);
      if (data.resolutionCode === "resolved_succeeded" && !evidenceReference) throw new Error("Enter the evidence reference that shows the payment arrived, such as a masked bank statement line.");
      if (evidenceReference && /\d{8,}/.test(evidenceReference)) throw new Error("Enter a masked evidence reference, such as STMT-***4411. Do not enter a full account or statement number.");
      if (evidenceReference && data.resolutionCode !== "resolved_succeeded") throw new Error("Leave the evidence reference blank unless the payment is confirmed as received.");
    } else if (evidenceReference) throw new Error("Leave the evidence reference blank. It is only for a Pay by Bank checkout whose outcome was unknown and is confirmed as received.");
    // FIN-03: only Finance, or an administrator, confirms whose payout a batch held for its provider identity is, naming one of the identities it was held for.
    if (data.resolutionCode !== providerIdentityConfirmedCode && identity !== undefined) throw new Error(`Leave the provider identity blank unless you resolve a held settlement batch as ${option(providerIdentityConfirmedCode)}.`);
    const confirmedCode = data.confirmedFailureCode === undefined || data.confirmedFailureCode === null || data.confirmedFailureCode === "" ? undefined : data.confirmedFailureCode;
    if (confirmedCode !== undefined) {
      if (type !== "unknown_outcome" || data.resolutionCode !== "resolved_failed") throw new Error(`Leave the failure code blank unless you resolve an unknown outcome as ${option("resolved_failed")}.`);
      if (!isKnownFailureCode(confirmedCode) || normaliseFailureCode(confirmedCode) === "TIMEOUT_UNKNOWN") throw new Error(`Choose the failure code the provider confirmed: ${listText(failureCodeList.filter((code) => code !== "TIMEOUT_UNKNOWN").map((code) => valueLabel(code)))}.`);
    }
    // The rules the resolution follows, so it keeps the meaning its answer gives it whatever a later build changes.
    item.status = "resolved"; item.data.resolutionCode = data.resolutionCode; item.data.notes = reason(input); item.data.resolvedBy = ctx.actor; item.data.resolvedAt = now; item.data.resolutionRuleVersion = resolutionRuleVersion;
    if (confirmedCode !== undefined) item.data.confirmedFailureCode = normaliseFailureCode(confirmedCode);
    if (heldBatch) item.data.confirmedProviderIdentity = identity;
    if (!type) item.data.legacyType = true;
    touch(item, now);
    if (heldBatch) return result(`Exception resolution recorded. The next reconciliation releases settlement batch ${heldBatch.reference} as the payout of ${providerIdentityParts(identity)?.connection ?? identity}. Evidence from that connection, and evidence that names no connection, stays with the batch. Settlement lines from other connections move to their own batches, and their statement credits are left to link to theirs. The expected fee leaves out the lines that move. So do the amounts before fees, fee and after fees, unless they were typed by hand. No money moves.`, item, { settlementBatchId: heldBatch.id, providerIdentity: identity });
    if (item.data.legacyResolutionReview) return result("Reversal review recorded. The earlier decision and its history are unchanged. Run reconciliation to apply this decision. It returns each instalment the review paused to its status before the hold, unless a dispute was recorded for it meanwhile. A paid instalment, or one unpaid after its final attempt, kept its status throughout. Allocations and reversals already applied change only through the usual reversal or correction steps.", item);
    if (checkout) {
      const settled = resolveUnknownCheckout(state, ctx, item, checkout, { reason: reason(input), evidenceReference });
      const receipt = settled === "confirmed" ? recordsOf(state, "payments").find((record) => record.id === checkout.data.paymentId) : undefined;
      const applied = receipt ? (paymentUnappliedKobo(receipt) === 0 ? " and allocated to its instalment" : ". What it could not allocate to its instalment waits for Finance, with an exception") : "";
      const instalment = recordsOf(state, "due-items").find((record) => record.id === checkout.data.dueItemId)?.reference ?? String(checkout.data.dueItemId);
      const auditNote = settled === "confirmed" ? `Pay by Bank payment of ${nairaText(checkout.amountKobo)} for instalment ${instalment} recorded as received, with evidence ${evidenceReference}.`
        : settled === "failed" ? `Pay by Bank payment of ${nairaText(checkout.amountKobo)} for instalment ${instalment} recorded as failed.` : undefined;
      return result(settled === "confirmed"
        ? `Exception resolution recorded. The Pay by Bank payment is recorded as received with evidence ${evidenceReference}${applied}. Its instalment is released: the checkout no longer holds it.`
        : settled === "failed"
          ? "Exception resolution recorded. The Pay by Bank payment is recorded as failed, and its instalment is released: a new checkout or retry may be planned."
          : "Exception resolution recorded. The checkout’s outcome was already recorded.", item, settled ? { checkoutStatus: settled, auditNote } : {});
    }
    // Decision on leaving a dispute: not upheld takes the instalment out of dispute; another resolution leaves it for Finance to release.
    const disputed = type === "customer_dispute" ? recordsOf(state, "due-items").find((record) => record.id === item.data.linkedRecordId && record.status === "in_dispute") : undefined;
    if (disputed && data.resolutionCode === "not_upheld") {
      releaseDispute(state, ctx, disputed, { via: "not_upheld", reason: reason(input), exceptionId: item.id });
      return releasedAnswer(item, disputed, "not_upheld");
    }
    if (disputed) return result(`Exception resolution recorded. Instalment ${disputed.reference} stays in dispute, so collection and allocation stay paused until Finance releases it from dispute with a reason.`, item, { dueStatus: disputed.status });
    // An unknown outcome's resolution is what the provider confirmed, so the attempt takes that outcome.
    const outcome = type === "unknown_outcome" ? confirmAttemptOutcome(state, ctx, item) : undefined;
    if (outcome) return result(`Exception resolution recorded. The collection attempt is now recorded as ${valueWords(outcome)}.`, item, { attemptStatus: outcome });
    // A suspected duplicate resolved as a separate payment leaves its hold. For held evidence, and a reversal that waited for a
    // payment no connection had seen, the next reconciliation reads Finance's resolution before it looks for any payment
    // (financeDecision in reconciliation), and the answer says what that does.
    const released = type === "suspected_duplicate" ? releaseDuplicateHold(state, ctx, item) : undefined;
    if (released) return result(`Exception resolution recorded. Payment ${released.reference} is released from the duplicate hold and is matched like any other payment.`, item, { paymentStatus: released.status });
    const decided = (type === "suspected_duplicate" && heldEvidenceOf(item.data.condition)?.observationId) || (type === "provider_status_mismatch" && unseenReversalOf(item.data.condition));
    const evidence = decided ? recordsOf(state, "observations").find((record) => record.id === decided && record.status === "unresolved") : undefined;
    if (evidence && type === "provider_status_mismatch") return result(data.resolutionCode === unseenReversalCodes.adopted
      ? `Exception resolution recorded. This reversal evidence keeps waiting for its payment, with no new exception. The reconciliation that records payment ${evidence.reference} reverses it, or holds it for you if that payment names another payer, currency or amount.`
      : "Exception resolution recorded. This reversal evidence is set aside at the next reconciliation: it reverses nothing, even if its payment arrives later.", item);
    const joinedTo = evidence && data.resolutionCode === heldEvidenceCodes.samePayment ? recordsOf(state, "payments").find((record) => record.id === heldEvidenceOf(item.data.condition)?.paymentId) : undefined;
    if (evidence && joinedTo) return result(`${reportsReversal(evidence)
      ? `Exception resolution recorded. The next reconciliation applies this reversal evidence to payment ${joinedTo.reference}, which is reversed.`
      : `Exception resolution recorded. The next reconciliation joins this payment evidence to payment ${joinedTo.reference} as more evidence of it: no second payment is made.`} If payment ${joinedTo.reference} changes before then so that the evidence no longer agrees with it, the evidence is held for you again instead.`, item);
    if (evidence && reportsReversal(evidence)) return result("Exception resolution recorded. This reversal evidence is set aside at the next reconciliation: no payment is made from it only to be reversed, and it reverses nothing, even if its payment is found later.", item);
    if (evidence && data.resolutionCode === heldEvidenceCodes.notMoney) return result("Exception resolution recorded. This payment evidence is set aside at the next reconciliation: no payment is made from it, and it is merged into none.", item);
    if (evidence && type === "suspected_duplicate") return result(`Exception resolution recorded. The next reconciliation records this payment evidence as a payment of its own${data.resolutionCode === "confirmed_duplicate_refund" ? ", held until its refund is recorded" : ""}.`, item);
    return result("Exception resolution recorded.", item);
  }
  if (input.action === "record_refund") {
    assertActionRole(ctx, ["Admin", "Finance"], "record a refund");
    if (!data.reference || /^\d{8,}$/.test(String(data.reference))) throw new Error("Enter a masked sample reference for the refund recorded outside Valo Pay.");
    const payment = findRecord(state, String(input.recordId), "payments");
    // Reversed money already went back. A refund returns what the payment has not applied, such as an overpayment's
    // excess: money applied to an instalment stays applied, and nothing is left to allocate or hold as credit.
    // One refund is recorded per payment, including one that returned only part of it.
    if (paymentReversed(payment) || paymentRefunded(payment)) throw Object.assign(new Error(paymentReversed(payment) ? `Payment ${payment.reference} was reversed by the provider, so its money already went back. There is nothing to refund.` : `A refund is already recorded for payment ${payment.reference}. Reload the page to see it.`), { status: 409 });
    if (paymentUnappliedKobo(payment) <= 0) throw Object.assign(new Error(`Payment ${payment.reference} has all of its money allocated to instalments, so there is nothing unallocated to refund. A refund recorded here returns only money the payment has not allocated.`), { status: 409 });
    payment.data.refundReference = String(data.reference); payment.data.refundRecordedAt = now; payment.data.refundRecordedExternally = true;
    const refundedKobo = recordPaymentRefund(state, ctx, payment, "No longer applied: the payment was refunded outside Valo Pay.");
    return result(`External refund of ${moneyText(refundedKobo, currencyOf(payment))} recorded: the money this payment had not allocated. No money moved.`, payment, { refundedKobo });
  }
  if (input.action === "simulate_failure") {
    assertActionRole(ctx, ["Admin", "Operations"], "record a sample failure");
    const due = findRecord(state, String(input.recordId), "due-items");
    if (!data.failureCode) throw new Error("Choose a failure code.");
    if (!isKnownFailureCode(data.failureCode)) throw new Error(`Choose a failure code from the list: ${listText(failureCodeList.map((code) => valueLabel(code)))}.`);
    if (recordsOf(state, "attempts").some((attempt) => attempt.data.dueItemId === due.id && ["scheduled", "sent", "unknown"].includes(attempt.status))) {
      throw new Error("An earlier attempt for this instalment is still pending or has an unknown outcome. Check its status with the provider before trying again.");
    }
    const code = normaliseFailureCode(data.failureCode);
    const attempt = makeRecord(state, "attempts", {
      name: code === "TIMEOUT_UNKNOWN" ? "Sample collection attempt with unknown outcome" : "Sample failed collection attempt",
      status: code === "TIMEOUT_UNKNOWN" ? "unknown" : "failed", customerId: due.customerId, amountKobo: due.amountKobo, createdAt: now,
      data: { dueItemId: due.id, number: countedAttempts(state, due.id).length + 1, source: "external", simulated: true, failureCode: code, rawFailureCode: String(data.failureCode), occurredAt: now, actualInstruction: false },
    });
    if (due.status === "scheduled") { due.status = "in_collection"; touch(due, now); }
    return result("Sample failure recorded for a policy simulation. No debit was attempted.", attempt);
  }
  if (input.action === "backtest_policy") {
    assertActionRole(ctx, ["Admin", "Operations", "Finance", "Compliance reviewer"], "run a policy simulation");
    const policy = findRecord(state, String(input.recordId), "policies");
    // Any version, a draft under review included, is tried on the instalments its policy governs, as if it applied.
    const lineage = new Set(policyLineage(state, policy).map((item) => item.id));
    const decisions = recordsOf(state, "due-items").filter((due) => lineage.has(String(policyIdFor(state, due)))).map((due) => evaluateRetry(state, ctx, due, policy, { simulation: true }));
    const unapproved = policy.status === "approved" ? "" : `Version ${policyVersionOf(policy)} is not approved: this shows what it would do if it were approved and applied. `;
    return result(`${unapproved}This simulation shows whether the policy would allow a retry and when. It does not predict how much money would be recovered.`, policy, { decisions, recoveryEstimate: null, notARecoveryClaim: true });
  }
  if (input.action === "preregister_experiment") {
    assertActionRole(ctx, ["Admin"], "register an experiment plan");
    const experiment = findRecord(state, String(input.recordId), "experiments");
    if (experiment.status !== "draft") throw new Error("This experiment plan has already been registered and cannot be changed.");
    const policy = recordsOf(state, "policies").find((item) => item.id === experiment.data.policyId && item.status === "approved");
    if (!policy) throw new Error("Choose an approved retry policy before registering the experiment plan.");
    const analysis = Date.parse(experiment.data.analysisDate), close = Date.parse(experiment.data.enrolmentClose);
    if (!Number.isFinite(analysis) || !Number.isFinite(close) || close > analysis - 30 * DAY_MS || close <= Date.parse(now)) throw new Error("Enrolment must close in the future and at least 30 days before analysis.");
    const sample = preregisterSample(Number(experiment.data.baselineRate), Number(experiment.data.holdoutShare));
    experiment.data.sampleCalculation = sample;
    experiment.data.minPerArm = Math.max(Number(experiment.data.minPerArm || 0), sample.holdoutMinimum);
    experiment.data.passRule = passRuleText;
    experiment.status = "preregistered"; experiment.data.preregisteredAt = now; experiment.data.parametersFrozen = true; experiment.data.preregisteredBy = ctx.actor;
    touch(experiment, now);
    return result("Experiment plan registered and locked. Instalments will be assigned to a group at their first eligible future failure, not when the plan is registered.", experiment, { assigned: 0 });
  }
  if (input.action === "hand_back") {
    assertActionRole(ctx, ["Admin", "Operations"], "return collection to its previous owner");
    // DEB-12: ownership reverts to the owner named in the cutover contract; every future instruction is cancelled.
    const contract = recordsOf(state, "cutovers").filter((item) => item.status !== "handed_back").at(-1);
    const fallbackOwner = handBackFallbackOwner(contract?.data.fallbackOwner);
    const reverted = recordsOf(state, "due-items").filter((item) => item.data.owner === PLATFORM_OWNER).map((item) => { item.data.owner = fallbackOwner; item.data.handBackAt = now; touch(item, now); return item.id; });
    const cancelled = cancelScheduledAttempts(state, now, "Collection returned to its previous owner. No future instruction is held.", () => true);
    state.merchant.killSwitch = true;
    settleStopRelease(state);
    const checklist = [`Collection of ${counted(reverted.length, "instalment")} returned to ${ownerPhrases[fallbackOwner]}`, `${counted(cancelled.length, "scheduled collection attempt")} cancelled`, "To do: the lender switches its previous collection schedules back on, checking them against this list", "To do: give the lender a full export of its records", "No future instructions are held for this lender"];
    const cutover = makeRecord(state, "cutovers", { name: "Collection returned", status: "handed_back", createdAt: now, data: { checklist, fallbackOwner, confirmation: reason(input), revertedDueItemIds: reverted, cancelledAttemptIds: cancelled, handedBackAt: now } });
    return result(`Collection returned to ${ownerPhrases[fallbackOwner]}. Scheduled collection attempts were cancelled, and no future instructions are queued.`, cutover, { fallbackOwner, reverted: reverted.length, cancelled: cancelled.length });
  }
  if (input.action === "notify_policy_change") {
    assertActionRole(ctx, ["Admin", "Operations"], "record a policy change notice");
    const mandate = findRecord(state, String(input.recordId), "mandates");
    const target = findRecord(state, String(data.policyId), "policies");
    if (target.status !== "approved" || (mandate.data.policyId && !samePolicyLineage(state, String(mandate.data.policyId), target.id))) throw new Error(SAME_POLICY);
    if (withinQuietHours(Date.parse(now))) throw new Error(QUIET_HOURS);
    const notification = makeRecord(state, "notifications", {
      name: "Policy change notice", status: "simulated", customerId: mandate.customerId, createdAt: now,
      data: { purpose: "policy_change", channel: "sms", class: "required", mandateId: mandate.id, policyId: target.id, policyVersion: Number(target.data.version || 1), submittedAt: now, acceptedAt: null, deliveredAt: null, renderedText: policyChangeText(state, target), simulated: true },
    });
    return result("Policy change notice recorded as a simulation. It is not evidence that the provider accepted it, and no message left Valo Pay.", notification, { notificationId: notification.id, policyId: target.id });
  }
  if (input.action === "apply_policy_version") {
    assertActionRole(ctx, ["Admin", "Operations"], "apply a retry policy version");
    const mandate = findRecord(state, String(input.recordId), "mandates");
    const target = findRecord(state, String(data.policyId), "policies");
    if (target.status !== "approved" || !target.data.reviewer) throw new Error("Only an approved retry policy version can be applied.");
    if (mandate.data.policyId && !samePolicyLineage(state, String(mandate.data.policyId), target.id)) throw new Error("Choose a version of this mandate’s own retry policy. A different policy needs a reissued mandate.");
    if (mandate.data.consentPolicyId === target.id) throw new Error("The customer’s consent already covers this version, so there is nothing to apply.");
    // RET-07: a notice accepted by the provider, and fresh consent where the merchant's terms require it.
    const notice = recordsOf(state, "notifications").find((item) => (data.noticeId ? item.id === data.noticeId : item.data.mandateId === mandate.id && item.data.policyId === target.id) && item.data.purpose === "policy_change" && item.data.acceptedAt && item.data.synthetic !== true);
    if (!notice) throw new Error("Before applying a new version, record evidence that the provider accepted the policy change notice. A simulated notice does not count.");
    const consentRequired = state.settings.policyChangeRequiresConsent === true;
    if (consentRequired && (!data.consentEvidence || typeof data.consentEvidence !== "string")) throw new Error("This lender’s terms require new consent for a policy change. Enter the new consent evidence reference.");
    const history = Array.isArray(mandate.data.policyVersionHistory) ? mandate.data.policyVersionHistory : [];
    history.push({ fromPolicyId: mandate.data.consentPolicyId ?? null, fromVersion: mandate.data.consentPolicyVersion ?? null, toPolicyId: target.id, toVersion: Number(target.data.version || 1), noticeId: notice.id, consentEvidence: consentRequired ? String(data.consentEvidence) : null, appliedAt: now, actor: ctx.actor, reason: reason(input) });
    mandate.data.policyVersionHistory = history;
    mandate.data.policyId = target.id;
    mandate.data.consentPolicyId = target.id;
    mandate.data.consentPolicyVersion = Number(target.data.version || 1);
    mandate.data.consentPolicySummary = policySummary(target);
    if (consentRequired) { mandate.data.consentEvidence = String(data.consentEvidence); mandate.data.consentCapturedAt = now; }
    touch(mandate, now);
    return result(`Retry policy version ${target.data.version ?? 1} now applies to this mandate, after the notice${consentRequired ? " and fresh consent" : ""}. The previous version stays on record.`, mandate, { policyId: target.id, noticeId: notice.id });
  }
  if (input.action === "confirm_discount_terms") {
    // BIL-02: the second person of a design partner's discount dates, which the record write proposes.
    assertActionRole(ctx, ["Admin", "Finance"], "confirm discount dates");
    const checked = discountConfirmationDataSchema.parse(data, { path: ["data"] });
    const terms = findRecord(state, String(input.recordId), "commercial");
    const confirmed = confirmDiscountTerms(terms, ctx, checked);
    const agreed = `50% discount from ${dayText(confirmed.discountStartDate)}, full price from ${dayText(confirmed.fullPriceStartDate)} (agreement ${confirmed.termsReference})`;
    return result(`Discount dates confirmed: ${agreed}, proposed by ${confirmed.reviewedBy}. New invoices are priced from these dates. Issued invoices are unchanged.`, terms, {
      commercialId: terms.id, auditNote: `Confirmed the design-partner discount dates proposed by ${confirmed.reviewedBy} at ${instantText(confirmed.reviewedAt)}: ${agreed}.`,
    });
  }
  if (input.action === "issue_invoice") {
    assertActionRole(ctx, ["Admin", "Finance"], "issue an invoice");
    const invoice = issueInvoice(state, ctx, { period: data.period });
    invoice.data.issueReason = reason(input);
    return result(`Invoice ${invoice.reference} issued for ${monthText(invoice.data.period)}: ${counted(Number(invoice.data.collectionsCounted), "collection")} counted, ${counted(invoice.data.adjustments.length, "adjustment line")}. Issued invoices cannot be changed. Corrections appear on the next invoice.`, invoice, { invoiceId: invoice.id, period: invoice.data.period, totals: invoice.data.totals });
  }
  if (input.action === "mark_pack_used") throw new Error("Sample dispute packs cannot be recorded as used in a real case.");
  throw new Error(UNAVAILABLE_ACTION);
}
