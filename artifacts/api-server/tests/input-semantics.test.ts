// What the API accepts and how it reads it (audit 23 September, API items 3,
// 5, 6 and 11), without a database: dates are real calendar dates, a
// date-only deadline lasts the whole West Africa Time day in the queues, the
// alerts and the overview alike, an incremental sync names an instant, a
// search reads values only, a name is never empty and indexed text is bounded.
// Also the payments waiting for Finance, counted alike in the alert, the
// reports and the daily close.
process.env.DATABASE_URL ||= "postgres://unused:unused@127.0.0.1:1/unused";
import assert from "node:assert/strict";
import { deadlineEnds, deadlinePassed, instantInputSchema, isoDateOrTimestamp, isoDay, isRealDate } from "@workspace/valo-pay-1-schema";
import { ctxAt, wat } from "./helpers.js";
import { seedMerchant } from "../src/lib/valo-pay-1-seed.js";
import { validateRecord } from "../src/domain/validation.js";
import { pageQueue } from "../src/lib/valo-pay-1-queues.js";
import { pageRecords } from "../src/lib/valo-pay-1-list.js";
import { buildAlerts } from "../src/domain/alerts.js";
import { buildOverview, buildReports } from "../src/domain/reports.js";
import { buildCloseReport, openingSnapshot } from "../src/domain/close.js";
import { makeRecord, recordsOf } from "../src/domain/records.js";

let checks = 0;
const eq = (actual: unknown, expected: unknown, message: string) => { assert.deepEqual(actual, expected, message); checks++; };
const refused = (run: () => unknown, pattern: RegExp, message: string) => { assert.throws(run, pattern, message); checks++; };

// ---- 1. A date is a real calendar date, as written (API item 6) ----
{
  for (const value of ["2026-02-30", "2026-04-31", "2027-02-29", "2026-13-01", "0000-01-01", "2026-02-30T07:00:00Z", "2026-02-28T24:00:00Z"]) eq(isoDateOrTimestamp.safeParse(value).success, false, `${value} rolls over or does not exist, and is refused`);
  for (const value of ["2028-02-29", "2026-09-23", "2026-09-23T07:00:00Z", "2026-09-23T07:00:00.5Z", "2026-12-31T23:59:59.999Z"]) eq(isoDateOrTimestamp.safeParse(value).success, true, `${value} is accepted`);
  eq([isoDay.safeParse("2026-02-30").success, isoDay.safeParse("2026-02-28").success], [false, true], "a day is checked the same way");
  eq([isRealDate("2026-02-29"), isRealDate("2024-02-29"), isRealDate("2026-09-23T07:00:00+01:00")], [false, true, false], "only a day or a UTC timestamp is a date here, and only a real one");
  const state = seedMerchant("input-dates"), ctx = ctxAt(wat("2026-09-23T12:53:00"), "Admin");
  const customer = recordsOf(state, "customers")[0]!, mandate = recordsOf(state, "mandates").find((item) => item.customerId === customer.id)!;
  refused(() => validateRecord(state, ctx, "due-items", { name: "Impossible instalment", status: "scheduled", customerId: customer.id, amountKobo: 1_500_000, data: { dueDate: "2026-02-30", owner: "lms", mandateId: mandate.id } }), /Due date: Enter a real date as YYYY-MM-DD/, "an instalment due on 30 February is refused, not moved to 2 March");
  refused(() => validateRecord(state, ctx, "mandates", { name: "Impossible activation", status: "pending_activation", customerId: customer.id, amountKobo: 5_000_000, data: { workflow: "hosted_consent", consentEvidence: "Synthetic consent", activationDeadline: "2026-02-31" } }), /Activation deadline: Enter a real date as YYYY-MM-DD/, "an activation deadline of 31 February is refused");
  refused(() => validateRecord(state, ctx, "exceptions", { name: "Impossible deadline", status: "open", data: { type: "unallocated_payment", severity: "low", dueBy: "2026-02-30" } }), /Due by: Enter a real date\.$/, "an exception due on 30 February is refused");
}

// ---- 2. A date-only deadline lasts the whole WAT day, everywhere (API item 5) ----
{
  eq(deadlineEnds("2026-09-23"), Date.parse("2026-09-23T22:59:59.999Z"), "a date-only deadline ends at 23:59:59.999 West Africa Time");
  eq([deadlinePassed("2026-09-23", "2026-09-23T22:59:59.999Z"), deadlinePassed("2026-09-23", "2026-09-23T23:00:00.000Z")], [false, true], "it passes when the WAT day is over");
  eq([deadlinePassed("2026-09-23T10:00:00.000Z", "2026-09-23T10:00:00.000Z"), deadlinePassed("2026-09-23T10:00:00.000Z", Date.parse("2026-09-23T10:00:00.001Z"))], [false, true], "a timestamp passes at its instant");
  eq([deadlinePassed("2026-02-30", "2027-01-01T00:00:00Z"), deadlinePassed("not a date", "2027-01-01T00:00:00Z"), deadlinePassed(undefined, "2027-01-01T00:00:00Z")], [false, false, false], "an impossible or missing date is no deadline, as the SQL queues read it");
  const now = wat("2026-09-23T12:53:00"), state = seedMerchant("input-deadlines");
  for (const record of recordsOf(state, "exceptions")) record.data.dueBy = "2028-01-01T00:00:00.000Z";
  for (const record of recordsOf(state, "mandates")) record.data.activationDeadline = "2028-01-01T00:00:00.000Z";
  const customer = recordsOf(state, "customers")[0]!;
  const exception = (dueBy: string) => makeRecord(state, "exceptions", { name: `Due ${dueBy}`, status: "open", customerId: customer.id, data: { type: "unallocated_payment", severity: "low", owner: "Finance", dueBy } });
  const today = exception("2026-09-23"), yesterday = exception("2026-09-22"), tomorrow = exception("2026-09-24");
  const mandate = makeRecord(state, "mandates", { name: "Activation due today", status: "pending_activation", customerId: customer.id, amountKobo: 5_000_000, data: { workflow: "hosted_consent", consentEvidence: "Synthetic consent", activationDeadline: "2026-09-23" } });
  const ids = (queue: "exceptions" | "mandates", view: string) => pageQueue(state.records, queue, { view, limit: 100 }, now).items.map((item) => item.id);
  eq([ids("exceptions", "overdue").includes(today.id), ids("exceptions", "due-today").includes(today.id)], [false, true], "an exception due today is due today, not overdue, in the reference queue");
  eq([ids("exceptions", "overdue").includes(yesterday.id), ids("exceptions", "overdue").includes(tomorrow.id)], [true, false], "yesterday's is overdue and tomorrow's is not");
  eq([ids("mandates", "overdue").includes(mandate.id), ids("mandates", "due-today").includes(mandate.id)], [false, true], "an activation due today is due today, not overdue");
  eq(ids("exceptions", "open").indexOf(today.id) < ids("exceptions", "open").indexOf(tomorrow.id), true, "a date-only deadline sorts by the end of its day");
  const alert = buildAlerts(state, now).find((item) => item.key === "exceptions_overdue");
  eq(alert?.count, 1, "the overdue alert counts only yesterday's exception");
  eq(buildOverview(state, now).queues.find((item) => item.key === "overdue")?.value, 1, "the overview's overdue count agrees");
  eq(buildAlerts(state, wat("2026-09-24T00:00:00")).find((item) => item.key === "exceptions_overdue")?.count, 2, "at midnight WAT today's exception is overdue too");
}

// ---- 3. An incremental sync names an instant with its offset (API item 6) ----
{
  const records = recordsOf(seedMerchant("input-sync"), "customers");
  for (const value of ["1", "2026-09-23", "2026-09-23T10:00:00", "+275760-09-13T00:00:00.000Z", "0000-01-01T00:00:00Z", "2026-02-30T10:00:00Z"]) {
    refused(() => pageRecords(records, { updatedSince: value }), /updatedSince must be an RFC 3339 date and time with Z or an offset/, `updatedSince ${value} is refused`);
  }
  eq(instantInputSchema.safeParse("0000-01-01T00:00:00Z").success, false, "a date and time is at least the year 0001, as PostgreSQL stores it");
  const later = new Date(Date.parse(records[0]!.updatedAt) + 1).toISOString().replace("Z", "+00:00");
  eq(pageRecords(records, { updatedSince: later }).total, records.filter((record) => Date.parse(record.updatedAt) > Date.parse(records[0]!.updatedAt)).length, "an offset is read as the instant it names");
}

// ---- 4. A search reads names, references and data values, never keys or JSON's syntax (API item 11, decision 9) ----
{
  const state = seedMerchant("input-search"), ctx = ctxAt(wat("2026-09-23T12:53:00"), "Admin");
  const customers = () => recordsOf(state, "customers");
  const quoted = makeRecord(state, "customers", { name: "Àdé Quoted", reference: "FOLD-1", data: { consentProvenance: "Synthetic fixture", note: 'He said "hi"', visits: [{ city: "Ìbàdàn", count: 3 }] } });
  const found = (search: string) => pageRecords(customers(), { search }).items.map((record) => record.id);
  eq(found('said "hi"'), [quoted.id], "a value holding a double quote is found as written");
  eq(found("ibadan"), [quoted.id], "a nested value is searched, ignoring case and accents");
  eq(found("ade quoted"), [quoted.id], "the name is searched");
  // Every record's data holds synthetic: true, and every customer's a consentProvenance key: they used to match every record.
  const plain = makeRecord(state, "customers", { name: "Plain Name", reference: "PLAIN-1", data: { consentProvenance: "Signed form" } });
  eq([found("true").length, found("consentProvenance").length, found("null").length, found("synthetic").includes(plain.id)], [0, 0, 0, false], "true, a key name and JSON's own words match no record, and synthetic only a record whose values say it");
  eq(found('"note"'), [], "JSON's quotes around a key are not searched");
  eq(found("Synthetic fixture").includes(quoted.id), true, "a data value is searched");
  // A name is never empty (the record API used to save "" as the kind's name).
  refused(() => validateRecord(state, ctx, "customers", { name: "   ", data: { consentProvenance: "Synthetic fixture" } }), /^Error: Enter a name for this record\.$/, "a blank name is refused");
  // Indexed text is bounded, refused naming its field, before PostgreSQL's index could fail on it (API item 3).
  const long = "x".repeat(201);
  refused(() => validateRecord(state, ctx, "customers", { name: "Long reference", reference: long, data: { consentProvenance: "Synthetic fixture" } }), /^Error: Loan software reference: Use at most 200 characters\.$/, "an over-long reference is refused");
  refused(() => validateRecord(state, ctx, "costs", { name: "Long status", status: "s".repeat(101), data: {} }), /^Error: Status: Use at most 100 characters\.$/, "an over-long free-form status is refused");
  refused(() => validateRecord(state, ctx, "exceptions", { name: "Long customer", customerId: "c".repeat(101), data: { type: "unallocated_payment", severity: "low" } }), /^Error: Customer reference or ID: Use at most 100 characters\.$/, "an over-long customerId is refused");
  refused(() => validateRecord(state, ctx, "observations", { name: "Long event", reference: "OBS-1", customerId: customers()[0]!.id, amountKobo: 150000, data: { source: "webhook", eventId: "e".repeat(201) } }), /Event ID: Use at most 200 characters/, "an over-long event ID is refused");
}

// ---- 5. Money waiting for Finance counts the same in the alert, the reports and the close (paymentAwaitsAllocation) ----
{
  const state = seedMerchant("input-awaiting"), now = wat("2026-09-23T12:53:00"), observedAt = new Date(Date.parse(now) - 2 * 24 * 60 * 60 * 1000).toISOString();
  const customer = recordsOf(state, "customers")[0]!;
  const aged = () => buildReports(state, now).operational.unallocatedOlderThan24Hours;
  const before = aged();
  const pay = (reference: string, status: string, data: Record<string, unknown>) => makeRecord(state, "payments", { name: `Payment ${reference}`, reference, status, customerId: customer.id, amountKobo: 5_000_000, data: { observedAt, ...data } });
  pay("AWAIT-PARTIAL", "partial", { allocatedKobo: 1_000_000 });
  pay("AWAIT-OVERPAID", "overpaid", { allocatedKobo: 4_000_000 });
  pay("AWAIT-APPLIED", "allocated", { allocatedKobo: 5_000_000 });
  pay("AWAIT-REFUNDED", "partial", { allocatedKobo: 1_000_000, refundStatus: "refunded", refundedKobo: 4_000_000 });
  eq(aged() - before, 2, "the unapplied rest of a partial and of an overpaid payment waits, as in Finance's queue; one fully applied, or whose rest was refunded, does not");
  eq(buildCloseReport(state, ctxAt(now, "Finance"), openingSnapshot(state), {}).unallocated.olderThan24Hours, aged(), "the reports count what the daily close counts");
  state.settings.unallocatedAlertThreshold = before + 1;
  const alert = buildAlerts(state, now).find((item) => item.key === "unallocated_over_threshold");
  eq(alert?.count, before + 2, "the alert counts the same payments, so the rests take it over the lender's limit");
  eq(/allocated in part/.test(String(alert?.detail)), true, "and says a payment applied in part is waiting too");
}

console.log(`Input semantics checks passed (${checks}): dates are real calendar dates, a date-only deadline lasts its whole WAT day in the queues, the alerts and the overview, an incremental sync names an instant with its offset, a search reads values only, a name is never empty, indexed text is bounded and money waiting for Finance counts the same in the alert, the reports and the close.`);
