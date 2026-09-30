import {
  ABSOLUTE_TICKET_FLOOR_KOBO, PLATFORM_OWNER, activationWorkflows, currencyMinorUnit, defaultStatus, importFieldLabel,
  editableKinds, exceptionCatalogue, exceptionTransitions, executionOwners, experimentRules, isActionOnlyStatus, mandateTransitions, normaliseFailureCode, observationEventKey,
  normaliseOwner, policyGuardrails, recordDataSchemas, recordStatuses, recordTextLimits, resolveExceptionType, roles, isKnownFailureCode, isRealDate, templateTextProblems, discountTermsStatus,
  dayText, listText, nairaText, notFoundText, recordTypeLabel, recordTypeTitle, rolesText, valueLabel, valueWords,
} from "@workspace/valopay-schema";
import { isDeepStrictEqual } from "node:util";
import type { ZodIssue } from "zod";
import { assertNoRealBankDetails, findRecord, masked, recordsOf } from "./records";
import type { Context, DomainState, RecordOf, TypedRecord, ValopayRecord } from "./types";
import { addBusinessDays } from "./calendar";
import { countedAttempts, minimumTicketKobo, policySummary } from "./policy-engine";
import { exceptionActionFields, exceptionReviewSubjectChanged } from './exception-integrity';
import { discountDateProblem, reviewedDiscount } from './commercial-terms';

const roleSet = new Set<string>(roles);
const editable = new Set<string>(editableKinds);
const statuses: Record<string, readonly string[]> = recordStatuses;

/** The refusal for a role Valo Pay does not know: a demo role is chosen in Settings, a staff role by an Admin. */
const UNKNOWN_ROLE = "Valo Pay does not recognise your role. Choose a demo role in Settings, or ask an Admin to check your access.";
/**
 * The standard's role refusal: who can, the specific reason when there is one, your role, and in the sandbox where
 * to change it. "Only an Admin or Finance team member can record a refund. Your role is Operations. Change your demo role in Settings."
 */
export function roleRefusal(ctx: Context, allowed: readonly string[], action: string, because?: string): string {
  return `Only ${rolesText(allowed)} can ${action}${because ? `, because ${because}` : ""}. Your role is ${ctx.role}.${ctx.accessMode === "staff" ? "" : " Change your demo role in Settings."}`;
}

function requireRole(ctx: Context, allowed: string[], action = "make this change"): void {
  if (!roleSet.has(ctx.role)) throw Object.assign(new Error(UNKNOWN_ROLE), { status: 403 });
  if (!allowed.includes(ctx.role)) throw Object.assign(new Error(roleRefusal(ctx, allowed, action)), { status: 403 });
}

/** An amount a form sends as whole kobo: the words say what to enter in naira, as the console's money fields take it. */
function positiveInteger(value: unknown, label: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1)) {
    throw new Error(`${label}: Enter an amount ${allowZero ? "of ₦0 or more" : "above ₦0"}, with no more than 2 decimal places.`);
  }
}

/**
 * A rule a record failed, as the import collects them: the field it concerns (a record field or a data key), the
 * refusal in the record API's words, and what failed where the import words it for the operator's column.
 */
export type ValidationProblem = { field?: string; message: string; rule?: ProblemRule };
/** What failed: a missing value, a value outside its choices, a date, a length, an amount, a true or false, a link that names no record, a status only an action sets, or a schema issue. */
export type ProblemRule =
  | { type: "required" } | { type: "choice"; options: readonly string[]; value: unknown } | { type: "date" } | { type: "length"; max: number }
  | { type: "amount" } | { type: "boolean" } | { type: "link"; kind: string; value: string } | { type: "starting-status"; value: string }
  | { type: "issue"; issue: ZodIssue };
type Refuse = (field: string | undefined, message: string, rule?: ProblemRule) => void;
const throwFirst: Refuse = (_field, message) => { throw new Error(message); };

/** Every date-like field (named ...At, ...Date or ...Deadline) is a real calendar date as written: 2026-02-30 is refused, not read as 2 March (isRealDate). */
function validateDates(kind: string, value: unknown, refuse: Refuse, key = ""): void {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    Object.entries(value as Record<string, unknown>).forEach(([childKey, child]) => {
      if (/(At|Date|Deadline)$/.test(childKey) && child !== undefined && child !== null && (typeof child !== "string" || !isRealDate(child))) {
        refuse(childKey, `${importFieldLabel(kind, childKey)}: Enter a real date as YYYY-MM-DD, or a UTC timestamp such as 2026-09-18T07:00:00Z.`, { type: "date" });
      }
      validateDates(kind, child, refuse, childKey);
    });
  } else if (Array.isArray(value)) value.forEach((child) => validateDates(kind, child, refuse, key));
}

/** A linked record of this lender, named in the words of its kind: "Choose an instalment." */
function parent<K extends string>(state: DomainState, id: unknown, kind: K): RecordOf<K> {
  const thing = recordTypeLabel(kind);
  if (typeof id !== "string" || !id) throw new Error(`Choose ${/^[aeiou]/.test(thing) ? "an" : "a"} ${thing}.`);
  const item = findRecord(state, id, kind);
  if (item.merchantId !== state.merchant.id) throw new Error(`This ${thing} belongs to another lender. Choose one of this lender’s ${recordTypeLabel(kind, 2)}.`);
  return item;
}

/** Typed data fields per kind from the shared schema; coerced values are written back so what is stored is what was validated. Collecting, each issue is its own problem. */
function parseData(kind: string, data: Record<string, any>, problems?: ValidationProblem[]): void {
  const schema = (recordDataSchemas as Record<string, { safeParse: (value: unknown) => { success: true; data: Record<string, unknown> } | { success: false; error: any } }>)[kind];
  if (!schema) return;
  const result = schema.safeParse(data);
  // Each issue in the field's own words: "Due by: Enter a real date."
  const worded = (issue: ZodIssue) => `${issue.path.length ? importFieldLabel(kind, String(issue.path[0])) : "Details"}: ${issue.message}`;
  if (!result.success && !problems) throw new Error((result.error.issues as ZodIssue[]).map(worded).join(" "));
  if (!result.success) {
    for (const issue of result.error.issues as ZodIssue[]) problems!.push({ ...(issue.path.length ? { field: String(issue.path[0]) } : {}), message: worded(issue), rule: { type: "issue", issue } });
    return;
  }
  Object.assign(data, result.data);
}

/** The cutover contract (DEB-11) is complete only when steps 1 to 6 are recorded. */
export function cutoverComplete(cutover: TypedRecord<"cutovers">): boolean {
  const data = cutover.data;
  return cutover.status === "ready" && data.incumbentDisabled === true && data.externalAttemptsImported === true && data.dualRunComplete === true && Boolean(data.accountableUser) && Boolean(data.confirmation);
}

/** When collection ownership was last handed back (DEB-12), or null if it never was. */
export function lastHandBackAt(state: DomainState): string | null {
  return recordsOf(state, "cutovers").filter((item) => item.status === "handed_back").map((item) => String(item.data.handedBackAt || item.createdAt)).sort().at(-1) ?? null;
}

/**
 * DEB-11 and DEB-12: Valo Pay may hold collection ownership only under a
 * complete contract.  A hand-back ends every contract recorded before it,
 * because the incumbent schedules were re-enabled, so only one recorded
 * after the last hand-back counts.
 */
export function cutoverInForce(state: DomainState): boolean {
  const handedBack = lastHandBackAt(state);
  return recordsOf(state, "cutovers").some((item) => cutoverComplete(item) && (handedBack === null || item.createdAt > handedBack));
}

/** Collection is returned from Settings, never by editing a collection transfer. */
const RETURN_COLLECTION = "Return collection to its previous owner from Settings. A collection transfer cannot be marked as returned here.";

function assertTransition(kind: string, from: string, to: string): void {
  if (from === to) return;
  if (kind === "cutovers" && to === "handed_back") throw new Error(RETURN_COLLECTION);
  if (kind === "mandates") {
    const allowed = mandateTransitions[from as keyof typeof mandateTransitions] ?? [];
    if (!allowed.includes(to as never)) throw new Error(`This mandate is ${valueWords(from)}, so it cannot be changed to ${valueWords(to)}.`);
    if (to === "cancelled" || to === "suspended") throw new Error("Suspend or cancel the mandate with its own button, so the reason is saved in the audit log.");
    return;
  }
  if (kind === "exceptions") {
    const allowed = exceptionTransitions[from as keyof typeof exceptionTransitions] ?? [];
    if (!allowed.includes(to as never)) throw new Error(to === "resolved" ? "Use Resolve exception and choose a resolution from the list." : `This exception is ${valueWords(from)}, so it cannot be changed to ${valueWords(to)}.`);
    return;
  }
  if (["policies", "templates", "experiments"].includes(kind)) {
    throw new Error("Use this record’s own buttons, such as Submit for review, to change its status.");
  }
  if (["due-items", "attempts", "observations", "settlement-batches", "payments", "allocations"].includes(kind)) {
    throw new Error(`Valo Pay sets the status of ${recordTypeLabel(kind, 2)} itself. You cannot set it here.`);
  }
  if (isActionOnlyStatus(kind, to)) throw new Error("Use this record’s own buttons to set this status.");
}

/**
 * Checks a record before it is created or updated. Record create and edit stop at the first failing rule, which is
 * thrown. The import passes `problems` to collect every failing rule in a row instead: a rule that fails is noted
 * there and the checks go on, skipping only those that need what failed. A refusal of the whole request (a kind that
 * cannot be written, a role) is still thrown.
 */
export function validateRecord(
  state: DomainState,
  ctx: Context,
  kind: string,
  input: Partial<ValopayRecord> & { data?: Record<string, any> },
  isUpdate = false,
  problems?: ValidationProblem[],
): void {
  const refuse: Refuse = problems ? (field, message, rule) => { problems.push({ ...(field ? { field } : {}), message, ...(rule ? { rule } : {}) }); } : throwFirst;
  /** What a role refusal says the reader cannot do here: "add or edit instalments". */
  const editing = `add or edit ${recordTypeLabel(kind, 2)}`;
  /** A check that throws: at once for record create and edit; noted while collecting, when it answers undefined. */
  const attempt = <T>(field: string | undefined, run: () => T, rule?: (error: Error & { status?: unknown }) => ProblemRule | undefined): T | undefined => {
    if (!problems) return run();
    try { return run(); } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error)), found = rule?.(failure);
      problems.push({ ...(field ? { field } : {}), message: failure.message, ...(found ? { rule: found } : {}) });
      return undefined;
    }
  };
  /** A linked record of this lender (parent), or undefined while collecting when there is none. */
  const link = <K extends string>(field: string, id: unknown, linked: K): RecordOf<K> | undefined =>
    attempt(field, () => parent(state, id, linked), (error) => typeof id !== "string" || !id ? { type: "required" } : error.status === 404 ? { type: "link", kind: linked, value: id } : undefined);
  // A data field named like an object's own machinery is refused before anything else looks at the
  // object: JSON can carry such a key, and code that copies fields would otherwise inherit from it.
  for (const key of Object.keys(input.data ?? {})) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") throw new Error("This request has a field Valo Pay does not accept. Reload the page and try again.");
  }
  // A record is named: an empty name used to be saved as the kind's name ("customers").
  if (typeof input.name === "string" && !input.name.trim()) refuse("name", "Enter a name for this record.", { type: "required" });
  // Indexed text is bounded, so an over-long value is refused here, naming its field, and never fails at the index.
  for (const field of ["status", "reference", "customerId"] as const) {
    const value = input[field];
    if (typeof value === "string" && value.length > recordTextLimits[field]) refuse(field, `${importFieldLabel(kind, field)}: Use at most ${recordTextLimits[field]} characters.`, { type: "length", max: recordTextLimits[field] });
  }
  if (!problems) assertNoRealBankDetails(input);
  else for (const [key, value] of [...Object.entries(input).filter(([key]) => key !== "data"), ...Object.entries(input.data ?? {})]) attempt(key, () => assertNoRealBankDetails(value, key));
  validateDates(kind, input, refuse);
  if (!editable.has(kind)) throw new Error(`${recordTypeTitle(kind, 2)} cannot be created or edited here.`);
  if (!roleSet.has(ctx.role)) throw Object.assign(new Error(UNKNOWN_ROLE), { status: 403 });
  if (ctx.role === "Read-only") throw Object.assign(new Error(`Your role is Read-only, so you can view records but not change them.${ctx.accessMode === "staff" ? " Ask an Admin if you need to make changes." : " Change your demo role in Settings."}`), { status: 403 });
  if (input.merchantId && input.merchantId !== state.merchant.id) throw new Error("This record belongs to another lender. Choose one of this lender’s records.");
  if (input.amountKobo !== undefined) attempt("amountKobo", () => positiveInteger(input.amountKobo, importFieldLabel(kind, "amountKobo"), true), () => ({ type: "amount" }));
  if (input.status && statuses[kind] && !statuses[kind].includes(input.status)) {
    refuse("status", `Choose a status from the list: ${listText(statuses[kind].map((status) => valueLabel(status)))}.`, { type: "choice", options: statuses[kind], value: input.status });
  }
  const data: Record<string, any> = input.data || (input.data = {});
  const existing = isUpdate && input.id ? findRecord(state, input.id, kind) : undefined;
  for (const field of ['case', 'importIdentity']) {
    if (JSON.stringify(data[field]) !== JSON.stringify(existing?.data[field])) refuse(field, field === 'case' ? "Use the exception’s case page to change who owns it, its next step or its handover." : "Imported details change only through an import correction. Open the record’s import batch to propose one.");
  }
  for (const field of ['legacyReversalReviewIds', 'legacyReversalReviewAppliedId', 'legacyReversalReviewPause', 'providerIdentityHeld']) {
    if (!isDeepStrictEqual(data[field], existing?.data[field])) throw new Error('Reconciliation sets the review holds on these records. You cannot change them here.');
  }
  if (kind === "exceptions") {
    requireRole(ctx, ["Admin", "Finance", "Operations"], editing);
    if (existing && exceptionReviewSubjectChanged(existing, input, state.records.find(record => record.id === existing.data.linkedRecordId))) {
      throw new Error('The customer, amount, type and linked record of this review cannot be changed. Keep them as they are.');
    }
    if (existing && ['resolved', 'closed'].includes(existing.status)) {
      const closingOnly = existing.status === 'resolved' && input.status === 'closed'
        && ['name', 'reference', 'amountKobo', 'customerId', 'data'].every(field => isDeepStrictEqual(input[field as keyof typeof input], existing[field as keyof typeof existing]));
      if (!closingOnly) throw new Error('This exception is resolved, so it cannot be edited. If the decision was wrong, raise a new exception.');
    }
    for (const field of exceptionActionFields) if (!isDeepStrictEqual(data[field], existing?.data[field])) {
      throw new Error("Use Resolve exception to record how an exception is resolved. You cannot change it here.");
    }
  }
  if (isUpdate && !existing) throw new Error(notFoundText(recordTypeLabel(kind)));
  if (existing?.status === "approved" && (kind === "policies" || kind === "templates")) {
    throw new Error("This version is approved, so it cannot be edited. Create a new draft version instead.");
  }
  if (existing && input.status && input.status !== existing.status) assertTransition(kind, existing.status, input.status);
  if (!isUpdate && input.status && isActionOnlyStatus(kind, input.status)) {
    refuse("status", `A new ${recordTypeLabel(kind)} cannot start as ${valueWords(input.status)}. Valo Pay sets that status later.`, { type: "starting-status", value: input.status });
  }
  if (kind === "due-items" && data.owner !== undefined) data.owner = normaliseOwner(data.owner) ?? data.owner;
  if (kind === "settlement-batches") {
    if (!data.batchReference && input.reference) data.batchReference = input.reference;
    if (!input.reference && data.batchReference) input.reference = String(data.batchReference);
  }
  if (kind === "exceptions" && data.type !== undefined) {
    const type = resolveExceptionType(data.type);
    if (!type && !isUpdate) throw new Error("Choose an exception type from the list.");
    if (type) {
      data.type = type;
      if (!isUpdate) {
        data.owner ||= exceptionCatalogue[type].owner;
        data.severity ||= exceptionCatalogue[type].severity;
        data.dueBy ||= addBusinessDays(state, ctx.now, exceptionCatalogue[type].slaBusinessDays);
      }
    }
  }
  parseData(kind, data, problems);

  if (kind === "customers") {
    requireRole(ctx, ["Admin", "Operations", "Finance"], editing);
    // CSV validation has already compared the row with its own source identity and other references.
    if (!problems && input.reference && state.records.some(record => record.kind === 'customers' && record.id !== existing?.id && record.reference === input.reference)) {
      refuse('reference', 'This customer reference is already used for this lender. Enter a different reference.');
    }
    if (data.accountMasked !== undefined && !masked(data.accountMasked)) refuse("accountMasked", "Mask the account number, for example •••• 1234. Do not enter a full account number.");
    if (data.phoneMasked !== undefined && !masked(data.phoneMasked)) refuse("phoneMasked", "Mask the phone number, for example +234 •••• 32. Do not enter a full phone number.");
  }
  if (kind === "mandates") {
    requireRole(ctx, ["Admin", "Operations"], editing);
    link("customerId", input.customerId, "customers");
    attempt("amountKobo", () => positiveInteger(input.amountKobo, "Mandate limit"), () => ({ type: "amount" }));
    if (!activationWorkflows.includes(data.workflow)) refuse("workflow", `Choose how the mandate is activated: ${listText(activationWorkflows.map((workflow) => valueLabel(workflow)))}.`, { type: "choice", options: activationWorkflows, value: data.workflow });
    const consentKeys = ["consentPolicyId", "consentPolicyVersion", "consentPolicySummary", "policyVersionHistory"] as const;
    if (data.policyId) {
      const policy = link("policyId", data.policyId, "policies");
      // RET-07 and MAN-02: the consent record carries the policy version and its text as it stood.  A mandate that
      // predates pinning is pinned to the version it has been running under on its next write; callers never set these.
      if (policy && !existing?.data.consentPolicyId) {
        data.consentPolicyId = policy.id;
        data.consentPolicyVersion = Number(policy.data.version || 1);
        data.consentPolicySummary = policySummary(policy);
      }
    } else if (!existing) {
      for (const key of consentKeys) delete data[key];
    }
    if (!existing?.data.policyVersionHistory && !existing?.data.consentPolicyId) delete data.policyVersionHistory;
    if (data.origin === "imported" && !data.consentGaps) throw new Error("For an imported mandate, list any missing consent evidence, or record that nothing is missing.");
    if (existing && ["consentEvidence", "workflow", "origin"].some((key) => JSON.stringify(data[key]) !== JSON.stringify(existing.data[key]))) {
      throw new Error("Existing consent evidence cannot be changed. Reissue the mandate with a new consent record.");
    }
    // MAN-02: the customer consented to this limit; a different limit needs a new consent record.
    if (existing && input.amountKobo !== existing.amountKobo) {
      throw new Error("The debit limit is part of the customer’s consent and cannot be changed here. Reissue the mandate with new consent evidence for the new limit.");
    }
    if (existing?.data.policyId && data.policyId !== existing.data.policyId) throw new Error("Use Apply policy version to change the version for this mandate and record the required notice and consent.");
    if (existing && consentKeys.some((key) => existing.data[key] !== undefined && JSON.stringify(data[key]) !== JSON.stringify(existing.data[key]))) {
      throw new Error("Use Apply policy version to update the version covered by consent.");
    }
  }
  if (kind === "due-items") {
    requireRole(ctx, ["Admin", "Operations", "Finance"], editing);
    link("customerId", input.customerId, "customers");
    attempt("amountKobo", () => positiveInteger(input.amountKobo, "Amount"), () => ({ type: "amount" }));
    const amount = Number(input.amountKobo);
    if (amount < ABSOLUTE_TICKET_FLOOR_KOBO) refuse("amountKobo", `The minimum debit is ${nairaText(ABSOLUTE_TICKET_FLOOR_KOBO)}. Amounts below this cannot be approved.`);
    const minimum = minimumTicketKobo(state);
    if (amount < minimum) {
      const override = data.overrideReason || data.adminOverrideReason;
      const preserved = existing && existing.amountKobo === input.amountKobo && (existing.data.overrideReason || existing.data.adminOverrideReason) === override;
      if (!override || (!preserved && ctx.role !== "Admin")) refuse("amountKobo", `This amount is below the lender’s minimum of ${nairaText(minimum)}. An Admin must record a reason to allow it.`);
    }
    if (!isUpdate && input.status !== "scheduled") refuse("status", "A new instalment must start as Scheduled. Its status changes as payments are allocated to it.");
    if (!normaliseOwner(data.owner)) refuse("owner", "Choose who is responsible for collecting this instalment: Valo Pay, the loan management system, the lender team or the provider.", { type: "choice", options: executionOwners, value: data.owner });
    if (data.mandateId) {
      const mandate = link("mandateId", data.mandateId, "mandates");
      if (mandate && mandate.customerId !== input.customerId) refuse("mandateId", "Choose a mandate that belongs to the customer on this instalment.");
    }
    if (data.owner === PLATFORM_OWNER && !cutoverInForce(state)) {
      const handedBack = lastHandBackAt(state);
      refuse("owner", handedBack
        ? `Valo Pay cannot collect these instalments again yet. Record a new collection transfer agreement after collection was returned on ${dayText(handedBack)}, complete its parallel-run day, and have a named person confirm it in writing.`
        : "Valo Pay cannot collect these instalments until a collection transfer agreement and its parallel-run day are complete, and a named person has confirmed it in writing.");
    }
    if (data.outstandingKobo !== undefined && (!Number.isInteger(data.outstandingKobo) || data.outstandingKobo < 0 || data.outstandingKobo > input.amountKobo!)) {
      refuse("outstandingKobo", "Enter an outstanding amount between ₦0 and the instalment’s amount.");
    }
  }
  if (kind === "attempts") {
    requireRole(ctx, ["Admin", "Operations"], editing);
    if (isUpdate) throw new Error("Saved collection attempts cannot be edited.");
    const due = link("dueItemId", data.dueItemId, "due-items");
    if (due && due.customerId !== input.customerId) refuse("customerId", "The collection attempt and its instalment must belong to the same customer.");
    if (due && input.amountKobo !== due.amountKobo) refuse("amountKobo", "The collection attempt’s amount must match the instalment’s amount.");
    if (data.source !== "external" || data.simulated !== true) {
      refuse(undefined, "Only sample records of collection attempts made by another system can be imported. They cannot be edited later, and Valo Pay sends no debit instruction.");
    }
    if (input.status === "failed") {
      if (data.failureCode !== undefined && !isKnownFailureCode(data.failureCode)) data.rawFailureCode = String(data.failureCode);
      data.failureCode = normaliseFailureCode(data.failureCode);
    }
    if (due && (!Number.isInteger(data.number) || data.number < 1)) data.number = countedAttempts(state, due.id).length + 1;
  }
  if (kind === "observations") {
    requireRole(ctx, ["Admin", "Operations", "Finance"], editing);
    if (!input.reference) refuse("reference", "Enter the original provider reference for this payment evidence.");
    const eventKey = observationEventKey(data);
    if (!problems && eventKey !== undefined && state.records.some(record => record.kind === 'observations' && record.id !== existing?.id && observationEventKey(record.data) === eventKey)) {
      refuse('eventId', 'This provider connection and delivery channel already have this event ID. Review the saved payment evidence.');
    }
    if (input.customerId) link("customerId", input.customerId, "customers");
    if (isUpdate) throw new Error("Saved payment evidence cannot be edited. Add a new record to correct it.");
    // Evidence of money received; an absent amount would be saved as 0.
    if (!Number.isSafeInteger(input.amountKobo) || Number(input.amountKobo) < 1) refuse("amountKobo", "Enter the amount received. Payment evidence must be for more than ₦0.", input.amountKobo === undefined ? { type: "required" } : undefined);
    // A gross is what was collected before fees came off, so it is never less than what was received.
    if (data.grossAmountKobo !== undefined && Number(data.grossAmountKobo) < Number(input.amountKobo)) refuse("grossAmountKobo", "The amount before fees cannot be less than the amount received. Enter the amount collected before fees, or leave it blank.");
    if (data.paymentId !== undefined || data.resolutionKey !== undefined || input.status === "resolved") {
      refuse(undefined, "Leave the matching details blank. Valo Pay matches payment evidence itself.");
    }
    // Reconciliation alone links evidence to a settlement batch, or marks where a line is counted: evidence naming a batch
    // by these could make a batch Finance confirmed ambiguous again, or claim another batch's count.
    const linked = ["settlementBatchId", "resolvedTo", "countedInBatchId", "duplicateSettlementLine", "otherCurrencyLine"].filter((field) => data[field] !== undefined);
    if (linked.length) refuse(linked[0], "Leave the settlement batch details blank. Reconciliation links payment evidence to its batch.");
    if (data.dueItemId) {
      const due = link("dueItemId", data.dueItemId, "due-items");
      if (due && due.customerId !== input.customerId) refuse("dueItemId", "The payment evidence and linked instalment must belong to the same customer.");
    }
  }
  if (kind === "policies") {
    requireRole(ctx, ["Admin"], editing);
    if (!isUpdate && input.status && input.status !== "draft") throw new Error("A new retry policy starts as a draft. Leave the status blank or choose Draft.");
    // RET-01: the reviewer approves the rules that were submitted, so they are frozen until a reviewer rejects them.
    if (existing?.status === "submitted") throw new Error("This retry policy has been submitted for review, so it cannot be edited. A reviewer must reject it before its author can change it.");
    if (data.reviewer !== undefined && data.reviewer !== existing?.data.reviewer) throw new Error("Valo Pay records the reviewer when the policy is approved. Leave the reviewer as it is.");
    for (const key of ["previousVersionId", "approvedAt", "submittedAt", "rejectedAt"]) {
      if (JSON.stringify(data[key]) !== JSON.stringify(existing?.data[key])) throw new Error("Valo Pay records a policy’s review dates and version links. You cannot change them here.");
    }
    // The API numbers versions: 1 on create, and new_policy_version after the whole history.
    if (existing && JSON.stringify(data.version) !== JSON.stringify(existing.data.version)) throw new Error("Leave the version number as it is. Valo Pay numbers each new draft version.");
    const maxAttempts = data.maxAttempts ?? policyGuardrails.defaultMaxAttempts;
    const spacing = data.spacingHours ?? policyGuardrails.defaultSpacingHours;
    const firstNotice = data.firstNoticeHours ?? policyGuardrails.defaultFirstNoticeHours;
    const retryNotice = data.retryNoticeHours ?? policyGuardrails.defaultRetryNoticeHours;
    [maxAttempts, spacing, firstNotice, retryNotice].forEach((value) => {
      if (!Number.isFinite(value) || !Number.isInteger(value)) throw new Error("Enter whole numbers for the policy limits and timings.");
    });
    if (maxAttempts > policyGuardrails.maxAttemptsCeiling || maxAttempts < 1 || spacing < policyGuardrails.minSpacingHours || firstNotice < policyGuardrails.minFirstNoticeHours || retryNotice < policyGuardrails.minRetryNoticeHours || data.partialAllowed === true) {
      throw new Error(`Use no more than ${policyGuardrails.maxAttemptsCeiling} attempts, at least ${policyGuardrails.minSpacingHours} hours between attempts and for each notice period, and no partial debits. These limits cannot be overridden.`);
    }
    if (data.author !== ctx.actor) throw new Error("You can save a retry policy only as yourself. Leave the author as it is.");
  }
  if (kind === "templates") {
    requireRole(ctx, ["Admin"], editing);
    if (!isUpdate && input.status && input.status !== "draft") throw new Error("A new message template starts as a draft. Leave the status blank or choose Draft.");
    if (existing?.status === "submitted") throw new Error("This message template has been submitted for review, so it cannot be edited. A reviewer must reject it before its author can change it.");
    for (const key of ["reviewer", "approvedAt", "submittedAt", "rejectedAt", "rejectionReason", "reviewHistory", "previousVersionId", "templateRootId"]) {
      if (JSON.stringify(data[key]) !== JSON.stringify(existing?.data[key])) throw new Error("Valo Pay records a template’s reviews, review dates and version links. You cannot change them here.");
    }
    if (existing && data.version !== existing.data.version) throw new Error("Leave the version number as it is. Valo Pay numbers each new draft version.");
    if (existing && data.author !== existing.data.author) throw new Error("Valo Pay records a template’s author when its draft is created. Leave the author as it is.");
    if (data.author !== ctx.actor) throw new Error("You can save a message template only as yourself. Leave the author as it is.");
    const problems = templateTextProblems(data.text);
    if (problems.length) throw new Error(problems.join(' '));
  }
  if (kind === "experiments") {
    requireRole(ctx, ["Admin"], editing);
    if (!isUpdate && input.status && input.status !== "draft") throw new Error("A new experiment plan starts as a draft. Leave the status blank or choose Draft.");
    const holdout = Number(data.holdoutShare);
    if (!Number.isFinite(holdout) || holdout < experimentRules.minimumHoldoutShare || holdout > experimentRules.maximumHoldoutShare || !Number.isInteger(data.minPerArm) || !data.seed) {
      throw new Error("Set the comparison group to between 10% and 50%, enter a whole-number minimum size for each group, and enter a seed (any text) for assigning instalments to groups.");
    }
    parent(state, data.policyId, "policies");
  }
  if (kind === "exceptions" && data.linkedRecordId) {
    const linked = state.records.find((item) => item.id === data.linkedRecordId);
    if (!linked || linked.merchantId !== state.merchant.id) throw Object.assign(new Error(notFoundText("linked record")), { status: 404 });
  }
  if (kind === "commercial" && data.designPartner && !data.signedFullPriceTerms) {
    // A discounted design-partner entry is allowed, but it cannot be treated as proof of a real Test 3 sale.
    data.realTest3Qualified = false;
  }
  if (kind === "cutovers") {
    requireRole(ctx, ["Admin"], editing);
    const handedBack = lastHandBackAt(state);
    if (input.status === "ready" && existing && existing.status !== "ready" && handedBack !== null && existing.createdAt <= handedBack) {
      throw new Error(`This collection transfer agreement ended when collection was returned on ${dayText(handedBack)}. Record a new agreement before Valo Pay collects again.`);
    }
    if (input.status === "ready" && existing?.status !== "ready") {
      const candidate = { ...(existing ?? { id: "", merchantId: "", kind, name: "", reference: "", amountKobo: 0, customerId: "", createdAt: "", updatedAt: "" }), status: "ready", data } as TypedRecord<"cutovers">;
      if (!cutoverComplete(candidate)) throw new Error("Before marking the collection transfer ready, switch off the previous collection system in writing, import its collection attempts, complete the parallel-run day and get a named person’s confirmation.");
    }
    if (input.status === "handed_back" && existing?.status !== "handed_back") throw new Error(RETURN_COLLECTION);
  }
  if (["evidence", "experiments"].includes(kind)) requireRole(ctx, ["Admin"], editing);
  if (["commercial", "costs", "settlement-batches"].includes(kind)) requireRole(ctx, ["Admin", "Finance"], editing);
  if (kind === 'commercial') {
    if (!isDeepStrictEqual(data.discountReview, existing?.data.discountReview)) throw new Error('Valo Pay records who proposed and who confirmed the discount dates. Leave those details out.');
    const problem = discountDateProblem(data);
    if (problem) throw new Error(problem);
    const proposal = reviewedDiscount(data, ctx);
    const pricingKeys = ['signed', 'signedFullPriceTerms', 'designPartner', 'discountStartDate', 'fullPriceStartDate', 'discountTermsReference'];
    // An edit that leaves the flags, dates and reference alone keeps their proposal and any confirmation; any other
    // change, or a save of dates with no current proposal, proposes them afresh for a different person to confirm.
    const kept = ['awaiting_confirmation', 'confirmed'].includes(discountTermsStatus(data).state) && pricingKeys.every(key => isDeepStrictEqual(data[key], existing?.data[key]));
    if (proposal && !kept) data.discountReview = proposal;
    else if (!proposal) delete data.discountReview;
  }
  // SCH-04: the business calendar decides when collections run, so only the roles that run them maintain it.
  if (kind === "calendar") requireRole(ctx, ["Admin", "Operations"], editing);
  // MEA-05: a fortnightly review is recorded by its reviewer at the service's time; neither is typed in.
  if (kind === "reviews" && !isUpdate) {
    if (data.reviewer !== undefined && data.reviewer !== ctx.actor) throw new Error("Valo Pay records you as the reviewer. Leave the reviewer blank.");
    if (data.reviewedAt !== undefined) throw new Error("Valo Pay records the review time when you save. Leave the review date blank.");
    data.reviewer = ctx.actor;
    data.reviewedAt = ctx.now;
  }
  if (kind === "settlement-batches") {
    for (const key of ["grossKobo", "feeKobo", "netKobo"] as const) positiveInteger(data[key], { grossKobo: "Amount before fees", feeKobo: "Fee", netKobo: "Amount after fees" }[key], true);
    if (data.grossKobo - data.feeKobo !== data.netKobo) throw new Error("The amount after fees must equal the amount before fees minus the fee.");
    if (!isUpdate && input.status !== (defaultStatus["settlement-batches"] ?? "pending")) throw new Error("A new settlement batch must start as Pending. Reconciliation updates its status.");
    // FIN-03: a batch Finance adds or corrects by hand takes no reference another batch has, whether the reference or only the
    // batch reference is given, so two batches never become one payout; reconciliation alone keeps one batch per connection
    // under a reference. An edit that keeps the batch's references is not checked. A copy an earlier build let an API
    // client create with only its batch reference carries the other batch's reference in both fields, and the console's
    // Edit changes the reference only: correcting such a duplicate carries its batch reference over, as the repair a
    // refused confirmation asks for. Every other edit keeps its batch reference, the key the provider's lines match by.
    const others = state.records.filter((record) => record.kind === "settlement-batches" && record.id !== existing?.id);
    if (existing && typeof input.reference === "string" && input.reference && input.reference !== existing.reference && data.batchReference === existing.data.batchReference
      && existing.data.batchReference === existing.reference && others.some((record) => record.reference === existing.reference || record.data.batchReference === existing.reference)) data.batchReference = input.reference;
    const references = [input.reference, data.batchReference].filter((value): value is string => typeof value === "string" && !!value);
    if ((!existing || input.reference !== existing.reference || data.batchReference !== existing.data.batchReference)
      && others.some((record) => references.includes(record.reference) || references.includes(String(record.data.batchReference ?? "")))) {
      throw Object.assign(new Error("Another settlement batch already has this reference. Each batch is one provider connection’s payout. Record this one under its own reference, or correct the other batch."), { status: 409 });
    }
    // Decision on currencies: a batch holds one currency, naira unless given, and its amounts are in its smallest unit.
    // One the provider's lines build takes its first line's, which reconciliation records.
    if (data.currency === undefined || data.currency === null || data.currency === "") data.currency = isUpdate ? existing?.data.currency : "NGN";
    if (data.currency === undefined) delete data.currency;
    else {
      const code = typeof data.currency === "string" ? data.currency.trim().toUpperCase() : "";
      if (currencyMinorUnit(code) === undefined) throw new Error("Enter the batch currency as a three-letter code, such as NGN or USD.");
      data.currency = code;
      if (Array.isArray(existing?.data.lineObservationIds) && code !== String(existing!.data.currency || "NGN").toUpperCase()) throw new Error("This batch was built from the provider’s lines, so it is in its first line’s currency. You cannot change the currency here.");
    }
    // Reconciliation copies these from the provider's lines, the fee schedule and the linked statement credit, and derives the status from them.
    // Compared by value: jsonb returns enteredTotals' keys in its own order.
    for (const key of ["statementObservationId", "statementNetKobo", "statementOtherCurrencies", "lineObservationIds", "linePaymentIds", "otherCurrencyLineIds", "expectedFeeKobo", "feeVarianceKobo", "enteredTotals", "providerIdentityReview", "providerIdentityKey", "providerIdentityRelease", "providerIdentityHistory", "providerIdentityClaimedBy"]) {
      if (!isDeepStrictEqual(data[key], existing?.data[key])) throw new Error("Reconciliation sets this detail of the settlement batch. You cannot change it here.");
    }
    if (existing?.data.providerIdentityKey !== undefined && (input.reference !== existing.reference || data.batchReference !== existing.data.batchReference)) throw new Error('Reconciliation recorded this batch’s provider identity, so its reference cannot be changed here.');
    if (Array.isArray(existing?.data.lineObservationIds) || existing?.data.providerIdentityKey !== undefined) for (const key of ['provider', 'providerConnection']) {
      if (!isDeepStrictEqual(data[key], existing?.data[key])) throw new Error("This batch was built from the provider’s lines, so its provider and connection cannot be changed.");
    }
  }
}

/** The role check of a domain action, refused in the standard's words: "Only {roles} can {action}." */
export function assertActionRole(ctx: Context, allowed: string[], action = "do this"): void {
  requireRole(ctx, allowed, action);
}

