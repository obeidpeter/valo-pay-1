/** Renewed reversal-review holds and restoration of the instalment status each hold paused. */
import { type TypedRecord, type DomainState, type Context } from "./types";
import { recordsWhere } from "./record-index";
import { resolveExceptionType, isOpenException, counted } from "@workspace/valo-pay-1-schema";
import { outstanding } from "./reconciliation-values";
import { balanceStatus, cancelUnsentAttempts, dueStatusText } from "./reconciliation-instalments";
import { intendedDueItem } from "./reconciliation-matching-index";
import { recordsOf, touch } from "./records";
import { noteUpdate } from "./reconciliation-exceptions";
import { reversalHoldScope } from "./reversal-review";
import { isDeepStrictEqual } from "node:util";

/** What a renewed reversal review's hold does, as the review's notes say (an earlier build's open review gains it as a dated line). */
export const REVERSAL_HOLD_RULE = "While this review is open, related payments cannot be allocated. Instalments still being collected are held in dispute; paid instalments, and those unpaid after their final attempt, keep their status. When the review is resolved, the next reconciliation returns each held instalment to its earlier status, unless a dispute was recorded for it meanwhile.";

/** The instalment statuses a renewed reversal review's hold pauses: those still being collected. */
const pausedStatuses: readonly string[] = ["scheduled", "in_collection", "partially_paid"];

/** Where a reversal review's hold paused an instalment (legacyReversalReviewPause): the status it had and when; inferred when its records gave that status, as for one an earlier build's hold put in dispute. */
interface ReversalPause { status: TypedRecord<"due-items">["status"]; pausedAt: string; inferred?: true }

const pauseOf = (due: TypedRecord<"due-items">): ReversalPause | undefined => due.data.legacyReversalReviewPause as ReversalPause | undefined;

/**
 * Whether a dispute was recorded for an instalment at or after `since` and
 * after its last release from dispute: a customer_dispute exception, or a
 * reversal of money applied to it (an earlier build put such an instalment in
 * dispute without an exception). The dispute workflow owns an instalment so
 * disputed, whatever a reversal review's hold did.
 */
function disputeRecorded(state: DomainState, due: TypedRecord<"due-items">, since = ""): boolean {
  const released = String((due.data.disputeRelease as { releasedAt?: unknown } | undefined)?.releasedAt ?? "");
  const recorded = (at: unknown) => String(at) >= since && String(at) > released;
  return recordsWhere(state, "exceptions", "data.linkedRecordId", due.id).some((item) => resolveExceptionType(item.data.type) === "customer_dispute" && recorded(item.createdAt))
    || recordsWhere(state, "allocations", "data.dueItemId", due.id).some((item) => item.status === "superseded" && recorded(item.updatedAt) && recordsWhere(state, "payments", "id", String(item.data.paymentId))[0]?.data.reversalApplied === true);
}

/**
 * The status an instalment an earlier build's reversal review hold put in
 * dispute had before it, as its records establish it: paid with nothing
 * outstanding; unpaid after its final attempt once the retry engine gave up on
 * it (giveUpRule: the engine never evaluates an instalment in dispute, so it
 * gave up before the hold); otherwise part-paid, or scheduled or in collection
 * by its attempts (balanceStatus).
 */
function statusBeforeHold(state: DomainState, due: TypedRecord<"due-items">): TypedRecord<"due-items">["status"] {
  if (outstanding(due) === 0) return "paid";
  return due.data.giveUpRule ? "unpaid_final" : balanceStatus(state, due);
}

/**
 * The instalments PR #61's build could hold for these renewed reviews, by its
 * own rule, which followed a reversal's reference through any connection and
 * any allocation: every instalment of a payment with the reference, the one its
 * evidence named or it was proposed for, the one the reversal named, those of
 * debits with the reference, and every instalment still carrying its hold.
 */
function earlierHoldReach(state: DomainState, reviews: readonly TypedRecord<"exceptions">[]): Set<string> {
  const reach = new Set<string>(), references = new Set<string>();
  const add = (id: unknown) => { if (typeof id === "string" && id) reach.add(id); };
  for (const review of reviews) {
    const reversal = recordsWhere(state, "observations", "id", String(review.data.linkedRecordId))[0];
    if (!reversal?.reference) continue;
    references.add(reversal.reference);
    add(reversal.data.dueItemId);
    for (const key of ["reference", "data.providerReference"] as const) for (const attempt of recordsWhere(state, "attempts", key, reversal.reference)) add(attempt.data.dueItemId);
  }
  for (const reference of references) for (const key of ["reference", "data.providerReference"] as const) for (const payment of recordsWhere(state, "payments", key, reference)) {
    for (const allocation of recordsWhere(state, "allocations", "data.paymentId", payment.id)) add(allocation.data.dueItemId);
    add(payment.data.dueItemId); add(payment.data.proposedDueItemId); add(intendedDueItem(state, payment)?.due.id);
  }
  for (const due of recordsOf(state, "due-items")) if (Array.isArray(due.data.legacyReversalReviewIds) && due.data.legacyReversalReviewIds.length) reach.add(due.id);
  return reach;
}

/** The status a reversal review's hold took from an instalment in dispute (holdEarlierReversalPayments), which its release returns; undefined when a dispute was recorded for it, or no hold made its dispute. */
export function statusHeldInDispute(state: DomainState, due: TypedRecord<"due-items">): TypedRecord<"due-items">["status"] | undefined {
  const pause = pauseOf(due);
  if (pause) return disputeRecorded(state, due, pause.pausedAt) ? undefined : pause.status;
  const reviews = recordsOf(state, "exceptions").filter((item) => item.data.legacyResolutionReview);
  return reviews.length && earlierHoldReach(state, reviews).has(due.id) && !disputeRecorded(state, due) ? statusBeforeHold(state, due) : undefined;
}

/** An instalment a reversal review's hold gave its status back, and that status. */
interface HoldRestored { due: TypedRecord<"due-items">; status: TypedRecord<"due-items">["status"] }

/**
 * FIN-02, decision on the renewed reversal review's holds. A hold undoes no
 * allocation: while its review is open, the payments and instalments its
 * reversal names through its own provider identity and live allocations
 * (reversalHoldScope) carry the review (legacyReversalReviewIds), so no action
 * applies money to them, releases them or plans their collection, and the
 * review's notes say what the hold does (REVERSAL_HOLD_RULE). It never changes
 * the status of a paid instalment or one unpaid after its final attempt. One
 * still being collected is paused in dispute with the status it had
 * (legacyReversalReviewPause), and once no open review holds it, that status
 * comes back exactly, unless a dispute was recorded for it meanwhile
 * (disputeRecorded), which the dispute workflow then owns. Decision on the holds
 * PR #61's build wrote, which put every instalment they reached in dispute: one
 * in its reach (earlierHoldReach) that is in dispute with no dispute recorded
 * gets the status its records establish (statusBeforeHold), at once when that
 * is paid or unpaid after its final attempt or no review holds it now, and
 * otherwise stays paused with that status, marked inferred. Returns the
 * instalments given a status back.
 */
export function holdEarlierReversalPayments(state: DomainState, ctx: Context, reviews: readonly TypedRecord<"exceptions">[]): HoldRestored[] {
  if (!reviews.length) return [];
  const earlier = earlierHoldReach(state, reviews);
  const paymentHolds = new Map<string, Set<string>>(), dueHolds = new Map<string, Set<string>>();
  const hold = (holds: Map<string, Set<string>>, id: string, review: string) => holds.set(id, (holds.get(id) ?? new Set<string>()).add(review));
  for (const review of reviews.filter((item) => isOpenException(item.status))) {
    noteUpdate(review, ctx, REVERSAL_HOLD_RULE);
    const reversal = recordsWhere(state, "observations", "id", String(review.data.linkedRecordId))[0];
    if (!reversal) continue;
    const scope = reversalHoldScope(state, reversal);
    for (const payment of scope.payments) hold(paymentHolds, payment.id, review.id);
    for (const id of scope.dueIds) hold(dueHolds, id, review.id);
  }
  const record = (item: TypedRecord<"payments"> | TypedRecord<"due-items">, ids: string[]) => {
    if (isDeepStrictEqual(item.data.legacyReversalReviewIds ?? [], ids)) return;
    if (ids.length) item.data.legacyReversalReviewIds = ids; else delete item.data.legacyReversalReviewIds;
    touch(item, ctx.now);
  };
  for (const payment of recordsOf(state, "payments")) record(payment, [...(paymentHolds.get(payment.id) ?? [])].sort());
  const restored: HoldRestored[] = [];
  const restore = (due: TypedRecord<"due-items">, status: TypedRecord<"due-items">["status"]) => {
    due.status = status;
    if (status === "paid") cancelUnsentAttempts(state, due.id, ctx.now);
    touch(due, ctx.now);
    restored.push({ due, status });
  };
  for (const due of recordsOf(state, "due-items")) {
    const ids = [...(dueHolds.get(due.id) ?? [])].sort(), pause = pauseOf(due);
    record(due, ids);
    if (pause) {
      if (ids.length) continue;
      // The hold cleared: the status it paused comes back, unless a dispute was recorded meanwhile.
      delete due.data.legacyReversalReviewPause;
      touch(due, ctx.now);
      if (due.status === "in_dispute" && !disputeRecorded(state, due, pause.pausedAt)) restore(due, pause.status);
      continue;
    }
    if (ids.length && pausedStatuses.includes(due.status)) {
      due.data.legacyReversalReviewPause = { status: due.status, pausedAt: ctx.now };
      due.status = "in_dispute";
      touch(due, ctx.now);
      continue;
    }
    // An earlier build's hold put it in dispute.
    if (due.status !== "in_dispute" || !earlier.has(due.id) || disputeRecorded(state, due)) continue;
    const before = statusBeforeHold(state, due);
    if (!ids.length || !pausedStatuses.includes(before)) { restore(due, before); continue; }
    due.data.legacyReversalReviewPause = { status: before, pausedAt: ctx.now, inferred: true };
    touch(due, ctx.now);
  }
  return restored;
}

/** What the audit entry adds for instalments a reversal review's hold gave their status back: each instalment and that status. */
export function restoredStatusesNote(restored: readonly HoldRestored[]): string | undefined {
  if (!restored.length) return undefined;
  const named = restored.slice(0, 3).map(({ due, status }) => `${due.reference} (${dueStatusText(status)})`);
  const more = restored.length > 3 ? `; and ${counted(restored.length - 3, "more", "more")}` : "";
  return `Returned ${counted(restored.length, "instalment")} to the status ${restored.length === 1 ? "it" : "they"} had before a reversal review held ${restored.length === 1 ? "it" : "them"}: ${named.join("; ")}${more}.`;
}
