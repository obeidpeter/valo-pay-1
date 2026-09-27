import { Link, useSearchParams } from 'wouter';
import { QueueSearch } from '@/components/queue-search';
import { QueueFreshness } from '@/components/queue-freshness';
import React, { useEffect, useRef, useState } from 'react';
import { ScrollFrame } from '@/components/scroll-frame';
import { EmptyState } from '@/components/empty-state';
import { Loading } from '@/components/loading';
import { useWorkspace } from '@/lib/workspace-context';
import { usePagedQueue } from '@/lib/use-paged-queue';
import { SavedQueueViews } from '@/components/saved-queue-views';
import { AlertTriangle, User, Calendar } from 'lucide-react';
import { PermissionButton as Button } from '@/components/permission-button';
import { formatDate, formatNumber } from '@/lib/formatters';
import { formatRecordMoney } from '@/lib/currencies';
import { RecordDialog } from '@/components/record-dialog';
import { exceptionSeverities, failureCodeList, resolveExceptionType } from '@workspace/valopay-schema';
import { readableLabel, RecordLabel, StatusBadge } from '@/components/record-label';
import { isDueToday, isOverdue, useQueueFilters } from '@/lib/queue-filters';
import { RecordPagination, usePageProblemFocus } from '@/components/record-pagination';
import { ExceptionContext, providerIdentityErrors, resolutionChoices, resolutionLabel, useHeldBatchIdentities } from '@/components/exception-context';
import { useHashTarget } from '@/lib/use-hash-target';
import { useFocusWhenLost } from '@/lib/focus';
import { permissionReason } from '@/lib/permissions';

const exceptionViews = ['open', 'high', 'overdue', 'due-today', 'resolved'] as const;

export default function ExceptionsPage() {
  const { merchantId, workspace } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q')?.trim();
  // A link to one exception (from its case) shows that exception alone, whatever its status, until the queue is chosen again.
  const targetId = searchParams.get('record');
  const wrongLender = Boolean(searchParams.get('lender') && searchParams.get('lender') !== merchantId);
  const leaveSelectedRecord = () => setSearchParams(current => {
    const next = new URLSearchParams(current);
    next.delete('record'); next.delete('lender');
    return next;
  });
  const [selectedEx, setSelectedEx] = useState<any>(null);
  const [actionKind, setActionKind] = useState<'update' | 'resolve' | ''>('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  // The service's answer to the last resolution: what the next reconciliation does with the exception's evidence, say.
  const [resolved, setResolved] = useState<{ what: string; message: string } | null>(null);
  const resolvedRef = useRef<HTMLElement>(null);
  // A resolution takes its Resolve button away (the exception leaves the open queue), so reading continues from its answer.
  useFocusWhenLost(resolvedRef, resolved);
  const { view: filter, owner, type, setView: setFilter, setOwner, setType } = useQueueFilters(exceptionViews, 'open');
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // The queue's problem notice, which takes the pager's focus when a page press fails.
  const listProblem = useRef<HTMLDivElement>(null);
  const listAgain = usePageProblemFocus(listProblem, 'exceptions');
  useEffect(() => { setSelectedEx(null); setIsDialogOpen(false); setResolved(null); }, [merchantId]);
  /** WAI-ARIA tabs: one tab stop for the group, arrows and Home/End move the selection and the focus together. */
  const onTabKeyDown = (event: React.KeyboardEvent, index: number, keys: Array<typeof filter>) => {
    const moves: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: keys.length - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const next = (moves[event.key]! + keys.length) % keys.length;
    setFilter(keys[next]!);
    tabRefs.current[next]?.focus();
  };

  const exceptionsQuery = usePagedQueue('exceptions', { view: filter, owner, type, record: targetId ? wrongLender ? 'unavailable' : targetId : undefined });
  const { data, isLoading, isPlaceholderData, error, refetch, pagination } = exceptionsQuery;
  useHashTarget(`record-${targetId || ''}`, !!targetId && !isLoading && !error && !wrongLender);
  const customerById = new Map(data?.related.filter(row => row.kind === 'customers').map(row => [row.id, row]));

  const handleAction = (ex: any, kind: 'update' | 'resolve') => {
    setSelectedEx(ex);
    setActionKind(kind);
    setIsDialogOpen(true);
  };

  // An unknown outcome of a pay-by-bank checkout is resolved with the evidence that the payment arrived, not a debit failure code.
  const checkoutOutcome = actionKind === 'resolve' && selectedEx?.data?.linkedKind === 'connected-intents';
  // A settlement batch held for its provider identity is confirmed as one of the identities it was held for (Admin and Finance).
  // Until they load there is no field to check, and the service's refusal names them.
  const heldBatch = useHeldBatchIdentities(selectedEx, isDialogOpen && actionKind === 'resolve', workspace?.role), heldIdentities = heldBatch.identities;
  const now = data?.asOf ? Date.parse(data.asOf) : Date.now();
  const isOpen = (status: string) => !['resolved', 'closed'].includes(status);
  const items = data?.items || [];
  const owners = [...new Set([...(data?.owners || []), ...(owner ? [owner] : [])])].sort();
  const types = [...new Set([...(data?.types || []), ...(type ? [type] : [])])].sort();
  const filters: Array<{ key: typeof filter; label: string }> = [
    { key: 'open', label: 'All open' }, { key: 'high', label: 'High severity' },
    { key: 'overdue', label: 'Overdue' }, { key: 'due-today', label: 'Due today' }, { key: 'resolved', label: 'Resolved' },
  ].map(item => ({ ...item, key: item.key as typeof filter, label: item.label + ' (' + (typeof data?.counts[item.key] === 'number' ? formatNumber(data.counts[item.key]!) : '…') + ')' }));

  if (!merchantId) return null;

  return (
    <div className="space-y-6">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Exceptions</h1>
          <p className="text-muted-foreground mt-1">Exceptions are items that need a person to review or resolve them. Track each item's owner and deadline here.</p>
        </div>
      </header>

      <QueueFreshness key={merchantId} queries={[exceptionsQuery]} />
      {workspace?.role === 'Compliance reviewer' && <p className="text-sm text-muted-foreground">You can review exception evidence and case history. An Admin, Operations or Finance colleague can edit exception details.</p>}

      {resolved && <section ref={resolvedRef} role="status" aria-label="Resolution recorded" className="rounded-lg border border-success/30 bg-success/5 p-4 text-sm">
        <p className="font-semibold">{resolved.what} resolved</p>
        <p className="mt-1">{resolved.message}</p>
      </section>}

      <QueueSearch /><SavedQueueViews queue="exceptions" views={exceptionViews} fallback="open" />

      <div className="bg-card border rounded-xl shadow-sm overflow-hidden flex flex-col">
        {targetId ? <div className="flex flex-wrap items-center justify-between gap-3 border-b p-5"><p className="text-sm font-medium">Selected exception</p><Button size="sm" variant="outline" onClick={leaveSelectedRecord}>View exception queue</Button></div> : <div className="p-5 border-b flex flex-wrap items-center gap-4">
          <p className="hidden print:block text-sm">Showing: {filters.find(option => option.key === filter)?.label}</p>
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Exception filter">
            {filters.map((option, index) => (
              <Button key={option.key} id={`exception-tab-${option.key}`} aria-controls="exception-results" ref={element => { tabRefs.current[index] = element; }} role="tab" aria-selected={filter === option.key} tabIndex={filter === option.key ? 0 : -1} onKeyDown={event => onTabKeyDown(event, index, filters.map(item => item.key))} variant={filter === option.key ? 'secondary' : 'ghost'} size="sm" className={filter === option.key ? 'bg-primary text-primary-foreground hover:bg-primary/90' : ''} onClick={() => setFilter(option.key)}>
                {option.label}
              </Button>
            ))}
          </div>
          <label className="flex w-full min-w-0 flex-col gap-2 text-sm sm:ml-auto sm:w-auto sm:flex-row sm:items-center">Owner
            <select aria-label="Filter exceptions by owner" className="w-full min-w-0 max-w-full rounded-md border bg-background px-3 py-2 sm:w-auto sm:max-w-52" value={owner} onChange={event => setOwner(event.target.value)}>
              <option value="">All owners</option>
              {owners.map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="flex w-full min-w-0 flex-col gap-2 text-sm sm:w-auto sm:flex-row sm:items-center">Type
            <select aria-label="Filter exceptions by type" className="w-full min-w-0 max-w-full rounded-md border bg-background px-3 py-2 sm:w-auto sm:max-w-60" value={type} onChange={event => setType(event.target.value)}>
              <option value="">All types</option>
              {types.map(value => <option key={value} value={value}>{readableLabel(value)}</option>)}
            </select>
          </label>
          <p className="w-full text-xs text-muted-foreground">Overdue items first, then severity and deadline. Dates use West Africa Time.</p>
        </div>}

        <div id="exception-results" {...(targetId ? {} : { role: 'tabpanel', 'aria-labelledby': `exception-tab-${filter}`, tabIndex: 0 })}>
        {isLoading ? (
          <Loading what="exceptions" />
        ) : error && !data ? (
          <div ref={listProblem} role="alert" className="p-6 text-sm"><p>Exceptions could not be loaded.</p><Button className="mt-3" size="sm" variant="outline" onClick={() => { listAgain(); void refetch(); }}>Try again</Button></div>
        ) : targetId && items.length === 0 ? (
          <EmptyState title={wrongLender ? 'This exception link belongs to another lender' : 'The selected exception is unavailable'} action={<Button size="sm" variant="outline" onClick={leaveSelectedRecord}>View exception queue</Button>}>
            {wrongLender ? 'Switch to the lender you were reviewing to open this exception.' : 'It could not be found for the active lender. Open the exception queue to find it.'}
          </EmptyState>
        ) : items.length === 0 ? (
          <EmptyState filtered title={q ? 'No results match your search' : owner || type ? 'No exceptions match these filters' : filter === 'resolved' ? 'Nothing resolved yet' : filter === 'high' ? 'No high-severity exceptions open' : filter === 'overdue' ? 'No overdue exceptions' : filter === 'due-today' ? 'No exceptions due today' : 'All clear: no open exceptions'}>
            {q ? 'Try another name or reference, or clear the search. Your status, owner and type filters will stay selected.' : filter === 'resolved'
              ? 'Resolved and closed items will appear here with a record of how they were resolved.'
              : filter !== 'open' || owner || type
                ? 'Select All open, All owners and All types to review other exceptions.'
                : 'Items appear here when reconciliation finds a problem that needs review, such as an unmatched payment or missing notice evidence.'}
          </EmptyState>
        ) : (
          <ScrollFrame label="Exceptions" className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm text-left">
              <thead className="bg-secondary/30 border-b text-muted-foreground">
                <tr>
                  <th className="px-6 py-4 font-medium">Type and severity</th>
                  <th className="px-6 py-4 font-medium">Customer and amount</th>
                  <th className="px-6 py-4 font-medium">Status and owner</th>
                  <th className="px-6 py-4 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {items.map(exception => (
                  <tr key={exception.id} id={`record-${exception.id}`} tabIndex={-1} className="hover:bg-secondary/10 transition-colors target:bg-primary/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        {String(exception.data?.severity) === 'high' && <AlertTriangle className="h-4 w-4 text-destructive" />}
                        <span title={readableLabel(exception.data?.type)} className="font-semibold text-foreground">{readableLabel(exception.data?.type)}</span>
                      </div>
                      <span className={`inline-block mt-1 px-2 py-0.5 text-[10px] uppercase font-bold rounded border ${
                        String(exception.data?.severity) === 'high' ? 'bg-destructive/10 text-destructive border-destructive/20' : 
                        String(exception.data?.severity) === 'medium' ? 'bg-warning text-warning-foreground border-warning-border' : 
                        'bg-secondary text-secondary-foreground'
                      }`}>
                        {/* A stored exception may have none (an earlier edit could clear it): it is never shown as low. */}
                        {exception.data?.severity ? String(exception.data.severity) : 'No severity'}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <RecordLabel record={customerById.get(String(exception.customerId))} id={exception.customerId} customer />
                      {/* In the currency of the money it is about: the service names one that is not naira (data.currency). */}
                      {exception.amountKobo > 0 && (
                         <p className="font-mono font-medium mt-1">{formatRecordMoney(exception, exception.amountKobo)}</p>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <StatusBadge status={exception.status} />
                      {!!exception.data?.case && <p className="mt-2 text-xs font-medium">Assigned to {String((exception.data.case as any).assigneeName)}</p>}
                      <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
                        <User className="h-3 w-3" /> {String(exception.data?.owner || 'Unassigned')}
                      </div>
                      {!!exception.data?.dueBy && (
                        <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
                          <Calendar className="h-3 w-3" /> Due {formatDate(String(exception.data.dueBy))}
                          {isOpen(exception.status) && isOverdue(exception.data.dueBy, now) && <span className="font-semibold text-destructive">Overdue</span>}
                        </div>
                      )}
                      {!!exception.data?.notes && (
                        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground mt-2">{String(exception.data.notes)}</p>
                      )}
                    </td>
                    <td className="px-6 py-4 text-right space-x-2">
                      <Link href={`/cases/${exception.id}`} className="mb-2 inline-flex min-h-9 items-center text-xs font-medium text-primary underline">Case & handover</Link>
                      {exception.status !== 'resolved' && exception.status !== 'closed' ? (
                        <div className="flex justify-end gap-2">
                          {!permissionReason(workspace, { kind: 'exceptions', record: exception }) && <Button size="sm" variant="ghost" className="text-xs" kind="exceptions" record={exception} onClick={() => handleAction(exception, 'update')}>
                            Edit
                          </Button>}
                          <Button size="sm" variant="outline" className="text-xs" action="resolve_exception" record={exception} onClick={() => handleAction(exception, 'resolve')}>
                            Resolve
                          </Button>
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-xs">Resolution: {resolutionLabel(exception, exception.data?.resolutionCode)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollFrame>
        )}
        {!isLoading && !error && !targetId && (data?.total || 0) > 25 && <RecordPagination pagination={pagination} total={data?.total || 0} busy={isPlaceholderData} label="exceptions" />}
        </div>
      </div>

      <RecordDialog
        kind="exceptions"
        record={selectedEx}
        isOpen={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        title={actionKind === 'resolve' ? 'Resolve exception' : 'Edit exception'}
        actionMutation={actionKind === 'resolve' ? 'resolve_exception' : undefined}
        answer={() => resolvedRef.current}
        onDone={response => { if (actionKind === 'resolve' && selectedEx) setResolved({ what: `${readableLabel(selectedEx.data?.type || 'exception')}${selectedEx.reference ? ` ${selectedEx.reference}` : ''}`, message: String(response?.message || 'Exception resolution recorded.') }); }}
        context={selectedEx ? values => <ExceptionContext exception={selectedEx} customer={customerById.get(String(selectedEx.customerId))} resolving={actionKind === 'resolve'} resolutionCode={values.resolutionCode} /> : undefined}
        validate={actionKind === 'resolve' ? (values): Record<string, string> => ({ ...(heldIdentities.length ? providerIdentityErrors(values) : {}), ...(checkoutOutcome
          ? values.resolutionCode === 'resolved_succeeded' && !String(values.evidenceReference || '').trim() ? { evidenceReference: 'Enter the masked reference of the evidence that the payment arrived.' }
            : values.resolutionCode !== 'resolved_succeeded' && String(values.evidenceReference || '').trim() ? { evidenceReference: 'Enter an evidence reference only when the payment is confirmed as received.' } : {}
          : values.confirmedFailureCode && values.resolutionCode !== 'resolved_failed' ? { confirmedFailureCode: 'Choose a failure code only when the provider confirmed that the debit failed.' } : {}) }) : undefined}
        fields={
          actionKind === 'resolve' ? [
            { name: 'resolutionCode', label: `How was this resolved? (${readableLabel(selectedEx?.data?.type || 'exception').toLowerCase()})`, type: 'select', isData: true, required: true, options: resolutionChoices(selectedEx, workspace?.role, heldBatch.held, heldBatch.blocked).map(code => ({ label: resolutionLabel(selectedEx, code), value: code })) },
            ...(heldIdentities.length ? [{
              name: 'confirmedProviderIdentity', label: 'Connection whose payout this batch is', type: 'select' as const, isData: true, options: heldIdentities,
              help: 'Only with Provider identity confirmed: the connection the providers confirmed. Its evidence stays with the batch; the evidence of the others moves to their own batches.',
            }] : []),
            ...(checkoutOutcome ? [{
              name: 'evidenceReference', label: 'Evidence reference', type: 'text' as const, isData: true,
              help: 'Only when the payment is confirmed as received: the masked reference of the evidence that the money arrived, such as a bank statement line (STMT-***4411).',
            }] : resolveExceptionType(selectedEx?.data?.type) === 'unknown_outcome' ? [{
              name: 'confirmedFailureCode', label: 'Failure code the provider confirmed', type: 'select' as const, isData: true,
              options: failureCodeList.filter(code => code !== 'TIMEOUT_UNKNOWN').map(code => ({ label: readableLabel(code), value: code })),
              help: 'Only when the provider confirmed that the debit failed. Without a code the attempt is recorded as an unclassified failure, which is never retried.',
            }] : []),
          ] : [
            { name: 'owner', label: 'Assigned owner', type: 'text', isData: true },
            { name: 'notes', label: 'Notes', type: 'textarea', isData: true },
            // Every exception type has a severity (the service gives a new exception its type's), so an edit never clears it.
            { name: 'severity', label: 'Severity', type: 'select', isData: true, required: true, options: exceptionSeverities.map(severity => ({ label: severity.charAt(0).toUpperCase() + severity.slice(1), value: severity })) }
          ]
        }
      />
    </div>
  );
}
