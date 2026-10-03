import { useSafeCreateRecord as useCreateRecord } from '@/lib/safe-mutations';
import { useEffect, useRef, useState } from 'react';
import { useUnsavedChanges } from '@/lib/unsaved-changes';
import { useDialogFocusReturn } from '@/lib/focus';
import { useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PermissionButton as Button } from '@/components/permission-button';
import { permissionReason } from '@/lib/permissions';
import { FieldError, FormAlert, FormErrorLinks, focusField, invalidProps } from '@/components/form-field';
import { useWorkspace } from '@/lib/workspace-context';
import { notifyDone, referenceOf, saidBy } from '@/lib/notify';
import { KEPT_IN_OPERATIONS, OpenOperations } from '@/components/pilot-ui';

export const reviewJobs = [
  { value: 'mandates', label: 'Mandate operations' },
  { value: 'retries', label: 'Retries' },
  { value: 'reconciliation', label: 'Payment matching' },
  { value: 'audit', label: 'Audit and dispute records' },
] as const;

/** Records the tasks actually checked; a count cannot establish which tasks were reviewed. The reviewer is the person
 * signed in and the time is the service's when it saves the review (MEA-05): neither is typed in. */
export function ReviewDialog({ onClose }: { onClose: () => void }) {
  const { merchantId, workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const [confirmedJobs, setConfirmedJobs] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState('');
  const restoreOpenerFocus = useDialogFocusReturn(true);
  const reviewFields = [{ name: 'note', label: 'Review notes' }];
  const corrected = (field: string) => setErrors(previous => { const next = { ...previous }; delete next[field]; return next; });
  const visit = useRef({ merchantId });
  if (visit.current.merchantId !== merchantId) visit.current = { merchantId };
  useEffect(() => () => { visit.current = { merchantId: null }; }, []);
  const { confirmDiscard } = useUnsavedChanges(Boolean(confirmedJobs.length || note));
  const close = () => {
    if (create.isPending) return;
    if (create.hasUnconfirmedOutcome) {
      if (window.confirm('Valo Pay 1 has not confirmed your review. If you close now, you lose this draft and cannot check it from here, but the request is not cancelled. If it arrived, it is listed in Request history. Close anyway?')) onClose();
      return;
    }
    if (confirmDiscard()) onClose();
  };
  const create = useCreateRecord({ mutation: {
    onMutate: () => visit.current,
    onSuccess: (_data, _variables, submitted) => {
      void queryClient.invalidateQueries();
      if (submitted !== visit.current) return;
      notifyDone('Review recorded', `${confirmedJobs.length} of 4 tasks confirmed. A review of sample data does not show that you are ready to go live.`);
      onClose();
    },
    onError: (error: unknown, _variables, submitted) => { if (submitted === visit.current) setFailure(saidBy(error, 'The review was not saved. Try again.')); },
  } }, merchantId);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (create.isPending || create.hasUnconfirmedOutcome) return;
    const blocked = permissionReason(workspace, { kind: 'reviews' });
    if (blocked) { setFailure(blocked); return; }
    const next: Record<string, string> = {};
    if (!note.trim()) next.note = 'Describe what was checked and any tasks still outstanding.';
    setErrors(next); setFailure('');
    if (next.note) { focusField('review-note'); return; }
    if (!merchantId) return;
    create.mutate({ kind: 'reviews', params: { merchantId }, data: {
      name: 'Operational review', status: 'recorded',
      data: { confirmedJobs, note: note.trim() },
    } });
  };
  return (
    <Dialog open onOpenChange={open => { if (!open && !create.isPending) close(); }}>
      <DialogContent onCloseAutoFocus={restoreOpenerFocus}>
        <DialogHeader>
          <DialogTitle>Record review</DialogTitle>
          <DialogDescription>Record what you checked with sample data. A review counts towards the schedule only when it confirms all four tasks. Review notes are required.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="space-y-5">
          {create.hasUnconfirmedOutcome && <div role="alert" className="space-y-2 rounded-lg border border-warning-border bg-warning/20 p-3 text-sm">
            <p className="font-semibold">Request not confirmed</p>
            <p>We do not know yet whether Valo Pay 1 saved this review. Select Check original request to find out without adding a second review. Keep this window open to check it here. {KEPT_IN_OPERATIONS}</p>
            {failure && <div><p className="font-medium">Latest response</p><p>{failure}</p></div>}
            {referenceOf(create.error) && <p>Support reference: {referenceOf(create.error)}</p>}
            <div className="flex flex-wrap items-center gap-3"><Button type="button" variant="outline" busy={create.isPending} busyLabel="Checking original request…" onClick={() => { void create.retryUnconfirmed().catch(() => {}); }}>Check original request</Button><OpenOperations /></div>
          </div>}
          <fieldset disabled={create.isPending || create.hasUnconfirmedOutcome} className="contents">
          {!create.hasUnconfirmedOutcome && (failure || Object.keys(errors).length > 0) && <FormAlert title="Review not saved">{failure || 'Check the highlighted fields.'}<FormErrorLinks errors={errors} fields={reviewFields} prefix="review" /></FormAlert>}
          <div className="space-y-1 rounded-md border bg-secondary/20 px-3 py-2 text-sm">
            <p><span className="font-medium">Reviewer:</span> {workspace?.actor || 'you'} (you)</p>
            <p className="text-xs text-muted-foreground">Valo Pay 1 records the review in your name, with the time it is saved. Another person records their own review after they sign in.</p>
          </div>
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">Tasks confirmed</legend>
            {reviewJobs.map(job => <label key={job.value} className="flex min-h-10 items-center gap-3 rounded-md border px-3 py-2 text-sm">
              <input type="checkbox" checked={confirmedJobs.includes(job.value)} onChange={event => setConfirmedJobs(previous => event.target.checked ? [...previous, job.value] : previous.filter(value => value !== job.value))} />
              {job.label}
            </label>)}
            <p className="text-xs text-muted-foreground">{confirmedJobs.length} of 4 confirmed. You can save a partial review and describe the remaining work below.</p>
          </fieldset>
          <div className="space-y-1.5">
            <label htmlFor="review-note" className="text-sm font-medium">Review notes</label>
            <textarea id="review-note" required {...invalidProps('review-note', errors.note)} value={note} onChange={event => { setNote(event.target.value); corrected('note'); }} rows={3} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
            <FieldError id="review-note" message={errors.note} />
          </div>
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={create.isPending} onClick={close}>{create.hasUnconfirmedOutcome ? 'Close' : 'Cancel'}</Button>
            <Button kind="reviews" type="submit" disabled={create.hasUnconfirmedOutcome} busy={create.isPending} busyLabel="Recording review…">Record review</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
