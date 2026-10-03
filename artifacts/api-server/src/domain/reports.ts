import { sumMoney, multiplyDivideMoney, nairaText, numberText, PLAN_GROSS_MARGIN, VARIABLE_COST_PER_COLLECTION_KOBO, counted, deadlinePassed, experimentRules, isOpenException, measurementRules, paymentAppliedKobo, paymentAwaitsAllocation, type RecordKind } from "@workspace/valo-pay-1-schema";
import { recordsOf } from "./records";
import type { DomainState, Metric, Report, TypedRecord, ValopayRecord } from "./types";
import { allocationConfirmedAt, paymentObservedAt, paymentReversed } from "./reconciliation";
import { buildBillingStatement, monthOf, periodBounds, previousMonth } from "./billing";
import { seededSample, wilsonInterval } from "./stats";
import type { Alert } from "./alerts";
import { closeSchedule } from "./close";
import { watDate } from "./calendar";
export { billableCollection, reversalWindowDays } from "./billing";

const DAY_MS = 24 * 60 * 60 * 1000;
const metric = (key: string, label: string, value: number, unit: string, detail: string): Metric => ({ key, label, value, unit, detail });
const round = (value: number, places = 6) => Number(value.toFixed(places));

/** Queue counts and headline metrics for the console overview; dashboards beyond this are stage 2 (UI-01). */
export function buildOverview(state: DomainState, now: string, alerts: Alert[] = []) {
  const by = <K extends RecordKind>(kind: K) => recordsOf(state, kind);
  const settled = by("payments").filter((item) => item.data.settlementStatus === "settled" && item.status !== "possible_duplicate" && !paymentReversed(item));
  const outstanding = sumMoney(by("due-items").map((item) => Number(item.data.outstandingKobo ?? item.amountKobo)));
  const certainPayments = new Set(by("allocations").filter((item) => item.status === "confirmed" && item.data.confidence === "certain").map((item) => item.data.paymentId));
  const open = by("exceptions").filter((item) => isOpenException(item.status));
  const schedule = closeSchedule(state, now);
  return {
    metrics: [
      metric("settled", "Reconciled collections", sumMoney(settled.map(paymentAppliedKobo)), "kobo", "Settled payments matched to instalments, counted once. Sample data only."),
      metric("outstanding", "Outstanding amount", outstanding, "kobo", "Amount still owed on instalments. Valo Pay 1 never holds money."),
      metric("match_rate", "Certain match rate", settled.length ? Math.round((settled.filter((item) => certainPayments.has(item.id)).length / settled.length) * 100) : 0, "percent", "Share of settled payments with a confirmed, certain match. Sample data only."),
      metric("exceptions", "Open exceptions", open.length, "count", "Exceptions that still need someone to follow up."),
    ],
    queues: [
      metric("activation", "Awaiting activation", by("mandates").filter((item) => item.status === "pending_activation").length, "count", "Mandates waiting for activation through the provider."),
      metric("review", "Matches to review", by("allocations").filter((item) => item.status === "proposed").length, "count", "Proposed matches for the Finance team to confirm."),
      metric("duplicates", "Possible duplicates", by("payments").filter((item) => item.status === "possible_duplicate").length, "count", "Finance must review these before any payment is allocated."),
      metric("failures", "Failed collection attempts", by("attempts").filter((item) => item.status === "failed").length, "count", "Failed collection attempts reported by another collection system."),
      metric("overdue", "Overdue exceptions", open.filter((item) => deadlinePassed(item.data.dueBy, now)).length, "count", "Ask each owner to follow up on these overdue exceptions."),
    ],
    activity: by("audit").sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8),
    upcoming: by("due-items").filter((item) => !["paid", "closed", "cancelled"].includes(item.status)).sort((a, b) => String(a.data.dueDate || '').localeCompare(String(b.data.dueDate || '')) || a.id.localeCompare(b.id)).slice(0, 6),
    mode: state.merchant.mode, environment: "sandbox", lastClose: by("closes").at(-1)?.createdAt || "Not closed yet",
    // REC-01: the next scheduled close, empty when the automatic close is off.
    nextClose: schedule.enabled ? schedule.nextAt : "", closeTime: schedule.time,
    alerts,
  };
}

// ---------- RET-06: the uplift report ----------

interface ArmOutcome { due: TypedRecord<"due-items">; recoveredKobo: number; settledInFull: boolean }
export interface ArmStatistics {
  enrolled: number;
  mature: number;
  totalDueKobo: number;
  recoveredKobo: number;
  settledInFull: number;
  recoveryByValue: number;
  recoveryByCount: number;
  /** Linearised (ratio-estimator) variance of the value-weighted rate; null below two mature items. */
  varianceByValue: number | null;
  varianceByCount: number | null;
}

/**
 * 6.6: settlement of the due item by any channel within 30 days of the first
 * failure, by value (partials count) and by count. A payment counts while it
 * has applied money that stands, so a refund of its excess keeps the recovery.
 */
function outcomeWithinWindow(state: DomainState, due: TypedRecord<"due-items">): ArmOutcome {
  const start = Date.parse(String(due.data.firstFailureAt || due.createdAt)), end = start + experimentRules.outcomeWindowDays * DAY_MS;
  const payments = recordsOf(state, "payments");
  const recovered = recordsOf(state, "allocations").filter((a) => a.status === "confirmed" && a.data.dueItemId === due.id).reduce((total, allocation) => {
    const payment = payments.find((p) => p.id === allocation.data.paymentId);
    if (!payment || payment.data.settlementStatus !== "settled" || paymentAppliedKobo(payment) <= 0) return total;
    const settled = Date.parse(String(payment.data.settledAt || payment.data.observedAt || payment.createdAt));
    return settled >= start && settled <= end ? sumMoney([total, allocation.amountKobo]) : total;
  }, 0);
  const recoveredKobo = Math.min(due.amountKobo, recovered);
  return { due, recoveredKobo, settledInFull: recoveredKobo >= due.amountKobo };
}

export function armStatistics(state: DomainState, items: TypedRecord<"due-items">[], now: string): ArmStatistics {
  const matured = items.filter((due) => Date.parse(now) >= Date.parse(String(due.data.firstFailureAt || due.createdAt)) + experimentRules.outcomeWindowDays * DAY_MS);
  const outcomes = matured.map((due) => outcomeWithinWindow(state, due));
  const n = outcomes.length;
  const totalDueKobo = sumMoney(outcomes.map((item) => item.due.amountKobo));
  const recoveredKobo = sumMoney(outcomes.map((item) => item.recoveredKobo));
  const settledInFull = outcomes.filter((item) => item.settledInFull).length;
  const byValue = totalDueKobo ? recoveredKobo / totalDueKobo : 0;
  const byCount = n ? settledInFull / n : 0;
  let varianceByValue: number | null = null, varianceByCount: number | null = null;
  if (n > 1 && totalDueKobo > 0) {
    // Ratio estimator p = Σwᵢyᵢ / Σwᵢ with yᵢ the recovered share of due item i; Taylor-linearised variance.
    const meanWeight = totalDueKobo / n;
    const residuals = outcomes.map((item) => (item.due.amountKobo * (item.recoveredKobo / item.due.amountKobo - byValue)) / meanWeight);
    varianceByValue = residuals.reduce((sum, r) => sum + r * r, 0) / (n * (n - 1));
    varianceByCount = (byCount * (1 - byCount)) / n;
  }
  return { enrolled: items.length, mature: n, totalDueKobo, recoveredKobo, settledInFull, recoveryByValue: byValue, recoveryByCount: byCount, varianceByValue, varianceByCount };
}

function interval(difference: number, varianceA: number | null, varianceB: number | null): { low: number; high: number; standardError: number } | null {
  if (varianceA === null || varianceB === null) return null;
  const standardError = Math.sqrt(varianceA + varianceB);
  return { low: round(difference - experimentRules.zScore * standardError), high: round(difference + experimentRules.zScore * standardError), standardError: round(standardError) };
}

/** RET-06 and RET-11: the uplift report per lender with the pre-registered rule evaluated exactly as written. */
export function upliftReport(state: DomainState, experiment: TypedRecord<"experiments">, now: string) {
  const enrolled = recordsOf(state, "due-items").filter((due) => due.data.experimentId === experiment.id);
  const engine = armStatistics(state, enrolled.filter((due) => due.data.experimentArm === "engine"), now);
  const holdout = armStatistics(state, enrolled.filter((due) => due.data.experimentArm === "holdout"), now);
  const minimumPerArm = Number(experiment.data.minPerArm || 0);
  // RET-11: each arm meets its own pre-computed minimum; minPerArm is a floor for both.  With a comparison group
  // under half, the retry group's minimum is the larger one.
  const sample = experiment.data.sampleCalculation;
  const minimumByArm = { engine: Math.max(minimumPerArm, Number(sample?.engineMinimum || 0)), holdout: Math.max(minimumPerArm, Number(sample?.holdoutMinimum || 0)) };
  const differenceByValue = round(engine.recoveryByValue - holdout.recoveryByValue);
  const differenceByCount = round(engine.recoveryByCount - holdout.recoveryByCount);
  const confidenceInterval90 = interval(differenceByValue, engine.varianceByValue, holdout.varianceByValue);
  const confidenceInterval90ByCount = interval(differenceByCount, engine.varianceByCount, holdout.varianceByCount);
  const analysisDate = String(experiment.data.analysisDate || "");
  const checks = {
    effectAtLeastEightPoints: differenceByValue >= experimentRules.effectPoints,
    intervalExcludesZero: confidenceInterval90 !== null && confidenceInterval90.low > 0,
    sampleMet: minimumByArm.engine > 0 && minimumByArm.holdout > 0 && engine.mature >= minimumByArm.engine && holdout.mature >= minimumByArm.holdout,
    // A WAT date: reached at midnight West Africa Time.
    analysisDateReached: Boolean(analysisDate) && watDate(Date.parse(now)) >= analysisDate.slice(0, 10),
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  const result = failed.length ? "not_proven" : "proven";
  const reason = failed.length
    ? `Not proven: ${failed.map((name) => ({ effectAtLeastEightPoints: "the improvement in recovery by value is below 8 percentage points", intervalExcludesZero: "the 90% confidence interval does not show a positive improvement", sampleMet: "at least one group has too few instalments with a complete 30-day outcome", analysisDateReached: "the analysis date has not been reached" })[name]).join("; ")}.`
    : "This lender meets the registered success criteria. Each design partner must meet them before the recovery fee can be switched on.";
  return {
    experimentId: experiment.id, status: experiment.status, passRule: experiment.data.passRule ?? null, preregisteredAt: experiment.data.preregisteredAt ?? null,
    analysisDate: analysisDate || null, enrolmentClose: experiment.data.enrolmentClose ?? null, holdoutShare: Number(experiment.data.holdoutShare), seed: experiment.data.seed ?? null,
    outcomeWindowDays: experimentRules.outcomeWindowDays, minimumPerArm, minimumByArm,
    engine: { ...engine, recoveryByValue: round(engine.recoveryByValue), recoveryByCount: round(engine.recoveryByCount) },
    holdout: { ...holdout, recoveryByValue: round(holdout.recoveryByValue), recoveryByCount: round(holdout.recoveryByCount) },
    differenceByValue, differenceByCount, confidenceInterval90, confidenceInterval90ByCount, confidence: experimentRules.confidence,
    checks, result, reason,
    // Compatibility fields read by earlier console builds.
    enrolled: enrolled.length, engineRecoveryByValue: round(engine.recoveryByValue), holdoutRecoveryByValue: round(holdout.recoveryByValue), matureEngine: engine.mature, matureHoldout: holdout.mature,
    synthetic: true,
  };
}

/** MEA-01 time to close: days from a WAT month end to the first close with no unallocated Payment older than 24 hours. */
export function timeToClose(state: DomainState, now: string): { month: string; days: number | null; closeId: string | null; closedAt: string | null } | null {
  const closes = recordsOf(state, "closes").filter((close) => close.data.report).sort((a, b) => String(a.data.closedAt).localeCompare(String(b.data.closedAt)));
  if (!closes.length) return null;
  const month = previousMonth(now);
  const monthEnd = new Date(periodBounds(month).end); // midnight WAT on this month's 1st = end of last month
  const clean = closes.find((close) => String(close.data.closedAt) >= monthEnd.toISOString() && Number(close.data.report?.unallocated?.olderThan24Hours ?? 1) === 0);
  return { month, days: clean ? round((Date.parse(String(clean.data.closedAt)) - monthEnd.getTime()) / DAY_MS, 2) : null, closeId: clean?.id ?? null, closedAt: clean ? String(clean.data.closedAt) : null };
}

/**
 * REC-09: each month Finance reviews a seeded random sample of at least 200 of
 * the previous month's automatic "certain" allocations (or all of them if
 * fewer); the false-match rate is reported with its interval beside the
 * automatic match rate.  The audit month is the last completed WAT month.
 */
export function precisionAudit(state: DomainState, now: string) {
  const month = previousMonth(now);
  const population = recordsOf(state, "allocations").filter((item) => item.data.automatic === true && item.data.confidence === "certain" && ["confirmed", "superseded"].includes(item.status) && monthOf(allocationConfirmedAt(item)) === month);
  const sampleIds = seededSample(population.map((item) => item.id), `${state.merchant.id}:${month}`, measurementRules.precisionSampleSize);
  const sampled = new Set(sampleIds);
  const reviewed = population.filter((item) => sampled.has(item.id) && typeof item.data.reviewed === "boolean");
  const wrong = reviewed.filter((item) => item.data.reviewed === false).length;
  const falseMatchRate = reviewed.length ? wrong / reviewed.length : null;
  return {
    month, population: population.length, sampleSize: sampleIds.length, requiredSample: Math.min(measurementRules.precisionSampleSize, population.length),
    reviewed: reviewed.length, wrong, falseMatchRate, interval: wilsonInterval(wrong, reviewed.length, measurementRules.precisionZScore), confidence: measurementRules.precisionConfidence,
    complete: sampleIds.length > 0 && reviewed.length >= sampleIds.length, sampledAllocationIds: sampleIds, seed: `${state.merchant.id}:${month}`,
  };
}

/** A fortnightly review counts when a named reviewer confirmed all four jobs (MEA-05). */
function confirmingReviews(state: DomainState): TypedRecord<"reviews">[] {
  return recordsOf(state, "reviews").filter((item) => {
    const jobs = item.data.confirmedJobs;
    // Historical numeric reviews remain readable; new reviews name each distinct task.
    const confirmed = Array.isArray(jobs) ? ['mandates', 'retries', 'reconciliation', 'audit'].every(job => jobs.includes(job)) : Number(jobs) >= measurementRules.jobsToConfirm;
    return confirmed && Boolean(item.data.reviewer?.trim());
  }).sort((a, b) => String(a.data.reviewedAt || a.createdAt).localeCompare(String(b.data.reviewedAt || b.createdAt)));
}

/** MEA-05: the Test 5 report per lender, derived from closes, reviews, allocations, exceptions and packs; never from constants. */
export function test5Report(state: DomainState, now: string) {
  const nowMs = Date.parse(now);
  const closes = recordsOf(state, "closes").sort((a, b) => String(a.data.closedAt || a.createdAt).localeCompare(String(b.data.closedAt || b.createdAt)));
  const firstClose = closes[0] ? String(closes[0].data.closedAt || closes[0].createdAt) : null;
  const liveDays = firstClose ? Math.max(0, Math.floor((nowMs - Date.parse(firstClose)) / DAY_MS)) : 0;
  const reviews = confirmingReviews(state);
  const reviewAt = (item: TypedRecord<"reviews">) => Date.parse(String(item.data.reviewedAt || item.createdAt));
  const latest = reviews.at(-1);
  const fortnightMs = measurementRules.fortnightDays * DAY_MS;
  const fortnightlyStaffConfirmed = Boolean(latest) && nowMs - reviewAt(latest!) <= fortnightMs;
  // Cadence: from the first close, no gap longer than a fortnight between confirming reviews, and the last one is current.
  let cadenceMet = Boolean(firstClose) && fortnightlyStaffConfirmed;
  if (cadenceMet) {
    let previous = Date.parse(firstClose!);
    for (const review of reviews) { if (reviewAt(review) - previous > fortnightMs) { cadenceMet = false; break; } previous = reviewAt(review); }
  }
  const monthEnds = new Map<string, TypedRecord<"closes">>();
  for (const close of closes) monthEnds.set(monthOf(String(close.data.closedAt || close.createdAt)), close); // the last close of each WAT month wins
  const overdueShareAtMonthEnds = [...monthEnds.entries()].filter(([month]) => month < monthOf(now)).map(([month, close]) => {
    const open = Number(close.data.report?.exceptions?.openAtClose ?? NaN), overdue = Number(close.data.report?.exceptions?.overdueAtClose ?? NaN);
    return { month, closeId: close.id, open: Number.isFinite(open) ? open : null, overdue: Number.isFinite(overdue) ? overdue : null, share: Number.isFinite(open) && Number.isFinite(overdue) ? (open ? overdue / open : 0) : null };
  });
  const packs = recordsOf(state, "exports").filter((item) => item.status === "ready" && ["customer-pack", "dispute-pack", "gate-pack", "audit-pack"].includes(String(item.data.kind)));
  return {
    liveDays, requiredLiveDays: measurementRules.liveDaysRequired, liveSince: firstClose, liveDaysMet: liveDays >= measurementRules.liveDaysRequired,
    fortnightlyStaffConfirmed, latestReviewAt: latest ? new Date(reviewAt(latest)).toISOString() : null, latestReviewer: latest ? String(latest.data.reviewer) : null, confirmingReviews: reviews.length, reviewCadenceMet: cadenceMet,
    overdueShareAtMonthEnds,
    packsGenerated: packs.length, realCasesUsed: packs.filter((item) => item.data.usedInRealCase === true).length, requiredRealCases: measurementRules.realCasesRequired,
    proof: false, reason: "These measurements use sample data. The operational readiness test needs at least 60 days of real operations for each design partner.",
  };
}

/** MEA-03: unit economics per merchant for the billing period against the plan's NGN 15 per collection and 85–90% margin. */
export function unitEconomics(state: DomainState, now: string, statement: Record<string, any>) {
  const pricingReady = statement.pricingReady !== false;
  const period = String(statement.period);
  const collections = Number(statement.successfulCollections || 0);
  const licenceKobo = sumMoney(statement.lines.map((line: any) => Number(line.licenceKobo || 0)));
  const usageKobo = sumMoney(statement.lines.map((line: any) => Number(line.usageKobo || 0)));
  const recurringKobo = sumMoney([licenceKobo, usageKobo]);
  const recorded = recordsOf(state, "costs").filter((item) => String(item.data.period || "") === period);
  const byName = recorded.reduce<Record<string, number>>((acc, item) => { acc[item.name] = sumMoney([acc[item.name] || 0, item.amountKobo]); return acc; }, {});
  const recordedKobo = sumMoney(recorded.map((item) => item.amountKobo));
  const estimated = recorded.length === 0;
  const variableCostKobo = estimated ? multiplyDivideMoney(collections, VARIABLE_COST_PER_COLLECTION_KOBO, 1) : recordedKobo;
  const costPerCollectionKobo = collections ? Math.round(variableCostKobo / collections) : null;
  const grossMargin = recurringKobo > 0 ? Number(((recurringKobo - variableCostKobo) / recurringKobo).toFixed(4)) : null;
  return {
    period, successfulCollections: collections, pricingReady, usageFeeKobo: pricingReady ? usageKobo : null, licenceKobo: pricingReady ? licenceKobo : null, volumeTier: statement.volumeTier, recurringKobo: pricingReady ? recurringKobo : null,
    variableCostKobo, costsRecorded: byName, estimated, costPerCollectionKobo, planCostPerCollectionKobo: VARIABLE_COST_PER_COLLECTION_KOBO,
    grossMargin, planGrossMargin: PLAN_GROSS_MARGIN,
    annualisedRecurringRevenueKobo: pricingReady ? multiplyDivideMoney(recurringKobo, 12, 1) : null, implementationExcluded: true, recoveryFeeIncluded: false,
    checks: { costPerCollectionWithinPlan: costPerCollectionKobo === null ? null : costPerCollectionKobo <= VARIABLE_COST_PER_COLLECTION_KOBO, marginWithinPlan: grossMargin === null ? null : grossMargin >= PLAN_GROSS_MARGIN.low },
    note: !pricingReady ? `Revenue and margin are unavailable until the commercial terms can price this month. ${statement.pricingExplanation} Cost evidence is shown separately.` : estimated ? `No costs have been recorded for this period. The estimate uses ${nairaText(VARIABLE_COST_PER_COLLECTION_KOBO)} per collection until infrastructure, message and support costs are entered.` : "Based on the costs recorded for this period.",
    synthetic: true,
  };
}

export function buildReports(state: DomainState, now: string): Report {
  const payments = recordsOf(state, "payments");
  const allocations = recordsOf(state, "allocations");
  const dueItems = recordsOf(state, "due-items");
  const exceptions = recordsOf(state, "exceptions");
  const closeRecords = recordsOf(state, "closes");
  const allocated = payments.filter((item) => ["allocated", "partial", "overpaid"].includes(item.status));
  const allocationRate = payments.length ? allocated.length / payments.length : 0;
  const automaticCertain = allocations.filter((item) => item.status === "confirmed" && item.data.automatic === true && item.data.confidence === "certain");
  const reviewed = automaticCertain.filter((item) => typeof item.data.reviewed === "boolean");
  const reviewedAll = allocations.filter((item) => typeof item.data.reviewed === "boolean");
  const precision = reviewedAll.length ? reviewedAll.filter((item) => item.data.reviewed === true).length / reviewedAll.length : 0;
  // Money waiting for Finance, as the Finance queue, the alert and the daily close count it (paymentAwaitsAllocation).
  const unallocated = payments.filter(paymentAwaitsAllocation);
  const openExceptions = exceptions.filter((item) => isOpenException(item.status));
  const metrics: Metric[] = [
    metric("allocation_rate", "Allocation rate", allocationRate, "ratio", `${numberText(allocated.length)} of ${counted(payments.length, "payment")} ${allocated.length === 1 ? "is" : "are"} allocated in full or in part, including overpayments.`),
    metric("allocation_precision", "Accuracy of reviewed allocations", precision, "ratio", reviewedAll.length ? `${counted(reviewedAll.length, "allocation")} reviewed. Unreviewed allocations are excluded from this accuracy measure.` : "No payment matches have been reviewed yet."),
    metric("open_exceptions", "Open exceptions", openExceptions.length, "count", "Exceptions that still need someone to follow up."),
    metric("outstanding_kobo", "Outstanding amount", sumMoney(dueItems.map((item) => Number(item.data.outstandingKobo ?? item.amountKobo))), "kobo", "Amount still owed on instalments. Valo Pay 1 never holds money."),
  ];

  const billing = buildBillingStatement(state, now);

  const experiments = recordsOf(state, "experiments").filter((item) => item.status === "preregistered" || item.status === "closed");
  const experimentRows = experiments.map((experiment) => upliftReport(state, experiment, now));
  const closeTiming = timeToClose(state, now);
  const audit = precisionAudit(state, now);
  const test5 = test5Report(state, now);
  return {
    metrics,
    billing: { ...billing, unitEconomics: unitEconomics(state, now, billing) },
    experiment: {
      results: experimentRows, result: experimentRows.length && experimentRows.every((row) => row.result === "proven") ? "proven" : "not_proven",
      note: "Each design partner must meet the recovery test criteria before the recovery fee can be switched on. A result from one lender is not enough.", synthetic: true,
    },
    operational: {
      asOf: now,
      allocationRate, precision,
      certainAutomaticRate: payments.length ? new Set(automaticCertain.map((a) => a.data.paymentId)).size / payments.length : 0,
      reviewedCount: reviewedAll.length, reviewedAutomaticCount: reviewed.length, falseMatchRate: audit.falseMatchRate, falseMatchInterval: audit.interval, requiredAuditSample: audit.requiredSample, precisionAudit: audit,
      overdueExceptionRate: openExceptions.length ? openExceptions.filter((e) => deadlinePassed(e.data.dueBy, now)).length / openExceptions.length : 0,
      liveDays: test5.liveDays, requiredLiveDays: test5.requiredLiveDays, liveSince: test5.liveSince,
      packsGenerated: test5.packsGenerated, disputePacksGenerated: recordsOf(state, "exports").filter((item) => item.status === "ready" && ["customer-pack", "dispute-pack"].includes(String(item.data.kind))).length,
      realCasesUsed: test5.realCasesUsed, requiredRealCases: test5.requiredRealCases,
      fortnightlyStaffConfirmed: test5.fortnightlyStaffConfirmed, latestReviewAt: test5.latestReviewAt, reviewCadenceMet: test5.reviewCadenceMet, test5, timeToClose: closeTiming, monthEndCloseDays: closeTiming?.days ?? null,
      closeSchedule: closeSchedule(state, now),
      unallocatedOlderThan24Hours: unallocated.filter((item) => Date.parse(now) - paymentObservedAt(item) >= DAY_MS).length, proof: false, reason: "All measurements use sample data. They do not show how Valo Pay 1 performs in live use.",
    },
    closes: closeRecords,
  };
}
