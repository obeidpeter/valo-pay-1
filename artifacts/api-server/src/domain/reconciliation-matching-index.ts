/** Read-only matching lookups shared by the rule ladder and historical reversal-hold review. */
import { type TypedRecord, type DomainState } from "./types";
import { outstanding } from "./reconciliation-values";
import { recordsOf } from "./records";

export function eligibleForAutomaticMatching(due: TypedRecord<"due-items">): boolean {
  return outstanding(due) > 0 && !["in_dispute", "unpaid_final", "cancelled", "closed"].includes(due.status);
}

/** Built after canonicalisation; records are live references so later payments
 * see earlier allocations/duplicate holds. No lookup survives a reconcile call. */
export class MatchIndex {
  attempts = new Map<string, TypedRecord<"attempts">>();
  dues = new Map<string, TypedRecord<"due-items">>();
  duesByCustomer = new Map<string, TypedRecord<"due-items">[]>();
  paymentsByCustomer = new Map<string, TypedRecord<"payments">[]>();
  /** Every instalment of the lender by its reference's words (referenceWords), and the most words a reference has. */
  duesByReference = new Map<string, TypedRecord<"due-items">[]>();
  longestReference = 0;
  constructor(state: DomainState) {
    for (const attempt of recordsOf(state, "attempts")) {
      const key = attempt.data.providerReference || attempt.reference;
      if (key && !this.attempts.has(key)) this.attempts.set(key, attempt);
    }
    for (const due of recordsOf(state, "due-items")) {
      this.dues.set(due.id, due);
      const group = this.duesByCustomer.get(due.customerId) ?? [];
      group.push(due); this.duesByCustomer.set(due.customerId, group);
      const words = referenceWords(due.reference);
      if (!words.length) continue;
      this.duesByReference.set(words.join(" "), [...(this.duesByReference.get(words.join(" ")) ?? []), due]);
      this.longestReference = Math.max(this.longestReference, words.length);
    }
    for (const payment of recordsOf(state, "payments")) {
      const group = this.paymentsByCustomer.get(payment.customerId) ?? [];
      group.push(payment); this.paymentsByCustomer.set(payment.customerId, group);
    }
  }
}

/** A reference or narration as its words: letters and digits, lower case, split at anything else, so LN0042-10 is "ln0042 10". */
const referenceWords = (text: unknown): string[] => String(text ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * R4: the instalments a narration names, read on word boundaries across the
 * whole lender. Where references overlap the longest wins, so "LN0042-10" is
 * not also "LN0042"; references that read alike name every instalment they fit.
 */
export function narrationInstalments(index: MatchIndex, narration: unknown): TypedRecord<"due-items">[] {
  const words = referenceWords(narration), found: { start: number; end: number; dues: TypedRecord<"due-items">[] }[] = [];
  for (let start = 0; start < words.length; start++) {
    for (let end = start + 1; end <= Math.min(words.length, start + index.longestReference); end++) {
      const dues = index.duesByReference.get(words.slice(start, end).join(" "));
      if (dues) found.push({ start, end, dues });
    }
  }
  const longest = found.filter((span) => !found.some((other) => other.end - other.start > span.end - span.start && other.start <= span.start && other.end >= span.end));
  return [...new Set(longest.flatMap((span) => span.dues))];
}

/** The due item a Payment was collected for, by its strong keys: the attempt's provider debit reference, then the observation's explicit link. */
export function intendedDueItem(state: DomainState, payment: TypedRecord<"payments">, index?: MatchIndex): { due: TypedRecord<"due-items">; key: string } | undefined {
  const byAttempt = index ? index.attempts.get(payment.reference) : recordsOf(state, "attempts").find((attempt) => attempt.data.providerReference ? attempt.data.providerReference === payment.reference : Boolean(attempt.reference) && attempt.reference === payment.reference);
  const candidate = byAttempt
    ? { id: String(byAttempt.data.dueItemId), key: byAttempt.data.providerReference ? "attempt_provider_reference" : "attempt_reference" }
    : payment.data.dueItemId ? { id: String(payment.data.dueItemId), key: "observation_due_item" } : undefined;
  if (!candidate) return undefined;
  const due = index ? index.dues.get(candidate.id) : recordsOf(state, "due-items").find((record) => record.id === candidate.id);
  if (!due || (payment.customerId && due.customerId !== payment.customerId)) return undefined;
  return { due, key: candidate.key };
}
