import { nairaText, normaliseRefundStatus, normaliseReversalStatus, paymentMoneyReturned, paymentRefundedKobo, paymentUnappliedKobo, providerIdentityOf } from '@workspace/valopay-schema';

type ActingWorkspace = { role: string; actor: string } | undefined;
type PermissionRecord = { status?: string; reference?: string; amountKobo?: number; data?: Record<string, unknown> } | null;
export type PermissionRequest = { action?: string; kind?: string; record?: PermissionRecord };

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
  review_allocation: ['Admin', 'Finance'], record_refund: ['Admin', 'Finance'], release_dispute: ['Admin', 'Finance'], issue_invoice: ['Admin', 'Finance'],
  edit_batch: ['Admin', 'Finance'], resolve_exception: operators,
  simulate_failure: ['Admin', 'Operations'], hand_back: ['Admin', 'Operations'],
  backtest_policy: [...operators, 'Compliance reviewer'], preregister_experiment: ['Admin'],
};

/**
 * Why the service refuses to allocate a payment to any instalment, in its words (assertPaymentAllocatable): it is in
 * another currency than naira, or its money went back to the payer. Null for a payment it would allocate.
 */
export function allocationRefusal(payment: PermissionRecord): string | null {
  if (!payment) return null;
  const currency = String(payment.data?.currency || 'NGN').trim().toUpperCase();
  if (currency !== 'NGN') return `Payment ${payment.reference} is in ${currency}. Instalments are owed in naira, so it cannot be applied to one. Record its refund or resolve it with Finance.`;
  if (paymentMoneyReturned(payment)) return `Payment ${payment.reference} was ${normaliseReversalStatus(payment.data?.reversalStatus) === 'reversed' ? 'reversed by the provider' : 'refunded to the payer'}. Its money went back, so it cannot be allocated to an instalment.`;
  const refunded = paymentRefundedKobo(payment);
  if (refunded > 0 && paymentUnappliedKobo(payment) <= 0) return `Payment ${payment.reference} was refunded to the payer in part: ${nairaText(refunded)} went back, so nothing is left to allocate to an instalment.`;
  return null;
}

/** Presentation guard only. The server remains authoritative for every write. */
export function permissionReason(workspace: ActingWorkspace, { action, kind, record }: PermissionRequest): string | null {
  if (!action && !kind) return null;
  if (!workspace) return 'Wait for your workspace permissions to load.';
  const allowed = action ? actionRoles[action] : recordRoles[kind!];
  if (!allowed) return 'This action is unavailable for your role.';
  const roles = allowed.length < 2 ? allowed[0] : `${allowed.slice(0, -1).join(', ')} or ${allowed.at(-1)}`;
  if (!allowed.includes(workspace.role)) return `Requires ${roles}.`;
  if (!action && kind === 'exceptions' && ['resolved', 'closed'].includes(record?.status || '')) {
    return 'Resolved and closed exception details are preserved. Review the case history instead.';
  }
  if (['approve_policy', 'reject_policy', 'approve_template', 'reject_template'].includes(action || '') && record?.data?.author === workspace.actor) {
    return 'Ask a different Compliance reviewer. You cannot review your own submission.';
  }
  if (action === 'submit_template' && record?.data?.author !== workspace.actor) return 'Only this template’s author can submit it for review.';
  if ((['edit_template', 'edit_policy'].includes(action || '') || (!action && ['templates', 'policies'].includes(kind || ''))) && record?.data?.author && record.data.author !== workspace.actor) return 'Only this draft’s author can edit it.';
  // One refund is recorded per payment, even one that returned only part of it, and reversed money already went back.
  if (action === 'record_refund' && normaliseReversalStatus(record?.data?.reversalStatus) === 'reversed') return 'The provider reversed this payment, so its money already went back.';
  if (action === 'record_refund' && normaliseRefundStatus(record?.data?.refundStatus) === 'refunded') return 'A refund is already recorded for this payment.';
  // A payment in another currency, or whose money went back, takes no allocation: its Allocate says why, as the service would.
  const refusal = action === 'manual_allocate' ? allocationRefusal(record ?? null) : null;
  if (refusal) return refusal;
  // A settlement batch held for its provider identity, or a renewed review of its hold, is resolved only by confirming whose payout it is (FIN-03).
  if (action === 'resolve_exception' && providerIdentityOf(record?.data?.condition) && !['Admin', 'Finance'].includes(workspace.role)) return 'Requires Admin or Finance: the exceptions of a settlement batch’s provider identity hold are Finance’s to resolve, by confirming whose payout the batch is.';
  // Confirming a pay-by-bank payment whose outcome stayed unknown records a receipt, so Finance records it.
  if (action === 'resolve_exception' && record?.data?.linkedKind === 'connected-intents' && !['Admin', 'Finance'].includes(workspace.role)) return 'Requires Admin or Finance: the outcome of a pay-by-bank payment is Finance’s to record.';
  if (!action && ['templates', 'policies'].includes(kind || '') && record && !['draft', 'rejected'].includes(record.status || '')) {
    return 'This submitted or approved version cannot be edited. Create a draft version to make changes.';
  }
  return null;
}
