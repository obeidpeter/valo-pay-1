import { sameJson } from '@workspace/valopay-schema';
import type { ValopayRecord } from './types';

/** An entry the saved-event verification recorded after asking Paystack; a replay's entry has no kind. */
export const verificationCheck = (entry: unknown) => ["independent_transaction_check", "independent_transaction_verification"].includes(String((entry as { kind?: unknown } | undefined)?.kind));
/** Adapter outcomes that say nothing about the payment: a refused key, an unreadable or live-mode answer, a transport failure. */
const inconclusiveReasons = ["authentication", "invalid_response", "live_mode", "timeout", "unavailable", "rate_limited", "not_found"];
/**
 * An event an earlier build quarantined only because its last verification check was inconclusive, as its
 * history shows. Nothing disagreed with the signed evidence, so it may be verified again (never replayed).
 */
export function quarantinedWithoutDisagreement(record: ValopayRecord): boolean {
  const last = record.data.replayHistory?.at(-1);
  return record.status === "quarantined" && last?.kind === "independent_transaction_check" && last.result === "quarantined" && last.outcome?.outcome === "unknown" && inconclusiveReasons.includes(last.outcome.reason);
}
/** Repository guard: delivery/replay bookkeeping can grow without rewriting the authenticated evidence. */
export function assertProviderEventChange(before: ValopayRecord, after: ValopayRecord) {
  const stable = (record: ValopayRecord) => {
    const data = { ...record.data };
    for (const key of ["deliveryCount", "lastReceivedAt", "message", "replayHistory"]) delete data[key];
    return { ...record, status: before.status, updatedAt: before.updatedAt, data };
  };
  const reject = (): never => { throw Object.assign(new Error("Provider evidence is immutable; only delivery counts and recorded rechecks may change."), { status: 409 }); };
  if (!sameJson(stable(before), stable(after))) reject();
  const previousCount = before.data.deliveryCount, nextCount = after.data.deliveryCount;
  if (!Number.isSafeInteger(nextCount) || nextCount < previousCount) reject();
  const previousHistory = before.data.replayHistory || [], nextHistory = after.data.replayHistory || [];
  if (!Array.isArray(nextHistory) || nextHistory.length < previousHistory.length || nextHistory.length > previousHistory.length + 1 || !sameJson(nextHistory.slice(0, previousHistory.length), previousHistory)) reject();
  const replayed = nextHistory.length > previousHistory.length;
  if (!replayed && (before.status !== after.status || before.data.message !== after.data.message)) reject();
  const held = ["quarantined", "rejected_fixture"].includes(before.status) && !(quarantinedWithoutDisagreement(before) && verificationCheck(nextHistory.at(-1)));
  if (replayed && (held || nextHistory.at(-1)?.result !== after.status)) reject();
  if (before.data.lastReceivedAt !== after.data.lastReceivedAt && (nextCount === previousCount || !Number.isFinite(Date.parse(after.data.lastReceivedAt)) || Date.parse(after.data.lastReceivedAt) < Date.parse(before.data.lastReceivedAt))) reject();
}
