import { browserStorageKey } from '@/lib/browser-identity';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'wouter';
import { Bookmark, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { useWorkspace } from '@/lib/workspace-context';

/** A view keeps its filters, never search text: a search stored by hand is dropped as the view is read. */
type SavedView = { name: string; view: string; owner: string; type: string };
function readViews(key: string, views: readonly string[]): SavedView[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) || '[]');
    if (!Array.isArray(saved)) return [];
    return saved.filter((item): item is SavedView => !!item && typeof item === 'object' && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 40 && views.includes(item.view) && typeof item.owner === 'string' && item.owner.length <= 200 && typeof item.type === 'string' && item.type.length <= 200)
      .slice(0, 10).map(({ name, view, owner, type }) => ({ name, view, owner, type }));
  } catch { return []; }
}
/** Views an earlier build saved, with their search text, under keys nothing reads: removed when saved views show, so a
 * browser holds them no longer than its first visit to a queue with this build. */
const EARLIER_VIEWS = browserStorageKey('queue-views-v1:');
function removeEarlierViews() {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(EARLIER_VIEWS)) localStorage.removeItem(key);
  } catch { /* storage blocked: nothing can be read from it either */ }
}

export function SavedQueueViews({ queue, views, fallback }: { queue: string; views: readonly string[]; fallback: string }) {
  const { merchantId, workspace } = useWorkspace();
  useEffect(removeEarlierViews, []);
  const scope = workspace?.viewerScope || workspace?.actor || 'anonymous';
  return merchantId ? <SavedViews key={`${scope}:${merchantId}:${queue}`} storageKey={browserStorageKey(`queue-views-v2:${scope}:${merchantId}:${queue}`)} views={views} fallback={fallback} /> : null;
}

function SavedViews({ storageKey, views, fallback }: { storageKey: string; views: readonly string[]; fallback: string }) {
  const [search, setSearch] = useSearchParams();
  const [saved, setSaved] = useState(() => readViews(storageKey, views));
  const [name, setName] = useState(''), [message, setMessage] = useState(''), [error, setError] = useState('');
  const persist = (next: SavedView[]) => {
    try { localStorage.setItem(storageKey, JSON.stringify(next)); setSaved(next); setError(''); return true; }
    catch { setError('This browser could not save the view. You can still bookmark this page or copy its address.'); return false; }
  };
  return <details className="rounded-xl border bg-card print:hidden">
    <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium"><Bookmark aria-hidden="true" className="h-4 w-4 text-muted-foreground" />Saved views<span className="text-xs font-normal text-muted-foreground">{saved.length ? `${saved.length} saved` : 'Keep your usual filters'}</span></summary>
    <div className="space-y-3 border-t p-4">
      <p className="text-xs text-muted-foreground">Saved in this browser for you, this lender and this list. A view keeps your filters but not your search text. Results are up to date each time you open a view.</p>
      {saved.length > 0 && <ul className="flex flex-wrap gap-2">{saved.map(item => <li key={item.name} className="flex max-w-full min-w-0 items-center rounded-lg border">
        <Button variant="ghost" size="sm" className="min-w-0 flex-1" title={item.name} onClick={() => {
          setSearch(current => {
            const next = new URLSearchParams(current);
            for (const key of ['view', 'owner', 'type', 'q', 'page', 'record', 'lender', 'returnTo', 'dueItem']) next.delete(key);
            for (const key of ['view', 'owner', 'type'] as const) if (item[key]) next.set(key, item[key]);
            return next;
          });
          setMessage(`Opened ${item.name}.`);
        }}><span className="truncate">{item.name}</span></Button>
        <Button variant="ghost" size="icon" aria-label={`Delete saved view ${item.name}`} onClick={() => { if (persist(saved.filter(view => view.name !== item.name))) setMessage(`Deleted ${item.name}.`); }}><Trash2 aria-hidden="true" className="h-3.5 w-3.5" /></Button>
      </li>)}</ul>}
      <form className="flex flex-wrap items-end gap-2" onSubmit={event => {
        event.preventDefault(); setMessage('');
        const trimmed = name.trim();
        if (!trimmed) { setError('Enter a name for this view.'); return; }
        if (saved.some(item => item.name.toLowerCase() === trimmed.toLowerCase())) { setError('That name is already saved. Choose a different name or delete the existing view.'); return; }
        if (saved.length >= 10) { setError('You can save up to 10 views for each list. Delete a view before you add another.'); return; }
        const candidate = search.get('view') || fallback;
        if (persist([...saved, { name: trimmed, view: views.includes(candidate) ? candidate : fallback, owner: search.get('owner') || '', type: search.get('type') || '' }])) { setName(''); setMessage(`Saved ${trimmed}.`); }
      }}>
        <label className="grid gap-1 text-xs font-medium">View name<input value={name} maxLength={40} onChange={event => setName(event.target.value)} className="min-h-10 max-w-full rounded-md border bg-background px-3 text-sm" placeholder="For example, overdue Finance" /></label>
        <Button type="submit" variant="outline">Save current view</Button>
      </form>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <p role="status" className="text-xs text-muted-foreground">{message}</p>
    </div>
  </details>;
}
