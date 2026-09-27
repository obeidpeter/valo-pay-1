import {
  ABSOLUTE_TICKET_FLOOR_KOBO, PLATFORM_OWNER, activationWorkflows, currencyMinorUnit, defaultStatus, describeIssues,
  editableKinds, exceptionCatalogue, exceptionTransitions, executionOwners, experimentRules, isActionOnlyStatus, mandateTransitions, normaliseFailureCode, observationEventKey,
  normaliseOwner, policyGuardrails, recordDataSchemas, recordStatuses, recordTextLimits, resolveExceptionType, roles, isKnownFailureCode, isRealDate, templateTextProblems,
} from "@workspace/valopay-schema";
import { isDeepStrictEqual } from "node:util";
import type { ZodIssue } from "zod";
import { assertNoRealBankDetails, findRecord, masked, recordsOf } from "./records";
import type { Context, DomainState, RecordOf, TypedRecord, ValopayRecord } from "./types";
import { addBusinessDays, watDate } from "./calendar";
import { countedAttempts, minimumTicketKobo, policySummary } from "./policy-engine";
import { exceptionActionFields, exceptionReviewSubjectChanged } from './exception-integrity';

const roleSet = new Set<string>(roles);
const editable = new Set<string>(editableKinds);
const statuses: Record<string, readonly string[]> = recordStatuses;

function requireRole(ctx: Context, allowed: string[]): void {
  if (!roleSet.has(ctx.role)) throw Object.assign(new Error("This demo role is not recognised. Choose one of the available roles."), { status: 403 });
  if (!allowed.includes(ctx.role)) throw Object.assign(new Error(`${ctx.role} is not permitted to make this change.`), { status: 403 });
}

function positiveInteger(value: unknown, label: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1)) {
    throw new Error(`${label} must be a whole number in kobo (100 kobo = ₦1).`);
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
function validateDates(value: unknown, refuse: Refuse, key = ""): void {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    Object.entries(value as Record<string, unknown>).forEach(([childKey, child]) => {
      if (/(At|Date|Deadline)$/.test(childKey) && child !== undefined && child !== null && (typeof child !== "string" || !isRealDate(child))) {
        refuse(childKey, `${childKey} must use YYYY-MM-DD or a UTC timestamp such as 2026-09-18T07:00:00Z, and name a real date.`, { type: "date" });
      }
      validateDates(child, refuse, childKey);
    });
  } else if (Array.isArray(value)) value.forEach((child) => validateDates(child, refuse, key));
}

function parent<K extends string>(state: DomainState, id: unknown, kind: K, label: string): RecordOf<K> {
  if (typeof id !== "string" || !id) throw new Error(`${label} is required.`);
  const item = findRecord(state, id, kind);
  if (item.merchantId !== state.merchant.id) throw new Error(`${label} belongs to another lender workspace. Choose a record from this workspace.`);
  return item;
}

/** Typed data fields per kind from the shared schema; coerced values are written back so what is stored is what was validated. Collecting, each issue is its own problem. */
function parseData(kind: string, data: Record<string, any>, problems?: ValidationProblem[]): void {
  const schema = (recordDataSchemas as Record<string, { safeParse: (value: unknown) => { success: true; data: Record<string, unknown> } | { success: false; error: any } }>)[kind];
  if (!schema) return;
  const result = schema.safeParse(data);
  if (!result.success && !problems) throw new Error(`Invalid ${kind} data: ${describeIssues(result.error)}`);
  if (!result.success) {
    for (const issue of result.error.issues as ZodIssue[]) problems!.push({ ...(issue.path.length ? { field: String(issue.path[0]) } : {}), message: `${issue.path.join(".") || "data"}: ${issue.message}`, rule: { type: "issue", issue } });
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

function assertTransition(kind: string, from: string, to: string): void {
  if (from === to) return;
  if (kind === "cutovers" && to === "handed_back") throw new Error("Use Return collection ownership to hand this back to the configured fallback owner.");
  if (kind === "mandates") {
    const allowed = mandateTransitions[from as keyof typeof mandateTransitions] ?? [];
    if (!allowed.includes(to as never)) throw new Error(`A ${from} mandate cannot move to ${to}.`);
    if (to === "cancelled" || to === "suspended") throw new Error("Cancel or suspend a mandate through its action so the reason is recorded.");
    return;
  }
  if (kind === "exceptions") {
    const allowed = exceptionTransitions[from as keyof typeof exceptionTransitions] ?? [];
    if (!allowed.includes(to as never)) throw new Error(to === "resolved" ? "Use Resolve exception and choose a resolution from the list." : `A ${from} exception cannot move to ${to}.`);
    return;
  }
  if (["policies", "templates", "experiments"].includes(kind)) {
    throw new Error("Use the action for this record to change its status.");
  }
  if (["due-items", "attempts", "observations", "settlement-batches", "payments", "allocations"].includes(kind)) {
    throw new Error(`${kind} status is derived by the platform and cannot be set directly.`);
  }
  if (isActionOnlyStatus(kind, to)) throw new Error("Use the action for this record to set this status.");
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
  const link = <K extends string>(field: string, id: unknown, linked: K, label: string): RecordOf<K> | undefined =>
    attempt(field, () => parent(state, id, linked, label), (error) => typeof id !== "string" || !id ? { type: "required" } : error.status === 404 ? { type: "link", kind: linked, value: id } : undefined);
  // A data field named like an object's own machinery is refused before anything else looks at the
  // object: JSON can carry such a key, and code that copies fields would otherwise inherit from it.
  for (const key of Object.keys(input.data ?? {})) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") throw new Error(`data.${key} is not an allowed field.`);
  }
  // A record is named: an empty name used to be saved as the kind's name ("customers").
  if (typeof input.name === "string" && !input.name.trim()) refuse("name", "name cannot be empty. Enter a name for this record.", { type: "required" });
  // Indexed text is bounded, so an over-long value is refused here, naming its field, and never fails at the index.
  for (const field of ["status", "reference", "customerId"] as const) {
    const value = input[field];
    if (typeof value === "string" && value.length > recordTextLimits[field]) refuse(field, `${field} is at most ${recordTextLimits[field]} characters.`, { type: "length", max: recordTextLimits[field] });
  }
  if (!problems) assertNoRealBankDetails(input);
  else for (const [key, value] of [...Object.entries(input).filter(([key]) => key !== "data"), ...Object.entries(input.data ?? {})]) attempt(key, () => assertNoRealBankDetails(value, key));
  validateDates(input, refuse);
  if (!editable.has(kind)) throw new Error(`${kind} cannot be created or edited directly.`);
  if (!roleSet.has(ctx.role) || ctx.role === "Read-only") throw Object.assign(new Error("This demo role has read-only access."), { status: 403 });
  if (input.merchantId && input.merchantId !== state.merchant.id) throw new Error("Linked records must belong to the same lender workspace.");
  if (input.amountKobo !== undefined) attempt("amountKobo", () => positiveInteger(input.amountKobo, "amountKobo", true), () => ({ type: "amount" }));
  if (input.status && statuses[kind] && !statuses[kind].includes(input.status)) {
    refuse("status", `Invalid ${kind} status. Allowed: ${statuses[kind].join(", ")}.`, { type: "choice", options: statuses[kind], value: input.status });
  }
  const data: Record<string, any> = input.data || (input.data = {});
  const existing = isUpdate && input.id ? findRecord(state, input.id, kind) : undefined;
  for (const field of ['case', 'importIdentity']) {
    if (JSON.stringify(data[field]) !== JSON.stringify(existing?.data[field])) refuse(field, `Use the dedicated workflow to change ${field === 'case' ? 'case coordination' : 'import provenance'}.`);
  }
  for (const field of ['legacyReversalReviewIds', 'legacyReversalReviewAppliedId', 'legacyReversalReviewPause', 'providerIdentityHeld']) {
    if (!isDeepStrictEqual(data[field], existing?.data[field])) throw new Error('Reversal and provider identity review holds are recorded by reconciliation and cannot be changed here.');
  }
  if (kind === "exceptions") {
    requireRole(ctx, ["Admin", "Finance", "Operations"]);
    if (existing && exceptionReviewSubjectChanged(existing, input, state.records.find(record => record.id === existing.data.linkedRecordId))) {
      throw new Error('The subject of a historical evidence review cannot be changed. Keep its customer, amount, type, condition, and linked record unchanged.');
    }
    if (existing && ['resolved', 'closed'].includes(existing.status)) {
      const closingOnly = existing.status === 'resolved' && input.status === 'closed'
        && ['name', 'reference', 'amountKobo', 'customerId', 'data'].every(field => isDeepStrictEqual(input[field as keyof typeof input], existing[field as keyof typeof existing]));
      if (!closingOnly) throw new Error('A completed exception decision cannot be edited. Record a new review through its dedicated workflow.');
    }
    for (const field of exceptionActionFields) if (!isDeepStrictEqual(data[field], existing?.data[field])) {
      throw new Error(`An exception's ${field} is recorded by its dedicated resolution workflow and cannot be changed here.`);
    }
  }
  if (isUpdate && !existing) throw new Error("An update requires the existing record id.");
  if (existing?.status === "approved" && (kind === "policies" || kind === "templates")) {
    throw new Error("Approved versions cannot be edited. Create a new draft version instead.");
  }
  if (existing && input.status && input.status !== existing.status) assertTransition(kind, existing.status, input.status);
  if (!isUpdate && input.status && isActionOnlyStatus(kind, input.status)) {
    refuse("status", `New ${kind} records cannot start ${input.status}; that status is set by a domain action.`, { type: "starting-status", value: input.status });
  }
  if (kind === "due-items" && data.owner !== undefined) data.owner = normaliseOwner(data.owner) ?? data.owner;
  if (kind === "settlement-batches") {
    if (!data.batchReference && input.reference) data.batchReference = input.reference;
    if (!input.reference && data.batchReference) input.reference = String(data.batchReference);
  }
  if (kind === "exceptions" && data.type !== undefined) {
    const type = resolveExceptionType(data.type);
    if (!type && !isUpdate) throw new Error(`Unknown exception type. Use one of: ${Object.keys(exceptionCatalogue).join(", ")}.`);
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
    requireRole(ctx, ["Admin", "Operations", "Finance"]);
    // CSV validation has already compared the row with its own source identity and other references.
    if (!problems && input.reference && state.records.some(record => record.kind === 'customers' && record.id !== existing?.id && record.reference === input.reference)) {
      refuse('reference', 'This customer reference is already used in this lender. Enter a different reference.');
    }
    if (data.accountMasked !== undefined && !masked(data.accountMasked)) refuse("accountMasked", "Mask the account number, for example •••• 1234. Do not enter a full account number.");
    if (data.phoneMasked !== undefined && !masked(data.phoneMasked)) refuse("phoneMasked", "Mask the phone number, for example +234 •••• 32. Do not enter a full phone number.");
  }
  if (kind === "mandates") {
    requireRole(ctx, ["Admin", "Operations"]);
    link("customerId", input.customerId, "customers", "A mandate customer");
    attempt("amountKobo", () => positiveInteger(input.amountKobo, "Mandate limit"), () => ({ type: "amount" }));
    if (!activationWorkflows.includes(data.workflow)) refuse("workflow", "Select a supported activation workflow.", { type: "choice", options: activationWorkflows, value: data.workflow });
    const consentKeys = ["consentPolicyId", "consentPolicyVersion", "consentPolicySummary", "policyVersionHistory"] as const;
    if (data.policyId) {
      const policy = link("policyId", data.policyId, "policies", "mandate policyId");
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
    if (data.origin === "imported" && !data.consentGaps) throw new Error("For an imported mandate, record any missing consent evidence. Use an empty list if nothing is missing.");
    if (existing && ["consentEvidence", "workflow", "origin"].some((key) => JSON.stringify(data[key]) !== JSON.stringify(existing.data[key]))) {
      throw new Error("Existing consent evidence cannot be changed. Reissue the mandate with a new consent record.");
    }
    // MAN-02: the customer consented to this limit; a different limit needs a new consent record.
    if (existing && input.amountKobo !== existing.amountKobo) {
      throw new Error("The debit limit is part of the customer's consent and cannot be changed here. Reissue the mandate with new consent evidence for the new limit.");
    }
    if (existing?.data.policyId && data.policyId !== existing.data.policyId) throw new Error("Use Apply policy version to change the version for this mandate and record the required notice and consent.");
    if (existing && consentKeys.some((key) => existing.data[key] !== undefined && JSON.stringify(data[key]) !== JSON.stringify(existing.data[key]))) {
      throw new Error("Use Apply policy version to update the version covered by consent.");
    }
  }
  if (kind === "due-items") {
    requireRole(ctx, ["Admin", "Operations", "Finance"]);
    link("customerId", input.customerId, "customers", "A due item customer");
    attempt("amountKobo", () => positiveInteger(input.amountKobo, "Due amount"), () => ({ type: "amount" }));
    const amount = Number(input.amountKobo);
    if (amount < ABSOLUTE_TICKET_FLOOR_KOBO) refuse("amountKobo", "The minimum debit is ₦5,000. Amounts below this cannot be approved.");
    const minimum = minimumTicketKobo(state);
    if (amount < minimum) {
      const override = data.overrideReason || data.adminOverrideReason;
      const preserved = existing && existing.amountKobo === input.amountKobo && (existing.data.overrideReason || existing.data.adminOverrideReason) === override;
      if (!override || (!preserved && ctx.role !== "Admin")) refuse("amountKobo", `Debits from ₦5,000 to below the lender minimum of ₦${(minimum / 100).toLocaleString("en-NG")} need an Admin to record an override reason.`);
    }
    if (!isUpdate && input.status !== "scheduled") refuse("status", "New instalments must start as scheduled. Their payment status updates when payments are allocated.");
    if (!normaliseOwner(data.owner)) refuse("owner", "Choose who is responsible for collecting this instalment: Valo Pay, the loan management system, the lender team or the provider.", { type: "choice", options: executionOwners, value: data.owner });
    if (data.mandateId) {
      const mandate = link("mandateId", data.mandateId, "mandates", "dueItem mandateId");
      if (mandate && mandate.customerId !== input.customerId) refuse("mandateId", "Choose a mandate that belongs to the customer on this instalment.");
    }
    if (data.owner === PLATFORM_OWNER && !cutoverInForce(state)) {
      const handedBack = lastHandBackAt(state);
      refuse("owner", handedBack
        ? `Valo Pay cannot take collection ownership again until a new handover agreement, recorded after the hand-back on ${watDate(Date.parse(handedBack))}, and its parallel-run day are complete, with a named responsible user and written confirmation.`
        : "Valo Pay cannot take collection ownership until the handover agreement and parallel-run day are complete, with a named responsible user and written confirmation.");
    }
    if (data.outstandingKobo !== undefined && (!Number.isInteger(data.outstandingKobo) || data.outstandingKobo < 0 || data.outstandingKobo > input.amountKobo!)) {
      refuse("outstandingKobo", "Outstanding balance cannot exceed the due amount.");
    }
  }
  if (kind === "attempts") {
    requireRole(ctx, ["Admin", "Operations"]);
    if (isUpdate) throw new Error("Recorded debit attempts cannot be edited.");
    const due = link("dueItemId", data.dueItemId, "due-items", "attempt dueItemId");
    if (due && due.customerId !== input.customerId) refuse("customerId", "The debit attempt and instalment must belong to the same customer.");
    if (due && input.amountKobo !== due.amountKobo) refuse("amountKobo", "The debit attempt amount must match the instalment amount.");
    if (data.source !== "external" || data.simulated !== true) {
      refuse(undefined, "Only sample records of external debit attempts can be imported. They cannot be edited later, and no debit instruction is available.");
    }
    if (input.status === "failed") {
      if (data.failureCode !== undefined && !isKnownFailureCode(data.failureCode)) data.rawFailureCode = String(data.failureCode);
      data.failureCode = normaliseFailureCode(data.failureCode);
    }
    if (due && (!Number.isInteger(data.number) || data.number < 1)) data.number = countedAttempts(state, due.id).length + 1;
  }
  if (kind === "observations") {
    requireRole(ctx, ["Admin", "Operations", "Finance"]);
    if (!input.reference) refuse("reference", "Enter the original provider reference for this payment evidence.");
    const eventKey = observationEventKey(data);
    if (!problems && eventKey !== undefined && state.records.some(record => record.kind === 'observations' && record.id !== existing?.id && observationEventKey(record.data) === eventKey)) {
      refuse('eventId', 'This provider connection and delivery channel already have this event ID. Review the saved payment evidence.');
    }
    if (input.customerId) link("customerId", input.customerId, "customers", "observation customer");
    if (isUpdate) throw new Error("Saved payment evidence cannot be edited. Add a new record to correct it.");
    // Evidence of money received; an absent amount would be saved as 0.
    if (!Number.isSafeInteger(input.amountKobo) || Number(input.amountKobo) < 1) refuse("amountKobo", "Enter the amount received. Payment evidence must be for more than ₦0.", input.amountKobo === undefined ? { type: "required" } : undefined);
    // A gross is what was collected before fees came off, so it is never less than what was received.
    if (data.grossAmountKobo !== undefined && Number(data.grossAmountKobo) < Number(input.amountKobo)) refuse("grossAmountKobo", "The gross amount cannot be less than the amount received. Enter the amount collected before fees, or leave the gross amount blank.");
    if (data.paymentId !== undefined || data.resolutionKey !== undefined || input.status === "resolved") {
      refuse(undefined, "Valo Pay determines how payment evidence is matched. Do not set its resolution when creating it.");
    }
    // Reconciliation alone links evidence to a settlement batch, or marks where a line is counted: evidence naming a batch
    // by these could make a batch Finance confirmed ambiguous again, or claim another batch's count.
    const linked = ["settlementBatchId", "resolvedTo", "countedInBatchId", "duplicateSettlementLine", "otherCurrencyLine"].filter((field) => data[field] !== undefined);
    if (linked.length) refuse(linked[0], "Valo Pay links payment evidence to its settlement batch and records where a settlement line is counted. Do not set these links when creating it.");
    if (data.dueItemId) {
      const due = link("dueItemId", data.dueItemId, "due-items", "observation dueItemId");
      if (due && due.customerId !== input.customerId) refuse("dueItemId", "The payment evidence and linked instalment must belong to the same customer.");
    }
  }
  if (kind === "policies") {
    requireRole(ctx, ["Admin"]);
    if (!isUpdate && input.status && input.status !== "draft") throw new Error("Policies are created as drafts only.");
    // RET-01: the reviewer approves the rules that were submitted, so they are frozen until a reviewer rejects them.
    if (existing?.status === "submitted") throw new Error("A submitted policy cannot be edited. A reviewer must reject it before its author can make changes.");
    if (data.reviewer !== undefined && data.reviewer !== existing?.data.reviewer) throw new Error("The policy reviewer is recorded during approval and cannot be changed here.");
    for (const key of ["previousVersionId", "approvedAt", "submittedAt", "rejectedAt"]) {
      if (JSON.stringify(data[key]) !== JSON.stringify(existing?.data[key])) throw new Error(`Policy ${key} is recorded by its review or version action and cannot be changed here.`);
    }
    // The API numbers versions: 1 on create, and new_policy_version after the whole history.
    if (existing && JSON.stringify(data.version) !== JSON.stringify(existing.data.version)) throw new Error("Policy version numbers are assigned when a new draft version is created.");
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
    if (data.author !== ctx.actor) throw new Error("The policy author must match the current demo user.");
  }
  if (kind === "templates") {
    requireRole(ctx, ["Admin"]);
    if (!isUpdate && input.status && input.status !== "draft") throw new Error("Templates are created as drafts only.");
    if (existing?.status === "submitted") throw new Error("A submitted template cannot be edited. A reviewer must reject it before its author can make changes.");
    for (const key of ["reviewer", "approvedAt", "submittedAt", "rejectedAt", "rejectionReason", "reviewHistory", "previousVersionId", "templateRootId"]) {
      if (JSON.stringify(data[key]) !== JSON.stringify(existing?.data[key])) throw new Error(`Template ${key} is recorded by its review or version action and cannot be changed here.`);
    }
    if (existing && data.version !== existing.data.version) throw new Error("Template version numbers are assigned when a new draft version is created.");
    if (existing && data.author !== existing.data.author) throw new Error("The template author is assigned when its draft is created and cannot be changed here.");
    if (data.author !== ctx.actor) throw new Error("The template author must match the current demo user.");
    const problems = templateTextProblems(data.text);
    if (problems.length) throw new Error(problems.join(' '));
  }
  if (kind === "experiments") {
    requireRole(ctx, ["Admin"]);
    if (!isUpdate && input.status && input.status !== "draft") throw new Error("Experiments are created as drafts only.");
    const holdout = Number(data.holdoutShare);
    if (!Number.isFinite(holdout) || holdout < experimentRules.minimumHoldoutShare || holdout > experimentRules.maximumHoldoutShare || !Number.isInteger(data.minPerArm) || !data.seed) {
      throw new Error("Set the comparison group to 10–50%, enter a whole-number minimum sample for each group, and provide an assignment seed.");
    }
    parent(state, data.policyId, "policies", "experiment policyId");
  }
  if (kind === "exceptions" && data.linkedRecordId) {
    const linked = state.records.find((item) => item.id === data.linkedRecordId);
    if (!linked || linked.merchantId !== state.merchant.id) throw Object.assign(new Error("Link the exception to a record in this lender workspace."), { status: 404 });
  }
  if (kind === "commercial" && data.designPartner && !data.signedFullPriceTerms) {
    // A discounted design-partner entry is allowed, but it cannot be treated as proof of a real Test 3 sale.
    data.realTest3Qualified = false;
  }
  if (kind === "cutovers") {
    requireRole(ctx, ["Admin"]);
    const handedBack = lastHandBackAt(state);
    if (input.status === "ready" && existing && existing.status !== "ready" && handedBack !== null && existing.createdAt <= handedBack) {
      throw new Error(`This cutover contract ended with the hand-back on ${watDate(Date.parse(handedBack))}. Record a new cutover contract to take collection ownership again.`);
    }
    if (input.status === "ready" && existing?.status !== "ready") {
      const candidate = { ...(existing ?? { id: "", merchantId: "", kind, name: "", reference: "", amountKobo: 0, customerId: "", createdAt: "", updatedAt: "" }), status: "ready", data } as TypedRecord<"cutovers">;
      if (!cutoverComplete(candidate)) throw new Error("The handover is ready only after the previous collection system is disabled in writing, external attempts are imported, the parallel-run day is complete, and a named responsible user has confirmed.");
    }
    if (input.status === "handed_back" && existing?.status !== "handed_back") throw new Error("Use Return collection ownership to hand this back to the configured fallback owner.");
  }
  if (["evidence", "experiments"].includes(kind)) requireRole(ctx, ["Admin"]);
  if (["commercial", "costs", "settlement-batches"].includes(kind)) requireRole(ctx, ["Admin", "Finance"]);
  // SCH-04: the business calendar decides when collections run, so only the roles that run them maintain it.
  if (kind === "calendar") requireRole(ctx, ["Admin", "Operations"]);
  // MEA-05: a fortnightly review is recorded by its reviewer at the service's time; neither is typed in.
  if (kind === "reviews" && !isUpdate) {
    if (data.reviewer !== undefined && data.reviewer !== ctx.actor) throw new Error("The reviewer is the person recording the review. Sign in as the reviewer to record it, and leave the reviewer out.");
    if (data.reviewedAt !== undefined) throw new Error("The review time is recorded by the service when the review is saved. Leave the review date out.");
    data.reviewer = ctx.actor;
    data.reviewedAt = ctx.now;
  }
  if (kind === "settlement-batches") {
    for (const key of ["grossKobo", "feeKobo", "netKobo"]) positiveInteger(data[key], key, true);
    if (data.grossKobo - data.feeKobo !== data.netKobo) throw new Error("The net settlement amount must equal the gross amount minus fees.");
    if (!isUpdate && input.status !== (defaultStatus["settlement-batches"] ?? "pending")) throw new Error("New settlement batches must start as pending. Reconciliation updates their status.");
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
      throw Object.assign(new Error("Another settlement batch already has this reference. A batch is one provider connection's payout: record this one under its own reference, or correct the other batch."), { status: 409 });
    }
    // Decision on currencies: a batch holds one currency, naira unless given, and its amounts are in its smallest unit.
    // One the provider's lines build takes its first line's, which reconciliation records.
    if (data.currency === undefined || data.currency === null || data.currency === "") data.currency = isUpdate ? existing?.data.currency : "NGN";
    if (data.currency === undefined) delete data.currency;
    else {
      const code = typeof data.currency === "string" ? data.currency.trim().toUpperCase() : "";
      if (currencyMinorUnit(code) === undefined) throw new Error("Enter the batch currency as an ISO 4217 code with a minor unit, such as NGN or USD.");
      data.currency = code;
      if (Array.isArray(existing?.data.lineObservationIds) && code !== String(existing!.data.currency || "NGN").toUpperCase()) throw new Error("A settlement batch built from the provider's lines is in its first line's currency, which reconciliation records; it cannot be changed here.");
    }
    // Reconciliation copies these from the provider's lines, the fee schedule and the linked statement credit, and derives the status from them.
    // Compared by value: jsonb returns enteredTotals' keys in its own order.
    for (const key of ["statementObservationId", "statementNetKobo", "statementOtherCurrencies", "lineObservationIds", "linePaymentIds", "otherCurrencyLineIds", "expectedFeeKobo", "feeVarianceKobo", "enteredTotals", "providerIdentityReview", "providerIdentityKey", "providerIdentityRelease", "providerIdentityHistory", "providerIdentityClaimedBy"]) {
      if (!isDeepStrictEqual(data[key], existing?.data[key])) throw new Error(`Settlement batch ${key} is recorded by reconciliation and cannot be changed here.`);
    }
    if (existing?.data.providerIdentityKey !== undefined && (input.reference !== existing.reference || data.batchReference !== existing.data.batchReference)) throw new Error('A settlement batch identity is recorded by reconciliation and its reference cannot be changed here.');
    if (Array.isArray(existing?.data.lineObservationIds) || existing?.data.providerIdentityKey !== undefined) for (const key of ['provider', 'providerConnection']) {
      if (!isDeepStrictEqual(data[key], existing?.data[key])) throw new Error(`A settlement batch built from provider lines cannot change ${key}.`);
    }
  }
}

export function assertActionRole(ctx: Context, allowed: string[]): void {
  requireRole(ctx, allowed);
}
