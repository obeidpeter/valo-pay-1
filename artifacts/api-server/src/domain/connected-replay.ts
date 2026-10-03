import { isDeepStrictEqual } from "node:util";
import type { ConnectedActionResult } from "@workspace/valo-pay-1-schema";
import { boundWhenSaved, cashView, savedCashDisclosable } from "./connected-cash-service";
import { creditView } from "./connected-credit-service";
import type { Context, DomainState, ValopayRecord } from "./types";

function refuse(status: 403 | 409, detail: string): never {
  throw Object.assign(new Error(`This request was already completed, but its saved result can no longer be shown with the current permissions or review. ${detail} The action has not been run again.`), { status });
}
const sameRecord = (state: DomainState, saved: ValopayRecord): ValopayRecord => {
  const current = state.records.find((record) => record.id === saved.id && record.kind === saved.kind && record.merchantId === state.merchant.id);
  if (!current || !isDeepStrictEqual(current, saved)) return refuse(409, "Open the current record to see what changed.");
  return current;
};

/** An idempotency receipt proves an earlier outcome; it does not grant future
 * access to a score or reusable bank/ERP file. Check a locked current snapshot
 * without executing the command, changing its receipt, or replacing its outcome.
 * Ordinary consent/payment receipts remain historical status evidence.
 *
 * The person who sent the request retries it, a sandbox visitor or a signed-in
 * staff member alike: its key is theirs alone, since the journal entry that
 * holds its answer is the sender's (its owner, actor and role must match) and
 * the route's fingerprint names the actor, so a colleague's key never reaches
 * this check. What is checked here is the lender, a synthetic sandbox, and the
 * sender's current role, grants and review. */
export function assertConnectedReplayAllowed(state: DomainState, ctx: Context, action: string, saved: ConnectedActionResult): void {
  if (!action.startsWith("credit.") && !action.startsWith("cash.")) return;
  if (state.settings.environment !== "sandbox") refuse(403, "This result can be shown only for lenders with sample data.");
  if (action.startsWith("credit.")) {
    const record = sameRecord(state, saved.record as ValopayRecord);
    const view = creditView(state, ctx);
    if (action === "credit.review" ? !view.canReview : !view.canAssess) refuse(403, "Your current role cannot see this result.");
    const assessmentId = action === "credit.review" ? record.data.assessmentRecordId : record.id;
    const assessment = view.assessments.find((item) => item.id === assessmentId);
    if (!assessment) refuse(409, "The assessment is no longer available.");
    // An assessment already blocked at creation may legitimately have no
    // grants. It is safe to replay only its original unscored, redacted result.
    const original = action === "credit.assess" ? record.data.result : undefined;
    const originallyRedacted = original?.state === "blocked" && original.features === null && original.score === null && original.affordability === null;
    if (assessment.permissionRestricted && !originallyRedacted) refuse(403, "A permission was withdrawn, expired or replaced. Grant it again, then run a new assessment.");
    return;
  }

  const financeOnly = ["cash.erp.review", "cash.erp.export", "cash.vat.export", "cash.payroll.approve", "cash.payroll.export", "cash.payroll.reconcile"].includes(action);
  const roles = financeOnly ? ["Finance"] : action === "cash.forecast" ? ["Admin", "Operations", "Finance"] : ["Admin", "Operations"];
  if (!roles.includes(ctx.role)) refuse(403, "Your current role cannot see this result.");
  const view = cashView(state, ctx);
  const needsErp = action.startsWith("cash.erp.") || action === "cash.vat.export";
  const needsPayroll = action.startsWith("cash.payroll.");
  // Finance can still reconcile retained outcomes after revocation. A full
  // historical receipt includes more than that minimal status view, so refuse
  // replay and direct the caller to the current desk rather than disclose it.
  if (!view.permissions.read || (needsErp && !view.permissions.erp) || (needsPayroll && !view.permissions.payroll)) refuse(403, "Open Cash Desk to see the records and outcomes you can still view.");
  const outcome = saved.record as { record?: ValopayRecord; data: Record<string, unknown> };
  if (!outcome.record) return; // cash.initialize can already be initialised.
  const record = sameRecord(state, outcome.record);
  // The rule the desk discloses a saved view, forecast or VAT schedule by.
  if (boundWhenSaved(record.kind) && !savedCashDisclosable(state, ctx.now)(record))
    refuse(409, "The permission or evidence it used has changed or cannot be checked. Prepare a new view or export.");
  if (record.kind === "connected-cash-erp") {
    const current = view.erpDrafts.find((draft) => draft.id === record.id);
    if (!current || current.status === "review_required") refuse(409, "The accounting permission or approval changed. Refresh the accounting review.");
    if (action === "cash.erp.export" && (!current.manifest || !isDeepStrictEqual(current.manifest, outcome.data.manifest))) refuse(409, "The accounting setup, period, receipt or approved file changed. Prepare a new export file.");
  }
  if (record.kind === "connected-cash-payroll") {
    const current = view.payrollPlans.find((plan) => plan.id === record.id);
    if (!current || current.status === "review_required") refuse(409, "The payroll permission or approval changed. Refresh the payroll funding review.");
    if (action === "cash.payroll.export" && (!current.manifest || !isDeepStrictEqual(current.manifest, outcome.data.manifest))) refuse(409, "The payroll funding, item outcomes or approved file changed. Check the current payroll funding plan.");
  }
}
