import { useEffect, useState } from 'react';
import { RefreshCw, WifiOff } from 'lucide-react';
import { Button } from './ui/button';
import { formatDate } from '@/lib/formatters';

type QueueQuery = { dataUpdatedAt: number; isFetching: boolean; error: unknown; data?: unknown; refetch: () => Promise<unknown> };
export const QUEUE_STALE_AFTER_MS = 5 * 60 * 1000;

/** Uses the oldest successful response across the visible queue and its supporting records. */
export function QueueFreshness({ queries }: { queries: QueueQuery[] }) {
  const [online, setOnline] = useState(() => navigator.onLine);
  const [now, setNow] = useState(Date.now);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    const update = () => { setOnline(navigator.onLine); setNow(Date.now()); };
    window.addEventListener('online', update); window.addEventListener('offline', update);
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); window.clearInterval(timer); };
  }, []);
  const complete = queries.every(query => query.dataUpdatedAt > 0 && query.data !== undefined);
  const updatedAt = complete ? Math.min(...queries.map(query => query.dataUpdatedAt)) : 0;
  const hasData = queries.some(query => query.data !== undefined);
  const failed = queries.some(query => !!query.error);
  const busy = refreshing || queries.some(query => query.isFetching);
  const stale = updatedAt > 0 && now - updatedAt >= QUEUE_STALE_AFTER_MS;
  const refresh = async () => {
    if (!online || busy) return;
    setRefreshing(true);
    try { await Promise.allSettled(queries.map(query => query.refetch())); }
    finally { setRefreshing(false); setNow(Date.now()); }
  };
  return <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 text-xs print:hidden">
    <div role="status" className="space-y-1 text-muted-foreground">
      <p>{updatedAt ? <>Last updated <time dateTime={new Date(updatedAt).toISOString()}>{formatDate(new Date(updatedAt).toISOString())}</time></> : 'Queue has not fully loaded yet.'}</p>
      {!online ? <p className="flex items-center gap-1.5 text-warning-strong"><WifiOff className="h-3.5 w-3.5" aria-hidden="true" />Offline. {hasData ? 'Showing last loaded records. Reconnect and refresh before taking action.' : 'Reconnect to load this queue.'}</p>
        : failed ? <p className="text-destructive">Refresh did not complete. {hasData ? 'Some records may be out of date. ' : ''}Try refreshing again.</p>
        : stale ? <p className="text-warning-strong">These records were loaded more than 5 minutes ago. Refresh before taking action.</p> : null}
    </div>
    <Button variant="outline" size="sm" disabled={!online} busy={busy} busyLabel="Refreshing…" onClick={() => { void refresh(); }}><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />Refresh queue</Button>
  </div>;
}
