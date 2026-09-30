import { createHash, createHmac } from "node:crypto";
import { verificationCheck } from '../domain/provider-event-integrity';
export { assertProviderEventChange, quarantinedWithoutDisagreement } from '../domain/provider-event-integrity';
import type { Context, DomainState, ValopayRecord } from "../domain/types";
import { makeRecord } from "../domain/records";
import { assertRecordVersion } from "../lib/edit-versions";
import { notFound, onlyRoles } from "../lib/refusal-words";
import { parsePaystackTestWebhook, reconcilePaystackEvidence, reconcilePaystackMandateEvidence, type PaystackWebhook } from "./paystack";

function refuse(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }
// The parser builds each event with a fixed key order; stored payload digests are of that text.
const digest = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
export type PaystackEventContext = { connectionId: string; mode: "fixture" | "test" };
const decisionFor = (state: DomainState, event: PaystackWebhook, connection: PaystackEventContext, excluding?: string) => {
  const previous = state.records.filter(r => r.kind === "provider-events" && r.id !== excluding && r.data.connectionId === connection.connectionId && r.data.mode === connection.mode && !["quarantined", "rejected_fixture"].includes(r.status));
  if (event.kind === "ignored") return { status: "ignored", message: "Valo Pay does not use this type of Paystack message. No payment or other financial record was created." };
  if (event.kind === "mandate") {
    const old = previous.filter(r => r.data.event?.kind === "mandate" && r.data.event.authorizationFingerprint === event.authorizationFingerprint).sort((a,b) => Number(b.data.event.state === "active") - Number(a.data.event.state === "active"))[0];
    const decision = reconcilePaystackMandateEvidence(old?.data.event, event).decision;
    return { status: decision === "ignored_stale" ? "ignored_stale" : decision === "review" ? "quarantined" : "recorded", message: decision === "ignored_stale" ? "A newer ‘active’ message is already recorded for this mandate, so this older ‘pending’ message cannot replace it." : "Mandate message recorded. The mandate’s status and the customer’s permission to debit are unchanged." };
  }
  const old = previous.find(r => r.data.event?.kind === "payment" && (r.data.event.payment.transactionId === event.payment.transactionId || r.data.event.payment.reference === event.payment.reference));
  if (old && reconcilePaystackEvidence(old.data.event.payment, event.payment).decision === "review") return { status: "quarantined", message: "This reference or transaction does not match an earlier message’s amount, currency, channel or details. Review it before it is checked." };
  // Only read an expectation already persisted for this lender. The webhook cannot select a customer or create its own expectation.
  const expected = state.records.filter(r => r.kind === "attempts" && [r.reference, r.data.providerReference].includes(event.payment.reference));
  if (expected.length > 1 || (expected.length === 1 && (expected[0]!.amountKobo !== event.payment.amountKobo || (expected[0]!.data.currency && expected[0]!.data.currency !== event.payment.currency)))) return { status: "quarantined", message: "The payment does not match the lender’s expected collection. No payment or allocation was created." };
  return { status: "awaiting_verification", message: expected.length ? "Signature accepted. The payment must be checked with Paystack before it is used." : "No expected collection has this reference. Link it to one, and check it with Paystack before it is used." };
};

/** Called only after raw-byte signature validation and server-only connection resolution. Persist under the lender lock. */
export function receivePaystackEvent(state: DomainState, ctx: Context, event: PaystackWebhook, connection: PaystackEventContext) {
  if (!connection.connectionId || !["fixture", "test"].includes(connection.mode)) refuse("The Paystack test connection is not available. Contact the Valo Pay team.", 403);
  const hash = digest(event), key = event.kind === "ignored" ? `unsupported:${hash}` : event.dedupeKey;
  const prior = state.records.find(r => r.kind === "provider-events" && r.data.connectionId === connection.connectionId && r.data.mode === connection.mode && r.data.dedupeKey === key && r.data.payloadDigest === hash);
  if (prior) {
    prior.data.deliveryCount = Number(prior.data.deliveryCount || 1) + 1;
    prior.data.lastReceivedAt = ctx.now;
    return { accepted: true, duplicate: true, event: prior };
  }
  const collision = state.records.find(r => r.kind === "provider-events" && r.data.connectionId === connection.connectionId && r.data.mode === connection.mode && r.data.dedupeKey === key);
  const decision = collision ? { status: "quarantined", message: "A message with the same ID arrived with different details. Both are kept for review." } : decisionFor(state, event, connection);
  const record = makeRecord(state, "provider-events", { name: connection.mode === "fixture" ? "Paystack practice message" : "Paystack signed test message", status: decision.status,
    createdAt: ctx.now, updatedAt: ctx.now, reference: event.kind === "payment" ? event.payment.reference : "", amountKobo: event.kind === "payment" ? event.payment.amountKobo : 0,
    data: { provider: "paystack", mode: connection.mode, connectionId: connection.connectionId, event, dedupeKey: key, payloadDigest: hash, deliveryCount: 1,
      firstReceivedAt: ctx.now, lastReceivedAt: ctx.now, message: decision.message, synthetic: true, financialRecordsCreated: 0, replayHistory: [] } });
  return { accepted: true, duplicate: false, event: record };
}

export function replayProviderEvent(state: DomainState, ctx: Context, id: string, version: string, reason: string) {
  if (!["Admin", "Finance"].includes(ctx.role)) refuse(onlyRoles(["Admin", "Finance"], "recheck a Paystack message", ctx.accessMode), 403);
  const record = state.records.find(r => r.id === id && r.kind === "provider-events");
  if (!record) refuse(notFound("Paystack message"), 404);
  assertRecordVersion(record, version);
  if (record.status === "quarantined" || record.status === "rejected_fixture") refuse("This message cannot be rechecked. It is on hold because of a conflict or a bad signature, which a recheck cannot fix. Review the original conflict.", 409);
  if (record.status === "verified") refuse("This message is already checked and recorded as payment evidence. Continue in Reconciliation.", 409);
  const decision = decisionFor(state, record.data.event, { connectionId: record.data.connectionId, mode: record.data.mode }, record.id);
  record.status = decision.status; record.data.message = decision.message;
  record.data.replayHistory = [...record.data.replayHistory, { at: ctx.now, actor: ctx.actor, reason, result: decision.status }];
  return record;
}

/** Fixed local evidence never calls Paystack and is permanently labelled fixture mode. */
export function runPaystackFixture(state: DomainState, ctx: Context, scenario: "payment" | "duplicate" | "amount_mismatch" | "out_of_order" | "tampered") {
  if (!["Admin", "Operations", "Finance"].includes(ctx.role)) refuse(onlyRoles(["Admin", "Operations", "Finance"], "simulate Paystack messages", ctx.accessMode), 403);
  const connection = { connectionId: `fixture:${state.merchant.id}`, mode: "fixture" as const };
  const key = ["sk", "test", "local", "fixture", "only", "0".repeat(20)].join("_");
  const payment = (amount: number) => ({ event: "charge.success", data: { domain: "test", id: "990000000001", status: "success", reference: "VALO-SYNTHETIC-ONLY-001", amount, currency: "NGN", channel: "direct_debit" } });
  const signed = (value: unknown, tamper = false) => { const raw = Buffer.from(JSON.stringify(value)); const signature = createHmac("sha512", key).update(raw).digest("hex"); return parsePaystackTestWebhook(tamper ? Buffer.concat([raw, Buffer.from(" ")]) : raw, signature, key); };
  if (scenario === "tampered") {
    try { signed(payment(2500000), true); refuse("The fixture unexpectedly accepted tampered bytes.", 500); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "invalid_signature") throw error;
      const record = makeRecord(state, "provider-events", { name: "Paystack message with a bad signature", status: "rejected_fixture", createdAt: ctx.now, data: { provider: "paystack", mode: "fixture", connectionId: connection.connectionId, synthetic: true, message: "A message with a bad signature was turned away before it was processed. No payment or other financial record was created.", deliveryCount: 0, financialRecordsCreated: 0, replayHistory: [] } });
      return { accepted: false, duplicate: false, event: record };
    }
  }
  if (scenario === "out_of_order") {
    for (const active of [true, false]) {
      const event = signed({ event: `direct_debit.authorization.${active ? "active" : "created"}`, data: { domain: "test", active, channel: "direct_debit", authorization_code: "AUTH_SYNTHETIC_REHEARSAL_ONLY" } });
      receivePaystackEvent(state, ctx, event, connection);
    }
    const record = state.records.find(r => r.kind === "provider-events" && r.data.connectionId === connection.connectionId && r.data.event?.kind === "mandate" && r.data.event.state === "pending")!;
    return { accepted: true, duplicate: false, event: record };
  }
  const first = receivePaystackEvent(state, ctx, signed(payment(2500000)), connection);
  if (scenario === "duplicate") return receivePaystackEvent(state, ctx, signed(payment(2500000)), connection);
  if (scenario === "amount_mismatch") return receivePaystackEvent(state, ctx, signed(payment(2500001)), connection);
  return first;
}

/** Remove connection routing and normalized provider payload from browser lists. Replays are rechecks; verification checks are not counted. */
export function providerEventView(record: ValopayRecord) {
  return { id: record.id, name: record.name, status: record.status, reference: record.reference, amountKobo: record.amountKobo, createdAt: record.createdAt, updatedAt: record.updatedAt,
    mode: record.data.mode, message: record.data.message, deliveryCount: record.data.deliveryCount, replayCount: (record.data.replayHistory || []).filter((entry: unknown) => !verificationCheck(entry)).length, financialRecordsCreated: 0 as const };
}
