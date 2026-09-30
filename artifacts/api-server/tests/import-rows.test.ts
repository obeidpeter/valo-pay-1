// Import rows (usability backlog UX-B03, UX-B10, UX-EX2 and UX-EX3, and the owner's decisions of September 2026):
// the quick import (POST /v1/imports) requires a source row ID on every row and recognises its rows across imports,
// and each row error names the operator's column in plain words, lists every failing rule and keeps the raw detail.
import assert from "node:assert/strict";
import { fromImportBatch, importFieldLabel, importFieldsOf, suggestImportField, suggestRowIdColumn, csvHeader } from "@workspace/valopay-schema";
import { seedMerchant } from "../src/lib/valopay-seed";
import { importCsv, QUICK_IMPORT_SOURCE } from "../src/lib/valopay-import";
import { validateRecord } from "../src/domain/validation";
import { assertNoDirectImportedCorrection } from "../src/domain/import-corrections";
import { saveImportBatch } from "../src/domain/pilot-workflow";

process.env.DATABASE_URL ||= "postgres://unused:unused@127.0.0.1:1/unused";
const { buildDisputePack } = await import("../src/lib/valopay-packs");
const admin = { actor: "Sandbox Admin", role: "Admin", now: "2026-09-25T10:00:00.000Z" };
let checks = 0;
const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks += 1; };
const refused = (run: () => unknown, pattern: RegExp, message: string) => { assert.throws(run, (error: Error & { status?: number }) => pattern.test(error.message) && error.status === 400, message); checks += 1; };
type Extra = Partial<Parameters<typeof importCsv>[2]>;
const quick = (state: ReturnType<typeof seedMerchant>, kind: string, csv: string, extra: Extra = {}) => importCsv(state, admin, { kind, csv, syntheticOnly: true, commit: true, identityColumn: "row_id", amountUnit: "kobo", ...extra });

{
  // Decision 1: every quick-import row carries a source row ID, and a file or mapping without one is refused.
  const state = seedMerchant("quick-row-ids");
  const before = state.records.length;
  refused(() => quick(state, "customers", "name,consentProvenance\nNo row ID,Synthetic consent", { identityColumn: "" }), /^Map a row ID column\. Choose the column that holds each row's source row ID/, "no row ID column is refused");
  refused(() => quick(state, "customers", "name,consentProvenance\nNo row ID,Synthetic consent"), /^Map a row ID column\. The file has no column named “row_id”\./, "a row ID column the file lacks is refused, naming it");
  refused(() => quick(state, "customers", "row_id,name,consentProvenance\nr1,First,Synthetic consent\n,Second,Synthetic consent"), /different, non-empty value on every row/, "a blank row ID is refused");
  refused(() => quick(state, "customers", "row_id,name,consentProvenance\nr1,First,Synthetic consent\nr1,Second,Synthetic consent"), /different, non-empty value on every row/, "a repeated row ID is refused");
  refused(() => quick(state, "customers", `row_id,name,consentProvenance\n${"r".repeat(161)},Long,Synthetic consent`), /up to 160 characters/, "a row ID over 160 characters is refused");
  check(state.records.length === before, "nothing is saved by a refused file");

  // Reference-free rows are recognised by their row ID: importing the same file again creates nothing new.
  const file = "row_id,name,consentProvenance\nr1,Reference-free one,Synthetic consent\nr2,Reference-free two,Synthetic consent";
  const first = quick(state, "customers", file);
  check(first.imported === 2 && first.invalid === 0, `the first import saves both rows (${JSON.stringify(first.rows)})`);
  const saved = state.records.filter((record) => record.name.startsWith("Reference-free"));
  assert.deepEqual(saved.map((record) => [record.data.importIdentity.source, record.data.importIdentity.rowId, record.data.importIdentity.batchId, typeof record.data.importIdentity.fingerprint]), [[QUICK_IMPORT_SOURCE, "r1", undefined, "string"], [QUICK_IMPORT_SOURCE, "r2", undefined, "string"]]); checks += 1;
  check(saved.every((record) => record.data.row_id === undefined), "the row ID column is the identity, not extra data");
  const again = quick(state, "customers", file);
  check(again.imported === 0 && again.skipped === 2 && again.rows.every((row) => row.status === "duplicate" && row.message === "This source row ID was imported before with the same data; nothing is changed."), `the same file again is recognised row by row (${JSON.stringify(again.rows)})`);
  check(state.records.filter((record) => record.name.startsWith("Reference-free")).length === 2, "and creates nothing new");
  const changed = quick(state, "customers", "row_id,name,consentProvenance\nr1,Reference-free renamed,Synthetic consent");
  check(changed.invalid === 1 && /^This source row ID was already imported with different data\./.test(changed.rows[0]!.message), "a row ID imported before with different data is refused with the existing message");
  // A different file sharing a row ID with the first is the same row; one sharing a reference with another row is refused.
  const referenced = quick(state, "customers", "row_id,name,reference,consentProvenance\nr9,Seeded reference,DEMO-C1001,Synthetic consent");
  check(referenced.invalid === 1 && /This reference belongs to another saved record/.test(referenced.rows[0]!.message), "a new row ID with another record's reference is refused, not skipped");

  // A row ID column named reference also fills the reference, as a batch's does.
  const byReference = quick(state, "customers", "reference,name,consentProvenance\nQUICK-REF-1,Keyed by reference,Synthetic consent", { identityColumn: "reference" });
  check(byReference.imported === 1 && state.records.find((record) => record.name === "Keyed by reference")?.reference === "QUICK-REF-1", "the reference is the row ID and the record's reference");

  // Quick-imported records stay editable as before: no batch holds them for a reviewed correction.
  const quickRecord = state.records.find((record) => record.name === "Reference-free one")!;
  assert.doesNotThrow(() => assertNoDirectImportedCorrection(quickRecord, { ...quickRecord, name: "Edited after a quick import", data: { ...quickRecord.data } })); checks += 1;
  check(!fromImportBatch(quickRecord) && fromImportBatch({ data: { importIdentity: { source: "loan-system", rowId: "r1", batchId: "batch-1" } } }), "the console's edit lock is a batch's alone");
  // Its history names the quick import and the row, and no batch.
  check(buildDisputePack(state, admin, quickRecord.id).timeline[0]!.detail.endsWith("Imported from Quick import; source row r1."), "the customer's history names the source row");

  // Payment evidence keeps its own event rules as well: the same event under a new row ID is refused.
  const evidence = quick(state, "observations", "row_id,reference,customerId,amountKobo,source,eventId\no1,QUICK-EVIDENCE-1,DEMO-C1001,2500000,webhook,evt-1");
  check(evidence.imported === 1, `payment evidence with a row ID is imported (${JSON.stringify(evidence.rows)})`);
  const sameEvent = quick(state, "observations", "row_id,reference,customerId,amountKobo,source,eventId\no2,QUICK-EVIDENCE-1,DEMO-C1001,2500000,webhook,evt-1");
  check(sameEvent.invalid === 1 && sameEvent.imported === 0, "the same source event under another row ID is refused");
}

{
  // Decision 2: a row error names the operator's column and the shared label, never a raw field path, in plain words;
  // decision 4: it lists every failing rule. The raw detail stays with the row.
  const state = seedMerchant("row-errors");
  const customers = quick(state, "customers", "row_id,name,consent,consentCapturedAt,pay_day\nr1,Two problems,,2026-02-30,40", { commit: false, mapping: { consent: "consentProvenance", pay_day: "payDay" } });
  const [row] = customers.rows;
  assert.equal(row!.message, "Consent captured at (column consentCapturedAt): Use YYYY-MM-DD or a UTC timestamp such as 2026-09-18T07:00:00Z, and a real date. Consent source or reference (column consent): Enter a value; it is blank on this row. Pay day (column pay_day): Enter a number of at most 31."); checks += 1;
  check(!/consentProvenance|payDay|String must contain|Number must be/.test(row!.message), "no raw field path or zod default text");
  check(/Consent source or reference: Enter a value\./.test(String(row!.detail)) && /Consent captured at: Enter a real date as YYYY-MM-DD/.test(String(row!.detail)) && !/String must contain|consentProvenance|consentCapturedAt/.test(String(row!.detail)), `the detail keeps every problem in the service's own words, with field labels (${row!.detail})`);

  const noConsent = quick(state, "customers", "row_id,name\nr1,No consent column", { commit: false });
  assert.equal(noConsent.rows[0]!.message, "No column is mapped to Consent source or reference. Map the column that holds it."); checks += 1;

  const mandates = quick(state, "mandates", "row_id,name,customer,amount,workflow,consentEvidence,consentGiven\nr1,Paper mandate,NOPE-1,5000000,paper,SYNTHETIC-CONSENT,yes", { commit: false, mapping: { customer: "customerId" } });
  assert.equal(mandates.rows[0]!.message, "Consent given (column consentGiven): Use true or false. Activation workflow (column workflow): “paper” is not one of the choices. Use Activate with a bank transfer (transfer_to_activate) or Consent through the provider (hosted_consent). Customer reference or ID (column customer): No customer has the reference or ID “NOPE-1” in this lender."); checks += 1;

  const dueFile = "row_id,name,customerId,amount,dueDate,owner,status\nr1,Zero instalment,DEMO-C1001,0,2028-12-01,lms,scheduled";
  assert.equal(quick(state, "due-items", dueFile, { commit: false, amountUnit: "naira" }).rows[0]!.message, "Amount: Enter an amount above ₦0 in naira, for example 1,000.50."); checks += 1;
  assert.equal(quick(state, "due-items", dueFile, { commit: false }).rows[0]!.message, "Amount: Enter a whole number of kobo above 0, for example 100000 for ₦1,000."); checks += 1;
  const undated = quick(state, "due-items", "row_id,name,customerId,amount,owner,status,mandate\nr1,Undated,DEMO-C1001,1000000,someone,paid,NOPE-M", { commit: false, mapping: { mandate: "mandateId" } });
  assert.equal(undated.rows[0]!.message, "Status: Paid (paid) is set by a domain action, so a new instalment cannot start with it. Leave the column blank or use Scheduled (scheduled). No column is mapped to Due date. Map the column that holds it. Collection owner (column owner): “someone” is not one of the choices. Use Valo Pay (valopay), Loan management system (lms), Lender team (merchant_manual) or Provider automatic collection (provider_auto). Mandate reference or ID (column mandate): No mandate has the reference or ID “NOPE-M” in this lender."); checks += 1;

  const status = quick(state, "customers", "row_id,name,consentProvenance,status\nr1,Archived,Synthetic consent,archived", { commit: false });
  assert.equal(status.rows[0]!.message, "Status: “archived” is not one of the choices. Use Active (active) or Inactive (inactive)."); checks += 1;

  const attempt = quick(state, "attempts", "row_id,name,customerId,amount,instalment\nr1,Unknown instalment,DEMO-C1001,2500000,NOPE-D", { commit: false, mapping: { instalment: "dueItemId" } });
  assert.equal(attempt.rows[0]!.message, "Instalment reference or ID (column instalment): No instalment has the reference or ID “NOPE-D” in this lender."); checks += 1;

  const unparsed = quick(state, "due-items", "row_id,name,customerId,amount,dueDate,owner\nr1,Unparsed,DEMO-C1001,12.5,2028-12-01,lms", { commit: false, amountUnit: "kobo" });
  assert.equal(unparsed.rows[0]!.message, "Amount: Enter kobo as a whole number without commas or decimals, for example 100000. Choose Naira (₦) if the source uses naira."); checks += 1;
  // Integration fix: payment evidence has no unit called Naira, and its row can name another currency. A minor-unit
  // amount that is not a whole number names the kind's own option (amountUnitName) and the row's smallest unit.
  const minor = quick(state, "observations", "row_id,name,reference,customerId,amount,source,currency\nr1,Naira decimals,QUICK-MINOR-1,DEMO-C1001,10.50,card,\nr2,Dollar decimals,QUICK-MINOR-2,DEMO-C1001,10.50,card,usd", { commit: false, amountUnit: "kobo" });
  assert.deepEqual(minor.rows.map((row) => row.message), [
    "Amount: Enter kobo as a whole number without commas or decimals, for example 100000. Choose Main unit (₦, or the row’s own currency) if the source uses naira.",
    "Amount: Enter the smallest unit of USD as a whole number without commas or decimals, for example 100000. Choose Main unit (₦, or the row’s own currency) if the source gives amounts in USD rather than its smallest unit.",
  ]); checks += 1;
}

{
  // Integration fix: only a kind with a currency field (payment evidence) reads its amounts in the row's currency. A
  // column headed currency in an instalment file names no currency of its amounts, which stay naira (or kobo).
  const state = seedMerchant("currency-kinds");
  check(!importFieldsOf("due-items").includes("currency") && importFieldsOf("observations").includes("currency"), "only payment evidence has a currency field");
  const dues = quick(state, "due-items", 'row_id,name,reference,customerId,amount,dueDate,owner,currency\nd1,Yen column,DUE-CUR-JPY,DEMO-C1001,"1,000,000",2099-01-01,lms,JPY\nd2,Dinar column,DUE-CUR-KWD,DEMO-C1001,"15,000.5",2099-01-01,lms,KWD', { amountUnit: "naira" });
  check(dues.imported === 2, `both instalments are imported (${JSON.stringify(dues.rows)})`);
  assert.deepEqual(dues.preview.map((row) => row.amountKobo), [100_000_000, 1_500_050], "the preview reads naira whatever the column says"); checks += 1;
  assert.deepEqual(["DUE-CUR-JPY", "DUE-CUR-KWD"].map((reference) => state.records.find((record) => record.reference === reference)!.amountKobo), [100_000_000, 1_500_050], "each instalment is saved in kobo"); checks += 1;
  const attempts = quick(state, "attempts", "row_id,name,customerId,amount,dueItemId,failureCode,occurredAt,currency\na1,Yen attempt,DEMO-C1001,2500.50,DUE-CUR-JPY,INSUFFICIENT_FUNDS,2099-01-02,JPY", { commit: false, amountUnit: "naira" });
  check(attempts.preview[0]?.amountKobo === 250_050, `a collection attempt keeps its naira decimals (${JSON.stringify(attempts.rows)})`);
  const evidence = quick(state, "observations", 'row_id,name,reference,customerId,amount,source,currency\no1,Yen payment,OBS-CUR-JPY,DEMO-C1001,"1,000",card,JPY', { commit: false, amountUnit: "naira" });
  check(evidence.preview[0]?.amountKobo === 1000, "payment evidence still reads its amount in its row's currency");
}

{
  // Record create and edit keep their single first message: the import path alone collects every problem.
  const state = seedMerchant("single-message");
  assert.throws(() => validateRecord(state, admin, "customers", { name: "Two problems", data: { consentCapturedAt: "2026-02-30", consentProvenance: "" } }), (error: Error) => error.message === "Consent captured at: Enter a real date as YYYY-MM-DD, or a UTC timestamp such as 2026-09-18T07:00:00Z."); checks += 1;
  assert.throws(() => validateRecord(state, admin, "customers", { name: "Blank consent", data: { consentProvenance: "", payDay: 40 } }), (error: Error) => error.message === "Consent source or reference: Enter a value. Pay day: Enter 31 or less."); checks += 1;
}

{
  // Decision 2's shared labels: one map for both import screens, the samples, the customer form and the row errors.
  check(importFieldLabel("customers", "consentProvenance") === "Consent source or reference" && importFieldLabel("customers", "name") === "Full name" && importFieldLabel("customers", "reference") === "Loan software reference", "the customer form's labels");
  check(importFieldLabel("due-items", "customerId") === "Customer reference or ID" && importFieldLabel("attempts", "dueItemId") === "Instalment reference or ID" && importFieldLabel("due-items", "mandateId") === "Mandate reference or ID" && importFieldLabel("mandates", "amountKobo") === "Amount", "the link and amount columns");
  check(importFieldLabel("observations", "grossAmountKobo") === "Gross amount" && importFieldLabel("mandates", "cancellationReason") === "Cancellation reason", "any other field in words");
  check(suggestImportField("customers", "Consent source or reference") === "consentProvenance" && suggestImportField("customers", "Loan software reference") === "reference" && suggestImportField("attempts", "Instalment reference or ID") === "dueItemId", "a column headed with a shared label is suggested for its field");
  check(suggestRowIdColumn(["name", "Source row ID"]) === "Source row ID" && suggestRowIdColumn(["source_row_id", "name"]) === "source_row_id" && suggestRowIdColumn(["name", "reference"]) === undefined, "a row ID column is recognised by its header");
  assert.deepEqual(csvHeader('\uFEFF"Full name", "Loan, reference" ,Consent\r\nA,B,C'), ["Full name", "Loan, reference", "Consent"]); checks += 1;
  assert.deepEqual(csvHeader('"Unclosed,header'), []); checks += 1;
  // A batch's row error is worded alike.
  const state = seedMerchant("batch-errors", true);
  const batch = saveImportBatch(state, admin, { name: "Blank consent", kind: "customers", source: "loan-system", sourceBatchId: "blank-1", businessDate: "2026-09-25", identityColumn: "source_row_id", amountUnit: "naira", mapping: {}, syntheticOnly: true, csv: "source_row_id,name,consentProvenance\nrow-1,Blank consent," });
  assert.equal(batch.data.check.rows[0].message, "Consent source or reference (column consentProvenance): Enter a value; it is blank on this row."); checks += 1;
}

{
  // A row ID is kept with the record, so it is screened as its column: a raw account number is refused as a batch
  // refuses it, on a check and on a commit, with or without an Idempotency-Key.
  const state = seedMerchant("row-id-screen");
  const before = state.records.length;
  const raw = "account_number,name,consentProvenance\n0123456789,Raw account row,Synthetic consent";
  refused(() => quick(state, "customers", raw, { identityColumn: "account_number" }), /^Do not enter a full bank account number\. Enter a masked number, for example •••• 1234\.$/, "a raw account number as the row ID is refused");
  refused(() => quick(state, "customers", raw, { identityColumn: "account_number", commit: false }), /^Do not enter a full bank account number/, "and refused by a check");
  refused(() => quick(state, "customers", "Account ID,name,consentProvenance\n0123-4567-89,Account digits,Synthetic consent", { identityColumn: "Account ID" }), /^Do not enter full account, card or BVN numbers/, "digits under a financial header are refused");
  check(state.records.length === before, "nothing is saved from a refused row ID");
  const masked = quick(state, "customers", "account_ref,name,consentProvenance\nACC-0001,Account reference row,Synthetic consent", { identityColumn: "account_ref" });
  check(masked.imported === 1 && state.records.find((record) => record.name === "Account reference row")?.data.importIdentity.rowId === "ACC-0001", "a row ID that is no account number is kept");
}

{
  // The header the browser reads is the importer's: blank lines before it are skipped, as the server's parser skips them.
  assert.deepEqual(csvHeader("\nrow_id,name,consentProvenance\nr1,Leading blank line,Synthetic consent"), ["row_id", "name", "consentProvenance"]); checks += 1;
  assert.deepEqual(csvHeader("﻿\r\n  \n\t\r\nrow_id,name\r\nr1,Blank lines"), ["row_id", "name"]); checks += 1;
  assert.deepEqual(csvHeader("\n\n"), []); checks += 1;
  const lead = quick(seedMerchant("leading-blank"), "customers", "\nrow_id,name,consentProvenance\nr1,Leading blank line,Synthetic consent", { commit: false });
  check(lead.valid === 1 && lead.invalid === 0, "and the importer reads the same file");
}

{
  // A reference chosen as the row ID column fills no reference unless mapped to it, so its generated reference warns.
  const state = seedMerchant("reference-row-id");
  const file = "Reference,name,consentProvenance\nREF-ROW-1,Keyed by its reference,Synthetic consent";
  const unmapped = quick(state, "customers", file, { identityColumn: "Reference", commit: false });
  check(unmapped.valid === 1 && unmapped.warnings?.some((warning) => warning.startsWith("No column is mapped to Reference, so each record gets a generated reference. Not mapped to a field: Reference, which looks like the reference.")), `the fallback reference warns (${JSON.stringify(unmapped.warnings)})`);
  const mapped = quick(state, "customers", file, { identityColumn: "Reference", mapping: { Reference: "reference" } });
  check(mapped.imported === 1 && !mapped.warnings && state.records.find((record) => record.name === "Keyed by its reference")?.reference === "REF-ROW-1", "mapped to the reference, it is the row ID and the reference");
  const other = quick(state, "customers", "source_row_id,name,consentProvenance\nrow-9,No reference column,Synthetic consent", { identityColumn: "source_row_id", commit: false });
  check(!other.warnings, "a row ID column that does not look like the reference is still metadata");
}

{
  // A field a CSV cell cannot fill, such as one Valo Pay sets, is named in plain words, never by its path or zod's text.
  const state = seedMerchant("platform-fields");
  const history = quick(state, "mandates", "row_id,name,customerId,amount,workflow,consentEvidence,history\nr1,History,DEMO-C1001,5000000,hosted_consent,SYNTHETIC-CONSENT,v1", { commit: false, mapping: { history: "policyVersionHistory" } });
  assert.equal(history.rows[0]!.message, "Policy version history (column history): A CSV column cannot fill this field. Choose Skip column for it."); checks += 1;
  check(/^Policy version history: Check this value\. It is not in the form this field takes\.$/.test(String(history.rows[0]!.detail)), `the detail says so in plain words, with the field's label (${history.rows[0]!.detail})`);
  // Every import field of every kind, given values it cannot take, is worded without a raw path or a zod default.
  const base: Record<string, Record<string, string>> = {
    customers: { name: "N", consentProvenance: "Synthetic" },
    mandates: { name: "N", customerId: "DEMO-C1001", amountKobo: "5000000", workflow: "hosted_consent", consentEvidence: "SYN-1" },
    "due-items": { name: "N", customerId: "DEMO-C1001", amountKobo: "1000000", dueDate: "2028-12-01", owner: "lms" },
    attempts: { name: "N", customerId: "DEMO-C1001", amountKobo: "2500000", dueItemId: "DEMO-LOAN-1001" },
    observations: { name: "N", reference: "OBS-X", customerId: "DEMO-C1001", amountKobo: "2500000", source: "webhook" },
  };
  const leaks: string[] = [];
  for (const kind of Object.keys(base)) {
    for (const field of importFieldsOf(kind)) {
      for (const bad of ["zzz", "-5", "true", "a|b", "x".repeat(300)]) {
        const cells = { ...base[kind], [field]: bad }, fields = Object.keys(cells);
        const csv = `rid,${fields.map((_, index) => `c${index}`).join(",")}\nr1,${fields.map((name) => `"${cells[name]}"`).join(",")}`;
        const [row] = quick(state, kind, csv, { commit: false, identityColumn: "rid", mapping: Object.fromEntries(fields.map((name, index) => [`c${index}`, name])) }).rows;
        if (row!.status === "invalid" && (importFieldsOf(kind).some((key) => new RegExp(`\\b${key}:`).test(row!.message) || (/[A-Z]/.test(key) && new RegExp(`\\b${key}\\b`).test(row!.message))) || /Expected|received|Invalid|Required|String must|Number must|Array must/.test(row!.message))) leaks.push(`${kind}.${field}=${bad.slice(0, 5)}: ${row!.message}`);
      }
    }
  }
  assert.deepEqual(leaks, []); checks += 1;
}

{
  // Decision 4 for the import's own conflicts: a row reports its reference and row ID conflicts beside every other rule.
  const state = seedMerchant("conflicts");
  const conflict = quick(state, "customers", "row_id,name,reference,consentProvenance,status\nr1,Conflict,DEMO-C1001,,archived", { commit: false });
  assert.equal(conflict.rows[0]!.message, "Loan software reference (column reference): This reference belongs to another saved record. Check its source row identity before importing; a conflicting row will not be silently skipped. Status: “archived” is not one of the choices. Use Active (active) or Inactive (inactive). Consent source or reference (column consentProvenance): Enter a value; it is blank on this row."); checks += 1;
  // A cell that cannot be read does not hide the reference conflict.
  const unreadable = quick(state, "due-items", "row_id,name,reference,customerId,amount,dueDate,owner\nr1,Unreadable,DEMO-LOAN-1001,DEMO-C1001,12.5,2028-12-01,lms", { commit: false });
  assert.equal(unreadable.rows[0]!.message, "Amount: Enter kobo as a whole number without commas or decimals, for example 100000. Choose Naira (₦) if the source uses naira. Reference: This reference belongs to another saved record. Check its source row identity before importing; a conflicting row will not be silently skipped."); checks += 1;
  // A row ID imported before with different data reports the other rules too, and its own record's reference is no conflict.
  check(quick(state, "customers", "row_id,name,reference,consentProvenance\nk1,Keyed once,QUICK-KEYED-1,Synthetic consent").imported === 1, "a keyed row is imported");
  const changed = quick(state, "customers", "row_id,name,reference,consentProvenance,status\nk1,Keyed renamed,QUICK-KEYED-1,Synthetic consent,archived", { commit: false });
  assert.equal(changed.rows[0]!.message, "This source row ID was already imported with different data. Review the existing record; it cannot be replaced by importing again. Status: “archived” is not one of the choices. Use Active (active) or Inactive (inactive)."); checks += 1;
  const moved = quick(state, "customers", "row_id,name,reference,consentProvenance\nk1,Keyed once,DEMO-C1001,Synthetic consent", { commit: false });
  check(/^This source row ID was already imported with different data\..* Loan software reference \(column reference\): This reference belongs to another saved record\./.test(moved.rows[0]!.message), `a changed reference that another record has is reported as well (${moved.rows[0]!.message})`);
  // Payment evidence: an event saved with different details is one conflict, not also the reference's.
  check(quick(state, "observations", "row_id,reference,customerId,amountKobo,source,eventId\no1,QUICK-EVIDENCE-2,DEMO-C1001,2500000,webhook,evt-2").imported === 1, "payment evidence is imported");
  const evidence = quick(state, "observations", "row_id,reference,customerId,amountKobo,source,eventId,currency\no2,QUICK-EVIDENCE-2,DEMO-C1001,2600000,webhook,evt-2,XYZ", { commit: false });
  check(evidence.rows[0]!.message.startsWith("This source event is already saved with different details.") && !/reference belongs/.test(evidence.rows[0]!.message), `the event conflict alone (${evidence.rows[0]!.message})`);
}

console.log(`Import row checks passed (${checks} checks): the quick import's required row IDs and durable recognition, screened as their column, row errors in the operator's words with every failing rule (the import's own conflicts included) and the raw detail, single messages for record forms, the shared labels, the header after blank lines, and the reference chosen as the row ID.`);
