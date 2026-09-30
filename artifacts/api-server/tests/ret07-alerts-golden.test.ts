// Golden tests for RET-07 (the consent pins the policy version; a newer version
// applies only after a notice and, where required, fresh consent) and the
// NFR-OBS-02 alerts feed.
import assert from "node:assert/strict";
import { DAY, addAttempt, addNotice, ctxAt, liveFixture, wat } from "./helpers.js";
import { executeAction, runDailyClose } from "../src/domain/actions.js";
import { evaluateRetry, policySummary, samePolicyLineage } from "../src/domain/policy-engine.js";
import { validateRecord } from "../src/domain/validation.js";
import { buildAlerts } from "../src/domain/alerts.js";
import { counted } from "@workspace/valopay-schema";
import { buildOverview } from "../src/domain/reports.js";
import { findRecord, makeRecord, recordsOf } from "../src/domain/records.js";
import { seedMerchant } from "../src/lib/valopay-seed.js";

let checks = 0;
// The audit_chain_broken detail for entry 4: once the lender has recorded the break, and while only a check has found it.
const keptBreak = "Entry 4 of the audit log is missing, out of order or changed. Ask an Admin to investigate. This alert stays until a full check finds every entry intact: select Check audit log on the Audit log page, or wait for the daily check after the daily close.";
const foundBreak = "Entry 4 of the audit log is missing, out of order or changed. Ask an Admin to investigate. The next change, Check audit log or the daily check after the daily close will record this break. After that, the alert stays until a full check finds every entry intact. Until then, it clears if the log is repaired.";
const admin = (now: string) => ctxAt(now, "Admin");
const reviewer = (now: string) => ctxAt(now, "Compliance reviewer");

// ---------- RET-07: the consent record carries the version and its text; the engine keeps the consented version ----------
{
  const { state, policy, mandate, due } = liveFixture({ merchantId: "ret07" });
  // A mandate created against a policy pins the version and the policy text as it stood (MAN-02).
  const customer = recordsOf(state, "customers")[1]!;
  const input = { name: "new mandate", status: "pending_activation", customerId: customer.id, amountKobo: 5_000_000, data: { workflow: "hosted_consent", consentEvidence: "CONSENT-9", consentGaps: [], policyId: policy.id, origin: "created" } as Record<string, any>, createdAt: wat("2027-06-01T09:00:00"), updatedAt: wat("2027-06-01T09:00:00") };
  validateRecord(state, admin(wat("2027-06-01T09:00:00")), "mandates", input);
  assert.equal(input.data.consentPolicyId, policy.id);
  assert.equal(input.data.consentPolicyVersion, 1);
  assert.equal(input.data.consentPolicySummary, policySummary(policy));
  assert.match(input.data.consentPolicySummary, /Version 1: up to 3 attempts/);
  checks += 4;

  // The seeded fixture mandate predates pinning: pin it as its creation would have.
  mandate.data.consentPolicyId = policy.id; mandate.data.consentPolicyVersion = 1; mandate.data.consentPolicySummary = policySummary(policy);
  // A new version is drafted and approved by a different reviewer.
  const draft = findRecord(state, executeAction(state, admin(wat("2027-06-02T09:00:00")), { action: "new_policy_version", recordId: policy.id, reason: "shorter spacing" }).record!.id, "policies");
  draft.data.spacingHours = 24;
  executeAction(state, admin(wat("2027-06-02T09:10:00")), { action: "submit_policy", recordId: draft.id, reason: "review" });
  executeAction(state, reviewer(wat("2027-06-02T09:20:00")), { action: "approve_policy", recordId: draft.id, reason: "compliant" });
  assert.equal(draft.status, "approved"); assert.equal(draft.data.version, 2);
  assert.equal(samePolicyLineage(state, policy.id, draft.id), true);
  // The engine still evaluates the consented version 1 for this mandate's due items.
  const failed = recordsOf(state, "attempts").find((item) => item.data.dueItemId === due.id)!;
  failed.data.noticeId = addNotice(state, due, wat("2027-06-28T09:00:08")).id;
  const underV1 = evaluateRetry(state, ctxAt(wat("2027-06-28T09:01:00")), due, policy);
  assert.equal(underV1.decision, "would_schedule"); assert.equal(underV1.policyVersion, 1);
  const underV2 = evaluateRetry(state, ctxAt(wat("2027-06-28T09:01:00")), due, draft);
  assert.equal(underV2.decision, "blocked"); assert.equal(underV2.rule, "policy_version_not_consented", "version 2 cannot apply before the notice");
  assert.equal(underV2.inputs.consentPolicyVersion, 1);
  checks += 8;

  // A direct edit cannot move the mandate to the new version, nor rewrite the consented version.
  const moved = { ...mandate, data: { ...mandate.data, policyId: draft.id }, updatedAt: wat("2027-06-03T09:00:00") };
  assert.throws(() => validateRecord(state, admin(wat("2027-06-03T09:00:00")), "mandates", moved, true), /Use Apply policy version/);
  const rewritten = { ...mandate, data: { ...mandate.data, consentPolicyVersion: 2 }, updatedAt: wat("2027-06-03T09:00:00") };
  assert.throws(() => validateRecord(state, admin(wat("2027-06-03T09:00:00")), "mandates", rewritten, true), /Use Apply policy version to update the version covered by consent/);
  checks += 2;

  // Applying the version needs a provider-accepted policy-change notice; a simulated notice is not evidence.
  const apply = (now: string, data: Record<string, unknown>) => executeAction(state, admin(now), { action: "apply_policy_version", recordId: mandate.id, reason: "customer informed", data: { policyId: draft.id, ...data } });
  assert.throws(() => apply(wat("2027-06-04T09:00:00"), {}), /evidence that the provider accepted the policy change notice/);
  const simulated = executeAction(state, ctxAt(wat("2027-06-04T09:00:00"), "Operations"), { action: "notify_policy_change", recordId: mandate.id, reason: "inform", data: { policyId: draft.id } }).record!;
  assert.equal(simulated.data.purpose, "policy_change"); assert.equal(simulated.data.synthetic, true);
  assert.throws(() => apply(wat("2027-06-04T10:00:00"), { noticeId: simulated.id }), /evidence that the provider accepted the policy change notice/, "a simulated notice is not evidence");
  const accepted = makeRecord(state, "notifications", { name: "policy change", status: "accepted", customerId: mandate.customerId, createdAt: wat("2027-06-05T09:00:00"), data: { purpose: "policy_change", channel: "sms", class: "required", mandateId: mandate.id, policyId: draft.id, acceptedAt: wat("2027-06-05T09:00:05"), deliveredAt: wat("2027-06-05T09:00:20") } });
  accepted.data.synthetic = false;
  state.settings.policyChangeRequiresConsent = true;
  assert.throws(() => apply(wat("2027-06-06T09:00:00"), {}), /new consent for a policy change/, "the merchant's terms require fresh consent");
  const applied = apply(wat("2027-06-06T09:00:00"), { consentEvidence: "CONSENT-9-V2" });
  assert.equal(applied.record?.data.policyId, draft.id);
  assert.equal(mandate.data.consentPolicyId, draft.id); assert.equal(mandate.data.consentPolicyVersion, 2);
  assert.equal(mandate.data.consentEvidence, "CONSENT-9-V2");
  assert.match(mandate.data.consentPolicySummary, /Version 2: .*at least 24 hours between attempts/);
  assert.equal(mandate.data.policyVersionHistory!.length, 1);
  assert.deepEqual([mandate.data.policyVersionHistory![0].fromVersion, mandate.data.policyVersionHistory![0].toVersion, mandate.data.policyVersionHistory![0].noticeId], [1, 2, accepted.id], "the history names the notice and versions");
  assert.throws(() => apply(wat("2027-06-07T09:00:00"), { consentEvidence: "again" }), /already covers/);
  // Now version 2 governs the customer's items and version 1 is refused.
  assert.equal(evaluateRetry(state, ctxAt(wat("2027-06-28T09:01:00")), due, draft).decision, "would_schedule");
  assert.equal(evaluateRetry(state, ctxAt(wat("2027-06-28T09:01:00")), due, policy).rule, "policy_version_not_consented");
  // Re-issue pins the fresh consent to the mandate's current version.
  mandate.status = "cancelled";
  const reissued = executeAction(state, admin(wat("2027-06-08T09:00:00")), { action: "mandate_reissue", recordId: mandate.id, reason: "new consent", data: { consentEvidence: "CONSENT-10" } }).record!;
  assert.equal(reissued.data.consentPolicyId, draft.id); assert.equal(reissued.data.consentPolicyVersion, 2);
  checks += 16;
}

// ---------- RET-07 (audit item 13): one number names one set of rules ----------
{
  const { state, policy } = liveFixture({ merchantId: "policy-versions" });
  const act = (action: string, recordId: string, now: string) => executeAction(state, action === "approve_policy" ? reviewer(now) : admin(now), { action, recordId, reason: "Version history test" });
  const draft = (from: string, now: string) => findRecord(state, act("new_policy_version", from, now).record!.id, "policies");
  const first = draft(policy.id, wat("2027-06-02T09:00:00")), second = draft(policy.id, wat("2027-06-02T09:05:00"));
  assert.deepEqual([first.data.version, second.data.version], [2, 3], "two drafts from version 1 are numbered 2 and 3, never both 2");
  assert.deepEqual([first.data.previousVersionId, second.data.previousVersionId], [policy.id, policy.id], "both still follow version 1");
  second.data.spacingHours = 72;
  for (const version of [first, second]) { act("submit_policy", version.id, wat("2027-06-02T10:00:00")); act("approve_policy", version.id, wat("2027-06-02T11:00:00")); }
  assert.deepEqual([first.status, second.status], ["approved", "approved"]);
  assert.equal(draft(first.id, wat("2027-06-03T09:00:00")).data.version, 4, "a draft from version 2 is numbered after the whole history, not after its source");
  checks += 4;

  // A duplicate stored by an earlier build, or a same-named policy (the same policy for consent and notices), cannot be approved under a number already approved.
  const refusedApproval = (record: { id: string }, version: number, message: string) =>
    assert.throws(() => act("approve_policy", record.id, wat("2027-06-04T09:00:00")), (error: any) => error.status === 409 && new RegExp(`^Version ${version} of this retry policy is already approved`).test(error.message), message);
  const duplicate = makeRecord(state, "policies", { name: policy.name, status: "submitted", amountKobo: 0, data: { ...policy.data, version: 2, author: "Sandbox Admin", reviewer: "", previousVersionId: policy.id, approvedAt: undefined } });
  refusedApproval(duplicate, 2, "a second version 2 is refused");
  const namesake = makeRecord(state, "policies", { name: policy.name, status: "submitted", amountKobo: 0, data: { version: 1, maxAttempts: 3, author: "Sandbox Admin" } });
  refusedApproval(namesake, 1, "so is a policy of the same name numbered 1");
  assert.equal(duplicate.status, "submitted", "nothing changed");
  const other = makeRecord(state, "policies", { name: "Short-term loan policy", status: "submitted", amountKobo: 0, data: { version: 1, maxAttempts: 3, author: "Sandbox Admin" } });
  act("approve_policy", other.id, wat("2027-06-04T09:00:00"));
  assert.equal(other.status, "approved", "another policy has its own version 1");
  checks += 4;

  // The record API cannot renumber or relink a version, or set its review times; other draft fields stay editable.
  const editable = draft(policy.id, wat("2027-06-05T09:00:00"));
  const patch = (data: Record<string, unknown>) => () => validateRecord(state, admin(wat("2027-06-05T10:00:00")), "policies", { ...editable, data: { ...editable.data, ...data } }, true);
  assert.throws(patch({ version: 2 }), /Leave the version number as it is\. Valo Pay numbers each new draft version\./, "the version number");
  assert.throws(patch({ previousVersionId: undefined }), /Valo Pay records a policy’s review dates and version links\. You cannot change them here\./, "the link to the previous version");
  assert.throws(patch({ approvedAt: wat("2027-06-05T10:00:00") }), /Valo Pay records a policy’s review dates and version links\./, "an approval time");
  assert.doesNotThrow(patch({ spacingHours: 72 }), "a rule");
  assert.throws(() => validateRecord(state, admin(wat("2027-06-05T10:00:00")), "policies", { name: "Copied policy", status: "draft", amountKobo: 0, data: { version: 1, author: "Sandbox Admin", previousVersionId: policy.id } }),
    /Valo Pay records a policy’s review dates and version links\./, "a new policy cannot claim to follow another");
  checks += 5;
}
{
  // Two drafts from version 1 that an earlier build both numbered 2: only an approved version holds a number, so a stored draft, rejected or submitted duplicate does not stop the first approval, and the second is then refused.
  const { state, policy } = liveFixture({ merchantId: "policy-stored-duplicates" });
  const stored = (status: "draft" | "submitted" | "rejected") => makeRecord(state, "policies", { name: policy.name, status, amountKobo: 0, data: { ...policy.data, version: 2, author: "Sandbox Admin", reviewer: "", previousVersionId: policy.id, approvedAt: undefined } });
  const draft = stored("draft"), rejected = stored("rejected"), first = stored("submitted"), second = stored("submitted");
  const approve = (record: { id: string }) => executeAction(state, reviewer(wat("2027-06-06T09:00:00")), { action: "approve_policy", recordId: record.id, reason: "Stored duplicates test" });
  approve(first);
  assert.equal(first.status, "approved", "a version 2 that is only drafted, rejected or submitted does not hold the number");
  assert.throws(() => approve(second), (error: any) => error.status === 409 && /^Version 2 of this retry policy is already approved/.test(error.message), "once one version 2 is approved, the other is refused");
  assert.deepEqual([draft.status, rejected.status, second.status], ["draft", "rejected", "submitted"], "and nothing else changed");
  checks += 3;
}

// ---------- NFR-OBS-02: alerts derived from state ----------
{
  const { state, due } = liveFixture({ merchantId: "alerts", withFailure: false });
  for (const exception of recordsOf(state, "exceptions")) exception.data.dueBy = "2028-01-01T00:00:00.000Z"; // the seeded deadlines are relative to the wall clock
  const now = wat("2027-07-01T09:00:00");
  const keys = (alerts: ReturnType<typeof buildAlerts>) => alerts.map((item) => item.key);
  const quiet = buildAlerts(state, now, { valid: true, count: 1, headHash: "x", verifiedSequence: 1 });
  assert.deepEqual(keys(quiet), ["close_overdue"], "a lender that has never closed has that one alert");
  assert.equal(quiet[0]!.severity, "medium");
  checks += 2;
  executeAction(state, ctxAt(now, "Finance"), { action: "daily_close" });
  assert.deepEqual(keys(buildAlerts(state, wat("2027-07-01T10:00:00"), { valid: true, count: 1, headHash: "x", verifiedSequence: 1 })), [], "no alerts after a close");
  const later = wat("2027-07-03T09:00:00");
  assert.deepEqual(keys(buildAlerts(state, later)), ["close_missed", "close_overdue"], "after 36 hours the close is overdue, and the 07:00 scheduled close the last close set up has been missed (high before medium)");
  // Position drift, the audit chain, unallocated Payments over the threshold and a dispatched instruction in observation mode.
  due.data.outstandingKobo = 1;
  state.settings.unallocatedAlertThreshold = 0;
  // Seven entries counted, the chain held to entry 3: entry 4 is the first that breaks it, not the entry after the last one counted.
  const alerts = buildAlerts(state, later, { valid: false, count: 7, headHash: "y", verifiedSequence: 3, kept: true });
  assert.deepEqual(keys(alerts), ["audit_chain_broken", "close_missed", "position_drift", "unallocated_over_threshold", "close_overdue"], "severity order: critical, high, medium");
  assert.equal(alerts[2]!.linkedRecordId, due.id);
  assert.equal(alerts[0]!.detail, keptBreak, "the alert names the entry after the last verified one, and what clears a break the lender has recorded");
  assert.equal(alerts[0]!.count, 7);
  // A break only this check has seen (the overview's, before a completed change or a check of the whole log records it) is not kept.
  assert.equal(buildAlerts(state, later, { valid: false, count: 7, headHash: "y", verifiedSequence: 3 }).find((item) => item.key === "audit_chain_broken")!.detail, foundBreak, "and says what records a break it has only found");
  checks += 3;
  state.merchant.mode = "observation";
  addAttempt(state, due, { status: "sent", occurredAt: wat("2027-07-02T06:16:00"), source: "valo" });
  const critical = buildAlerts(state, later);
  assert.equal(critical[0]!.key, "instruction_in_observation_mode"); assert.equal(critical[0]!.severity, "critical");
  // Notification cost per collection and overdue exceptions.
  const fresh = seedMerchant("alerts-cost");
  const month = new Date().toISOString().slice(0, 7);
  makeRecord(fresh, "notifications", { name: "sms", status: "delivered", data: { purpose: "pre_debit", channel: "sms", costKobo: 5_000, submittedAt: `${month}-02T09:00:00.000Z` } });
  const collection = recordsOf(fresh, "payments").find((item) => item.data.channel === "direct_debit")!;
  collection.data.observedAt = `${month}-03T09:00:00.000Z`;
  const costAlert = buildAlerts(fresh, `${month}-10T09:00:00.000Z`).find((item) => item.key === "notification_cost");
  assert.ok(costAlert, "NGN 50 of notification cost on one collection exceeds the NGN 8 ceiling");
  fresh.settings.notificationCostAlertKobo = 10_000;
  assert.equal(buildAlerts(fresh, `${month}-10T09:00:00.000Z`).some((item) => item.key === "notification_cost"), false, "the merchant ceiling applies");
  const overdueAlert = buildAlerts(fresh, new Date(Date.now() + 3 * DAY).toISOString()).find((item) => item.key === "exceptions_overdue");
  assert.ok(overdueAlert, "the seeded exceptions pass their deadline");
  assert.match(overdueAlert.detail, /^\d+ open exceptions? (is|are) overdue/, "the count carries its noun and verb");
  assert.equal(counted(1, "open exception is", "open exceptions are"), "1 open exception is");
  // The overview carries the alerts and the close freezes them.
  const overview = buildOverview(state, later, critical);
  assert.equal(overview.alerts.length, critical.length);
  const closed = executeAction(state, ctxAt(later, "Finance"), { action: "daily_close" }).record!;
  assert.ok(Array.isArray(closed.data.report.alerts) && closed.data.report.alerts.some((item: any) => item.key === "instruction_in_observation_mode"), "the close report freezes the alerts at close time");
  // Every daily close lists a broken audit chain with the lender's audit state, as its write found it, naming the same entry as the overview.
  const chainBroken = (close: { data: Record<string, any> }) => close.data.report.alerts.find((item: any) => item.key === "audit_chain_broken");
  const brokenAtClose = executeAction(state, ctxAt(later, "Finance"), { action: "daily_close" }, { audit: { valid: false, count: 7, headHash: "y", verifiedSequence: 3, kept: true } }).record!;
  assert.deepEqual([chainBroken(brokenAtClose)?.severity, chainBroken(brokenAtClose)?.detail], ["critical", keptBreak], "a person's close freezes the broken chain, naming the entry after the last verified one");
  assert.equal(chainBroken(executeAction(state, ctxAt(later, "Finance"), { action: "daily_close" }, { audit: { valid: true, count: 9, headHash: "z", verifiedSequence: 8 } }).record!), undefined, "and a close on a chain that holds lists none");
  const scheduled = runDailyClose(state, ctxAt(wat("2027-07-04T07:00:00"), "Operations"), "scheduled", undefined, { valid: false, count: 7, headHash: "y", verifiedSequence: 3, kept: true }).record!;
  assert.equal(chainBroken(scheduled)?.detail, keptBreak, "as does a scheduled close");
  checks += 14;
}

// ---------- NFR-OBS-02: message cost per collection is for the WAT month, and counts a direct debit that settled without its webhook ----------
{
  const state = seedMerchant("alerts-wat-month");
  for (const payment of recordsOf(state, "payments")) payment.data.channel = "transfer"; // only the collection below counts
  makeRecord(state, "notifications", { name: "sms", status: "delivered", data: { purpose: "pre_debit", channel: "sms", costKobo: 5_000, submittedAt: wat("2027-07-31T23:50:00") } });
  const collection = makeRecord(state, "payments", { name: "Canonical payment", status: "allocated", customerId: recordsOf(state, "customers")[0]!.id, amountKobo: 2_500_000, reference: "PSK-SETTLED", data: { channel: "direct_debit", collectionStatus: "received", settlementStatus: "settled", observedAt: wat("2027-07-31T20:00:00"), settledAt: wat("2027-07-31T20:00:00"), reversalStatus: "none", refundStatus: "none", allocatedKobo: 2_500_000 } });
  const costAlert = (now: string) => buildAlerts(state, now).some((item) => item.key === "notification_cost");
  assert.equal(costAlert(wat("2027-07-31T23:55:00")), true, "the settled direct debit is July's one collection, so July's NGN 50 of messages is over the ceiling");
  collection.data.collectionStatus = "succeeded";
  assert.equal(costAlert(wat("2027-08-01T00:30:00")), false, "at 00:30 WAT on 1 August the month is August, though it is still July in UTC");
  checks += 2;
}

console.log(`RET-07 and alerts golden tests passed (${checks} checks): consent pins the version, engine refuses an unconsented version, notice and consent gates, version history, one number per approved version, re-issue, and the alerts feed.`);
