import { ExportJobControl } from '@/components/export-job-control';
import React, { useEffect } from 'react';
import { ScrollFrame } from '@/components/scroll-frame';
import { EmptyState } from '@/components/empty-state';
import { Loading } from '@/components/loading';
import { useWorkspace } from '@/lib/workspace-context';
import { useGetCustomerHistory, getGetCustomerHistoryQueryKey, } from '@workspace/valo-pay-1-api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { formatKobo, formatDate, formatCompactDate, formatCount } from '@/lib/formatters';
import { formatRecordMoney, otherCurrencyEntries } from '@/lib/currencies';
import { ArrowLeft, Clock, FileText, CheckCircle, AlertTriangle } from 'lucide-react';
import { CustomerAvatar, StatusBadge, readableLabel } from '@/components/record-label';
import { Link, useParams, useSearch, useSearchParams } from 'wouter';
import { LookedFor } from '@/components/notice';
import { NotFoundNotice } from '@/pages/not-found';
import { LoadProblem } from '@/components/load-problem';
import { RecordPagination } from '@/components/record-pagination';
import { useUrlPagination } from '@/lib/use-url-pagination';
import { keepRowsWhilePaging } from '@/lib/use-record-pagination';
import { safeCustomerReturnTo } from '@/lib/record-navigation';
import { useHashTarget } from '@/lib/use-hash-target';
import { recordKindName } from '@/lib/record-kinds';

/** The page a return link goes back to, by its name in the navigation. */
const backPages: Record<string, string> = { '/collections': 'Collections', '/exceptions': 'Exceptions', '/reconciliation': 'Reconciliation', '/mandates': 'Mandates', '/customers': 'Customers' };

/** The sections' pagers: one history request carries every section's page, so a failed page replaces the whole history. */
const sectionPagers = ['customer mandates', 'customer instalments', 'customer payments', 'history events'] as const;

const watStamp = (iso: unknown) => typeof iso === 'string' && Number.isFinite(Date.parse(iso)) ? formatDate(iso) : 'not recorded';

/** RET-03: the recorded decision in one sentence: why, when the next attempt is, the notice it requires, the version and the arm. */
function decisionDetail(data: Record<string, any>): string {
  const notice = data.noticeRequired as { purpose?: string; requiredBy?: string | null; evidenced?: boolean } | undefined;
  return [
    String(data.reason || ''),
    data.nextAt ? `Next attempt: ${watStamp(data.nextAt)}.` : '',
    notice ? `Customer notice: ${readableLabel(notice.purpose)}${notice.requiredBy ? `, due by ${watStamp(notice.requiredBy)}` : ''}. ${notice.evidenced ? 'The provider’s acceptance is recorded.' : 'No provider acceptance is recorded.'}` : '',
    `Retry policy version: ${String(data.policyVersion || 'not recorded')}.${data.experimentArm ? ` Experiment group: ${readableLabel(data.experimentArm)}.` : ''}`,
  ].filter(Boolean).join(' ');
}

/** How an allocation was made, then the reason recorded with it: an automatic match names its rule and how sure it was. A proposal
 * says why it was made, not what is still to do: Finance's decision changes only its status, which the badge beside it shows. */
function allocationDetail(data: Record<string, any>): string {
  const rule = String(data.rule || 'not recorded');
  const confidence = data.confidence && data.confidence !== 'manual' ? ` Confidence: ${readableLabel(data.confidence)}.` : '';
  const how = data.automatic === true ? `Matched automatically by rule ${rule}.${confidence}`
    : data.confidence === 'manual' ? ''
    : `Proposed by rule ${rule} for Finance to confirm.${confidence}`;
  return [how, String(data.explanation || '')].filter(Boolean).join(' ');
}

/** The address is a customer page, but the current lender has no customer with that reference. */
function MissingCustomer({ id }: { id: string }) {
  useEffect(() => { document.title = 'Customer not found · Valo Pay 1'; }, []);
  return (
    <NotFoundNotice title="Customer not found" primary={{ href: '/customers', label: 'Back to Customers' }} secondary={{ href: '/overview', label: 'Open Overview' }}>
      <p>No customer has the ID <LookedFor>{id}</LookedFor> for this lender. It may have been deleted, or it belongs to another lender. Check the address or choose another lender.</p>
      <p>Nothing has changed.</p>
    </NotFoundNotice>
  );
}

export default function CustomerTimelinePage() {
  const { id } = useParams();
  const { merchantId, workspace } = useWorkspace();
  const search = new URLSearchParams(useSearch());
  const sameLender = !search.get('lender') || search.get('lender') === merchantId;
  const requestedRecord = sameLender ? search.get('record') : null;
  const returnTo = safeCustomerReturnTo(search.get('returnTo'), merchantId);

  const historyPage = useUrlPagination(merchantId, 'history-');
  const mandatePage = useUrlPagination(merchantId, 'mandate-');
  const duePage = useUrlPagination(merchantId, 'due-');
  const paymentPage = useUrlPagination(merchantId, 'payment-');
  const queryParams = {merchantId:merchantId!, record:requestedRecord || undefined,
    eventsLimit:historyPage.pageSize, eventsOffset:historyPage.offset,
    mandatesLimit:mandatePage.pageSize, mandatesOffset:mandatePage.offset,
    dueItemsLimit:duePage.pageSize, dueItemsOffset:duePage.offset,
    paymentsLimit:paymentPage.pageSize, paymentsOffset:paymentPage.offset};
  const historyKey = getGetCustomerHistoryQueryKey(id!,queryParams), client = useQueryClient();
  // Paging a section keeps this customer's history shown until the next page arrives, so its pager and the control pressed stay.
  const { data: timeline, isLoading, isFetching, isPlaceholderData, error, refetch } = useGetCustomerHistory(id!,queryParams,
    {query:{enabled:!!merchantId && !!id && sameLender,queryKey:historyKey,placeholderData:keepRowsWhilePaging(historyKey,client)}});
  const focusedRecord = timeline?.focusedRecord;
  // Correct every out-of-range section together so one URL update cannot undo another.
  const [, setSearch] = useSearchParams();
  useEffect(() => {
    // The previous page's history, shown while this one loads, says nothing of where this page is.
    if (!timeline || isPlaceholderData) return;
    const sections = [['events','history-',historyPage],['mandates','mandate-',mandatePage],['dueItems','due-',duePage],['payments','payment-',paymentPage]] as const;
    if (!sections.some(([key,,page])=>timeline.offsets[key]!==page.offset)) return;
    setSearch(current=>{const next=new URLSearchParams(current);for(const [key,prefix,page] of sections) if(timeline.offsets[key]!==page.offset) next.set(prefix+'page',String(Math.floor(timeline.offsets[key]/page.pageSize)+1));return next;},{replace:true});
  },[timeline,isPlaceholderData,historyPage.offset,mandatePage.offset,duePage.offset,paymentPage.offset]);
  useHashTarget(`record-${requestedRecord}`, !!focusedRecord && !error);


  if (!merchantId) return null;
  if (!sameLender) return <NotFoundNotice title="Choose the linked lender" primary={{ href: '/collections', label: 'Open Collections' }} secondary={{ href: '/customers', label: 'Open Customers' }}><p>This link belongs to {workspace?.merchants.find(merchant => merchant.id === search.get('lender'))?.name || 'another lender'}. Choose that lender in Active lender to see this customer.</p></NotFoundNotice>;
  if (isLoading) return <Loading what="the customer history" heading />;
  if ((error as { status?: number } | null)?.status === 404) return <MissingCustomer id={String(id)} />;
  if (error || !timeline) return <div className="space-y-4"><h1 className="text-2xl font-bold tracking-tight">Customer history</h1><LoadProblem what="customer history" pager={sectionPagers} error={error} retry={() => { void refetch(); }} busy={isFetching} /></div>;

  const { customer, position, events, mandates, dueItems, payments } = timeline;
  // Money in another currency that the customer's payments hold unallocated, never added to the naira amount.
  const otherCredit = otherCurrencyEntries(position?.unallocatedOtherCurrencies, 'payment');

  return (
    <div className="space-y-6">
      <div>
        <Link href={returnTo || '/customers'} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4 print:hidden">
          <ArrowLeft aria-hidden="true" className="h-4 w-4" /> Back to {returnTo ? backPages[returnTo.split('?')[0]!] || 'the previous page' : 'Customers'}
        </Link>
        <div className="flex flex-col xl:flex-row xl:items-start justify-between gap-6">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-4">
              <CustomerAvatar name={customer.name} large />
              <div>
                <h1 className="text-3xl font-bold tracking-tight">{customer.name}</h1>
                <p className="text-muted-foreground mt-1 font-mono text-xs" title={customer.id}>{customer.reference}</p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Bank:</span> <span className="font-medium">{String(customer.data?.bankName || 'Not provided')}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Account:</span> <span className="font-mono font-medium">{String(customer.data?.accountMasked || 'Not provided')}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Status:</span> 
                <span className="ml-2"><StatusBadge status={customer.status} /></span>
              </div>
            </div>
            <div className="mt-4"><ExportJobControl kind="dispute-pack" customerId={String(id)} formats={['pdf', 'csv', 'json']} label="Export dispute pack (PDF)" /></div>
            <p className="mt-2 max-w-xl text-xs leading-relaxed text-muted-foreground">Creates a file for a dispute review. It holds a summary, the full customer history, and the retry policy, message template and handover versions used at each event. Once it is ready, you can check later that the file has not changed.</p>
          </div>

          <div className="bg-card border rounded-xl p-5 shadow-sm w-full xl:w-80 shrink-0">
            <h2 className="text-sm font-semibold text-muted-foreground mb-2">Balance summary</h2>
            <div className="space-y-3">
              <div className="flex justify-between items-baseline">
                <span className="text-sm text-muted-foreground">Outstanding</span>
                <span className="text-lg font-bold text-destructive font-mono">{formatKobo(Number(position?.outstandingKobo || 0))}</span>
              </div>
              <div className="flex justify-between items-baseline">
                <span className="text-sm text-muted-foreground">Allocated</span>
                <span className="text-lg font-bold text-success font-mono">{formatKobo(Number(position?.allocatedKobo || 0))}</span>
              </div>
              <div className="flex justify-between items-baseline">
                <span className="text-sm text-muted-foreground">Unallocated payments</span>
                <span className="text-lg font-bold font-mono">{formatKobo(Number(position?.unallocatedKobo || 0))}</span>
              </div>
              {/* A list under its label, each currency on a line of its own, as the card is narrow beside the history. */}
              {otherCredit.length > 0 && <div>
                <span id="other-credit" className="text-sm text-muted-foreground">Unallocated, other currencies</span>
                <ul aria-labelledby="other-credit" className="mt-1 space-y-0.5 text-right text-sm">
                  {otherCredit.map(({ code, money, counted }) => <li key={code}><span className="whitespace-nowrap font-mono font-semibold">{money}</span> <span className="ml-1 whitespace-nowrap text-muted-foreground">({counted})</span></li>)}
                </ul>
              </div>}
              <p className="text-[11px] text-muted-foreground">{String(position?.note || 'Calculated from instalments and payments. Valo Pay 1 never holds money.')}</p>
            </div>
          </div>
        </div>
      </div>

      {requestedRecord && <section id={`record-${requestedRecord}`} tabIndex={-1} aria-label="Selected collection record" className="scroll-mt-6 rounded-xl border border-primary/30 bg-secondary/30 p-5">
        <h2 className="font-semibold">{focusedRecord ? `Selected ${recordKindName(focusedRecord.kind).toLowerCase()}` : 'Record not found'}</h2>
        {focusedRecord ? <>
          <p className="mt-2 font-medium">{focusedRecord.name} · {focusedRecord.reference}</p>
          <p className="mt-1 text-sm">{formatRecordMoney(focusedRecord, focusedRecord.amountKobo)} · {readableLabel(focusedRecord.status)} · {formatDate(focusedRecord.createdAt)}</p>
          {focusedRecord.data?.failureCode ? <p className="mt-2 text-sm">Failure reason: {readableLabel(focusedRecord.data.failureCode)}</p> : null}
          {focusedRecord.kind === 'due-items' && <p className="mt-2 text-sm">Outstanding: {formatKobo(Number(focusedRecord.data?.outstandingKobo ?? focusedRecord.amountKobo))} · Due: {watStamp(focusedRecord.data?.dueDate)}</p>}
          <p className="mt-2 text-xs text-muted-foreground">Review this customer’s records below before you decide the next step.</p>
        </> : <p className="mt-2 text-sm">This record was not found in this customer’s history. Go back to the page you came from and refresh it.</p>}
      </section>}

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-6 items-start">
        <div className="xl:col-span-2 space-y-6">
          {/* Active Mandates */}
          <section className="bg-card border rounded-xl shadow-sm overflow-hidden">
            <div className="p-4 border-b bg-secondary/20 flex items-center gap-2">
              <FileText className="h-5 w-5 text-primary" />
              <h2 className="font-semibold">Mandates</h2>
            </div>
            <div className="divide-y">
              {mandates.length === 0 ? (
                <EmptyState title="No mandates for this customer">A mandate is a customer’s permission for recurring bank debits. This customer’s mandates appear here after they are added or imported.</EmptyState>
              ) : (
                mandates.map(mandate => (
                  <div key={mandate.id} className="p-4">
                    <div className="flex justify-between items-start mb-2">
                      <div>
                        <p className="font-medium font-mono text-sm" title={mandate.id}>{mandate.reference}</p>
                        <p className="text-xs text-muted-foreground">Debit limit: {formatKobo(mandate.amountKobo)}</p>
                      </div>
                      <StatusBadge status={mandate.status} />
                    </div>
                  </div>
                ))
              )}
            </div>
            {timeline.totals.mandates > 25 && <RecordPagination pagination={mandatePage} total={timeline.totals.mandates} busy={isPlaceholderData} label="customer mandates" />}
          </section>

          {/* Due Items & Payments */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-1 gap-6">
            <section className="bg-card border rounded-xl shadow-sm overflow-hidden">
              <div className="p-4 border-b bg-secondary/20 flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-warning-strong" />
                <h2 className="font-semibold">Instalments</h2>
              </div>
              <div className="divide-y">
                {dueItems.length === 0 ? (
                  <EmptyState title="No instalments recorded">Import this customer’s instalments on Collections to see their amounts and due dates here.</EmptyState>
                ) : (
                  dueItems.map(item => (
                    <div key={item.id} className="p-4">
                      <div className="flex justify-between items-baseline mb-1">
                        <span className="font-mono text-sm">{item.reference}</span>
                        <span className="font-mono font-medium text-destructive">{formatKobo(item.amountKobo)}</span>
                      </div>
                      <div className="flex justify-between items-center mt-2">
                        <span className="text-xs text-muted-foreground">Due: {formatCompactDate(String(item.data?.dueDate || item.createdAt))}</span>
                        <StatusBadge status={item.status} />
                      </div>
                    </div>
                  ))
                )}
              </div>
              {timeline.totals.dueItems > 25 && <RecordPagination pagination={duePage} total={timeline.totals.dueItems} busy={isPlaceholderData} label="customer instalments" />}
            </section>

            <section className="bg-card border rounded-xl shadow-sm overflow-hidden">
              <div className="p-4 border-b bg-secondary/20 flex items-center gap-2">
                <CheckCircle className="h-5 w-5 text-success" />
                <h2 className="font-semibold">Payments</h2>
              </div>
              <div className="divide-y">
                {payments.length === 0 ? (
                  <EmptyState title="No payments recorded">Payments appear here when they are linked to this customer.</EmptyState>
                ) : (
                  payments.map(payment => (
                    <div key={payment.id} className="p-4">
                      <div className="flex justify-between items-baseline mb-1">
                        <span className="font-mono text-sm">{payment.reference}</span>
                        <span className="font-mono font-medium text-success">{formatRecordMoney(payment, payment.amountKobo)}</span>
                      </div>
                      <div className="flex justify-between items-center mt-2">
                        <span className="text-xs text-muted-foreground">{formatCompactDate(payment.createdAt)}</span>
                        <StatusBadge status={payment.status} />
                      </div>
                    </div>
                  ))
                )}
              </div>
              {timeline.totals.payments > 25 && <RecordPagination pagination={paymentPage} total={timeline.totals.payments} busy={isPlaceholderData} label="customer payments" />}
            </section>
          </div>
        </div>

        {/* Timeline Log */}
        <div className="bg-card border rounded-xl shadow-sm overflow-hidden flex flex-col xl:col-span-3">
          <div className="p-5 border-b flex items-center gap-3 shrink-0">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-secondary"><Clock className="h-4 w-4 text-primary" /></span>
            <div>
              <h2 className="font-semibold">Customer history</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{formatCount(timeline.totals.events, 'event')} in the full history</p>
            </div>
          </div>
          <ScrollFrame label="Customer history" className="p-5 sm:p-6 overflow-y-auto max-h-[720px] space-y-4">
            {events.length === 0 ? (
              <EmptyState title="No events recorded yet" className="px-0">Consent, mandate changes, collection attempts, customer notices and payments appear here as they happen.</EmptyState>
            ) : (
              <ol className="relative border-l border-border ml-2 space-y-7">
                {events.map(event => (
                  <li key={event.id} className="relative pl-6">
                    <span aria-hidden="true" className="absolute -left-[5px] top-1 h-2.5 w-2.5 rounded-full bg-brand ring-4 ring-card" />
                    <div className="flex flex-col items-start">
                      <time dateTime={event.createdAt} className="text-[11px] text-muted-foreground mb-1.5">{formatDate(event.createdAt)}</time>
                      <span className="text-sm font-semibold" title={event.id}>{event.name || recordKindName(event.kind)}</span>
                      {event.amountKobo > 0 && (
                        <span className="text-sm font-mono mt-1">{formatRecordMoney(event, event.amountKobo)}</span>
                      )}
                      {event.kind === 'retry-decisions' && (
                        <span className="text-xs leading-relaxed text-muted-foreground mt-2">{decisionDetail((event.data || {}) as Record<string, any>)}</span>
                      )}
                      {event.kind === 'allocations' && (
                        <span className="text-xs leading-relaxed text-muted-foreground mt-2">{allocationDetail((event.data || {}) as Record<string, any>)}</span>
                      )}
                      <span className="mt-2"><StatusBadge status={event.status} /></span>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </ScrollFrame>
          {timeline.totals.events > 25 && <RecordPagination pagination={historyPage} total={timeline.totals.events} busy={isPlaceholderData} label="history events" />}
        </div>
      </div>
    </div>
  );
}
