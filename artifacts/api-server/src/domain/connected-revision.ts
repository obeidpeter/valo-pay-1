import { createHash } from "node:crypto";
import type { DomainState } from "./types";
import { payable } from "./connected-context";

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
