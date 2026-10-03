import { QueueSearch } from '@/components/queue-search';
import { QueueFreshness } from '@/components/queue-freshness';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'wouter';
import { useLocationProperty } from 'wouter/use-browser-location';
import { ScrollFrame } from '@/components/scroll-frame';
import { EmptyRow } from '@/components/empty-state';
import { LoadingRow } from '@/components/loading';
import { useWorkspace } from '@/lib/workspace-context';
import { usePagedQueue } from '@/lib/use-paged-queue';
import { SavedQueueViews } from '@/components/saved-queue-views';
import { FileText, Upload } from 'lucide-react';
import { PermissionButton as Button } from '@/components/permission-button';
import { RecordDialog } from '@/components/record-dialog';
import { notifyDone } from '@/lib/notify';
import { ImportWizard } from '@/components/import-wizard';
import { confirmUnsavedChanges } from '@/lib/unsaved-changes';
import { failureCodeList } from '@workspace/valo-pay-1-schema';
import { RecordLabel, StatusBadge, readableLabel } from '@/components/record-label';
import { formatKobo, formatDate, formatNumber } from '@/lib/formatters';
import { deadlineOrder, isOverdue, useQueueFilters } from '@/lib/queue-filters';
import { collectionReturnTo, recordDestination } from '@/lib/record-navigation';
import { useHashTarget } from '@/lib/use-hash-target';
import { RecordPagination, usePageProblemFocus } from '@/components/record-pagination';

const collectionViews = ['all', 'overdue', 'due-today', 'failed'] as const;
const isUnpaid = (status: string) => !['paid', 'closed', 'cancelled'].includes(status);

export default function CollectionsPage() {
  const { merchantId } = useWorkspace();
  const [importOpen, setImportOpen] = useState(false);
  const [actionError, setActionError] = useState('');
  const { view, owner, setView, setOwner } = useQueueFilters(collectionViews, 'all');
  // The queue's problem notice, which takes the pager's focus when a page press fails.
  const listProblem = useRef<HTMLDivElement>(null), listLabel = view === 'failed' ? 'failed collection attempts' : 'instalments';
  const listAgain = usePageProblemFocus(listProblem, listLabel);
  const [search] = useSearchParams();
  const targetHash = useLocationProperty(() => window.location.hash);
  
  const [selectedItem, setSelectedItem] = useState<any>(null);
  const [actionKind, setActionKind] = useState<string>('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);



  const queue = usePagedQueue('collections', { view, owner, target: targetHash.startsWith('#record-') ? targetHash.slice(8) : undefined });
  const { data, isLoading: isLoadingDue, error: dueError, refetch: refetchDue, pagination } = queue;
  const dueItems = { items: [...(data?.items || []), ...(data?.related || [])].filter(row => row.kind === 'due-items') };
  const attempts = { items: [...(data?.items || []), ...(data?.related || [])].filter(row => row.kind === 'attempts') };
  const isLoadingAttempts = isLoadingDue, attemptsError = dueError, refetchAttempts = refetchDue;
  const customerById = new Map(data?.related.filter(row => row.kind === 'customers').map(row => [row.id, row]));
  const mandates = { items: data?.related.filter(row => row.kind === 'mandates') || [] };
  const policies = { items: data?.related.filter(row => row.kind === 'policies') || [] };
  const rowTargets = useMemo(() => (data?.items || []).map(row => 'record-' + row.id), [data]);

  useEffect(() => { setActionError(''); setIsDialogOpen(false); setSelectedItem(null); }, [merchantId]);

  const handleAction = (item: any, action: string) => {
    setActionError('');
    if (action === 'backtest_policy') {
      const policyId = item.data?.policyId || mandates?.items.find(mandate => mandate.id === item.data?.mandateId)?.data?.policyId;
      const policy = policies?.items.find(candidate => candidate.id === policyId);
      if (!policy) {
        setActionError('This instalment has no retry policy to test. On Mandates, check that its mandate has a retry policy.');
        return;
      }
      setSelectedItem(policy);
    } else {
      setSelectedItem(item);
    }
    setActionKind(action);
    setIsDialogOpen(true);
  };

  const now = data?.asOf ? Date.parse(data.asOf) : Date.now();
  const instalments = dueItems.items;
  const byId = new Map(instalments.map(item => [item.id, item]));
  const ownerOf = (item: typeof instalments[number] | undefined) => String(item?.data?.owner || 'unassigned');
  const failedAttempts = attempts.items;
  const latestFailure = new Map<string, typeof failedAttempts[number]>();
  for (const attempt of [...failedAttempts].sort((a, b) => deadlineOrder(a.data?.occurredAt || a.createdAt, b.data?.occurredAt || b.createdAt))) latestFailure.set(String(attempt.data?.dueItemId), attempt);
  const owners = [...new Set([...(data?.owners || []), ...(owner ? [owner] : [])])].sort();
  const isOverdueItem = (item: typeof instalments[number]) => isUnpaid(item.status) && isOverdue(item.data?.dueDate, now);
  const displayed = (data?.items || []).map(row => row.kind === 'attempts' ? { key: row.id, item: byId.get(String(row.data?.dueItemId)), attempt: row } : { key: row.id, item: row, attempt: undefined });
  const pagedRows = displayed;
  useHashTarget(rowTargets, !!data && !isLoadingDue && !dueError);
  const views: Array<{ key: typeof view; label: string; count: number | string }> = [
    { key: 'all', label: 'All instalments' }, { key: 'overdue', label: 'Overdue' },
    { key: 'due-today', label: 'Due today' }, { key: 'failed', label: 'Failed collection attempts' },
  ].map(item => ({ ...item, key: item.key as typeof view, count: typeof data?.counts[item.key] === 'number' ? formatNumber(data.counts[item.key]!) : '…' }));
  if (!merchantId) return null;
  const nextAction = (item: typeof instalments[number] | undefined, attempt: typeof failedAttempts[number] | undefined) => {
    const rowId = attempt?.id || item?.id;
    const returnTo = collectionReturnTo(search, merchantId, rowId);
    const destination = (path: string, id: string, parameter?: string) => recordDestination(path, id, returnTo, merchantId, parameter);
    const customerId = item?.customerId || attempt?.customerId;
    const customerLink = (label: string, recordId: string | undefined) => customerId && recordId
      ? <Link href={destination(`/customers/${encodeURIComponent(customerId)}`, recordId)} className="font-medium text-primary underline underline-offset-4 hover:no-underline">{label}</Link>
      : <span>{label}. This record is not linked to a customer. Check its customer reference in the import.</span>;
    if (!item) return customerLink('Review this unlinked collection attempt', attempt?.id);
    if (!isUnpaid(item.status)) return 'No collection action needed';
    if (item.status === 'in_dispute') return customerLink('Review the customer dispute', item.id);
    if (item.status === 'unpaid_final') return customerLink('No retries left: decide the next step', item.id);
    const mandate = mandates?.items.find(candidate => candidate.id === item.data?.mandateId);
    if (mandate?.status === 'pending_activation') return <Link href={destination('/mandates', mandate.id)} className="font-medium text-primary underline underline-offset-4 hover:no-underline">Follow up on mandate activation</Link>;
    if (latestFailure.has(item.id)) return customerLink('Review the failed collection attempt and retry policy', attempt?.id || latestFailure.get(item.id)?.id);
    if (item.status === 'partially_paid') return <Link href={destination('/reconciliation', item.id, 'dueItem')} className="font-medium text-primary underline underline-offset-4 hover:no-underline">Review the remaining amount</Link>;
    return customerLink(ownerOf(item) === 'valopay' || ownerOf(item) === 'valo' ? 'Check the collection schedule' : 'Follow up with whoever collects it', item.id);
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Collections</h1>
          <p className="text-muted-foreground mt-1">Test retry policies and simulate collection attempts with sample data. Live payments and bank connections are switched off.</p>
        </div>
        <Button action={importOpen ? undefined : "import_records"} variant="outline" className="gap-2" aria-expanded={importOpen} aria-controls="collection-import" onClick={() => { if (importOpen && !confirmUnsavedChanges()) return; setImportOpen(open => !open); }}><Upload className="h-4 w-4" aria-hidden="true" />{importOpen ? 'Hide import' : 'Import sample data'}</Button>
      </header>

      <QueueFreshness key={merchantId} queries={[queue]} />

      <QueueSearch help="Your view and Collected by filter still apply." /><SavedQueueViews queue="collections" views={collectionViews} fallback="all" />

      {actionError && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">{actionError}</p>}
      <div className="flex flex-col gap-6">
        
        <div id="collection-import" hidden={!importOpen} className="order-1">{importOpen && <ImportWizard key={merchantId} merchantId={merchantId} />}</div>

        {/* Due Items List */}
        <div className="order-2">
          <section className="bg-card border rounded-xl shadow-sm overflow-hidden h-full flex flex-col">
            <div className="p-4 border-b bg-secondary/20 flex items-center justify-between">
              <h2 className="font-semibold text-lg flex items-center gap-2">
                <FileText className="h-5 w-5 text-primary" /> Instalments
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-3 border-b p-4">
              <div className="flex flex-wrap gap-2" role="group" aria-label="Collection views">
                {views.map(option => <Button key={option.key} size="sm" variant={view === option.key ? 'default' : 'ghost'} aria-pressed={view === option.key} onClick={() => setView(option.key)}>{option.label} ({option.count})</Button>)}
              </div>
              <label className="flex w-full min-w-0 flex-col gap-2 text-sm sm:ml-auto sm:w-auto sm:flex-row sm:items-center">Collected by
                <select aria-label="Filter instalments by who collects them" className="w-full min-w-0 max-w-full rounded-md border bg-background px-3 py-2 sm:w-auto sm:max-w-60" value={owner} onChange={event => setOwner(event.target.value)}>
                  <option value="">Anyone</option>
                  {owners.map(value => <option key={value} value={value}>{readableLabel(value)}</option>)}
                </select>
              </label>
              <p className="w-full text-xs text-muted-foreground">{view === 'failed' ? 'Each row is a failed collection attempt, including attempts on instalments paid later. ' : ''}Unpaid and overdue instalments come first.</p>
            </div>
            
            <ScrollFrame label="Instalments" className="flex-1 overflow-auto">
              <table className="w-full min-w-[1120px] text-sm text-left">
                <thead className="bg-secondary/30 border-b text-muted-foreground sticky top-0">
                  <tr>
                    <th className="px-4 py-3 font-medium">Instalment</th>
                    <th className="px-4 py-3 font-medium">Customer</th>
                    <th className="px-4 py-3 font-medium text-right">{view === 'failed' ? 'Attempt amount and outstanding' : 'Amount and outstanding'}</th>
                    <th className="px-4 py-3 font-medium">Due date</th>
                    <th className="px-4 py-3 font-medium">Status and collected by</th>
                    <th className="px-4 py-3 font-medium">Next step</th>
                    <th className="px-4 py-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {isLoadingDue || isLoadingAttempts ? (
                    <LoadingRow colSpan={7} what="instalments" />
                  ) : dueError && !data ? (
                    <tr><td colSpan={7} className="p-6"><div ref={listProblem} role="alert"><p>We could not load instalments.</p><Button className="mt-3" size="sm" variant="outline" onClick={() => { listAgain(); refetchDue(); refetchAttempts(); }}>Try again</Button></div></td></tr>
                  ) : displayed.length === 0 ? (
                    <EmptyRow colSpan={7} title={search.get('q')?.trim() ? 'No instalments match your search' : view === 'all' && !owner ? 'No instalments yet' : 'No instalments match these filters'}>{search.get('q')?.trim() ? 'Try another name or reference, or select Clear search. Your view and Collected by filter stay as they are.' : view === 'all' && !owner ? 'Select Import sample data to add sample instalments from a CSV file.' : 'Choose All instalments and Anyone to see the full list.'}</EmptyRow>
                  ) : (
                    pagedRows.map(({ key, item, attempt }) => (
                      <tr key={key} id={`record-${key}`} tabIndex={-1} className="hover:bg-secondary/10 target:bg-primary/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
                        <td className="px-4 py-3"><p className="font-mono text-xs">{item?.reference || 'Instalment not linked'}</p>{attempt && <><p className="mt-1 text-xs text-muted-foreground">Collection attempt {attempt.reference || String(attempt.data?.number || '')}</p><p className="mt-1 text-xs text-muted-foreground">{formatDate(String(attempt.data?.occurredAt || attempt.createdAt))}</p></>}</td>
                        <td className="px-4 py-3"><RecordLabel record={customerById.get(String(item?.customerId || attempt?.customerId))} id={item?.customerId || attempt?.customerId} customer /></td>
                        <td className="px-4 py-3 text-right tabular-nums"><p className="font-medium">{formatKobo(attempt?.amountKobo ?? item?.amountKobo ?? 0)}</p><p className="mt-1 text-xs text-muted-foreground">{item ? `${formatKobo(Number(item.data?.outstandingKobo ?? item.amountKobo))} outstanding` : 'Outstanding not recorded'}</p></td>
                        <td className="px-4 py-3 whitespace-nowrap"><p>{formatDate(String(item?.data?.dueDate || ''))}</p>{item && isOverdueItem(item) && <p className="mt-1 text-xs font-semibold text-destructive">Overdue</p>}</td>
                        <td className="px-4 py-3"><StatusBadge status={attempt?.status || item?.status} /><p className="mt-1 text-xs text-muted-foreground">{ownerOf(item) === 'unassigned' ? 'Collector not set' : readableLabel(ownerOf(item))}</p>{attempt && <p className="mt-1 text-xs">{readableLabel(attempt.data?.failureCode)}</p>}</td>
                        <td className="max-w-56 px-4 py-3 text-xs leading-relaxed">{nextAction(item, attempt)}</td>
                        <td className="px-4 py-3 text-right">
                          {item && <div className="flex flex-col items-end gap-2"><Button size="sm" variant="outline" className="h-7 text-xs" action="backtest_policy" record={item} onClick={() => handleAction(item, 'backtest_policy')}>Test retry policy</Button>
                          {item.status === 'in_dispute' && <Button size="sm" variant="outline" className="h-7 text-xs" action="release_dispute" record={item} onClick={() => handleAction(item, 'release_dispute')}>Release from dispute</Button>}
                          {isUnpaid(item.status) && <Button size="sm" variant="ghost" className="h-7 text-xs" action="simulate_failure" record={item} onClick={() => handleAction(item, 'simulate_failure')}>Simulate failed collection attempt</Button>}</div>}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </ScrollFrame>
            {!isLoadingDue && !isLoadingAttempts && !dueError && !attemptsError && <RecordPagination pagination={pagination} total={data?.total || 0} busy={queue.isPlaceholderData} label={listLabel} />}
          </section>
        </div>
      </div>

      <RecordDialog
        kind={actionKind === 'backtest_policy' ? 'policies' : 'due-items'}
        record={selectedItem}
        isOpen={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        title={actionKind === 'simulate_failure' ? 'Simulate failed collection attempt' : actionKind === 'release_dispute' ? 'Release from dispute' : 'Test retry policy'}
        submitLabel={actionKind === 'simulate_failure' ? 'Simulate failed collection attempt' : actionKind === 'release_dispute' ? 'Release from dispute' : 'Test retry policy'}
        busyLabel={actionKind === 'simulate_failure' ? 'Simulating failed collection attempt…' : actionKind === 'release_dispute' ? 'Releasing from dispute…' : 'Testing retry policy…'}
        actionMutation={actionKind}
        onDone={response => { if (actionKind === 'release_dispute' && response?.message) notifyDone('Released from dispute', String(response.message)); }}
        context={actionKind === 'release_dispute' && selectedItem ? <section aria-label="Release context" className="space-y-2 rounded-lg border bg-secondary/10 p-4 text-sm">
          <p className="font-medium">{selectedItem.reference} · {formatKobo(Number(selectedItem.data?.outstandingKobo ?? selectedItem.amountKobo))} outstanding</p>
          <p>Releasing takes the instalment out of dispute. Its status goes back to match its balance. Collection and allocation start again, so a waiting payment can be allocated. Any open customer dispute exception for it closes automatically.</p>
          <p>Record why the instalment can be collected again. The reason is saved in the audit log.</p>
        </section> : actionKind === 'backtest_policy' && selectedItem ? <section aria-label="Retry policy test" className="space-y-2 rounded-lg border bg-secondary/10 p-4 text-sm">
          <p className="font-medium">{selectedItem.name} · version {String(selectedItem.data?.version ?? 1)}</p>
          <p>Testing shows what this retry policy would decide for each instalment it covers. Nothing is collected and no customer message is sent.</p>
        </section> : undefined}
        fields={
          actionKind === 'simulate_failure' ? 
            [{ name: 'failureCode', label: 'Failure reason', type: 'select', options: failureCodeList.map(code => ({ label: readableLabel(code), value: code })), isData: true, required: true }] :
            []
        }
      />
    </div>
  );
}
