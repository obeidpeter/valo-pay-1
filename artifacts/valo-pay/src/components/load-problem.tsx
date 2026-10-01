import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { usePageProblemFocus } from '@/components/record-pagination';
import { formatDate } from '@/lib/formatters';
import { saidBy } from '@/lib/notify';

/**
 * A failed request is never presented as an empty list. One that took the place of a list's pager after a page press
 * takes its focus: `pager` names that pager (usePageProblemFocus).
 */
export function LoadProblem({ what, error, retry, busy = false, pager }: { what: string; error: unknown; retry: () => void; busy?: boolean; pager?: string | readonly string[] }) {
  const notice = useRef<HTMLDivElement>(null);
  const again = usePageProblemFocus(notice, pager);
  return (
    <div ref={notice} role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-5 text-sm">
      <p className="font-semibold">We could not load {what}</p>
      <p className="mt-2 text-muted-foreground">{saidBy(error, 'Valo Pay could not be reached. Check your connection and try again.')}</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={() => { again(); retry(); }} busy={busy} busyLabel="Trying again…">Try again</Button>
    </div>
  );
}

/** What RefreshProblem reads from a query; a TanStack Query result has every field. */
export interface RefreshableQuery { data?: unknown; error: unknown; dataUpdatedAt: number; isFetching: boolean; refetch: () => unknown }

/**
 * A background refresh that failed while earlier figures are on the page: the
 * figures stay, with a small notice that they could not be refreshed, when
 * they were last updated and a way to try again. It renders nothing unless a
 * refresh failed with data in hand, so a page shows it beside its content and
 * keeps LoadProblem for a first load that failed, when there is nothing to show.
 */
export function RefreshProblem({ what, shown = 'figures', query }: { what: string; shown?: string; query?: Partial<RefreshableQuery> }) {
  if (!query?.error || query.data === undefined) return null;
  const updated = query.dataUpdatedAt ? new Date(query.dataUpdatedAt).toISOString() : '';
  return (
    <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning-border bg-warning px-4 py-3 text-xs text-warning-foreground">
      <p><span className="font-semibold">{what} could not be refreshed.</span> {updated ? <>Showing {shown} last updated <time dateTime={updated}>{formatDate(updated)}</time>.</> : <>Showing the {shown} loaded earlier.</>}</p>
      <Button variant="outline" size="sm" busy={Boolean(query.isFetching)} busyLabel="Trying again…" onClick={() => { void query.refetch?.(); }}>Try again</Button>
    </div>
  );
}
