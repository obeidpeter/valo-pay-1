/** Canonical payment evidence, Finance decisions and observation indexes scoped to one reconciliation pass. */
import { type TypedRecord, type DomainState, type Context } from "./types";
import { evidenceConflict as conflictOf, statedGross } from "./evidence-agreement";
import { connectionOf, currencyOf, UNSEEN_REVERSAL_AGE_MS, channelFor, connectionKey } from "./reconciliation-values";
import { moneyText, heldEvidenceCondition, isOpenException, resolveExceptionType, heldEvidenceOf, unseenReversalCondition, unseenReversalCodes, heldEvidenceCodes, evidenceSourceText, instantText, optionText } from "@workspace/valopay-schema";
import { datedUpdate, raiseException } from "./reconciliation-exceptions";
import { addBusinessDays } from "./calendar";
import { touch, recordsOf, makeRecord } from "./records";
import { indexedPass, recordsWhere, recordsOfKind } from "./record-index";
import { latestEvidenceResolution } from "./reversal-review";
import { REVERSAL_HOLD_RULE } from "./reconciliation-reversal-holds";
import { SettlementLines, completeLineGross, settlementBatch } from "./reconciliation-settlement";
import { paymentDimensions, settlePaymentStatus, reversePayment } from "./reconciliation-payments";

/** ING-03 and ING-05: why evidence under a payment's key is someone else's money (evidence-agreement), with the payers this pass ties the payment to. */
const evidenceConflict = (payment: TypedRecord<"payments">, observation: TypedRecord<"observations">, index: CanonicalPaymentIndex): string | undefined =>
  conflictOf(payment, observation, (item) => index.tiedPayers(item));

/** Evidence that reports a reversal of the payment it names. */
export const reportsReversal = (observation: TypedRecord<"observations">): boolean => observation.data.reversed === true || observation.data.reversalStatus === "reversed";

/**
 * Decision on evidence Finance must look at before it becomes a payment:
 * evidence that disagrees with the payment its key names (evidenceConflict),
 * or evidence through a connection where no payment has its reference while
 * another connection's payment does (a disputes or settlement report may spell
 * the connection another way). Neither is merged or dropped: the evidence
 * stays unresolved with a suspected_duplicate exception that names the
 * payment, and the connections when they differ, and says what each resolution
 * does. Evidence held only because of its connection (`connectionOnly`) can be
 * joined to that payment as more evidence of it (same_payment); any held
 * evidence can be set aside as not money (not_money). An open hold follows its
 * evidence: when the hold as it stands now differs from the condition its
 * exception records (the payment changed, or an earlier build recorded it
 * otherwise), the exception takes the current condition and a dated line says
 * where the hold now stands, so it offers the codes that apply now. Returns
 * that exception and the payment, or undefined when no payment has its
 * reference.
 */
function holdForReview(state: DomainState, ctx: Context, observation: TypedRecord<"observations">, candidates: TypedRecord<"payments">[], payments: CanonicalPaymentIndex, gross: number): { exception: TypedRecord<"exceptions">; other: TypedRecord<"payments">; connectionOnly: boolean } | undefined {
  const other = candidates[0] ?? payments.withReference(observation)[0];
  if (!other) return undefined;
  const ref = observation.reference, source = String(observation.data.source), reversal = reportsReversal(observation);
  const conflict = evidenceConflict(other, observation, payments), connectionOnly = !candidates.length && !conflict;
  const through = connectionOf(state, observation), otherThrough = connectionOf(state, other);
  const what = `${reversal ? "Reversal evidence" : "Payment evidence"} ${ref} (${moneyText(gross, currencyOf(observation))}, from ${evidenceSourceText(source)})`;
  // A reversal never becomes a payment of its own, which would only be reversed at once.
  const kept = reversal ? "It was not recorded against that payment. It reports a reversal, so no payment is made from it." : `It was not added to that payment${candidates.length ? "" : ", and no payment was made from it"}.`;
  const lead = candidates.length
    ? `${what} shares its provider reference with payment ${other.reference}, but ${conflict}. ${kept}`
    : `${what} came through ${through}. No payment there has its reference, but payment ${other.reference} came through ${otherThrough}${conflict ? `, and ${conflict}` : ""}. ${kept}`;
  // The note in three parts: what happened, each choice on its own line, then what happens next.
  const choices = reversal
    ? [
      ...(connectionOnly ? [`${optionText(heldEvidenceCodes.samePayment)}: it reverses payment ${other.reference}. It is recorded against that payment, which is reversed, and later evidence through ${through} finds that payment too.`] : []),
      `${connectionOnly ? "Any other resolution" : "Any resolution, once you have checked it"}: it is set aside and reverses nothing, even if its payment appears later.`,
    ]
    : [
      ...(connectionOnly ? [`${optionText(heldEvidenceCodes.samePayment)}: it is more evidence of payment ${other.reference}, with its connection spelled another way. It is added to that payment, and later evidence through ${through} finds that payment too.`] : []),
      `${optionText(heldEvidenceCodes.notMoney)}: it records no money. It is set aside, and no payment is made from it.`,
      `${optionText("distinct_payments")}: it is money of its own${candidates.length ? "" : ` through ${through}`}. It is recorded as a separate payment.`,
      `${optionText("confirmed_duplicate_refund")}: the payer was charged twice. It is recorded as a separate payment, held until its refund is recorded.`,
    ];
  const notes = [lead, "Resolve this exception as one of these:", ...choices, "The next reconciliation carries out your choice."].join("\n");
  const condition = heldEvidenceCondition(observation.id, other.id, connectionOnly);
  const exception = raiseException(state, ctx, "suspected_duplicate", { linkedRecordId: observation.id, customerId: observation.customerId, amountKobo: gross, notes, condition });
  if (isOpenException(exception.status) && exception.data.condition !== condition) {
    exception.data.condition = condition;
    exception.data.notes = `${exception.data.notes ? `${exception.data.notes}\n` : ""}${datedUpdate(ctx, `the hold now stands as follows.\n${notes}`)}`;
    touch(exception, ctx.now);
  }
  return { exception, other, connectionOnly };
}

/**
 * Decision on the codes held evidence offers: an open hold is re-derived from
 * its evidence as it stands now (holdForReview) by every reconciliation,
 * before resolve_exception checks the code Finance chose, and after every
 * action that can change the payment a hold names. So same_payment is offered
 * and accepted only while the hold is for the connection alone, whatever
 * condition an earlier state or an earlier build recorded. `only` limits it to
 * one exception.
 */
export function refreshHeldEvidence(state: DomainState, ctx: Context, only?: TypedRecord<"exceptions">): void {
  const open = (only ? [only] : recordsOf(state, "exceptions")).filter((item) => isOpenException(item.status) && resolveExceptionType(item.data.type) === "suspected_duplicate" && heldEvidenceOf(item.data.condition));
  if (!open.length) return;
  indexedPass(state, () => {
    const payments = new CanonicalPaymentIndex(state);
    for (const exception of open) {
      const observation = recordsWhere(state, "observations", "id", String(exception.data.linkedRecordId))[0];
      if (!observation || observation.status !== "unresolved") continue;
      const candidates = payments.candidates(observation);
      const own = candidates.find((item) => !evidenceConflict(item, observation, payments));
      if (!own) { holdForReview(state, ctx, observation, candidates, payments, statedGross(observation).kobo); continue; }
      // Evidence that now agrees with a payment under its own key resolves to it at the next reconciliation; until then the
      // join its exception offers stands only while it still agrees with the payment the exception names.
      const held = heldEvidenceOf(exception.data.condition)!, named = payments.payment(held.paymentId);
      const conflict = named ? evidenceConflict(named, observation, payments) : "that payment is no longer recorded";
      if (!held.connectionOnly || !conflict) continue;
      exception.data.condition = heldEvidenceCondition(observation.id, held.paymentId, false);
      exception.data.notes = `${exception.data.notes ? `${exception.data.notes}\n` : ""}${datedUpdate(ctx, `the hold now stands as follows. Payment evidence ${observation.reference} no longer agrees with payment ${named?.reference ?? observation.reference}: ${conflict}. It cannot be added to that payment. The next reconciliation records it as evidence of payment ${own.reference}, which has its reference through ${connectionOf(state, own)}, unless you resolve this exception first.`)}`;
      touch(exception, ctx.now);
    }
  });
}

/**
 * Decision on a reversal reported for a payment no connection has seen: it is
 * never made a payment only to be reversed. It stays unresolved, waiting for
 * its payment: the reconciliation that sees a payment with its reference
 * applies it through its key, or holds it for Finance when that payment came
 * through another connection. Once it has waited UNSEEN_REVERSAL_AGE_MS since
 * the time its evidence gives, a Finance-owned provider_status_mismatch
 * exception says the provider reported a reversal of a payment the platform
 * has not seen, and what each resolution does (financeDecision).
 */
function awaitReversedPayment(state: DomainState, ctx: Context, observation: TypedRecord<"observations">, gross: number): void {
  // The time its evidence gives, else when it was recorded; a time that does not read as one never stops the close.
  const since = [observation.data.occurredAt, observation.createdAt].map((value) => Date.parse(String(value))).find(Number.isFinite) ?? Date.parse(ctx.now);
  if (Date.parse(ctx.now) - since < UNSEEN_REVERSAL_AGE_MS) return;
  // The note in three parts: what happened, each choice on its own line, then what happens next.
  raiseException(state, ctx, "provider_status_mismatch", {
    linkedRecordId: observation.id, customerId: observation.customerId, amountKobo: gross, owner: "Finance", linkedKind: "observations", condition: unseenReversalCondition(observation.id),
    notes: [
      `The provider reported a reversal of payment ${observation.reference} (${moneyText(gross, currencyOf(observation))}, from ${evidenceSourceText(observation.data.source)}) through ${connectionOf(state, observation)} on ${instantText(since)}. No payment with that reference has come through any connection, so there is nothing to reverse yet, and no payment is made from it. The reconciliation that records the payment reverses it through the same connection, or holds it for you if the payment came through another.`,
      "Ask the provider which collection it reverses, and leave this exception open while you check. If the payment arrives meanwhile, the reversal is recorded against it and this exception closes.",
      "Resolve this exception as one of these:",
      `${optionText(unseenReversalCodes.setAside)}: the provider says it reverses nothing of this lender’s. It is set aside and reverses nothing, even if its payment arrives later.`,
      `${optionText(unseenReversalCodes.adopted)}: the provider confirms the reversal. It keeps waiting for its payment, with no new exception, and reverses the payment when it arrives, whichever way its connection is spelled.`,
      "The next reconciliation carries out your choice.",
    ].join("\n"),
  });
}

/** Held evidence Finance resolved without making it a payment: it is resolved to its exception, never to a payment. */
function setAside(ctx: Context, observation: TypedRecord<"observations">, exception: TypedRecord<"exceptions">, resolutionKey: string): void {
  observation.status = "resolved";
  observation.data.resolvedTo = `exception:${exception.id}`;
  observation.data.resolutionKey = resolutionKey;
  touch(observation, ctx.now);
}

/** What Finance's resolution of evidence decides for it (financeDecision). */
interface FinanceDecision {
  exception: TypedRecord<"exceptions">;
  /** Earlier builds assigned conflicting meanings to unversioned decisions. Neither meaning is safe to infer. */
  needsReview?: boolean;
  /** Set aside for good: no payment is made from it, and it is applied to none. */
  setAside?: boolean;
  /** The payment its hold named, while the evidence still agrees with it: it is joined to that payment. */
  join?: TypedRecord<"payments">;
  /** A payment of its own. */
  separate?: { paymentId: string; exceptionId: string; resolutionCode: string };
  /** A reversal Finance adopted: it keeps waiting, and reverses its payment through any spelling of the connection. */
  adopted?: boolean;
}

/** Several releases omitted the marker, so absence cannot identify a historical rule. */
const earlierResolution = (exception: TypedRecord<"exceptions">): boolean => exception.data.resolutionRuleVersion === undefined;

/**
 * What one resolved exception of a piece of evidence decides for it (see
 * financeDecision). `other` is the payment a hold names when its exception
 * records no held-evidence condition, as one written by hand may not.
 */
function decisionOf(exception: TypedRecord<"exceptions">, observation: TypedRecord<"observations">, payments: CanonicalPaymentIndex, other?: TypedRecord<"payments">): FinanceDecision {
  const code = String(exception.data.resolutionCode);
  if (resolveExceptionType(exception.data.type) === "provider_status_mismatch") return earlierResolution(exception) ? { exception, needsReview: true } : code === unseenReversalCodes.setAside ? { exception, setAside: true } : { exception, adopted: code === unseenReversalCodes.adopted };
  const paymentId = heldEvidenceOf(exception.data.condition)?.paymentId ?? other?.id ?? "", named = payments.payment(paymentId);
  if (code === heldEvidenceCodes.samePayment) return { exception, join: named && !evidenceConflict(named, observation, payments) ? named : undefined };
  if (reportsReversal(observation) || code === heldEvidenceCodes.notMoney) return { exception, setAside: true };
  return { exception, separate: { paymentId, exceptionId: exception.id, resolutionCode: code } };
}

/**
 * Decision on a Finance resolution already recorded for evidence: its latest
 * resolution, of a suspected_duplicate that held it or of the
 * provider_status_mismatch raised while its reversal waited for a payment no
 * connection had seen, decides what happens to it before any payment is looked
 * up, whatever order and pass the evidence and its payment arrive in. Held
 * evidence resolved as the same payment joins the payment its exception names
 * only while the hold is still for the connection alone, the evidence agreeing
 * with that payment; otherwise it is looked at afresh, and held again. Resolved
 * as not money it is set aside for good, and resolved any other way it becomes
 * a payment of its own, except evidence of a reversal, which is set aside. A
 * waiting reversal resolved as platform state confirmed is set aside for good;
 * resolved as provider state adopted it keeps waiting, with no new exception,
 * and reverses its payment when that arrives, through any spelling of the
 * connection. An unversioned resolution has ambiguous historical meaning and
 * requires a new explicit review; the old decision remains unchanged. Undefined when
 * Finance has resolved neither.
 */
function financeDecision(state: DomainState, observation: TypedRecord<"observations">, payments: CanonicalPaymentIndex): FinanceDecision | undefined {
  const latest = latestEvidenceResolution(state, observation);
  return latest && decisionOf(latest, observation, payments);
}

/** Quarantine ambiguous persisted decisions without rewriting either the decision or its previous disposition. */
export function reviewEarlierReversalDecisions(state: DomainState, ctx: Context): TypedRecord<"exceptions">[] {
  const payments = new CanonicalPaymentIndex(state);
  for (const observation of recordsOf(state, "observations").filter(reportsReversal)) {
    const decision = financeDecision(state, observation, payments);
    if (!decision?.needsReview) continue;
    const condition = `${unseenReversalCondition(observation.id)}:review:${decision.exception.id}`;
    let review = recordsWhere(state, "exceptions", "data.linkedRecordId", observation.id).find((item) => item.data.condition === condition);
    if (review) continue;
    const notes = [
      `An earlier decision on reversal ${observation.reference} (exception ${decision.exception.reference || decision.exception.id}) was recorded as ${optionText(decision.exception.data.resolutionCode)} without a rule version. Earlier releases gave that choice different meanings, so Valo Pay cannot tell whether to record the reversal against its payment or set it aside. The earlier decision, and what happened to the evidence, stay on record.`,
      "Check the provider’s evidence, then resolve this review as one of these:",
      `${optionText(unseenReversalCodes.adopted)}: the reversal is recorded against its payment.`,
      `${optionText(unseenReversalCodes.setAside)}: reversal evidence not yet recorded against a payment is set aside.`,
      `Allocations and reversals already recorded do not change until you decide. ${REVERSAL_HOLD_RULE} After that reconciliation, check any earlier effects.`,
    ].join("\n");
    // Do not let an old resolution without a condition suppress this new review.
    review = recordsWhere(state, "exceptions", "data.linkedRecordId", observation.id).find((item) => isOpenException(item.status) && resolveExceptionType(item.data.type) === "provider_status_mismatch")
      ?? makeRecord(state, "exceptions", { name: "Review earlier reversal decision", status: "open", customerId: observation.customerId, amountKobo: statedGross(observation).kobo, createdAt: ctx.now, data: { type: "provider_status_mismatch", owner: "Finance", severity: "high", slaBusinessDays: 1, dueBy: addBusinessDays(state, ctx.now, 1), linkedRecordId: observation.id, linkedKind: "observations", ...(currencyOf(observation) !== "NGN" ? { currency: currencyOf(observation) } : {}) } });
    Object.assign(review.data, { condition, notes, owner: "Finance", severity: "high", legacyResolutionReview: {
      priorExceptionId: decision.exception.id,
      priorObservation: { status: observation.status, resolutionKey: observation.data.resolutionKey ?? null, resolvedTo: observation.data.resolvedTo ?? null, paymentId: observation.data.paymentId ?? null },
    } });
    touch(review, ctx.now);
  }
  const reviews = recordsOf(state, "exceptions").filter((item) => item.data.legacyResolutionReview);
  for (const review of reviews.filter((item) => !isOpenException(item.status) && !earlierResolution(item))) {
    const observation = recordsWhere(state, "observations", "id", String(review.data.linkedRecordId))[0];
    // A prior applied reversal is historical financial activity, never silently undone. An earlier set-aside
    // disposition may be reconsidered only by this newly authorised decision; its snapshot stays on the review.
    if (!observation || observation.data.paymentId || observation.data.legacyReversalReviewAppliedId === review.id) continue;
    observation.status = "unresolved";
    observation.data.legacyReversalReviewAppliedId = review.id;
    touch(observation, ctx.now);
  }
  return reviews;
}

/**
 * ING-03: every observation resolves to one canonical Payment by its key, the
 * provider connection and reference, so the same reference through another
 * connection is another payment once Finance says so; the batch leg of a
 * statement never becomes a customer Payment. A resolution Finance has
 * recorded for the evidence decides first (financeDecision). Evidence Finance
 * must look at (holdForReview) stays unresolved with a suspected_duplicate
 * exception until Finance resolves it, and a reversal of a payment no
 * connection has seen waits for it (awaitReversedPayment).
 */
export function canonicalPayment(state: DomainState, ctx: Context, observation: TypedRecord<"observations">, payments: CanonicalPaymentIndex, lines: SettlementLines): TypedRecord<"payments"> | undefined {
  const source = String(observation.data.source);
  const ref = observation.reference;
  if (source === "statement" && (observation.data.batchReference || observation.data.resolutionKey === "batch")) return undefined;
  const { kobo: gross, atLeast } = statedGross(observation);
  const reversal = reportsReversal(observation);
  let decision = financeDecision(state, observation, payments), prior: TypedRecord<"payments"> | undefined, key: string | undefined;
  if (decision?.needsReview) return undefined;
  if (!decision?.setAside && !decision?.join && !decision?.separate) {
    const candidates = payments.candidates(observation);
    prior = candidates.find((item) => !evidenceConflict(item, observation, payments));
    // A reversal Finance adopted reverses its payment through another spelling of the connection too, with no hold.
    const named = !prior && !candidates.length && decision?.adopted ? payments.withReference(observation)[0] : undefined;
    if (named && !evidenceConflict(named, observation, payments)) { prior = named; key = "adopted_after_review"; }
    decision = undefined;
    if (!prior) {
      const held = holdForReview(state, ctx, observation, candidates, payments, gross);
      if (!held && reversal) { awaitReversedPayment(state, ctx, observation, gross); return undefined; }
      if (held && isOpenException(held.exception.status)) return undefined;
      // An earlier resolution of this very hold stands where the latest one no longer applies.
      if (held) decision = decisionOf(held.exception, observation, payments, held.other);
      if (decision && !decision.setAside && !decision.join && !decision.separate) return undefined;
    }
  }
  if (decision?.setAside) {
    setAside(ctx, observation, decision.exception, reversal ? "reversal_set_aside_after_review" : "set_aside_after_review");
    return undefined;
  }
  if (decision?.join) { prior = decision.join; key = "joined_after_review"; }
  const separate = decision?.separate;
  // Evidence Finance joined to a payment keys it under the evidence's connection too, so later evidence through either finds it.
  if (prior && key) payments.addConnection(prior, connectionOf(state, observation));
  const observedAt = String(observation.data.occurredAt || observation.createdAt);
  const payment = prior || makeRecord(state, "payments", {
    name: `Payment ${ref}`, status: "unallocated", reference: ref, customerId: observation.customerId, createdAt: ctx.now,
    amountKobo: gross,
    data: {
      providerReference: ref, providerConnection: connectionOf(state, observation), currency: currencyOf(observation), channel: channelFor(source),
      narration: observation.data.narration, virtualAccountCustomerId: observation.data.virtualAccountCustomerId, dueItemId: observation.data.dueItemId,
      observedAt, collectionStatus: source === "webhook" ? "succeeded" : "received", settlementStatus: "unsettled", reversalStatus: "none", refundStatus: "none",
      allocatedKobo: 0, canonical: true, ...(atLeast ? { grossUnstated: true } : {}), ...(separate ? { evidenceConflict: separate } : {}),
    },
  });
  if (!prior) payments.add(payment);
  if (separate?.resolutionCode === "confirmed_duplicate_refund") {
    payment.status = "possible_duplicate";
    payment.data.explanation = `Finance confirmed this evidence duplicates payment ${payments.payment(separate.paymentId)?.reference ?? ref}. It is held until its refund is recorded.`;
  }
  paymentDimensions(payment);
  // A settlement line's net made this payment; the debit's own gross completes it. What the gross adds to money
  // already applied is unapplied money for Finance, so the payment's status follows it.
  if (prior && !atLeast && payment.data.grossUnstated === true) {
    const previous = payment.amountKobo, raised = gross > previous;
    payment.amountKobo = Math.max(previous, gross); delete payment.data.grossUnstated;
    if (raised && Number(payment.data.allocatedKobo || 0) > 0) settlePaymentStatus(state, ctx, payment);
    completeLineGross(state, ctx, payment, previous, lines);
  }
  if (!payment.data.observedAt || Date.parse(observedAt) < Date.parse(String(payment.data.observedAt))) payment.data.observedAt = observedAt;
  if (!payment.customerId && observation.customerId) payment.customerId = observation.customerId;
  // The instalment evidence names is kept only while it is the payer's.
  if (!payment.data.dueItemId && observation.data.dueItemId && (!payment.customerId || payments.dueCustomer(observation.data.dueItemId) === payment.customerId)) payment.data.dueItemId = observation.data.dueItemId;
  if (observation.data.narration) payment.data.narration = observation.data.narration;
  if (observation.data.virtualAccountCustomerId) payment.data.virtualAccountCustomerId = observation.data.virtualAccountCustomerId;
  if (source === "webhook") payment.data.collectionStatus = "succeeded";
  if (source === "settlement") {
    payment.data.settlementStatus = "settled";
    payment.data.settledAt ||= observedAt;
    // A settlement line pays out a debit that was collected, so it succeeded even when its webhook never arrived.
    if (payment.data.channel === "direct_debit" && payment.data.collectionStatus !== "failed") payment.data.collectionStatus = "succeeded";
    settlementBatch(state, ctx, observation, payment, lines);
  }
  if (reversal) reversePayment(state, ctx, payment);
  observation.status = "resolved";
  observation.data.paymentId = payment.id;
  observation.data.resolutionKey = key ?? (prior ? "canonical_provider_reference" : separate ? "separate_payment_after_review" : "new_canonical_provider_reference");
  touch(observation, ctx.now); touch(payment, ctx.now);
  return payment;
}

/**
 * Canonical payments by their key, the provider connection and a reference
 * (the payment's reference or its provider reference). Lookups keep the
 * first-record-wins semantics across colliding keys, including legacy rows. A
 * key holds more than one payment once Finance has said conflicting evidence
 * is money of its own. New payments are registered as they are made, so
 * repeated evidence in one run resolves to one payment. A payment is also
 * keyed on the connections of the evidence resolved to it: an earlier build
 * keyed a payment on its evidence's provider (or the lender's), whatever
 * connection the evidence named, and Finance may join evidence through
 * another connection to a payment (same_payment), so later evidence through
 * that connection still finds it.
 */
export class CanonicalPaymentIndex {
  private byKey = new Map<string, TypedRecord<"payments">[]>();
  private byReference = new Map<string, TypedRecord<"payments">[]>();
  private byId = new Map<string, TypedRecord<"payments">>();
  private order = new Map<string, number>();
  private dues?: Map<string, TypedRecord<"due-items">>;
  constructor(private state: DomainState) {
    const evidenceConnections = new Map<string, Set<string>>();
    for (const observation of recordsOfKind(state, "observations")) {
      if (observation.status !== "resolved" || typeof observation.data.paymentId !== "string") continue;
      const connections = evidenceConnections.get(observation.data.paymentId) ?? new Set<string>();
      evidenceConnections.set(observation.data.paymentId, connections.add(connectionKey(connectionOf(state, observation))));
    }
    for (const payment of recordsOf(state, "payments")) this.add(payment, evidenceConnections.get(payment.id));
  }
  private key(connection: string, reference: unknown) { return `${connectionKey(connection)}\u0000${String(reference)}`; }
  add(payment: TypedRecord<"payments">, evidenceConnections: Iterable<string> = []) {
    this.order.set(payment.id, this.order.size);
    this.byId.set(payment.id, payment);
    const connections = new Set([connectionKey(connectionOf(this.state, payment)), ...evidenceConnections]);
    for (const reference of new Set([payment.reference, payment.data.providerReference].filter(Boolean))) {
      for (const connection of connections) {
        const key = this.key(connection, reference);
        this.byKey.set(key, [...(this.byKey.get(key) ?? []), payment]);
      }
      this.byReference.set(String(reference), [...(this.byReference.get(String(reference)) ?? []), payment]);
    }
  }
  /** Keys a payment under another connection too, once Finance joined evidence through it to the payment, so later evidence in this pass finds it. */
  addConnection(payment: TypedRecord<"payments">, connection: string) {
    for (const reference of new Set([payment.reference, payment.data.providerReference].filter(Boolean))) {
      const key = this.key(connection, reference), group = this.byKey.get(key) ?? [];
      if (!group.includes(payment)) this.byKey.set(key, [...group, payment]);
    }
  }
  /** The payments an observation's key names, with one it names by id, first made first. */
  candidates(observation: TypedRecord<"observations">): TypedRecord<"payments">[] {
    const named = this.byId.get(String(observation.data.paymentId));
    const group = this.byKey.get(this.key(connectionOf(this.state, observation), observation.reference)) ?? [];
    return [...new Set(named ? [named, ...group] : group)].sort((a, b) => this.order.get(a.id)! - this.order.get(b.id)!);
  }
  /** The payments with an observation's reference under any connection, first made first: for evidence its own key finds none of, the ones another connection holds. */
  withReference(observation: TypedRecord<"observations">): TypedRecord<"payments">[] {
    if (!observation.reference) return [];
    return [...new Set(this.byReference.get(observation.reference) ?? [])].sort((a, b) => this.order.get(a.id)! - this.order.get(b.id)!);
  }
  /** A payment by id. */
  payment(id: string): TypedRecord<"payments"> | undefined { return this.byId.get(id); }
  /** The customer of an instalment, by id. */
  dueCustomer(id: unknown): string | undefined {
    this.dues ??= new Map(recordsOf(this.state, "due-items").map((due) => [due.id, due]));
    return this.dues.get(String(id))?.customerId;
  }
  /** The payers of the instalments a payment with no payer is tied to: the one its evidence names and the one it is proposed for. */
  tiedPayers(payment: TypedRecord<"payments">): string[] {
    return [payment.data.dueItemId, payment.data.proposedDueItemId].map((id) => (id ? this.dueCustomer(id) : undefined)).filter((customerId): customerId is string => !!customerId);
  }
}
