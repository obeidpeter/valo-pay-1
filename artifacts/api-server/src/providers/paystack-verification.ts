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
 * verification, named in its history (`check`). The rest are refusals, which
 * record nothing.
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

/** Why an adapter outcome that is not a verified payment leaves the event awaiting verification, and what to do next. */
const inconclusive: Partial<Record<PaystackErrorCode, [PaystackVerificationOutcome, string]>> = {
  authentication: ["credentials_refused", "Paystack refused the test credentials. The event still awaits verification: correct the test key, then check the same event again. Do not issue another payment."],
  live_mode: ["live_mode", "Paystack answered with live-mode data, which is never accepted. The event still awaits verification: check that the configured key belongs to the test account, then check the same event again."],
  invalid_response: ["invalid_response", "Paystack's answer could not be read as a test transaction. The event still awaits verification: check the same event later, and investigate if this repeats. Do not issue another payment."],
  not_found: ["reference_not_found", "Paystack has not returned this test reference. Its outcome stays unknown: check the same event later and do not issue another payment."],
};
const unavailable: [PaystackVerificationOutcome, string] = ["provider_unavailable", "Paystack did not complete the check: it timed out, could not be reached, limited the rate or failed. The event still awaits verification: check the same event later and do not issue another payment."];
const disagreement = "Paystack's answer conflicts with the signed event: another transaction, amount, currency or channel, or a failed or reversed payment. Both are retained for review; no observation was created.";

function eligible(state: DomainState) {
  if (
    state.settings.environment !== "sandbox" ||
    !["sandbox", "observation"].includes(state.merchant.mode) ||
    !state.merchant.killSwitch
  )
    refuse(
      "Verification requires a synthetic workspace in observation mode with its emergency stop on.",
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
    refuse("The provider event was not found in the mapped test lender.", 404, "event_not_found");
  if (event.data.mode !== "test" || event.data.event?.kind !== "payment")
    refuse(
      "Only an authenticated test payment event can be independently verified. Local fixtures cannot be promoted.",
      403,
      "not_a_test_payment",
    );
  // An earlier build quarantined events whose check was only inconclusive; their history shows it.
  if (!["awaiting_verification", "verified"].includes(event.status) && !quarantinedWithoutDisagreement(event))
    refuse(
      "This provider event is held for review and cannot be verified automatically.",
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
      "Exactly one saved collection expectation must match this test reference.",
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
      "The saved customer, instalment, amount, currency and test-provider connection must match the signed evidence.",
      409,
      "expectation_mismatch",
    );
  return { attempt, due, customer };
}
const checkLimit = (event: ValopayRecord) => {
  if ((event.data.replayHistory?.length ?? 0) >= 100)
    refuse(
      "This event reached its check limit. Ask the operator to review the retained evidence.",
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
      "The verified event is missing its retained observation. Hold it for recovery review; do not recreate it automatically.",
      409,
      "observation_missing",
    );
  return {
    status: "verified" as const,
    outcome: "verified" as PaystackVerificationOutcome,
    message: "This event was independently verified earlier. Its observation is retained; no check was repeated.",
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
      "Use the opaque configured test connection and a saved event ID.",
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
        "The stored expectation or signed evidence changed during verification. Review it before checking the same reference again.",
        409,
        "evidence_changed",
      );
    // Only a real disagreement quarantines the event. A refused key, an unreadable or live-mode
    // answer or a transport failure leaves it awaiting verification, with its finding named.
    let [named, message]: [PaystackVerificationOutcome, string] =
      outcome.outcome === "verified"
        ? ["pending", "Paystack reports this test payment as still pending. Check the same event later; do not issue another payment."]
        : outcome.reason === "mismatch"
          ? ["mismatch", disagreement]
          : (inconclusive[outcome.reason] ?? unavailable);
    let status = named === "mismatch" ? "quarantined" : "awaiting_verification";
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
            "An observation already holds this transaction identity. Review the original evidence instead of creating another.",
            409,
            "duplicate_observation",
          );
        const observation = makeRecord(state, "observations", {
          name: "Independently verified Paystack test receipt",
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
          "Independent test verification matched the saved expectation. One observation is ready for normal reconciliation; settlement is not confirmed and no financial instruction was created.",
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
