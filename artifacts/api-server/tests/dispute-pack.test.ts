// AUD-02 and AUD-06: the dispute pack as a paginated PDF with a summary page and
// the timeline, plus CSV and JSON of the same data, with the governing versions
// as they applied at the time of each event.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { addNotice, addObservation, ctxAt, decodePdfText, liveFixture, wat } from "./helpers.js";
import { reconcile } from "../src/domain/reconciliation.js";
import { executeAction } from "../src/domain/actions.js";
import { makeRecord, recordsOf } from "../src/domain/records.js";
import { buildDisputePack, disputePackCsv, renderDisputePackPdf } from "../src/lib/valopay-packs.js";
import { buildExportBytes } from "../src/lib/valopay-exports.js";
import { positionFor } from "../src/domain/close.js";

let checks = 0;
const { state, due, customer, policy } = liveFixture({ merchantId: "dispute-pack" });
const failed = recordsOf(state, "attempts").find((item) => item.data.dueItemId === due.id)!;
failed.data.noticeId = addNotice(state, due, wat("2027-06-28T09:00:08")).id;
makeRecord(state, "templates", { name: "Failed-debit notice", status: "approved", data: { purpose: "failed_debit", version: 2, text: "{{merchant}}: {{amount}} on {{date}}; help {{contact}}", author: "Sandbox Admin", reviewer: "Sandbox Compliance reviewer", approvedAt: "2027-03-01T09:00:00.000Z" } });
reconcile(state, ctxAt(wat("2027-06-28T09:01:00"), "Finance"));
executeAction(state, ctxAt(wat("2027-06-28T09:30:00"), "Operations"), { action: "simulate_failure", recordId: due.id, reason: "second failure", data: { failureCode: "ACCOUNT_CLOSED" } });
reconcile(state, ctxAt(wat("2027-06-28T10:00:00"), "Finance"));
const ctx = ctxAt(wat("2027-07-01T08:00:00"), "Finance");

const started = Date.now();
const pack = buildDisputePack(state, ctx, customer.id);
const pdf = await renderDisputePackPdf(pack, { compress: false });
const elapsed = Date.now() - started;
assert.ok(elapsed < 60_000, `AUD-02: pack generated in ${elapsed} ms`);
checks += 1;

// ---- Content of the pack ----
assert.equal(pack.kind, "dispute-pack");
assert.equal(pack.customer.reference, customer.reference);
const kinds = new Set(pack.timeline.map((event) => event.kind));
for (const kind of ["customers", "mandates", "due-items", "attempts", "notifications", "retry-decisions", "exceptions"]) assert.ok(kinds.has(kind), `timeline carries ${kind}`);
assert.deepEqual(pack.timeline.map((event) => event.at), [...pack.timeline.map((event) => event.at)].sort(), "timeline is oldest first");
const decisionEvents = pack.timeline.filter((event) => event.kind === "retry-decisions");
assert.ok(decisionEvents.length >= 2, "both decisions are on the timeline");
assert.match(decisionEvents[0]!.detail, /Next attempt 2027-06-30 06:16:00 WAT/, "the planned time is spelled out");
assert.match(decisionEvents.at(-1)!.event, /give up/, "the give-up after ACCOUNT_CLOSED is on the timeline");
assert.match(decisionEvents.at(-1)!.detail, /‘Invalid or closed account’ cannot be retried/, "the raw code was normalised to the catalogue");
assert.equal(pack.summary.dueItems && (pack.summary as any).dueItems.unpaidFinal, 1);
assert.equal((pack.summary as any).exceptions.open, 1, "the unpaid-after-final-attempt exception is counted");
assert.equal((pack.summary as any).retryDecisions, decisionEvents.length);
assert.equal(pack.position.outstandingKobo, due.amountKobo);
assert.equal(pack.auditVerification.valid, true);
checks += 16;

// ---- AUD-06: versions as they applied at each event, not the current ones ----
const policyDocument = pack.documents.find((document) => document.kind === "policies")!;
assert.equal(policyDocument.version, 1);
assert.equal(policyDocument.appliesFrom, policy.data.approvedAt);
assert.match(policyDocument.text, /Up to 3 attempts/);
const templateDocument = pack.documents.find((document) => document.kind === "templates")!;
assert.equal(templateDocument.version, 2);
assert.match(templateDocument.text, /\{\{amount\}\}/);
assert.ok(pack.documents.some((document) => document.kind === "cutovers"), "the cutover contract is included");
const seededMandate = pack.timeline.find((event) => event.kind === "mandates")!;
assert.equal(seededMandate.policyVersion, null, "an event before the first approval has no governing version");
const attemptEvent = pack.timeline.find((event) => event.kind === "attempts")!;
assert.equal(attemptEvent.policyVersion, 1, "an event after approval carries the version that applied");
assert.equal(attemptEvent.templateVersion, 2);
checks += 9;

// ---- PDF: paginated, summary first, timeline, documents, page numbers ----
const body = pdf.toString("latin1");
const decoded = decodePdfText(pdf);
assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
const pages = Number(body.match(/\/Count (\d+)/)?.[1]);
assert.ok(pages >= 3, `summary, timeline and documents pages: ${pages}`);
for (const needle of ["Dispute pack", `Timeline: ${pack.timeline.length} events`, "Documents in effect at the time", `Page 1 of ${pages}`, `Page ${pages} of ${pages}`, "₦25,000.00", customer.name, "Retry policy v1", "Notice template v2"]) assert.ok(decoded.includes(needle), `PDF text contains "${needle}"`);
assert.ok(!/NGN [0-9]/.test(decoded), "naira amounts are printed with the naira sign, as the console shows them");
assert.match(body, /\/BaseFont \/[A-Z]{6}\+ValoPackSans-Regular/, "the pack embeds its own typeface rather than a WinAnsi standard font");
assert.match(body, /\/Lang \(en-GB\)/, "the document declares its language");
checks += 12;

// ---- CSV and JSON of the same data ----
const csv = disputePackCsv(pack);
const lines = csv.split("\r\n");
assert.equal(lines.length, pack.timeline.length + 1, "one CSV row per event");
assert.match(lines[0]!, /^environment,merchant,customer,customerReference,generatedAt,at,atWAT,kind,event,status,reference,amountKobo,currency,detail,actor,policyVersion/);
assert.ok(lines.every((line, index) => index === 0 || line.startsWith('"synthetic_sandbox"')), "every row names the environment");
const json = await buildExportBytes(state, ctx, { kind: "customer-pack", customerId: customer.id, format: "json" });
const parsed = JSON.parse(json.bytes.toString());
assert.equal(parsed.kind, "dispute-pack");
assert.equal(parsed.timeline.length, pack.timeline.length);
assert.equal(json.contentType, "application/json");
const asPdf = await buildExportBytes(state, ctx, { kind: "dispute-pack", customerId: customer.id, format: "pdf" });
assert.equal(asPdf.contentType, "application/pdf");
assert.equal(asPdf.pack?.timeline.length, pack.timeline.length);
const asCsv = await buildExportBytes(state, ctx, { kind: "customer-pack", customerId: customer.id, format: "csv" });
assert.equal(asCsv.bytes.toString(), `\uFEFF${csv}`, "the CSV download starts with the byte order mark spreadsheet programs need for accented letters");
assert.equal(createHash("sha256").update(asCsv.bytes).digest("hex").length, 64, "the checksum is SHA-256");
await assert.rejects(buildExportBytes(state, ctx, { kind: "customer-pack", customerId: "missing", format: "pdf" }), /Customer not found/);
checks += 11;

// ---- Second review finding 4: money in another currency is never added to a naira total, and every amount is printed in its own currency ----
{
  const { state: usd, customer: payer } = liveFixture({ withFailure: false, merchantId: "dispute-pack-currencies" });
  addObservation(usd, { reference: "CARD-USD-1", amountKobo: 100_000, source: "card", customerId: payer.id, eventId: "c1", occurredAt: wat("2027-07-01T07:00:00"), currency: "USD" } as any);
  addObservation(usd, { reference: "CARD-NGN-1", amountKobo: 700_000, source: "card", customerId: payer.id, eventId: "c2", occurredAt: wat("2027-07-01T07:00:00") });
  executeAction(usd, ctxAt(wat("2027-07-02T07:30:00"), "Finance"), { action: "daily_close" });
  const held = buildDisputePack(usd, ctxAt(wat("2027-07-02T09:00:00"), "Finance"), payer.id);
  const payments = recordsOf(usd, "payments").filter((item) => item.customerId === payer.id);
  const nairaKobo = payments.filter((item) => String(item.data.currency || "NGN") === "NGN").reduce((sum, item) => sum + item.amountKobo, 0);
  assert.deepEqual(held.summary.payments, { count: payments.length, kobo: nairaKobo, otherCurrencies: { USD: { count: 1, amount: 100_000 } }, reversed: 0 }, "the payments total counts every payment, sums naira only and lists the USD payment beside it");
  assert.deepEqual([held.position.unallocatedKobo, held.position.unallocatedOtherCurrencies], [positionFor(usd, payer.id).unallocatedKobo, { USD: { count: 1, amount: 100_000 } }], "the unallocated position is naira, with the USD money beside it");
  const currencyOfRow = (kind: string, reference: string) => held.timeline.find((event) => event.kind === kind && event.reference === reference)?.currency;
  assert.deepEqual([currencyOfRow("payments", "CARD-USD-1"), currencyOfRow("observations", "CARD-USD-1"), currencyOfRow("payments", "CARD-NGN-1"), currencyOfRow("observations", "CARD-NGN-1")], ["USD", "USD", "NGN", "NGN"], "the timeline carries each amount's currency");
  assert.equal(held.timeline.find((event) => event.kind === "exceptions" && /CARD-USD-1/.test(event.detail))?.currency, "USD", "and an exception about the USD payment is in USD too");
  assert.match(held.timeline.find((event) => event.kind === "payments" && event.reference === "CARD-USD-1")!.detail, /allocated USD 0\.00; Payment CARD-USD-1 is in USD[^]*resolve it with Finance\.$/, "its detail prints its money in USD, with one full stop");
  const text = decodePdfText(await renderDisputePackPdf(held, { compress: false }));
  const printed = text.split("\n");
  const after = (label: string) => printed.slice(printed.indexOf(label), printed.indexOf(label) + 2).join(" | ");
  assert.match(after("Payments"), new RegExp(`^Payments \\|\\s+${payments.length} totalling ₦[0-9,.]+ and USD 1,000\\.00 \\(0 reversed\\)$`), `the PDF sums naira and lists the dollars beside it (${after("Payments")})`);
  assert.match(after("Unallocated payments"), /^Unallocated payments \|\s+₦[0-9,.]+ and USD 1,000\.00 in another currency, held for Finance$/, `and so does the unallocated line (${after("Unallocated payments")})`);
  const usdRow = printed.indexOf("Payment CARD-USD-1 unallocated");
  assert.ok(usdRow > 0 && printed.slice(usdRow, usdRow + 15).includes("USD 1,000.00") && !text.includes("₦1,000.00"), "the USD payment's timeline row prints its amount in USD, never as naira");
  const csvRow = disputePackCsv(held).split("\r\n").find((line) => line.includes('"payments","Payment CARD-USD-1 unallocated"'));
  assert.match(String(csvRow), /"100000","USD",/, "and the CSV gives its currency beside the amount");
  checks += 9;
}

// ---- The gate pack freezes the uplift report with the pre-registered rule ----
const gate = await buildExportBytes(state, ctx, { kind: "gate-pack", format: "json" });
const gatePack = JSON.parse(gate.bytes.toString());
assert.ok(Array.isArray(gatePack.data.upliftReport.results), "MEA-02: the gate pack carries the uplift report");
assert.equal(gatePack.data.upliftReport.result, "not_proven");
checks += 2;

console.log(`Dispute pack tests passed (${checks} checks): timeline content, governing versions, paginated PDF, CSV and JSON parity, money in another currency beside naira totals, gate pack.`);
