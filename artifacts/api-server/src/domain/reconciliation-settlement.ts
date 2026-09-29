/** Settlement line counting, currency separation, statement matching and batch variance evaluation. */
import { type DomainState, type Context, type TypedRecord, type ValopayRecord } from "./types";
import { identityHeld, currencyOf, connectionOf, namedConnection, connectionKey } from "./reconciliation-values";
import { recordsWhere, recordsOfKind } from "./record-index";
import { lineSchedule, lineTotals, countLine, type PaymentOf, madeItsPayment, totalsFromLines, lineAdded, feesChecked, takeLineCurrency, settlementIdentity, batchIdentity } from "./reconciliation-settlement-totals";
import { isKobo, providerFeeKobo, sumMoney, isOpenException, resolveExceptionType, counted, moneyText, conditionClearedCode, providerIdentityConfirmedCode, providerIdentityCondition, hasFeeSchedule, SETTLEMENT_BATCH_TOLERANCE_KOBO, otherCurrenciesText } from "@workspace/valopay-schema";
import { touch, makeRecord, recordsOf } from "./records";
import { carriedReports, noteUpdate, raiseException, carryReport, countedTwiceReports } from "./reconciliation-exceptions";
import { IDENTITY_HOLD_EXPLANATION, stillReported, keepHoldException } from "./reconciliation-settlement-identity";
import { watDate } from "./calendar";
import { isDeepStrictEqual } from "node:util";

/**
 * Decision on a settlement line that stated only what it paid out: once the
 * debit's own gross completes its payment, the batch that counts the line takes
 * the line's gross and fee as they now are and the schedule's fee on that gross,
 * so its expected fee and variance follow at this reconciliation. A line counted
 * before it recorded its gross added its payment's amount then, `previousKobo`.
 */
export function completeLineGross(state: DomainState, ctx: Context, payment: TypedRecord<"payments">, previousKobo: number, lines: SettlementLines): void {
  const batch = lines.batchOf(payment.id);
  if (!batch || identityHeld(batch) || !Array.isArray(batch.data.lineObservationIds)) return;
  const line = batch.data.lineObservationIds.map((id) => recordsWhere(state, "observations", "id", String(id))[0]).find((item) => item?.data.paymentId === payment.id);
  if (!line) return;
  const schedule = lineSchedule(state, line);
  const grossKobo = isKobo(line.data.countedGrossKobo) ? line.data.countedGrossKobo : previousKobo;
  const expectedFeeKobo = isKobo(line.data.expectedFeeKobo) ? line.data.expectedFeeKobo : schedule ? providerFeeKobo(grossKobo, schedule) : 0;
  const was = { grossKobo, expectedFeeKobo, feeKobo: isKobo(line.data.assumedFeeKobo) ? line.data.assumedFeeKobo : isKobo(line.data.feeKobo) ? line.data.feeKobo : grossKobo > line.amountKobo ? grossKobo - line.amountKobo : expectedFeeKobo };
  const now = lineTotals(line, payment, schedule);
  if (now.grossKobo === was.grossKobo && now.feeKobo === was.feeKobo && now.expectedFeeKobo === was.expectedFeeKobo) return;
  countLine(batch, line, now, was);
  touch(batch, ctx.now); touch(line, ctx.now);
}

/**
 * Decision on batches an earlier build counted: it counted a settlement line
 * that stated only what it paid out, and made its payment, as a gross of that
 * payout with the schedule's fee taken off it (the line's assumedFeeKobo and
 * expectedFeeKobo, and no countedGrossKobo), and never gave the batch the gross
 * that later completed the payment. Once that gross is known, such a line is
 * counted again, once, as this build counts it (lineTotals), while its batch's
 * totals are still the ones its lines added: a batch Finance has corrected by
 * hand keeps the totals Finance typed. The batch's variance and exception then
 * follow at the same reconciliation.
 */
export function recountEarlierLines(state: DomainState, ctx: Context): void {
  const paymentOf: PaymentOf = (line) => recordsWhere(state, "payments", "id", String(line.data.paymentId ?? ""))[0];
  for (const batch of recordsOfKind(state, "settlement-batches")) {
    if (identityHeld(batch)) continue;
    if (!Array.isArray(batch.data.lineObservationIds)) continue;
    const lines = batch.data.lineObservationIds.map((id) => recordsWhere(state, "observations", "id", String(id))[0]);
    const earlier = lines.filter((line): line is TypedRecord<"observations"> => {
      const payment = line && paymentOf(line);
      return !!payment && !isKobo(line.data.countedGrossKobo) && line.data.grossAmountKobo === undefined && madeItsPayment(line) && payment.data.grossUnstated !== true && payment.amountKobo > line.amountKobo;
    });
    if (!earlier.length || !totalsFromLines(batch, lines, paymentOf)) continue;
    for (const line of earlier) {
      const payment = paymentOf(line)!;
      countLine(batch, line, lineTotals(line, payment, lineSchedule(state, line)), { grossKobo: line.amountKobo, feeKobo: Number(line.data.assumedFeeKobo), expectedFeeKobo: isKobo(line.data.expectedFeeKobo) ? line.data.expectedFeeKobo : 0 });
      touch(line, ctx.now);
    }
    touch(batch, ctx.now);
  }
}

/**
 * Decision on batches an earlier build saved, which added lines in any currency
 * to one gross, fee and net and checked their fees against the naira schedule.
 * At each reconciliation a batch that names no currency takes its first counted
 * line's, else, counting none, the first line linked to it (as a batch this
 * build makes takes the currency of the line that made it), and records it when
 * that is not naira or its lines mix currencies (one that names none is in
 * naira). A counted line in another currency than its batch is taken out of its
 * lines and, while its totals are still the ones its lines added
 * (totalsFromLines), out of its totals, and is reported as a line in another
 * currency is (separateOtherCurrencyLine); a batch whose currency has no fee
 * schedule loses the expected fee and fee variance the naira schedule gave it
 * and its lines. The provider's other lines of a collection no batch counts any
 * more are then read again (countDisplacedLines). It runs before the pass counts
 * any line, so each batch is corrected once. Returns the lines taken out, each
 * with its batch and the batch that now counts its collection instead.
 */
export function separateEarlierCurrencies(state: DomainState, ctx: Context): SeparatedLine[] {
  const paymentOf: PaymentOf = (line) => recordsWhere(state, "payments", "id", String(line.data.paymentId ?? ""))[0];
  const separated: SeparatedLine[] = [], displaced: SeparatedLine[] = [];
  let linked: Map<string, TypedRecord<"observations">> | undefined;
  // The first settlement line linked to each batch, read once and only for an earlier batch that counts no line.
  const firstLinked = (batchId: string) => (linked ??= recordsOfKind(state, "observations").reduce((map, item) => {
    if (item.data.source === "settlement" && typeof item.data.settlementBatchId === "string" && !map.has(item.data.settlementBatchId)) map.set(item.data.settlementBatchId, item);
    return map;
  }, new Map<string, TypedRecord<"observations">>())).get(batchId);
  for (const batch of recordsOfKind(state, "settlement-batches")) {
    if (identityHeld(batch)) continue;
    const lines = Array.isArray(batch.data.lineObservationIds) ? batch.data.lineObservationIds.map((id) => recordsWhere(state, "observations", "id", String(id))[0]) : [];
    const first = lines.find(Boolean) ?? (!batch.data.currency && Array.isArray(batch.data.lineObservationIds) ? firstLinked(batch.id) : undefined);
    const currency = batch.data.currency || !first ? currencyOf(batch) : currencyOf(first);
    const other = lines.filter((line): line is TypedRecord<"observations"> => !!line && currencyOf(line) !== currency);
    if (!batch.data.currency && (currency !== "NGN" || other.length)) { batch.data.currency = currency; touch(batch, ctx.now); }
    if (other.length) {
      const fromLines = totalsFromLines(batch, lines, paymentOf);
      for (const line of other) {
        const payment = paymentOf(line), added = lineAdded(line, paymentOf);
        if (fromLines) {
          batch.data.grossKobo = Number(batch.data.grossKobo) - added.grossKobo;
          batch.data.feeKobo = Number(batch.data.feeKobo) - added.feeKobo;
          if (batch.data.expectedFeeKobo !== undefined) batch.data.expectedFeeKobo = Number(batch.data.expectedFeeKobo) - added.expectedFeeKobo;
        }
        batch.data.lineObservationIds = (batch.data.lineObservationIds as string[]).filter((id) => id !== line.id);
        const kept = lines.some((item) => item && item !== line && !other.includes(item) && item.data.paymentId === line.data.paymentId);
        if (!kept) batch.data.linePaymentIds = ((batch.data.linePaymentIds ?? []) as string[]).filter((id) => id !== line.data.paymentId);
        for (const key of ["countedGrossKobo", "assumedFeeKobo", "expectedFeeKobo", "feeVarianceKobo"]) delete line.data[key];
        separateOtherCurrencyLine(state, ctx, batch, line, payment?.amountKobo ?? line.amountKobo, fromLines
          ? " An earlier build added it to the batch's totals; it is now taken out of them."
          : " An earlier build added it to the batch's totals, which no longer show what its lines added (Finance may have typed them by hand), so they are left as they are: check that they leave this line out.");
        separated.push({ line, batch });
        if (!kept && payment) displaced.push(separated.at(-1)!);
      }
      if (fromLines) {
        batch.data.netKobo = sumMoney([Number(batch.data.grossKobo), -Number(batch.data.feeKobo)]);
        if (batch.data.expectedFeeKobo !== undefined) batch.data.feeVarianceKobo = sumMoney([Number(batch.data.feeKobo), -Number(batch.data.expectedFeeKobo)]);
      }
    }
    if (!feesChecked(batch) && ["expectedFeeKobo", "feeVarianceKobo", "feeSchedule"].some((key) => batch.data[key] !== undefined)) {
      for (const key of ["expectedFeeKobo", "feeVarianceKobo", "feeSchedule"]) delete batch.data[key];
      for (const line of lines) if (line && (line.data.expectedFeeKobo !== undefined || line.data.feeVarianceKobo !== undefined)) { delete line.data.expectedFeeKobo; delete line.data.feeVarianceKobo; touch(line, ctx.now); }
      touch(batch, ctx.now);
    }
  }
  // Every batch now names the currency it holds, so the lines of a collection no batch counts any more are read in it.
  for (const entry of displaced) {
    entry.countedIn = countDisplacedLines(state, ctx, entry.batch, entry.line, paymentOf(entry.line)!);
    if (entry.countedIn) noteOpenReport(state, ctx, entry.batch, otherCurrencyLineCondition(entry.batch.id, entry.line.id), `its collection is now counted in settlement batch ${entry.countedIn.reference}, where the provider lists it too.`);
  }
  return separated;
}

/** A line separateEarlierCurrencies took out of its batch, and the batch that now counts its collection instead, if one does. */
interface SeparatedLine { line: TypedRecord<"observations">; batch: TypedRecord<"settlement-batches">; countedIn?: TypedRecord<"settlement-batches"> }

/**
 * Adds a dated line to the open settlement_variance exception of a batch that
 * reports `condition`, as its own or carried, or, for an earlier build's
 * carrier, by the dated line it added for `line`.
 */
function noteOpenReport(state: DomainState, ctx: Context, batch: ValopayRecord, condition: string, text: string, line?: ValopayRecord): void {
  const open = recordsWhere(state, "exceptions", "data.linkedRecordId", batch.id).find((item) => isOpenException(item.status) && resolveExceptionType(item.data.type) === "settlement_variance"
    && (item.data.condition === condition || carriedReports(item).includes(condition) || (!!line && String(item.data.notes ?? "").includes(`(WAT): Settlement line ${line.reference} (`))));
  if (open) noteUpdate(open, ctx, text);
}

/**
 * Decision on a collection an earlier build counted in a batch of another
 * currency, whose line there separateEarlierCurrencies took out (`taken`, from
 * batch `from`): that build reported the provider's other lines of it as
 * counted in `from` (countedInBatchId), which no longer counts it. They are
 * read again in order, as settlementBatch reads a line: one in a batch that
 * counts the collection in another line repeats it there; one in a batch whose
 * lines are in another currency is a line in another currency there; one whose
 * collection another batch counts is counted twice with that batch; and the
 * first left is counted in its batch, which takes its currency if it counts no
 * line yet. Each report still open gains a dated line. Returns the batch that
 * counts the collection now, when this counted it.
 */
function countDisplacedLines(state: DomainState, ctx: Context, from: TypedRecord<"settlement-batches">, taken: TypedRecord<"observations">, payment: TypedRecord<"payments">): TypedRecord<"settlement-batches"> | undefined {
  const lines = recordsOfKind(state, "observations").filter((item) => item.data.source === "settlement" && item.data.countedInBatchId === from.id && item.data.paymentId === payment.id);
  if (!lines.length) return undefined;
  const why = `settlement batch ${from.reference} no longer counts its collection, as its line there is in ${currencyOf(taken)} and the batch in ${currencyOf(from)}`;
  let counting = recordsOfKind(state, "settlement-batches").find((batch) => Array.isArray(batch.data.linePaymentIds) && batch.data.linePaymentIds.map(String).includes(payment.id));
  let countedNow: TypedRecord<"settlement-batches"> | undefined;
  for (const line of lines) {
    const batch = recordsWhere(state, "settlement-batches", "id", String(line.data.settlementBatchId ?? ""))[0];
    if (!batch || identityHeld(batch) || batch.id === from.id || !Array.isArray(batch.data.lineObservationIds)) continue;
    const lineIds = batch.data.lineObservationIds as string[], linePaymentIds = (batch.data.linePaymentIds ||= []) as string[];
    delete line.data.countedInBatchId;
    let now: string;
    if (linePaymentIds.includes(payment.id)) now = "is still not counted in this batch, as this batch counts its collection in another line";
    else if (lineIds.length && currencyOf(line) !== currencyOf(batch)) {
      delete line.data.duplicateSettlementLine;
      separateOtherCurrencyLine(state, ctx, batch, line, payment.amountKobo, ` An earlier build reported it as counted in settlement batch ${from.reference}, which no longer counts it.`);
      now = "is reported as a line in another currency than this batch";
    } else if (counting) {
      line.data.countedInBatchId = counting.id;
      now = `is still not counted in this batch, as settlement batch ${counting.reference} now counts its collection`;
    } else {
      const schedule = lineSchedule(state, line);
      if (!lineIds.length) takeLineCurrency(batch, currencyOf(line), schedule);
      delete line.data.duplicateSettlementLine;
      linePaymentIds.push(payment.id); lineIds.push(line.id);
      countLine(batch, line, lineTotals(line, payment, schedule), { grossKobo: 0, feeKobo: 0, expectedFeeKobo: 0 });
      touch(batch, ctx.now);
      counting = countedNow = batch;
      now = "is now counted in this batch";
    }
    touch(line, ctx.now);
    noteOpenReport(state, ctx, batch, lineCountedTwiceCondition(batch.id, line.id), `${why}, so settlement line ${line.reference} ${now}.`, line);
  }
  return countedNow;
}

/**
 * ING-07: a settlement line counts in the batch its batch reference names.
 * Decision on currencies: a batch holds one currency, its first counted line's,
 * and its totals are in that currency's smallest unit; a line in another
 * currency is linked to it as evidence and never counted (separateOtherCurrencyLine).
 */
export function settlementBatch(state: DomainState, ctx: Context, observation: TypedRecord<"observations">, payment: TypedRecord<"payments">, lines: SettlementLines): void {
  const batchReference = String(observation.data.batchReference || "");
  if (!batchReference) return;
  const provider = connectionOf(state, observation);
  const currency = currencyOf(observation), schedule = lineSchedule(state, observation);
  const identity = settlementIdentity(state, observation, batchReference);
  let batch = recordsWhere(state, "settlement-batches", "reference", batchReference).find((item) => batchIdentity(state, item) === identity || (identityHeld(item) && !!(item.data.providerIdentityReview as { identities?: string[] }).identities?.includes(identity)));
  if (!batch) {
    batch = makeRecord(state, "settlement-batches", {
      name: `Settlement batch ${batchReference}`, status: "pending", reference: batchReference, createdAt: ctx.now,
      data: { provider, batchReference, providerConnection: provider, providerIdentityKey: identity, currency, lineObservationIds: [], linePaymentIds: [], grossKobo: 0, feeKobo: 0, netKobo: 0, ...(schedule ? { expectedFeeKobo: 0, feeSchedule: schedule } : {}) },
    });
  }
  if (identityHeld(batch)) {
    // Retain new evidence beside the quarantined historical total; never silently mix it into that total.
    observation.data.settlementBatchId = batch.id;
    observation.data.providerIdentityHeld = true;
    return;
  }
  if (!Array.isArray(batch.data.lineObservationIds)) {
    // A batch Finance entered by hand: the provider's lines now build its totals, in their currency, and the typed totals are kept beside them.
    batch.data.enteredTotals = { grossKobo: Number(batch.data.grossKobo || 0), feeKobo: Number(batch.data.feeKobo || 0), netKobo: Number(batch.data.netKobo || 0), currency: currencyOf(batch) };
    Object.assign(batch.data, { lineObservationIds: [], linePaymentIds: [], grossKobo: 0, feeKobo: 0, netKobo: 0 });
  }
  const lineIds = batch.data.lineObservationIds as string[];
  const linePaymentIds = (batch.data.linePaymentIds ||= []) as string[];
  if (lineIds.includes(observation.id)) return;
  observation.data.settlementBatchId = batch.id;
  // ING-05: a repeated settlement line for a Payment already in the batch is evidence, and adds nothing to the batch totals.
  if (linePaymentIds.includes(payment.id)) { observation.data.duplicateSettlementLine = true; return; }
  if (lineIds.length && currency !== currencyOf(batch)) { separateOtherCurrencyLine(state, ctx, batch, observation, payment.amountKobo); return; }
  // A collection is paid out once: a line for a payment another batch already counts is not counted again, and
  // Finance is asked about the second payout. An exception already open for the batch carries it (carryReport).
  const counted = lines.batchOf(payment.id);
  if (counted && counted.id !== batch.id) {
    observation.data.duplicateSettlementLine = true;
    observation.data.countedInBatchId = counted.id;
    reportLineCountedTwice(state, ctx, batch, observation, counted, payment);
    return;
  }
  if (!lineIds.length) takeLineCurrency(batch, currency, schedule);
  linePaymentIds.push(payment.id);
  lines.count(payment.id, batch);
  lineIds.push(observation.id);
  countLine(batch, observation, lineTotals(observation, payment, schedule), { grossKobo: 0, feeKobo: 0, expectedFeeKobo: 0 });
  touch(batch, ctx.now);
}

/** The condition a settlement line in another currency than its batch is reported with on the batch. */
const otherCurrencyLineCondition = (batchId: string, lineId: string): string => `settlement_variance:${batchId}:currency:${lineId}`;

/**
 * Decision on a settlement line in another currency than its batch: a batch
 * holds one currency, so the line is never added to its totals. It is linked to
 * the batch as evidence (settlementBatchId, and otherCurrencyLineIds on the
 * batch, which names its own currency from then on, as an earlier one may not),
 * marked otherCurrencyLine, and reported to Finance with a
 * settlement_variance exception of its own that names the batch, the line and
 * both currencies (condition settlement_variance:<batch>:currency:<line>; an
 * exception already open for the batch carries it, carryReport), which stays
 * open until Finance resolves it. Its payment, `amount` in the line's currency,
 * is reconciled as any payment is. `note` says what an earlier build did with it.
 */
function separateOtherCurrencyLine(state: DomainState, ctx: Context, batch: TypedRecord<"settlement-batches">, line: TypedRecord<"observations">, amount: number, note = ""): void {
  line.data.settlementBatchId = batch.id;
  line.data.otherCurrencyLine = true;
  batch.data.currency ||= currencyOf(batch);
  const ids = Array.isArray(batch.data.otherCurrencyLineIds) ? batch.data.otherCurrencyLineIds.map(String) : [];
  if (!ids.includes(line.id)) batch.data.otherCurrencyLineIds = [...ids, line.id];
  touch(batch, ctx.now); touch(line, ctx.now);
  const currency = currencyOf(line), condition = otherCurrencyLineCondition(batch.id, line.id);
  const notes = `Settlement line ${line.reference} (${moneyText(amount, currency)}) is in ${currency}, and settlement batch ${batch.reference} is in ${currencyOf(batch)}: a batch holds one currency, so the line is not counted in its totals.${note} Its payment is reconciled as any payment is. Check with the provider which batch pays it out, then resolve this exception.`;
  const raised = raiseException(state, ctx, "settlement_variance", { linkedRecordId: batch.id, amountKobo: amount, notes, condition, currency });
  if (isOpenException(raised.status)) carryReport(raised, ctx, condition, notes);
}

/** The condition a settlement line whose collection another batch already counts is reported with on its own batch. */
const lineCountedTwiceCondition = (batchId: string, lineId: string): string => `settlement_variance:${batchId}:line:${lineId}`;

/** Reports on its batch a settlement line whose collection batch `counted` already counts, for Finance to check both payouts. */
function reportLineCountedTwice(state: DomainState, ctx: Context, batch: TypedRecord<"settlement-batches">, line: TypedRecord<"observations">, counted: ValopayRecord, payment: TypedRecord<"payments">): void {
  const notes = `Settlement line ${line.reference} (${moneyText(payment.amountKobo, currencyOf(payment))}) is already counted in settlement batch ${counted.reference}: the provider reports the same collection in two batches. It is not counted again in ${batch.reference}. Check both payouts with the provider.`;
  const condition = lineCountedTwiceCondition(batch.id, line.id);
  const raised = raiseException(state, ctx, "settlement_variance", { linkedRecordId: batch.id, amountKobo: payment.amountKobo, notes, condition, currency: currencyOf(payment) });
  if (isOpenException(raised.status)) carryReport(raised, ctx, condition, notes);
}

/**
 * A report that a settlement line's collection is counted in another batch
 * stays with Finance until Finance resolves it: one an earlier build closed
 * with its batch's statement or fee variance, as its condition cleared, is
 * raised again at the next reconciliation. An earlier build carried the
 * report on the batch's open exception as a dated line only: while that
 * exception is open, it lists the report in countedTwice from now on, so it
 * stays open and its resolution settles the report (carryReport). Once
 * Finance resolved it, the resolution replaced those notes: a report that no
 * exception carries any more was settled by it, since every build raised the
 * report as it marked the line (countedInBatchId), and the platform's own
 * closing keeps the notes.
 */
export function keepLinesCountedTwiceReported(state: DomainState, ctx: Context): void {
  for (const line of recordsOfKind(state, "observations")) {
    const batchId = line.data.settlementBatchId, countedIn = line.data.countedInBatchId;
    if (line.status !== "resolved" || typeof batchId !== "string" || typeof countedIn !== "string" || line.data.source !== "settlement") continue;
    const condition = lineCountedTwiceCondition(batchId, line.id);
    const reports = recordsWhere(state, "exceptions", "data.linkedRecordId", batchId).filter((item) => resolveExceptionType(item.data.type) === "settlement_variance"
      && (item.data.condition === condition || countedTwiceReports(item).includes(condition) || String(item.data.notes ?? "").includes(`Settlement line ${line.reference} (`)));
    // An earlier build's carrier holds the report as a dated line; one this build raised for another line names it in its own text.
    const listed = reports.some((item) => item.data.condition === condition || countedTwiceReports(item).includes(condition));
    const carrier = listed ? undefined : reports.find((item) => isOpenException(item.status) && String(item.data.notes ?? "").includes(`(WAT): Settlement line ${line.reference} (`));
    if (carrier) { carrier.data.countedTwice = [...countedTwiceReports(carrier), condition]; touch(carrier, ctx.now); }
    // A report settles when Finance resolves it; closed as its condition cleared, or by confirming a held batch's identity, it does not.
    if (!reports.length || reports.some((item) => isOpenException(item.status) || ![conditionClearedCode, providerIdentityConfirmedCode].includes(String(item.data.resolutionCode)))) continue;
    const batch = recordsWhere(state, "settlement-batches", "id", batchId)[0], counted = recordsWhere(state, "settlement-batches", "id", countedIn)[0];
    const payment = recordsWhere(state, "payments", "id", String(line.data.paymentId ?? ""))[0];
    if (batch && counted && payment) reportLineCountedTwice(state, ctx, batch, line, counted, payment);
  }
}

const STATEMENT_DIFFERS = "Statement credit differs from gross settlement lines less recorded fees.";

const STATEMENT_MATCHED = "Statement credit matched the settlement batch net total; it was not allocated to a customer.";

/**
 * ING-03 and ING-07: what a settlement batch's current lines and linked
 * statement credit show. It waits for its statement credit unless the fees
 * already differ from the schedule; it is reconciled when the credit equals the
 * net total and the fees are within tolerance, and a variance otherwise. The
 * condition names the state a settlement_variance exception is raised for;
 * `settledBy` is the other spelling earlier builds recorded for the same state.
 * `credits` is how many statement credits the linked total sums. Decision on
 * currencies: the fees of a batch in a currency with no fee schedule are not
 * checked, and its explanation says so, whatever its state; a statement credit
 * in another currency than the batch (statementOtherCurrencies) never matches
 * it, so while one names the batch it is in variance.
 */
export function settlementBatchState(batch: TypedRecord<"settlement-batches">, credits = 1): { status: "pending" | "reconciled" | "variance"; explanation?: string; condition?: string; settledBy?: string[] } {
  if (identityHeld(batch)) return { status: "variance", condition: providerIdentityCondition(batch.id), explanation: IDENTITY_HOLD_EXPLANATION };
  const currency = currencyOf(batch), checked = hasFeeSchedule(currency);
  const net = Number(batch.data.netKobo || 0), variance = checked ? Number(batch.data.feeVarianceKobo || 0) : 0;
  const feesDiffer = Math.abs(variance) > SETTLEMENT_BATCH_TOLERANCE_KOBO;
  const unchecked = checked ? "" : ` Its fees were not checked, because there is no fee schedule for ${currency}.`;
  const feeText = `Provider fees of ${batch.data.feeKobo} kobo differ from the schedule's ${batch.data.expectedFeeKobo} kobo by ${variance} kobo.`;
  const feeCondition = `settlement_variance:${batch.id}:fees:${batch.data.feeKobo}:${batch.data.expectedFeeKobo}`;
  const others = Object.entries((batch.data.statementOtherCurrencies ?? {}) as Record<string, { count: number; amount: number }>).sort(([a], [b]) => (a < b ? -1 : 1));
  const otherCredits = others.reduce((sum, [, row]) => sum + row.count, 0);
  const otherText = otherCredits ? `${otherCredits === 1 ? "A statement credit" : `${otherCredits} statement credits`} of ${otherCurrenciesText(Object.fromEntries(others))} ${otherCredits === 1 ? "names" : "name"} the batch in another currency than its ${currency}, and a credit in another currency never matches its net total.` : "";
  const statement = typeof batch.data.statementObservationId === "string" && Number.isSafeInteger(batch.data.statementNetKobo) ? Number(batch.data.statementNetKobo) : null;
  if (statement === null && !otherCredits) return feesDiffer ? { status: "variance", explanation: feeText, condition: feeCondition } : { status: "pending", ...(unchecked ? { explanation: `It waits for its statement credit.${unchecked}` } : {}) };
  const statementCondition = `settlement_variance:${batch.id}:statement:${statement ?? "none"}:${batch.data.netKobo}:${batch.data.feeKobo}${others.map(([code, row]) => `:${code}=${row.amount}`).join("")}`;
  const differs = statement === null || statement === net ? "" : credits > 1 ? `The batch's ${credits} statement credits together differ from gross settlement lines less recorded fees.` : STATEMENT_DIFFERS;
  if (differs || otherCredits) return { status: "variance", explanation: [differs, otherText, feesDiffer ? feeText : ""].filter(Boolean).join(" ") + unchecked, condition: statementCondition };
  if (feesDiffer) return { status: "variance", explanation: feeText, condition: feeCondition, settledBy: [statementCondition] };
  return { status: "reconciled", explanation: STATEMENT_MATCHED + unchecked };
}

/**
 * Every batch is re-evaluated from its current totals at every reconciliation,
 * so a line imported after its statement credit matched, or an edit, moves it.
 * Only what changed is written. A variance is a settlement_variance exception,
 * never forced; an exception raised for an earlier state stays for Finance,
 * and its notes gain a dated line whenever the batch moves, so the text it was
 * raised with is not read as the batch's current state.
 * A collection is counted in its first batch (SettlementLines): a later batch
 * that lists it too, as an earlier build could leave it, counts it twice, and
 * raises a settlement_variance exception that names both batches, once per
 * collection counted again. A batch held for its provider identity has an
 * exception of its own for the hold, or a renewed review of an earlier build's
 * decision on it (keepHoldException), added to `reviews` when raised now.
 * Returns the number of batches in variance. `credits` is how many statement
 * credits each batch's linked total sums.
 */
export function evaluateSettlementBatches(state: DomainState, ctx: Context, credits: ReadonlyMap<string, number>, reviews: TypedRecord<"exceptions">[]): number {
  let variances = 0;
  const countedIn = new Map<string, TypedRecord<"settlement-batches">>();
  for (const batch of recordsOf(state, "settlement-batches")) {
    let changed = false;
    // A batch edited by hand keeps its fee variance in step with its stated and expected fees, where they are checked.
    if (!identityHeld(batch) && feesChecked(batch) && Number.isSafeInteger(batch.data.feeKobo) && Number.isSafeInteger(batch.data.expectedFeeKobo)) {
      const variance = sumMoney([Number(batch.data.feeKobo), -Number(batch.data.expectedFeeKobo)]);
      if (batch.data.feeVarianceKobo !== variance) { batch.data.feeVarianceKobo = variance; changed = true; }
    }
    const next = settlementBatchState(batch, credits.get(batch.id));
    const previous = batch.status;
    const moved = previous !== next.status || (next.explanation !== undefined && batch.data.explanation !== next.explanation);
    if (previous !== next.status) { batch.status = next.status; changed = true; }
    if (next.explanation !== undefined && batch.data.explanation !== next.explanation) { batch.data.explanation = next.explanation; changed = true; }
    // Back to waiting for its statement credit: the variance explanation no longer applies.
    if (next.explanation === undefined && previous !== next.status && batch.data.explanation !== undefined) { delete batch.data.explanation; changed = true; }
    if (changed) touch(batch, ctx.now);
    // The exception raised for an earlier state stays open for Finance; a dated line says where the batch now stands, and
    // why one that reports a collection counted in two batches, or a line in another currency, stays open once the batch leaves variance.
    const open = moved ? recordsOf(state, "exceptions").find((item) => isOpenException(item.status) && item.data.linkedRecordId === batch.id && resolveExceptionType(item.data.type) === "settlement_variance") : undefined;
    if (open) {
      const current = `the batch is now ${next.status === "variance" ? "in variance" : next.status}. ${next.explanation ?? "Its fees are within the schedule and it waits for its statement credit."}${next.status !== "variance" ? stillReported(open) : ""}`;
      open.data.notes = `${open.data.notes ? `${open.data.notes}\n` : ""}Update on ${watDate(Date.parse(ctx.now))} (WAT): ${current}`;
      touch(open, ctx.now);
    }
    if (next.status === "variance") {
      // A hold has an exception of its own (keepHoldException); any other variance follows the one-open-exception rule.
      if (identityHeld(batch)) {
        const review = keepHoldException(state, ctx, batch);
        if (review) reviews.push(review);
      } else raiseException(state, ctx, "settlement_variance", { linkedRecordId: batch.id, notes: next.explanation!, condition: next.condition, settledBy: next.settledBy });
      variances += 1;
    }
    for (const paymentId of Array.isArray(batch.data.linePaymentIds) ? batch.data.linePaymentIds.map(String) : []) {
      const first = countedIn.get(paymentId);
      if (!first) { countedIn.set(paymentId, batch); continue; }
      const payment = recordsWhere(state, "payments", "id", paymentId)[0];
      if (first.id === batch.id || !payment) continue;
      const notes = `Settlement batch ${batch.reference} counts payment ${payment.reference} (${moneyText(payment.amountKobo, currencyOf(payment))}), which settlement batch ${first.reference} already counts: the same collection is in both batches' totals. Check both payouts with the provider.`;
      const condition = `settlement_variance:${batch.id}:counted:${paymentId}`;
      const raised = raiseException(state, ctx, "settlement_variance", { linkedRecordId: batch.id, amountKobo: payment.amountKobo, notes, condition });
      // An exception already open for the batch carries it.
      if (isOpenException(raised.status)) carryReport(raised, ctx, condition, notes);
    }
  }
  return variances;
}

/**
 * ING-03 (3): a statement credit whose reference matches a settlement batch
 * resolves to the batch, never to a customer; the batch is evaluated
 * afterwards. Every credit that names a batch counts: statementNetKobo is
 * their sum and statementObservationId the first, so a second credit is
 * compared with the batch's net total rather than replacing the first. A
 * credit with the reference and amount of one already counted is the same
 * bank line delivered again and adds nothing. A batch linked before credits
 * were summed is brought to the sum at the next reconciliation. Decision on
 * currencies: a credit in another currency than the batch is linked to it and
 * marked otherCurrencyCredit, but never summed with its credits: the batch
 * lists such credits by currency (statementOtherCurrencies), and they never
 * match it (settlementBatchState). Returns how many credits were linked now and
 * how many each batch counts in its own currency.
 */
/** Money by currency code, as otherCurrencies lists it: how many records and their amount in that currency's minor unit; undefined for none. */
function inCurrencies(records: readonly ValopayRecord[]): Record<string, { count: number; amount: number }> | undefined {
  const rows = new Map<string, { count: number; amount: number }>();
  for (const record of records) { const row = rows.get(currencyOf(record)) ?? { count: 0, amount: 0 }; row.count += 1; row.amount = sumMoney([row.amount, record.amountKobo]); rows.set(currencyOf(record), row); }
  return rows.size ? Object.fromEntries([...rows].sort(([a], [b]) => (a < b ? -1 : 1))) : undefined;
}

export function linkSettlementStatements(state: DomainState, ctx: Context): { linked: number; credits: Map<string, number> } {
  const statements = recordsOf(state, "observations").filter((item) => item.data.source === "statement" && item.data.batchReference && (item.status === "unresolved" || String(item.data.resolvedTo ?? "").startsWith("batch:")));
  const credits = new Map<string, number>();
  if (!statements.length) return { linked: 0, credits };
  const batches = new Map<string, TypedRecord<"settlement-batches">>(), byId = new Map<string, TypedRecord<"settlement-batches">>();
  for (const batch of recordsOf(state, "settlement-batches")) { if (!identityHeld(batch)) batches.set(batchIdentity(state, batch), batch); byId.set(batch.id, batch); }
  const linkedTo = new Map<string, TypedRecord<"observations">[]>();
  let linked = 0;
  for (const statement of statements) {
    const reference = String(statement.data.batchReference), named = namedConnection(statement);
    const batch = statement.status === "unresolved" ? batches.get(settlementIdentity(state, statement, reference)) : byId.get(String(statement.data.resolvedTo).slice("batch:".length));
    // Its own provider's batch may arrive later; a same-named foreign payout never matches. A credit linked earlier stays
    // linked unless it names another connection: one that names none, as a bank statement's may not, carries no identity.
    if (!batch || identityHeld(batch) || (named !== undefined && JSON.stringify([connectionKey(named), reference]) !== batchIdentity(state, batch))) continue;
    if (statement.status === "unresolved") {
      statement.status = "resolved";
      statement.data.resolvedTo = `batch:${batch.id}`;
      statement.data.resolutionKey = "settlement_batch_net_credit";
      touch(statement, ctx.now);
      linked += 1;
    }
    linkedTo.set(batch.id, [...(linkedTo.get(batch.id) ?? []), statement]);
  }
  for (const [batchId, linkedCredits] of linkedTo) {
    const batch = byId.get(batchId)!, currency = currencyOf(batch);
    const counted: TypedRecord<"observations">[] = [], elsewhere: TypedRecord<"observations">[] = [];
    for (const credit of linkedCredits) {
      const foreign = currencyOf(credit) !== currency, distinct = foreign ? elsewhere : counted;
      const repeat = distinct.some((item) => item.reference === credit.reference && item.amountKobo === credit.amountKobo && currencyOf(item) === currencyOf(credit));
      if (repeat !== (credit.data.duplicateStatementCredit === true) || foreign !== (credit.data.otherCurrencyCredit === true)) {
        if (repeat) credit.data.duplicateStatementCredit = true; else delete credit.data.duplicateStatementCredit;
        if (foreign) credit.data.otherCurrencyCredit = true; else delete credit.data.otherCurrencyCredit;
        touch(credit, ctx.now);
      }
      if (!repeat) distinct.push(credit);
    }
    const total = sumMoney(counted.map((item) => item.amountKobo)), other = inCurrencies(elsewhere);
    credits.set(batchId, counted.length);
    if (!isDeepStrictEqual(batch.data.statementOtherCurrencies, other)) {
      if (other) batch.data.statementOtherCurrencies = other; else delete batch.data.statementOtherCurrencies;
      touch(batch, ctx.now);
    }
    if (!counted.length) {
      if (batch.data.statementObservationId !== undefined || batch.data.statementNetKobo !== undefined) { delete batch.data.statementObservationId; delete batch.data.statementNetKobo; touch(batch, ctx.now); }
    } else if (batch.data.statementObservationId !== counted[0]!.id || batch.data.statementNetKobo !== total) {
      batch.data.statementObservationId = counted[0]!.id;
      batch.data.statementNetKobo = total;
      touch(batch, ctx.now);
    }
  }
  return { linked, credits };
}

/** Which settlement batch counts each payment's line, across every batch, so a collection is counted in one payout only. */
export class SettlementLines {
  private counted = new Map<string, TypedRecord<"settlement-batches">>();
  constructor(state: DomainState) {
    for (const batch of recordsOf(state, "settlement-batches")) {
      for (const id of Array.isArray(batch.data.linePaymentIds) ? batch.data.linePaymentIds.map(String) : []) if (!this.counted.has(id)) this.counted.set(id, batch);
    }
  }
  batchOf(paymentId: string) { return this.counted.get(paymentId); }
  count(paymentId: string, batch: TypedRecord<"settlement-batches">) { if (!this.counted.has(paymentId)) this.counted.set(paymentId, batch); }
}

/** What the audit entry adds for settlement lines an earlier build counted in a batch of another currency: each line, its batch, both currencies and the batch that now counts its collection instead. */
export function separatedLinesNote(separated: readonly SeparatedLine[]): string | undefined {
  if (!separated.length) return undefined;
  const named = separated.slice(0, 3).map(({ line, batch, countedIn }) => `${line.reference} (${currencyOf(line)}) from settlement batch ${batch.reference} (${currencyOf(batch)})${countedIn ? `, now counted in settlement batch ${countedIn.reference}, where the provider lists it too` : ""}`);
  const more = separated.length > 3 ? `; and ${counted(separated.length - 3, "more", "more")}` : "";
  return `Took ${counted(separated.length, "settlement line")} in another currency than its batch out of the batch, as a batch holds one currency: ${named.join("; ")}${more}.`;
}
