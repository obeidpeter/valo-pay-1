import { useEffect, useRef, useState, type Ref } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'wouter';
import { Archive, LockKeyhole, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { lifecycleViewSchema, lifecycleRunViewSchema, type LifecycleRunView, type LifecycleView, type RetentionPolicy, type LifecycleCandidate } from '@workspace/valopay-schema';
import { useWorkspace } from '@/lib/workspace-context';
import { outcomeIsUnconfirmed, requestClosed, submissionIdentity, useSafeMutation } from '@/lib/safe-mutations';
import { useUnsavedChanges } from '@/lib/unsaved-changes';
import { lenderPath, pilotRequest } from '@/lib/pilot';
import { INCOMPLETE_CONFIRMATION } from '@/lib/answers';
import { formatCount, formatDate, formatNumber } from '@/lib/formatters';
import { PilotError, PilotHeading, PilotPanel, RecoveryNotice, pilotField } from '@/components/pilot-ui';
import { Button } from '@/components/ui/button';
import { PageButtons } from '@/components/record-pagination';
import { keepRowsWhilePaging } from '@/lib/use-record-pagination';
import { focusLost, useFocusWhenLost } from '@/lib/focus';
import { errorWords } from '@/lib/notify';
import { readableLabel } from '@/components/record-label';
import { TechnicalDetails } from '@/components/technical-details';

/** One name for each kind of item, the same in every list. */
const names = { raw_csv: 'Import file (CSV)', journal_payload: 'Saved request details', export_file: 'Export file' } as const;
/** What the codes in a deletion preview's Technical details are for, said once where they are shown. */
const DIGEST_EXPLAINED = 'This code is worked out from the exact items in the preview. It shows that the items approved are the items deleted.';
const ITEM_CODE_EXPLAINED = 'This code is worked out from the item’s contents. It shows exactly which version of the item is deleted.';
/** Why an item is kept as evidence, in words. */
const evidenceWords = (evidence: LifecycleView['targets'][number]['evidence']) => evidence.map(item => item.reason === 'open_case' ? `linked to open case ${item.recordId}` : `the export of approved close review ${item.recordId}`).join('; ');
type Variables = { path: string; data: unknown; response: 'view' | 'run' };
/** How far a run has got, as its last confirmed answer says. */
const removedSoFar = (run: LifecycleRunView) => `Deleted so far: ${formatNumber(run.successful)} of ${formatCount(run.candidateCount, 'item')}.`;
/** Words that end as a sentence. */
const sentence = (words: string) => /[.!?]$/.test(words) ? words : `${words}.`;
/** An approved run being executed request after request, and whether the person asked it to stop. */
type Running = { runId: string; stopping: boolean };
export default function LifecyclePage() {
  const { merchantId, workspace } = useWorkspace();
  return <LifecycleControls key={`${merchantId}:${workspace?.actor}:${workspace?.role}`} />;
}
function LifecycleControls() {
  const { merchantId, workspace } = useWorkspace(), cache = useQueryClient();
  const [offset, setOffset] = useState(0), [selected, setSelected] = useState<LifecycleRunView | null>(null), [message, setMessage] = useState('');
  const [running, setRunning] = useState<Running | null>(null), executing = useRef(false), stopRequested = useRef(false), mounted = useRef(true), messageRef = useRef<HTMLParagraphElement>(null);
  // Where Discard original request returns focus: the control that sent the last request, or for a run its Start deletion
  // or Continue deletion button as it now stands, since the run's panel is drawn again whenever its status changes.
  const sentFrom = useRef<HTMLElement | null>(null), runSent = useRef(false), executeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => () => { mounted.current = false; }, []);
  // A finished run removes its Stop button: reading continues from what happened.
  useFocusWhenLost(messageRef, message);
  // Paging the kept items keeps the view shown, and so the page buttons and the one pressed, until the next page arrives.
  const lifecycleKey = ['lifecycle', merchantId, workspace?.actor, { offset }];
  const query = useQuery({ queryKey: lifecycleKey, enabled: !!merchantId && workspace?.role === 'Admin', placeholderData: keepRowsWhilePaging(lifecycleKey, cache), queryFn: async ({ signal }) => {
    const data = await pilotRequest(lenderPath('/lifecycle', merchantId, offset), lifecycleViewSchema, { signal });
    if (data.merchantId !== merchantId || data.actor !== workspace?.actor) throw new Error('Valo Pay’s reply does not match this lender and Admin. Refresh the page.');
    return data;
  } });
  // The run the address names (an expired export links to the run that removed its file) opens however many newer runs the list shows.
  const [params] = useSearchParams(), linkedRun = params.get('run') || '', opened = useRef('');
  const linked = useQuery({ queryKey: ['lifecycle-run', merchantId, workspace?.actor, linkedRun], enabled: !!merchantId && workspace?.role === 'Admin' && !!linkedRun, queryFn: async ({ signal }) => {
    const run = await pilotRequest(lenderPath(`/lifecycle/runs/${encodeURIComponent(linkedRun)}`, merchantId), lifecycleRunViewSchema, { signal });
    if (run.merchantId !== merchantId || run.id !== linkedRun) throw new Error('Valo Pay’s reply named a different deletion run. Refresh the page.');
    return run;
  } });
  useEffect(() => {
    if (!linked.data || opened.current === linked.data.id) return;
    opened.current = linked.data.id; setSelected(linked.data);
    setMessage(`Deletion run ${linked.data.id} is shown below${linked.data.receipts.length ? ', with its deletion records' : ''}.`);
  }, [linked.data]);
  const mutation = useSafeMutation(async (variables: Variables, options) => {
    const request = { ...options, method: 'POST', body: JSON.stringify(variables.data) };
    const result: LifecycleRunView | LifecycleView = variables.response === 'run' ? await pilotRequest(lenderPath(variables.path, merchantId), lifecycleRunViewSchema, request, INCOMPLETE_CONFIRMATION) : await pilotRequest(lenderPath(variables.path, merchantId), lifecycleViewSchema, request, INCOMPLETE_CONFIRMATION);
    if (result.merchantId !== merchantId || ('actor' in result && result.actor !== workspace?.actor)) throw new Error('Valo Pay did not confirm this data retention change. Check the original request before you make another change.');
    const expectedRun = variables.path.match(/\/runs\/([^/]+)\/(approve|execute)$/)?.[1];
    if (expectedRun && (!('id' in result) || result.id !== expectedRun)) throw new Error('Valo Pay’s reply named a different deletion run. Check the original request.');
    return result;
  }, { recovery: variables => submissionIdentity('POST', `/v1${variables.path}`, merchantId || '', variables.data), mutation: { onSuccess: (result, variables) => {
    // While execute (below) carries a run on, it says the outcome once the run stops; a recovered answer is said here.
    if ('candidates' in result) { setSelected(result); if (!(executing.current && variables.path.endsWith('/execute'))) setMessage(result.status === 'preview' ? 'Deletion preview saved. Nothing has been deleted yet.' : result.status === 'approved' ? 'Preview approved. Select Start deletion when you are ready. Each item and its holds are checked again first.' : result.status === 'completed' ? 'Deletion run complete. See its deletion records below.' : 'Progress saved. Check any blocked items, then select Continue deletion.'); }
    else setMessage(variables.path.endsWith('/policy') ? 'Retention policy saved. Saving a policy does not delete data.' : 'Hold updated. Every deletion checks the current holds first.');
    void cache.invalidateQueries();
  } } }, `${merchantId}:${workspace?.actor}:${workspace?.role}`);
  const locked = mutation.isPending || mutation.hasUnconfirmedOutcome || !!running;
  // Leaving while a run is being executed asks first; leaving stops it after the current request.
  useUnsavedChanges(locked);
  const data = query.data;
  /**
   * Executes an approved run request after request (each removes what fits in the service's time budget) until it
   * completes, a source is blocked or its deletion fails, the person stops it, or a request fails, which the recovery
   * notice then shows while the status area says the run stopped, why and how far it got. Each request is new, with
   * its own key; a lost answer is recovered with Check original request.
   */
  const execute = async (run: LifecycleRunView) => {
    executing.current = true; stopRequested.current = false; setRunning({ runId: run.id, stopping: false }); setMessage('');
    let current = run, outcome = '';
    try {
      for (;;) {
        const seen = new Set(current.receipts.map(receipt => receipt.id)), before = current.successful;
        current = await mutation.mutateAsync({ path: `/lifecycle/runs/${run.id}/execute`, data: { previewDigest: run.previewDigest }, response: 'run' }) as LifecycleRunView;
        if (!mounted.current) return;
        const removed = removedSoFar(current);
        const problem = current.receipts.find(receipt => (receipt.status === 'blocked' || receipt.status === 'failed') && !seen.has(receipt.id));
        if (current.status === 'completed') outcome = 'Deletion run complete. See its deletion records below.';
        else if (problem) outcome = `Deletion stopped at ${names[problem.kind]} ${problem.sourceId}, which ${problem.status === 'blocked' ? 'is blocked' : 'could not be deleted'}: ${problem.detail} ${removed}`;
        else if (current.successful <= before) outcome = 'Progress saved. Check any blocked items, then select Continue deletion.';
        else if (stopRequested.current) outcome = `Stopped. ${removed} Select Continue deletion to go on. Each item is checked again first.`;
        else continue;
        break;
      }
    } catch (error) {
      // The recovery notice shows the refusal or the unconfirmed outcome; nothing more is sent. Stop goes with the run, so the status area says what happened.
      outcome = requestClosed(error) || !outcomeIsUnconfirmed(error)
        ? `Deletion stopped because its last request was refused: ${sentence(errorWords(error, 'Valo Pay gave no reason'))} ${removedSoFar(current)}`
        : `Deletion stopped because its last request was not confirmed. It may have deleted more items. Select Check original request above to find out. ${removedSoFar(current)}`;
    }
    finally { executing.current = false; if (mounted.current) { setRunning(null); if (outcome) setMessage(outcome); } }
  };
  const stop = () => { stopRequested.current = true; setRunning(value => value && { ...value, stopping: true }); };
  // Start deletion and Continue deletion carry the run on until it stops (execute, above).
  const submit = (path: string, body: unknown, response: 'view' | 'run' = 'view') => {
    const active = document.activeElement;
    sentFrom.current = active instanceof HTMLElement && !focusLost() && active.id !== 'main' ? active : null;
    runSent.current = !!selected && path === `/lifecycle/runs/${selected.id}/execute`;
    if (selected && path === `/lifecycle/runs/${selected.id}/execute`) void execute(selected);
    else mutation.mutate({ path, data: body, response });
  };
  return <div className="space-y-6">
    <PilotHeading title="Data retention">Choose how long sample import files, saved request details and export files are kept. Deleting them needs a preview and an Admin’s approval. Financial records and the audit log are kept.</PilotHeading>
    {workspace?.role !== 'Admin' ? <p role="status" className="rounded-xl border bg-card p-5">Only Admin can view or change data retention. Your role is {workspace?.role || 'not set'}.{workspace?.accessMode !== 'staff' ? ' Change your demo role in Settings.' : ' Ask an Admin about holds and deletion runs.'}</p> : <>
      <PilotError error={query.error} pager="kept items" retry={() => { void query.refetch(); }} />
      <PilotError error={linked.error} retry={() => { void linked.refetch(); }} />
      {query.isLoading && <p role="status">Loading data retention…</p>}
      <RecoveryNotice mutation={mutation} next={() => runSent.current ? executeButton.current : sentFrom.current} />
      {message && <p ref={messageRef} role="status" className="rounded-lg border bg-secondary/20 p-4 text-sm">{message}</p>}
      {running && selected?.id === running.runId && <RunProgress run={selected} running={running} stop={stop} />}
      {data && <>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4"><p className="text-sm"><strong>{data.lenderName}</strong><span className="block text-xs text-muted-foreground">Sample data · {formatCount(data.eligibleCount, 'item')} can be deleted now{data.evidenceTotal ? ` · ${formatNumber(data.evidenceTotal)} kept as evidence` : ''} · Checked {formatDate(data.asOf)}</span></p><Button variant="outline" busy={query.isFetching} busyLabel="Refreshing…" onClick={() => { void query.refetch(); }}><RefreshCw className="size-4" />Refresh data retention</Button></div>
        <div className="grid gap-4 md:grid-cols-2"><div className="flex gap-3 rounded-xl border bg-card p-4"><ShieldCheck className="size-5 shrink-0 text-success-foreground" /><div><h2 className="font-semibold">The audit log and financial records are kept</h2><p className="mt-1 text-sm text-muted-foreground">This version of Valo Pay cannot delete the audit log, imported financial records, record IDs, case history or deletion records.</p></div></div><div className="flex gap-3 rounded-xl border bg-card p-4"><LockKeyhole className="size-5 shrink-0" /><div><h2 className="font-semibold">Holds take priority</h2><p className="mt-1 text-sm text-muted-foreground">A hold stops deletion, even after approval. Requests that are pending or not confirmed are never deleted.</p></div></div></div>
        <PolicyForm key={data.policyRevision} view={data} locked={locked} submit={submit} />
        <PilotPanel title="Kept items and holds"><p className="text-sm text-muted-foreground">An item can go into a deletion preview only when its category is switched on, it has been kept for at least that category’s minimum period, and it has no hold. Export files linked to an open case or an approved close review are kept as evidence and never go into a preview. An item’s age counts from when its batch was imported, its request finished or was cancelled, or its export was created.</p><HoldForm key={`${data.holdRevision}:${offset}`} view={data} locked={locked} submit={submit} />
          <p className="text-xs text-muted-foreground">Showing {formatNumber(data.targets.length ? offset + 1 : 0)}–{formatNumber(Math.min(offset + data.targets.length, data.targetTotal))} of {formatCount(data.targetTotal, 'kept item')}. {formatCount(data.holdTotal, 'active hold')}.</p>
          <div className="flex gap-2"><PageButtons label="kept items" busy={query.isPlaceholderData} atStart={locked || offset === 0} atEnd={locked || offset + 100 >= data.targetTotal} onPrevious={() => setOffset(Math.max(0, offset - 100))} onNext={() => setOffset(offset + 100)} previous="Previous items" next="Next items" /></div>
          {!!data.holds.length && <details className="rounded-lg border p-3 text-sm"><summary className="min-h-8 cursor-pointer font-medium">Active holds ({formatNumber(data.holds.length)} of {formatNumber(data.holdTotal)})</summary><ul className="mt-2 space-y-3">{data.holds.map(hold => <li key={`${hold.kind}:${hold.sourceId}`}><p className="font-medium">{names[hold.kind]} · <span className="break-all font-mono text-xs">{hold.sourceId}</span></p><p>{hold.reason}</p><p className="text-xs text-muted-foreground">{formatDate(hold.at)}</p></li>)}</ul></details>}
        </PilotPanel>
        <PilotPanel title="Preview a deletion"><p className="text-sm text-muted-foreground">Preview up to 100 items that can be deleted now. Check each one before you approve. The preview expires after 15 minutes. If the policy or an item changes, prepare a new preview.</p><Button disabled={locked || data.eligibleCount === 0} onClick={() => submit('/lifecycle/runs', { expectedPolicyRevision: data.policyRevision }, 'run')}><Archive className="size-4" />Prepare deletion preview</Button>{data.eligibleCount === 0 && <p className="text-sm">Nothing can be deleted under the current policy and holds. Categories that are switched off are always kept.</p>}</PilotPanel>
        {selected && <RunReview key={`${selected.id}:${selected.status}`} run={selected} locked={locked} submit={submit} secondApprover={data.secondApprover === true} actor={data.actor} executeRef={executeButton} />}
        <PilotPanel title="Deletion runs">{!data.runs.length ? <p className="text-sm text-muted-foreground">No deletion runs yet. Select Prepare deletion preview to start one.</p> : <ul className="space-y-2">{data.runs.map(run => <li key={run.id}><button type="button" disabled={locked} className="flex min-h-12 w-full flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-left text-sm hover:bg-secondary/20 disabled:opacity-50" onClick={() => setSelected(run)}><span>{formatDate(run.createdAt)} · {formatCount(run.candidateCount, 'item')}</span><span className="font-medium">{readableLabel(run.status)} · {formatNumber(run.successful)} deleted</span></button></li>)}</ul>}<p className="text-xs text-muted-foreground">Latest 10 runs. Each deletion record shows exactly what was deleted and what happened. Deleting cannot recall copies already downloaded, and it does not erase backups.</p></PilotPanel>
      </>}
    </>}
  </div>;
}
function PolicyForm({ view, locked, submit }: { view: LifecycleView; locked: boolean; submit(path: string, body: unknown): void }) {
  const [policy, setPolicy] = useState(view.policy), [reason, setReason] = useState('');
  const dirty = JSON.stringify(policy) !== JSON.stringify(view.policy) || !!reason.trim();
  useUnsavedChanges(dirty);
  const shortest = (field: keyof NonNullable<LifecycleView['minimumDays']>) => view.minimumDays?.[field] ?? 1;
  return <PilotPanel title="Retention policy"><p className="text-sm text-muted-foreground">Every category starts switched off. Switching one on sets how long its items must be kept. It does not delete anything or schedule a deletion.</p>{view.minimumDays && <p className="text-sm">{view.secondApprover ? `In this pilot, import files and export files are kept for at least ${formatNumber(view.minimumDays.rawCsvDays)} days (six years) because they are evidence. Saved request details are kept for at least ${formatNumber(view.minimumDays.journalPayloadDays)} days (one year, for the yearly audit).` : `The sandbox keeps every category for at least ${formatNumber(view.minimumDays.rawCsvDays)} days, the time an inactive sandbox is kept. A pilot keeps evidence for six years.`}</p>}<form className="space-y-4" onSubmit={event => { event.preventDefault(); submit('/lifecycle/policy', { policy, expectedRevision: view.policyRevision, reason }); }}><fieldset disabled={locked} className="grid gap-4 lg:grid-cols-3">{([['rawCsvDays', 'Import files (CSV)', 'Only the original CSV file and its preview, for batches already imported.'], ['journalPayloadDays', 'Saved request details', 'Only the details of finished or cancelled requests. A short record of each request is kept.'], ['exportFileDays', 'Export files', 'Once deleted, the file cannot be downloaded. A record of the export is kept, with the code that identifies the file.']] as const).map(([field, label, help]) => <div key={field} className="space-y-3 rounded-lg border p-4"><label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={policy[field] !== null} onChange={event => setPolicy({ ...policy, [field]: event.target.checked ? Math.max(30, shortest(field)) : null })} />{label}</label><p className="text-xs text-muted-foreground">{help}</p>{policy[field] === null ? <p className="text-sm">Off. These items are kept.</p> : <label className="block space-y-1 text-sm">Keep for at least (days)<input className={pilotField} type="number" min={shortest(field)} max={3650} step={1} required value={policy[field]} aria-label={`${label}: keep for at least (days)`} onChange={event => setPolicy({ ...policy, [field]: Number(event.target.value) })} /></label>}</div>)}</fieldset><div className="space-y-1"><label className="block space-y-2 text-sm font-medium">Reason for the policy change<textarea className={pilotField} disabled={locked} required minLength={10} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} aria-describedby="policy-reason-help" placeholder="Why this policy, and what it is for." /></label><p id="policy-reason-help" className="text-xs text-muted-foreground">At least 10 characters.</p></div><p className="text-sm"><ShieldCheck className="mr-2 inline size-4" />Kept: the audit log, financial records and decision records.</p><Button disabled={locked || reason.trim().length < 10} type="submit">Save retention policy</Button></form></PilotPanel>;
}
function HoldForm({ view, locked, submit }: { view: LifecycleView; locked: boolean; submit(path: string, body: unknown): void }) {
  const [target, setTarget] = useState(''), [reason, setReason] = useState('');
  const source = view.targets.find(item => `${item.kind}:${item.sourceId}` === target);
  useUnsavedChanges(!!reason.trim());
  if (!view.targets.length) return <p className="text-sm">No items on this page.</p>;
  return <form className="space-y-3" onSubmit={event => { event.preventDefault(); if (source) submit('/lifecycle/holds', { kind: source.kind, sourceId: source.sourceId, held: !source.held, expectedHoldRevision: view.holdRevision, reason }); }}><label className="block space-y-2 text-sm font-medium">Item to hold or release<select className={pilotField} value={target} disabled={locked} required onChange={event => setTarget(event.target.value)}><option value="">Choose an item</option>{view.targets.map(item => <option key={`${item.kind}:${item.sourceId}`} value={`${item.kind}:${item.sourceId}`}>{names[item.kind]} · {item.sourceId}{item.held ? ' · On hold' : ''}{item.evidence.length ? ' · Kept as evidence' : ''}</option>)}</select></label>{source && <p className="text-sm">Age counted from {formatDate(source.createdAt)}. {source.held ? 'This item has a hold, so it cannot be deleted.' : 'This item has no hold.'}{source.evidence.length ? ` It is kept as evidence (${evidenceWords(source.evidence)}), so it cannot be deleted.` : ''}</p>}<div className="space-y-1"><label className="block space-y-2 text-sm font-medium">Reason for the hold decision<textarea className={pilotField} disabled={locked || !source} required minLength={10} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} aria-describedby="hold-reason-help" /></label><p id="hold-reason-help" className="text-xs text-muted-foreground">At least 10 characters.</p></div><Button type="submit" variant="outline" disabled={locked || !source || reason.trim().length < 10}>{source?.held ? 'Release this hold' : 'Place a hold'}</Button></form>;
}
function RunReview({ run, locked, submit, secondApprover, actor, executeRef }: { run: LifecycleRunView; locked: boolean; submit(path: string, body: unknown, response: 'run'): void; secondApprover: boolean; actor: string; executeRef?: Ref<HTMLButtonElement> }) {
  const [confirmed, setConfirmed] = useState(false), [reason, setReason] = useState('');
  useUnsavedChanges(run.status === 'preview' && (!!reason.trim() || confirmed));
  // A pilot's preparer cannot approve their own preview; the sandbox's one person plays every role, so there the rule is explained.
  const ownPreview = secondApprover && run.preparedBy === actor;
  return <PilotPanel title={run.status === 'preview' ? 'Check the items to delete' : 'Approved deletion run'}><p className="text-sm">{formatCount(run.candidateCount, 'item')} · {formatNumber(run.successful)} deleted · {formatNumber(run.remaining)} left.{run.moreEligible > 0 && ` ${formatCount(run.moreEligible, 'more item')} can be deleted in another preview.`}</p><TechnicalDetails explanation={DIGEST_EXPLAINED}><p>Preview code (SHA-256): {run.previewDigest}</p></TechnicalDetails>{run.preparedBy && <p className="text-xs text-muted-foreground">Prepared by {run.preparedBy}{run.approvedBy ? ` · approved by ${run.approvedBy}` : ''}</p>}<ul className="max-h-96 space-y-2 overflow-y-auto rounded-lg border p-3" tabIndex={0} aria-label="Items in this deletion preview">{run.candidates.map((candidate: LifecycleCandidate) => <li key={`${candidate.kind}:${candidate.sourceId}`} className="border-b py-3 last:border-0"><p className="text-sm font-semibold">{names[candidate.kind]}</p><p className="break-all font-mono text-xs">{candidate.sourceId}</p><p className="text-xs text-muted-foreground">Kept since {formatDate(candidate.createdAt)}</p><TechnicalDetails className="mt-1" explanation={ITEM_CODE_EXPLAINED}><p>Version: {candidate.version}</p><p>Code (SHA-256): {candidate.digest}</p></TechnicalDetails></li>)}</ul>
    {run.status === 'preview' ? <form className="space-y-4" onSubmit={event => { event.preventDefault(); submit(`/lifecycle/runs/${run.id}/approve`, { expectedUpdatedAt: run.updatedAt, previewDigest: run.previewDigest, reason }, 'run'); }}><p className="text-sm">Approve before {formatDate(run.expiresAt)}. Deletion cannot be undone. It deletes only these items. The audit log and imported records are kept.</p><p role="note" className="text-sm">{ownPreview ? 'You prepared this preview, so another Admin must approve it. Either of you can then start the deletion.' : secondApprover ? 'An Admin other than the one who prepared this preview must approve it.' : 'In a pilot, an Admin other than the one who prepared a preview must approve it. In this sandbox one person plays every role, so here you may approve your own preview.'}</p><label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 size-4" disabled={locked} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I have checked every item in this preview and approve deleting exactly these items.</label><div className="space-y-1"><label className="block space-y-2 text-sm font-medium">Reason for approving this deletion<textarea className={pilotField} required disabled={locked} minLength={10} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} aria-describedby="approval-reason-help" /></label><p id="approval-reason-help" className="text-xs text-muted-foreground">At least 10 characters.</p></div><Button type="submit" variant="destructive" disabled={locked || ownPreview || !confirmed || reason.trim().length < 10}>Approve deletion</Button></form> : <><p className="text-sm">Approved {run.approvedAt ? formatDate(run.approvedAt) : ''}. Each item, the saved policy and the holds are checked again before each deletion.</p>{run.status !== 'completed' && <Button ref={executeRef} variant="destructive" disabled={locked} onClick={() => submit(`/lifecycle/runs/${run.id}/execute`, { previewDigest: run.previewDigest }, 'run')}><Trash2 className="size-4" />{run.status === 'approved' ? 'Start deletion' : 'Continue deletion'}</Button>}</>}
    {!!run.receipts.length && <div className="space-y-3 border-t pt-4"><h3 className="font-semibold">Deletion records</h3><ul className="space-y-3">{run.receipts.map(receipt => <li key={receipt.id} className="rounded-lg border p-3 text-sm"><p className="font-semibold">{names[receipt.kind]} · {readableLabel(receipt.status)}</p><p className="break-all font-mono text-xs">{receipt.sourceId}</p><p>{receipt.detail}</p><p className="text-xs text-muted-foreground">{formatDate(receipt.at)}</p></li>)}</ul></div>}
  </PilotPanel>;
}
/**
 * An approved run being executed: how many of its items are deleted, and Stop, which ends the run after the current
 * request, since a deletion already sent cannot be recalled. It stands in the page's status area, where the run's
 * outcome is said once it stops.
 */
function RunProgress({ run, running, stop }: { run: LifecycleRunView; running: Running; stop(): void }) {
  const stopButton = useRef<HTMLButtonElement>(null);
  // Start deletion is disabled while the run goes on: the keyboard moves on to Stop rather than to the page.
  useEffect(() => { const active = document.activeElement; if (focusLost() || (active instanceof HTMLButtonElement && active.disabled)) stopButton.current?.focus(); }, []);
  return <div className="space-y-3 rounded-lg border bg-card p-4">
    <p role="status" className="text-sm font-medium">{running.stopping ? 'Stopping after the current step.' : 'Deleting the approved items.'} {formatNumber(run.successful)} of {formatCount(run.candidateCount, 'item')} deleted.</p>
    <progress className="h-2 w-full accent-primary" max={Math.max(1, run.candidateCount)} value={run.successful} aria-label="Items deleted" />
    <p className="text-xs text-muted-foreground">Deletion continues until every item is deleted or one is blocked. Each item is checked against the policy and holds just before it is deleted.</p>
    {/* Pressing it again changes nothing; it stays enabled so the keyboard keeps its place until the run stops. */}
    <Button ref={stopButton} variant="outline" onClick={stop}>{running.stopping ? 'Stopping…' : 'Stop'}</Button>
  </div>;
}
