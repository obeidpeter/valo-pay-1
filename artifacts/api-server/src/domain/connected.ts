import { createHash } from "node:crypto";
import { z } from "zod";
import { connectedActionInputSchema, connectedConsentPurposes } from "@workspace/valopay-schema";
import type { Context, DomainState, ValopayRecord, RecordOf } from "./types";
import { makeRecord, recordsOf, touch } from "./records";
import {
  allocatePayment,
  clearSettledExceptions,
  clearedExceptionsNote,
  supersedeAllocation,
  raiseException,
  recordPaymentRefund,
  reversePayment,
} from "./reconciliation";
import { creditView, runCreditAction } from "./connected-credit-service";
import { cashView, runCashAction } from "./connected-cash-service";
import { dueNeedsReversalReview } from "./reversal-review";

// The action's shape and the consent purposes are the shared definitions the contract and the console read.
export const connectedActionSchema = connectedActionInputSchema;
export type ConnectedAction = z.infer<typeof connectedActionSchema>;
export const consentPurposes = connectedConsentPurposes;
export const purposeLabels: Record<string, string> = {
  account_read: "Read applicant accounts",
  credit_assessment: "Assess an application",
  merchant_account_read: "Read business accounts",
  erp_draft: "Prepare accounting drafts",
  payroll_prepare: "Prepare payroll funding",
  one_time_payment: "Authorise one payment",
};
const gates = [
  [
    "G0",
    "Provider and legal readiness",
    "Contracts, permitted role and approved routes",
  ],
  [
    "G-DATA",
    "Real data",
    "Privacy assessment, retention and tenant security evidence",
  ],
  [
    "G-OB",
    "Connected accounts",
    "Bank and account coverage, consent and data provenance",
  ],
  [
    "G-A2A",
    "Pay-by-bank",
    "Bank authorisation, verified receipts and duplicate collection controls",
  ],
  [
    "G-CREDIT",
    "Credit assessments",
    "Validated rules, lender ownership and independent review",
  ],
  [
    "G-MODEL",
    "Predictive credit models",
    "Calibration, performance and model governance",
  ],
  [
    "G-AUTO",
    "Automated credit decisions",
    "Separate legal and consequential decision approval",
  ],
  [
    "G-ERP",
    "Accounting writes",
    "Finance approval, scoped access and closed-period controls",
  ],
  [
    "G-PAYOUT",
    "Own-account payouts",
    "Corporate bank authority, signatories and item-level verification",
  ],
  ["G-TAX", "Tax submission", "Tax review and filing authority"],
] as const;
function reject(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}
/** An instalment Pay-by-bank offers: money is owed and nothing holds it. */
function payable(r: ValopayRecord) {
  return (
    Number(r.data.outstandingKobo ?? r.amountKobo) > 0 &&
    !["paid", "closed", "cancelled", "in_dispute"].includes(r.status)
  );
}
/** The lender's settings the workspace and its actions read: only these are part of its revision. */
const connectedSettings = ["environment"] as const;
/**
 * The revision an action names: it changes whenever anything the workspace
 * shows or its actions read changes, and nothing else does. It covers the
 * lender, the settings the workspace reads (connectedSettings), the
 * customers, every connected record, each pay-by-bank receipt with its
 * allocations, and the instalments the workspace offers, a checkout names or
 * a receipt was applied to, with their attempts, each record whole. The
 * lender's history (closes, the audit trail, exports, settled instalments,
 * other payments) and the other settings (the scheduler's close cursor and
 * retry, a pause for inactivity, the audit chain's head) are left out, so the
 * revision costs what the workspace does, a scheduled close or an audited
 * write elsewhere keeps it, and a write, which loads older closes as
 * summaries, computes the revision its view did. It does not change with the
 * clock.
 */
export function connectedRevision(state: DomainState): string {
  const receipts = new Set<string>(),
    dues = new Set<unknown>();
  for (const r of state.records) {
    if (r.kind === "payments" && r.data.connectedIntentId) receipts.add(r.id);
    else if (r.kind === "due-items" && payable(r)) dues.add(r.id);
    else if (r.kind === "connected-intents") dues.add(r.data.dueItemId);
  }
  for (const r of state.records)
    if (r.kind === "allocations" && receipts.has(r.data.paymentId))
      dues.add(r.data.dueItemId);
  const rows = state.records
    .filter(
      (r) =>
        r.kind === "customers" ||
        r.kind.startsWith("connected-") ||
        (r.kind === "due-items" && dues.has(r.id)) ||
        (r.kind === "attempts" && dues.has(r.data.dueItemId)) ||
        (r.kind === "payments" && receipts.has(r.id)) ||
        (r.kind === "allocations" && receipts.has(r.data.paymentId)),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const settings = Object.fromEntries(connectedSettings.map((key) => [key, state.settings[key]]));
  return createHash("sha256")
    .update(JSON.stringify([state.merchant, settings, rows]))
    .digest("hex");
}
function owned<K extends string>(
  state: DomainState,
  id: string | undefined,
  kind: K,
): RecordOf<K> {
  return (state.records.find(
    (r) => r.id === id && r.kind === kind && r.merchantId === state.merchant.id,
  ) ?? reject("Record not found in this workspace.", 404)) as RecordOf<K>;
}
function allow(ctx: Context, roles: string[]) {
  if (!roles.includes(ctx.role))
    reject(`This action requires ${roles.join(" or ")} role.`, 403);
}
function intentOpen(r: ValopayRecord) {
  return (
    r.kind === "connected-intents" &&
    ["authorised", "pending", "unknown"].includes(r.status)
  );
}
function externalScheduled(r: ValopayRecord) {
  return (
    r.kind === "attempts" &&
    r.status === "scheduled" &&
    r.data.source !== "valo"
  );
}
export function consentActive(r: ValopayRecord, now: string) {
  return (
    r.status === "active" &&
    Date.parse(String(r.data.validFrom ?? r.createdAt)) <= Date.parse(now) &&
    Date.parse(r.data.expiresAt) > Date.parse(now) &&
    Number.isSafeInteger(r.data.version) && Number(r.data.version) > 0
  );
}
function addConsent(
  state: DomainState,
  ctx: Context,
  data: Record<string, unknown>,
) {
  allow(ctx, ["Admin", "Operations"]);
  const input = z
    .object({
      purpose: z.enum(consentPurposes),
      subjectId: z.string().min(1),
      days: z.number().int().min(1).max(90).default(30),
    })
    .strict()
    .parse(data);
  const sme = [
    "merchant_account_read",
    "erp_draft",
    "payroll_prepare",
  ].includes(input.purpose);
  if (
    sme
      ? input.subjectId !== "sme"
      : !state.records.some(
          (r) => r.kind === "customers" && r.id === input.subjectId,
        )
  )
    reject("Select a subject that belongs to this workspace.");
  const existing = state.records.find(
    (r) =>
      r.kind === "connected-consents" &&
      r.data.subjectId === input.subjectId &&
      r.data.purpose === input.purpose &&
      consentActive(r, ctx.now),
  );
  if (existing) return existing;
  return makeRecord(state, "connected-consents", {
    name: purposeLabels[input.purpose],
    status: "active",
    createdAt: ctx.now,
    data: {
      ...input,
      entityId: sme ? `${state.merchant.id}:sme` : state.merchant.id,
      version: 1,
      expiresAt: new Date(
        Date.parse(ctx.now) + input.days * 86400000,
      ).toISOString(),
      grantedBy: ctx.actor,
      authority: "simulated",
      noticeVersion: "connected-2026-09",
      source: "synthetic_permission_journey",
    },
  });
}
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
function paymentAction(
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
export function runConnectedAction(
  state: DomainState,
  ctx: Context,
  input: ConnectedAction,
) {
  return runConnectedActionWithNote(state, ctx, input).result;
}
/**
 * A connected action and the note its audit entry adds to the reason: a
 * pay-by-bank step that closed exceptions whose condition cleared names them
 * (clearedExceptionsNote), as the actions and the daily close do.
 */
export function runConnectedActionWithNote(
  state: DomainState,
  ctx: Context,
  input: ConnectedAction,
) {
  const cleared: RecordOf<"exceptions">[] = [];
  const result = connectedAction(state, ctx, input, cleared);
  const auditNote = clearedExceptionsNote(cleared);
  return auditNote ? { result, auditNote } : { result };
}
function connectedAction(
  state: DomainState,
  ctx: Context,
  input: ConnectedAction,
  cleared: RecordOf<"exceptions">[],
) {
  if (state.settings.environment !== "sandbox")
    reject(
      "Connected modules currently support synthetic workspaces only.",
      403,
    );
  if (ctx.role === "Read-only")
    reject("Read-only role cannot change the workspace.", 403);
  if (input.expectedRevision !== connectedRevision(state))
    reject(
      "The workspace changed. Refresh and review before trying again.",
      409,
    );
  const startsNewWork = [
    "consent.grant",
    "payment.create",
    "credit.assess",
    "cash.initialize",
    "cash.forecast",
    "cash.erp.prepare",
    "cash.vat.export",
    "cash.payroll.prepare",
  ].includes(input.action);
  if (
    startsNewWork &&
    state.records.filter((r) => r.kind.startsWith("connected-")).length >= 1500
  )
    reject(
      "This sample workspace reached its connected-record limit for new work. Existing permissions can still be revoked and in-flight outcomes reconciled.",
      409,
    );
  if (input.action === "consent.grant")
    return addConsent(state, ctx, input.data);
  if (input.action === "consent.revoke") {
    allow(ctx, ["Admin", "Operations", "Compliance reviewer"]);
    const consent = owned(state, input.recordId, "connected-consents");
    if (consent.status === "revoked") return consent;
    consent.status = "revoked";
    consent.data.revokedAt = ctx.now;
    consent.data.revokedBy = ctx.actor;
    consent.data.revocationReason = input.reason;
    consent.data.version = Number(consent.data.version || 0) + 1;
    touch(consent, ctx.now);
    return consent;
  }
  if (input.action.startsWith("payment."))
    return paymentAction(state, ctx, input, cleared);
  if (input.action.startsWith("credit."))
    return runCreditAction(state, ctx, input);
  if (input.action.startsWith("cash.")) return runCashAction(state, ctx, input);
  reject("Unknown connected-workspace action.");
}
export function connectedView(state: DomainState, ctx: Context) {
  const customers = recordsOf(state, "customers").map((r) => ({
    id: r.id,
    name: r.name,
    reference: r.reference,
  }));
  // Built once for the whole view: each customer's name, and the instalments an
  // open checkout or an attempt scheduled elsewhere or in flight holds.
  const customerNames = new Map<string, string>();
  for (const c of customers)
    if (!customerNames.has(c.id)) customerNames.set(c.id, c.name);
  const held = new Set<unknown>();
  for (const a of state.records)
    if (
      intentOpen(a) ||
      externalScheduled(a) ||
      (a.kind === "attempts" && ["sent", "unknown"].includes(a.status))
    )
      held.add(a.data.dueItemId);
  // The instalments offered or named by a checkout that reconciliation holds for a renewed reversal review
  // (data.legacyReversalReviewIds), which payment.create and payment.authorise refuse. A hold derived before the
  // first reconciliation is not recorded yet, so it is not listed; the refusal still says so.
  const checkedOut = new Set(
    state.records
      .filter((r) => r.kind === "connected-intents")
      .map((r) => r.data.dueItemId),
  );
  const heldForReversalReview = recordsOf(state, "due-items")
    .filter(
      (r) =>
        (payable(r) || checkedOut.has(r.id)) &&
        Array.isArray(r.data.legacyReversalReviewIds) &&
        r.data.legacyReversalReviewIds.length > 0,
    )
    .map((r) => r.id);
  return {
    mode: "synthetic" as const,
    revision: connectedRevision(state),
    asOf: ctx.now,
    role: ctx.role,
    entity: {
      id: `${state.merchant.id}:sme`,
      name: "Sample SME · separate legal entity",
      workspaceOwner: state.merchant.name,
    },
    customers,
    consents: state.records
      .filter((r) => r.kind === "connected-consents")
      .map((r) => ({
        ...r,
        effectiveStatus: consentActive(r, ctx.now)
          ? "active"
          : r.status === "revoked"
            ? "revoked"
            : "expired",
      })),
    purposes: consentPurposes.map((id) => ({ id, label: purposeLabels[id] })),
    gates: gates.map(([id, name, requires]) => ({
      id,
      name,
      requires,
      status: "not_enabled",
      liveEnabled: false,
    })),
    payments: {
      intents: state.records
        .filter((r) => r.kind === "connected-intents")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      dues: recordsOf(state, "due-items")
        .filter(payable)
        .map((r) => ({
          id: r.id,
          name: r.name,
          reference: r.reference,
          customerId: r.customerId,
          customerName: customerNames.get(r.customerId) ?? r.name,
          outstandingKobo: Number(r.data.outstandingKobo ?? r.amountKobo),
          blocked: held.has(r.id),
        })),
      heldForReversalReview,
    },
    credit: creditView(state, ctx),
    cash: cashView(state, ctx),
  };
}
