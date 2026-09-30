import { QueueSearch } from '@/components/queue-search';
import { useSafeCreateRecord as useCreateRecord } from '@/lib/safe-mutations';
import React, { useEffect, useRef, useState } from 'react';
import { useUnsavedChanges } from '@/lib/unsaved-changes';
import { Link, useSearchParams } from 'wouter';
import { ScrollFrame } from '@/components/scroll-frame';
import { FieldError, FormAlert, attentionTitle, focusField, invalidProps, missingMessage, serverFieldErrors } from '@/components/form-field';
import { EmptyState } from '@/components/empty-state';
import { Loading } from '@/components/loading';
import * as Dialog from '@radix-ui/react-dialog';
import { useWorkspace } from '@/lib/workspace-context';
import { permissionReason } from '@/lib/permissions';
import { useListRecords, getListRecordsQueryKey, } from '@workspace/api-client-react';
import { formatKobo, formatDate, formatNumber } from '@/lib/formatters';
import { PermissionButton as Button } from '@/components/permission-button';
import { RecordDialog } from '@/components/record-dialog';
import { useQueryClient } from '@tanstack/react-query';
import { activationWorkflows, mandateFrequencies } from '@workspace/valopay-schema';
import { RecordLabel, StatusBadge, readableLabel } from '@/components/record-label';
import { isDueToday, isOverdue, useQueueFilters } from '@/lib/queue-filters';
import { nairaToKobo } from '@/lib/money-input';
import { MandateActionContext } from '@/components/mandate-action-context';
import { recordDestination, safeCollectionReturnTo } from '@/lib/record-navigation';
import { useHashTarget } from '@/lib/use-hash-target';
import { usePagedQueue } from '@/lib/use-paged-queue';
import { SavedQueueViews } from '@/components/saved-queue-views';
import { RecordPagination, usePageProblemFocus } from '@/components/record-pagination';
import { DiscardOriginalRequest } from '@/components/discard-original-request';
import { KEPT_IN_OPERATIONS, OpenOperations } from '@/components/pilot-ui';
import { keepRowsWhilePaging, searchWithoutSubmitting, useDebouncedSearch, useRecordPagination } from '@/lib/use-record-pagination';
import { LoadProblem } from '@/components/load-problem';

const mandateViews = ['all', 'awaiting-activation', 'overdue', 'due-today'] as const;
const emptyMandate = { name: '', customerId: '', amountKobo: '', reference: '', workflow: 'hosted_consent', consentEvidence: '', consentGaps: '', policyId: '', frequency: 'monthly' };

const mandateActionTitles: Record<string, string> = {
  mandate_suspend: 'Suspend mandate', mandate_reinstate: 'Resume mandate', mandate_cancel: 'Cancel mandate',
  mandate_reissue: 'Reissue mandate', activation_reminder: 'Record activation reminder',
  notify_policy_change: 'Record policy change notice', apply_policy_version: 'Apply policy version',
};

export default function MandatesPage() {
  const { merchantId, workspace } = useWorkspace();
  const [selectedMandate, setSelectedMandate] = useState<any>(null);
  const [actionKind, setActionKind] = useState<string>('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const pendingErrorFocus = useRef<string | null>(null);
  // The queue's problem notice, which takes the pager's focus when a page press fails.
  const listProblem = useRef<HTMLDivElement>(null);
  const listAgain = usePageProblemFocus(listProblem, 'mandates');
  const { view, setView } = useQueueFilters(mandateViews, 'all');
  const [search, setSearch] = useSearchParams();
  const targetId = search.get('record');
  const wrongLender = Boolean(search.get('lender') && search.get('lender') !== merchantId);
  const returnTo = safeCollectionReturnTo(search.get('returnTo'), merchantId);
  /** The fields the form asks for, in order, with the words a missing value is named by. */
  const requiredFields: Array<{ name: keyof typeof draft; label: string; type: 'text' | 'number' | 'select' }> = [
    { name: 'name', label: 'Mandate name', type: 'text' }, { name: 'customerId', label: 'Customer', type: 'select' }, { name: 'amountKobo', label: 'Debit limit (₦)', type: 'text' },
    { name: 'reference', label: 'Provider reference', type: 'text' }, { name: 'workflow', label: 'Activation method', type: 'select' }, { name: 'consentEvidence', label: 'Consent evidence reference', type: 'text' },
    { name: 'policyId', label: 'Retry policy', type: 'select' }, { name: 'frequency', label: 'Frequency', type: 'select' },
  ];
  const change = (name: keyof typeof draft, value: string) => {
    setDraft(current => ({ ...current, [name]: value }));
    setFieldErrors(prev => { if (!prev[name]) return prev; const next = { ...prev }; delete next[name]; return next; });
  };
  const [draft, setDraft] = useState(emptyMandate);
  const draftScope = `${merchantId}:${isCreateOpen}`;
  const createSession = useRef({ scope: draftScope });
  if (createSession.current.scope !== draftScope) createSession.current = { scope: draftScope };
  const { confirmDiscard } = useUnsavedChanges(isCreateOpen && JSON.stringify(draft) !== JSON.stringify(emptyMandate));
  const changeCreateOpen = (open: boolean) => { if (!open && (createMandate.isPending || createMandate.hasUnconfirmedOutcome)) return; if (open || confirmDiscard()) { if (!open) { setDraft(emptyMandate); setCustomerSearch(''); setChosenCustomer(null); } setIsCreateOpen(open); } };
  useEffect(() => () => { createSession.current = { scope: 'unmounted' }; }, []);
  useEffect(() => {
    setSelectedMandate(null); setIsDialogOpen(false); setIsCreateOpen(false);
    setFieldErrors({}); setFormErrors([]); setDraft(emptyMandate); setCustomerSearch(''); setChosenCustomer(null);
  }, [merchantId]);
  const queryClient = useQueryClient();

  const { data, isLoading, isPlaceholderData, error, refetch, pagination } = usePagedQueue('mandates', { view, record: targetId ? wrongLender ? 'unavailable' : targetId : undefined });
  // The customer picker asks for one searchable page of customers, never the whole book (a pilot lender's was about 400 KB).
  const [customerSearch, setCustomerSearch] = useState('');
  const { search: customerTerm, searchPending: customerSearchPending } = useDebouncedSearch(customerSearch, draftScope);
  const customerPage = useRecordPagination(`${draftScope}:${customerTerm}`);
  const customerParams = { merchantId: merchantId!, search: customerTerm, limit: customerPage.pageSize, offset: customerPage.offset };
  // Paging keeps the choices shown, and so the pager and the control pressed, until the next page arrives.
  const customersKey = getListRecordsQueryKey('customers', customerParams);
  const { data: customers, error: customersError, isFetching: fetchingCustomers, refetch: retryCustomers } = useListRecords(
    'customers',
    customerParams,
    { query: { enabled: !!merchantId && isCreateOpen && !customerSearchPending, queryKey: customersKey, placeholderData: keepRowsWhilePaging(customersKey, queryClient) } }
  );
  // The chosen customer stays in the list while the person searches or pages on.
  const [chosenCustomer, setChosenCustomer] = useState<{ value: string; label: string } | null>(null);
  const customerOptions = (customers?.items || []).map(customer => ({ value: customer.id, label: `${customer.name} · ${customer.reference}` }));
  if (chosenCustomer && chosenCustomer.value === draft.customerId && !customerOptions.some(option => option.value === chosenCustomer.value)) customerOptions.unshift(chosenCustomer);
  useHashTarget(`record-${targetId || ''}`, !!targetId && !isLoading && !error && !wrongLender);
  const { data: policies } = useListRecords(
    'policies',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId && (isCreateOpen || isDialogOpen), queryKey: getListRecordsQueryKey('policies', { merchantId: merchantId! }) } }
  );
  const customerById = new Map([...(data?.related || []), ...(customers?.items || [])].filter(row => row.kind === 'customers').map(customer => [customer.id, customer]));
  const approvedVersionOptions = (policies?.items || []).filter(policy => policy.status === 'approved').map(policy => ({ value: policy.id, label: `${policy.name} · version ${String(policy.data?.version || 1)}` }));
  const createMandate = useCreateRecord({
    mutation: {
      onMutate: () => createSession.current,
      onSuccess: (_data, _variables, submitted) => {
        queryClient.invalidateQueries();
        if (submitted !== createSession.current) return;
        setIsCreateOpen(false);
        // The next mandate starts afresh, as after Cancel: no search and no customer chosen.
        setDraft(emptyMandate); setCustomerSearch(''); setChosenCustomer(null);
        setFieldErrors({}); setFormErrors([]);
      },
      onError: (error: unknown, _variables, submitted) => {
        if (submitted !== createSession.current) return;
        const { fields, general } = serverFieldErrors(error, path => { const name = path.replace(/^data\./, ''); return requiredFields.some(field => field.name === name) ? name : null; });
        setFieldErrors(fields); setFormErrors(general);
        const first = requiredFields.find(field => fields[field.name]);
        if (first) pendingErrorFocus.current = first.name;
      }
    }
  }, draftScope);
  useEffect(() => { if (!createMandate.isPending && pendingErrorFocus.current) { focusField(`mandate-${pendingErrorFocus.current}`); pendingErrorFocus.current = null; } }, [createMandate.isPending, fieldErrors]);

  const handleAction = (mandate: any, action: string) => {
    setSelectedMandate(mandate);
    setActionKind(action);
    setIsDialogOpen(true);
  };

  const submitCreate = (event: React.FormEvent) => {
    event.preventDefault();
    if (createMandate.isPending) return;
    const blocked = permissionReason(workspace, { kind: 'mandates' });
    if (blocked) { setFormErrors([blocked]); return; }
    if (createMandate.hasUnconfirmedOutcome) { void createMandate.retryUnconfirmed().catch(() => undefined); return; }
    const errors: Record<string, string> = {};
    for (const field of requiredFields) {
      const value = String(draft[field.name] ?? '').trim();
      if (!value) errors[field.name] = missingMessage(field.label, field.type);
      else if (field.type === 'number' && !Number.isFinite(Number(value))) errors[field.name] = `Enter ${field.label} as a number.`;
    }
    let amountKobo = 0;
    if (!errors.amountKobo) {
      try {
        amountKobo = nairaToKobo(draft.amountKobo);
        if (amountKobo === 0) errors.amountKobo = 'Enter a debit limit greater than ₦0.00.';
      } catch (error) { errors.amountKobo = error instanceof Error ? error.message : 'Enter a debit limit in naira.'; }
    }
    setFieldErrors(errors); setFormErrors([]);
    const first = requiredFields.find(field => errors[field.name]);
    if (first) { focusField(`mandate-${first.name}`); return; }
    createMandate.mutate({
      kind: 'mandates',
      data: {
        name: draft.name,
        customerId: draft.customerId,
        amountKobo,
        reference: draft.reference,
        data: {
          workflow: draft.workflow,
          consentEvidence: draft.consentEvidence,
          consentGaps: draft.consentGaps.split('\n').map(value => value.trim()).filter(Boolean),
          policyId: draft.policyId,
          frequency: draft.frequency,
          origin: 'imported'
        }
      },
      params: { merchantId: merchantId! }
    });
  };

  const now = data?.asOf ? Date.parse(data.asOf) : Date.now();
  const shown = data?.items || [];
  const pagedMandates = shown;
  const replacements = targetId && !wrongLender ? (data?.related || []).filter(mandate => mandate.kind === 'mandates' && mandate.data?.reissuedFrom === targetId) : [];
  const leaveSelectedRecord = () => setSearch(current => {
    const next = new URLSearchParams(current);
    next.delete('record'); next.delete('lender');
    return next;
  });
  const views: Array<{ key: typeof view; label: string; count: number | string }> = [
    { key: 'all', label: 'All mandates' }, { key: 'awaiting-activation', label: 'Awaiting activation' },
    { key: 'overdue', label: 'Overdue activation' }, { key: 'due-today', label: 'Activation due today' },
  ].map(item => ({ ...item, key: item.key as typeof view, count: typeof data?.counts[item.key] === 'number' ? formatNumber(data.counts[item.key]!) : '…' }));
  if (!merchantId) return null;

  return (
    <div className="space-y-6">
      {returnTo && <Link href={returnTo} className="inline-flex text-sm font-medium text-primary underline underline-offset-4">Back to Collections</Link>}
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Mandates</h1>
          <p className="text-muted-foreground mt-1">A mandate is a customer’s permission for recurring bank debits. Track each mandate and its activation here.</p>
        </div>
        <Button kind="mandates" onClick={() => setIsCreateOpen(true)}>Add mandate</Button>
      </header>

      <QueueSearch /><SavedQueueViews queue="mandates" views={mandateViews} fallback="all" />

      <div className="bg-card border rounded-xl shadow-sm overflow-hidden flex flex-col">
        {targetId ? <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4"><p className="text-sm font-medium">Selected mandate</p><Button size="sm" variant="outline" onClick={leaveSelectedRecord}>Show all mandates</Button></div> : <div className="border-b p-4">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Mandate views">
            {views.map(option => <Button key={option.key} size="sm" variant={view === option.key ? 'default' : 'ghost'} aria-pressed={view === option.key} onClick={() => setView(option.key)}>{option.label} ({option.count})</Button>)}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">Mandates awaiting activation come first, with the earliest deadline at the top.</p>
        </div>}
        {isLoading ? (
          <Loading what="mandates" />
        ) : error ? (
          <div ref={listProblem} role="alert" className="p-6 text-sm"><p>We could not load mandates.</p><Button className="mt-3" size="sm" variant="outline" onClick={() => { listAgain(); void refetch(); }}>Try again</Button></div>
        ) : targetId && shown.length === 0 ? (
          <EmptyState title={wrongLender ? 'This mandate link belongs to another lender' : 'Mandate not found'} action={<Button size="sm" variant="outline" onClick={leaveSelectedRecord}>Show all mandates</Button>}>
            {wrongLender ? 'To open this mandate, choose its lender in Active lender.' : 'This mandate was not found for the selected lender. Show all mandates, or go back to the page you came from.'}
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState title={search.get('q')?.trim() ? 'No mandates match your search' : view === 'all' ? 'No mandates yet' : 'No mandates match these filters'} action={search.get('q')?.trim() ? undefined : view === 'all' ? <Button kind="mandates" size="sm" variant="outline" onClick={() => setIsCreateOpen(true)}>Add mandate</Button> : <Button size="sm" variant="outline" onClick={() => setView('all')}>Show all mandates</Button>}>
            {search.get('q')?.trim() ? 'Try another name or reference, or clear the search. Your view stays as it is.' : view === 'all' ? 'Mandates appear after they are added or imported. Select Add mandate to try activation.' : 'Select Show all mandates to see every activation status.'}
          </EmptyState>
        ) : (
          <ScrollFrame label="Mandates" className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-secondary/30 border-b text-muted-foreground">
                <tr>
                  <th className="px-6 py-4 font-medium">Reference</th>
                  <th className="px-6 py-4 font-medium">Customer</th>
                  <th className="px-6 py-4 font-medium">Status</th>
                  <th className="px-6 py-4 font-medium">Debit limit</th>
                  <th className="px-6 py-4 font-medium">Activation method</th>
                  <th className="px-6 py-4 font-medium">Activation deadline</th>
                  <th className="px-6 py-4 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {pagedMandates.map(mandate => (
                  <tr key={mandate.id} id={`record-${mandate.id}`} tabIndex={-1} className="hover:bg-secondary/10 target:bg-primary/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
                    <td className="px-6 py-4 font-mono font-medium">{mandate.reference}</td>
                    <td className="px-6 py-4"><RecordLabel record={customerById.get(String(mandate.customerId))} id={mandate.customerId} customer /></td>
                    <td className="px-6 py-4"><StatusBadge status={mandate.status} /></td>
                    <td className="px-6 py-4 font-mono">{formatKobo(mandate.amountKobo)}</td>
                    <td className="px-6 py-4 text-xs text-muted-foreground" title={readableLabel(mandate.data?.workflow || 'standard')}>{readableLabel(mandate.data?.workflow || 'standard')}</td>
                    <td className="px-6 py-4 text-xs"><p>{formatDate(String(mandate.data?.activationDeadline || ''))}</p>{mandate.status === 'pending_activation' && isOverdue(mandate.data?.activationDeadline, now) && <p className="mt-1 font-semibold text-destructive">Overdue · follow up or reissue</p>}{mandate.status === 'pending_activation' && !isOverdue(mandate.data?.activationDeadline, now) && isDueToday(mandate.data?.activationDeadline, now) && <p className="mt-1 font-semibold text-warning-strong">Activation due today</p>}</td>
                    <td className="px-6 py-4 text-right space-x-2">
                      {mandate.status === 'active' && <Button size="sm" variant="outline" className="h-7 text-xs" action="mandate_suspend" record={mandate} onClick={() => handleAction(mandate, 'mandate_suspend')}>Suspend mandate</Button>}
                      {mandate.status === 'suspended' && <Button size="sm" variant="outline" className="h-7 text-xs" action="mandate_reinstate" record={mandate} onClick={() => handleAction(mandate, 'mandate_reinstate')}>Resume mandate</Button>}
                      {['draft', 'submitted', 'pending_activation', 'active', 'suspended'].includes(mandate.status) && <Button size="sm" variant="outline" className="h-7 text-xs" action="mandate_cancel" record={mandate} onClick={() => handleAction(mandate, 'mandate_cancel')}>Cancel mandate</Button>}
                      {['pending_activation', 'expired', 'cancelled', 'failed'].includes(mandate.status) && <Button size="sm" variant="outline" className="h-7 text-xs" action="mandate_reissue" record={mandate} onClick={() => handleAction(mandate, 'mandate_reissue')}>Reissue mandate</Button>}
                      {mandate.status === 'pending_activation' && <Button size="sm" variant="outline" className="h-7 text-xs" action="activation_reminder" record={mandate} onClick={() => handleAction(mandate, 'activation_reminder')}>Record activation reminder</Button>}
                      {['active', 'suspended', 'pending_activation'].includes(mandate.status) && <Button size="sm" variant="ghost" className="h-7 text-xs" action="notify_policy_change" record={mandate} onClick={() => handleAction(mandate, 'notify_policy_change')}>Record policy change notice</Button>}
                      {['active', 'suspended', 'pending_activation'].includes(mandate.status) && <Button size="sm" variant="ghost" className="h-7 text-xs" action="apply_policy_version" record={mandate} onClick={() => handleAction(mandate, 'apply_policy_version')}>Apply policy version</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollFrame>
        )}
        {!isLoading && !error && !targetId && <RecordPagination pagination={pagination} total={data?.total || 0} busy={isPlaceholderData} label="mandates" />}
      </div>

      {replacements.length > 0 && <section aria-label="Reissued mandates" className="rounded-xl border bg-card p-5 text-sm">
        <h2 className="font-semibold">Mandates reissued from this one</h2>
        <p className="mt-1 text-muted-foreground">Open the new mandate to track its activation. The original history stays with this mandate.</p>
        <ul className="mt-3 space-y-2">{replacements.map(replacement => <li key={replacement.id} className="flex flex-wrap items-center gap-3">
          <Link href={recordDestination('/mandates', replacement.id, returnTo || '', merchantId)} className="font-medium text-primary underline underline-offset-4">{replacement.reference || replacement.name}</Link>
          <StatusBadge status={replacement.status} />
        </li>)}</ul>
      </section>}

      <RecordDialog
        kind="mandates"
        record={selectedMandate && ['mandate_reissue', 'apply_policy_version', 'notify_policy_change'].includes(actionKind)
          ? { ...selectedMandate, data: { ...selectedMandate.data, consentEvidence: '', policyId: '', noticeId: '' } }
          : selectedMandate}
        isOpen={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        title={mandateActionTitles[actionKind] || 'Update mandate'}
        actionMutation={actionKind}
        context={values => selectedMandate && <MandateActionContext
          mandate={selectedMandate}
          customerName={customerById.get(String(selectedMandate.customerId))?.name}
          customerReference={customerById.get(String(selectedMandate.customerId))?.reference || selectedMandate.customerId}
          action={actionKind}
          policyName={approvedVersionOptions.find(policy => policy.value === values.policyId)?.label}
        />}
        fields={actionKind === 'mandate_reissue' ? [
            { name: 'consentEvidence', label: 'New consent evidence reference', type: 'text', isData: true, required: true, help: 'Reissuing creates a new mandate.' },
            { name: 'amountKobo', label: 'Debit limit the new consent covers', type: 'number', isData: true, required: true },
          ]
          : actionKind === 'notify_policy_change' ? [{ name: 'policyId', label: 'Approved policy version', type: 'select', isData: true, required: true, options: approvedVersionOptions, help: 'The notice is simulated. It is not proof that the customer received it.' }]
          : actionKind === 'apply_policy_version' ? [
            { name: 'policyId', label: 'Approved policy version to apply', type: 'select', isData: true, required: true, options: approvedVersionOptions },
            { name: 'noticeId', label: 'Accepted notice ID', type: 'text', isData: true, help: 'Optional. Leave it empty to use the latest accepted notice for this version.' },
            { name: 'consentEvidence', label: 'New consent evidence reference', type: 'text', isData: true, help: 'Needed only if this lender asks for fresh consent when a retry policy changes.' },
          ] : []}
      />
      <Dialog.Root open={isCreateOpen} onOpenChange={changeCreateOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg max-h-[90vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border bg-background p-6 shadow-lg">
            <Dialog.Title className="text-lg font-semibold">Add mandate</Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-muted-foreground">Use sample details only. This adds a mandate to the sample data and sends no instruction to a bank. Fields marked * are required.</Dialog.Description>
            <form noValidate className="mt-5 space-y-4" onSubmit={submitCreate}>
              {createMandate.hasUnconfirmedOutcome && <FormAlert title="Request not confirmed"><p>We do not know yet whether Valo Pay saved this mandate. Check the original request before you change anything. Keep these details as they are: checking never adds a second mandate. {KEPT_IN_OPERATIONS}</p><div className="mt-2 flex flex-wrap items-center gap-3"><OpenOperations /><DiscardOriginalRequest disabled={createMandate.isPending} onDiscard={() => { createMandate.abandonUnconfirmed(); setFormErrors([]); setFieldErrors({}); }} /></div></FormAlert>}
              <fieldset disabled={createMandate.isPending || createMandate.hasUnconfirmedOutcome} className="contents">
              {!createMandate.hasUnconfirmedOutcome && (formErrors.length > 0 || Object.keys(fieldErrors).length > 0) && (
                <FormAlert title={formErrors[0] ?? attentionTitle(Object.keys(fieldErrors).length)}>{formErrors.slice(1).map(message => <p key={message}>{message}</p>)}</FormAlert>
              )}
              <MandateField label="Mandate name" value={draft.name} id="mandate-name" error={fieldErrors.name} onChange={value => change('name', value)} required />
              <div className="space-y-2">
                <label className="grid gap-1 text-sm font-medium">Search customers<input type="search" value={customerSearch} onKeyDown={searchWithoutSubmitting} onChange={event => { setCustomerSearch(event.target.value); customerPage.setPage(0); }} placeholder="Name or reference" className={controlClass} /></label>
                <MandateSelect label="Customer" value={draft.customerId} id="mandate-customerId" error={fieldErrors.customerId} onChange={value => { change('customerId', value); setChosenCustomer(customerOptions.find(option => option.value === value) ?? null); }} required options={customerOptions} />
                {customersError ? <LoadProblem what="customer choices" pager="customer choices" error={customersError} retry={() => { void retryCustomers(); }} busy={fetchingCustomers} /> : <>
                  {(fetchingCustomers || customerSearchPending) && <p role="status" className="text-xs text-muted-foreground">Loading customer choices…</p>}
                  {customers && !customerSearchPending && <RecordPagination pagination={customerPage} total={customers.total} busy={fetchingCustomers} label="customer choices" />}
                </>}
              </div>
              <MandateField label="Debit limit (₦)" inputMode="decimal" value={draft.amountKobo} id="mandate-amountKobo" error={fieldErrors.amountKobo} onChange={value => change('amountKobo', value)} required />
              <MandateField label="Provider reference" value={draft.reference} id="mandate-reference" error={fieldErrors.reference} onChange={value => change('reference', value)} required />
              <MandateSelect label="Activation method" value={draft.workflow} id="mandate-workflow" error={fieldErrors.workflow} onChange={value => change('workflow', value)} required options={activationWorkflows.map(workflow => ({ value: workflow, label: readableLabel(workflow) }))} />
              <MandateField label="Consent evidence reference" value={draft.consentEvidence} id="mandate-consentEvidence" error={fieldErrors.consentEvidence} onChange={value => change('consentEvidence', value)} required />
              <div>
                <label htmlFor="mandate-consent-gaps" className="block text-sm font-medium">Missing consent evidence</label>
                <textarea id="mandate-consent-gaps" aria-describedby="mandate-consent-gaps-help" className="mt-1 min-h-[72px] w-full rounded-md border bg-transparent px-3 py-2 text-sm" value={draft.consentGaps} onChange={event => setDraft({ ...draft, consentGaps: event.target.value })} />
                <p id="mandate-consent-gaps-help" className="mt-1 text-xs text-muted-foreground">One item per line.</p>
              </div>
              <MandateSelect label="Retry policy" value={draft.policyId} id="mandate-policyId" error={fieldErrors.policyId} onChange={value => change('policyId', value)} required options={(policies?.items || []).map(policy => ({ value: policy.id, label: `${policy.name} · version ${String(policy.data?.version || 1)} · ${readableLabel(policy.status)}` }))} />
              <MandateSelect label="Frequency" value={draft.frequency} id="mandate-frequency" error={fieldErrors.frequency} onChange={value => change('frequency', value)} required options={mandateFrequencies.map(frequency => ({ value: frequency, label: readableLabel(frequency) }))} />
              </fieldset>
              <div className="flex justify-end gap-2 border-t pt-4">
                <Button type="button" variant="outline" disabled={createMandate.isPending || createMandate.hasUnconfirmedOutcome} onClick={() => changeCreateOpen(false)}>Cancel</Button>
                <Button kind="mandates" type="submit" busy={createMandate.isPending} busyLabel={createMandate.hasUnconfirmedOutcome ? 'Checking original request…' : 'Adding mandate…'}>{createMandate.hasUnconfirmedOutcome ? 'Check original request' : 'Add mandate'}</Button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

type MandateControl = { id: string; label: string; value: string; onChange: (value: string) => void; required?: boolean; error?: string };
const controlClass = 'mt-1 flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

function MandateField({ id, label, value, onChange, required, error, type = 'text', inputMode }: MandateControl & { type?: 'text' | 'number'; inputMode?: 'decimal' }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">{label}{required ? ' *' : ''}</label>
      <input id={id} type={type} inputMode={inputMode} required={required} value={value} onChange={event => onChange(event.target.value)} className={controlClass} {...invalidProps(id, error)} />
      <FieldError id={id} message={error} />
    </div>
  );
}

function MandateSelect({ id, label, value, onChange, required, error, options }: MandateControl & { options: { value: string; label: string }[] }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">{label}{required ? ' *' : ''}</label>
      <select id={id} required={required} value={value} onChange={event => onChange(event.target.value)} className={controlClass} {...invalidProps(id, error)}>
        <option value="">Choose an option</option>
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <FieldError id={id} message={error} />
    </div>
  );
}
