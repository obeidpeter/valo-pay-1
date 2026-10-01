/** Provider-identity holds, Finance confirmations and release evidence for settlement batches. */
import { type TypedRecord, type ValopayRecord, type DomainState, type Context } from "./types";
import { resolveExceptionType, providerIdentityOf, isOpenException, providerIdentityConfirmedCode, providerIdentityParts, counted, sumMoney, exceptionCatalogue, providerIdentityCondition, conditionClearedCode, providerIdentityReviewOf, providerIdentityReviewCondition, dayText, listText, optionText } from "@workspace/valopay-schema";
import { recordsWhere } from "./record-index";
import { identityHeld, connectionKey, namedConnection, connectionOf, currencyOf } from "./reconciliation-values";
import { type PaymentOf, totalsFromLines, lineAdded } from "./reconciliation-settlement-totals";
import { touch, makeRecord, recordsOf } from "./records";
import { carriedReports, noteUpdate, closeClearedException, moneyCurrency, moneyIn, countedTwiceReports, otherCurrencyReports } from "./reconciliation-exceptions";
import { addBusinessDays } from "./calendar";
import { isDeepStrictEqual } from "node:util";

/**
 * A settlement batch released from a provider identity hold: the connection it holds, the lines it held meanwhile,
 * which are counted again, and for one Finance confirmed (confirmIdentity), who did, the evidence of other connections
 * it moved out (lines counted again, credits left to link to their own batch) and whether its totals were kept as typed.
 */
interface IdentityRelease {
  batch: TypedRecord<"settlement-batches">; connection: string; held: TypedRecord<"observations">[];
  confirmedBy?: string; confirmedAt?: string; detached?: TypedRecord<"observations">[]; credits?: TypedRecord<"observations">[]; totalsKept?: boolean;
}

/** Whether an exception is one of a batch's provider identity hold: its hold's exception or a renewed review of it (providerIdentityOf). */
const identityExceptionOf = (exception: TypedRecord<"exceptions">, batchId: string): boolean =>
  resolveExceptionType(exception.data.type) === "settlement_variance" && providerIdentityOf(exception.data.condition) === batchId;

/** One entry of a settlement batch's provider identity history (providerIdentityHistory): a release, kept when the batch was held again, and when and for which identities it was. */
interface IdentityHistoryEntry { release: Record<string, unknown>; heldAgainAt: string; identities: string[]; observationIds: string[] }

/** A batch's provider identity history: every release a later hold ended, oldest first. Never shortened. */
const identityHistory = (batch: ValopayRecord): IdentityHistoryEntry[] => Array.isArray(batch.data.providerIdentityHistory) ? batch.data.providerIdentityHistory as IdentityHistoryEntry[] : [];

/** When a held batch's current hold began: its latest hold again (providerIdentityHistory), else its first (providerIdentityReview). */
const latestHoldAt = (batch: ValopayRecord): string => identityHistory(batch).at(-1)?.heldAgainAt ?? String((batch.data.providerIdentityReview as { detectedAt?: unknown } | undefined)?.detectedAt ?? "");

/** When an exception was decided: resolved, else last changed. */
const decidedAt = (exception: TypedRecord<"exceptions">): string => String(exception.data.resolvedAt || exception.updatedAt);

/**
 * The resolution confirming a held batch's identity (providerIdentityConfirmedCode), recorded on its hold's exception
 * or on a renewed review of it (providerIdentityOf) since its current hold began (latestHoldAt), while it names one of
 * the identities the batch was held for and, for a batch that records its identity, that one (heldBatchToConfirm). A
 * confirmation of an earlier hold does not decide a later one. Of several, the latest decided is Finance's decision, as
 * keepHoldException reads it: one an earlier build recorded although another batch claimed its identity, which this pass
 * skips, does not outlast a later confirmation of another identity.
 */
function identityConfirmation(state: DomainState, batch: TypedRecord<"settlement-batches">): TypedRecord<"exceptions"> | undefined {
  const identities = (batch.data.providerIdentityReview as { identities?: string[] }).identities ?? [], since = latestHoldAt(batch);
  return recordsWhere(state, "exceptions", "data.linkedRecordId", batch.id).filter((item) => identityExceptionOf(item, batch.id) && !isOpenException(item.status) && decidedAt(item) >= since
    && item.data.resolutionCode === providerIdentityConfirmedCode && identities.includes(String(item.data.confirmedProviderIdentity))
    && (!batch.data.providerIdentityKey || batch.data.providerIdentityKey === item.data.confirmedProviderIdentity))
    .sort((a, b) => decidedAt(b).localeCompare(decidedAt(a)))[0];
}

/** Whether the settlement batch a provider identity exception names (providerIdentityOf) is still held for its provider identity. */
export function identityExceptionHeld(state: DomainState, exception: TypedRecord<"exceptions">): boolean {
  const batchId = providerIdentityOf(exception.data.condition);
  const batch = batchId === undefined ? undefined : recordsWhere(state, "settlement-batches", "id", batchId)[0];
  return !!batch && identityHeld(batch);
}

/** Why a confirmation as an identity another batch records or claims is refused, and not applied: the collision is the data owner's to settle. */
function collisionText(identity: string, others: readonly { reference: string; handEntered: boolean }[]): string {
  const connection = providerIdentityParts(identity)?.connection ?? identity;
  return `${others.map(batchInWords).join(" and ")} also ${others.length === 1 ? "records or claims" : "record or claim"} the payout of ${connection}. Confirming whose payout a batch is does not settle two batches claiming the same payout: the lender’s data owner must correct the duplicate batch’s reference or provider. The next reconciliation then releases the right batch.`;
}

/**
 * The settlement batch a provider identity confirmation releases, checked before it is recorded: a batch still held for
 * its provider identity (409 otherwise, so a person whose dialog was open while it was released refreshes it); an
 * identity it was held for, or for a batch that records its identity, that one, which the store keeps (400 otherwise);
 * and one no other batch records or claims (identityClaimedElsewhere; 409 otherwise, naming that batch). resolve_exception
 * checks the role first: only Admin or Finance confirms.
 */
export function heldBatchToConfirm(state: DomainState, exception: TypedRecord<"exceptions">, identity: string | undefined): TypedRecord<"settlement-batches"> {
  const batchId = providerIdentityOf(exception.data.condition);
  const batch = batchId === undefined ? undefined : recordsWhere(state, "settlement-batches", "id", batchId)[0];
  if (!batch || !identityHeld(batch)) throw Object.assign(new Error("This settlement batch is no longer on hold for its provider identity. Reload the page to see where it stands."), { status: 409 });
  const identities = (batch.data.providerIdentityReview as { identities?: string[] }).identities ?? [];
  const choices = batch.data.providerIdentityKey ? identities.filter((item) => item === batch.data.providerIdentityKey) : identities;
  if (!identity || !choices.includes(identity)) throw new Error(`Choose one of the connections settlement batch ${batch.reference} was held for: ${listText(choices.map((choice) => providerIdentityParts(choice)?.connection ?? choice))}.`);
  const others = identityClaimedElsewhere(state, batch, identity);
  if (others.length) throw Object.assign(new Error(`Settlement batch ${batch.reference} cannot be confirmed as this payout: ${collisionText(identity, others.map((other) => ({ reference: other.reference, handEntered: enteredByHand(other) })))}`), { status: 409 });
  return batch;
}

/**
 * Decision on Finance's confirmation of a held batch's identity (identityConfirmation): the batch is released as that
 * identity, once. Its evidence of that connection, and evidence that names none, stays with it. Each settlement line of
 * another connection leaves its lines and, while its totals are the ones its lines added (totalsFromLines), its gross,
 * fee and net, and always its expected fee, which only reconciliation records, and is returned to be read as a new
 * line is, in its own connection's batch; each statement credit of another
 * connection is unlinked, to link to its own connection's batch; and the lines it held meanwhile are returned too. The
 * release records the identity, who confirmed it and when, and what moved; the batch takes the confirmed connection as
 * its identity and its provider and providerConnection, keeping in the release (previous) those that named another.
 */
function confirmIdentity(state: DomainState, ctx: Context, batch: TypedRecord<"settlement-batches">, confirmation: TypedRecord<"exceptions">, linked: Map<string, TypedRecord<"observations">>): IdentityRelease {
  const identity = String(confirmation.data.confirmedProviderIdentity), key = providerIdentityParts(identity)?.connection ?? identity;
  const identityOf = (item: TypedRecord<"observations">, named: string) => JSON.stringify([connectionKey(named), String(item.data.batchReference || batch.reference)]);
  const other = (item: TypedRecord<"observations">) => { const named = namedConnection(item); return named !== undefined && identityOf(item, named) !== identity; };
  const evidence = [...linked.values()];
  const connection = evidence.map((item) => { const named = namedConnection(item); return named !== undefined && identityOf(item, named) === identity ? named.trim() : undefined; }).find(Boolean) ?? key;
  const held = evidence.filter((item) => item.data.providerIdentityHeld === true);
  const detached = evidence.filter((item) => item.data.source === "settlement" && item.data.providerIdentityHeld !== true && other(item));
  const credits = evidence.filter((item) => item.data.source === "statement" && other(item));
  const paymentOf: PaymentOf = (line) => recordsWhere(state, "payments", "id", String(line.data.paymentId ?? ""))[0];
  const lines = Array.isArray(batch.data.lineObservationIds) ? batch.data.lineObservationIds.map((id) => recordsWhere(state, "observations", "id", String(id))[0]) : [];
  const counted = detached.filter((line) => lines.includes(line)), fromLines = counted.length > 0 && totalsFromLines(batch, lines, paymentOf);
  for (const line of counted) {
    const added = lineAdded(line, paymentOf);
    if (fromLines) {
      batch.data.grossKobo = sumMoney([Number(batch.data.grossKobo), -added.grossKobo]);
      batch.data.feeKobo = sumMoney([Number(batch.data.feeKobo), -added.feeKobo]);
    }
    // The expected fee is reconciliation's alone (Finance cannot type it), so the moved line's always leaves it, typed totals or not.
    if (batch.data.expectedFeeKobo !== undefined) batch.data.expectedFeeKobo = sumMoney([Number(batch.data.expectedFeeKobo), -added.expectedFeeKobo]);
    batch.data.lineObservationIds = (batch.data.lineObservationIds as string[]).filter((id) => id !== line.id);
    if (!lines.some((item) => item && !counted.includes(item) && item.data.paymentId === line.data.paymentId)) batch.data.linePaymentIds = ((batch.data.linePaymentIds ?? []) as string[]).filter((id) => id !== line.data.paymentId);
  }
  if (fromLines) batch.data.netKobo = sumMoney([Number(batch.data.grossKobo), -Number(batch.data.feeKobo)]);
  if (counted.length && batch.data.expectedFeeKobo !== undefined) batch.data.feeVarianceKobo = sumMoney([Number(batch.data.feeKobo), -Number(batch.data.expectedFeeKobo)]);
  if (Array.isArray(batch.data.otherCurrencyLineIds)) batch.data.otherCurrencyLineIds = batch.data.otherCurrencyLineIds.filter((id) => !detached.some((line) => line.id === id));
  for (const line of detached) {
    for (const field of ["settlementBatchId", "countedGrossKobo", "assumedFeeKobo", "expectedFeeKobo", "feeVarianceKobo", "duplicateSettlementLine", "countedInBatchId", "otherCurrencyLine"]) delete line.data[field];
    touch(line, ctx.now);
  }
  for (const credit of credits) {
    credit.status = "unresolved";
    for (const field of ["resolvedTo", "resolutionKey", "duplicateStatementCredit", "otherCurrencyCredit"]) delete credit.data[field];
    touch(credit, ctx.now);
  }
  // The credits it keeps are summed again by the statement link.
  if (credits.length) for (const field of ["statementObservationId", "statementNetKobo", "statementOtherCurrencies"]) delete batch.data[field];
  for (const line of held) { delete line.data.providerIdentityHeld; delete line.data.settlementBatchId; touch(line, ctx.now); }
  for (const item of [...held, ...detached, ...credits]) linked.delete(item.id);
  // The batch takes the connection Finance confirmed, unless it records its identity already (then the store keeps these).
  const previous = batch.data.providerIdentityKey ? {} : Object.fromEntries((["provider", "providerConnection"] as const).filter((field) => batch.data[field] !== undefined && connectionKey(String(batch.data[field])) !== key).map((field) => [field, batch.data[field]]));
  const confirmedBy = String(confirmation.data.resolvedBy ?? ""), confirmedAt = String(confirmation.data.resolvedAt ?? "");
  batch.data.providerIdentityRelease = {
    releasedAt: ctx.now, identity, heldLineIds: held.map((item) => item.id).sort(), confirmedBy, confirmedAt, exceptionId: confirmation.id,
    detachedLineIds: detached.map((item) => item.id).sort(), detachedCreditIds: credits.map((item) => item.id).sort(), ...(Object.keys(previous).length ? { previous } : {}),
  };
  if (!batch.data.providerIdentityKey) {
    batch.data.providerIdentityKey = identity;
    for (const field of Object.keys(previous)) batch.data[field] = connection;
    batch.data.providerConnection ||= connection;
  }
  touch(batch, ctx.now);
  return { batch, connection, held, confirmedBy, confirmedAt, detached, credits, totalsKept: counted.length > 0 && !fromLines };
}

/**
 * Closes, as their condition cleared, the open exceptions of a released batch's provider identity hold
 * (providerIdentityOf): its hold's exception and a renewed review of it. A hold exception concerns only the hold, but
 * one an earlier build made carry a report of a collection counted in two batches, or of a line in another currency,
 * stays open for Finance to settle that report, with a dated line saying so; once the batch is not held, it offers the
 * ordinary settlement_variance codes (resolutionCodesForException). Returns those closed.
 */
function closeIdentityExceptions(state: DomainState, ctx: Context, batch: TypedRecord<"settlement-batches">, reason: string): TypedRecord<"exceptions">[] {
  const open = recordsWhere(state, "exceptions", "data.linkedRecordId", batch.id).filter((item) => isOpenException(item.status) && identityExceptionOf(item, batch.id));
  const closed: TypedRecord<"exceptions">[] = [];
  for (const exception of open) {
    if (carriedReports(exception).length) noteUpdate(exception, ctx, `${reason[0]!.toUpperCase()}${reason.slice(1)}.${stillReported(exception)}`);
    else { closeClearedException(exception, ctx, reason); closed.push(exception); }
  }
  return closed;
}

/** The exception raised for a batch's provider identity hold: created directly, since it concerns only the hold and is never carried by, or carries, another. */
function raiseHoldException(state: DomainState, ctx: Context, batch: TypedRecord<"settlement-batches">): TypedRecord<"exceptions"> {
  const definition = exceptionCatalogue.settlement_variance, condition = providerIdentityCondition(batch.id);
  const currency = moneyCurrency({ linkedRecordId: batch.id, condition }, moneyIn(state));
  return makeRecord(state, "exceptions", {
    name: definition.title, status: "open", customerId: "", amountKobo: 0, createdAt: ctx.now,
    data: {
      type: "settlement_variance", severity: definition.severity, owner: definition.owner, slaBusinessDays: definition.slaBusinessDays, dueBy: addBusinessDays(state, ctx.now, definition.slaBusinessDays),
      notes: IDENTITY_HOLD_EXPLANATION, linkedRecordId: batch.id, condition, ...(currency !== "NGN" ? { currency } : {}),
    },
  });
}

/**
 * Decision on the exception a batch held for its provider identity needs: every such batch has its own exception with
 * the hold's condition, on which Finance or an administrator confirms whose payout it is. One is created directly when
 * the batch has none for its current hold (latestHoldAt): open, or decided since the hold began other than as its
 * condition cleared, whether it was held while another settlement_variance was open for it, an earlier build carried
 * the hold on that one, or it is held again after a release. A confirmation this pass could not apply because another
 * batch records or claims its identity (providerIdentityClaimedBy), as two recorded before one reconciliation can be,
 * leaves the batch a new open exception, since a decision is never reopened, with a dated line saying why; one another
 * batch no longer claims applies at the next reconciliation. One an earlier build resolved or closed since the hold
 * began another way gets a renewed review instead (reviewEarlierIdentityDecision). Returns the review raised now.
 */
export function keepHoldException(state: DomainState, ctx: Context, batch: TypedRecord<"settlement-batches">): TypedRecord<"exceptions"> | undefined {
  const since = latestHoldAt(batch);
  const current = recordsWhere(state, "exceptions", "data.linkedRecordId", batch.id)
    .filter((item) => identityExceptionOf(item, batch.id) && (isOpenException(item.status) || (item.data.resolutionCode !== conditionClearedCode && decidedAt(item) >= since)))
    .sort((a, b) => decidedAt(b).localeCompare(decidedAt(a)));
  if (current.some((item) => isOpenException(item.status))) return undefined;
  if (!current.length) { raiseHoldException(state, ctx, batch); return undefined; }
  const [latest] = current;
  if (latest!.data.resolutionCode === providerIdentityConfirmedCode) {
    // Decided since the hold began, yet the batch is still held: a confirmation this pass did not apply.
    const identity = String(latest!.data.confirmedProviderIdentity), identities = (batch.data.providerIdentityReview as { identities?: string[] }).identities ?? [];
    const claimed = ((batch.data.providerIdentityClaimedBy ?? []) as IdentityClaim[]).filter((claim) => claim.identity === identity);
    const applicable = identities.includes(identity) && (!batch.data.providerIdentityKey || batch.data.providerIdentityKey === identity);
    if (applicable && !claimed.length) return undefined;
    const why = claimed.length ? collisionText(identity, claimed) : `that connection is not one the batch was held for. Resolve this exception as ${optionText(providerIdentityConfirmedCode)} and choose one of those connections.`;
    noteUpdate(raiseHoldException(state, ctx, batch), ctx, `the confirmation recorded on exception ${latest!.reference || latest!.id}, of settlement batch ${batch.reference} as the payout of ${providerIdentityParts(identity)?.connection ?? identity}, was not carried out: ${why}`);
    return undefined;
  }
  // An earlier build's other code, which a renewed review follows.
  const earlier = current.filter((item) => providerIdentityReviewOf(item.data.condition) === undefined)[0];
  return earlier ? reviewEarlierIdentityDecision(state, ctx, batch, earlier) : undefined;
}

/**
 * Decision on a batch still held for its provider identity whose hold's exception an earlier build resolved, or
 * closed, without a confirmed identity: that build offered codes that closed the exception while the batch stayed
 * held with its evidence uncounted, and nothing was left to release it. The earlier resolution keeps its meaning, and
 * a renewed review is raised, once: a Finance-owned settlement_variance naming that decision (`earlier`), with the
 * condition providerIdentityReviewCondition and legacyIdentityReview, whose only code, while the batch is held, is
 * provider_identity_confirmed and which only Admin or Finance resolves. No second review of the same decision is
 * raised, open or resolved; a later hold has an exception of its own (keepHoldException). Returns the review raised now.
 */
function reviewEarlierIdentityDecision(state: DomainState, ctx: Context, batch: TypedRecord<"settlement-batches">, earlier: TypedRecord<"exceptions">): TypedRecord<"exceptions"> | undefined {
  const condition = providerIdentityReviewCondition(batch.id, earlier.id);
  if (recordsWhere(state, "exceptions", "data.linkedRecordId", batch.id).some((item) => item.data.condition === condition)) return undefined;
  const code = earlier.data.resolutionCode ? String(earlier.data.resolutionCode) : undefined;
  const at = Date.parse(String(earlier.data.resolvedAt ?? ""));
  const decided = `${code ? `resolved as ${optionText(code)}` : "closed"}${earlier.data.resolvedBy ? ` by ${earlier.data.resolvedBy}` : ""}${Number.isFinite(at) ? ` on ${dayText(at)}` : ""}`;
  const definition = exceptionCatalogue.settlement_variance;
  // The note in three parts: what happened, each choice on its own line, then what happens next.
  const notes = [
    `Settlement batch ${batch.reference} is on hold for its provider identity: its evidence names more than one provider connection, or another batch claims the same payout. None of its evidence is counted, and it cannot be reconciled. Exception ${earlier.reference || earlier.id} was ${decided} without confirming whose payout the batch is. That decision stands, but the batch stays on hold until Finance or an Admin confirms whose payout it is.`,
    `${optionText(providerIdentityConfirmedCode)}: once the providers have confirmed whose payout it is, resolve this review with it and choose that connection. The next reconciliation releases the batch as its payout and moves other connections’ evidence to their own batches.`,
    "If the providers cannot say which connection it belongs to, leave this review open until the data owner corrects the evidence. The next reconciliation then releases the batch and closes this review.",
  ].join("\n");
  const currency = moneyCurrency({ linkedRecordId: batch.id, condition }, moneyIn(state));
  return makeRecord(state, "exceptions", {
    name: "Review earlier settlement identity decision", status: "open", customerId: "", amountKobo: 0, createdAt: ctx.now,
    data: {
      type: "settlement_variance", severity: definition.severity, owner: "Finance", slaBusinessDays: definition.slaBusinessDays, dueBy: addBusinessDays(state, ctx.now, definition.slaBusinessDays), notes, linkedRecordId: batch.id, condition,
      legacyIdentityReview: { priorExceptionId: earlier.id, priorStatus: earlier.status, priorResolutionCode: code ?? null, priorResolvedBy: earlier.data.resolvedBy ?? null, priorResolvedAt: earlier.data.resolvedAt ?? null },
      ...(currency !== "NGN" ? { currency } : {}),
    },
  });
}

/** A settlement batch's evidence, what it claims and the identity it takes (assessIdentity). */
interface IdentityAssessment {
  batch: TypedRecord<"settlement-batches">; linked: TypedRecord<"observations">[]; own: TypedRecord<"observations">[];
  claims: Map<string, string>; identity: string; connection: string;
}

/** The evidence linked to each settlement batch: the settlement lines that name it, the statement credits resolved to it, and the lines and credit it lists. */
function batchEvidence(state: DomainState, batches: readonly TypedRecord<"settlement-batches">[]): Map<string, Map<string, TypedRecord<"observations">>> {
  const evidence = new Map<string, Map<string, TypedRecord<"observations">>>();
  const link = (batchId: unknown, observation: TypedRecord<"observations"> | undefined) => {
    if (typeof batchId === "string" && observation) evidence.set(batchId, (evidence.get(batchId) ?? new Map<string, TypedRecord<"observations">>()).set(observation.id, observation));
  };
  for (const observation of recordsOf(state, "observations")) {
    link(observation.data.source === "settlement" ? observation.data.settlementBatchId
      : observation.data.source === "statement" && String(observation.data.resolvedTo ?? "").startsWith("batch:") ? String(observation.data.resolvedTo).slice(6) : undefined, observation);
  }
  for (const batch of batches) {
    for (const id of [...(Array.isArray(batch.data.lineObservationIds) ? batch.data.lineObservationIds : []), ...(Array.isArray(batch.data.otherCurrencyLineIds) ? batch.data.otherCurrencyLineIds : []), ...(batch.data.statementObservationId ? [batch.data.statementObservationId] : [])]) {
      link(batch.id, recordsWhere(state, "observations", "id", String(id))[0]);
    }
  }
  return evidence;
}

/**
 * What a batch claims (FIN-03): each identity its own evidence names, with a spelling of its connection; its recorded
 * identity; and for a batch Finance entered by hand, the provider it records, when it records one. Its identity is its
 * one claim, else the lender's own connection with its reference.
 */
function assessIdentity(state: DomainState, batch: TypedRecord<"settlement-batches">, evidence: ReadonlyMap<string, TypedRecord<"observations">> | undefined): IdentityAssessment {
  const linked = [...(evidence?.values() ?? [])];
  // A line a hold attached without counting it was never the batch's evidence: it is read again once the batch is released.
  const own = linked.filter((item) => item.data.providerIdentityHeld !== true);
  const claims = new Map<string, string>();
  for (const item of own) {
    const named = namedConnection(item);
    if (named !== undefined) claims.set(JSON.stringify([connectionKey(named), String(item.data.batchReference || batch.reference)]), named.trim());
  }
  const entered = !Array.isArray(batch.data.lineObservationIds) || !!batch.data.enteredTotals ? namedConnection(batch) : undefined;
  const recorded = batch.data.providerIdentityKey ? String(batch.data.providerIdentityKey) : entered !== undefined ? JSON.stringify([connectionKey(entered), batch.reference]) : undefined;
  if (recorded !== undefined && !claims.has(recorded)) claims.set(recorded, (entered ?? connectionOf(state, batch)).trim());
  const [identity, connection] = claims.size === 1 ? [...claims][0]! : [JSON.stringify([connectionKey(String(state.merchant.provider)), batch.reference]), String(state.merchant.provider)];
  return { batch, linked, own, claims, identity, connection };
}

/** Which batches claim each identity: an ambiguous batch claims every one its evidence names, and one held already those it was held for; any other its identity. */
function identityClaimants(assessed: readonly IdentityAssessment[]): Map<string, Set<string>> {
  const claimants = new Map<string, Set<string>>();
  for (const { batch, claims, identity } of assessed) {
    const claimed = claims.size > 1 ? [...claims.keys(), ...(identityHeld(batch) ? (batch.data.providerIdentityReview as { identities?: string[] }).identities ?? [] : [])] : [identity];
    for (const item of claimed) claimants.set(item, (claimants.get(item) ?? new Set<string>()).add(batch.id));
  }
  return claimants;
}

/**
 * The other settlement batches that record or claim an identity (identityClaimants), as the lender's records stand
 * now: a confirmation of that identity would leave two batches as one payout, which only the data owner settles.
 */
export function identityClaimedElsewhere(state: DomainState, batch: TypedRecord<"settlement-batches">, identity: string): TypedRecord<"settlement-batches">[] {
  const batches = recordsOf(state, "settlement-batches"), evidence = batchEvidence(state, batches);
  const claimants = identityClaimants(batches.map((item) => assessIdentity(state, item, evidence.get(item.id))));
  return batches.filter((item) => item.id !== batch.id && claimants.get(identity)?.has(item.id));
}

/** One other batch that records or claims one of a held batch's identities (providerIdentityClaimedBy). */
interface IdentityClaim { identity: string; batchId: string; reference: string; handEntered: boolean }

/** A batch in words, for a person telling two batches with one reference apart: its reference, and whether Finance entered it by hand. */
const batchInWords = (batch: { reference: string; handEntered: boolean }): string => `settlement batch ${batch.reference}${batch.handEntered ? ", entered by hand" : ", built from the provider’s lines"}`;

/** Whether Finance entered a batch by hand (the provider's lines never built it, or built it over totals Finance typed). */
const enteredByHand = (batch: TypedRecord<"settlement-batches">): boolean => !Array.isArray(batch.data.lineObservationIds) || !!batch.data.enteredTotals;

/**
 * FIN-03: a settlement batch is one provider connection's payout, and one whose
 * evidence is genuinely ambiguous is held for review (providerIdentityReview keeps
 * its earlier totals and links; the batch stays in variance) instead of being split
 * by guesswork. It is ambiguous when its evidence names more than one connection
 * (the connection, else the provider, each of its settlement lines and statement
 * credits names, observationProviderKey, with its batch reference; its recorded
 * identity; and for a batch Finance entered by hand, the provider it records), or
 * when another batch claims its identity. Evidence that names no connection
 * carries no identity and never makes a batch ambiguous. Decision on the batches
 * earlier builds saved: one saved before identities were recorded takes the one
 * connection its evidence names, else the lender's own (as ING-03 reads evidence
 * that names none), never the connection an earlier build copied to it from its
 * first payment (providerConnection), and records it (providerIdentityKey). A batch
 * PR #61's build held that is not ambiguous is released, once:
 * providerIdentityRelease records when, as which identity and the lines it
 * attached but held meanwhile (providerIdentityHeld), beside its snapshot, which is
 * kept; the exception raised for the hold closes as its condition cleared; and
 * those lines are returned to be counted as a line is when it arrives
 * (settlementBatch), in this batch or in their own connection's. Its totals and
 * statement links were kept, so the pass then reconciles it as before. A held
 * batch whose identity Finance confirmed is released as that identity first
 * (confirmIdentity), unless another batch records or claims that identity, a
 * collision only the data owner settles; and another batch claiming it does not
 * hold it again. A released batch whose evidence later names another connection
 * is held again. Each held batch records the identities it was held for that
 * another batch records or claims (providerIdentityClaimedBy), which it cannot
 * be confirmed as. Returns how many batches are held, those released and the
 * exceptions their release closed.
 */
export function holdEarlierSettlementIdentities(state: DomainState, ctx: Context): { held: number; released: IdentityRelease[]; cleared: TypedRecord<"exceptions">[] } {
  const batches = recordsOf(state, "settlement-batches"), evidence = batchEvidence(state, batches), released: IdentityRelease[] = [], cleared: TypedRecord<"exceptions">[] = [];
  // Decision on a collision: a confirmation settles which connection's payout a batch is, not a collision between two
  // batches that claim one identity, so one whose identity another batch records or claims, as the batches stand before
  // this pass decides anything, is not applied (keepHoldException says why); the data owner corrects the duplicate.
  let before: Map<string, Set<string>> | undefined;
  for (const batch of batches) {
    const confirmation = identityHeld(batch) ? identityConfirmation(state, batch) : undefined;
    if (!confirmation) continue;
    before ??= identityClaimants(batches.map((item) => assessIdentity(state, item, evidence.get(item.id))));
    if ([...(before.get(String(confirmation.data.confirmedProviderIdentity)) ?? [])].some((id) => id !== batch.id)) continue;
    const release = confirmIdentity(state, ctx, batch, confirmation, evidence.get(batch.id) ?? new Map());
    released.push(release);
    cleared.push(...closeIdentityExceptions(state, ctx, batch, `settlement batch ${batch.reference} was released as the payout of ${release.connection}, which ${release.confirmedBy} confirmed`));
  }
  const assessed = batches.map((batch) => assessIdentity(state, batch, evidence.get(batch.id)));
  const claimants = identityClaimants(assessed);
  let held = 0;
  for (const { batch, linked, own, claims, identity, connection } of assessed) {
    // Finance confirmed its identity: another batch claiming it does not hold it again.
    const confirmed = !!(batch.data.providerIdentityRelease as { confirmedBy?: unknown } | undefined)?.confirmedBy;
    if (claims.size > 1 || (!confirmed && (claimants.get(identity)?.size ?? 0) > 1)) {
      if (!batch.data.providerIdentityReview) {
        batch.data.providerIdentityReview = {
          detectedAt: ctx.now, identities: (claims.size > 1 ? [...claims.keys()] : [identity]).sort(), observationIds: own.map((item) => item.id).sort(),
          previous: { status: batch.status, grossKobo: batch.data.grossKobo, feeKobo: batch.data.feeKobo, netKobo: batch.data.netKobo, currency: currencyOf(batch), statementObservationId: batch.data.statementObservationId ?? null, statementNetKobo: batch.data.statementNetKobo ?? null },
        };
        touch(batch, ctx.now);
      } else if (batch.data.providerIdentityRelease) {
        // Held again: the release it had stays in its history, which marks when this hold began (latestHoldAt).
        const entry: IdentityHistoryEntry = { release: batch.data.providerIdentityRelease as Record<string, unknown>, heldAgainAt: ctx.now, identities: (claims.size > 1 ? [...claims.keys()] : [identity]).sort(), observationIds: own.map((item) => item.id).sort() };
        batch.data.providerIdentityHistory = [...identityHistory(batch), entry];
        delete batch.data.providerIdentityRelease;
        touch(batch, ctx.now);
      }
      held += 1;
      continue;
    }
    if (identityHeld(batch)) {
      const lines = linked.filter((item) => item.data.providerIdentityHeld === true);
      batch.data.providerIdentityRelease = { releasedAt: ctx.now, identity, heldLineIds: lines.map((item) => item.id).sort() };
      for (const line of lines) { delete line.data.providerIdentityHeld; delete line.data.settlementBatchId; touch(line, ctx.now); }
      cleared.push(...closeIdentityExceptions(state, ctx, batch, `all the evidence of settlement batch ${batch.reference} now comes from ${connection}, and no other batch claims it, so its provider identity hold is released`));
      released.push({ batch, connection, held: lines });
      touch(batch, ctx.now);
    }
    if (!batch.data.providerIdentityKey) {
      batch.data.providerIdentityKey = identity;
      batch.data.providerConnection ||= connection;
      touch(batch, ctx.now);
    }
  }
  // Each held batch records which of its identities another batch records or claims, which it cannot be confirmed as.
  for (const batch of batches) {
    const claimed: IdentityClaim[] = !identityHeld(batch) ? [] : ((batch.data.providerIdentityReview as { identities?: string[] }).identities ?? [])
      .flatMap((identity) => batches.filter((other) => other.id !== batch.id && claimants.get(identity)?.has(other.id)).map((other) => ({ identity, batchId: other.id, reference: other.reference, handEntered: enteredByHand(other) })));
    if (isDeepStrictEqual(claimed, batch.data.providerIdentityClaimedBy ?? [])) continue;
    if (claimed.length) batch.data.providerIdentityClaimedBy = claimed; else delete batch.data.providerIdentityClaimedBy;
    touch(batch, ctx.now);
  }
  return { held, released, cleared };
}

/** Why a batch held for its provider identity is in variance, and the way out: its batch explanation and its hold's exception's notes. */
export const IDENTITY_HOLD_EXPLANATION = [
  "This batch is on hold: its evidence mixes more than one provider connection, or another batch claims the same payout. Its totals and links are kept for Finance to review, but it cannot be reconciled yet.",
  `${optionText(providerIdentityConfirmedCode)}: once the providers confirm whose payout this is, Finance or an Admin resolves its exception with it and chooses that connection. The next reconciliation keeps that connection’s evidence in the batch and moves other connections’ evidence to their own batches.`,
  "If the providers cannot say which connection it belongs to, the exception stays open until the data owner corrects the evidence. The next reconciliation then releases the batch.",
  "Running reconciliation again, or importing the batch again, does not lift this hold.",
].join("\n");

/** Why an open exception of a batch that left variance stays open: the reports it was raised for, or carries, that only Finance settles. */
export function stillReported(exception: TypedRecord<"exceptions">): string {
  const [, , report] = String(exception.data.condition ?? "").split(":");
  const countedTwice = countedTwiceReports(exception).length > 0 || report === "line" || report === "counted", otherCurrency = otherCurrencyReports(exception).length > 0 || report === "currency";
  return `${countedTwice ? " It stays open for the collection the provider reports in two batches: resolve it once you have checked both payouts with the provider." : ""}${otherCurrency ? " It stays open for the settlement line in a different currency from the batch: resolve it once you have checked with the provider which batch pays it out." : ""}`;
}

/** What the audit entry adds for settlement batches released from an earlier build's provider identity hold: each batch, its connection and the lines it held meanwhile. */
export function releasedBatchesNote(released: readonly IdentityRelease[]): string | undefined {
  const automatic = released.filter((item) => item.confirmedBy === undefined);
  const notes = released.filter((item) => item.confirmedBy !== undefined).map(confirmedReleaseNote);
  const lines = ({ held }: IdentityRelease) => held.length ? `; ${counted(held.length, "settlement line")} held meanwhile ${held.length === 1 ? "is" : "are"} now counted as new lines` : "";
  if (automatic.length === 1) notes.push(`Released settlement batch ${automatic[0]!.batch.reference} from its provider identity hold: all its evidence now comes from ${automatic[0]!.connection}, and no other batch claims it${lines(automatic[0]!)}.`);
  else if (automatic.length) {
    const named = automatic.slice(0, 3).map((item) => `${item.batch.reference} (${item.connection}${lines(item)})`);
    const more = automatic.length > 3 ? `; and ${counted(automatic.length - 3, "more", "more")}` : "";
    notes.push(`Released ${counted(automatic.length, "settlement batch", "settlement batches")} from their provider identity holds: all the evidence of each now comes from one provider connection, and no other batch claims it: ${named.join("; ")}${more}.`);
  }
  return notes.join(" ") || undefined;
}

/** What the audit entry says of the renewed reviews raised for batches held for their provider identity: each batch and the earlier exception its review names. */
export function identityReviewsNote(state: DomainState, reviews: readonly TypedRecord<"exceptions">[]): string | undefined {
  if (!reviews.length) return undefined;
  const named = reviews.slice(0, 3).map((review) => {
    const batch = recordsWhere(state, "settlement-batches", "id", String(review.data.linkedRecordId))[0];
    const earlier = recordsWhere(state, "exceptions", "id", String((review.data.legacyIdentityReview as { priorExceptionId?: string }).priorExceptionId))[0];
    return `settlement batch ${batch?.reference ?? review.data.linkedRecordId} (exception ${earlier?.reference || earlier?.id} ${earlier?.data.resolutionCode ? `resolved as ${optionText(earlier.data.resolutionCode)}` : "closed"})`;
  });
  const more = reviews.length > 3 ? `; and ${counted(reviews.length - 3, "more", "more")}` : "";
  return `Raised a renewed Finance review for ${counted(reviews.length, "settlement batch", "settlement batches")} still on hold for ${reviews.length === 1 ? "its" : "their"} provider identity. Valo Pay had closed ${reviews.length === 1 ? "its hold’s exception" : "their holds’ exceptions"} earlier without confirming whose payout the batch is, and that decision stands: ${named.join("; ")}${more}.`;
}

/** What the audit entry says of a batch released as the identity Finance confirmed (confirmIdentity): the batch, the connection, who confirmed it and when, and the evidence of other connections it moved out. */
function confirmedReleaseNote(release: IdentityRelease): string {
  const references = (items: readonly ValopayRecord[]) => `${items.slice(0, 3).map((item) => item.reference).join(", ")}${items.length > 3 ? ` and ${counted(items.length - 3, "more", "more")}` : ""}`;
  const was = (items: readonly unknown[]) => (items.length === 1 ? "was" : "were");
  const { detached = [], credits = [], held } = release;
  const moved = [
    detached.length ? `${counted(detached.length, "settlement line")} of another connection (${references(detached)}) ${was(detached)} moved out, to be counted as new lines in their own connection’s batch` : "",
    credits.length ? `${counted(credits.length, "statement credit")} of another connection (${references(credits)}) ${was(credits)} left to link to their own batch` : "",
    held.length ? `${counted(held.length, "settlement line")} held meanwhile ${held.length === 1 ? "is" : "are"} now counted as new lines` : "",
  ].filter(Boolean);
  const confirmedAt = Date.parse(String(release.confirmedAt));
  return `Released settlement batch ${release.batch.reference} as the payout of ${release.connection}, which ${release.confirmedBy} confirmed${Number.isFinite(confirmedAt) ? ` on ${dayText(confirmedAt)}` : ""}${moved.length ? `: ${moved.join(", and ")}` : ""}.${release.totalsKept ? " Its amounts before fees, fee and after fees were typed by hand, so they were left as typed. Only the expected fee of the lines that moved was taken out: check that the typed amounts leave those lines out too." : ""}`;
}
