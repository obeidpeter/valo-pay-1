/** The ordered matching rule ladder for canonical payments; allocation decisions remain in the payment workflow. */
import { type DomainState, type Context, type TypedRecord } from "./types";
import { MatchIndex, intendedDueItem, eligibleForAutomaticMatching, narrationInstalments } from "./reconciliation-matching-index";
import { paymentReturned, connectionOf, currencyOf, identityCondition, outstanding, paymentObservedAt, DUPLICATE_WINDOW_MS, connectionKey, DAY_MS } from "./reconciliation-values";
import { paymentUnappliedKobo, paymentRefundedKobo, nairaText, valueWords } from "@workspace/valopay-schema";
import { rejectedMatches, allocatePayment } from "./reconciliation-payments";
import { touch } from "./records";
import { raiseException } from "./reconciliation-exceptions";

/** How rule R1 found a payment's instalment, in words for its explanation. */
const matchedThrough: Record<string, string> = {
  attempt_provider_reference: "through its collection attempt’s provider reference", attempt_reference: "through its collection attempt’s reference", observation_due_item: "because its payment evidence names that instalment",
};

/** Section 7.2 rule ladder, applied to canonical Payments, never to observations. A payment with nothing to allocate, such as one an earlier build made from a line whose gross was 0, is left alone. */
export function matchPayment(state: DomainState, ctx: Context, payment: TypedRecord<"payments">, index: MatchIndex): void {
  if (payment.status !== "unallocated" || paymentReturned(payment) || paymentUnappliedKobo(payment) === 0) return;
  if (Array.isArray(payment.data.legacyReversalReviewIds) && payment.data.legacyReversalReviewIds.length) return;
  const connection = connectionOf(state, payment), currency = currencyOf(payment);
  const rejected = rejectedMatches(payment);
  const intended = intendedDueItem(state, payment, index);
  // A payment left for Finance is rewritten only when its explanation changes, so a daily close does not rewrite it every day.
  const leaveForFinance = (explanation: string) => {
    if (payment.data.explanation === explanation) return;
    payment.data.explanation = explanation;
    touch(payment, ctx.now);
  };
  // Decision on R1's currency and connection: such a payment stays unallocated, with an exception for Finance.
  const holdForFinance = (explanation: string) => {
    leaveForFinance(explanation);
    raiseException(state, ctx, "unallocated_payment", { linkedRecordId: payment.id, customerId: payment.customerId, amountKobo: paymentUnappliedKobo(payment), notes: explanation, condition: identityCondition("unallocated_payment", payment.id) });
  };
  // Instalments are owed in naira: money in another currency is never matched, by any rule.
  if (currency !== "NGN") {
    holdForFinance(`Payment ${payment.reference} is in ${currency} and came through ${connection}. Instalments are owed in naira, so it cannot be matched or allocated to one. Record its refund, or resolve it with Finance.`);
    return;
  }
  // The rules compare the gross amount, which a payment refunded in part no longer holds.
  const refunded = paymentRefundedKobo(payment);
  if (refunded > 0) {
    leaveForFinance(`A refund returned ${nairaText(refunded)} of this payment. Automatic matching leaves the ${nairaText(paymentUnappliedKobo(payment))} it still holds for Finance to allocate.`);
    return;
  }
  // Finance's "this is the wrong instalment" stands: a strong reference to a
  // rejected instalment is not matched anywhere else automatically either.
  if (intended && rejected.has(intended.due.id)) {
    leaveForFinance(`Finance said this payment does not belong to instalment ${intended.due.reference}. It stays unallocated for Finance to allocate.`);
    return;
  }
  // Finance resolved a suspected duplicate as a separate payment: it is not held again for the same reason.
  const distinct = payment.data.duplicateReview?.resolutionCode === "distinct_payments";
  // ING-05 (b): a second Payment for a due item that is already paid is held, never allocated.
  if (intended && outstanding(intended.due) === 0 && !distinct) {
    payment.status = "possible_duplicate";
    payment.data.explanation = `Instalment ${intended.due.reference} is already paid, so this second payment is held for Finance to review.`;
    raiseException(state, ctx, "suspected_duplicate", { linkedRecordId: payment.id, customerId: payment.customerId, amountKobo: payment.amountKobo, notes: payment.data.explanation });
    return;
  }
  // ING-05 (a): the later of two near-identical Payments from the same payer inside two minutes is held, never allocated.
  const observedBefore = (item: TypedRecord<"payments">) => {
    const delta = paymentObservedAt(item) - paymentObservedAt(payment);
    return delta < 0 || (delta === 0 && `${item.createdAt}${item.id}` < `${payment.createdAt}${payment.id}`);
  };
  const twin = !distinct && (index.paymentsByCustomer.get(payment.customerId) ?? []).find((item) =>
    item.id !== payment.id && item.reference !== payment.reference && payment.customerId && item.customerId === payment.customerId &&
    item.amountKobo === payment.amountKobo && item.status !== "possible_duplicate" && !paymentReturned(item) &&
    observedBefore(item) && paymentObservedAt(payment) - paymentObservedAt(item) <= DUPLICATE_WINDOW_MS,
  );
  if (twin) {
    payment.status = "possible_duplicate";
    payment.data.explanation = `This payment is almost the same as payment ${twin.reference} from the same payer, within two minutes. It is held for Finance to review.`;
    raiseException(state, ctx, "suspected_duplicate", { linkedRecordId: payment.id, customerId: payment.customerId, amountKobo: payment.amountKobo, notes: payment.data.explanation });
    return;
  }
  // A strong reference to a stopped instalment must not be redirected to a
  // different obligation, or abort the whole batch at the allocation guard.
  // Keep it in the existing unallocated Finance queue (and its ageing SLA).
  if (intended && !eligibleForAutomaticMatching(intended.due)) {
    leaveForFinance(`Instalment ${intended.due.reference} is ${valueWords(intended.due.status)}, so this payment stays unallocated for Finance to review.`);
    return;
  }
  // R1 needs the lender's own connection: a strong reference seen through another provider is not our debit's evidence.
  if (intended && connectionKey(connection) !== connectionKey(String(state.merchant.provider))) {
    holdForFinance(`Provider reference ${payment.reference} names instalment ${intended.due.reference}, but this payment came through ${connection}, not the lender’s ${state.merchant.provider} connection. It is not matched automatically.`);
    return;
  }
  const dues = (index.duesByCustomer.get(payment.customerId) ?? []).filter((due) => eligibleForAutomaticMatching(due) && !rejected.has(due.id));
  // R1: provider reference, same tenant and connection, NGN, gross amount equals the attempt (due) amount.
  if (intended && payment.amountKobo === intended.due.amountKobo && outstanding(intended.due) >= payment.amountKobo) {
    const matched = `Provider reference ${payment.reference} matches instalment ${intended.due.reference} ${matchedThrough[intended.key] ?? "through its reference"}. The currency and the amount before fees also match.`;
    // Decision on evidence with no payer: R1 proposes it, and Finance's confirmation identifies the payer.
    if (!payment.customerId) allocatePayment(state, ctx, payment, intended.due, payment.amountKobo, "R1", "probable", false, `${matched} The payment evidence names no payer, so Finance confirms the payer before it is allocated.`);
    else allocatePayment(state, ctx, payment, intended.due, payment.amountKobo, "R1", "certain", true, matched);
    return;
  }
  // R2: dedicated virtual account, exact amount of the oldest outstanding due item.
  const virtualAccountDues = dues.filter((due) => String(payment.data.virtualAccountCustomerId || "") === due.customerId).sort((a, b) => String(a.data.dueDate).localeCompare(String(b.data.dueDate)));
  if (virtualAccountDues.length && virtualAccountDues[0]!.amountKobo === payment.amountKobo && outstanding(virtualAccountDues[0]!) === payment.amountKobo) {
    allocatePayment(state, ctx, payment, virtualAccountDues[0]!, payment.amountKobo, "R2", "certain", true, "The payment to the customer’s own virtual account equals their oldest outstanding instalment.");
    return;
  }
  // R3: dedicated virtual account, different amount: proposed as partial or overpayment against the oldest outstanding item.
  if (virtualAccountDues.length && payment.amountKobo !== virtualAccountDues[0]!.amountKobo) {
    const oldest = virtualAccountDues[0]!;
    allocatePayment(state, ctx, payment, oldest, Math.min(payment.amountKobo, outstanding(oldest)), "R3", "probable", false, payment.amountKobo < oldest.amountKobo ? "The payment to the customer’s own virtual account is less than their oldest instalment, so it is proposed as a partial payment." : "The payment to the customer’s own virtual account is more than their oldest instalment, so it is proposed with the rest left unallocated.");
    return;
  }
  // R4: an instalment reference in the narration, on word boundaries and the longest where references overlap. It is
  // certain only when the narration names one instalment across the lender, and that one is this payer's, open and
  // owed this amount. A narration naming several, or a reference that is not unique, is never matched automatically.
  const named = narrationInstalments(index, payment.data.narration);
  const [only] = named;
  if (named.length === 1 && dues.includes(only!) && only!.amountKobo === payment.amountKobo && outstanding(only!) >= payment.amountKobo) {
    allocatePayment(state, ctx, payment, only!, payment.amountKobo, "R4", "certain", true, `The payment description contains the unique reference ${only!.reference}, and the amount matches.`);
    return;
  }
  // R5: amount, payer and a five-day window around the due date.
  const near = dues.filter((due) => due.amountKobo === payment.amountKobo && outstanding(due) >= payment.amountKobo && Math.abs(Date.parse(String(due.data.dueDate)) - paymentObservedAt(payment)) <= 5 * DAY_MS);
  if (near.length === 1) allocatePayment(state, ctx, payment, near[0]!, payment.amountKobo, "R5", "probable", false, "The amount and payer match one instalment whose due date is within five days of the payment. Finance must confirm the match.");
}
