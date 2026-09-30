/** Pure connected-workspace record and role predicates, shared by its capability workflows. */
import type { Context, DomainState, ValopayRecord, RecordOf } from "./types";
import { notFound, onlyRoles } from "../lib/refusal-words";

export function reject(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}
/** An instalment Pay-by-bank offers: money is owed and nothing holds it. */
export function payable(r: ValopayRecord) {
  return (
    Number(r.data.outstandingKobo ?? r.amountKobo) > 0 &&
    !["paid", "closed", "cancelled", "in_dispute"].includes(r.status)
  );
}
export function owned<K extends string>(
  state: DomainState,
  id: string | undefined,
  kind: K,
): RecordOf<K> {
  return (state.records.find(
    (r) => r.id === id && r.kind === kind && r.merchantId === state.merchant.id,
  ) ?? reject(notFound("Record"), 404)) as RecordOf<K>;
}
/** Refuses a role the action does not allow: "Only Admin or Operations can grant permissions." */
export function allow(ctx: Context, roles: string[], action: string) {
  if (!roles.includes(ctx.role))
    reject(onlyRoles(roles, action, ctx.accessMode), 403);
}
export function intentOpen(r: ValopayRecord) {
  return (
    r.kind === "connected-intents" &&
    ["authorised", "pending", "unknown"].includes(r.status)
  );
}
export function externalScheduled(r: ValopayRecord) {
  return (
    r.kind === "attempts" &&
    r.status === "scheduled" &&
    r.data.source !== "valo"
  );
}
