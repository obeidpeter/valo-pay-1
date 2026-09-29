// Golden tests for the Test 5 report (MEA-05), the REC-09 precision sample with
// its interval, and MEA-03 unit economics, against TRD v1.1 sections 5.8 and 5.14.
import assert from "node:assert/strict";
import { DAY, ctxAt, wat } from "./helpers.js";
import { executeAction } from "../src/domain/actions.js";
import { buildOverview, buildReports, precisionAudit, test5Report, unitEconomics } from "../src/domain/reports.js";
import { seededSample, wilsonInterval } from "../src/domain/stats.js";
import { makeRecord, recordsOf } from "../src/domain/records.js";
import { seedMerchant } from "../src/lib/valopay-seed.js";

let checks = 0;
const finance = (now: string) => ctxAt(now, "Finance");

// Overview links must describe the records in their destination queue.
{
  const state = seedMerchant("overview-queues");
  const now = wat("2027-07-20T09:00:00");
  makeRecord(state, "allocations", { name: "Second proposed match", status: "proposed", amountKobo: 1000, data: { paymentId: "same-payment", dueItemId: "next-instalment" } });
  const earliest = makeRecord(state, "due-items", { name: "Earliest deadline added last", status: "scheduled", amountKobo: 1000, data: { dueDate: "2020-01-01" } });
  const overview = buildOverview(state, now);
  assert.equal(overview.queues.find(item => item.key === "review")?.value, recordsOf(state, "allocations").filter(item => item.status === "proposed").length);
  assert.equal(overview.upcoming[0]?.id, earliest.id, "sort all deadlines before limiting the dashboard list");
  assert.equal(buildReports(state, now).operational.asOf, now);
  checks += 3;
}

// ---------- Statistics helpers ----------
{
  const zero = wilsonInterval(0, 10, 1.959963984540054)!;
  assert.equal(zero.low, 0); assert.ok(Math.abs(zero.high - 0.2775) < 1e-3, `0 of 10 upper bound ${zero.high}`);
  const one = wilsonInterval(1, 20, 1.959963984540054)!;
  assert.ok(Math.abs(one.low - 0.0089) < 1e-3 && Math.abs(one.high - 0.2360) < 1e-3, `1 of 20: ${JSON.stringify(one)}`);
  assert.equal(wilsonInterval(0, 0, 1.96), null, "no trials, no interval");
  const ids = Array.from({ length: 300 }, (_, i) => `a${i}`);
  const sample = seededSample(ids, "seed", 200);
  assert.equal(sample.length, 200);
  assert.deepEqual(seededSample(ids, "seed", 200), sample, "the same seed gives the same sample");
  assert.notDeepEqual(seededSample(ids, "other", 200), sample, "a different seed gives a different sample");
  assert.equal(seededSample(ids.slice(0, 50), "seed", 200).length, 50, "all of them when fewer than the sample size");
  checks += 8;
}

// ---------- REC-09: the monthly seeded sample of 200 and the false-match rate with its interval ----------
{
  const state = seedMerchant("precision");
  const customer = recordsOf(state, "customers")[0]!;
  const now = wat("2027-07-20T09:00:00"); // July reviews June's matching
  for (let i = 0; i < 250; i++) {
    makeRecord(state, "allocations", { name: `auto ${i}`, status: "confirmed", customerId: customer.id, amountKobo: 1_000_000, createdAt: wat(`2027-06-${String(1 + (i % 19)).padStart(2, "0")}T08:00:00`), data: { paymentId: `p${i}`, dueItemId: `d${i}`, rule: "R1", confidence: "certain", automatic: true, reviewed: null } });
  }
  makeRecord(state, "allocations", { name: "last month", status: "confirmed", customerId: customer.id, amountKobo: 1_000_000, createdAt: wat("2027-05-20T08:00:00"), data: { paymentId: "old", dueItemId: "old", rule: "R1", confidence: "certain", automatic: true } });
  const before = precisionAudit(state, now);
  assert.equal(before.month, "2027-06");
  assert.equal(before.population, 250, "only the completed month's automatic certain allocations");
  assert.equal(before.sampleSize, 200); assert.equal(before.requiredSample, 200);
  assert.equal(before.reviewed, 0); assert.equal(before.falseMatchRate, null); assert.equal(before.interval, null); assert.equal(before.complete, false);
  assert.deepEqual(precisionAudit(state, wat("2027-07-25T09:00:00")).sampledAllocationIds, before.sampledAllocationIds, "the sample is stable within the month");
  const allocations = recordsOf(state, "allocations");
  before.sampledAllocationIds.slice(0, 10).forEach((id, index) => { allocations.find((item) => item.id === id)!.data.reviewed = index < 2 ? false : true; });
  allocations.find((item) => item.data.paymentId === "old")!.data.reviewed = false; // outside the month: not in the rate
  const after = precisionAudit(state, now);
  assert.equal(after.reviewed, 10); assert.equal(after.wrong, 2); assert.equal(after.falseMatchRate, 0.2);
  assert.deepEqual(after.interval, wilsonInterval(2, 10, 1.959963984540054), "95% Wilson interval beside the rate");
  assert.equal(after.complete, false, "190 of the sample are still unreviewed");
  const reports = buildReports(state, now);
  assert.equal(reports.operational.falseMatchRate, 0.2);
  assert.equal(reports.operational.requiredAuditSample, 200);
  assert.equal(reports.operational.precisionAudit.sampleSize, 200);
  checks += 15;
}

// ---------- MEA-05: live days, the fortnightly confirmation and the overdue share at month ends come from records ----------
{
  const state = seedMerchant("test5");
  const empty = test5Report(state, wat("2027-06-01T09:00:00"));
  assert.equal(empty.liveDays, 0); assert.equal(empty.liveSince, null); assert.equal(empty.fortnightlyStaffConfirmed, false); assert.equal(empty.reviewCadenceMet, false);
  checks += 4;
  executeAction(state, finance(wat("2027-04-30T07:00:00")), { action: "daily_close" });
  executeAction(state, finance(wat("2027-05-31T07:00:00")), { action: "daily_close" });
  executeAction(state, finance(wat("2027-06-10T07:00:00")), { action: "daily_close" });
  const now = wat("2027-07-09T09:00:00");
  const noReviews = test5Report(state, now);
  assert.equal(noReviews.liveDays, 70, "live days count from the first close");
  assert.equal(noReviews.liveDaysMet, true);
  assert.equal(noReviews.fortnightlyStaffConfirmed, false);
  assert.equal(noReviews.overdueShareAtMonthEnds.length, 3, "one row per completed month with a close; July is still open");
  assert.deepEqual(noReviews.overdueShareAtMonthEnds.map((row: any) => row.month), ["2027-04", "2027-05", "2027-06"]);
  assert.ok(noReviews.overdueShareAtMonthEnds.every((row: any) => typeof row.share === "number"), "share of open exceptions past their deadline at each month end");
  checks += 6;
  const review = (at: string, jobs: number | string[], reviewer = "Named lender user") => makeRecord(state, "reviews", { name: "Fortnightly review", status: "recorded", data: { reviewer, confirmedJobs: jobs, reviewedAt: at, note: "moved off spreadsheets" } });
  review(wat("2027-05-10T10:00:00"), 4); review(wat("2027-05-24T10:00:00"), 4); review(wat("2027-06-07T10:00:00"), ["mandates", "retries", "reconciliation", "audit"]); review(wat("2027-06-21T10:00:00"), 4); review(wat("2027-07-05T10:00:00"), 4);
  const confirmed = test5Report(state, now);
  assert.equal(confirmed.fortnightlyStaffConfirmed, true, "a confirming review within the last fortnight");
  assert.equal(confirmed.confirmingReviews, 5);
  assert.equal(confirmed.latestReviewer, "Named lender user");
  assert.equal(confirmed.reviewCadenceMet, true, "no gap longer than a fortnight since the first close");
  review(wat("2027-07-08T10:00:00"), 3); // three jobs is not a confirmation
  review(wat("2027-07-08T11:00:00"), 4, ""); // no named reviewer is not a confirmation
  review(wat("2027-07-08T12:00:00"), ['mandates', 'mandates', 'mandates', 'mandates']);
  review(wat("2027-07-08T12:30:00"), ['a', 'b', 'c', 'd']);
  review(wat("2027-07-08T13:00:00"), ['mandates', 'retries', 'reconciliation', 'audit'], '   ');
  assert.equal(test5Report(state, now).confirmingReviews, 5);
  assert.equal(test5Report(state, wat("2027-07-25T09:00:00")).fortnightlyStaffConfirmed, false, "a confirmation older than a fortnight lapses");
  assert.equal(buildReports(state, now).operational.liveDays, 70);
  checks += 7;
}
{
  // Month ends are West Africa Time: a close at 00:30 WAT on 1 August (23:30 UTC on 31 July) is August's, not July's.
  const state = seedMerchant("test5-wat");
  const close = (at: string, openAtClose: number, overdueAtClose: number) => makeRecord(state, "closes" as string, { name: "Daily close", status: "completed", createdAt: at, data: { closedAt: at, report: { exceptions: { openAtClose, overdueAtClose } } } });
  const julyLast = close(wat("2027-07-31T23:30:00"), 4, 1);
  const augustFirst = close(wat("2027-08-01T00:30:00"), 5, 5);
  // 00:30 WAT on 1 September is still 31 August in UTC, yet August has ended.
  const rows = test5Report(state, wat("2027-09-01T00:30:00")).overdueShareAtMonthEnds;
  assert.deepEqual(rows.map((row: any) => [row.month, row.closeId, row.share]), [["2027-07", julyLast.id, 0.25], ["2027-08", augustFirst.id, 1]], "July ends with its 23:30 WAT close; the 00:30 WAT close on the 1st counts toward August");
  assert.deepEqual(test5Report(state, wat("2027-08-31T23:30:00")).overdueShareAtMonthEnds.map((row: any) => row.month), ["2027-07"], "August is still open until 00:00 WAT on 1 September");
  checks += 2;
}

// ---------- MEA-03: unit economics against the plan ----------
{
  const state = seedMerchant("economics");
  const terms = recordsOf(state, "commercial")[0]!;
  terms.data.signed = true; terms.data.effectiveDate = "2027-01-01";
  terms.data.signedFullPriceTerms = true;
  terms.data.discountStartDate = '2027-01-01'; terms.data.fullPriceStartDate = '2028-01-01'; terms.data.discountTermsReference = 'synthetic-economics-agreement';
  terms.data.discountReview = { reviewedBy: 'Synthetic Finance', reviewedAt: '2026-12-01T09:00:00.000Z', discountStartDate: terms.data.discountStartDate, fullPriceStartDate: terms.data.fullPriceStartDate, termsReference: terms.data.discountTermsReference };
  for (const payment of recordsOf(state, "payments")) payment.data.channel = "transfer";
  const customer = recordsOf(state, "customers")[0]!;
  for (let i = 0; i < 3; i++) {
    makeRecord(state, "payments", { name: `c${i}`, status: "allocated", customerId: customer.id, amountKobo: 2_500_000, reference: `C-${i}`, data: { channel: "direct_debit", collectionStatus: "succeeded", settlementStatus: "settled", observedAt: wat("2027-06-05T06:20:00"), settledAt: wat("2027-06-05T06:20:00"), reversalStatus: "none", refundStatus: "none", allocatedKobo: 2_500_000 } });
  }
  state.settings.billingPeriod = "2027-06";
  const now = wat("2027-07-01T09:00:00");
  const statement = buildReports(state, now).billing;
  const economics = statement.unitEconomics;
  assert.equal(economics.successfulCollections, 3);
  assert.equal(economics.usageFeeKobo, Math.floor(3 * 7_500 * 0.5), "design-partner usage in 2027");
  assert.equal(economics.licenceKobo, 30_000_000);
  assert.equal(economics.recurringKobo, 30_000_000 + 11_250);
  assert.equal(economics.estimated, true, "no cost lines: the plan's NGN 15 per collection is assumed");
  assert.equal(economics.variableCostKobo, 4_500);
  assert.equal(economics.costPerCollectionKobo, 1_500);
  assert.equal(economics.annualisedRecurringRevenueKobo, (30_000_000 + 11_250) * 12);
  assert.equal(economics.checks.costPerCollectionWithinPlan, true);
  assert.equal(economics.checks.marginWithinPlan, true);
  makeRecord(state, "costs", { name: "infrastructure", status: "recorded", amountKobo: 3_000, data: { period: "2027-06" } });
  makeRecord(state, "costs", { name: "notifications", status: "recorded", amountKobo: 6_000, data: { period: "2027-06" } });
  makeRecord(state, "costs", { name: "support", status: "recorded", amountKobo: 5_000_000, data: { period: "2027-06" } });
  const recorded = unitEconomics(state, now, buildReports(state, now).billing);
  assert.equal(recorded.estimated, false);
  assert.equal(recorded.variableCostKobo, 5_009_000);
  assert.deepEqual(recorded.costsRecorded, { infrastructure: 3_000, notifications: 6_000, support: 5_000_000 });
  assert.equal(recorded.checks.costPerCollectionWithinPlan, false, "NGN 16,696 per collection is far above the plan");
  assert.equal(recorded.grossMargin, Number(((30_011_250 - 5_009_000) / 30_011_250).toFixed(4)));
  assert.equal(recorded.checks.marginWithinPlan, false);
  checks += 16;
}

void DAY;
console.log(`Test 5 golden tests passed (${checks} checks): Wilson interval, seeded sample, precision audit, live days, fortnightly confirmation, month-end overdue share, unit economics.`);
