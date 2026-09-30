import { createHash } from "node:crypto";
import { canonicalJson } from "@workspace/valopay-schema";
import { makeRecord, touch } from "../domain/records";
import type { Context, DomainState, ValopayRecord } from "../domain/types";
import type { ExpectedPayment, PaystackErrorCode, RecoveryResult } from "./paystack";
import { quarantinedWithoutDisagreement } from "./paystack-inbox";

export type PaystackVerificationTransaction = <T>(
  connectionId: string,
  write: boolean,
  apply: (state: DomainState, ctx: Context) => T,
) => Promise<T>;
export type PaystackVerificationAdapter = {
  recoverUnknown(expected: ExpectedPayment): Promise<RecoveryResult>;
};
/**
 * What one check found, or why it was refused, as the command prints and logs
 * it. Only `mismatch` quarantines the event and `verified` records its
 * observation; any other finding a check records leaves the event awaiting
 * verification, or an event an earlier build quarantined still quarantined,
 * named in its history (`check`). The rest are refusals, which record nothing.
 */
export type PaystackVerificationOutcome =
  | "verified"
  | "pending"
  | "reference_not_found"
  | "provider_unavailable"
  | "invalid_response"
  | "credentials_refused"
  | "live_mode"
  | "mismatch"
  | "usage"
  | "not_configured"
  | "connection_not_mapped"
  | "connection_unavailable"
  | "configuration_changed"
  | "lender_unavailable"
  | "lender_not_found"
  | "database_unavailable"
  | "lender_not_eligible"
  | "event_not_found"
  | "not_a_test_payment"
  | "held_for_review"
  | "check_limit_reached"
  | "expectation_mismatch"
  | "evidence_changed"
  | "duplicate_observation"
  | "observation_missing"
  | "failed";
/** A refusal that names its outcome; nothing was recorded. Its message is fixed and names no identifier. */
function refuse(
  message: string,
  status: number,
  outcome: PaystackVerificationOutcome,
): never {
  throw Object.assign(new Error(message), { status, outcome });
}
export { refuse as refuseVerification };
const hash = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
export const paystackTestConnectionIdentity = (connectionId: string) =>
  `paystack:test:${connectionId}`;

/** An adapter outcome that is not a verified payment: what it says about the check, and what to do next. */
const inconclusive: Partial<Record<PaystackErrorCode, [PaystackVerificationOutcome, string, string]>> = {
  authentication: ["credentials_refused", "Paystack refused the test key.", "correct the test key, then check the same event again"],
  live_mode: ["live_mode", "Paystack answered with live data, which is never accepted and says nothing about this test payment.", "check the configured test key, then check the same event again, and report it to Paystack if it repeats"],
  invalid_response: ["invalid_response", "Paystack’s answer could not be read as a test payment.", "check the same event later, and contact the Valo Pay team if this repeats"],
  not_found: ["reference_not_found", "Paystack has not returned this test reference.", "check the same event later"],
};
const unavailable: [PaystackVerificationOutcome, string, string] = ["provider_unavailable", "Paystack did not complete the check: it was too slow, could not be reached, was busy or failed.", "check the same event later"];
/**
 * What an inconclusive check leaves: an event awaiting verification, or one an earlier build quarantined
 * still quarantined, since that build also reported a test transaction in another currency as unreadable.
 */
const inconclusiveMessage = (what: string, next: string, quarantined: boolean) =>
  quarantined
    ? `${what} This event was put on hold earlier, because a check may have found a difference, such as another currency. It stays on hold until Paystack gives a clear answer: ${next}. Do not ask for another payment.`
    : `${what} The event is still waiting to be checked: ${next}. Do not ask for another payment.`;
const disagreement = "Paystack’s answer does not match the signed event. It names another transaction, amount, currency or channel, or a failed or reversed payment. Both are kept for review, and no payment evidence was created.";

function eligible(state: DomainState) {
  if (
    state.settings.environment !== "sandbox" ||
    !["sandbox", "observation"].includes(state.merchant.mode) ||
    !state.merchant.killSwitch
  )
    refuse(
      "Test payments can be checked only for a sample lender that is watching only, with its emergency stop on.",
      403,
      "lender_not_eligible",
    );
}
function eventIn(state: DomainState, connectionId: string, eventId: string) {
  const event = state.records.find(
    (record) =>
      record.id === eventId &&
      record.kind === "provider-events" &&
      record.merchantId === state.merchant.id &&
      record.data.connectionId === connectionId,
  );
  if (!event)
    refuse("This Paystack event was not found for the test lender. Check the event ID.", 404, "event_not_found");
  if (event.data.mode !== "test" || event.data.event?.kind !== "payment")
    refuse(
      "Only a signed test payment from Paystack can be checked. Practice messages cannot be checked.",
      403,
      "not_a_test_payment",
    );
  // An earlier build quarantined events whose check was only inconclusive; their history shows it.
  if (!["awaiting_verification", "verified"].includes(event.status) && !quarantinedWithoutDisagreement(event))
    refuse(
      "This event is on hold for review, so it cannot be checked automatically.",
      409,
      "held_for_review",
    );
  return event;
}
function expectation(
  state: DomainState,
  event: ValopayRecord,
  connectionId: string,
) {
  const payment = event.data.event.payment;
  const matches = state.records.filter(
    (record) =>
      record.kind === "attempts" &&
      record.merchantId === state.merchant.id &&
      [record.reference, record.data.providerReference].includes(
        payment.reference,
      ),
  );
  if (matches.length !== 1)
    refuse(
      "Exactly one expected collection must have this test reference. Check the expected collections.",
      409,
      "expectation_mismatch",
    );
  const attempt = matches[0]!;
  const due = state.records.find(
    (record) =>
      record.kind === "due-items" &&
      record.id === attempt.data.dueItemId &&
      record.merchantId === state.merchant.id,
  );
  const customer = state.records.find(
    (record) =>
      record.kind === "customers" &&
      record.id === attempt.customerId &&
      record.merchantId === state.merchant.id,
  );
  if (
    !due ||
    !customer ||
    due.customerId !== attempt.customerId ||
    attempt.amountKobo !== payment.amountKobo ||
    payment.currency !== "NGN" ||
    payment.channel !== "direct_debit" ||
    attempt.data.currency !== "NGN" ||
    attempt.data.providerConnection !==
      paystackTestConnectionIdentity(connectionId)
  )
    refuse(
      "The customer, instalment, amount, currency and test connection must match the signed Paystack event.",
      409,
      "expectation_mismatch",
    );
  return { attempt, due, customer };
}
const checkLimit = (event: ValopayRecord) => {
  if ((event.data.replayHistory?.length ?? 0) >= 100)
    refuse(
      "This event has been checked the maximum number of times. Ask the Valo Pay team to review it.",
      409,
      "check_limit_reached",
    );
};
const eventHash = (event: ValopayRecord) =>
  hash({
    id: event.id,
    merchantId: event.merchantId,
    reference: event.reference,
    amountKobo: event.amountKobo,
    event: event.data.event,
    payloadDigest: event.data.payloadDigest,
  });
const receiptOf = (state: DomainState, event: ValopayRecord) => {
  const verification = (
    event.data.replayHistory as Array<Record<string, unknown>> | undefined
  )?.find((entry) => entry.kind === "independent_transaction_verification");
  const observation = state.records.find(
    (record) =>
      record.kind === "observations" &&
      record.id === verification?.observationId &&
      record.merchantId === state.merchant.id &&
      record.data.providerEventId === event.id,
  );
  if (!verification || !observation)
    refuse(
      "This checked event has lost its payment evidence. Leave it on hold for review, and do not create it again.",
      409,
      "observation_missing",
    );
  return {
    status: "verified" as const,
    outcome: "verified" as PaystackVerificationOutcome,
    message: "This event was checked earlier, and its payment evidence is kept. It was not checked again.",
    observationCreated: false,
    financialRecordsCreated: 0 as const,
    instructions: "disabled" as const,
  };
};

/** Explicit operator test verification. The HTTP lookup occurs between two short
 * lender transactions. Its result is useful only if the expectation and authority
 * remain current. It never creates an instruction, Payment or allocation. */
export async function verifyQueuedPaystackEvent(input: {
  connectionId: string;
  eventId: string;
  transact: PaystackVerificationTransaction;
  adapter: PaystackVerificationAdapter;
}) {
  if (
    !/^[a-f0-9]{64}$/.test(input.connectionId) ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(input.eventId)
  )
    refuse(
      "Give the configured test connection and a saved event ID.",
      400,
      "usage",
    );
  const prepared = await input.transact(
    input.connectionId,
    false,
    (state, ctx) => {
      eligible(state);
      const event = eventIn(state, input.connectionId, input.eventId);
      if (event.status === "verified")
        return { previous: receiptOf(state, event) };
      checkLimit(event);
      const { attempt, due, customer } = expectation(
        state,
        event,
        input.connectionId,
      );
      return {
        pending: {
          eventHash: eventHash(event),
          attemptHash: hash(attempt),
          dueId: due.id,
          customerId: customer.id,
          merchantId: state.merchant.id,
          startedAt: ctx.now,
          expected: {
            reference: event.data.event.payment.reference,
            amountKobo: attempt.amountKobo,
            currency: "NGN" as const,
            channel: "direct_debit" as const,
          },
        },
      };
    },
  );
  if (prepared.previous) return prepared.previous;
  const pending = prepared.pending!;
  const outcome = await input.adapter.recoverUnknown(pending.expected);
  return input.transact(input.connectionId, true, (state, ctx) => {
    eligible(state);
    const event = eventIn(state, input.connectionId, input.eventId);
    if (event.status === "verified") return receiptOf(state, event);
    checkLimit(event);
    const { attempt, due, customer } = expectation(
      state,
      event,
      input.connectionId,
    );
    if (
      state.merchant.id !== pending.merchantId ||
      eventHash(event) !== pending.eventHash ||
      hash(attempt) !== pending.attemptHash ||
      due.id !== pending.dueId ||
      customer.id !== pending.customerId
    )
      refuse(
        "The expected collection or the signed event changed during the check. Review it before you check the same reference again.",
        409,
        "evidence_changed",
      );
    // Only a real disagreement quarantines the event. A refused key, an unreadable or live-mode
    // answer or a transport failure leaves it awaiting verification, with its finding named, but
    // leaves an event an earlier build quarantined as it is: only a conclusive answer moves that.
    const quarantinedEarlier = event.status === "quarantined";
    let named: PaystackVerificationOutcome, message: string;
    if (outcome.outcome === "verified")
      [named, message] = ["pending", "Paystack says this test payment is still pending. Check the same event later, and do not ask for another payment."];
    else if (outcome.reason === "mismatch") [named, message] = ["mismatch", disagreement];
    else {
      const [found, what, next] = inconclusive[outcome.reason] ?? unavailable;
      [named, message] = [found, inconclusiveMessage(what, next, quarantinedEarlier)];
    }
    let status = named === "mismatch" || (quarantinedEarlier && outcome.outcome === "unknown") ? "quarantined" : "awaiting_verification";
    let observationId: string | undefined;
    if (outcome.outcome === "verified") {
      const payment = outcome.payment,
        signed = event.data.event.payment;
      const matched =
        payment.provider === "paystack" &&
        payment.domain === "test" &&
        payment.transactionId === signed.transactionId &&
        payment.reference === pending.expected.reference &&
        payment.amountKobo === pending.expected.amountKobo &&
        payment.currency === "NGN" &&
        payment.channel === "direct_debit";
      if (!matched || ["failed", "reversed"].includes(payment.state)) {
        status = "quarantined";
        [named, message] = ["mismatch", disagreement];
      } else if (payment.state === "succeeded") {
        const identity = `paystack:test:verified:${payment.transactionId}`;
        if (
          state.records.some(
            (record) =>
              record.kind === "observations" &&
              record.data.providerConnection ===
                paystackTestConnectionIdentity(input.connectionId) &&
              record.data.eventId === identity,
          )
        )
          refuse(
            "This payment is already recorded as payment evidence. Review the original evidence instead.",
            409,
            "duplicate_observation",
          );
        const observation = makeRecord(state, "observations", {
          name: "Checked Paystack test payment",
          status: "unresolved",
          reference: payment.reference,
          amountKobo: payment.amountKobo,
          customerId: customer.id,
          createdAt: ctx.now,
          data: {
            source: "webhook",
            eventId: identity,
            providerReference: payment.reference,
            providerConnection: paystackTestConnectionIdentity(
              input.connectionId,
            ),
            currency: "NGN",
            dueItemId: due.id,
            providerEventId: event.id,
            providerTransactionId: payment.transactionId,
            verification: {
              mode: "test",
              verifiedAt: ctx.now,
              startedAt: pending.startedAt,
              expectedAttemptHash: pending.attemptHash,
              eventHash: pending.eventHash,
            },
            synthetic: true,
          },
        });
        observationId = observation.id;
        status = "verified";
        [named, message] = [
          "verified",
          "The test payment matched the expected collection. It is now payment evidence, ready for Reconciliation. Settlement is not confirmed, and no money moved.",
        ];
      }
    }
    event.status = status;
    event.data.message = message;
    event.data.replayHistory = [
      ...event.data.replayHistory,
      {
        at: ctx.now,
        actor: ctx.actor,
        reason: "Explicit operator read-only test verification",
        result: status,
        check: named,
        kind: observationId
          ? "independent_transaction_verification"
          : "independent_transaction_check",
        ...(observationId ? { observationId } : {}),
        outcome,
      },
    ];
    touch(event, ctx.now);
    return {
      status,
      outcome: named,
      message,
      observationCreated: !!observationId,
      financialRecordsCreated: 0 as const,
      instructions: "disabled" as const,
    };
  });
}
