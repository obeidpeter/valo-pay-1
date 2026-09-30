import { QueueSearch } from '@/components/queue-search';
import { QueueFreshness } from '@/components/queue-freshness';
import { useSafePerformAction as usePerformAction } from '@/lib/safe-mutations';
import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import { ScrollFrame } from '@/components/scroll-frame';
import { EmptyRow } from '@/components/empty-state';
import { LoadingRow } from '@/components/loading';
import { useWorkspace } from '@/lib/workspace-context';
import { useListRecords, getListRecordsQueryKey } from '@workspace/api-client-react';
import { formatKobo, formatDate, formatCount, formatNumber, formatPercent } from '@/lib/formatters';
import { CheckSquare, Info, ShieldAlert, CornerUpLeft, Plus, ClipboardCheck, RefreshCw } from 'lucide-react';
import { PermissionButton as Button } from '@/components/permission-button';
import { RecordDialog } from '@/components/record-dialog';
import { RecordLabel, StatusBadge, readableLabel } from '@/components/record-label';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useSearch } from 'wouter';
import { nairaToKobo } from '@/lib/money-input';
import { notifyDone, saidBy } from '@/lib/notify';
import { useHashTarget } from '@/lib/use-hash-target';
import { safeCollectionReturnTo } from '@/lib/record-navigation';
import { RecordPagination, usePageProblemFocus } from '@/components/record-pagination';
import { useUrlPagination } from '@/lib/use-url-pagination';
import { keepRowsWhilePaging, searchWithoutSubmitting, useDebouncedSearch } from '@/lib/use-record-pagination';
import { useReconciliationPage } from '@/lib/use-reconciliation-page';
import { LoadProblem } from '@/components/load-problem';
import { KEPT_IN_OPERATIONS, OpenOperations } from '@/components/pilot-ui';
import { hasFeeSchedule, paymentUnappliedKobo } from '@workspace/valopay-schema';
import { formatRecordMoney as moneyOf } from '@/lib/currencies';
import { permissionReason } from '@/lib/permissions';

const paymentAvailable = (record: any): number => paymentUnappliedKobo(record);
const instalmentOutstanding = (record: any): number => Math.max(0, Number(record?.data?.outstandingKobo ?? record?.amountKobo ?? 0));

/** A table whose rows could not be loaded (Refresh queue tries again); after a press of its pager, `pager`, it takes the pager's focus. */
function TableProblem({ colSpan, pager, children }: { colSpan: number; pager: string; children: ReactNode }) {
  const notice = useRef<HTMLParagraphElement>(null);
  usePageProblemFocus(notice, pager);
  return <tr><td colSpan={colSpan} className="p-5"><p ref={notice} role="alert" className="text-sm text-destructive">{children}</p></td></tr>;
}

function MatchEvidence({ allocation, payment, instalment, customer, decision }: { allocation: any; payment: any; instalment: any; customer?: any; decision: string }) {
  const available = paymentAvailable(payment), outstanding = instalmentOutstanding(instalment);
  const payerToConfirm = !!payment && !payment.customerId;
  return (
    <section aria-label="Match evidence" className="space-y-3 rounded-lg border bg-secondary/20 p-3 text-sm">
      <div><p className="font-semibold">{customer?.name || 'Customer details unavailable'}</p><p className="mt-1 font-mono text-xs">{customer?.reference || 'Check the linked records before recording a decision.'}</p></div>
      {payerToConfirm && <p className="rounded-md border border-warning-border bg-warning p-2 text-warning-foreground">The payment evidence does not name a payer. {decision === 'confirm_allocation' ? `If you confirm, ${customer?.name || `the customer of instalment ${instalment?.reference || ''}`.trim()} is recorded as the payer, with your reason.` : 'If you reject, the payment stays unallocated and without a payer until Finance allocates it.'}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border bg-card p-3">
          <h3 className="font-semibold">Recorded payment</h3>
          <p className="mt-1 break-words font-mono text-xs">{payment?.reference || 'Payment details unavailable'}</p>
          <p className="mt-2">Received: <strong>{payment ? moneyOf(payment, payment.amountKobo) : 'Not available'}</strong></p>
          <p className="text-xs text-muted-foreground">{payment ? formatDate(String(payment.data?.observedAt || payment.createdAt)) : 'Reload to check this payment.'}</p>
          <p className="mt-2">Unallocated: {payment ? moneyOf(payment, available) : 'Not available'}</p>
          <dl className="mt-3 space-y-1 text-xs"><div><dt className="inline text-muted-foreground">Collection result: </dt><dd className="inline">{payment?.data?.collectionStatus ? readableLabel(payment.data.collectionStatus) : 'Not recorded'}</dd></div><div><dt className="inline text-muted-foreground">Settlement: </dt><dd className="inline">{payment?.data?.settlementStatus ? readableLabel(payment.data.settlementStatus) : 'Not recorded'}</dd></div><div><dt className="inline text-muted-foreground">Provider reference: </dt><dd className="inline break-all">{String(payment?.data?.providerReference || payment?.reference || 'Not recorded')}</dd></div></dl>
        </div>
        <div className="rounded-md border bg-card p-3">
          <h3 className="font-semibold">Instalment</h3>
          <p className="mt-1 break-words font-mono text-xs">{instalment?.reference || 'Instalment details unavailable'}</p>
          <p className="mt-2">Outstanding: <strong>{instalment ? formatKobo(outstanding) : 'Not available'}</strong></p>
          <p className="text-xs text-muted-foreground">Due: {formatDate(String(instalment?.data?.dueDate || ''))}</p>
        </div>
      </div>
      <p><strong>Matching evidence:</strong> {String(allocation.data?.explanation || 'No explanation was recorded. Check the payment and instalment before you decide.')}</p>
      <p className="text-xs text-muted-foreground">Rule: {String(allocation.data?.rule || 'Not recorded')} · Confidence: {allocation.data?.confidence ? readableLabel(allocation.data.confidence) : 'Not recorded'}</p>
      <p className="text-xs text-muted-foreground">Allocating puts the full payment amount against the instalment. Provider fees are checked separately in settlement batches and do not reduce this amount.</p>
      {decision === 'confirm_allocation' ? <>
        <p>Confirming allocates <strong>{formatKobo(allocation.amountKobo)}</strong> to this instalment.</p>
        {payment && instalment && allocation.amountKobo <= available && allocation.amountKobo <= outstanding && <p className="text-xs text-muted-foreground">After confirmation: {formatKobo(available - allocation.amountKobo)} of the payment unallocated; {formatKobo(outstanding - allocation.amountKobo)} outstanding on the instalment.</p>}
      </> : decision === 'reject_allocation' ? <p>Rejecting removes this match. The payment stays unallocated for Finance to allocate.</p> : decision === 'review_correct' ? <p>Marking this match correct keeps its allocation and saves your review and reason in the audit log.</p> : <div className="rounded-md border border-warning-border bg-warning p-3 text-warning-foreground"><p className="font-semibold">This corrects the allocation</p><p className="mt-1">Marking the match incorrect removes its {formatKobo(allocation.amountKobo)} allocation and reopens the payment and instalment for review. This does not refund or move money.</p>{payment && instalment && <p className="mt-2">After correction: {formatKobo(Math.min(payment.amountKobo, available + allocation.amountKobo))} of the payment unallocated; {formatKobo(Math.min(instalment.amountKobo, outstanding + allocation.amountKobo))} outstanding on the instalment.</p>}</div>}
    </section>
  );
}

export default function ReconciliationPage() {
  const { merchantId, workspace } = useWorkspace();
  const [selectedRecord, setSelectedRecord] = useState<any>(null);
  const [actionKind, setActionKind] = useState<string>('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [reviewCorrect, setReviewCorrect] = useState(true);
  const [runResult, setRunResult] = useState<Record<string, any> | null>(null);
  const currentMerchant = useRef(merchantId);
  currentMerchant.current = merchantId;
  const runRequest = useRef(0);
  const queryClient = useQueryClient();
  const search = useSearch();
  const searchParams = new URLSearchParams(search);
  const q = searchParams.get('q')?.trim();
  const searchHref = (view:string) => {const next=new URLSearchParams(searchParams);if(view==='all')next.delete('view');else next.set('view',view);return '/reconciliation?'+next;};
  const requestedView = searchParams.get('view');
  const requestedDueId = searchParams.get('dueItem');
  const sameLender = !searchParams.get('lender') || searchParams.get('lender') === merchantId;
  const returnTo = safeCollectionReturnTo(searchParams.get('returnTo'), merchantId);
  const view = requestedView === 'review' || requestedView === 'duplicates' ? requestedView : 'all';
  const focus = requestedDueId ? sameLender ? requestedDueId : 'unavailable' : undefined;
  const proposalsQuery=useReconciliationPage('proposals',focus), allPaymentsQuery=useReconciliationPage('duplicates',focus), paymentsQuery=useReconciliationPage('payments',focus), observationsQuery=useReconciliationPage('observations',focus), confirmedAllocationsQuery=useReconciliationPage('audit'), batchesQuery=useReconciliationPage('batches');
  const {data:proposals,isLoading:isLoadingProposals,error:proposalsError,pagination:proposalPage}=proposalsQuery;
  const {data:allPayments,isLoading:isLoadingAllPayments,error:allPaymentsError,pagination:duplicatePage}=allPaymentsQuery;
  const {data:payments,isLoading:isLoadingPayments,error:paymentsError,pagination:paymentPage}=paymentsQuery;
  const {data:observations,isLoading:isLoadingObs,error:observationsError,pagination:observationPage}=observationsQuery;
  const {data:confirmedAllocations,isLoading:isLoadingAudit,error:auditError,pagination:auditPage}=confirmedAllocationsQuery;
  const {data:batches,isLoading:isLoadingBatches,error:batchesError,pagination:batchPage}=batchesQuery;
  const [allocationSearch,setAllocationSearch]=useState('');
  // Each opening of the picker starts from an empty search, never the last one typed.
  const [allocationSession,setAllocationSession]=useState(0);
  const {search:allocationTerm,searchPending:allocationSearchPending}=useDebouncedSearch(allocationSearch,`${merchantId}:${allocationSession}`);
  const choicePage=useUrlPagination(merchantId,'allocation-');
  // The server lists only the instalments a manual allocation of this payment accepts (paymentId): its payer's, or, when its evidence names an
  // instalment but no payer, that instalment's customer's; one that names neither offers every instalment, and choosing one identifies the payer.
  // So the pager counts exactly the choices it offers.
  const choiceParams={merchantId:merchantId!,search:allocationTerm,limit:choicePage.pageSize,offset:choicePage.offset,allocatable:'true' as const,...(actionKind==='manual_allocate'&&selectedRecord?.id?{paymentId:String(selectedRecord.id)}:{})};
  // Paging keeps the choices shown, and so the pager and the control pressed, until the next page arrives.
  const choicesKey=getListRecordsQueryKey('due-items',choiceParams);
  const choicesQuery=useListRecords('due-items',choiceParams,{query:{enabled:!!merchantId && isDialogOpen && actionKind==='manual_allocate' && !allocationSearchPending,queryKey:choicesKey,placeholderData:keepRowsWhilePaging(choicesKey,queryClient)}});
  const rows=[...(proposals?.related||[]),...(payments?.related||[]),...(allPayments?.related||[]),...(observations?.related||[]),...(confirmedAllocations?.related||[])];
  const customerById=new Map(rows.filter(r=>r.kind==='customers').map(r=>[r.id,r]));
  const paymentById=new Map(rows.filter(r=>r.kind==='payments').map(r=>[r.id,r]));
  const dueItems=proposals ? {items:[...rows.filter(r=>r.kind==='due-items'),...(choicesQuery.data?.items||[])]} : undefined;
  const dueItemById=new Map(dueItems?.items.map(r=>[r.id,r]));
  const dueItemsError=proposalsError,refetchDueItems=proposalsQuery.refetch;
  const focusedDue=focus?dueItemById.get(focus):undefined;
  const proposalRows=proposals?.items||[],duplicates=allPayments?.items||[],paymentRows=payments?.items||[],observationRows=observations?.items||[],auditSample=confirmedAllocations?.items||[];
  const precision=confirmedAllocations?.precision as Record<string,any>|undefined;
  useHashTarget('record-'+requestedDueId,!!focusedDue && !dueItemsError);
  useHashTarget('precision-audit',!!merchantId && view==='all' && !!confirmedAllocations && !isLoadingAudit && !auditError);

  const runRecon = usePerformAction(undefined, merchantId);
  useEffect(() => { runRequest.current += 1; setRunResult(null); runRecon.reset(); setIsDialogOpen(false); return () => { runRequest.current += 1; }; }, [merchantId]);
  const runReconciliation = async () => {
    if (!merchantId) return;
    const request = ++runRequest.current;
    setRunResult(null);
    try {
      const response = await runRecon.mutateAsync({ data: { action: 'run_reconciliation' }, params: { merchantId } });
      // Reconciliation changes all these records together, even if the user has since switched lender.
      await queryClient.invalidateQueries();
      if (currentMerchant.current === merchantId && runRequest.current === request) setRunResult(response);
    } catch { /* The mutation's inline error offers a retry in the current view. */ }
  };

  const handleAction = (record: any, action: string) => {
    if (action === 'manual_allocate') { setAllocationSearch(''); setAllocationSession(session => session + 1); choicePage.resetPage(); }
    setSelectedRecord(record);
    setActionKind(action);
    setIsDialogOpen(true);
  };

  const reviewAllocation = (allocation: any, correct: boolean) => {setReviewCorrect(correct);handleAction(allocation,'review_allocation');};
  const handleCreateBatch = () => {
    setSelectedRecord(null);
    setActionKind('create_batch');
    setIsDialogOpen(true);
  };

  if (!merchantId) return null;
  const isProposalDecision = actionKind === 'confirm_allocation' || actionKind === 'reject_allocation';
  const isAllocationReview = actionKind === 'review_allocation';
  const selectedPayment = isProposalDecision || isAllocationReview ? paymentById.get(String(selectedRecord?.data?.paymentId)) : selectedRecord;
  // A payment with no payer whose evidence names an instalment takes only that instalment's customer's instalments; the
  // page has the instalment and its customer (a named instalment that does not exist leaves every customer's offered).
  const namedInstalment = !selectedRecord?.customerId && selectedRecord?.data?.dueItemId ? dueItemById.get(String(selectedRecord.data.dueItemId)) : undefined;
  const namedCustomer = namedInstalment ? customerById.get(String(namedInstalment.customerId)) : undefined;
  const selectedInstalment = isProposalDecision || isAllocationReview ? dueItemById.get(String(selectedRecord?.data?.dueItemId)) : null;

  return (
    <div className="space-y-6">
      {returnTo && <Link href={returnTo} className="inline-flex min-h-9 items-center gap-2 text-sm text-primary print:hidden">Back to Collections</Link>}
      {requestedDueId && <section id={`record-${requestedDueId}`} tabIndex={-1} aria-label="Selected instalment" className="scroll-mt-6 rounded-xl border border-primary/30 bg-secondary/30 p-5">
        {!sameLender ? <p role="alert">This link belongs to a different lender. Select that lender to review its instalment.</p> : dueItemsError ? <LoadProblem what="the selected instalment" error={dueItemsError} retry={() => { void refetchDueItems(); }} /> : !dueItems ? <p role="status">Loading the selected instalment…</p> : focusedDue ? <>
          <h2 className="font-semibold">{focusedDue.name}</h2>
          <p className="mt-1 text-xs font-mono">{focusedDue.reference}</p>
          <p className="mt-2 text-sm">Outstanding: <strong>{formatKobo(instalmentOutstanding(focusedDue))}</strong> · Due: {formatDate(String(focusedDue.data?.dueDate || ''))}</p>
          <p className="mt-2 text-sm">This shows matches to review for this instalment, and unallocated payments and payment evidence for this customer. There may be no matches yet.</p>
          <p className="mt-1 text-xs text-muted-foreground">Running reconciliation still checks all records for the selected lender.</p>
        </> : <p role="alert">Instalment not found. It may have been deleted, or it belongs to another lender. Go back to Collections and select Refresh queue.</p>}
      </section>}
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Reconciliation</h1>
          <p className="text-muted-foreground mt-1">Review the matches reconciliation finds, and allocate the payments it could not match.</p>
        </div>
        <div className="flex items-center gap-3">
          <Button 
            action="run_reconciliation" onClick={() => { void runReconciliation(); }}
            busy={runRecon.isPending}
            busyLabel="Running reconciliation…"
            className="gap-2 bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            <RefreshCw className="h-4 w-4" /> Run reconciliation
          </Button>
        </div>
      </header>
      <QueueSearch label="Search reconciliation" placeholder="Customer, payment or instalment reference" help="Your current view and instalment still apply. Match accuracy figures always cover the full sample." pagePrefixes={['proposals-','duplicates-','payments-','observations-','audit-','batches-']} />

      <QueueFreshness key={merchantId} queries={[allPaymentsQuery, confirmedAllocationsQuery, paymentsQuery, proposalsQuery, observationsQuery, batchesQuery]} />

      {runRecon.error && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
        <p className="font-semibold text-destructive">Reconciliation not completed</p>
        <p className="mt-1">{saidBy(runRecon.error, 'Valo Pay could not finish this check.')} Select Run reconciliation to try again.{runRecon.hasUnconfirmedOutcome && <> {KEPT_IN_OPERATIONS}</>}</p>
        {runRecon.hasUnconfirmedOutcome && <OpenOperations />}
      </div>}
      {runResult && <section role="status" aria-label="Reconciliation result" className="rounded-lg border border-success/30 bg-success/5 p-4 text-sm">
        <p className="font-semibold">Reconciliation complete</p>
        <p className="mt-1 text-muted-foreground">Payment evidence checked. No money moved.</p>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ['Evidence matched', runResult.data?.observationsResolved], ['Matches to review', runResult.data?.proposed],
            ['Unallocated payments', runResult.data?.unallocated], ['Possible duplicates', runResult.data?.possibleDuplicates],
          ].map(([label, count]) => <div key={String(label)}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{formatNumber(Number(count || 0))}</dd></div>)}
        </dl>
      </section>}

      <nav aria-label="Reconciliation views" className="flex flex-wrap gap-2 print:hidden">
        {[
          { key: 'all', label: 'All sections', href: '/reconciliation' },
          { key: 'review', label: 'Matches to review', href: '/reconciliation?view=review' },
          { key: 'duplicates', label: 'Possible duplicates', href: '/reconciliation?view=duplicates' },
        ].map(item => <Button key={item.key} asChild size="sm" variant={view === item.key ? 'default' : 'outline'}><Link href={searchHref(item.key)} aria-current={view === item.key ? 'page' : undefined}>{item.label}</Link></Button>)}
      </nav>

      {/* Paging keeps each table's rows until the next page arrives; the frames never anchor the scroll, so the browser holds the pager in place when a page has fewer rows. */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Allocations requiring review */}
        {view !== 'duplicates' && <div className="bg-card border rounded-xl shadow-sm flex flex-col xl:col-span-2">
          <div className="p-5 border-b flex flex-wrap items-center gap-2">
            <CheckSquare className="h-5 w-5 text-warning-strong" />
            <h2 className="font-semibold">Matches to review</h2>
            <span className="ml-auto bg-warning text-warning-foreground text-xs font-bold px-2 py-1 rounded-full">
              {formatNumber(proposals?.total || 0)} to review
            </span>
          </div>
          
          <ScrollFrame label="Matches to review" className="p-0 overflow-x-auto [overflow-anchor:none]">
            <table className="min-w-[780px] w-full text-sm text-left">
              <thead className="bg-secondary/30 border-b text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Customer</th>
                  <th className="px-4 py-3 font-medium">Payment</th>
                  <th className="px-4 py-3 font-medium">Instalment</th>
                  <th className="px-4 py-3 font-medium text-right">Amount</th>
                  <th className="px-4 py-3 font-medium">Confidence and reason</th>
                  <th className="px-4 py-3 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {isLoadingProposals ? (
                  <LoadingRow colSpan={6} what="matches to review" />
                ) : proposalsError && !proposals ? (
                  <TableProblem colSpan={6} pager="matches to review">We could not load matches to review. Select Refresh queue to try again.</TableProblem>
                ) : proposalRows.length === 0 ? (
                  <EmptyRow colSpan={6} title={q ? 'No matches to review for this search' : "No matches to review"}>{q ? 'Try another name or reference, or select Clear search.' : <>Matches appear here when Finance needs to confirm them. Select Run reconciliation to look for new ones.</>}</EmptyRow>
                ) : (
                  proposalRows.map(prop => (
                    <tr key={prop.id} className="hover:bg-secondary/10">
                      <td className="px-4 py-4">{prop.customerId ? <RecordLabel record={customerById.get(String(prop.customerId))} id={prop.customerId} customer /> : <><RecordLabel record={customerById.get(String(dueItemById.get(String(prop.data?.dueItemId))?.customerId))} id={dueItemById.get(String(prop.data?.dueItemId))?.customerId} customer /><span className="mt-1 block text-xs text-muted-foreground">Payer to confirm</span></>}</td>
                      <td className="px-4 py-4 text-xs"><RecordLabel record={paymentById.get(String(prop.data?.paymentId))} id={prop.data?.paymentId} /></td>
                      <td className="px-4 py-4 text-xs"><RecordLabel record={dueItemById.get(String(prop.data?.dueItemId))} id={prop.data?.dueItemId} /></td>
                      <td className="px-4 py-3 text-right font-mono font-medium">{formatKobo(prop.amountKobo)}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-info text-info-foreground border border-info-border">
                          {prop.data?.confidence ? readableLabel(prop.data.confidence) : 'Not recorded'}
                        </span>
                        <p className="mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">{String(prop.data?.explanation || 'Check the payment and instalment before you decide.')}</p>
                      </td>
                      <td className="px-4 py-3 text-right"><div className="flex justify-end gap-2">
                        <Button 
                          size="sm" variant="outline" 
                          className="text-xs"
                          action="reject_allocation" record={prop} onClick={() => handleAction(prop, 'reject_allocation')}
                        >Reject match</Button>
                        <Button 
                          size="sm" 
                          className="text-xs bg-success hover:bg-success/90 text-success-foreground"
                          action="confirm_allocation" record={prop} payment={paymentById.get(String(prop.data?.paymentId))} instalment={dueItemById.get(String(prop.data?.dueItemId))} onClick={() => handleAction(prop, 'confirm_allocation')}
                        >Confirm match</Button>
                      </div></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </ScrollFrame>
          {!isLoadingProposals && !proposalsError && (proposals?.total || 0) > 25 && <RecordPagination pagination={proposalPage} total={proposals?.total || 0} busy={proposalsQuery.isPlaceholderData} label="matches to review" />}
        </div>}

        {view !== 'review' && <section aria-label="Possible duplicate payments" className="bg-card border rounded-xl shadow-sm overflow-hidden xl:col-span-2">
          <div className="border-b p-4"><h2 className="font-semibold">Possible duplicate payments</h2><p className="mt-1 text-xs text-muted-foreground">These payments are held for Finance review and are never allocated automatically.</p></div>
          <ScrollFrame label="Possible duplicate payments table" className="overflow-x-auto [overflow-anchor:none]">
            <table className="min-w-[650px] w-full text-left text-sm"><thead className="border-b bg-secondary/30 text-muted-foreground"><tr><th className="p-4 font-medium">Payment</th><th className="p-4 font-medium">Customer</th><th className="p-4 font-medium">Reason for review</th><th className="p-4 text-right font-medium">Amount</th><th className="p-4 text-right font-medium">Next step</th></tr></thead>
              <tbody className="divide-y">{isLoadingAllPayments ? <LoadingRow colSpan={5} what="possible duplicate payments" /> : allPaymentsError && !allPayments ? <TableProblem colSpan={5} pager="duplicate payments">We could not load possible duplicate payments. Select Refresh queue to try again.</TableProblem> : duplicates.length === 0 ? <EmptyRow colSpan={5} title={q ? 'No possible duplicates match your search' : "No possible duplicates"}>{q ? 'Try another name or reference, or select Clear search.' : <>Payments that need a duplicate check appear here.</>}</EmptyRow> : duplicates.map(payment => <tr key={payment.id}>
                <td className="p-4"><RecordLabel record={payment} id={payment.id} /></td><td className="p-4"><RecordLabel record={customerById.get(String(payment.customerId))} id={payment.customerId} customer /></td>
                <td className="p-4 text-xs text-muted-foreground">{String(payment.data?.explanation || 'Check the provider references and payment evidence before you decide whether this is a separate payment.')}</td>
                <td className="p-4 text-right font-mono">{moneyOf(payment, payment.amountKobo)}</td><td className="p-4 text-right"><Link className="inline-flex min-h-9 items-center text-xs font-medium underline underline-offset-4" href="/exceptions?type=suspected_duplicate">Review duplicate exceptions</Link></td>
              </tr>)}</tbody>
            </table>
          </ScrollFrame>
          {!isLoadingAllPayments && !allPaymentsError && (allPayments?.total || 0) > 25 && <RecordPagination pagination={duplicatePage} total={allPayments?.total || 0} busy={allPaymentsQuery.isPlaceholderData} label="duplicate payments" />}
        </section>}

        {view === 'all' && <>

        {/* Unallocated Payments */}
        <div className="bg-card border rounded-xl shadow-sm flex flex-col">
          <div className="p-4 border-b bg-secondary/20 flex items-center gap-2">
            <Info className="h-5 w-5 text-info-strong" />
            <h2 className="font-semibold">Unallocated payments</h2>
            <span className="ml-auto bg-info text-info-foreground text-xs font-bold px-2 py-1 rounded-full">
              {formatCount(payments?.total || 0, 'payment')}
            </span>
          </div>
          <ScrollFrame label="Unallocated payments" className="p-0 overflow-auto max-h-[400px] [overflow-anchor:none]">
            <table className="min-w-[460px] w-full text-sm text-left">
              <thead className="bg-secondary/30 border-b text-muted-foreground sticky top-0">
                <tr>
                  <th className="px-4 py-2 font-medium">Reference</th>
                  <th className="px-4 py-2 font-medium text-right">Amount</th>
                  <th className="px-4 py-2 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {isLoadingPayments ? (
                  <LoadingRow colSpan={3} what="unallocated payments" />
                ) : paymentsError && !payments ? (
                  <TableProblem colSpan={3} pager="unallocated payments">We could not load unallocated payments. Select Refresh queue to try again.</TableProblem>
                ) : paymentRows.length === 0 ? (
                  <EmptyRow colSpan={3} title={q ? 'No unallocated payments match your search' : "No unallocated payments"}>{q ? 'Try another name or reference, or select Clear search.' : <>Payments appear here while some of their money is not allocated to an instalment, including what is left of a partly allocated payment. None are waiting now.</>}</EmptyRow>
                ) : (
                  paymentRows.map(pay => (
                    <tr key={pay.id} className="hover:bg-secondary/10">
                      <td className="px-4 py-2 font-mono text-xs">
                        {pay.reference}
                        <div className="text-muted-foreground">{formatDate(pay.createdAt)}</div>
                      </td>
                      <td className="px-4 py-2 text-right font-mono font-medium">{moneyOf(pay, pay.amountKobo)}{paymentAvailable(pay) !== pay.amountKobo && <div className="text-xs font-normal text-muted-foreground">{moneyOf(pay, paymentAvailable(pay))} unallocated</div>}</td>
                      <td className="px-4 py-2 text-right space-x-2 flex justify-end items-center">
                        <Button size="sm" variant="outline" className="h-7 text-xs" action="manual_allocate" record={pay} onClick={() => handleAction(pay, 'manual_allocate')}>Allocate payment</Button>
                        <Button size="sm" variant="outline" className="h-8 gap-1 text-xs" action="record_refund" record={pay} onClick={() => handleAction(pay, 'record_refund')} aria-label={`Record refund for ${pay.reference}`}>
                          <CornerUpLeft aria-hidden="true" className="h-3 w-3" />Record refund
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </ScrollFrame>
          {!isLoadingPayments && !paymentsError && (payments?.total || 0) > 25 && <RecordPagination pagination={paymentPage} total={payments?.total || 0} busy={paymentsQuery.isPlaceholderData} label="unallocated payments" />}
        </div>

        {/* Unresolved Observations */}
        <div className="bg-card border rounded-xl shadow-sm flex flex-col">
          <div className="p-4 border-b bg-secondary/20 flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-destructive" />
            <h2 className="font-semibold">Unresolved payment evidence</h2>
            <span className="ml-auto bg-destructive/10 text-destructive text-xs font-bold px-2 py-1 rounded-full">
              {formatCount(observations?.total || 0, 'record')}
            </span>
          </div>
          <ScrollFrame label="Unresolved payment evidence" className="p-0 overflow-auto max-h-[400px] [overflow-anchor:none]">
             <table className="min-w-[440px] w-full text-sm text-left">
              <thead className="bg-secondary/30 border-b text-muted-foreground sticky top-0">
                <tr>
                  <th className="px-4 py-2 font-medium">Source</th>
                  <th className="px-4 py-2 font-medium">Reference</th>
                  <th className="px-4 py-2 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {isLoadingObs ? (
                  <LoadingRow colSpan={3} what="unresolved payment evidence" />
                ) : observationsError && !observations ? (
                  <TableProblem colSpan={3} pager="payment evidence">We could not load payment evidence. Select Refresh queue to try again.</TableProblem>
                ) : observationRows.length === 0 ? (
                  <EmptyRow colSpan={3} title={q ? 'No payment evidence matches your search' : "No unresolved payment evidence"}>{q ? 'Try another name or reference, or select Clear search.' : <>Provider notifications and bank statement lines appear here when they cannot be linked to a payment or settlement batch.</>}</EmptyRow>
                ) : (
                  observationRows.map(obs => (
                    <tr key={obs.id} className="hover:bg-secondary/10">
                      <td className="px-4 py-2">
                        <span className="px-1.5 py-0.5 bg-secondary text-xs rounded border">{readableLabel(obs.data?.source)}</span>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs truncate max-w-[120px]" title={obs.reference}>{obs.reference}</td>
                      <td className="px-4 py-2 text-right font-mono font-medium">{moneyOf(obs, obs.amountKobo)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </ScrollFrame>
          {!isLoadingObs && !observationsError && (observations?.total || 0) > 25 && <RecordPagination pagination={observationPage} total={observations?.total || 0} busy={observationsQuery.isPlaceholderData} label="payment evidence" />}
        </div>
        
        {/* Precision audit */}
        {!requestedDueId && <>
        <div id="precision-audit" tabIndex={-1} role="region" aria-label="Match accuracy review" className="scroll-mt-6 bg-card border rounded-xl shadow-sm flex flex-col xl:col-span-2">
          <div className="p-5 border-b flex flex-wrap items-start gap-2">
            <ClipboardCheck className="h-5 w-5 text-primary" />
            <h2 className="font-semibold">Match accuracy review</h2>
            <p className="w-full text-xs leading-relaxed text-muted-foreground">Finance checks a sample of last month’s automatic matches. Marking a match incorrect removes its allocation and reopens the payment and instalment.</p>
            <p className="text-xs font-medium">{formatNumber(Number(precision?.reviewed || 0))} of {formatCount(Number(precision?.sampleSize || 0), 'sample match', 'sample matches')} checked.{precision?.falseMatchRate !== null && precision?.falseMatchRate !== undefined ? ` Incorrect match rate: ${formatPercent(Number(precision.falseMatchRate), 1)}. The true rate is likely between ${formatPercent(Number(precision.interval?.low), 1)} and ${formatPercent(Number(precision.interval?.high), 1)} (95% confidence interval).` : ''}</p>
          </div>
          <ScrollFrame label="Match accuracy review table" className="p-0 overflow-x-auto max-h-[400px] [overflow-anchor:none]">
            <table className="min-w-[780px] w-full text-sm text-left">
              <thead className="bg-secondary/30 border-b text-muted-foreground sticky top-0">
                <tr>
                  <th className="px-4 py-2 font-medium">Rule</th>
                  <th className="px-4 py-2 font-medium">Payment</th>
                  <th className="px-4 py-2 font-medium">Instalment</th>
                  <th className="px-4 py-2 font-medium text-right">Amount</th>
                  <th className="px-4 py-2 font-medium">Explanation</th>
                  <th className="px-4 py-2 font-medium">Review</th>
                  <th className="px-4 py-2 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {isLoadingAudit ? (
                  <LoadingRow colSpan={7} what="the match review sample" />
                ) : auditError && !confirmedAllocations ? (
                  <TableProblem colSpan={7} pager="sampled matches">We could not load the match review sample. Select Refresh queue to try again.</TableProblem>
                ) : auditSample.length === 0 ? (
                  <EmptyRow colSpan={7} title={q ? 'No sample matches for this search' : "No automatic matches to review yet"}>{q ? 'Try another name or reference, or select Clear search.' : <>Each daily close picks a sample of last month’s automatic matches rated Certain. Finance then checks whether they are correct.</>}</EmptyRow>
                ) : (
                  auditSample.map(allocation => (
                    <tr key={allocation.id} className="hover:bg-secondary/10">
                      <td className="px-4 py-2 font-mono text-xs">{String(allocation.data?.rule || '')}</td>
                      <td className="px-4 py-3 text-xs"><RecordLabel record={paymentById.get(String(allocation.data?.paymentId))} id={allocation.data?.paymentId} /></td>
                      <td className="px-4 py-3 text-xs"><RecordLabel record={dueItemById.get(String(allocation.data?.dueItemId))} id={allocation.data?.dueItemId} /></td>
                      <td className="px-4 py-2 text-right font-mono font-medium">{formatKobo(allocation.amountKobo)}</td>
                      <td className="px-4 py-2 text-xs text-muted-foreground max-w-[280px]">{String(allocation.data?.explanation || '')}</td>
                      <td className="px-4 py-2 text-xs">
                        {allocation.data?.reviewed === true ? <span className="text-success font-medium">Correct</span> : allocation.data?.reviewed === false ? <span className="text-destructive font-medium">Incorrect</span> : <span className="text-muted-foreground">Not reviewed</span>}
                      </td>
                      <td className="px-4 py-2 text-right space-x-2">
                        <Button size="sm" variant="outline" className="h-7 text-xs" action="review_allocation" onClick={() => reviewAllocation(allocation, true)}>Mark match correct</Button>
                        <Button size="sm" variant="outline" className="h-7 text-xs text-destructive" action="review_allocation" onClick={() => reviewAllocation(allocation, false)}>Mark match incorrect</Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </ScrollFrame>
          {!isLoadingAudit && !auditError && (confirmedAllocations?.total || 0) > 25 && <RecordPagination pagination={auditPage} total={confirmedAllocations?.total || 0} busy={confirmedAllocationsQuery.isPlaceholderData} label="sampled matches" />}
        </div>

        {/* Settlement Batches */}
        <div className="bg-card border rounded-xl shadow-sm flex flex-col xl:col-span-2">
          <div className="p-4 border-b bg-secondary/20 flex items-center justify-between">
            <h2 className="font-semibold flex items-center gap-2"><Info className="h-5 w-5 text-primary" /> Settlement batches</h2>
            <Button size="sm" kind="settlement-batches" onClick={handleCreateBatch}><Plus className="h-4 w-4 mr-2" /> Add settlement batch</Button>
          </div>
          <ScrollFrame label="Settlement batches" className="p-0 overflow-x-auto max-h-[400px] [overflow-anchor:none]">
             <table className="min-w-[650px] w-full text-sm text-left">
              <thead className="bg-secondary/30 border-b text-muted-foreground sticky top-0">
                <tr>
                  <th className="px-4 py-2 font-medium">Provider</th>
                  <th className="px-4 py-2 font-medium">Batch reference</th>
                  <th className="px-4 py-2 font-medium text-right">Before fees</th>
                  <th className="px-4 py-2 font-medium text-right">Fee</th>
                  <th className="px-4 py-2 font-medium text-right">After fees</th>
                  <th className="px-4 py-2 font-medium text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {isLoadingBatches ? (
                  <LoadingRow colSpan={6} what="settlement batches" />
                ) : batchesError && !batches ? (
                  <TableProblem colSpan={6} pager="settlement batches">We could not load settlement batches. Select Refresh queue to try again.</TableProblem>
                ) : !batches || batches.items.length === 0 ? (
                  <EmptyRow colSpan={6} title={q ? 'No settlement batches match your search' : "No settlement batches yet"}>{q ? 'Try another name or reference, or select Clear search.' : <>A batch groups the payments in one provider settlement report. Select Add settlement batch, or import a settlement report.</>}</EmptyRow>
                ) : (
                  batches.items.map(b => {
                    // Each batch in its own currency; fees are checked only where a fee schedule exists for it.
                    const currency = String(b.data?.currency || 'NGN'), apart = Array.isArray(b.data?.otherCurrencyLineIds) ? b.data.otherCurrencyLineIds.length : 0;
                    return <tr key={b.id} className="hover:bg-secondary/10">
                      <td className="px-4 py-2 font-medium">{String(b.data?.provider || 'Not recorded')}</td>
                      <td className="px-4 py-2"><Button variant="link" type="button" className="min-h-9 font-mono text-xs underline underline-offset-4 hover:text-primary" action="edit_batch" record={b} onClick={() => handleAction(b, 'edit_batch')} aria-label={`Edit settlement batch ${String(b.data?.batchReference || b.reference)}`}>{String(b.data?.batchReference || b.reference)}</Button><span className="hidden print:inline font-mono text-xs">{String(b.data?.batchReference || b.reference)}</span>{apart > 0 && <span className="block text-xs text-muted-foreground">{formatCount(apart, 'line')} in another currency, not counted</span>}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs">{moneyOf(b, Number(b.data?.grossKobo || 0))}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-destructive">{moneyOf(b, Number(b.data?.feeKobo || 0))}{!hasFeeSchedule(currency) && <span className="block font-sans text-muted-foreground">Not checked: no fee schedule for {currency}</span>}</td>
                      <td className="px-4 py-2 text-right font-mono font-medium">{moneyOf(b, Number(b.data?.netKobo || 0))}</td>
                      <td className="px-4 py-2 text-right"><StatusBadge status={b.status} /></td>
                    </tr>;
                  })
                )}
              </tbody>
            </table>
          </ScrollFrame>
          {!isLoadingBatches && !batchesError && batches && (batches?.total || 0) > 25 && <RecordPagination pagination={batchPage} total={batches?.total || 0} busy={batchesQuery.isPlaceholderData} label="settlement batches" />}
        </div>

        </>}
        </>}
      </div>

      <RecordDialog
        kind={
          actionKind === 'confirm_allocation' || actionKind === 'reject_allocation' || actionKind === 'review_allocation' ? 'allocations' :
          actionKind === 'create_batch' || actionKind === 'edit_batch' ? 'settlement-batches' :
          'payments'
        }
        record={selectedRecord}
        isOpen={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        title={
          actionKind === 'confirm_allocation' ? 'Confirm match' :
          actionKind === 'reject_allocation' ? 'Reject match' :
          actionKind === 'manual_allocate' ? 'Allocate payment' :
          actionKind === 'record_refund' ? 'Record refund' :
          actionKind === 'create_batch' ? 'Add settlement batch' :
          actionKind === 'edit_batch' ? 'Edit settlement batch' :
          // A match check follows its checkbox: the title and the submit button say which way it is marked.
          (values: Record<string, any>) => values.correct ? 'Mark match correct' : 'Mark match incorrect'
        }
        submitLabel={
          actionKind === 'confirm_allocation' ? 'Confirm match' :
          actionKind === 'reject_allocation' ? 'Reject match' :
          actionKind === 'manual_allocate' ? 'Allocate payment' :
          actionKind === 'record_refund' ? 'Record refund' :
          actionKind === 'create_batch' ? 'Add settlement batch' :
          actionKind === 'edit_batch' ? 'Save changes' :
          (values: Record<string, any>) => values.correct ? 'Mark match correct' : 'Mark match incorrect'
        }
        actionMutation={actionKind === 'create_batch' || actionKind === 'edit_batch' ? undefined : actionKind}
        actionRecordId={isProposalDecision ? selectedRecord?.data?.paymentId : undefined}
        onDone={response => { if (response?.data?.payerCustomerId) notifyDone('Payer recorded', String(response.message)); }}
        defaultValues={isProposalDecision ? { data: { proposalId: selectedRecord?.id, proposalUpdatedAt: selectedRecord?.updatedAt } } : actionKind === 'review_allocation' ? { correct: reviewCorrect } : actionKind === 'manual_allocate' ? { amountKobo: paymentAvailable(selectedRecord) } : actionKind === 'create_batch' ? { currency: 'NGN' } : actionKind === 'edit_batch' ? { currency: String(selectedRecord?.data?.currency || 'NGN') } : {}}
        currencyField={actionKind === 'create_batch' || actionKind === 'edit_batch' ? 'currency' : undefined}
        context={isProposalDecision && selectedRecord ? <MatchEvidence allocation={selectedRecord} payment={selectedPayment} instalment={selectedInstalment} customer={customerById.get(String(selectedRecord.customerId || selectedInstalment?.customerId))} decision={actionKind} /> : isAllocationReview && selectedRecord ? values => <MatchEvidence allocation={selectedRecord} payment={selectedPayment} instalment={selectedInstalment} customer={customerById.get(String(selectedRecord.customerId))} decision={values.correct ? 'review_correct' : 'review_incorrect'} /> : actionKind === 'manual_allocate' ? values => {
          const due = dueItemById.get(String(values.dueItemId));
          const available = paymentAvailable(selectedRecord), outstanding = instalmentOutstanding(due);
          let amount: number | null = null;
          try { amount = nairaToKobo(String(values.amountKobo ?? '')); } catch { /* The field reports incomplete or invalid input on submit. */ }
          return <section aria-label="Allocation preview" className="space-y-2 rounded-lg border bg-secondary/20 p-3 text-sm">
            <label className="grid gap-1 text-xs">Find an instalment<input type="search" value={allocationSearch} onKeyDown={searchWithoutSubmitting} onChange={event=>{setAllocationSearch(event.target.value);choicePage.resetPage();}} placeholder="Name or reference" className="min-h-10 rounded-md border bg-background px-3" /></label>
            <p className="text-xs text-muted-foreground">Paid, cancelled, closed and disputed instalments are not listed. Nor are instalments on hold while Finance reviews an earlier reversal decision.</p>
            {choicesQuery.error ? <LoadProblem what="instalment choices" pager="instalment choices" error={choicesQuery.error} retry={()=>{void choicesQuery.refetch();}} /> : <>
              {(choicesQuery.isFetching || allocationSearchPending) && <p role="status">Loading instalment choices…</p>}
              {!allocationSearchPending && choicesQuery.data && (choicesQuery.data.total === 0 ? !choicesQuery.isFetching && <p role="status">{allocationTerm ? 'No instalment that can take a payment matches this search. Try another name or reference.' : `${selectedRecord?.customerId ? 'This payer has no instalment that can take a payment.' : namedInstalment ? `${namedCustomer?.name ? `${namedCustomer.name}, named in the payment evidence,` : `The customer of instalment ${namedInstalment.reference}, named in the payment evidence,`} has no instalment that can take a payment.` : 'No instalment can take a payment.'} Leave the payment unallocated for now, or record a refund if the money went back.`}</p> : <RecordPagination pagination={choicePage} total={choicesQuery.data.total} busy={choicesQuery.isFetching} label="instalment choices" />)}
            </>}
            <p className="font-semibold">Payment {selectedRecord?.reference}</p>
            <p>Recorded payer: <strong>{customerById.get(String(selectedRecord?.customerId))?.name || (selectedRecord?.customerId ? 'Customer name unavailable' : 'Not identified')}</strong></p>
            {!selectedRecord?.customerId ? <>
              <p className="text-xs text-muted-foreground">Check who paid from the payment evidence, then choose one of their instalments. Allocating also records that customer as the payer, with your reason.{namedInstalment ? ` The payment evidence names instalment ${namedInstalment.reference}${namedCustomer?.name ? ` of ${namedCustomer.name}` : ''}, so only that customer’s instalments are listed.` : ''}</p>
              {due && <p>Payer to be recorded: <strong>{customerById.get(String(due.customerId))?.name || `the customer of instalment ${due.reference}`}</strong></p>}
            </> : <p className="text-xs text-muted-foreground">Only this payer’s instalments are listed.</p>}
            <p>Unallocated: <strong>{moneyOf(selectedRecord, available)}</strong></p>
            <p>Outstanding on the chosen instalment: <strong>{due ? formatKobo(outstanding) : 'Choose an instalment'}</strong></p>
            {due && amount !== null && amount > 0 && amount <= available && amount <= outstanding && <p className="text-xs text-muted-foreground">After allocation: {formatKobo(available - amount)} of the payment unallocated; {formatKobo(outstanding - amount)} outstanding on the instalment.</p>}
          </section>;
        } : actionKind === 'record_refund' && selectedRecord ? <p className="text-sm">This records that <strong>{moneyOf(selectedRecord, paymentAvailable(selectedRecord))}</strong> was refunded outside Valo Pay. That is the part of this payment not allocated to any instalment. Valo Pay does not move money.</p> : undefined}
        validate={(values): Record<string, string> => {
          if ((isProposalDecision || isAllocationReview) && (!selectedPayment || !selectedInstalment)) return { reason: 'The payment or instalment details are not available. Close this dialog and reload the page before you decide.' };
          // A hold reconciliation recorded while the dialog was open refuses the decision, in the service's words.
          const held = actionKind === 'confirm_allocation' ? permissionReason(workspace, { action: actionKind, record: selectedRecord, payment: selectedPayment, instalment: selectedInstalment }) : null;
          if (held) return { reason: held };
          if (actionKind === 'confirm_allocation' && (selectedRecord.amountKobo > paymentAvailable(selectedPayment) || selectedRecord.amountKobo > instalmentOutstanding(selectedInstalment))) return { reason: 'The match amount is more than the payment has unallocated, or more than the instalment still owes. Close this dialog, select Refresh queue and check the new balances.' };
          if (actionKind !== 'manual_allocate') return {};
          const due = dueItemById.get(String(values.dueItemId));
          if (!due) return { dueItemId: 'Choose an instalment from the list.' };
          const amount = nairaToKobo(String(values.amountKobo));
          if (amount <= 0) return { amountKobo: 'Enter an amount greater than ₦0.00.' };
          if (amount > paymentAvailable(selectedRecord)) return { amountKobo: `Enter ${formatKobo(paymentAvailable(selectedRecord))} or less. This is the payment’s unallocated amount.` };
          if (amount > instalmentOutstanding(due)) return { amountKobo: `Enter ${formatKobo(instalmentOutstanding(due))} or less. This is the amount outstanding on the instalment.` };
          return {};
        }}
        fields={
          actionKind === 'manual_allocate' ? [
            { name: 'dueItemId', label: 'Instalment', type: 'select', isData: true, required: true, options: (choicesQuery.data?.items || []).map(item => ({ value: item.id, label: `${customerById.get(String(item.customerId))?.name || item.name} · ${item.reference} · ${formatKobo(instalmentOutstanding(item))} outstanding` })) },
            { name: 'amountKobo', label: 'Amount to allocate (₦)', type: 'number', isData: true, required: true }
          ] : 
          actionKind === 'record_refund' ? [
            { name: 'reference', label: 'Refund reference', type: 'text', isData: true, required: true, help: 'The reference your bank or provider gave the refund.' }
          ] :
          actionKind === 'review_allocation' ? [
            { name: 'correct', label: 'This match is correct', type: 'checkbox', isData: true, help: 'Untick it to mark the match incorrect. That reopens the payment and instalment.' }
          ] :
          actionKind === 'create_batch' || actionKind === 'edit_batch' ? [
            { name: 'name', label: 'Name', type: 'text', required: true },
            { name: 'reference', label: 'Batch reference', type: 'text', required: true, help: 'Reconciliation sets the batch’s status.' },
            { name: 'provider', label: 'Provider', type: 'text', isData: true, required: true },
            // A batch the provider's lines build is in its first line's currency, which reconciliation records.
            ...(actionKind === 'create_batch' || !Array.isArray(selectedRecord?.data?.lineObservationIds) ? [{ name: 'currency', label: 'Currency', type: 'text' as const, isData: true, required: true, help: 'The three-letter currency code, such as NGN or USD. Use NGN unless the provider paid this batch out in another currency. Enter the amounts below in this currency.' }] : []),
            { name: 'grossKobo', label: 'Amount before fees (₦)', type: 'number', isData: true, required: true },
            { name: 'feeKobo', label: 'Fee (₦)', type: 'number', isData: true, required: true },
            { name: 'netKobo', label: 'Amount after fees (₦)', type: 'number', isData: true, required: true }
          ] :
          []
        }
      />
    </div>
  );
}
