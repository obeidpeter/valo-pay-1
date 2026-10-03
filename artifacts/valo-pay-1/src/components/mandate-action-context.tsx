import { readableLabel } from './record-label';
import { formatKobo } from '@/lib/formatters';

type Mandate = { name?: string; reference?: string; status: string; amountKobo: number; data?: Record<string, unknown> };

/** Confirm the actual domain transition; recovery never promises to recreate cancelled attempts. */
export function MandateActionContext({ mandate, customerName, customerReference, action, policyName }: {
  mandate: Mandate; customerName?: string; customerReference?: string; action: string; policyName?: string;
}) {
  const current = readableLabel(mandate.status);
  const descriptions: Record<string, { after: string; consequence: string; recovery: string }> = {
    mandate_suspend: {
      after: 'Suspended',
      consequence: 'Scheduled collection attempts on this mandate will be cancelled. Attempts already sent to a provider keep their recorded outcomes.',
      recovery: 'You can resume this mandate later. Resuming does not restore cancelled attempts, so check the collection schedule before you arrange another attempt.',
    },
    mandate_reinstate: {
      after: 'Active',
      consequence: 'Collection can use this mandate again. Cancelled attempts stay cancelled, and this action does not create a new attempt.',
      recovery: 'You can suspend the mandate again later.',
    },
    mandate_cancel: {
      after: 'Cancelled',
      consequence: 'Scheduled collection attempts on this mandate will be cancelled. The mandate and its history stay on record.',
      recovery: 'Cancelling cannot be undone. To collect again, reissue the mandate with fresh consent evidence. Reissuing creates a new mandate.',
    },
    mandate_reissue: {
      after: mandate.status === 'pending_activation' ? 'Existing mandate: Expired · New mandate: Awaiting activation' : `Existing mandate: ${current} · New mandate: Awaiting activation`,
      consequence: 'This creates a new mandate and consent record for this customer, with the same activation method and the debit limit you enter below. A new limit needs a reissue because the limit is part of the customer’s consent. Existing instalments are not moved to the new mandate automatically.',
      recovery: 'The old mandate keeps its history. If you no longer need the new mandate, cancel it. Reissuing does not reactivate the old mandate.',
    },
    activation_reminder: {
      after: `${current} (unchanged)`,
      consequence: 'One simulated reminder will be recorded and count towards this mandate’s reminder limit. No customer message is sent.',
      recovery: 'The reminder remains in the history and cannot be removed. Check the customer and reference before recording it.',
    },
    notify_policy_change: {
      after: `${current} (unchanged)`,
      consequence: 'A simulated policy change notice will be saved. The mandate’s retry policy does not change. This notice is not proof that the provider accepted it.',
      recovery: 'The notice stays in the history. Applying a policy version is a separate action, and it needs evidence that the notice was accepted.',
    },
    apply_policy_version: {
      after: `${current} · ${policyName || 'Choose the approved policy version below'}`,
      consequence: 'The chosen policy version applies to this mandate only after Valo Pay 1 checks the accepted notice and any fresh consent needed. Earlier versions stay in its history.',
      recovery: 'There is no automatic undo. A later policy change must meet the same notice and consent requirements.',
    },
  };
  const detail = descriptions[action];
  if (!detail) return null;
  return <section aria-label="Mandate change summary" className="space-y-3 rounded-lg border bg-secondary/20 p-4 text-sm">
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
      <dt className="text-muted-foreground">Customer</dt><dd className="break-words font-medium">{customerName || 'Customer name unavailable'}{customerReference && <span className="block text-xs font-normal text-muted-foreground">{customerReference}</span>}</dd>
      <dt className="text-muted-foreground">Mandate</dt><dd className="break-words font-medium">{mandate.reference || mandate.name || 'Reference unavailable'}</dd>
      <dt className="text-muted-foreground">Debit limit</dt><dd className="tabular-nums">{formatKobo(mandate.amountKobo)}</dd>
      <dt className="text-muted-foreground">Current status</dt><dd>{current}</dd>
      <dt className="text-muted-foreground">After confirmation</dt><dd className="font-medium">{detail.after}</dd>
    </dl>
    <p className="border-t pt-3">{detail.consequence}</p>
    <p className="text-muted-foreground">{detail.recovery}</p>
    <p className="text-xs font-medium">This changes the sample record only. Nothing is sent to a bank.</p>
  </section>;
}
