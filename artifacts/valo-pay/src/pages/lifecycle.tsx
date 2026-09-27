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

const names = { raw_csv: 'Raw import CSV', journal_payload: 'Completed request payload', export_file: 'Export file' } as const;
/** Why a source is kept as evidence, in words. */
const evidenceWords = (evidence: LifecycleView['targets'][number]['evidence']) => evidence.map(item => item.reason === 'open_case' ? `linked to open case ${item.recordId}` : `the reviewed-close export of approved close review ${item.recordId}`).join('; ');
type Variables = { path: string; data: unknown; response: 'view' | 'run' };
/** How far a run has got, as its last confirmed answer says. */
const removedSoFar = (run: LifecycleRunView) => `Removed so far: ${formatNumber(run.successful)} of ${formatCount(run.candidateCount, 'source')}.`;
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
  // Where Discard original request returns focus: the control that sent the last request, or for a run its Execute or
  // Resume button as it now stands, since the run's panel is drawn again whenever its status changes.
  const sentFrom = useRef<HTMLElement | null>(null), runSent = useRef(false), executeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => () => { mounted.current = false; }, []);
  // A finished run removes its Stop button: reading continues from what happened.
  useFocusWhenLost(messageRef, message);
  // Paging the retained sources keeps the view shown, and so the page buttons and the one pressed, until the next page arrives.
  const lifecycleKey = ['lifecycle', merchantId, workspace?.actor, { offset }];
  const query = useQuery({ queryKey: lifecycleKey, enabled: !!merchantId && workspace?.role === 'Admin', placeholderData: keepRowsWhilePaging(lifecycleKey, cache), queryFn: async ({ signal }) => {
    const data = await pilotRequest(lenderPath('/lifecycle', merchantId, offset), lifecycleViewSchema, { signal });
    if (data.merchantId !== merchantId || data.actor !== workspace?.actor) throw new Error('The response did not match this lender and administrator. Refresh the page.');
    return data;
  } });
  // The run the address names (an expired export links to the run that removed its file) opens however many newer runs the list shows.
  const [params] = useSearchParams(), linkedRun = params.get('run') || '', opened = useRef('');
  const linked = useQuery({ queryKey: ['lifecycle-run', merchantId, workspace?.actor, linkedRun], enabled: !!merchantId && workspace?.role === 'Admin' && !!linkedRun, queryFn: async ({ signal }) => {
    const run = await pilotRequest(lenderPath(`/lifecycle/runs/${encodeURIComponent(linkedRun)}`, merchantId), lifecycleRunViewSchema, { signal });
    if (run.merchantId !== merchantId || run.id !== linkedRun) throw new Error('The response named a different retention run. Refresh the page.');
    return run;
  } });
  useEffect(() => {
    if (!linked.data || opened.current === linked.data.id) return;
    opened.current = linked.data.id; setSelected(linked.data);
    setMessage(`Retention run ${linked.data.id} is open below${linked.data.receipts.length ? ' with its saved deletion receipts' : ''}.`);
  }, [linked.data]);
  const mutation = useSafeMutation(async (variables: Variables, options) => {
    const request = { ...options, method: 'POST', body: JSON.stringify(variables.data) };
    const result: LifecycleRunView | LifecycleView = variables.response === 'run' ? await pilotRequest(lenderPath(variables.path, merchantId), lifecycleRunViewSchema, request, INCOMPLETE_CONFIRMATION) : await pilotRequest(lenderPath(variables.path, merchantId), lifecycleViewSchema, request, INCOMPLETE_CONFIRMATION);
    if (result.merchantId !== merchantId || ('actor' in result && result.actor !== workspace?.actor)) throw new Error('The service did not confirm this retention action. Check the original request before trying another change.');
    const expectedRun = variables.path.match(/\/runs\/([^/]+)\/(approve|execute)$/)?.[1];
    if (expectedRun && (!('id' in result) || result.id !== expectedRun)) throw new Error('The response named a different retention run. Check the original request.');
    return result;
  }, { recovery: variables => submissionIdentity('POST', `/v1${variables.path}`, merchantId || '', variables.data), mutation: { onSuccess: (result, variables) => {
    // While execute (below) carries a run on, it says the outcome once the run stops; a recovered answer is said here.
    if ('candidates' in result) { setSelected(result); if (!(executing.current && variables.path.endsWith('/execute'))) setMessage(result.status === 'preview' ? 'Deletion preview saved. No source has been deleted.' : result.status === 'approved' ? 'The exact preview is approved. Execute it when ready; source versions and holds are checked again.' : result.status === 'completed' ? 'This run is complete. Inspect its saved deletion receipts below.' : 'Execution progress saved. Review any blocked items, then resume the run.'); }
    else setMessage(variables.path.endsWith('/policy') ? 'Retention policy saved. Saving a policy does not delete data.' : 'Retention hold updated. Every deletion checks current holds.');
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
        if (current.status === 'completed') outcome = 'This run is complete. Inspect its saved deletion receipts below.';
        else if (problem) outcome = `The run stopped at ${names[problem.kind]} ${problem.sourceId}, which ${problem.status === 'blocked' ? 'is blocked' : 'could not be deleted'}: ${problem.detail} ${removed}`;
        else if (current.successful <= before) outcome = 'Execution progress saved. Review any blocked items, then resume the run.';
        else if (stopRequested.current) outcome = `Stopped. ${removed} Resume approved run to continue; each source is checked again first.`;
        else continue;
        break;
      }
    } catch (error) {
      // The recovery notice shows the refusal or the unconfirmed outcome; nothing more is sent. Stop goes with the run, so the status area says what happened.
      outcome = requestClosed(error) || !outcomeIsUnconfirmed(error)
        ? `The run stopped because its last request was refused: ${sentence(errorWords(error, 'The service gave no reason'))} ${removedSoFar(current)}`
        : `The run stopped because its last request was not confirmed: it failed or its answer was lost, and it may have removed more sources. Use Check original request above to find out. ${removedSoFar(current)}`;
    }
    finally { executing.current = false; if (mounted.current) { setRunning(null); if (outcome) setMessage(outcome); } }
  };
  const stop = () => { stopRequested.current = true; setRunning(value => value && { ...value, stopping: true }); };
  // Execute approved run and Resume approved run carry the run on until it stops (execute, above).
  const submit = (path: string, body: unknown, response: 'view' | 'run' = 'view') => {
    const active = document.activeElement;
    sentFrom.current = active instanceof HTMLElement && !focusLost() && active.id !== 'main' ? active : null;
    runSent.current = !!selected && path === `/lifecycle/runs/${selected.id}/execute`;
    if (selected && path === `/lifecycle/runs/${selected.id}/execute`) void execute(selected);
    else mutation.mutate({ path, data: body, response });
  };
  return <div className="space-y-6">
    <PilotHeading title="Data retention">Control how long sample source files and completed request payloads remain available. Deletion requires an exact preview and administrator approval. Financial records and the audit trail are retained.</PilotHeading>
    {workspace?.role !== 'Admin' ? <p role="status" className="rounded-xl border bg-card p-5">Only a currently authorised administrator can inspect or change retention controls. Ask your administrator about holds and approved deletion runs.</p> : <>
      <PilotError error={query.error} pager="retained sources" retry={() => { void query.refetch(); }} />
      <PilotError error={linked.error} retry={() => { void linked.refetch(); }} />
      {query.isLoading && <p role="status">Loading retention policy and saved runs…</p>}
      <RecoveryNotice mutation={mutation} next={() => runSent.current ? executeButton.current : sentFrom.current} />
      {message && <p ref={messageRef} role="status" className="rounded-lg border bg-secondary/20 p-4 text-sm">{message}</p>}
      {running && selected?.id === running.runId && <RunProgress run={selected} running={running} stop={stop} />}
      {data && <>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4"><p className="text-sm"><strong>{data.lenderName}</strong><span className="block text-xs text-muted-foreground">Sample data · {formatCount(data.eligibleCount, 'source')} currently eligible{data.evidenceTotal ? ` · ${formatNumber(data.evidenceTotal)} kept as evidence` : ''} · Checked {formatDate(data.asOf)}</span></p><Button variant="outline" busy={query.isFetching} busyLabel="Refreshing…" onClick={() => { void query.refetch(); }}><RefreshCw className="size-4" />Refresh retention</Button></div>
        <div className="grid gap-4 md:grid-cols-2"><div className="flex gap-3 rounded-xl border bg-card p-4"><ShieldCheck className="size-5 shrink-0 text-success-foreground" /><div><h2 className="font-semibold">Audit and financial evidence stay</h2><p className="mt-1 text-sm text-muted-foreground">This release cannot delete the audit trail, imported financial records, original record identities, case history or deletion receipts.</p></div></div><div className="flex gap-3 rounded-xl border bg-card p-4"><LockKeyhole className="size-5 shrink-0" /><div><h2 className="font-semibold">Holds take priority</h2><p className="mt-1 text-sm text-muted-foreground">A hold blocks deletion even after approval. Pending and unconfirmed requests are never retention candidates.</p></div></div></div>
        <PolicyForm key={data.policyRevision} view={data} locked={locked} submit={submit} />
        <PilotPanel title="Retained sources and holds"><p className="text-sm text-muted-foreground">A source must reach its enabled retention age and have no hold to enter a preview. An export file linked to an open case, or the reviewed-close export of an approved close review, is kept as evidence and never enters one. The age starts when an import was committed, a request completed or was cancelled, or an export was generated.</p><HoldForm key={`${data.holdRevision}:${offset}`} view={data} locked={locked} submit={submit} />
          <p className="text-xs text-muted-foreground">Showing {formatNumber(data.targets.length ? offset + 1 : 0)}–{formatNumber(Math.min(offset + data.targets.length, data.targetTotal))} of {formatCount(data.targetTotal, 'retained source')}. {formatCount(data.holdTotal, 'active hold')}.</p>
          <div className="flex gap-2"><PageButtons label="retained sources" busy={query.isPlaceholderData} atStart={locked || offset === 0} atEnd={locked || offset + 100 >= data.targetTotal} onPrevious={() => setOffset(Math.max(0, offset - 100))} onNext={() => setOffset(offset + 100)} previous="Previous sources" next="Next sources" /></div>
          {!!data.holds.length && <details className="rounded-lg border p-3 text-sm"><summary className="min-h-8 cursor-pointer font-medium">Active holds ({formatNumber(data.holds.length)} of {formatNumber(data.holdTotal)})</summary><ul className="mt-2 space-y-3">{data.holds.map(hold => <li key={`${hold.kind}:${hold.sourceId}`}><p className="font-medium">{names[hold.kind]} · <span className="break-all font-mono text-xs">{hold.sourceId}</span></p><p>{hold.reason}</p><p className="text-xs text-muted-foreground">{formatDate(hold.at)}</p></li>)}</ul></details>}
        </PilotPanel>
        <PilotPanel title="Preview a deletion run"><p className="text-sm text-muted-foreground">Preview up to 100 currently eligible sources. Review their exact identities before approving. The preview expires after 15 minutes; policy or source changes require a new preview.</p><Button disabled={locked || data.eligibleCount === 0} onClick={() => submit('/lifecycle/runs', { expectedPolicyRevision: data.policyRevision }, 'run')}><Archive className="size-4" />Prepare deletion preview</Button>{data.eligibleCount === 0 && <p className="text-sm">No sources meet the enabled policy and hold rules. Disabled categories remain retained.</p>}</PilotPanel>
        {selected && <RunReview key={`${selected.id}:${selected.status}`} run={selected} locked={locked} submit={submit} secondApprover={data.secondApprover === true} actor={data.actor} executeRef={executeButton} />}
        <PilotPanel title="Saved deletion runs">{!data.runs.length ? <p className="text-sm text-muted-foreground">No previews or approved runs yet.</p> : <ul className="space-y-2">{data.runs.map(run => <li key={run.id}><button type="button" disabled={locked} className="flex min-h-12 w-full flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-left text-sm hover:bg-secondary/20 disabled:opacity-50" onClick={() => setSelected(run)}><span>{formatDate(run.createdAt)} · {formatCount(run.candidateCount, 'source')}</span><span className="font-medium">{run.status.replaceAll('_', ' ')} · {formatNumber(run.successful)} completed</span></button></li>)}</ul>}<p className="text-xs text-muted-foreground">Latest 10 runs. Each retained receipt records the exact source identity and outcome. A completed run does not recall copies previously downloaded or erase backups.</p></PilotPanel>
      </>}
    </>}
  </div>;
}
function PolicyForm({ view, locked, submit }: { view: LifecycleView; locked: boolean; submit(path: string, body: unknown): void }) {
  const [policy, setPolicy] = useState(view.policy), [reason, setReason] = useState('');
  const dirty = JSON.stringify(policy) !== JSON.stringify(view.policy) || !!reason.trim();
  useUnsavedChanges(dirty);
  const shortest = (field: keyof NonNullable<LifecycleView['minimumDays']>) => view.minimumDays?.[field] ?? 1;
  return <PilotPanel title="Retention policy"><p className="text-sm text-muted-foreground">All deletion categories start disabled. Enabling a category sets its minimum retention period; it does not schedule or perform deletion.</p>{view.minimumDays && <p className="text-sm">{view.secondApprover ? `This pilot keeps raw CSV and export files for at least ${formatNumber(view.minimumDays.rawCsvDays)} days (six years), because they are evidence, and completed request payloads for at least ${formatNumber(view.minimumDays.journalPayloadDays)} days, one annual audit cycle.` : `The sandbox keeps every category for at least ${formatNumber(view.minimumDays.rawCsvDays)} days, the time an inactive sandbox is kept. A pilot keeps evidence for six years.`}</p>}<form className="space-y-4" onSubmit={event => { event.preventDefault(); submit('/lifecycle/policy', { policy, expectedRevision: view.policyRevision, reason }); }}><fieldset disabled={locked} className="grid gap-4 lg:grid-cols-3">{([['rawCsvDays', 'Raw CSV after import', 'Only a committed batch’s source CSV and raw preview.'], ['journalPayloadDays', 'Completed request payloads', 'Only payloads of completed or cancelled requests; compact operation receipts remain.'], ['exportFileDays', 'Generated export files', 'File access ends after confirmed deletion; the export receipt and checksum remain.']] as const).map(([field, label, help]) => <div key={field} className="space-y-3 rounded-lg border p-4"><label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={policy[field] !== null} onChange={event => setPolicy({ ...policy, [field]: event.target.checked ? Math.max(30, shortest(field)) : null })} />{label}</label><p className="text-xs text-muted-foreground">{help}</p>{policy[field] === null ? <p className="text-sm">Disabled — retain this source.</p> : <label className="block space-y-1 text-sm">Minimum days to retain<input className={pilotField} type="number" min={shortest(field)} max={3650} step={1} required value={policy[field]} aria-label={`${label}: minimum days`} onChange={event => setPolicy({ ...policy, [field]: Number(event.target.value) })} /></label>}</div>)}</fieldset><label className="block space-y-2 text-sm font-medium">Reason for the policy change<textarea className={pilotField} disabled={locked} required minLength={10} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} placeholder="Explain the retention decision and its agreed purpose." /></label><p className="text-sm"><ShieldCheck className="mr-2 inline size-4" />Audit trail: retained. Financial and decision records: retained.</p><Button disabled={locked || reason.trim().length < 10} type="submit">Save retention policy</Button></form></PilotPanel>;
}
function HoldForm({ view, locked, submit }: { view: LifecycleView; locked: boolean; submit(path: string, body: unknown): void }) {
  const [target, setTarget] = useState(''), [reason, setReason] = useState('');
  const source = view.targets.find(item => `${item.kind}:${item.sourceId}` === target);
  useUnsavedChanges(!!reason.trim());
  if (!view.targets.length) return <p className="text-sm">No retained source artifacts on this page.</p>;
  return <form className="space-y-3" onSubmit={event => { event.preventDefault(); if (source) submit('/lifecycle/holds', { kind: source.kind, sourceId: source.sourceId, held: !source.held, expectedHoldRevision: view.holdRevision, reason }); }}><label className="block space-y-2 text-sm font-medium">Source to hold or release<select className={pilotField} value={target} disabled={locked} required onChange={event => setTarget(event.target.value)}><option value="">Choose an exact source</option>{view.targets.map(item => <option key={`${item.kind}:${item.sourceId}`} value={`${item.kind}:${item.sourceId}`}>{names[item.kind]} · {item.sourceId}{item.held ? ' · Held' : ''}{item.evidence.length ? ' · Evidence' : ''}</option>)}</select></label>{source && <p className="text-sm">{source.label} · Retention age starts {formatDate(source.createdAt)}. {source.held ? 'This source is currently protected from deletion.' : 'No hold is currently recorded.'}{source.evidence.length ? ` Kept as evidence (${evidenceWords(source.evidence)}), so it is not eligible for deletion.` : ''}</p>}<label className="block space-y-2 text-sm font-medium">Reason for the hold decision<textarea className={pilotField} disabled={locked || !source} required minLength={10} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label><Button type="submit" variant="outline" disabled={locked || !source || reason.trim().length < 10}>{source?.held ? 'Release this hold' : 'Place a hold'}</Button></form>;
}
function RunReview({ run, locked, submit, secondApprover, actor, executeRef }: { run: LifecycleRunView; locked: boolean; submit(path: string, body: unknown, response: 'run'): void; secondApprover: boolean; actor: string; executeRef?: Ref<HTMLButtonElement> }) {
  const [confirmed, setConfirmed] = useState(false), [reason, setReason] = useState('');
  useUnsavedChanges(run.status === 'preview' && (!!reason.trim() || confirmed));
  // A pilot's preparer cannot approve their own preview; the sandbox's one person plays every role, so there the rule is explained.
  const ownPreview = secondApprover && run.preparedBy === actor;
  return <PilotPanel title={run.status === 'preview' ? 'Review exact deletion candidates' : 'Approved deletion run'}><p className="text-sm">{formatCount(run.candidateCount, 'source artifact')} · {formatNumber(run.successful)} confirmed complete · {formatNumber(run.remaining)} remaining. {run.moreEligible > 0 && `${formatCount(run.moreEligible, 'additional eligible source')} ${run.moreEligible === 1 ? 'requires' : 'require'} a separate preview.`}</p><p className="break-all font-mono text-xs text-muted-foreground">Preview digest: {run.previewDigest}</p>{run.preparedBy && <p className="text-xs text-muted-foreground">Prepared by {run.preparedBy}{run.approvedBy ? ` · approved by ${run.approvedBy}` : ''}</p>}<ul className="max-h-96 space-y-2 overflow-y-auto rounded-lg border p-3" tabIndex={0} aria-label="Exact sources in this deletion preview">{run.candidates.map((candidate: LifecycleCandidate) => <li key={`${candidate.kind}:${candidate.sourceId}`} className="border-b py-3 last:border-0"><p className="text-sm font-semibold">{names[candidate.kind]}</p><p className="break-all font-mono text-xs">{candidate.sourceId}</p><p className="text-xs text-muted-foreground">{candidate.label} · Retained since {formatDate(candidate.createdAt)}</p><details className="mt-1 text-xs"><summary className="min-h-8 cursor-pointer">Verify source version and digest</summary><p className="break-all">Version: {candidate.version}</p><p className="break-all">SHA-256: {candidate.digest}</p></details></li>)}</ul>
    {run.status === 'preview' ? <form className="space-y-4" onSubmit={event => { event.preventDefault(); submit(`/lifecycle/runs/${run.id}/approve`, { expectedUpdatedAt: run.updatedAt, previewDigest: run.previewDigest, reason }, 'run'); }}><p className="text-sm">Approve before {formatDate(run.expiresAt)}. Deletion cannot be undone in this console. It removes these source artifacts only; the audit trail and imported records remain.</p><p role="note" className="text-sm">{ownPreview ? 'You prepared this preview, so another administrator must approve it. Either of you can execute it once approved.' : secondApprover ? 'An administrator other than the one who prepared a preview approves it.' : 'In a pilot, an administrator other than the one who prepared a preview must approve it. This sandbox has one person playing every role, so here you may approve your own preview.'}</p><label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 size-4" disabled={locked} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I reviewed every source identity in this preview and authorise this exact deletion run.</label><label className="block space-y-2 text-sm font-medium">Reason for approving this deletion<textarea className={pilotField} required disabled={locked} minLength={10} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label><Button type="submit" variant="destructive" disabled={locked || ownPreview || !confirmed || reason.trim().length < 10}>Approve exact deletion run</Button></form> : <><p className="text-sm">Approved {run.approvedAt ? formatDate(run.approvedAt) : ''}. Source identities, the saved policy and holds are checked again before each deletion.</p>{run.status !== 'completed' && <Button ref={executeRef} variant="destructive" disabled={locked} onClick={() => submit(`/lifecycle/runs/${run.id}/execute`, { previewDigest: run.previewDigest }, 'run')}><Trash2 className="size-4" />{run.status === 'approved' ? 'Execute approved run' : 'Resume approved run'}</Button>}</>}
    {!!run.receipts.length && <div className="space-y-3 border-t pt-4"><h3 className="font-semibold">Saved deletion receipts</h3><ul className="space-y-3">{run.receipts.map(receipt => <li key={receipt.id} className="rounded-lg border p-3 text-sm"><p className="font-semibold">{names[receipt.kind]} · {receipt.status.replaceAll('_', ' ')}</p><p className="break-all font-mono text-xs">{receipt.sourceId}</p><p>{receipt.detail}</p><p className="text-xs text-muted-foreground">{formatDate(receipt.at)}</p></li>)}</ul></div>}
  </PilotPanel>;
}
/**
 * An approved run being executed: how many of its sources are removed, and Stop, which ends the run after the current
 * request, since a deletion already sent cannot be recalled. It stands in the page's status area, where the run's
 * outcome is said once it stops.
 */
function RunProgress({ run, running, stop }: { run: LifecycleRunView; running: Running; stop(): void }) {
  const stopButton = useRef<HTMLButtonElement>(null);
  // Execute approved run is disabled while the run goes on: the keyboard moves on to Stop rather than to the page.
  useEffect(() => { const active = document.activeElement; if (focusLost() || (active instanceof HTMLButtonElement && active.disabled)) stopButton.current?.focus(); }, []);
  return <div className="space-y-3 rounded-lg border bg-card p-4">
    <p role="status" className="text-sm font-medium">{running.stopping ? 'Stopping after the current step.' : 'Deleting the approved sources.'} {formatNumber(run.successful)} of {formatCount(run.candidateCount, 'source')} removed.</p>
    <progress className="h-2 w-full accent-primary" max={Math.max(1, run.candidateCount)} value={run.successful} aria-label="Sources removed" />
    <p className="text-xs text-muted-foreground">The run continues until every source is removed or one is blocked. Each source is checked against the saved policy and holds just before it is deleted.</p>
    {/* Pressing it again changes nothing; it stays enabled so the keyboard keeps its place until the run stops. */}
    <Button ref={stopButton} variant="outline" onClick={stop}>{running.stopping ? 'Stopping…' : 'Stop'}</Button>
  </div>;
}
