import React from 'react';
import { ConnectedIntroduction } from '@/components/connected-introduction';
import { GetStarted } from '@/components/get-started';
import { Link } from 'wouter';
import { ScrollFrame } from '@/components/scroll-frame';
import { EmptyRow, EmptyState } from '@/components/empty-state';
import { Loading } from '@/components/loading';
import { RefreshProblem } from '@/components/load-problem';
import { DailyCloseStatus } from '@/components/daily-close-status';
import { Button } from '@/components/ui/button';
import { readableLabel, StatusBadge } from '@/components/record-label';
import { useWorkspace } from '@/lib/workspace-context';
import { useGetOverview, getGetOverviewQueryKey } from '@workspace/valo-pay-1-api-client-react';
import { formatKobo, formatDate, formatCompactDate, formatNumber, formatCount, formatPercent } from '@/lib/formatters';
import { ArrowDownLeft, ArrowUpRight, ArrowRight, AlertCircle, CheckCheck, Clock, Activity, FileBarChart2, ShieldCheck } from 'lucide-react';

const queueDestinations: Record<string, string> = {
  activation: '/mandates?view=awaiting-activation', review: '/reconciliation?view=review', duplicates: '/reconciliation?view=duplicates', failures: '/collections?view=failed', overdue: '/exceptions?view=overdue',
};

function alertDestination(key: string): { href: string; label: string } {
  if (key.includes('pay_by_bank')) return { href: '/pay-by-bank', label: 'Review Pay by Bank checkouts' };
  if (key.includes('export')) return { href: '/exports', label: 'Open Saved exports' };
  if (key.includes('close')) return { href: '/reports', label: 'Open Reports' };
  if (key.includes('audit')) return { href: '/audit', label: 'Open Audit log' };
  if (key.includes('exception')) return { href: '/exceptions?view=overdue', label: 'Review overdue exceptions' };
  if (key.includes('unallocated') || key.includes('position')) return { href: '/reconciliation', label: 'Open Reconciliation' };
  if (key.includes('attempt')) return { href: '/collections', label: 'Open Collections' };
  return { href: '/settings', label: 'Open Settings' };
}

const metricIcons = [ArrowDownLeft, ArrowUpRight, CheckCheck, AlertCircle];

/** The overview's heading, the same while its figures load, when they are shown and when they could not be loaded. */
function OverviewHeader() {
  const { workspace, merchantId } = useWorkspace();
  const lender = workspace?.merchants.find(merchant => merchant.id === merchantId);
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
        <p className="mt-2 text-sm text-muted-foreground">{lender?.name || 'This lender'}’s customers, payment matches and exceptions at a glance.</p>
      </div>
      <Button asChild variant="outline" className="gap-2"><Link href="/reports"><FileBarChart2 aria-hidden="true" className="h-4 w-4" /> Open Reports</Link></Button>
    </header>
  );
}

export default function OverviewPage() {
  const { merchantId, workspace } = useWorkspace();
  const overviewQuery = useGetOverview(
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, refetchInterval: 60_000, queryKey: getGetOverviewQueryKey({ merchantId: merchantId! }) } }
  );
  const { data: overview, isLoading, error, refetch } = overviewQuery;

  if (!merchantId) return <div className="space-y-6"><OverviewHeader /><section className="rounded-xl border bg-card" aria-label="Lender access"><EmptyState title="No lender to show yet" action={<Button asChild><Link href={workspace?.role === 'Admin' ? '/pilot' : '/help?topic=access'}>{workspace?.role === 'Admin' ? 'Create a sample lender' : 'Read about lender access'}</Link></Button>}>{workspace?.role === 'Admin' ? 'Create a sample lender to start the pilot journey. Team member access and approval to use real data are separate checks.' : 'There are no lender records to show yet. Signing in does not give you access to every lender. Ask an Admin at your organisation for access to the lender you work with.'}</EmptyState></section></div>;
  if (isLoading) return <div className="space-y-6"><Loading what="the overview" heading /><GetStarted /></div>;
  // A failed refresh keeps the figures on the page, with a notice; only a first load that failed shows this card, under the page's heading.
  if (error && !overview) return <div className="space-y-6"><OverviewHeader /><GetStarted /><div role="alert" className="rounded-xl border bg-card p-6"><p className="font-semibold">We could not load the overview</p><p className="mt-1 text-sm text-muted-foreground">Nothing has changed.</p><Button variant="outline" className="mt-4" onClick={() => refetch()}>Try again</Button></div></div>;
  if (!overview) return null;

  const upcoming = [...overview.upcoming].sort((a, b) => String(a.data.dueDate || '').localeCompare(String(b.data.dueDate || '')));

  return (
    <div className="space-y-6 animate-in fade-in duration-500 motion-reduce:animate-none">
      <OverviewHeader />

      <RefreshProblem what="the overview" query={overviewQuery} />

      <GetStarted overview={overview} />

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border bg-card px-4 py-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-2 font-medium text-foreground"><Clock aria-hidden="true" className="h-4 w-4 text-muted-foreground" /> Daily close</span>
        <p>Last daily close: {overview.lastClose ? formatDate(overview.lastClose) : 'Not closed yet'}</p>
        <DailyCloseStatus value={overview.closeSchedule} />
        <span className="ml-auto rounded-md bg-secondary px-2 py-1 font-medium">{overview.environment === 'sandbox' ? 'Sample data only' : readableLabel(overview.environment)}</span>
      </div>

      <section aria-labelledby="overview-metrics-title" className="@container">
        <h2 id="overview-metrics-title" className="sr-only">Key metrics</h2>
        {/* Columns follow the section's own width, since from 768 px the sidebar takes part of the window: at 36rem a card
            holds a 15-character amount on one line, and at 72rem four cards do. */}
        <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2 @6xl:grid-cols-4 print:grid-cols-2">
          {overview.metrics.map((metric, index) => {
            const Icon = metricIcons[index % metricIcons.length];
            return (
              <div key={metric.key} className="relative min-w-0 rounded-xl border bg-card p-5 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-medium text-muted-foreground">{metric.label}</p>
                  <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${metric.key === 'settled' ? 'bg-success/10 text-success' : metric.key === 'exceptions' ? 'bg-warning text-warning-foreground' : 'bg-secondary/60 text-muted-foreground'}`}><Icon aria-hidden="true" className="h-4 w-4" /></span>
                </div>
                {/* An amount stays on one line; one wider than its card still scrolls in a frame a keyboard can reach. The
                    value is only as wide as its text, so the frame sees its width change, as when a late typeface widens it. */}
                <ScrollFrame label={metric.label} className="mt-4 overflow-x-auto">
                  <p className="w-max whitespace-nowrap text-[1.75rem] font-semibold leading-tight tracking-tight tabular-nums">
                    {metric.unit === 'kobo' ? formatKobo(metric.value) : metric.unit === 'percent' ? formatPercent(metric.value / 100) : formatNumber(metric.value)}
                    {metric.unit !== 'kobo' && metric.unit !== 'percent' && metric.unit !== 'count' && <span className="ml-1 text-sm font-normal text-muted-foreground">{metric.unit}</span>}
                  </p>
                </ScrollFrame>
                {metric.detail && <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{metric.detail}</p>}
              </div>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="overview-alerts-title">
        <div className="mb-3 flex items-center gap-2">
          <h2 id="overview-alerts-title" className="text-sm font-semibold">Alerts</h2>
          {overview.alerts.length > 0 && <span className="rounded-full bg-warning px-2 py-0.5 text-xs font-medium text-warning-foreground">{formatNumber(overview.alerts.length)}</span>}
        </div>
        {overview.alerts.length === 0 ? (
          <div className="flex items-start gap-3 rounded-xl border border-success/20 bg-success/5 p-4">
            <ShieldCheck aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-success" />
            <p className="text-sm text-muted-foreground">No alerts need attention. Current checks found no problems with the audit log, customer balances, overdue work or daily closes.</p>
          </div>
        ) : (
          <ul className="grid gap-3 lg:grid-cols-2">
            {overview.alerts.map(alert => {
              const destination = alertDestination(alert.key);
              return (
                <li key={alert.key} className={`rounded-xl border p-4 ${alert.severity === 'critical' || alert.severity === 'high' ? 'border-destructive/25 bg-destructive/5' : alert.severity === 'medium' ? 'border-warning-strong/20 bg-warning-strong/5' : 'border-border bg-card'}`}>
                  <div className="flex items-start gap-2.5">
                    <AlertCircle aria-hidden="true" className={`mt-0.5 h-4 w-4 shrink-0 ${alert.severity === 'critical' || alert.severity === 'high' ? 'text-destructive' : 'text-warning-strong'}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="text-sm font-semibold">{alert.title}</h3><span className="text-xs font-semibold text-muted-foreground">{readableLabel(alert.severity)}</span></div>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{alert.detail}{alert.since ? ` Since ${formatDate(alert.since)}.` : ''}</p>
                      <Link href={destination.href} className="mt-2 inline-flex min-h-7 items-center gap-1 text-xs font-semibold underline-offset-4 hover:underline">{destination.label}<ArrowRight aria-hidden="true" className="h-3.5 w-3.5" /></Link>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2 print:grid-cols-2">
        <section className="overflow-hidden rounded-xl border bg-card shadow-sm" aria-labelledby="overview-queues-title">
          <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
            <div><h2 id="overview-queues-title" className="font-semibold">Action required</h2><p className="mt-1 text-xs text-muted-foreground">Open a list to review its items.</p></div>
            <AlertCircle aria-hidden="true" className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="divide-y">
            {overview.queues.length === 0 && <EmptyState title="Nothing needs a decision">Lists that need a decision appear here, such as mandates awaiting activation, matches to review, possible duplicates, failed collection attempts and overdue exceptions.</EmptyState>}
            {overview.queues.map(queue => (
              <Link key={queue.key} href={queueDestinations[queue.key] || '/exceptions'} className="group flex min-h-16 items-center gap-3 px-5 py-3.5 transition-colors hover:bg-secondary/40">
                <div className="min-w-0 flex-1"><p className="text-sm font-medium">{queue.label}</p><p className="mt-0.5 text-xs text-muted-foreground">{queue.detail}</p></div>
                <span className={`flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-xs font-semibold tabular-nums ${queue.value > 0 ? 'bg-warning text-warning-foreground' : 'bg-secondary/60 text-muted-foreground'}`}>{formatNumber(queue.value)}</span>
                <ArrowRight aria-hidden="true" className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transform-none" />
              </Link>
            ))}
          </div>
        </section>

        <section className="overflow-hidden rounded-xl border bg-card shadow-sm" aria-labelledby="overview-upcoming-title">
          <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
            <div><h2 id="overview-upcoming-title" className="font-semibold">Instalments to collect</h2><p className="mt-1 text-xs text-muted-foreground">Unpaid instalments, earliest due date first.</p></div>
            <Link href="/collections" className="inline-flex min-h-8 shrink-0 items-center gap-1 text-xs font-semibold hover:underline">Open Collections<ArrowRight aria-hidden="true" className="h-3.5 w-3.5" /></Link>
          </div>
          <div className="divide-y">
            {upcoming.length === 0 && <EmptyState title="No instalments to collect">Instalments that are scheduled or in collection appear here with their due dates.</EmptyState>}
            {upcoming.map(record => (
              <Link key={record.id} href={record.customerId ? `/customers/${record.customerId}` : '/collections'} className="flex items-center justify-between gap-3 px-5 py-3.5 transition-colors hover:bg-secondary/40">
                <div className="min-w-0"><p className="text-sm font-medium">{record.name}</p><p className="mt-1 break-all text-xs text-muted-foreground">{record.reference || 'No reference'}</p></div>
                <div className="shrink-0 text-right"><StatusBadge status={record.status} /><p className="mt-1 text-xs text-muted-foreground">Due {formatCompactDate(String(record.data.dueDate || ''))}</p></div>
              </Link>
            ))}
          </div>
        </section>
      </div>

      <section className="overflow-hidden rounded-xl border bg-card shadow-sm" aria-labelledby="overview-activity-title">
        <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
          <h2 id="overview-activity-title" className="flex items-center gap-2 font-semibold"><Activity aria-hidden="true" className="h-4 w-4 text-muted-foreground" /> Recent activity</h2>
          <Link href="/audit" className="inline-flex min-h-8 items-center gap-1 text-xs font-semibold hover:underline">Open Audit log<ArrowRight aria-hidden="true" className="h-3.5 w-3.5" /></Link>
        </div>
        <ScrollFrame label="Recent activity table" className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-secondary/25 text-xs text-muted-foreground"><tr><th className="px-5 py-3 font-medium">Time</th><th className="px-5 py-3 font-medium">Change</th><th className="px-5 py-3 font-medium">Status</th><th className="px-5 py-3 text-right font-medium">Amount</th></tr></thead>
            <tbody className="divide-y">
              {overview.activity.length === 0 && <EmptyRow colSpan={4} title="No activity yet">Recent changes for this lender appear here. The audit log keeps every change.</EmptyRow>}
              {overview.activity.map(record => (
                <tr key={record.id} className="hover:bg-secondary/20">
                  <td className="whitespace-nowrap px-5 py-3 text-xs text-muted-foreground">{formatDate(record.updatedAt)}</td>
                  <td className="px-5 py-3 font-medium"><span>{readableLabel(record.name || record.kind)}</span><span className="mt-0.5 block text-xs font-normal text-muted-foreground">{typeof record.data?.actor === 'string' ? `By ${record.data.actor}` : record.reference || 'Not recorded'}</span></td>
                  <td className="px-5 py-3"><StatusBadge status={record.status} /></td>
                  <td className="px-5 py-3 text-right font-medium tabular-nums">{record.amountKobo ? formatKobo(record.amountKobo) : 'None'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollFrame>
        <div className="border-t px-5 py-2.5 text-xs text-muted-foreground">{formatCount(overview.activity.length, 'recent change')} · The audit log keeps every change.</div>
      </section>
      <ConnectedIntroduction compact />
    </div>
  );
}
