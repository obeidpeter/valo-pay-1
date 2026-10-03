// Import mapping (23 September 2026 audit, item 11): a column the mapping does
// not use, while a record's name or reference falls back, is reported by the
// check instead of passing silently; and the console suggests a field for a
// recognisable column name.
import assert from "node:assert/strict";
import { importFieldsOf, suggestImportField } from "@workspace/valo-pay-1-schema";
import { seedMerchant } from "../src/lib/valo-pay-1-seed";
import { importCsv } from "../src/lib/valo-pay-1-import";
import { saveImportBatch, commitImportBatch } from "../src/domain/pilot-workflow";
import type { BatchInput } from "@workspace/valo-pay-1-schema";

const ctx = { actor: "Sandbox Admin", role: "Admin", now: "2026-09-23T10:00:00.000Z" };
let checks = 0;
const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks += 1; };
const empty = (id: string) => { const state = seedMerchant(id, true); state.records = []; return state; };
// The audit's file: the name is in full_name, which is not a field, so the customer was named after its reference.
const csv = "source_row_id,full_name,reference,consentProvenance\nrow-1,Named in an unmapped column,UNMAPPED-C1,Synthetic consent";
const batchInput = (mapping: Record<string, string> = {}, file = csv): BatchInput => ({ name: "Unmapped names", kind: "customers", source: "loan-system", sourceBatchId: `unmapped-${Object.keys(mapping).length}`, businessDate: "2026-09-23", identityColumn: "source_row_id", amountUnit: "naira", mapping, csv: file, syntheticOnly: true });
const nameWarning = "No column is mapped to Name, so each record’s name is taken from its reference (or its row number without one). Not mapped to a field: full_name, which looks like the name. Map the column that holds the name, or import anyway to save the fallback.";

{
  // The check says so, and so does the commit's; it is a warning, so the batch can still be committed.
  const state = empty("mapping-warning");
  const batch = saveImportBatch(state, ctx, batchInput());
  check(batch.status === "ready", "the rows themselves are valid");
  assert.deepEqual(batch.data.check.warnings, [nameWarning]); checks += 1;
  const committed = commitImportBatch(state, ctx, batch.id, batch.updatedAt);
  check(committed.status === "committed", "a warning does not refuse the commit");
  assert.deepEqual(committed.data.check.warnings, [nameWarning]); checks += 1;
  check(state.records.find(record => record.kind === "customers")!.name === "UNMAPPED-C1", "committed anyway, the customer is named after its reference");
}
{
  // Mapped as the console suggests, the check has no warning and the customer gets its name.
  const state = empty("mapping-suggested");
  const batch = saveImportBatch(state, ctx, batchInput({ full_name: "name" }));
  check(batch.data.check.warnings === undefined, "nothing to warn about");
  commitImportBatch(state, ctx, batch.id, batch.updatedAt);
  check(state.records.find(record => record.kind === "customers")!.name === "Named in an unmapped column", "the customer is named from full_name");
}
{
  // Skipping the column on purpose still warns: the name still comes from the fallback.
  const state = empty("mapping-skipped");
  const skipped = saveImportBatch(state, ctx, batchInput({ full_name: "" }));
  assert.deepEqual(skipped.data.check.warnings, [nameWarning]); checks += 1;
}
{
  // The record import's check (POST /v1/imports) reports it too, and every fallback it sees; its row ID column is not an unused column.
  const state = empty("mapping-records");
  const file = "row_id,full_name,consentProvenance,extra\nr1,First person,Synthetic consent,x\nr2,Second person,Synthetic consent,y";
  const result = importCsv(state, ctx, { kind: "customers", csv: file, syntheticOnly: true, commit: false, identityColumn: "row_id" });
  assert.deepEqual(result.warnings, [
    "No column is mapped to Name, so each record’s name is taken from its reference (or its row number without one). Not mapped to a field: full_name, which looks like the name; extra. Map the column that holds the name, or import anyway to save the fallback.",
    "No column is mapped to Reference, so each record gets a generated reference. Not mapped to a field: full_name; extra. Map the column that holds the reference, or import anyway to save the fallback.",
  ]); checks += 1;
  // A name column blank on one row names that row from its reference.
  const blank = importCsv(state, ctx, { kind: "customers", csv: "row_id,name,reference,consentProvenance,extra\nr1,Named,REF-1,Synthetic consent,x\nr2,,REF-2,Synthetic consent,y", syntheticOnly: true, commit: false, identityColumn: "row_id" });
  assert.deepEqual(blank.warnings, ["Name is blank on 1 row, so its name is taken from its reference (or its row number without one). Not mapped to a field: extra. Map the column that holds the name, or import anyway to save the fallback."]); checks += 1;
}
{
  // No warning without an unused column: a source with no names, or one whose every column is used, is taken as it is.
  const state = empty("mapping-quiet");
  check(importCsv(state, ctx, { kind: "customers", csv: "reference,consentProvenance\nREF-1,Synthetic consent", syntheticOnly: true, commit: false, identityColumn: "reference" }).warnings === undefined, "every column is used");
  check(saveImportBatch(state, ctx, batchInput({}, "source_row_id,reference,consentProvenance\nrow-1,REF-9,Synthetic consent")).data.check.warnings === undefined, "the row identity column is not an unused column");
  check(importCsv(state, ctx, { kind: "customers", csv: "row_id,name,reference,consentProvenance,extra\nr1,Named,REF-1,Synthetic consent,x", syntheticOnly: true, commit: false, identityColumn: "row_id" }).warnings === undefined, "an unused column warns only while a value falls back");
}
{
  // Suggestions: a column that folds to a field's name, and the common spellings of a name and of links.
  check(suggestImportField("customers", "full_name") === "name" && suggestImportField("customers", "Full Name") === "name" && suggestImportField("customers", "customer_name") === "name", "full_name and customer_name suggest the name");
  check(suggestImportField("due-items", "due_date") === "dueDate" && suggestImportField("due-items", "Customer ID") === "customerId" && suggestImportField("due-items", "customer_reference") === "customerId", "a folded field name, and a customer reference links an instalment to its customer");
  check(suggestImportField("customers", "customer_reference") === "reference", "in a customer file the customer reference is the record's own");
  check(suggestImportField("customers", "due_date") === undefined && suggestImportField("customers", "notes") === undefined && suggestImportField("customers", "customer_id") === undefined, "nothing for a column the kind has no field for");
  check(suggestImportField("observations", "batch_reference") === "batchReference" && suggestImportField("due-items", "amount") === "amountKobo", "data fields and the amount");
  check(importFieldsOf("customers").includes("consentProvenance") && !importFieldsOf("customers").includes("synthetic"), "a kind's fields come from its data schema");
}

console.log(`Import mapping checks passed (${checks} checks): unused columns with a fallback are reported by every check, suggestions for recognisable column names.`);
