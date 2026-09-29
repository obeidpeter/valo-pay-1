/** Retry-rule decisions and ageing of pay-by-bank outcomes that remain unknown. */
import { type DomainState, type Context, type TypedRecord } from "./types";
import { enrolEligibleFailures, approvedPolicyFor, evaluateRetry, recordRetryDecision } from "./policy-engine";
import { recordsOf, touch } from "./records";
import { type ExceptionType, WAT_OFFSET_MS, nairaText, isOpenException } from "@workspace/valopay-schema";
import { raiseException } from "./reconciliation-exceptions";
import { outstanding, UNKNOWN_OUTCOME_AGE_MS, identityCondition } from "./reconciliation-values";

/**
 * Section 6.3, applied by the close to every open obligation under an approved
 * policy: the arm is assigned at the first eligible failure, every decision is
 * recorded (RET-03), give-up rows become exceptions so the LMS can be told
 * (REC-04), and a notice not evidenced by its deadline defers the attempt.
 */
export function applyDecisions(state: DomainState, ctx: Context): { finalFailures: number; disputes: number; decisionsRecorded: number; deferred: number } {
  let finalFailures = 0, disputes = 0, decisionsRecorded = 0, deferred = 0;
  enrolEligibleFailures(state, ctx);
  for (const due of recordsOf(state, "due-items").filter((item) => ["scheduled", "in_collection", "partially_paid"].includes(item.status))) {
    const policy = approvedPolicyFor(state, due);
    if (!policy) continue;
    const decision = evaluateRetry(state, ctx, due, policy);
    if (decision.decision === "not_eligible") continue; // Nothing happened to this item; there is no decision to record.
    if (recordRetryDecision(state, ctx, due, decision)) decisionsRecorded += 1;
    if (decision.decision === "give_up") {
      due.status = "unpaid_final"; due.data.giveUpRule = decision.rule; touch(due, ctx.now);
      const type: ExceptionType = decision.inputs.code === "MANDATE_LIMIT_EXCEEDED" ? "mandate_limit_exceeded" : "unpaid_after_final_attempt";
      raiseException(state, ctx, type, { linkedRecordId: due.id, customerId: due.customerId, amountKobo: outstanding(due), notes: `${due.reference}: ${decision.reason}` });
      finalFailures += 1;
    } else if (decision.decision === "stop" && decision.rule === "customer_disputed") {
      // A debit whose dispute was not upheld, or that Finance released, is dispute_released instead and does not freeze it again.
      due.status = "in_dispute"; touch(due, ctx.now);
      raiseException(state, ctx, "customer_dispute", { linkedRecordId: due.id, customerId: due.customerId, amountKobo: outstanding(due), notes: `${due.reference}: the customer disputed the debit.` });
      disputes += 1;
    } else if (decision.decision === "defer") {
      // One exception per failed attempt whose notice was not evidenced: the deferred slot moves every close, the attempt does not.
      raiseException(state, ctx, "notice_not_evidenced", { linkedRecordId: due.id, customerId: due.customerId, amountKobo: outstanding(due), notes: `${due.reference}: ${decision.reason}`, condition: `notice_not_evidenced:${due.id}:${decision.attemptId ?? ""}` });
      deferred += 1;
    }
  }
  return { finalFailures, disputes, decisionsRecorded, deferred };
}

/** When a pay-by-bank checkout's outcome became unknown: its first unknown event, else its last change. */
export function checkoutUnknownSince(intent: TypedRecord<"connected-intents">): string {
  const events = Array.isArray(intent.data.events) ? intent.data.events : [];
  return String(events.find((event) => event.status === "unknown")?.at ?? intent.updatedAt);
}

/**
 * Item 10: a pay-by-bank checkout whose outcome stays unknown holds its
 * instalment, with no new checkout and no retry. Once it has been unknown for
 * UNKNOWN_OUTCOME_AGE_MS it is an unknown_outcome exception for Finance,
 * linked to the checkout, which names it. Finance records the outcome by
 * resolving it (resolveUnknownCheckout), and a late outcome from the
 * provider clears it. Returns how many checkouts wait that long.
 */
export function ageUnknownCheckouts(state: DomainState, ctx: Context, now: number): number {
  const waiting = recordsOf(state, "connected-intents").filter((intent) => intent.status === "unknown" && now - Date.parse(checkoutUnknownSince(intent)) >= UNKNOWN_OUTCOME_AGE_MS);
  if (!waiting.length) return 0;
  const dues = new Map(recordsOf(state, "due-items").map((due) => [due.id, due]));
  for (const intent of waiting) {
    const since = new Date(Date.parse(checkoutUnknownSince(intent)) + WAT_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");
    const exception = raiseException(state, ctx, "unknown_outcome", {
      linkedRecordId: intent.id, customerId: intent.customerId, amountKobo: intent.amountKobo, owner: "Finance", linkedKind: "connected-intents", condition: identityCondition("unknown_outcome", intent.id),
      notes: `The outcome of the pay-by-bank payment of ${nairaText(intent.amountKobo)} for instalment ${dues.get(String(intent.data.dueItemId))?.reference ?? intent.data.dueItemId} has been unknown since ${since} WAT, for more than 24 hours. Until it is known the instalment is held: no new checkout and no retry is planned. Check with the bank, then resolve this exception as confirmed successful, with the masked reference of the evidence that the money arrived, or as confirmed failed.`,
    });
    if (isOpenException(exception.status) && intent.data.outcomeExceptionId !== exception.id) { intent.data.outcomeExceptionId = exception.id; touch(intent, ctx.now); }
  }
  return waiting.length;
}
