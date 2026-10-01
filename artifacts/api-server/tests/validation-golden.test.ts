// Golden tests for the shared per-kind schema as enforced by the validator and actions.
import assert from "node:assert/strict";
import { addObservation, completeCutover, ctxAt, liveFixture, wat } from "./helpers.js";
import { validateRecord } from "../src/domain/validation.js";
import { executeAction } from "../src/domain/actions.js";
import { assertNoRealBankDetails, makeRecord, recordsOf } from "../src/domain/records.js";
import { reconcile } from "../src/domain/reconciliation.js";
import { seedMerchant } from "../src/lib/valopay-seed.js";
import { exceptionCatalogue, listText, recordStatuses, templateTextProblems, valueLabel } from "@workspace/valopay-schema";
import { importCsv } from "../src/lib/valopay-import.js";

let checks = 0;
const admin = ctxAt(wat("2027-07-01T09:00:00"), "Admin");
const ops = ctxAt(wat("2027-07-01T09:00:00"), "Operations");
const patch = (record: any, changes: any) => ({ ...record, ...changes, data: { ...record.data, ...(changes.data || {}) } });

// ---------- Mandate state machine (4.2): terminal states stay terminal; reasons come through actions ----------
{
  const state = seedMerchant("machine");
  const mandate = recordsOf(state, "mandates").find((item) => item.status === "suspended")!;
  mandate.status = "cancelled";
  assert.throws(() => validateRecord(state, ops, "mandates", patch(mandate, { status: "active" }), true), /This mandate is cancelled, so it cannot be changed to active\./);
  const pending = recordsOf(state, "mandates").find((item) => item.status === "pending_activation")!;
  assert.doesNotThrow(() => validateRecord(state, ops, "mandates", patch(pending, { status: "active" }), true), "activation confirmed by the provider");
  assert.doesNotThrow(() => validateRecord(state, ops, "mandates", patch(pending, { status: "expired" }), true));
  const active = recordsOf(state, "mandates").find((item) => item.status === "active")!;
  assert.throws(() => validateRecord(state, ops, "mandates", patch(active, { status: "cancelled" }), true), /Suspend or cancel the mandate with its own button, so the reason is saved in the audit log\./);
  assert.throws(() => validateRecord(state, ops, "mandates", patch(active, { status: "pending_activation" }), true), /^Error: This mandate is active, so it cannot be changed to awaiting activation\.$/);
  checks += 5;
}

// ---------- Exception machine (EXC-03): resolution needs a controlled code for the type ----------
{
  const state = seedMerchant("exceptions");
  const exception = recordsOf(state, "exceptions").find((item) => item.data.type === "activation_expired")!;
  assert.throws(() => validateRecord(state, ops, "exceptions", patch(exception, { status: "closed" }), true), /so it cannot be changed to closed\./);
  assert.throws(() => validateRecord(state, ops, "exceptions", patch(exception, { status: "resolved" }), true), /Use Resolve exception and choose a resolution/);
  assert.doesNotThrow(() => validateRecord(state, ops, "exceptions", patch(exception, { status: "assigned", data: { owner: "Ada" } }), true));
  assert.throws(() => executeAction(state, ops, { action: "resolve_exception", recordId: exception.id, reason: "done", data: { resolutionCode: "allocated" } }), /Choose one of these: ‘Reissued’, ‘Customer declined’, ‘Wrong number’ or ‘Abandoned’/);
  executeAction(state, ops, { action: "resolve_exception", recordId: exception.id, reason: "done", data: { resolutionCode: "reissued" } });
  assert.equal(exception.status, "resolved");
  assert.doesNotThrow(() => validateRecord(state, ops, "exceptions", patch(exception, { status: "closed" }), true), "closing follows resolution");
  assert.throws(() => executeAction(state, ops, { action: "resolve_exception", recordId: exception.id, reason: "again", data: { resolutionCode: "reissued" } }), /already resolved/);
  // A legacy type alias resolves to the catalogue and creation fills owner, severity and SLA from Appendix A.
  const created: any = { name: "dup", status: "open", customerId: "", amountKobo: 0, data: { type: "possible_duplicate", linkedRecordId: recordsOf(state, "payments")[0]!.id } };
  validateRecord(state, ops, "exceptions", created);
  assert.equal(created.data.type, "suspected_duplicate");
  assert.equal(created.data.owner, exceptionCatalogue.suspected_duplicate.owner);
  assert.equal(created.data.severity, "high");
  assert.ok(created.data.dueBy > admin.now);
  assert.throws(() => validateRecord(state, ops, "exceptions", { name: "x", status: "open", data: { type: "something_else" } }), /Choose an exception type from the list\./);
  assert.throws(() => validateRecord(state, ops, "exceptions", { name: "x", status: "open", data: {} }), /Type: Choose one from the list\./);
  checks += 13;
}

// ---------- Cutover contract (DEB-11, 10.4): no owner valo until step 5 is complete; the ready flag needs the steps ----------
{
  const state = seedMerchant("cutover");
  const customer = recordsOf(state, "customers")[0]!;
  const cutover = recordsOf(state, "cutovers")[0]!;
  const input = () => ({ name: "d", status: "scheduled", customerId: customer.id, amountKobo: 2_500_000, data: { dueDate: "2027-08-01", owner: "valopay" } });
  assert.throws(() => validateRecord(state, admin, "due-items", input()), /collection transfer agreement and its parallel-run day are complete/);
  assert.throws(() => validateRecord(state, admin, "cutovers", patch(cutover, { status: "ready", data: { accountableUser: "Ops", confirmation: "signed" } }), true), /switch off the previous collection system in writing/);
  assert.doesNotThrow(() => validateRecord(state, admin, "cutovers", patch(cutover, { status: "ready", data: { accountableUser: "Ops", confirmation: "signed", incumbentDisabled: true, externalAttemptsImported: true, dualRunComplete: true } }), true));
  completeCutover(state);
  assert.doesNotThrow(() => validateRecord(state, admin, "due-items", input()));
  const aliased: any = { ...input(), data: { dueDate: "2027-08-01", owner: "valo" } };
  validateRecord(state, admin, "due-items", aliased);
  assert.equal(aliased.data.owner, "valopay", "the TRD's owner spelling is accepted and normalised");
  assert.throws(() => validateRecord(state, admin, "cutovers", patch(cutover, { status: "handed_back" }), true), /Return collection to its previous owner from Settings/);
  checks += 6;
}

// ---------- Hand-back (DEB-12, audit item 7): it ends every earlier contract; only a cutover recorded after it restores owner valo ----------
{
  const { state, due } = liveFixture({ merchantId: "hand-back-contract" });
  const contract = recordsOf(state, "cutovers").find((item) => item.status === "ready")!;
  contract.createdAt = contract.updatedAt = wat("2027-06-01T09:00:00");
  const draft = makeRecord(state, "cutovers", { name: "Cohort 2 draft", status: "draft", createdAt: wat("2027-06-20T09:00:00"), data: { inventory: "LMS scheduler", fallbackOwner: "lms" } });
  executeAction(state, ops, { action: "hand_back", reason: "Lender exit" });
  assert.equal(due.data.owner, "lms");
  const nextDay = ctxAt(wat("2027-07-02T09:00:00"), "Operations");
  assert.throws(() => validateRecord(state, nextDay, "due-items", patch(due, { data: { owner: "valopay" } }), true), /Record a new collection transfer agreement after collection was returned on/, "the contract the hand-back ended no longer lets Valo Pay collect");
  const flags = { incumbentDisabled: true, externalAttemptsImported: true, dualRunComplete: true, accountableUser: "Ops lead", confirmation: "Signed again" };
  assert.throws(() => validateRecord(state, admin, "cutovers", patch(draft, { status: "ready", data: flags }), true), /ended when collection was returned on/, "a contract drafted before the hand-back cannot be completed afterwards");
  assert.doesNotThrow(() => validateRecord(state, admin, "cutovers", { name: "Cohort 2 cutover", status: "ready", data: { ...flags, fallbackOwner: "lms" } }), "a new contract can be recorded ready");
  makeRecord(state, "cutovers", { name: "Cohort 2 cutover", status: "ready", createdAt: wat("2027-07-03T09:00:00"), data: { ...flags, fallbackOwner: "lms" } });
  assert.doesNotThrow(() => validateRecord(state, ctxAt(wat("2027-07-03T10:00:00"), "Operations"), "due-items", patch(due, { data: { owner: "valopay" } }), true), "a cutover completed after the hand-back restores ownership");
  checks += 5;
}

// ---------- Mandate limit (MAN-02, audit item 8): the consented limit changes only through a reissue with new consent ----------
{
  const { state, mandate } = liveFixture({ withFailure: false, merchantId: "mandate-limit" });
  assert.throws(() => validateRecord(state, ops, "mandates", patch(mandate, { amountKobo: 10_000_000 }), true), /limit is part of the customer’s consent/);
  assert.throws(() => validateRecord(state, ops, "mandates", patch(mandate, { amountKobo: mandate.amountKobo - 1 }), true), /limit is part of the customer’s consent/, "lowering it is refused too: the consent names one limit");
  assert.doesNotThrow(() => validateRecord(state, ops, "mandates", patch(mandate, { name: "Renamed mandate" }), true), "other fields stay editable");
  executeAction(state, ops, { action: "mandate_cancel", recordId: mandate.id, reason: "The customer agreed a higher limit" });
  assert.throws(() => executeAction(state, ops, { action: "mandate_reissue", recordId: mandate.id, reason: "Higher limit", data: { consentEvidence: "CONSENT-LIMIT-2", amountKobo: 0 } }), /debit limit/);
  const reissued = executeAction(state, ops, { action: "mandate_reissue", recordId: mandate.id, reason: "Higher limit", data: { consentEvidence: "CONSENT-LIMIT-2", amountKobo: 10_000_000 } }).record!;
  assert.equal(reissued.amountKobo, 10_000_000, "the new consent carries the new limit");
  assert.equal(mandate.amountKobo, 5_000_000, "the old mandate keeps the limit its consent covered");
  const same = executeAction(state, ops, { action: "mandate_reissue", recordId: reissued.id, reason: "Consent captured again", data: { consentEvidence: "CONSENT-LIMIT-3" } }).record!;
  assert.equal(same.amountKobo, 10_000_000, "without a new limit a reissue keeps the current one");
  checks += 7;
}

// ---------- Policy review (RET-01, audit item 18): a submitted policy is frozen until a reviewer rejects it ----------
{
  const state = seedMerchant("policy-freeze");
  const policy = recordsOf(state, "policies")[0]!;
  const reviewer = ctxAt(admin.now, "Compliance reviewer");
  const rules = (maxAttempts: number, spacingHours: number) => patch(policy, { data: { maxAttempts, spacingHours } });
  assert.doesNotThrow(() => validateRecord(state, admin, "policies", rules(3, 48), true), "a draft is editable by its author");
  executeAction(state, admin, { action: "submit_policy", recordId: policy.id, reason: "Ready for review" });
  assert.throws(() => validateRecord(state, admin, "policies", rules(4, 24), true), /This retry policy has been submitted for review, so it cannot be edited/);
  assert.throws(() => validateRecord(state, admin, "policies", patch(policy, { name: "Renamed while in review" }), true), /This retry policy has been submitted for review, so it cannot be edited/);
  executeAction(state, reviewer, { action: "reject_policy", recordId: policy.id, reason: "Explain the spacing" });
  assert.doesNotThrow(() => validateRecord(state, admin, "policies", rules(4, 24), true), "a rejected policy is editable again before it is resubmitted");
  checks += 4;
}

// ---------- Attempts: failure codes are normalised to the 4.4 catalogue, raw codes kept for mapping ----------
{
  const { state, due } = liveFixture({ withFailure: false, merchantId: "codes" });
  const attempt = (failureCode: string): any => ({ name: "a", status: "failed", customerId: due.customerId, amountKobo: due.amountKobo, data: { dueItemId: due.id, source: "external", simulated: true, failureCode, occurredAt: wat("2027-06-28T06:16:00") } });
  const aliased = attempt("ACCOUNT_CLOSED"); validateRecord(state, ops, "attempts", aliased);
  assert.equal(aliased.data.failureCode, "INVALID_ACCOUNT"); assert.equal(aliased.data.rawFailureCode, undefined);
  const unmapped = attempt("R99 weird provider text"); validateRecord(state, ops, "attempts", unmapped);
  assert.equal(unmapped.data.failureCode, "UNKNOWN"); assert.equal(unmapped.data.rawFailureCode, "R99 weird provider text");
  assert.equal(unmapped.data.number, 1, "DEB-05: numbered across sources");
  assert.throws(() => executeAction(state, ops, { action: "simulate_failure", recordId: due.id, reason: "r", data: { failureCode: "NOT_A_CODE" } }), /Choose a failure code from the list: /);
  const unknown = executeAction(state, ops, { action: "simulate_failure", recordId: due.id, reason: "r", data: { failureCode: "TIMEOUT_UNKNOWN" } }).record!;
  assert.equal(unknown.status, "unknown", "an unknown outcome is not a failure");
  assert.throws(() => executeAction(state, ops, { action: "simulate_failure", recordId: due.id, reason: "r", data: { failureCode: "INSUFFICIENT_FUNDS" } }), /still pending or has an unknown outcome/);
  checks += 7;
}

// ---------- Settlement batches and statuses from the shared vocabulary ----------
{
  const state = seedMerchant("batches");
  const finance = ctxAt(wat("2027-07-01T09:00:00"), "Finance");
  const batch: any = { name: "b", status: "pending", reference: "B-1", data: { provider: "Sandbox Rail", grossKobo: 100, feeKobo: 10, netKobo: 90 } };
  validateRecord(state, finance, "settlement-batches", batch);
  assert.equal(batch.data.batchReference, "B-1", "the top-level reference is the batch reference");
  assert.throws(() => validateRecord(state, finance, "settlement-batches", { ...batch, status: "settled" }), /Choose a status from the list: Pending, Reconciled or Variance\./);
  assert.throws(() => validateRecord(state, finance, "settlement-batches", { ...batch, status: "reconciled" }), /A new settlement batch cannot start as reconciled\. Valo Pay sets that status later\.|A new settlement batch must start as Pending/);
  assert.throws(() => validateRecord(state, finance, "settlement-batches", { ...batch, data: { ...batch.data, netKobo: 80 } }), /amount before fees minus the fee/);
  const customer: any = { name: "c", status: "inactive", data: { consentProvenance: "Imported" } };
  assert.doesNotThrow(() => validateRecord(state, ops, "customers", customer));
  assert.throws(() => validateRecord(state, ops, "customers", { ...customer, status: "archived" }), new RegExp(`Choose a status from the list: ${listText(recordStatuses.customers.map((status) => valueLabel(status)))}\\.`));
  assert.throws(() => validateRecord(state, ops, "customers", { name: "c", status: "active", data: {} }), /Consent source or reference: Enter a value\./);
  const policy: any = { name: "p", status: "draft", data: { version: "2", maxAttempts: 3, spacingHours: 48, firstNoticeHours: 48, retryNoticeHours: 24, author: admin.actor } };
  validateRecord(state, admin, "policies", policy);
  assert.equal(policy.data.version, 2, "coerced numbers are written back");
  assert.throws(() => validateRecord(state, admin, "policies", { ...policy, data: { ...policy.data, maxAttempts: 5 } }), /no more than 4 attempts/);
  assert.throws(() => validateRecord(state, admin, "policies", { ...policy, data: { ...policy.data, spacingHours: 12 } }), /at least 24 hours between attempts/);
  const calendar: any = { name: "h", status: "active", data: { date: "not-a-date" } };
  assert.throws(() => validateRecord(state, admin, "calendar", calendar), /YYYY-MM-DD/);
  checks += 11;
}

// Template review is a complete lifecycle; malformed placeholders never reach approval.
{
  const state = seedMerchant('template-review');
  const template = recordsOf(state, 'templates')[0]!;
  const reviewer = ctxAt(admin.now, 'Compliance reviewer');
  const act = (action: string, ctx = admin, recordId = template.id, reason = 'Synthetic review evidence') => executeAction(state, ctx, { action, recordId, reason });
  const originalText = template.data.text;
  for (const suffix of [' {{unknown}}', ' {{amount}', ' {amount}', ' {{}}', ' {{{amount}}}']) {
    assert.throws(() => validateRecord(state, admin, 'templates', patch(template, { data: { text: originalText + suffix } }), true), /placeholder|braces/);
    checks++;
  }
  assert.doesNotThrow(() => validateRecord(state, admin, 'templates', patch(template, { data: { text: '{{ merchant }} {{ amount }} {{ date }} {{ contact }}' } }), true));
  // The lender's name is {{lender}}; {{merchant}}, its earlier spelling, keeps working in templates saved with it.
  assert.doesNotThrow(() => validateRecord(state, admin, 'templates', patch(template, { data: { text: '{{ lender }} {{ amount }} {{ date }} {{ contact }}' } }), true));
  assert.deepEqual(templateTextProblems('{{lender}}: Your payment of {{amount}} is due on {{date}}. For help, contact {{contact}}.'), [], '{{lender}} names the lender');
  assert.deepEqual(templateTextProblems('{{merchant}}: Your payment of {{amount}} is due on {{date}}. For help, contact {{contact}}.'), [], 'a saved template with {{merchant}} still passes');
  assert.deepEqual(templateTextProblems('Your payment of {{amount}} is due on {{date}}. For help, contact {{contact}}.'), ['Add {{lender}} to the message.'], 'a message without the lender\'s name asks for {{lender}}');
  assert.deepEqual(templateTextProblems('{{shop}}: {{lender}} {{amount}} {{date}} {{contact}}'), ['Unknown placeholder {{shop}}. Use only {{amount}}, {{date}}, {{lender}} and {{contact}}.'], 'an unknown placeholder names the four to use');
  checks += 5;
  act('submit_template');
  assert.throws(() => validateRecord(state, admin, 'templates', patch(template, { data: { text: originalText + ' Changed.' } }), true), /This message template has been submitted for review, so it cannot be edited/);
  assert.throws(() => act('reject_template', { ...reviewer, actor: admin.actor }), /other than its author/);
  assert.throws(() => act('reject_template', reviewer, template.id, '  '), /Enter a reason/);
  act('reject_template', reviewer, template.id, 'Explain the date more clearly.');
  assert.equal(template.status, 'rejected');
  assert.equal(template.data.rejectionReason, 'Explain the date more clearly.');
  assert.equal((template.data.reviewHistory as unknown[]).length, 1);
  assert.doesNotThrow(() => validateRecord(state, admin, 'templates', patch(template, { data: { text: originalText + ' Thank you.' } }), true));
  assert.throws(() => validateRecord(state, admin, 'templates', patch(template, { data: { rejectionReason: 'No changes requested' } }), true), /Valo Pay records a template’s reviews, review dates and version links\. You cannot change them here\./);
  assert.throws(() => validateRecord(state, admin, 'templates', patch(template, { data: { version: 99 } }), true), /Leave the version number as it is\. Valo Pay numbers each new draft version\./);
  act('submit_template'); act('approve_template', reviewer);
  assert.equal(template.status, 'approved');
  assert.equal((template.data.reviewHistory as unknown[]).length, 2);
  const approved = structuredClone(template);
  const second = act('new_template_version').record!;
  const third = act('new_template_version').record!;
  assert.equal(second.data.version, 2); assert.equal(third.data.version, 3);
  assert.equal(second.data.previousVersionId, template.id);
  assert.equal(second.data.reviewer, undefined); assert.equal(second.data.rejectionReason, undefined);
  assert.deepEqual(template, approved);
  assert.throws(() => validateRecord(state, admin, 'templates', patch(template, { name: 'Overwrite approved' }), true), /This version is approved, so it cannot be edited/);
  assert.throws(() => act('new_template_version', reviewer), /Only Admin can draft a new version of a message template\./);
  assert.throws(() => act('new_template_version', admin, second.id), /Draft a new version only from an approved message template\./);
  second.status = 'submitted'; second.data.text = originalText + ' {{injected}}';
  assert.throws(() => act('approve_template', reviewer, second.id), /Unknown placeholder \{\{injected\}\}\. Use only \{\{amount\}\}/);
  second.data.text = originalText; delete second.data.author;
  assert.throws(() => act('approve_template', reviewer, second.id), /other than its author/);
  checks += 23;
}

// CSV mapping, quoted previews and all-or-nothing commits share the production parser.
{
  const state = seedMerchant('guided-import');
  const before = structuredClone(state);
  const input = { kind: 'customers', syntheticOnly: true, commit: false, csv: 'Full name,External ref,Consent,Unused\n"Sample, Person",SAMPLE-CSV-1,"Synthetic\nconsent",ignore', mapping: { 'Full name': 'name', 'External ref': 'reference', Consent: 'consentProvenance', Unused: '' }, identityColumn: 'External ref' };
  const preview = importCsv(state, admin, input);
  assert.equal(preview.valid, 1); assert.equal(preview.imported, 0); assert.equal(preview.skipped, 0);
  assert.deepEqual(preview.columns, ['Full name', 'External ref', 'Consent', 'Unused']);
  assert.equal(preview.preview[0]?.values['Full name'], 'Sample, Person');
  assert.equal(preview.preview[0]?.values.Consent, 'Synthetic\nconsent');
  assert.deepEqual(state, before);
  const committed = importCsv(state, admin, { ...input, commit: true });
  assert.equal(committed.imported, 1);
  const again = importCsv(state, admin, { ...input, commit: true });
  assert.equal(again.imported, 0); assert.equal(again.skipped, 1);
  assert.equal(state.records.find(record => record.reference === 'SAMPLE-CSV-1')?.data.Unused, undefined);
  const stableCount = state.records.length;
  const invalid = importCsv(state, admin, { ...input, csv: 'name,reference,consentProvenance\nValid,SAMPLE-CSV-2,Synthetic\nInvalid,SAMPLE-CSV-3,', mapping: undefined, identityColumn: 'reference', commit: true });
  assert.equal(invalid.valid, 1); assert.equal(invalid.invalid, 1); assert.equal(invalid.imported, 0); assert.equal(state.records.length, stableCount);
  assert.match(invalid.rows[0]!.message, /Not imported/);
  assert.throws(() => importCsv(state, admin, { ...input, syntheticOnly: false }), /Only sample data can be imported/);
  assert.throws(() => importCsv(state, admin, { ...input, mapping: { 'Full name': 'name', 'External ref': 'name' } }), /only once/);
  assert.throws(() => importCsv(state, admin, { ...input, mapping: { Consent: '__proto__' } }), /Choose a field, or Skip column, for each column in the file/);
  assert.throws(() => importCsv(state, admin, { ...input, mapping: { Unknown: 'name' } }), /Choose a field, or Skip column, for each column in the file/);
  assert.throws(() => importCsv(state, admin, { ...input, csv: 'name,name\nOne,Two' }), /different, non-empty header/);
  assert.throws(() => importCsv(state, admin, { ...input, csv: '__proto__,name\nobject,Name' }), /Some names, such as ‘constructor’, cannot be used/);
  assert.throws(() => importCsv(state, admin, { ...input, csv: 'name\n' + 'é'.repeat(750001) }), /1.5 MB/);
  assert.throws(() => importCsv(state, admin, { ...input, csv: 'name\n' + Array.from({ length: 501 }, () => 'Sample').join('\n') }), /between 1 and 500/);
  assert.throws(() => importCsv(state, admin, { ...input, csv: 'name\n"Unclosed' }), /Valo Pay could not read this CSV file/);
  checks += 25;
}

// CSV numbers: a blank optional number is absent, while a blank amount and a receipt of ₦0 are row errors.
{
  const state = seedMerchant("blank-numbers");
  // Each file's reference is its row ID.
  const rows = (kind: string, csv: string, extra: Partial<Parameters<typeof importCsv>[2]> = {}) => importCsv(state, admin, { kind, csv, syntheticOnly: true, commit: true, amountUnit: "kobo", identityColumn: "reference", ...extra });
  const saved = (reference: string) => state.records.find((record) => record.reference === reference)!;
  // Each row was refused before: a blank count read as 0 failed its minimum, and a blank fee failed the amount parser.
  for (const [kind, csv] of [
    ["customers", "name,reference,consentProvenance,payDay\nBlank pay day,IMP-C-BLANK,Synthetic consent,"],
    ["due-items", "name,reference,customerId,amountKobo,dueDate,owner,outstandingKobo\nBlank outstanding,IMP-D-BLANK,DEMO-C1001,1000000,2028-12-01,lms,"],
    ["attempts", "name,reference,customerId,amountKobo,dueItemId,number,failureCode,occurredAt\nBlank number,IMP-A-BLANK,DEMO-C1001,2500000,DEMO-LOAN-1001,,INSUFFICIENT_FUNDS,2028-12-02"],
    ["observations", "name,reference,customerId,amountKobo,source,feeKobo,grossAmountKobo\nBlank fees,IMP-O-BLANK,DEMO-C1001,2500000,webhook,,"],
  ] as const) { const result = rows(kind, csv); assert.equal(result.imported, 1, `${kind}: ${JSON.stringify(result.rows)}`); }
  assert.equal(saved("IMP-C-BLANK").data.payDay, undefined, "a blank pay day is absent, not 0");
  assert.equal(saved("IMP-D-BLANK").data.outstandingKobo, 1000000, "the whole instalment is outstanding");
  assert.equal(saved("IMP-A-BLANK").data.number, 2, "a blank attempt number is worked out after the instalment's earlier attempt");
  assert.deepEqual([saved("IMP-O-BLANK").data.feeKobo, saved("IMP-O-BLANK").data.grossAmountKobo], [undefined, undefined], "blank fees are absent, not ₦0");
  // A quoted cell of spaces survives the parser's trim; it is blank all the same.
  for (const [kind, csv] of [
    ["customers", 'name,reference,consentProvenance,payDay\nSpaced pay day,IMP-C-SPACED,Synthetic consent," "'],
    ["observations", 'name,reference,customerId,amountKobo,source,feeKobo,grossAmountKobo\nSpaced fees,IMP-O-SPACED,DEMO-C1001,2500000,webhook," ","\t"'],
  ] as const) { const result = rows(kind, csv); assert.equal(result.imported, 1, `${kind} with quoted spaces: ${JSON.stringify(result.rows)}`); }
  assert.equal(saved("IMP-C-SPACED").data.payDay, undefined, "a pay day of spaces is absent");
  assert.deepEqual([saved("IMP-O-SPACED").data.feeKobo, saved("IMP-O-SPACED").data.grossAmountKobo], [undefined, undefined], "fees of spaces are absent");
  // A blank count was read as 0, so such a row could be valid: its fingerprint is still the one the previous build stored.
  const identities = { source: "blank-lms", batchId: "blank-batch", ids: ["row-1"] };
  const mandate = "name,reference,customerId,amountKobo,workflow,consentEvidence,reminderCount\nBlank reminders,IMP-M-BLANK,DEMO-C1001,5000000,hosted_consent,SYNTHETIC-CONSENT-BLANK,";
  assert.equal(rows("mandates", mandate, { identities }).imported, 1);
  assert.equal(saved("IMP-M-BLANK").data.reminderCount, undefined);
  assert.equal(saved("IMP-M-BLANK").data.importIdentity.fingerprint, "463d15b91cfdf3bc9a19ed3f974bcfb3deb73f0b46319e3989c9cd166372f3f0");
  assert.equal(rows("mandates", mandate, { identities }).rows[0]!.status, "duplicate", "importing the same row again is recognised");
  // The amount is still required wherever a kind has one, with the same row error.
  const noAmount = "name,reference,customerId,amountKobo,dueDate,owner\nBlank amount,IMP-D-NOAMOUNT,DEMO-C1001,,2028-12-01,lms";
  assert.match(rows("due-items", noAmount).rows[0]!.message, /Enter kobo as a whole number/);
  assert.match(rows("due-items", noAmount, { amountUnit: "naira" }).rows[0]!.message, /Enter an amount in naira/);
  // Payment evidence records money received: ₦0, or no amount at all, is refused by the import and the record API alike.
  for (const [csv, message] of [
    ["name,reference,customerId,amountKobo,source\nZero receipt,IMP-O-ZERO,DEMO-C1001,0,webhook", "Amount (column amountKobo): Enter the amount received. Payment evidence must be for more than ₦0."],
    ["name,reference,customerId,source\nNo amount,IMP-O-NONE,DEMO-C1001,webhook", "No column is mapped to Amount. Map the column that holds it."],
  ] as const) {
    const refused = rows("observations", csv);
    assert.deepEqual([refused.invalid, refused.imported, refused.rows[0]!.message, refused.rows[0]!.detail], [1, 0, message, "Enter the amount received. Payment evidence must be for more than ₦0."]);
  }
  assert.equal(state.records.some((record) => ["IMP-O-ZERO", "IMP-O-NONE", "IMP-D-NOAMOUNT"].includes(record.reference)), false);
  const customerId = saved("IMP-C-BLANK").id;
  assert.throws(() => validateRecord(state, ops, "observations", { name: "Zero", reference: "API-O-ZERO", customerId, amountKobo: 0, data: { source: "webhook" } }), /more than ₦0/);
  assert.doesNotThrow(() => validateRecord(state, ops, "observations", { name: "One kobo", reference: "API-O-ONE", customerId, amountKobo: 1, data: { source: "webhook" } }));
  checks += 19;
}

// ---------- The bank-detail screen refuses account and card numbers, not record IDs ----------
{
  for (const value of [{ accountId: "1234567890" }, { "Account number": "0123456789" }, { bank: "1234-5678-9012" }, { cardNumber: "4111111111111111" }, { virtualAccountCustomerId: "0123456789" }, { accounts: "0123456789" }, { payerCards: "4111 1111 1111 1111" }]) {
    assert.throws(() => assertNoRealBankDetails(value), /Do not enter (full account, card or BVN numbers|a full bank account number)/, `refused: ${JSON.stringify(value)}`);
  }
  // A UUID's digit groups are not an account number, and "company" or "accountable" are not financial words.
  const digitHeavy = "12345678-1234-4123-8123-123456789012";
  for (const value of [{ virtualAccountCustomerId: digitHeavy }, { companyId: "12345678901" }, { accountableUser: "12345678" }, { accountMasked: "•••• 1234" }, { accountRef: `batch ${digitHeavy} line` }]) {
    assert.doesNotThrow(() => assertNoRealBankDetails(value), `accepted: ${JSON.stringify(value)}`);
  }
  // End to end: a customer whose ID has long digit groups carries a virtual-account link and R2 matches it.
  const state = seedMerchant("virtual-account");
  makeRecord(state, "customers", { id: digitHeavy, name: "Synthetic virtual-account customer", status: "active", data: { consentProvenance: "Synthetic imported consent" } });
  const due = makeRecord(state, "due-items", { name: "Virtual account instalment", status: "scheduled", customerId: digitHeavy, amountKobo: 1_000_000, reference: "VA-LOAN-1", data: { dueDate: "2027-07-01", owner: "lms", outstandingKobo: 1_000_000 } });
  addObservation(state, { reference: "VA-1", amountKobo: 1_000_000, source: "transfer", customerId: digitHeavy, virtualAccountCustomerId: digitHeavy, eventId: "va-1", occurredAt: wat("2027-07-01T09:00:00") });
  reconcile(state, ctxAt(wat("2027-07-01T09:05:00"), "Finance"));
  const payment = recordsOf(state, "payments").find((item) => item.reference === "VA-1")!;
  assert.equal(payment.data.virtualAccountCustomerId, digitHeavy);
  assert.equal(payment.status, "allocated");
  assert.equal(recordsOf(state, "allocations").find((item) => item.data.paymentId === payment.id)!.data.rule, "R2");
  assert.equal(due.status, "paid");
  checks += 16;
}

console.log(`Validation golden tests passed (${checks} checks): state machines, exception codes, cutover contract and hand-back, mandate limits, submitted policies, failure-code normalisation, batch/status vocabularies, template lifecycle, guided CSV imports, blank CSV numbers and ₦0 receipts, and the bank-detail screen.`);
