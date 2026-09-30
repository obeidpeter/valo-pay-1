import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'wouter';
import { useListRecords, getListRecordsQueryKey } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '@/lib/workspace-context';
import { ExportJobControl, exportKindTitle, exportStatusLabel, exportStatusLabels } from '@/components/export-job-control';
import { PilotError, PilotHeading, PilotPanel, pilotField } from '@/components/pilot-ui';
import { readableLabel } from '@/components/record-label';
import { Button } from '@/components/ui/button';
import { PageButtons } from '@/components/record-pagination';
import { keepRowsWhilePaging } from '@/lib/use-record-pagination';
import { formatDate, formatNumber } from '@/lib/formatters';
import { useFocusWhenLost } from '@/lib/focus';

/** A saved export named by what it holds and its format ("Dispute pack (JSON)"), not by its machine name ("dispute-pack · JSON"). */
function exportName(record: { name: string; data: Record<string, unknown> }): string {
  const kind = String(record.data.kind || ''), format = String(record.data.format || '').toUpperCase();
  if (!kind) return record.name;
  const what = exportKindTitle(kind, readableLabel(kind));
  return format && !what.toUpperCase().endsWith(` ${format}`) ? `${what} (${format})` : what;
}

export default function ExportsPage() {
  const { merchantId } = useWorkspace();
  return <SavedExports key={merchantId} />;
}
function SavedExports() {
  const { merchantId } = useWorkspace(), [params, setParams] = useSearchParams();
  const requested = params.get('job') || '', status = Object.keys(exportStatusLabels).includes(params.get('status') || '') ? params.get('status')! : 'all';
  const parsedOffset = Number(params.get('offset') || 0), offset = Number.isSafeInteger(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
  const query = { merchantId: merchantId!, status, offset, limit: 25 };
  // Paging keeps the jobs shown, and so the page buttons and the one pressed, until the next page arrives.
  const listKey = getListRecordsQueryKey('exports', query), client = useQueryClient();
  const list = useListRecords('exports', query, { query: { enabled: !!merchantId, queryKey: listKey, placeholderData: keepRowsWhilePaging(listKey, client), refetchInterval: 5000 } });
  const exact = { merchantId: merchantId!, id: requested, limit: 1 };
  const focusedKey = getListRecordsQueryKey('exports', exact);
  const focused = useListRecords('exports', exact, { query: { enabled: !!merchantId && !!requested, queryKey: focusedKey } });
  const selected = requested ? focused.data?.items.find(item => item.id === requested && item.merchantId === merchantId) : list.data?.items[0];
  const selectionQuery = requested ? focused : list;
  const awaitingSelection = !selected && !selectionQuery.data && !selectionQuery.error;
  const emptySelection = !selected && !!selectionQuery.data && !selectionQuery.error;
  const historyProblem = useRef<HTMLDivElement>(null), selectionProblem = useRef<HTMLDivElement>(null);
  const historyRecovered = useRef<HTMLParagraphElement>(null), selectionRecovered = useRef<HTMLParagraphElement>(null);
  const historyRecoveryKey = JSON.stringify(listKey), selectionRecoveryKey = JSON.stringify(focusedKey);
  const [historyRecovery, setHistoryRecovery] = useState<{ key: string } | null>(null), [selectionRecovery, setSelectionRecovery] = useState<{ key: string } | null>(null);
  const currentHistoryRecovery = historyRecovery?.key === historyRecoveryKey && list.data && !list.isPlaceholderData ? historyRecovery : null;
  const currentSelectionRecovery = selectionRecovery?.key === selectionRecoveryKey && focused.data ? selectionRecovery : null;
  useFocusWhenLost(historyRecovered, currentHistoryRecovery, historyProblem);
  useFocusWhenLost(selectionRecovered, currentSelectionRecovery, selectionProblem);
  const change = (nextStatus: string, nextOffset: number) => setParams(new URLSearchParams({ status: nextStatus, offset: String(nextOffset) }));
  const statusOptions = [['all','All exports'],...Object.entries(exportStatusLabels)];
  return <div className="space-y-6">
    <PilotHeading title="Saved exports">See which files are being prepared, restart any that are stuck, and download finished files. Restarting uses the same export, so no copy is made.</PilotHeading>
    <div className="flex flex-wrap items-end justify-between gap-3"><label className="space-y-2 text-sm font-medium">Export status<select className={pilotField} value={status} onChange={event => change(event.target.value, 0)}>{statusOptions.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><Button variant="outline" onClick={() => { void list.refetch(); if(requested)void focused.refetch(); }}>Refresh saved exports</Button></div>
    <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(16rem,1fr)_minmax(0,1.5fr)]">
      <PilotPanel title="Export history">
        <PilotError error={list.error} noticeRef={historyProblem} fallback="We could not load the export history. Check your connection and try again." pager="saved exports" retry={() => { void list.refetch().then(result => { if (!result.error && result.data) setHistoryRecovery({ key: historyRecoveryKey }); }); }} />
        {currentHistoryRecovery && !list.error && <p ref={historyRecovered} role="status" className="text-sm">Export history reloaded.</p>}
        {list.error && list.data && <p role="status" className="text-sm text-muted-foreground">Showing the last loaded export history. Try again to check for updates.</p>}
        {!list.data && !list.error && <p role="status">Loading saved exports…</p>}
        {list.data && !list.data.items.length && !list.error && <p className="text-sm text-muted-foreground">{status !== 'all' ? 'No exports match this status. Choose All exports in Export status to see every export for this lender.' : offset > 0 ? 'No exports on this page. Select Previous exports to go back.' : 'No exports yet. To create one, open a customer, Reports or an approved close review.'}</p>}
        {list.data && list.data.items.length > 0 && <ul className="max-h-[36rem] space-y-2 overflow-y-auto p-1">{list.data.items.map(record=><li key={record.id}><Link href={`/exports?status=${status}&offset=${offset}&job=${encodeURIComponent(record.id)}`} aria-current={selected?.id===record.id?'page':undefined} className={`block rounded-lg border p-3 text-sm ${selected?.id===record.id?'border-primary bg-primary/5':''}`}><p className="font-semibold break-words">{exportName(record)}</p><p className="mt-1 text-xs text-muted-foreground">{formatDate(record.createdAt)} · {exportStatusLabel(record)}</p></Link></li>)}</ul>}
      {!!list.data && <nav aria-label="Export history pages" className="space-y-2"><p className="text-xs text-muted-foreground">{formatNumber(list.data.items.length?offset+1:0)}–{formatNumber(Math.min(offset+(list.data.items.length||0),list.data.total))} of {formatNumber(list.data.total)}</p><div className="flex gap-2"><PageButtons label="saved exports" busy={list.isPlaceholderData} atStart={offset===0} atEnd={offset+25>=list.data.total} onPrevious={()=>change(status,Math.max(0,offset-25))} onNext={()=>change(status,offset+25)} previous="Previous exports" next="Next exports" /></div></nav>}</PilotPanel>
      <PilotPanel title="Selected export">
        {requested && <PilotError error={focused.error} noticeRef={selectionProblem} fallback="We could not load this export. Check your connection and try again." retry={() => { void focused.refetch().then(result => { if (!result.error && result.data) setSelectionRecovery({ key: selectionRecoveryKey }); }); }} />}
        {requested && currentSelectionRecovery && !focused.error && <p ref={selectionRecovered} role="status" className="text-sm">Export details reloaded.</p>}
        {selected && <>
          {selectionQuery.error && <p role="status" className="text-sm text-muted-foreground">Showing the last loaded export details. Try again to check for updates.</p>}
          <p className="break-words text-sm font-semibold">{exportName(selected)}</p><p className="break-all font-mono text-xs text-muted-foreground">Export ID: {selected.id}</p><ExportJobControl key={`${merchantId}:${selected.id}`} kind={String(selected.data.kind)} savedJobId={selected.id} formats={[]} label="Saved export" />
        </>}
        {awaitingSelection && <p role="status">{requested ? 'Loading this export…' : 'Loading the export history…'}</p>}
        {emptySelection && <p className="text-sm text-muted-foreground">{requested ? 'Export not found. It may have been deleted, or it belongs to another lender. Choose one from this lender’s export history.' : 'Select a saved export to see its progress and available actions.'}</p>}
        {!selected && !requested && list.error && <p className="text-sm text-muted-foreground">Load the export history again to choose a saved export.</p>}
      </PilotPanel>
    </div>
  </div>;
}
