import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { ArrowRight, Bell, Check, Clock3, Handshake, RefreshCw } from 'lucide-react';
import { personalWorkViewSchema, workReceiptSchema, type PersonalWorkItem, type PersonalWorkQuery, type WorkReceiptInput } from '@workspace/valopay-schema';
import { useWorkspace } from '@/lib/workspace-context';
import { submissionIdentity, useSafeMutation } from '@/lib/safe-mutations';
import { useUnsavedChanges } from '@/lib/unsaved-changes';
import { lenderPath, pilotRequest } from '@/lib/pilot';
import { INCOMPLETE_CONFIRMATION } from '@/lib/answers';
import { formatCount, formatDate, formatNumber } from '@/lib/formatters';
import { useDialogFocusReturn, useFocusWhenLost } from '@/lib/focus';
import { PilotError, PilotHeading, PilotPanel, RecoveryNotice, pilotField } from '@/components/pilot-ui';
import { Button } from '@/components/ui/button';
import { PageButtons } from '@/components/record-pagination';
import { keepRowsWhilePaging } from '@/lib/use-record-pagination';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const filterLabels = { all: 'All work', overdue: 'Overdue follow-ups', handover: 'Handovers to acknowledge', review: 'Pending reviews', unread: 'Unread notifications' } as const;
type ReceiptVariables = { action: 'read' | 'acknowledge'; data: WorkReceiptInput };
function receiptInput(item: PersonalWorkItem): WorkReceiptInput { return { sourceId: item.sourceId, eventId: item.eventId, expectedUpdatedAt: item.sourceVersion, expectedDigest: item.sourceDigest }; }

export default function WorkPage() {
  const { merchantId, workspace } = useWorkspace();
  return <WorkQueue key={`${merchantId}:${workspace?.actor}:${workspace?.role}`} />;
}
function WorkQueue() {
  const { merchantId, workspace } = useWorkspace(), cache = useQueryClient();
  const [scope, setScope] = useState<'mine' | 'team'>('mine');
  const [filter, setFilter] = useState<PersonalWorkQuery['filter']>('all');
  const [offset, setOffset] = useState(0);
  const [reviewed, setReviewed] = useState(false);
  const [selected, setSelected] = useState<PersonalWorkItem | null>(null);
  const [dialogFocusReturned, setDialogFocusReturned] = useState(true);
  const [feedback, setFeedback] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const feedbackRef = useRef<HTMLParagraphElement>(null);
  const restoreFocus = useDialogFocusReturn(!!selected, () => feedbackRef.current);
  // Acknowledgement can remove its opener only when the refreshed queue arrives.
  // Start watching after dialog autofocus has returned to the opener; otherwise
  // its close handler could undo the notice focus before the queue updates.
  useFocusWhenLost(feedbackRef, dialogFocusReturned && feedback);
  const focusPage = useRef(false);
  // Paging keeps the work shown, and so the page buttons and the one pressed, until the next page arrives.
  const workKey = ['personal-work', merchantId, workspace?.actor, workspace?.role, scope, filter, { offset }];
  const query = useQuery({ queryKey: workKey, enabled: !!merchantId && !!workspace, refetchInterval: 60000, placeholderData: keepRowsWhilePaging(workKey, cache),
    queryFn: async ({ signal }) => {
      const result = await pilotRequest(lenderPath(`/work?scope=${scope}&filter=${filter}&offset=${offset}&limit=25`, merchantId), personalWorkViewSchema, { signal });
      if (result.merchantId !== merchantId || result.actor !== workspace?.actor || result.scope !== scope) throw new Error('The service returned work for a different context. Refresh the selected lender.');
      return result;
    },
  });
  const mutation = useSafeMutation(async (variables: ReceiptVariables, options) => {
    const path = variables.action === 'read' ? '/work/notifications/read' : '/work/handovers/acknowledge';
    const result = await pilotRequest(lenderPath(path, merchantId), workReceiptSchema, { ...options, method: 'POST', body: JSON.stringify(variables.data) }, INCOMPLETE_CONFIRMATION);
    if (result.merchantId !== merchantId || result.actor !== workspace?.actor || result.sourceId !== variables.data.sourceId || result.eventId !== variables.data.eventId || result.action !== variables.action) throw new Error('The response did not confirm this work item. Check the original request before making another change.');
    return result;
  }, { recovery: variables => submissionIdentity('POST', variables.action === 'read' ? '/v1/work/notifications/read' : '/v1/work/handovers/acknowledge', merchantId || '', variables.data), mutation: { onSuccess: (result) => {
    setSelected(null); setReviewed(false); setFeedback(result.action === 'read' ? 'Notification marked as read. The work remains in your queue until its source is completed or reassigned.' : 'Handover acknowledged. The case and its next action remain open; no financial status changed.');
    void cache.invalidateQueries();
  } } }, `${merchantId}:${workspace?.actor}:${workspace?.role}`);
  const locked = mutation.isPending || mutation.hasUnconfirmedOutcome;
  useUnsavedChanges(locked);
  const data = query.data;
  useEffect(() => { if (data && data.offset === offset && focusPage.current) { heading.current?.focus(); focusPage.current = false; } }, [data, offset]);
  const changeFilter = (next: PersonalWorkQuery['filter']) => { setFilter(next); setOffset(0); setFeedback(''); };
  const movePage = (next: number) => { focusPage.current = true; setOffset(next); };
  return <div className="space-y-6">
    <PilotHeading title="My work">Your assigned cases, follow-ups, handovers, import corrections and close reviews for the selected lender. Notifications appear here when you open or refresh the page; no email is sent.</PilotHeading>
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
      <p className="text-sm"><span className="font-medium">{data?.lenderName || 'Selected lender'}</span><span className="block text-xs text-muted-foreground">Sample records only · Times shown in WAT{data ? ` · Checked ${formatDate(data.asOf)}` : ''}</span></p>
      <Button variant="outline" onClick={() => { void query.refetch(); }} busy={query.isFetching} busyLabel="Refreshing work…"><RefreshCw className="size-4" />Refresh work</Button>
    </div>
    <PilotError error={query.error} pager="work" retry={() => { void query.refetch(); }} />
    {query.isLoading && <p role="status">Loading your current assignments…</p>}
    <RecoveryNotice mutation={mutation} />
    {feedback && <p ref={feedbackRef} role="status" tabIndex={-1} className="rounded-lg border border-success-border bg-success/10 p-4 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">{feedback}</p>}
    {data && <>
      {!data.canWork && <p role="status" className="rounded-lg border bg-secondary/20 p-4 text-sm">Your current role cannot acknowledge work. You can inspect records allowed by your role; ask an administrator to check your assignment and staff access.</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-2 text-sm font-medium">Work queue<select className={pilotField} value={scope} disabled={locked || !data.canViewTeam} onChange={event => { setScope(event.target.value as typeof scope); setOffset(0); }}><option value="mine">Assigned to me</option>{data.canViewTeam && <option value="team">Team workload — this lender</option>}</select></label>
        <label className="space-y-2 text-sm font-medium">Show<select className={pilotField} value={filter} disabled={locked} onChange={event => changeFilter(event.target.value as PersonalWorkQuery['filter'])}>{Object.entries(filterLabels).map(([value, label]) => <option key={value} value={value}>{label} ({formatNumber(data.counts[value as keyof typeof filterLabels])})</option>)}</select></label>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Work summary">{[['Assigned', data.counts.all], ['Overdue follow-ups', data.counts.overdue], ['Handovers to acknowledge', data.counts.handover], ['Escalated', data.counts.escalated]].map(([label, count]) => <div key={label} className="min-w-0 rounded-xl border bg-card p-4"><p className="text-2xl font-semibold tabular-nums">{formatNumber(Number(count))}</p><p className="text-sm text-muted-foreground">{label}</p></div>)}</div>
      {scope === 'team' && <PilotPanel title="Workload by staff member"><p className="text-sm text-muted-foreground">Only assignments in {data.lenderName} are included. Showing {formatNumber(data.workload.length)} of {formatCount(data.workloadTotal, 'staff member')} with work. An administrator cannot acknowledge another person’s handover.</p>{!data.workload.length ? <p className="text-sm">No named assignments or pending reviews for this lender.</p> : <ul className="grid gap-3 sm:grid-cols-2">{data.workload.map(person => <li key={person.actor} className="rounded-lg border p-3 text-sm"><p className="font-semibold">{person.name}</p><p>{formatNumber(person.total)} assigned · {formatNumber(person.overdue)} overdue · {formatCount(person.handovers, 'handover')} · {formatCount(person.reviews, 'review')}</p>{person.escalated > 0 && <p className="mt-1 font-medium text-warning-foreground">{formatNumber(person.escalated)} escalated for follow-up</p>}</li>)}</ul>}</PilotPanel>}
      <section className="space-y-4" aria-labelledby="work-list-heading">
        <h2 ref={heading} id="work-list-heading" tabIndex={-1} className="text-lg font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">{filterLabels[filter]} <span className="font-normal text-muted-foreground">({formatNumber(data.total)})</span></h2>
        {!data.items.length ? <div className="space-y-3 rounded-xl border bg-card p-6"><Bell className="size-6 text-muted-foreground" /><p className="font-semibold">{data.total ? 'No work on this page' : filter === 'all' ? 'No work assigned here' : 'No work matches this filter'}</p><p className="max-w-2xl text-sm text-muted-foreground">{data.total ? 'The queue changed while you were viewing it. Return to its first page.' : 'Work appears from saved case assignments, import corrections and pending close reviews. An empty queue does not mean the lender has no open exceptions.'}</p>{offset > 0 ? <Button variant="outline" onClick={() => movePage(0)}>Return to first page</Button> : filter !== 'all' ? <Button variant="outline" onClick={() => changeFilter('all')}>Show all work</Button> : <Link href="/exceptions" className="inline-flex min-h-11 items-center gap-2 text-sm text-primary underline">Open exception queue<ArrowRight className="size-4" /></Link>}</div> : <ul className="space-y-3">{data.items.map(item => <li key={item.id} className="min-w-0 space-y-4 rounded-xl border bg-card p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 space-y-1"><div className="flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground"><span>{item.type === 'handover' ? 'Handover' : item.type === 'review' ? 'Close review' : item.type === 'correction' ? 'Import correction' : 'Assigned case'}</span>{!item.readAt && <span className="rounded-full border px-2 py-0.5">Unread notification</span>}{item.escalated && <span className="rounded-full border border-warning-border bg-warning/20 px-2 py-0.5 text-warning-foreground">Escalated</span>}{item.reviewCurrent === false && <span className="rounded-full border px-2 py-0.5">{item.type === 'correction' ? 'New comparison needed' : 'New close needed'}</span>}</div><h3 className="break-words font-semibold">{item.title}</h3>{scope === 'team' && <p className="text-sm text-muted-foreground">Assigned to {item.assigneeName}</p>}</div>{item.readAt && <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Check className="size-3" />Read {formatDate(item.readAt)}</span>}</div>
          <p className="break-words text-sm">{item.nextAction}</p>
          {item.waitingSince && <p className="text-sm text-muted-foreground">Awaiting decision since {formatDate(item.waitingSince)} · Assigned to {item.assigneeName}</p>}{item.dueAt && <p className={`inline-flex flex-wrap items-center gap-2 text-sm ${item.overdue ? 'font-medium text-destructive' : 'text-muted-foreground'}`}><Clock3 className="size-4" />{item.overdue ? 'Follow-up overdue' : 'Follow-up due'} · {formatDate(item.dueAt)}</p>}
          {item.escalationReason && <p className="text-sm text-warning-foreground">{item.escalationReason}</p>}{item.notice && <p className="rounded-lg bg-secondary/30 p-3 text-sm">{item.notice}</p>}
          <div className="flex flex-wrap gap-2"><Button asChild variant="outline"><Link href={item.href}>{item.type === 'review' ? 'Open close review' : item.type === 'correction' ? 'Review import correction' : 'Open case'}<ArrowRight className="size-4" /></Link></Button>{item.canAcknowledge && <Button disabled={locked} onClick={() => { setDialogFocusReturned(false); setSelected(item); setReviewed(false); setFeedback(''); }}><Handshake className="size-4" />Review handover</Button>}{data.canWork && item.assignee === data.actor && !item.readAt && <Button variant="ghost" disabled={locked} busy={mutation.isPending && mutation.variables?.action === 'read' && mutation.variables.data.sourceId === item.sourceId} busyLabel="Saving read status…" onClick={() => mutation.mutate({ action: 'read', data: receiptInput(item) })}>Mark as read</Button>}</div>
        </li>)}</ul>}
        {data.total > 0 && <nav aria-label="Work pages" className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">{formatNumber(Math.min(data.offset + 1, data.total))}–{formatNumber(Math.min(data.offset + data.items.length, data.total))} of {formatNumber(data.total)}</p><div className="flex gap-2"><PageButtons label="work" busy={query.isPlaceholderData} atStart={locked || offset === 0} atEnd={locked || offset + data.limit >= data.total} onPrevious={() => movePage(Math.max(0, offset - data.limit))} onNext={() => movePage(offset + data.limit)} /></div></nav>}
      </section>
      <details className="rounded-xl border bg-card p-4 text-sm"><summary className="min-h-8 cursor-pointer font-semibold">Notification and escalation rules</summary><p className="mt-3">{data.escalationRule}</p><p className="mt-2 text-muted-foreground">Marking a notification as read records that you saw it. Acknowledging a handover records receipt of the assignment. Neither action resolves the case, approves a correction or approves a close.</p></details>
      <PilotPanel title="Your recent read and acknowledgement history">{!data.history.length ? <p className="text-sm text-muted-foreground">No read or handover acknowledgements recorded for you in this lender yet.</p> : <><p className="text-xs text-muted-foreground">Your 10 most recent saved events. Older events remain in the audit record.</p><ol className="divide-y">{data.history.map(event => <li key={event.id} className="space-y-1 py-3 text-sm"><p className="font-medium">{event.action === 'read' ? 'Notification read' : 'Handover acknowledged'} · {event.summary}</p><p className="text-muted-foreground">{formatDate(event.at)}</p><Link href={event.href} className="inline-flex min-h-9 items-center text-primary underline">Open source record</Link></li>)}</ol></>}</PilotPanel>
    </>}
    <Dialog open={!!selected} onOpenChange={open => { if (!open && !locked) { setSelected(null); setReviewed(false); } }}><DialogContent onCloseAutoFocus={event => { restoreFocus(event); setDialogFocusReturned(true); }} onEscapeKeyDown={event => { if (locked) event.preventDefault(); }} onPointerDownOutside={event => { if (locked) event.preventDefault(); }}><DialogHeader><DialogTitle>Review this handover</DialogTitle><DialogDescription>Acknowledge that you have received this case and reviewed its next action. The case stays open.</DialogDescription></DialogHeader>{selected && <div className="space-y-4"><dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 text-sm"><dt className="text-muted-foreground">Case</dt><dd className="break-words font-medium">{selected.title}</dd><dt className="text-muted-foreground">Assigned to</dt><dd className="break-words">{selected.assigneeName}</dd><dt className="text-muted-foreground">Next action</dt><dd className="break-words">{selected.nextAction}</dd><dt className="text-muted-foreground">Follow-up</dt><dd>{selected.dueAt ? formatDate(selected.dueAt) : 'Not recorded'}</dd></dl><p className="text-sm text-muted-foreground">Open the case to inspect its note and linked evidence before acknowledging. The server checks that this is still your current assignment.</p><Link href={selected.href} className="inline-flex min-h-10 items-center text-sm text-primary underline">Open full case history</Link><label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 size-4" checked={reviewed} disabled={locked} onChange={event => setReviewed(event.target.checked)} />I have reviewed this handover and its next action.</label><RecoveryNotice mutation={mutation} /><DialogFooter><Button variant="outline" disabled={locked} onClick={() => setSelected(null)}>Cancel</Button><Button disabled={!reviewed || locked} busy={mutation.isPending} busyLabel="Acknowledging…" onClick={() => mutation.mutate({ action: 'acknowledge', data: receiptInput(selected) })}>Acknowledge handover</Button></DialogFooter></div>}</DialogContent></Dialog>
  </div>;
}
