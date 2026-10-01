import { nairaText, normaliseRefundStatus, normaliseReversalStatus, paymentMoneyReturned, paymentRefundedKobo, paymentUnappliedKobo, providerIdentityOf } from '@workspace/valopay-schema';

type ActingWorkspace = { role: string; actor: string; accessMode?: string } | undefined;
type PermissionRecord = { status?: string; reference?: string; amountKobo?: number; data?: Record<string, unknown> } | null;
/** An action on a record; a proposed match's decision also names the payment and instalment it applies. */
export type PermissionRequest = { action?: string; kind?: string; record?: PermissionRecord; payment?: PermissionRecord; instalment?: PermissionRecord };

const operators = ['Admin', 'Operations', 'Finance'];
const recordRoles: Record<string, string[]> = {
  customers: operators, mandates: ['Admin', 'Operations'], 'due-items': operators,
  attempts: ['Admin', 'Operations'], observations: operators,
  policies: ['Admin'], templates: ['Admin'], experiments: ['Admin'], evidence: ['Admin'], cutovers: ['Admin'],
  commercial: ['Admin', 'Finance'], costs: ['Admin', 'Finance'], 'settlement-batches': ['Admin', 'Finance'],
  exceptions: operators, reviews: [...operators, 'Compliance reviewer'],
  calendar: ['Admin', 'Operations'],
};
const actionRoles: Record<string, string[]> = {
  kill_switch: ['Admin'], approve_kill_switch_off: ['Admin'], update_settings: ['Admin'], import_records: operators,
  mandate_suspend: ['Admin', 'Operations'], mandate_cancel: ['Admin', 'Operations'], mandate_reinstate: ['Admin', 'Operations'],
  mandate_reissue: ['Admin', 'Operations'], activation_reminder: ['Admin', 'Operations'],
  notify_policy_change: ['Admin', 'Operations'], apply_policy_version: ['Admin', 'Operations'],
  create_policy: ['Admin'], edit_policy: ['Admin'], submit_policy: ['Admin'], new_policy_version: ['Admin'],
  approve_policy: ['Compliance reviewer'], reject_policy: ['Compliance reviewer'],
  create_template: ['Admin'], edit_template: ['Admin'], submit_template: ['Admin'], new_template_version: ['Admin'],
  approve_template: ['Compliance reviewer'], reject_template: ['Compliance reviewer'],
  run_reconciliation: operators, daily_close: operators,
  confirm_allocation: ['Admin', 'Finance'], reject_allocation: ['Admin', 'Finance'], manual_allocate: ['Admin', 'Finance'],
  review_allocation: ['Admin', 'Finance'], record_refund: ['Admin', 'Finance'], release_dispute: ['Admin', 'Finance'], issue_invoice: ['Admin', 'Finance'], confirm_discount_terms: ['Admin', 'Finance'],
  edit_batch: ['Admin', 'Finance'], resolve_exception: operators,
  simulate_failure: ['Admin', 'Operations'], hand_back: ['Admin', 'Operations'],
  backtest_policy: [...operators, 'Compliance reviewer'], preregister_experiment: ['Admin'],
};

/** What an action does, in the words a refusal uses: "Only Admin or Finance can confirm a match." */
const actionWords: Record<string, string> = {
  kill_switch: 'turn the emergency stop on or off', approve_kill_switch_off: 'approve turning the emergency stop off',
  update_settings: 'change collection settings', import_records: 'import records',
  mandate_suspend: 'suspend a mandate', mandate_cancel: 'cancel a mandate', mandate_reinstate: 'resume a mandate',
  mandate_reissue: 'reissue a mandate', activation_reminder: 'record an activation reminder',
  notify_policy_change: 'record a policy change notice', apply_policy_version: 'apply a policy version',
  create_policy: 'draft a retry policy', edit_policy: 'edit a retry policy', submit_policy: 'submit a retry policy for review',
  new_policy_version: 'draft a new version of a retry policy', approve_policy: 'approve a retry policy', reject_policy: 'reject a retry policy',
  create_template: 'draft a message template', edit_template: 'edit a message template', submit_template: 'submit a message template for review',
  new_template_version: 'draft a new version of a message template', approve_template: 'approve a message template', reject_template: 'request changes to a message template',
  run_reconciliation: 'run reconciliation', daily_close: 'run a daily close',
  confirm_allocation: 'confirm a match', reject_allocation: 'reject a match', manual_allocate: 'allocate a payment',
  review_allocation: 'review a match', record_refund: 'record a refund', release_dispute: 'release an instalment from dispute',
  issue_invoice: 'issue an invoice', confirm_discount_terms: 'confirm discount dates',
  edit_batch: 'edit a settlement batch', resolve_exception: 'resolve an exception',
  simulate_failure: 'simulate a failed collection attempt', hand_back: 'return collection to the previous owner',
  backtest_policy: 'test a retry policy', preregister_experiment: 'register an experiment plan',
};
/** What adding or editing a record of a kind is called in a refusal. */
const kindWords: Record<string, string> = {
  customers: 'add or edit customers', mandates: 'add or edit mandates', 'due-items': 'add or edit instalments',
  attempts: 'add or edit collection attempts', observations: 'add or edit payment evidence',
  policies: 'draft or edit retry policies', templates: 'draft or edit message templates', experiments: 'add or edit experiments',
  evidence: 'add or edit evidence', cutovers: 'record collection transfers', commercial: 'add or edit commercial terms',
  costs: 'add or edit costs', 'settlement-batches': 'add or edit settlement batches', exceptions: 'edit exceptions',
  reviews: 'record reviews', calendar: 'add or edit calendar dates',
};
/** The roles as a refusal names them, exactly as the standard lists them and with no articles: "Admin", "Admin, Operations or Finance". */
export function rolesInWords(roles: readonly string[]): string {
  return roles.length > 1 ? `${roles.slice(0, -1).join(', ')} or ${roles.at(-1)}` : roles[0] ?? '';
}
/**
 * A refusal by role (docs/design/writing.md, Notices): "Only {roles} can {action}." and the specific reason when there
 * is one. A notice also names the reader's role and, where it is a demo role (outside a staff pilot), where to change
 * it. The reason under a disabled button is `brief` and stops at the reason: the bar above every page already shows
 * the role and, in the sandbox, links to Change demo role, so a table of disabled buttons does not repeat it.
 */
export function onlyRoles(roles: readonly string[], action: string, { reason, role, accessMode, brief = false }: { reason?: string; role?: string; accessMode?: string; brief?: boolean } = {}): string {
  const reader = brief || !role ? [] : [`Your role is ${role}.`, accessMode === 'staff' ? '' : 'Change your demo role in Settings.'];
  return [`Only ${rolesInWords(roles)} can ${action}.`, reason, ...reader].filter(Boolean).join(' ');
}

/**
 * Why the service refuses to allocate a payment to any instalment, in its words (assertPaymentAllocatable): it is in
 * another currency than naira, or its money went back to the payer. Null for a payment it would allocate.
 */
export function allocationRefusal(payment: PermissionRecord): string | null {
  if (!payment) return null;
  const currency = String(payment.data?.currency || 'NGN').trim().toUpperCase();
  if (currency !== 'NGN') return `Payment ${payment.reference} is in ${currency}. Instalments are owed in naira, so it cannot be allocated to one. Record its refund or resolve it with Finance.`;
  if (paymentMoneyReturned(payment)) return `Payment ${payment.reference} was ${normaliseReversalStatus(payment.data?.reversalStatus) === 'reversed' ? 'reversed by the provider' : 'refunded to the payer'}. Its money went back, so it cannot be allocated to an instalment.`;
  const refunded = paymentRefundedKobo(payment);
  if (refunded > 0 && paymentUnappliedKobo(payment) <= 0) return `Payment ${payment.reference} was refunded to the payer in part: ${nairaText(refunded)} went back, so nothing is left to allocate to an instalment.`;
  return null;
}

/**
 * The service's words when a hold for a renewed review of an earlier reversal decision refuses an action
 * (reconciliation-payments.ts and connected-checkout.ts in the API, which say exactly the same). Reconciliation records the hold on the payments and
 * instalments it concerns (heldForReversalReview); one the service derives before its first reconciliation is
 * not recorded yet, so the console cannot see it, and the service's refusal says so then.
 */
export const reversalReviewRefusals = {
  payment: 'This payment is on hold while Finance reviews an earlier reversal decision again. Resolve that review and run reconciliation before you allocate it.',
  instalment: 'This instalment is on hold while Finance reviews an earlier reversal decision again. Resolve that review and run reconciliation before you allocate a payment to it.',
  release: 'This instalment is on hold while Finance reviews an earlier reversal decision again. Resolve that review and run reconciliation before you release it from dispute.',
  checkout: 'This instalment is on hold while Finance reviews an earlier reversal decision again. Resolve that review and run reconciliation before you create a checkout for it.',
  authorise: 'This instalment is on hold while Finance reviews an earlier reversal decision again. Resolve that review and run reconciliation before this checkout can be authorised.',
} as const;

/** Whether reconciliation holds this payment or instalment for a renewed reversal review (data.legacyReversalReviewIds). */
export function heldForReversalReview(record: PermissionRecord | undefined): boolean {
  const ids = record?.data?.legacyReversalReviewIds;
  return Array.isArray(ids) && ids.length > 0;
}

/**
 * Presentation guard only. The server remains authoritative for every write. A refusal shown as a notice names the
 * reader's role; one shown under a disabled button (`brief`, from PermissionButton) says only who can and why.
 */
export function permissionReason(workspace: ActingWorkspace, { action, kind, record, payment, instalment }: PermissionRequest, { brief = false }: { brief?: boolean } = {}): string | null {
  if (!action && !kind) return null;
  if (!workspace) return 'Wait for your workspace permissions to load.';
  const reader = { role: workspace.role, accessMode: workspace.accessMode, brief };
  const allowed = action ? actionRoles[action] : recordRoles[kind!];
  if (!allowed) return 'Your role cannot do this.';
  if (!allowed.includes(workspace.role)) return onlyRoles(allowed, (action ? actionWords[action] : kindWords[kind!]) || 'do this', reader);
  if (!action && kind === 'exceptions' && ['resolved', 'closed'].includes(record?.status || '')) {
    return 'You cannot edit a resolved or closed exception. Its case keeps what happened.';
  }
  if (['approve_policy', 'reject_policy', 'approve_template', 'reject_template'].includes(action || '') && record?.data?.author === workspace.actor) {
    return 'You cannot review your own submission. Ask a different Compliance reviewer.';
  }
  if (action === 'submit_template' && record?.data?.author !== workspace.actor) return 'Only this template’s author can submit it for review.';
  // Design-partner discount dates take two people: a staff account cannot confirm its own proposal, and every demo role is the sandbox's one visitor.
  if (action === 'confirm_discount_terms' && workspace.accessMode !== 'staff') return 'A different person must confirm these discount dates. Switching demo roles is not a second person. In a pilot, a second Admin or Finance team member confirms them.';
  if (action === 'confirm_discount_terms' && (record?.data?.discountReview as { reviewedBy?: unknown } | undefined)?.reviewedBy === workspace.actor) return 'You proposed these discount dates. A different Admin or Finance team member must confirm them.';
  if ((['edit_template', 'edit_policy'].includes(action || '') || (!action && ['templates', 'policies'].includes(kind || ''))) && record?.data?.author && record.data.author !== workspace.actor) return 'Only this draft’s author can edit it.';
  // One refund is recorded per payment, even one that returned only part of it, and reversed money already went back.
  if (action === 'record_refund' && normaliseReversalStatus(record?.data?.reversalStatus) === 'reversed') return 'The provider reversed this payment, so its money has already gone back. There is nothing to refund.';
  if (action === 'record_refund' && normaliseRefundStatus(record?.data?.refundStatus) === 'refunded') return 'A refund is already recorded for this payment.';
  // A held payment or instalment takes no allocation, confirmation or release. A proposed match links its payment to its
  // instalment, so the service, which checks the instalment first, finds the instalment held when either is.
  if (action === 'manual_allocate' && heldForReversalReview(record)) return reversalReviewRefusals.payment;
  if (action === 'confirm_allocation' && (heldForReversalReview(instalment) || heldForReversalReview(payment))) return reversalReviewRefusals.instalment;
  if (action === 'release_dispute' && heldForReversalReview(record)) return reversalReviewRefusals.release;
  // A payment in another currency, or whose money went back, takes no allocation: its Allocate says why, as the service would.
  const refusal = action === 'manual_allocate' ? allocationRefusal(record ?? null) : null;
  if (refusal) return refusal;
  // A settlement batch held for its provider identity, or a renewed review of its hold, is resolved only by confirming whose payout it is (FIN-03).
  if (action === 'resolve_exception' && providerIdentityOf(record?.data?.condition) && !['Admin', 'Finance'].includes(workspace.role)) return onlyRoles(['Admin', 'Finance'], 'resolve this exception', { ...reader, reason: 'Resolving it confirms whose payout the settlement batch is.' });
  // Confirming a pay-by-bank payment whose outcome stayed unknown records a receipt, so Finance records it.
  if (action === 'resolve_exception' && record?.data?.linkedKind === 'connected-intents' && !['Admin', 'Finance'].includes(workspace.role)) return onlyRoles(['Admin', 'Finance'], 'record the outcome of a Pay by Bank payment', reader);
  // Reconciliation raises a renewed review of an earlier reversal decision for Finance, and only Finance or an administrator resolves it.
  if (action === 'resolve_exception' && record?.data?.legacyResolutionReview && !['Admin', 'Finance'].includes(workspace.role)) return onlyRoles(['Admin', 'Finance'], 'record a second review of an earlier reversal decision', reader);
  if (!action && ['templates', 'policies'].includes(kind || '') && record && !['draft', 'rejected'].includes(record.status || '')) {
    return 'You cannot edit a submitted or approved version. Select Draft next version to change it.';
  }
  return null;
}
