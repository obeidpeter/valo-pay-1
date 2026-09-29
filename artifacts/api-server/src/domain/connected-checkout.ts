/** Synthetic checkout transitions and their narrow Core outcome-resolution interface. */
import { z } from "zod";
import type { ConnectedActionInput as ConnectedAction } from "@workspace/valopay-schema";
import type { Context, DomainState, RecordOf } from "./types";
import { makeRecord, recordsOf, touch } from "./records";
import {
  allocatePayment, clearSettledExceptions, supersedeAllocation, raiseException,
  recordPaymentRefund, reversePayment,
} from "./reconciliation";
import { dueNeedsReversalReview } from "./reversal-review";
import { allow, owned, reject, intentOpen, externalScheduled } from "./connected-context";

/** A step in a checkout's journey: its new status and what happened, in its event history. */
function recordEvent(
  intent: RecordOf<"connected-intents">,
  ctx: Context,
  status: string,
  detail: string,
) {
  intent.status = status;
  intent.data.events!.push({ at: ctx.now, status, detail });
  touch(intent, ctx.now);
  return intent;
}
/**
 * The receipt of a checkout confirmed as paid: the payment and its evidence,
 * applied to the bound instalment while it is open. Money it cannot apply,
 * such as a late payment for an instalment paid another way, waits for
 * Finance with an exception. The server simulator is the only receipt
 * producer, unless Finance confirmed an outcome that stayed unknown with the
 * reference of its evidence: request data never supplies the beneficiary,
 * amount or reference.
 */
function recordCheckoutReceipt(
  state: DomainState,
  ctx: Context,
  intent: RecordOf<"connected-intents">,
  due: RecordOf<"due-items">,
  evidenceReference?: string,
) {
  const reference = `SYN-A2A-${intent.id}`;
  const payment = makeRecord(state, "payments", {
    name: "Confirmed sample pay-by-bank receipt",
    status: "unallocated",
    reference,
    customerId: intent.customerId,
    amountKobo: intent.amountKobo,
    createdAt: ctx.now,
    data: {
      channel: "transfer",
      providerConnection: "synthetic_a2a",
      providerReference: reference,
      currency: "NGN",
      collectionStatus: "received",
      settlementStatus: "settled",
      reversalStatus: "none",
      refundStatus: "none",
      allocatedKobo: 0,
      observedAt: ctx.now,
      connectedIntentId: intent.id,
      paymentMethod: "pay_by_bank",
      ...(evidenceReference ? { evidenceReference } : {}),
    },
  });
  const observation = makeRecord(state, "observations", {
    name: "Sample bank confirmation",
    status: "resolved",
    reference,
    amountKobo: intent.amountKobo,
    customerId: intent.customerId,
    createdAt: ctx.now,
    data: {
      source: "transfer",
      eventId: reference,
      providerReference: reference,
      paymentId: payment.id,
      dueItemId: due.id,
      provider: "synthetic_a2a",
      currency: "NGN",
      receiptAuthority: evidenceReference ? "finance_evidence" : "server_simulator",
    },
  });
  const available = Number(due.data.outstandingKobo ?? due.amountKobo);
  if (
    available > 0 &&
    !dueNeedsReversalReview(state, due) &&
    !["in_dispute", "cancelled", "closed"].includes(due.status)
  )
    allocatePayment(
      state,
      ctx,
      payment,
      due,
      Math.min(available, payment.amountKobo),
      "A2A-bound-intent",
      "certain",
      true,
      evidenceReference
        ? `Finance confirmed the payment with evidence ${evidenceReference} after its outcome stayed unknown; the amount, beneficiary and instalment are bound to the checkout.`
        : "Server simulator confirmed the amount, beneficiary and bound instalment.",
    );
  if (Number(payment.data.allocatedKobo || 0) < payment.amountKobo)
    raiseException(state, ctx, "unallocated_payment", {
      linkedRecordId: payment.id,
      customerId: payment.customerId,
      amountKobo:
        payment.amountKobo - Number(payment.data.allocatedKobo || 0),
      notes:
        "A late sample payment needs Finance review. Never collect the same instalment again.",
    });
  intent.data.paymentId = payment.id;
  intent.data.observationId = observation.id;
  intent.data.receiptReference = reference;
  intent.data.confirmedAt = ctx.now;
  return payment;
}
/**
 * Item 10: Finance's resolution of a checkout whose outcome stayed unknown
 * (its unknown_outcome exception). Confirmed successful records the receipt
 * with the evidence reference and applies it; confirmed failed, or no debit,
 * records the checkout as failed. Either way the instalment is no longer
 * held. Returns the checkout's new status, or undefined when its outcome was
 * already recorded.
 */
export function resolveUnknownCheckout(
  state: DomainState,
  ctx: Context,
  exception: RecordOf<"exceptions">,
  intent: RecordOf<"connected-intents">,
  resolution: { reason: string; evidenceReference?: string },
): "confirmed" | "failed" | undefined {
  const { evidenceReference } = resolution;
  if (intent.status !== "unknown") return undefined;
  const due = owned(state, String(intent.data.dueItemId), "due-items");
  const resolutionCode = String(exception.data.resolutionCode);
  const confirmed = resolutionCode === "resolved_succeeded";
  if (confirmed) recordCheckoutReceipt(state, ctx, intent, due, evidenceReference);
  recordEvent(
    intent,
    ctx,
    confirmed ? "confirmed" : "failed",
    confirmed
      ? `Finance confirmed the payment was received, with evidence ${evidenceReference}, after its outcome stayed unknown.`
      : resolutionCode === "provider_confirmed_no_debit"
        ? "Finance recorded that the provider confirmed no payment was taken, after the outcome stayed unknown."
        : "Finance confirmed the payment failed after its outcome stayed unknown.",
  );
  intent.data.outcomeResolution = {
    exceptionId: exception.id,
    resolutionCode,
    outcome: confirmed ? "confirmed" : "failed",
    ...(confirmed ? { evidenceReference } : {}),
    resolvedBy: ctx.actor,
    resolvedAt: ctx.now,
    reason: resolution.reason,
  };
  return confirmed ? "confirmed" : "failed";
}
/**
 * A pay-by-bank step. One that settles what an open exception waited for (a
 * late outcome, a refund or a reversal) closes each exception whose condition
 * cleared and adds them to `cleared`, for its audit entry.
 */
export function paymentAction(
  state: DomainState,
  ctx: Context,
  input: ConnectedAction,
  cleared: RecordOf<"exceptions">[],
) {
  allow(ctx, ["Admin", "Operations", "Finance"]);
  if (input.action === "payment.create") {
    const { dueItemId, amountKobo } = z
      .object({
        dueItemId: z.string().min(1),
        amountKobo: z.number().int().positive().safe(),
      })
      .strict()
      .parse(input.data);
    const due = owned(state, dueItemId, "due-items");
    if (dueNeedsReversalReview(state, due)) reject("This instalment is held for renewed Finance review of an earlier reversal decision. Resolve that review and run reconciliation before creating a checkout.", 409);
    if (
      ["paid", "cancelled", "closed", "in_dispute"].includes(due.status) ||
      amountKobo > Number(due.data.outstandingKobo ?? due.amountKobo)
    )
      reject(
        "Choose an open instalment and an amount no higher than its outstanding balance.",
      );
    if (
      state.records.some(
        (r) =>
          r.data.dueItemId === due.id &&
          (intentOpen(r) ||
            externalScheduled(r) ||
            (r.kind === "attempts" && ["sent", "unknown"].includes(r.status))),
      )
    )
      reject(
        "Another instruction is scheduled externally, pending or has an unknown outcome. Confirm its cancellation or resolve its outcome before creating a checkout.",
        409,
      );
    const draft = state.records.find(
      (r) =>
        r.kind === "connected-intents" &&
        r.data.dueItemId === due.id &&
        r.status === "created" &&
        Date.parse(r.data.expiresAt) > Date.parse(ctx.now),
    );
    if (draft)
      reject(
        "This instalment already has an open checkout. Continue or cancel it first.",
        409,
      );
    return makeRecord(state, "connected-intents", {
      name: `Pay ${due.name}`,
      status: "created",
      amountKobo,
      customerId: due.customerId,
      createdAt: ctx.now,
      data: {
        dueItemId: due.id,
        currency: "NGN",
        beneficiary: state.merchant.name,
        beneficiaryId: state.merchant.id,
        rail: "simulated_bank_authorised_a2a",
        expiresAt: new Date(Date.parse(ctx.now) + 15 * 60000).toISOString(),
        createdBy: ctx.actor,
        events: [{ at: ctx.now, status: "created", detail: input.reason }],
      },
    });
  }
  const intent = owned(state, input.recordId, "connected-intents");
  const due = owned(state, String(intent.data.dueItemId), "due-items");
  const event = (status: string, detail: string) => recordEvent(intent, ctx, status, detail);
  if (input.action === "payment.authorise") {
    if (dueNeedsReversalReview(state, due)) reject("This instalment is held for renewed Finance review of an earlier reversal decision. Resolve that review and run reconciliation before authorising a checkout.", 409);
    if (intent.status !== "created")
      reject("Only a new checkout can be authorised.", 409);
    if (Date.parse(String(intent.data.expiresAt)) <= Date.parse(ctx.now))
      reject("This checkout expired. Cancel it and create a new one.", 409);
    if (state.merchant.killSwitch)
      reject("The workspace emergency stop is on.", 403);
    if (
      intent.amountKobo > Number(due.data.outstandingKobo ?? due.amountKobo) ||
      ["paid", "cancelled", "closed", "in_dispute"].includes(due.status)
    )
      reject(
        "The instalment changed. Cancel this checkout and review the balance.",
        409,
      );
    if (
      state.records.some(
        (r) =>
          r.id !== intent.id &&
          r.data.dueItemId === due.id &&
          (intentOpen(r) ||
            externalScheduled(r) ||
            (r.kind === "attempts" && ["sent", "unknown"].includes(r.status))),
      )
    )
      reject(
        "Another instruction is scheduled externally or in flight. Authorisation is held until cancellation or outcome evidence prevents a duplicate collection.",
        409,
      );
    for (const r of state.records.filter(
      (r) =>
        r.kind === "attempts" &&
        r.data.dueItemId === due.id &&
        r.status === "scheduled" &&
        r.data.source === "valo",
    )) {
      r.status = "cancelled";
      r.data.cancellationReason =
        "Replaced by a separately authorised sample pay-by-bank checkout.";
      touch(r, ctx.now);
    }
    const consent = makeRecord(state, "connected-consents", {
      name: "Authorise one payment",
      status: "active",
      createdAt: ctx.now,
      data: {
        purpose: "one_time_payment",
        subjectId: intent.customerId,
        entityId: state.merchant.id,
        intentId: intent.id,
        amountKobo: intent.amountKobo,
        currency: "NGN",
        beneficiaryId: state.merchant.id,
        dueItemId: due.id,
        expiresAt: intent.data.expiresAt,
        version: 1,
        authority: "simulated",
        grantedBy: ctx.actor,
      },
    });
    intent.data.consentId = consent.id;
    return event(
      "authorised",
      "Sample bank authorisation recorded. No money was moved.",
    );
  }
  if (input.action === "payment.cancel") {
    if (intent.status !== "created")
      reject(
        "Only an unauthorised checkout can be cancelled. An in-flight payment must be reconciled.",
        409,
      );
    return event("cancelled", input.reason);
  }
  if (input.action === "payment.return") {
    if (!["authorised", "pending"].includes(intent.status))
      reject("Return is available only after sample authorisation.", 409);
    return event(
      "pending",
      "Browser returned. Payment is not confirmed; awaiting provider evidence.",
    );
  }
  if (input.action === "payment.outcome") {
    const { outcome } = z
      .object({ outcome: z.enum(["confirmed", "unknown", "failed"]) })
      .strict()
      .parse(input.data);
    if (intent.status === "confirmed" && outcome === "confirmed") return intent;
    if (!["authorised", "pending", "unknown"].includes(intent.status))
      reject("This checkout is not waiting for a provider outcome.", 409);
    if (outcome !== "confirmed") {
      event(
        outcome,
        outcome === "unknown"
          ? "Sample provider did not establish the outcome. Query again; do not retry payment."
          : "Sample provider confirmed that payment failed.",
      );
      // A late answer to an outcome that stayed unknown clears its exception.
      cleared.push(...clearSettledExceptions(state, ctx));
      return intent;
    }
    // A late response may arrive after consent expires/revokes: keep recording existing in-flight evidence.
    recordCheckoutReceipt(state, ctx, intent, due);
    event(
      "confirmed",
      "Sample server receipt confirmed and added to collections reconciliation.",
    );
    cleared.push(...clearSettledExceptions(state, ctx));
    return intent;
  }
  if (input.action === "payment.refund_request") {
    allow(ctx, ["Admin", "Operations"]);
    if (intent.status !== "confirmed")
      reject("Only a confirmed payment can be requested for refund.", 409);
    if (intent.data.refundRequest)
      reject("A refund request is already recorded.", 409);
    intent.data.refundRequest = {
      maker: ctx.actor,
      reason: input.reason,
      at: ctx.now,
    };
    touch(intent, ctx.now);
    return intent;
  }
  if (
    input.action === "payment.refund_confirm" ||
    input.action === "payment.reverse"
  ) {
    allow(ctx, ["Finance"]);
    if (intent.status !== "confirmed")
      reject("Only a confirmed receipt can be adjusted.", 409);
    if (
      input.action === "payment.refund_confirm" &&
      (!intent.data.refundRequest ||
        intent.data.refundRequest.maker === ctx.actor)
    )
      reject("A different maker must request the refund first.", 403);
    const payment =
      recordsOf(state, "payments").find(
        (r) => r.id === intent.data.paymentId,
      ) ?? reject("Receipt not found.", 404);
    const refund = input.action === "payment.refund_confirm";
    // The money went back: the payment leaves the allocation queues and is no longer customer credit.
    if (refund) {
      // Decision on leaving a dispute: a refund Finance confirmed reopens each instalment it paid by its balance, not in
      // dispute. With its allocations taken off first, the refund records the whole receipt as returned.
      for (const allocation of recordsOf(state, "allocations").filter(
        (r) => r.data.paymentId === payment.id && r.status === "confirmed",
      ))
        supersedeAllocation(state, ctx, allocation, input.reason);
      recordPaymentRefund(state, ctx, payment, input.reason);
    } else
      // A reversal puts each instalment it paid in dispute, with an exception so someone owns it.
      reversePayment(
        state,
        ctx,
        payment,
        input.reason,
        "Finance recorded sample reversal evidence for the pay-by-bank receipt",
      );
    cleared.push(...clearSettledExceptions(state, ctx));
    return event(
      refund ? "refunded" : "reversed",
      `${input.reason} (sample evidence only)`,
    );
  }
  reject("Unknown payment action.");
}
