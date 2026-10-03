// The market's letters and conventions: a search that ignores case and marks,
// counts with their nouns in the right number, money exact to the kobo, and
// exports that spell Yoruba and Igbo names as their bearers write them, in the
// PDF and in a spreadsheet.
import assert from "node:assert/strict";

// The store and export modules reach the database module, which insists on an address before anything here runs; nothing in this file touches a database.
process.env["DATABASE_URL"] ??= "postgres://postgres@127.0.0.1:1/valo-pay-1-unused";
const { counted, dayText, instantText, monthText, nairaText } = await import("@workspace/valo-pay-1-schema");
const { foldForSearch, pageRecords } = await import("../src/lib/valo-pay-1-list.js");
const { seedMerchant } = await import("../src/lib/valo-pay-1-seed.js");
const { buildDisputePack, packFonts, renderDisputePackPdf } = await import("../src/lib/valo-pay-1-packs.js");
const { buildExportBytes } = await import("../src/lib/valo-pay-1-exports.js");
const { importCsv } = await import("../src/lib/valo-pay-1-import.js");
const { ctxAt, decodePdfText } = await import("./helpers.js");

let checks = 0;
const state = seedMerchant("i18n-merchant", false);
const ctx = ctxAt("2027-07-01T08:00:00.000Z", "Finance");
const customers = state.records.filter((record) => record.kind === "customers");
const names = customers.map((record) => record.name);

// ---- Names carry their marks, and a search finds them however it is typed ----
for (const name of ["Chiamaka Ọbi", "Túndé Bakare", "Dami Adéyẹmí", "Ṣeyi Ajayi"]) assert.ok(names.includes(name), `seeded ${name}`);
assert.equal(foldForSearch("Ọkọnkwọ"), "okonkwo");
assert.equal(foldForSearch("ADÉYẸMÍ"), "adeyemi");
const found = (search: string) => pageRecords(customers, { search }).items.map((record) => record.name);
assert.deepEqual(found("obi"), ["Chiamaka Ọbi"], "unmarked letters find the marked name");
assert.deepEqual(found("ỌBI"), ["Chiamaka Ọbi"], "marked capitals find it too");
assert.deepEqual(found("adeyemi"), ["Dami Adéyẹmí"]);
assert.deepEqual(found("Adéyẹmí"), ["Dami Adéyẹmí"]);
assert.deepEqual(found("seyi"), ["Ṣeyi Ajayi"]);
assert.deepEqual(found("tunde"), ["Túndé Bakare"]);
assert.deepEqual(found("okonkwo"), ["Ada Okonkwo"], "a plain name still matches only itself");
checks += 13;

// ---- Counts read with their nouns ----
assert.equal(counted(1, "entry", "entries"), "1 entry");
assert.equal(counted(0, "item"), "0 items");
assert.equal(counted(2, "observation"), "2 observations");
assert.equal(counted(1234, "record"), "1,234 records");
checks += 4;

// ---- Money in messages is exact to the kobo, however large, and written as the console writes it ----
assert.equal(nairaText(2_500_000), "₦25,000.00");
assert.equal(nairaText(0), "₦0.00");
assert.equal(nairaText(-150), "-₦1.50");
assert.equal(nairaText(-5), "-₦0.05", "a credit under a naira keeps its sign");
assert.equal(nairaText(8_496_439_859_216_957), "₦84,964,398,592,169.57", "dividing by 100 as a float printed .56");
assert.equal(nairaText(Number.MAX_SAFE_INTEGER), "₦90,071,992,547,409.91");
assert.equal(nairaText(-Number.MAX_SAFE_INTEGER), "-₦90,071,992,547,409.91");
checks += 7;

// ---- Dates in messages read as the console writes them, in West Africa Time ----
assert.equal(dayText("2026-09-29"), "29 Sept 2026", "a day is shown as it is");
assert.equal(dayText("2026-06-29T23:30:00.000Z"), "30 Jun 2026", "an instant is the WAT day it falls on");
assert.equal(instantText("2026-09-29T13:05:00.000Z"), "29 Sept 2026, 14:05 WAT");
assert.equal(instantText("2026-09-29T07:00:00.000Z"), "29 Sept 2026, 08:00 WAT", "hours have two digits");
assert.equal(instantText("2026-09-29"), "29 Sept 2026", "a day has no invented time");
assert.equal(monthText("2026-09"), "September 2026");
assert.equal(dayText("2026-02-30"), "2026-02-30", "a day that does not exist is left as given");
assert.equal(instantText("not a date"), "not a date");
checks += 8;

// ---- A rule without words of its own is refused in Valo Pay 1's words, never zod's ----
{
  const { z } = await import("zod");
  const said = (schema: { safeParse: (value: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } } }, value: unknown) => schema.safeParse(value).error?.issues.map((issue) => issue.message);
  assert.deepEqual(said(z.object({ note: z.string().min(10) }), { note: "short" }), ["Enter at least 10 characters."]);
  assert.deepEqual(said(z.object({ note: z.string() }), {}), ["Enter a value."], "a missing value");
  assert.deepEqual(said(z.number().max(31), 40), ["Enter 31 or less."]);
  assert.deepEqual(said(z.number().int(), 1.5), ["Enter a whole number."]);
  assert.deepEqual(said(z.enum(["approve", "return"]), "maybe"), ["Choose Approve or Return."], "the choices by their labels");
  assert.deepEqual(said(z.object({ note: z.string() }).strict(), { note: "x", extra: 1 }), ["This request has details Valo Pay 1 does not use. Reload the page and try again."]);
  assert.deepEqual(said(z.string().min(3, "Enter the next step (at least 3 characters)."), "x"), ["Enter the next step (at least 3 characters)."], "a rule's own words win");
  checks += 7;
}

// ---- The PDF spells the names: its own typeface, not a WinAnsi standard font ----
const fonts = packFonts();
assert.ok(fonts.regular.length > 50_000 && fonts.bold.length > 50_000, "both weights of the typeface are shipped");
for (const name of ["Chiamaka Ọbi", "Dami Adéyẹmí", "Ṣeyi Ajayi"]) {
  const customer = customers.find((record) => record.name === name)!;
  const pdf = await renderDisputePackPdf(buildDisputePack(state, ctx, customer.id), { compress: false });
  const decoded = decodePdfText(pdf);
  assert.ok(decoded.includes(name), `the pack for ${name} prints the name as written`);
  assert.ok(!decoded.includes("?k") && !decoded.includes("�"), `no letter of ${name} is replaced`);
  assert.match(pdf.toString("latin1"), /\/BaseFont \/[A-Z]{6}\+ValoPackSans-(Regular|Bold)/);
}
checks += 10;

// ---- Spreadsheet exports: UTF-8 with the byte order mark, and the importer accepts one ----
const csv = await buildExportBytes(state, ctx, { kind: "customers", format: "csv" });
const csvText = csv.bytes.toString("utf8");
assert.ok(csvText.startsWith("﻿"), "the CSV starts with the byte order mark");
assert.ok(csvText.includes("Dami Adéyẹmí") && csvText.includes("Chiamaka Ọbi"), "the CSV carries the names unchanged");
assert.equal(csv.contentType, "text/csv; charset=utf-8");
const preview = importCsv(state, ctx, { kind: "customers", syntheticOnly: true, commit: false, identityColumn: "reference", csv: "﻿name,reference,consentProvenance,bankName,accountMasked,phoneMasked\r\nỌlá Adébáyọ̀,IMP-C001,Synthetic imported consent,Sandbox Bank,•••• 0001,+234 ••• ••01\r\n" });
assert.equal((preview as { valid: number }).valid, 1, "a file saved by a spreadsheet program, mark and all, is read");
checks += 4;

console.log(`Internationalisation tests passed (${checks} checks): accent-insensitive search, counts with nouns, money in messages exact to the kobo and dates in words, Valo Pay 1's words for rules without their own, the pack's own typeface spelling Yoruba and Igbo names, CSV byte order mark in and out.`);
