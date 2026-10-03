import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { messageSchema, operationLookupSchema, operationReplaySchema } from '@workspace/valo-pay-1-schema';
import { useSubmissionRecovery, type RememberedSubmission } from '@/lib/submission-recovery';
import { lenderPath, pilotRequest } from '@/lib/pilot';
import { requestClosed, savedAnswerWithheld } from '@/lib/safe-mutations';
import { recordPage } from '@/lib/record-navigation';
import { focusMain } from '@/lib/focus';
import { Button } from './ui/button';

/** Recovery sits on the original page even when its form was lost during a reload. No submitted fields are restored. */
export function SubmissionRecoveryNotice() {
  const recovery = useSubmissionRecovery();
  if (!recovery?.entries.length) return null;
  // Named by its heading, the standard's title for a request whose answer was lost.
  return <section aria-labelledby="submission-recovery-title" className="mb-6 space-y-3 rounded-xl border border-warning-border bg-warning/10 p-4 print:hidden">
    <h2 id="submission-recovery-title" className="font-semibold">{recovery.entries.length === 1 ? 'Request not confirmed' : 'Requests not confirmed'}</h2>
    <p className="text-sm">We do not know yet whether Valo Pay 1 saved a request you sent from this page, with this account, role and lender. What you typed is not kept in this browser, so reloading the page loses it. Check the original request before you change anything, so you do not send it twice.</p>
    {!recovery.durable && <p role="alert" className="text-sm">This browser cannot store the request. Keep this page open until you have checked it, or find it in Request history.</p>}
    {recovery.entries.map(entry => <RecoveryRow key={entry.key} entry={entry} />)}
    <Link href="/operations" className="inline-block text-sm underline">Open Request history</Link>
  </section>;
}

function RecoveryRow({ entry }: { entry: RememberedSubmission }) {
  const recovery = useSubmissionRecovery()!, client = useQueryClient();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const input = { key: entry.key, method: entry.method, path: entry.path };
  const query = useQuery({ queryKey: ['submission-recovery', recovery.scope, entry.key], retry: false,
    queryFn: ({ signal }) => pilotRequest(lenderPath('/operations/lookup', recovery.merchantId), operationLookupSchema, { method: 'POST', body: JSON.stringify(input), signal }),
  });
  const operation = query.data?.operation;
  const finish = async () => { await client.invalidateQueries(); recovery.forget(entry.key); queueMicrotask(focusMain); };
  const run = async (cancel: boolean) => {
    setBusy(true); setError('');
    try {
      if (cancel) {
        // This also fences a not-yet-received original request: a mere "not found" read cannot do that.
        await pilotRequest(lenderPath('/operations/cancel-unreceived', recovery.merchantId), messageSchema, { method: 'POST', body: JSON.stringify(input) });
      } else if (operation) {
        // The service loads the original payload and original key and rechecks today's permissions.
        await pilotRequest(lenderPath(`/operations/${encodeURIComponent(operation.id)}/retry`, recovery.merchantId), operationReplaySchema, { method: 'POST', body: '{}' });
      }
      await query.refetch();
      await client.invalidateQueries();
    } catch (problem) {
      if (requestClosed(problem) || savedAnswerWithheld(problem)) { await finish(); return; }
      setError(problem instanceof Error ? problem.message : 'The result was not confirmed. Keep this request and check again.');
      await query.refetch();
    } finally { setBusy(false); }
  };
  const terminal = operation?.status === 'completed' || operation?.status === 'cancelled';
  const saved = operation?.status === 'completed' && operation.recordId ? recordPage(operation.recordKind, operation.recordId, recovery.merchantId) : null;
  return <article className="space-y-3 rounded-lg border bg-card p-3 text-sm">
    <p className="font-medium">{operation?.summary?.action || operation?.label || 'Earlier request'}</p>
    <p role="status">{query.isLoading ? 'Checking the original request…' : operation ? operation.message : query.data ? 'Valo Pay 1 has not received this request yet. It may still arrive, so do not send it again.' : 'The original request could not be checked. Select Check status again.'}</p>
    {(query.error || error) && <p role="alert">{error || (query.error instanceof Error ? query.error.message : 'Check your connection and try again. No new request has been sent.')}</p>}
    {saved && <Link href={saved} className="inline-block underline">Open saved result</Link>}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={busy} busy={query.isFetching} busyLabel="Checking…" onClick={() => { void query.refetch(); }}>Check status again</Button>
      {operation?.status === 'pending' && <Button size="sm" disabled={query.isFetching} busy={busy} busyLabel="Checking original request…" onClick={() => { void run(false); }}>Check original request</Button>}
      {!terminal && query.data && <Button size="sm" variant="outline" disabled={busy || query.isFetching} onClick={() => { void run(true); }}>Cancel if unfinished</Button>}
      {terminal && <Button size="sm" disabled={busy || query.isFetching} onClick={() => { void finish(); }}>Mark as checked</Button>}
    </div>
    <p className="text-xs text-muted-foreground">Cancelling cannot undo a record that was already saved. This notice stays until Valo Pay 1 confirms what happened.</p>
  </article>;
}
