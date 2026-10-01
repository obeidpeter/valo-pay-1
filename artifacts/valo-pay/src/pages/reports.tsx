import { CloseHistorySection } from '@/components/close-history-section';
import { ExportJobControl } from '@/components/export-job-control';
import { outcomeIsUnconfirmed, useSafePerformAction as usePerformAction } from '@/lib/safe-mutations';
import React, { useEffect, useRef, useState } from 'react';
import { EvidenceDisclosure as ReportDisclosure } from '@/components/evidence-disclosure';
import { SectionNavigation } from '@/components/section-navigation';
import { ScrollFrame } from '@/components/scroll-frame';
import { EmptyRow, EmptyState } from '@/components/empty-state';
import { Loading } from '@/components/loading';
import { DailyCloseStatus } from '@/components/daily-close-status';
import { useWorkspace } from '@/lib/workspace-context';
import { useGetReports, getGetReportsQueryKey, useListRecords, getListRecordsQueryKey } from '@workspace/api-client-react';
import { BarChart3, FileText, CheckSquare, RefreshCcw } from 'lucide-react';
import { PermissionButton as Button } from '@/components/permission-button';
import { formatKobo, formatDate, formatCount, formatNumber, formatPercent, formatPercentagePoints } from '@/lib/formatters';
import { formatWithOtherCurrencies } from '@/lib/currencies';
import { RecordDialog } from '@/components/record-dialog';
import { readableLabel } from '@/components/record-label';
import { Link, useSearchParams } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { LoadProblem, RefreshProblem } from '@/components/load-problem';
import { notifyProblem, saidBy } from '@/lib/notify';
import { useHashTarget } from '@/lib/use-hash-target';
import { useFocusWhenLost } from '@/lib/focus';
import { Input } from '@/components/ui/input';
import { KEPT_IN_OPERATIONS, OpenOperations } from '@/components/pilot-ui';

type Unknown = Record<string, unknown> | undefined;
const isScalar = (value: unknown) => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const scalarEntries = (record: Unknown): Array<[string, unknown]> => Object.entries(record || {}).filter(([, value]) => isScalar(value));
const billingLines = (record: Unknown): Array<Record<string, any>> => Array.isArray(record?.lines) ? (record!.lines as Array<Record<string, any>>) : [];
const experimentRows = (record: Unknown): Array<Record<string, any>> => Array.isArray(record?.results) ? (record!.results as Array<Record<string, any>>) : [];
const labelOf = (key: string) => key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim().toLowerCase().replace(/^./, first => first.toUpperCase());
const percent = (value: unknown) => typeof value === 'number' ? formatPercent(value, 1) : 'Not recorded';
const percentagePoints = (value: unknown) => typeof value === 'number' ? formatPercentagePoints(value) : 'Not recorded';
/** A count from the report's free-form data, grouped the market's way; one the report leaves out is 0. */
const count = (value: unknown) => typeof value === 'number' ? formatNumber(value) : String(value ?? 0);
const invoiceRows = (record: Unknown): Array<Record<string, any>> => Array.isArray(record?.invoices) ? (record!.invoices as Array<Record<string, any>>) : [];
const adjustmentRows = (record: Unknown): Array<Record<string, any>> => Array.isArray(record?.pendingAdjustments) ? (record!.pendingAdjustments as Array<Record<string, any>>) : [];
/** Issued invoices charged at another rate than the terms in effect for their month give, each with the service's explanation; an older answer has none. */
const discrepancyRows = (record: Unknown): Array<Record<string, any>> => Array.isArray(record?.rateDiscrepancies) ? (record!.rateDiscrepancies as Array<Record<string, any>>) : [];
const rateText = (rate: unknown) => typeof rate !== 'number' ? 'Not recorded' : rate > 0 ? `${formatPercent(rate)} discount` : 'Full public price';
const billingSummaryKeys = new Set(['period', 'volumeTier', 'totalKobo', 'usageFeeKobo', 'successfulCollections', 'nextInvoicePeriod', 'pendingAdjustmentsKobo']);
const billingReadinessKeys = new Set(['pricingReady', 'pricingExplanation', 'nextInvoicePricingReady', 'nextInvoicePricingExplanation']);
const billingLabels: Record<string, string> = {
  period: 'Billing month', volumeTier: 'Licence plan', totalKobo: 'Statement total',
  usageRateBps: 'Usage fee rate', usageCapKobo: 'Maximum usage fee per collection', vatBps: 'VAT rate',
  reversalWindowDays: 'Provider reversal period (days)', billableRule: 'When a collection can be billed',
  eligibleAllocatedKobo: 'Matched value eligible for billing', successfulCollections: 'Billable collections',
  usageFeeKobo: 'Usage fees', nextInvoicePeriod: 'Month the next invoice covers',
  withheldInsideReversalWindow: 'Collections still within the reversal period',
  pendingAdjustmentsKobo: 'Pending adjustments', adjustmentRule: 'How invoice corrections work',
  recoveryFee: 'Recovery fee conditions', implementationExcludedFromRecurring: 'Setup fees excluded from recurring revenue',
  synthetic: 'Uses sample data',
};
const experimentLabels: Record<string, string> = { result: 'Result', note: 'What the result means', synthetic: 'Uses sample data' };
const checkLabels: Record<string, string> = {
  effectAtLeastEightPoints: 'Improvement of at least 8 percentage points', intervalExcludesZero: 'Confidence interval shows improvement',
  sampleMet: 'Required sample reached', analysisDateReached: 'Analysis date reached',
};

function renderValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return 'Not recorded';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    if (/kobo$/i.test(key)) return formatKobo(value);
    if (/bps$/i.test(key)) return formatPercent(value / 10000);
    if (/rate$|precision$|share$/i.test(key)) return percent(value);
    return formatNumber(value);
  }
  return String(value);
}

/** REC-01: the schedule block on a close record and the schedule view in the operational report, typed from free-form data. */
interface CloseTriggerView { trigger: string; late: boolean; delayMinutes: number | null; scheduledFor: string | null }
export default function ReportsPage() {
  const { merchantId } = useWorkspace();
  const [search, setSearch] = useSearchParams();
  const view = ['billing', 'evidence'].includes(search.get('view') || '') ? search.get('view')! : 'operations';
  const from = search.get('from') || '', to = search.get('to') || '';
  const setReportFilter = (name: string, value: string) => setSearch(current => {
    const next = new URLSearchParams(current);
    if (value) next.set(name, value); else next.delete(name);
    return next;
  });
  const [experimentDialog, setExperimentDialog] = useState<'create' | 'edit' | 'preregister' | null>(null);
  const [selectedExperiment, setSelectedExperiment] = useState<any>(null);
  const [invoiceDialogOpen, setInvoiceDialogOpen] = useState(false);
  const [sourceBusinessDate, setSourceBusinessDate] = useState('');
  const queryClient = useQueryClient();
  const [closeResult, setCloseResult] = useState<{ merchantId: string; message: string; failed: boolean } | null>(null);
  useEffect(() => { setExperimentDialog(null); setInvoiceDialogOpen(false); setSourceBusinessDate(''); }, [merchantId]);

  const reportsQuery = useGetReports(
    { merchantId: merchantId!, includeCloses: 'false' as const },
    { query: { enabled: !!merchantId, refetchInterval: 60_000, queryKey: getGetReportsQueryKey({ merchantId: merchantId!, includeCloses: 'false' as const }) } }
  );
  const { data: reports, isLoading, error: reportsError, isFetching: fetchingReports, refetch } = reportsQuery;
  const invoiceNeedsReview = reports?.billing?.nextInvoicePricingReady === false;
  const statementNeedsReview = reports?.billing?.pricingReady === false;
  const pricingExplanation = (value: unknown) => typeof value === 'string' && value.trim() ? value : 'Review the design-partner discount dates in the signed commercial terms before issuing this invoice.';
  useHashTarget('daily-closes', view === 'operations' && !!merchantId && !!reports && !isLoading && !reportsError);

  // While Check original request asks about a lost close, its notice stays, with the button busy, until the answer comes.
  const checkingClose = useRef(false), closeNotice = useRef<HTMLDivElement>(null);
  // The button that checked a lost close goes with the notice it was in: reading continues from the close's outcome.
  useFocusWhenLost(closeNotice, closeResult);
  const dailyClose = usePerformAction({
    mutation: {
      onMutate: () => { if (!checkingClose.current) setCloseResult(null); },
      onSuccess: (data, variables) => {
        setCloseResult({ merchantId: variables.params!.merchantId, message: data.message, failed: false });
        void queryClient.invalidateQueries();
      },
      onError: (error, variables) => setCloseResult({ merchantId: variables.params!.merchantId, message: saidBy(error, outcomeIsUnconfirmed(error) ? 'We do not know yet whether Valo Pay ran this close. Select Check original request to find out. It does not run a second close.' : 'Valo Pay gave no reason. Try again.'), failed: true }),
    }
  }, merchantId);
  /** Sends the lost close again with its original details and key: Valo Pay answers what it did, and never runs a second close. */
  const checkClose = () => {
    checkingClose.current = true;
    void dailyClose.retryUnconfirmed().catch(() => undefined).finally(() => { checkingClose.current = false; });
  };

  const { data: experiments, error: experimentsError, isLoading: loadingExperiments, isFetching: fetchingExperiments, refetch: retryExperiments } = useListRecords(
    'experiments',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId && view === 'evidence', queryKey: getListRecordsQueryKey('experiments', { merchantId: merchantId! }) } }
  );
  const { data: policies, error: policiesError, isFetching: fetchingPolicies, refetch: retryPolicies } = useListRecords(
    'policies',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId && view === 'evidence', queryKey: getListRecordsQueryKey('policies', { merchantId: merchantId! }) } }
  );


  if (!merchantId) return null;
  const approvedPolicyOptions = (policies?.items || [])
    .filter(policy => policy.status === 'approved')
    .map(policy => ({ label: `${policy.name} · v${String(policy.data?.version || 1)}`, value: policy.id }));
  const openExperimentDialog = (mode: 'create' | 'edit' | 'preregister', experiment?: any) => {
    setSelectedExperiment(experiment || null);
    setExperimentDialog(mode);
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Reports</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {view === 'billing' && <><ExportJobControl kind="billing" formats={['csv']} label="Export billing CSV" />
          <Button variant="outline" className="gap-2" action="issue_invoice" disabled={invoiceNeedsReview} aria-describedby={invoiceNeedsReview ? 'invoice-pricing-review' : undefined} onClick={() => setInvoiceDialogOpen(true)}>
            <FileText className="h-4 w-4" /> Issue invoice
          </Button></>}
          {view === 'operations' && <><div className="max-w-64 space-y-1">
            <label htmlFor="close-source-date" className="text-xs font-medium">Source business date (optional)</label>
            <Input id="close-source-date" type="date" value={sourceBusinessDate} onChange={event => setSourceBusinessDate(event.target.value)} disabled={dailyClose.isPending} aria-describedby="close-source-date-help" />
            <p id="close-source-date-help" className="text-xs text-muted-foreground">Leave blank to use today (WAT). If automatic closes were missed, the oldest missed date is used instead. The close checks the files for that date. Its totals are as at the time it runs.</p>
          </div><Button
            className="gap-2"
            action="daily_close" onClick={() => dailyClose.mutate({ data: { action: 'daily_close', ...(sourceBusinessDate ? { data: { sourceBusinessDate } } : {}) }, params: { merchantId } })}
            busy={dailyClose.isPending}
            busyLabel="Running daily close…"
          >
            <RefreshCcw className="h-4 w-4" /> Run daily close
          </Button></>}
        </div>
      </header>
      <SectionNavigation label="Report views" value={view} onChange={value => setReportFilter('view', value)} sections={[
        { id: 'operations', label: 'Totals and closes', description: 'Current totals and the saved daily closes. Use the dates below to compare past closes.' },
        { id: 'billing', label: 'Billing', description: 'Charges for this billing month, issued invoices and adjustments. The billing CSV covers this month’s statement.' },
        { id: 'evidence', label: 'Pilot results', description: 'Results for judging the pilot. Sample data cannot show how Valo Pay performs live.' },
      ]} />
      {view === 'billing' && (invoiceNeedsReview || statementNeedsReview) && <div id="invoice-pricing-review" role="status" className="rounded-xl border border-warning/40 bg-warning/5 p-4 text-sm">
        <p className="font-semibold">Commercial terms need review</p>
        {statementNeedsReview && <p className="mt-2">Current statement: {pricingExplanation(reports?.billing?.pricingExplanation)}</p>}
        {invoiceNeedsReview && <p className="mt-2">Next invoice: {pricingExplanation(reports?.billing?.nextInvoicePricingExplanation)}</p>}
        <Link href="/evidence" className="mt-3 inline-flex min-h-10 items-center font-medium text-primary underline underline-offset-4">Open Go-live evidence</Link>
      </div>}
      {closeResult?.merchantId === merchantId && <div ref={closeNotice} role={closeResult.failed ? 'alert' : 'status'} className={`rounded-lg border p-5 text-sm ${closeResult.failed ? 'border-destructive/30 bg-destructive/5' : 'bg-card'}`}>
        <p className="font-semibold">{closeResult.failed ? (dailyClose.hasUnconfirmedOutcome ? 'Request not confirmed' : 'Daily close not completed') : 'Daily close completed'}</p>
        <p className="mt-2 text-muted-foreground">{closeResult.message}{closeResult.failed && dailyClose.hasUnconfirmedOutcome && <> {KEPT_IN_OPERATIONS}</>}</p>
        {closeResult.failed ? <div className="mt-3 flex flex-wrap items-center gap-3">{dailyClose.hasUnconfirmedOutcome && <Button variant="outline" size="sm" action="daily_close" onClick={checkClose} busy={dailyClose.isPending} busyLabel="Checking original request…">Check original request</Button>}<Button variant="outline" size="sm" onClick={() => { void refetch(); void queryClient.invalidateQueries({ queryKey: ['/api/v1/close-history'] }); }} busy={fetchingReports} busyLabel="Refreshing…">Refresh close records</Button>{dailyClose.hasUnconfirmedOutcome && <OpenOperations />}</div> : <Link href="/reports?view=operations#daily-closes" className="mt-3 inline-flex min-h-6 items-center font-medium text-primary underline">View close record</Link>}
      </div>}

      {isLoading ? (
        <Loading what="reports" />
      ) : !reports ? (
        <LoadProblem what="reports" error={reportsError} retry={() => { void refetch(); }} busy={fetchingReports} />
      ) : (
        <div className="space-y-6">
          <RefreshProblem what="the reports" query={reportsQuery} />
          <p className="text-xs text-muted-foreground">{view === 'operations' ? `Current totals for this lender${reports.operational?.asOf ? ` as at ${formatDate(String(reports.operational.asOf))}` : ''}.` : view === 'billing' ? `Billing month: ${String(reports.billing?.period || 'not recorded')}. Amounts are in naira unless another currency is named.` : `Accuracy sample: ${String((reports.operational?.precisionAudit as any)?.month || 'completed month')}.`} All figures use sample data.</p>
          <section hidden={view !== 'operations'} aria-label="Totals" className={view === 'operations' ? 'grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4' : ''}>
            {reports.metrics.map(metric => (
              <div key={metric.key} className="min-w-0 rounded-xl border bg-card p-5 shadow-sm">
                <p className="text-xs font-medium text-muted-foreground">{metric.label}</p>
                <div className="mt-4 break-words text-[1.75rem] font-semibold leading-none tracking-tight tabular-nums">
                  {metric.key === 'allocation_precision' && Number(reports.operational?.reviewedCount || 0) === 0 ? <span className="text-xl">Not measured yet</span> : metric.unit === 'kobo' ? formatKobo(metric.value) : metric.unit === 'ratio' ? percent(metric.value) : metric.unit === 'percent' ? formatPercent(metric.value / 100) : formatNumber(metric.value)}
                  {!['kobo', 'ratio', 'percent', 'count'].includes(metric.unit) && <span className="ml-1 text-sm text-muted-foreground">{metric.unit}</span>}
                </div>
                {metric.detail && <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{metric.detail}</p>}
                {metric.key === 'allocation_precision' && <Link href="/reconciliation#precision-audit" className="mt-3 inline-flex min-h-6 items-center text-xs font-medium text-primary underline">Review matches</Link>}
              </div>
            ))}
          </section>

          <section hidden={view !== 'evidence'} className="rounded-xl border bg-card" aria-labelledby="measurement-title">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-4">
              <h2 id="measurement-title" className="text-sm font-semibold">Pilot results</h2>
              <span className="rounded-md bg-secondary/60 px-2 py-1 text-xs text-muted-foreground">Sample data, not live results</span>
            </div>
            <div className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 xl:grid-cols-4">
            <div className="min-w-0">
               <p className="text-xs font-medium text-muted-foreground">Staff review confirmed</p>
               <div className="mt-2 text-xl font-semibold tracking-tight tabular-nums">{reports.operational?.fortnightlyStaffConfirmed ? 'Yes' : 'No'}</div>
               <p className="text-xs text-muted-foreground mt-2">{reports.operational?.latestReviewAt ? `Last confirmed on ${formatDate(String(reports.operational.latestReviewAt))}. ${reports.operational?.reviewCadenceMet ? 'Reviews have happened every two weeks since the first close.' : 'Some two-week periods since the first close had no review.'}` : 'No reviewer has confirmed all four tasks in a review yet. Reviews are due every two weeks.'}</p>
            </div>
            <div className="min-w-0">
               <p className="text-xs font-medium text-muted-foreground">Payment match accuracy</p>
               <div className="mt-2 text-xl font-semibold tracking-tight tabular-nums">{count((reports.operational?.precisionAudit as any)?.reviewed)} <span className="text-sm font-normal text-muted-foreground">/ {count(reports.operational?.requiredAuditSample || 0)} reviewed</span></div>
               <p className="text-xs text-muted-foreground mt-2">{(() => { const audit = reports.operational?.precisionAudit as any; return audit?.falseMatchRate === null || audit?.falseMatchRate === undefined ? `A sample of ${count(audit?.sampleSize)} of ${count(audit?.population)} automatic Certain matches for ${String(audit?.month ?? 'the completed month')}. None reviewed yet.` : `Incorrect matches: ${percent(audit.falseMatchRate)}. The 95% confidence interval is ${percent(audit.interval?.low)} to ${percent(audit.interval?.high)}, based on ${count(audit.reviewed)} reviewed matches from a sample of ${count(audit.sampleSize)}.`; })()}</p>
            </div>
            <div className="min-w-0">
               <p className="text-xs font-medium text-muted-foreground">Days since first close</p>
               <div className="mt-2 text-xl font-semibold tracking-tight tabular-nums">{count(reports.operational?.liveDays || 0)} <span className="text-sm font-normal text-muted-foreground">/ {count(reports.operational?.requiredLiveDays || 60)} days</span></div>
               <p className="text-xs text-muted-foreground mt-2">{reports.operational?.liveSince ? `Since the first daily close on ${formatDate(String(reports.operational.liveSince))}.` : 'Counts from the first daily close.'}</p>
            </div>
            <div className="min-w-0">
               <p className="text-xs font-medium text-muted-foreground">Real cases used</p>
               <div className="mt-2 text-xl font-semibold tracking-tight tabular-nums">
                 {count(reports.operational?.realCasesUsed || 0)} <span className="text-sm font-normal text-muted-foreground">/ {count(reports.operational?.requiredRealCases || 5)} cases</span>
               </div>
               <p className="mt-2 text-xs text-muted-foreground">Exports from sample data do not count as real cases.</p>
            </div>
            </div>
          </section>

          <div className="space-y-6">
            {/* Billing Statement Preview */}
            <section hidden={view !== 'billing'} className="bg-card border rounded-xl shadow-sm overflow-hidden">
              <div className="p-5 border-b flex items-center gap-2">
                <FileText aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
                <h2 className="font-semibold">Billing statement for this month</h2>
              </div>
              <div className="space-y-4 p-5">
                <div className="flex flex-wrap items-end justify-between gap-4 rounded-xl bg-secondary/35 p-4">
                  <div><p className="text-xs text-muted-foreground">Current statement total</p><p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">{statementNeedsReview ? 'Needs review' : typeof reports.billing?.totalKobo === 'number' ? formatKobo(reports.billing.totalKobo) : 'Not recorded'}</p></div>
                  <div className="text-xs text-muted-foreground"><p>Billing month {String(reports.billing?.period || 'not recorded')}</p><p className="mt-1">Valo Pay never holds money.</p></div>
                </div>
                <div className="grid grid-cols-1 gap-x-5 gap-y-3 text-sm sm:grid-cols-2">
                  {scalarEntries(reports.billing).filter(([key]) => billingSummaryKeys.has(key) && key !== 'totalKobo' && key !== 'period').map(([key, value]) => (
                    <div key={key} className="flex justify-between items-baseline gap-3 border-b border-border/70 pb-2">
                      <span className="text-xs text-muted-foreground">{billingLabels[key] || labelOf(key)}</span>
                      <span className="min-w-0 text-xs font-medium tabular-nums [overflow-wrap:anywhere]">{renderValue(key, value)}</span>
                    </div>
                  ))}
                  {scalarEntries(reports.billing).length === 0 && (
                    <EmptyState title="No billing data for this month" className="px-0 py-4">A collection is billed only when its direct debit succeeds, the money settles and the provider’s reversal period ends without a reversal.</EmptyState>
                  )}
                </div>
                {discrepancyRows(reports.billing).length > 0 && <div role="status" className="space-y-3 rounded-xl border border-warning/40 bg-warning/5 p-4 text-sm">
                  <p className="font-semibold">Issued invoices that differ from the terms in effect</p>
                  <ScrollFrame label="Issued invoices that differ from the terms in effect" className="overflow-x-auto">
                    <table className="w-full text-xs text-left tabular-nums">
                      <thead className="text-muted-foreground border-b"><tr><th className="py-1 pr-2">Invoice</th><th className="py-1 pr-2">Billing month</th><th className="py-1 pr-2">Rate charged</th><th className="py-1 pr-2">Rate in the terms in effect</th></tr></thead>
                      {/* Each difference with the service's explanation beneath it: the terms compared with, when they took effect and the whole-month rule. */}
                      {discrepancyRows(reports.billing).map(line => (
                        <tbody key={String(line.invoiceId)} className="border-b border-border/60 last:border-0">
                          <tr><td className="pt-2 pr-2">{String(line.invoiceReference)}</td><td className="pt-2 pr-2">{String(line.period)}</td><td className="pt-2 pr-2">{rateText(line.chargedRate)}</td><td className="pt-2 pr-2">{rateText(line.agreedRate)}</td></tr>
                          {!!line.explanation && <tr><td colSpan={4} className="pb-2 pr-2 font-sans text-muted-foreground [overflow-wrap:anywhere]">{String(line.explanation)}</td></tr>}
                        </tbody>
                      ))}
                    </table>
                  </ScrollFrame>
                  <p>{String(reports.billing?.rateDiscrepancyGuidance || 'Issued invoices cannot be changed. Agree any difference with the lender outside Valo Pay.')}</p>
                </div>}
                <ReportDisclosure title="Billing rates and rules">
                  <dl className="space-y-3 text-xs">
                    {scalarEntries(reports.billing).filter(([key]) => !billingSummaryKeys.has(key) && !billingReadinessKeys.has(key) && key !== 'rateDiscrepancyGuidance').map(([key, value]) => (
                      <div key={key} className="grid gap-1 border-b border-border/60 pb-3 last:border-0 last:pb-0">
                        <dt className="font-medium">{billingLabels[key] || labelOf(key)}</dt>
                        <dd className="leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{renderValue(key, value)}</dd>
                      </div>
                    ))}
                  </dl>
                </ReportDisclosure>
                <ReportDisclosure title={`Statement lines (${formatNumber(billingLines(reports.billing).length)})`}>
                  {billingLines(reports.billing).length === 0 ? (
                    <p className="text-xs text-muted-foreground">{statementNeedsReview ? 'Statement lines are hidden until the design-partner terms can be used for this month (see the reason above). Signed terms may still exist, and money may still be owed.' : 'No signed partner terms apply to this month, so there are no statement lines to bill.'}</p>
                  ) : (
                    <ScrollFrame label="Statement lines" className="overflow-x-auto">
                      <table className="w-full text-xs text-left tabular-nums">
                        <thead className="text-muted-foreground border-b">
                          <tr><th className="py-1 pr-2">Lender</th><th className="py-1 pr-2">Plan</th><th className="py-1 pr-2 text-right">Licence</th><th className="py-1 pr-2 text-right">Usage fees</th><th className="py-1 pr-2 text-right">Total</th><th className="py-1">Note</th></tr>
                        </thead>
                        <tbody className="divide-y">
                          {billingLines(reports.billing).map(line => (
                            <tr key={String(line.commercialId)}>
                              <td className="py-1 pr-2 font-sans">{String(line.prospect)}</td>
                              <td className="py-1 pr-2">{String(line.volumeTier)}{line.tierMismatch ? ' (differs from contract)' : ''}</td>
                              <td className="py-1 pr-2 text-right">{formatKobo(Number(line.licenceKobo || 0))}</td>
                              <td className="py-1 pr-2 text-right">{formatKobo(Number(line.usageKobo || 0))}</td>
                              <td className="py-1 pr-2 text-right font-bold">{formatKobo(Number(line.totalKobo || 0))}</td>
                              <td className="py-1 font-sans text-muted-foreground">{line.designPartnerDiscount ? 'Design-partner discount applied' : 'Full public price'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </ScrollFrame>
                  )}
                </ReportDisclosure>
                <ReportDisclosure title="Payments by method">
                  <p className="text-xs text-muted-foreground mb-2">Only successful direct debits are billed, after settlement and the reversal period. Transfers and card payments are matched to records but never billed.</p>
                  <ScrollFrame label="Payments by method" className="overflow-x-auto">
                    <table className="w-full text-xs text-left tabular-nums">
                      <thead className="text-muted-foreground border-b"><tr><th className="py-1 pr-2">Payment method</th><th className="py-1 pr-2 text-right">Payments</th><th className="py-1 pr-2 text-right">Value</th><th className="py-1 pr-2 text-right">Billable</th></tr></thead>
                      <tbody className="divide-y">
                        {Object.entries((reports.billing?.channelBreakdown as Record<string, any>) || {}).map(([channel, row]) => (
                          <tr key={channel}><td className="py-1 pr-2">{labelOf(channel)}</td><td className="py-1 pr-2 text-right">{count(row.count)}</td><td className="py-1 pr-2 text-right">{formatWithOtherCurrencies(Number(row.kobo || 0), row.otherCurrencies, 'payment')}</td><td className="py-1 pr-2 text-right">{count(row.billable)}</td></tr>
                        ))}
                        {Object.keys((reports.billing?.channelBreakdown as Record<string, any>) || {}).length === 0 && <tr><td colSpan={4} className="py-2 text-muted-foreground">No payments this month.</td></tr>}
                      </tbody>
                    </table>
                  </ScrollFrame>
                  <p className="text-xs text-muted-foreground mt-2">Collections still in the reversal period: {count(reports.billing?.withheldInsideReversalWindow)}. They can be billed on a later statement.</p>
                </ReportDisclosure>
                <ReportDisclosure title="Revenue and costs">
                  {(() => { const e = reports.billing?.unitEconomics as Record<string, any> | undefined; if (!e) return <p className="text-xs text-muted-foreground">Not recorded.</p>; return (
                    <div className="text-xs tabular-nums space-y-1">
                      {e.pricingReady === false && <p className="font-sans font-medium">Revenue and margin are shown once the commercial terms can be used for this month. Recorded collection costs are shown below.</p>}
                      <p>Successful collections: {count(e.successfulCollections)}. Usage fees: {renderValue('usageFeeKobo', e.usageFeeKobo)}. Licence fees: {renderValue('licenceKobo', e.licenceKobo)} ({String(e.volumeTier)} plan). Recurring revenue: {renderValue('recurringKobo', e.recurringKobo)}.</p>
                      <p>Collection costs: {formatKobo(Number(e.variableCostKobo || 0))}{e.estimated ? ' (estimated at ₦15 per collection)' : ' (recorded)'}. Cost per collection: {e.costPerCollectionKobo === null ? 'not recorded' : formatKobo(Number(e.costPerCollectionKobo))}. Plan target: {formatKobo(Number(e.planCostPerCollectionKobo || 0))}.</p>
                      <p>Gross margin (share of revenue left after collection costs): {e.grossMargin === null ? 'not recorded' : percent(e.grossMargin)}. Plan target: {percent(e.planGrossMargin?.low)} to {percent(e.planGrossMargin?.high)}. Recurring revenue at an annual rate: {renderValue('annualisedRecurringRevenueKobo', e.annualisedRecurringRevenueKobo)}, from licence and usage fees only.</p>
                      <p className="font-sans text-muted-foreground">{String(e.note || '')}</p>
                    </div>
                  ); })()}
                </ReportDisclosure>
                <ReportDisclosure title={`Issued invoices (${formatNumber(invoiceRows(reports.billing).length)})`}>
                  {invoiceRows(reports.billing).length === 0 ? (
                    <p className="text-xs text-muted-foreground">No invoices yet. The next invoice covers {String(reports.billing?.nextInvoicePeriod || 'the previous month')}. Issued invoices cannot be changed. VAT is shown separately.</p>
                  ) : (
                    <ScrollFrame label="Issued invoices" className="overflow-x-auto">
                      <table className="w-full text-xs text-left tabular-nums">
                        <thead className="text-muted-foreground border-b"><tr><th className="py-1 pr-2">Invoice</th><th className="py-1 pr-2">Billing month</th><th className="py-1 pr-2 text-right">Collections billed</th><th className="py-1 pr-2 text-right">Adjustments</th><th className="py-1 pr-2 text-right">Before VAT</th><th className="py-1 pr-2 text-right">VAT</th><th className="py-1 pr-2 text-right">Total</th></tr></thead>
                        <tbody className="divide-y">
                          {invoiceRows(reports.billing).map(invoice => (
                            <tr key={String(invoice.id)}>
                              <td className="py-1 pr-2">{String(invoice.reference)}{invoice.creditNote ? ' (credit note)' : ''}</td>
                              <td className="py-1 pr-2">{String(invoice.period)}</td>
                              <td className="py-1 pr-2 text-right">{count(invoice.collectionsCounted)}</td>
                              <td className="py-1 pr-2 text-right">{count(invoice.adjustmentCount)} · {formatKobo(Number(invoice.adjustmentsKobo || 0))}</td>
                              <td className="py-1 pr-2 text-right">{formatKobo(Number(invoice.netKobo || 0))}</td>
                              <td className="py-1 pr-2 text-right">{formatKobo(Number(invoice.vatKobo || 0))}</td>
                              <td className="py-1 pr-2 text-right font-bold">{formatKobo(Number(invoice.totalKobo || 0))}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </ScrollFrame>
                  )}
                </ReportDisclosure>
                <ReportDisclosure title={`Next invoice adjustments (${formatNumber(adjustmentRows(reports.billing).length)})`}>
                  <p className="text-xs text-muted-foreground mb-2">If a billed collection is reversed, refunded, confirmed as a duplicate or loses its match, the next invoice adds a credit or debit. Each adjustment names the invoice it corrects. Issued invoices cannot be changed.</p>
                  {adjustmentRows(reports.billing).length === 0 ? (
                    <p className="text-xs text-muted-foreground">Nothing to adjust this month.</p>
                  ) : (
                    <ul className="text-xs tabular-nums space-y-1">
                      {adjustmentRows(reports.billing).map(line => (
                        <li key={`${String(line.paymentId)}-${String(line.reason)}`} className={Number(line.kobo) < 0 ? 'text-destructive' : ''}>
                          {String(line.paymentReference)} · {readableLabel(line.reason)} · {formatKobo(Number(line.kobo || 0))} · corrects {String(line.originalInvoiceReference)}
                        </li>
                      ))}
                    </ul>
                  )}
                </ReportDisclosure>
              </div>
            </section>

            {/* Experiment Results */}
            <section hidden={view !== 'evidence'} className="bg-card border rounded-xl shadow-sm overflow-hidden">
              <div className="p-5 border-b flex flex-wrap gap-3 items-center justify-between">
                <div className="flex items-center gap-2">
                  <BarChart3 aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
                  <h2 className="font-semibold">Recovery experiment</h2>
                </div>
                <Button size="sm" disabled={!policies || !!policiesError} kind="experiments" onClick={() => openExperimentDialog('create')}>Create experiment</Button>
              </div>
              <div className="p-5">
                {policiesError && <LoadProblem what="approved policies" error={policiesError} retry={() => { void retryPolicies(); }} busy={fetchingPolicies} />}
                {experimentsError && <LoadProblem what="experiments" error={experimentsError} retry={() => { void retryExperiments(); }} busy={fetchingExperiments} />}
                {loadingExperiments && <Loading what="experiments" />}
                <div className="space-y-4">
                  {(experiments?.items || []).map(experiment => (
                    <div key={experiment.id} className="border rounded-lg p-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium">{experiment.name}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{readableLabel(experiment.status)} · {percent(experiment.data?.holdoutShare)} in the comparison group</p>
                        </div>
                        {experiment.status === 'draft' && (
                          <div className="flex gap-2">
                            <Button size="sm" variant="outline" kind="experiments" record={experiment} onClick={() => openExperimentDialog('edit', experiment)}>Edit</Button>
                            <Button size="sm" action="preregister_experiment" record={experiment} onClick={() => openExperimentDialog('preregister', experiment)}>Register experiment plan</Button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  {scalarEntries(reports.experiment).map(([key, value]) => (
                    <div key={key} className={`rounded-lg bg-secondary/30 p-3 ${String(value).length > 70 ? 'space-y-2' : 'flex items-center justify-between gap-3'}`}>
                      <span className="text-xs font-medium text-muted-foreground">{experimentLabels[key] || labelOf(key)}</span>
                      <span className={`block text-sm leading-relaxed [overflow-wrap:anywhere] ${String(value) === 'not_proven' ? 'font-medium text-warning-strong' : ''}`}>
                        {key === 'result' ? readableLabel(renderValue(key, value)) : renderValue(key, value)}
                      </span>
                    </div>
                  ))}
                  {experimentRows(reports.experiment).map(row => (
                    <div key={String(row.experimentId)} className="border rounded-lg p-3 text-xs tabular-nums space-y-2">
                      <p className="text-muted-foreground truncate">Experiment {String(row.experimentId)} · {readableLabel(row.status)} · analysis date {row.analysisDate ? formatDate(String(row.analysisDate)) : 'not set'}</p>
                      <p>Enrolled instalments: retry group {count(row.engine?.enrolled)} · comparison group {count(row.holdout?.enrolled)}</p>
                      <p>Minimum completed outcomes: retry group {count(row.minimumByArm?.engine ?? row.minimumPerArm)} · comparison group {count(row.minimumByArm?.holdout ?? row.minimumPerArm)}</p>
                      <p>Completed 30-day outcomes: retry group {count(row.engine?.mature)} · comparison group {count(row.holdout?.mature)}</p>
                      <p>Amount recovered (primary measure): retry group {percent(row.engine?.recoveryByValue)} · comparison group {percent(row.holdout?.recoveryByValue)} · difference {percentagePoints(row.differenceByValue)}</p>
                      <p>Instalments settled in full: retry group {percent(row.engine?.recoveryByCount)} · comparison group {percent(row.holdout?.recoveryByCount)} · difference {percentagePoints(row.differenceByCount)}</p>
                      <p>90% confidence interval for the difference in amount recovered: {row.confidenceInterval90 ? `${percentagePoints(row.confidenceInterval90.low)} to ${percentagePoints(row.confidenceInterval90.high)}` : 'needs at least two completed 30-day outcomes in each group'}</p>
                      <p>Result checks: {Object.entries(row.checks || {}).map(([name, ok]) => `${checkLabels[name] || labelOf(name)}: ${ok ? 'met' : 'not met'}`).join(' · ')}</p>
                      <p>Result: <span className={`font-bold ${row.result === 'proven' ? 'text-success' : 'text-warning-strong'}`}>{readableLabel(row.result)}</span></p>
                      <p className="font-sans text-muted-foreground">{String(row.reason || '')}</p>
                    </div>
                  ))}
                  {scalarEntries(reports.experiment).length === 0 && experimentRows(reports.experiment).length === 0 && (
                    <EmptyState title="No experiment results yet" className="px-0 py-4">Select Create experiment and choose an approved policy, then register its plan. The experiment compares a retry group with a comparison group, and its results will appear here.</EmptyState>
                  )}
                </div>
              </div>
            </section>
          </div>

          {/* Daily Closes */}
          <section hidden={view !== 'operations'} id="daily-closes" tabIndex={-1} aria-label="Daily close records" className="scroll-mt-6 bg-card border rounded-xl shadow-sm overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4"><p className="text-sm text-muted-foreground">Export the saved daily closes and their reconciliation details.</p><ExportJobControl kind="closes" formats={['json','csv']} label="Export close evidence" /></div>
            <div className="p-5 border-b flex flex-wrap gap-3 items-center justify-between">
              <div className="flex items-center gap-2">
                <CheckSquare aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
                <h2 className="font-semibold">Daily close records</h2>
              </div>
              <DailyCloseStatus value={reports.operational?.closeSchedule} showHistory />
            </div>
            <CloseHistorySection active={view === 'operations'} />
          </section>

        </div>
      )}
      <RecordDialog
        kind="invoices"
        record={null}
        isOpen={invoiceDialogOpen}
        onOpenChange={(open) => { if (!open) { setInvoiceDialogOpen(false); refetch(); } }}
        title="Issue the monthly invoice?"
        actionMutation="issue_invoice"
        fields={[
          { name: 'period', label: 'Billing month (optional)', type: 'text', isData: true, help: `Leave blank to invoice the previous month, or enter a month as YYYY-MM, for example 2027-01. Months are invoiced in order, and a month with nothing to bill gets a zero invoice. The next invoice covers ${String(reports?.billing?.nextInvoicePeriod || 'the previous month')}.` },
        ]}
      />
      <RecordDialog
        kind="experiments"
        record={selectedExperiment}
        isOpen={experimentDialog !== null}
        onOpenChange={(open) => { if (!open) setExperimentDialog(null); }}
        title={experimentDialog === 'preregister' ? 'Register experiment plan?' : experimentDialog === 'edit' ? 'Edit experiment' : 'Create experiment'}
        submitLabel={experimentDialog === 'edit' ? 'Save changes' : experimentDialog === 'create' ? 'Create experiment' : undefined}
        busyLabel={experimentDialog === 'edit' ? 'Saving changes…' : experimentDialog === 'create' ? 'Creating experiment…' : undefined}
        actionMutation={experimentDialog === 'preregister' ? 'preregister_experiment' : undefined}
        fields={experimentDialog === 'preregister' ? [] : [
          { name: 'name', label: 'Experiment name', type: 'text', required: true },
          { name: 'status', label: 'Status', type: 'select', options: [{ label: 'Draft', value: 'draft' }], required: true },
          { name: 'baselineRate', label: 'Baseline recovery rate (%)', type: 'number', percent: 'fraction', isData: true, required: true, help: 'The share of money due that is recovered without the experiment’s retries. More than 0 and less than 92, for example 40.' },
          { name: 'holdoutShare', label: 'Comparison group share (%)', type: 'number', percent: 'fraction', isData: true, required: true, help: 'From 10 to 50, for example 20.' },
          { name: 'minPerArm', label: 'Minimum instalments per group', type: 'number', isData: true, required: true },
          { name: 'analysisDate', label: 'Analysis date', type: 'text', isData: true, required: true, help: 'Enter the date as YYYY-MM-DD, for example 2027-01-31.' },
          { name: 'enrolmentClose', label: 'Enrolment closes', type: 'text', isData: true, required: true, help: 'Enter the date as YYYY-MM-DD, for example 2026-12-31.' },
          { name: 'seed', label: 'Random assignment key', type: 'text', isData: true, required: true, help: 'Any text. The same key always puts an instalment in the same group.' },
          { name: 'policyId', label: 'Approved policy', type: 'select', options: approvedPolicyOptions, isData: true, required: true }
        ]}
        defaultValues={{ status: 'draft' }}
      />
    </div>
  );
}
