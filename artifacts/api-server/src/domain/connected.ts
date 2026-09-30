/** Connected workspace orchestration. Financial transitions belong to their capability modules. */
import { connectedActionInputSchema, type ConnectedActionInput } from "@workspace/valopay-schema";
import type { Context, DomainState, RecordOf } from "./types";
import { recordsOf } from "./records";
import { clearedExceptionsNote } from "./reconciliation";
import { creditView, runCreditAction } from "./connected-credit-service";
import { cashView, runCashAction } from "./connected-cash-service";
import { reject, payable, intentOpen, externalScheduled } from "./connected-context";
import { consentPurposes, purposeLabels, consentActive, addConsent, revokeConsent } from "./connected-consents";
import { connectedRevision } from "./connected-revision";
import { paymentAction } from "./connected-checkout";
import { onlyRoles } from "../lib/refusal-words";

// Preserve the connected-workspace public contract while its workflows have separate ownership.
export const connectedActionSchema = connectedActionInputSchema;
export type ConnectedAction = ConnectedActionInput;
export { consentPurposes, purposeLabels, consentActive } from "./connected-consents";
export { connectedRevision } from "./connected-revision";
export { resolveUnknownCheckout } from "./connected-checkout";

const gates = [
  [
    "G0",
    "Provider and legal readiness",
    "Signed contracts, an agreed legal role and approved ways to connect",
  ],
  [
    "G-DATA",
    "Real data",
    "A privacy assessment, rules for keeping data, and proof that each lender’s data is kept apart and secure",
  ],
  [
    "G-OB",
    "Connected accounts",
    "Which banks and accounts are covered, the customer’s permission, and proof of where the data comes from",
  ],
  [
    "G-A2A",
    "Pay by Bank",
    "Customer authorisation at the bank, confirmed payments and checks that stop an instalment being collected twice",
  ],
  [
    "G-CREDIT",
    "Credit assessments",
    "Validated scoring rules owned by the lender, and review by a different person",
  ],
  [
    "G-MODEL",
    "Predictive credit models",
    "Proof that the model predicts accurately, and rules for managing it",
  ],
  [
    "G-AUTO",
    "Automated credit decisions",
    "Separate legal approval for decisions made without a person",
  ],
  [
    "G-ERP",
    "Posting to accounting software",
    "Finance approval, limited access and no changes to closed periods",
  ],
  [
    "G-PAYOUT",
    "Payments from the business’s own account",
    "Approval from the business’s bank and its signatories, and a check of every payment",
  ],
  ["G-TAX", "Tax filing", "A tax review and the right to file for the business"],
] as const;
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
      "Connected banking works only with sample data for now.",
      403,
    );
  if (ctx.role === "Read-only")
    reject(onlyRoles(["Admin", "Operations", "Finance", "Compliance reviewer"], "make changes in connected banking", ctx.accessMode), 403);
  if (input.expectedRevision !== connectedRevision(state))
    reject(
      "Connected banking changed after you opened it. Reload the page and try again.",
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
      "This lender has reached its limit for connected banking records, so you cannot start new work. You can still withdraw permissions and record outcomes for payments in progress.",
      409,
    );
  if (input.action === "consent.grant")
    return addConsent(state, ctx, input.data);
  if (input.action === "consent.revoke") return revokeConsent(state, ctx, input);
  if (input.action.startsWith("payment."))
    return paymentAction(state, ctx, input, cleared);
  if (input.action.startsWith("credit."))
    return runCreditAction(state, ctx, input);
  if (input.action.startsWith("cash.")) return runCashAction(state, ctx, input);
  reject("This connected banking action is not available.");
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
      name: "Sample business",
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
