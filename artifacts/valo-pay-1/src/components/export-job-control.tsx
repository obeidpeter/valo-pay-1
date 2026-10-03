import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useGetExportJob, useListRecords, getListRecordsQueryKey, getGetExportJobQueryKey, type ExportResult } from '@workspace/valo-pay-1-api-client-react';
import { Download, RefreshCw } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace-context';
import { outcomeIsUnconfirmed, useSafeCreateExport, useSafeRetryExportJob } from '@/lib/safe-mutations';
import { Button } from './ui/button';
import { DiscardOriginalRequest } from './discard-original-request';
import { KEPT_IN_OPERATIONS, OpenOperations } from './pilot-ui';
import { readableLabel } from './record-label';
import { TechnicalDetails } from './technical-details';
import { formatDate, formatNumber } from '@/lib/formatters';
import { notifyDone, notifyProblem, saidBy } from '@/lib/notify';
import { exportKindName, exportPermitted, exportResultSchema, sensitiveExportRefusal } from '@workspace/valo-pay-1-schema';
import { readAnswer } from '@/lib/answers';
import { Link } from 'wouter';

type Format = 'pdf' | 'csv' | 'json';
/** The exports that are documents with their own names (exportKindName); the others are lists of one record type. */
const PACKS = ['gate-pack', 'billing', 'reviewed-close', 'dispute-pack', 'customer-pack'];
/** What a saved export holds, in the one name the service gives its saved export and its file (exportKindName): "Dispute pack". */
export function exportKindTitle(kind: string): string {
  return kind ? exportKindName(kind) : 'Saved export';
}
/**
 * A saved export's state in words: the one vocabulary Saved exports filters by, lists and shows in the export's own
 * box. `expired` is no job status: the list derives it from a file an approved deletion run deleted, which Ready to
 * download and Failed then leave out.
 */
export const exportStatusLabels: Record<string, string> = { queued: 'Waiting', running: 'In progress', ready: 'Ready to download', failed: 'Failed', expired: 'File deleted' };
/** What a checksum is for, said once where it is shown. */
const CHECKSUM_EXPLAINED = 'A checksum is a code worked out from the file’s contents. It shows exactly which file this is and that it has not changed.';
/** A saved export's state as Saved exports and the recent exports beside an export button both show it, never its machine name ("ready"). */
export function exportStatusLabel(record: { status: string; data: Record<string, unknown> }): string {
  return record.data.fileDeletedAt ? exportStatusLabels.expired! : exportStatusLabels[record.status] || readableLabel(record.status);
}

/** Exports survive page changes and reloads. Poll only the selected lender and export; downloads always re-authorise on the server. */
export function ExportJobControl({ kind, customerId, closeReviewId, savedJobId, formats = ['pdf'], label }: { kind: string; customerId?: string; closeReviewId?: string; savedJobId?: string; formats?: Format[]; label: string }) {
  const { merchantId, workspace } = useWorkspace();
  // A dispute pack, the customer register or the audit trail is for Admin, Finance and Compliance reviewer only (export_sensitive); the server refuses anyone else.
  const canOpen = !!workspace && exportPermitted(workspace.role, kind), canCreate = canOpen && workspace.role !== 'Read-only';
  const queryClient = useQueryClient();
  const scope = `${merchantId}:${kind}:${customerId || ''}:${closeReviewId || ''}:${savedJobId || ''}`;
  const visit = useRef({ scope });
  if (visit.current.scope !== scope) visit.current = { scope };
  const [selected, setSelected] = useState<{ scope: string; job: ExportResult } | null>(null);
  // Which request failed: a new export (start) or a retry or restart of a saved one, so a refusal names the right action.
  const [problem, setProblem] = useState<{ scope: string; action: 'start' | 'restart'; message: string } | null>(null);
  const title = exportKindTitle(kind);
  // What the link and the ready notice open, named once: a pack by its name, and one named after its page keeps the
  // page's capital ("billing statement", "Go-live evidence pack"). Any other export holds records whose name is also
  // a page's, so it is the saved export.
  const opened = !PACKS.includes(kind) ? 'saved export' : kind === 'gate-pack' ? title : title.charAt(0).toLowerCase() + title.slice(1);
  const openLabel = `Open ${opened}`;
  // Search the saved review identity before paging, then enforce the exact match.
  const params = { merchantId: merchantId!, customerId, search: closeReviewId || kind, limit: 5 };
  const recent = useListRecords('exports', params, { query: { enabled: !!merchantId && !savedJobId, queryKey: getListRecordsQueryKey('exports', params), refetchInterval: savedJobId ? false : 5000 } });
  const previous = savedJobId ? [] : recent.data?.items.filter(record => record.data.kind === kind && (!customerId || record.customerId === customerId) && (!closeReviewId || record.data.closeReviewId === closeReviewId)) || [];
  const selectedJob = selected?.scope === scope ? selected.job : undefined;
  const id = savedJobId || selectedJob?.id || previous[0]?.id || '';
  const status = useGetExportJob(id, { merchantId: merchantId! }, { query: { enabled: !!merchantId && !!id, queryKey: getGetExportJobQueryKey(id, { merchantId: merchantId! }), select: value => {
    if (readAnswer(exportResultSchema, value) === undefined || value.id !== id || !['queued','running','ready','failed'].includes(value.status || '') || (value.status === 'ready' && !/^[a-f0-9]{64}$/i.test(value.checksum || ''))) throw new Error('We could not check this export’s status. Refresh the export status.');
    const download = new URL(value.downloadUrl, window.location.origin);
    if (download.origin !== window.location.origin || download.pathname !== `/api/v1/exports/${encodeURIComponent(id)}/download` || download.searchParams.get('merchantId') !== merchantId) throw new Error('We could not check this export’s download link. Refresh the export status.');
    return value;
  }, refetchInterval: query => ['queued', 'running'].includes(query.state.data?.status || '') ? 1500 : false } });
  const job = status.data || selectedJob;
  const state = job?.expiredAt ? 'expired' : job?.status || (job?.checksum ? 'ready' : undefined);
  const create = useSafeCreateExport(undefined, scope);
  const retry = useSafeRetryExportJob(undefined, scope);
  const announce = (result: ExportResult, immediate = false) => {
    if (!canOpen || result.expiredAt || (result.status || 'ready') !== 'ready' || !result.checksum) return;
    const tab = immediate ? window.open(result.downloadUrl, '_blank') : undefined;
    notifyDone(`${opened.charAt(0).toUpperCase()}${opened.slice(1)} ready`, `${immediate ? (tab ? 'The file opened in a new tab.' : 'Your browser blocked the new tab. Select Open to view the file.') : 'Select Open to view the file.'} Sample data only.`, { label: 'Open', altText: `Open the ${opened} in a new tab`, onClick: () => { window.open(result.downloadUrl, '_blank'); } });
  };
  const announced = useRef(new Set<string>());
  useEffect(() => {
    if (selected?.scope === scope && state === 'ready' && job && !announced.current.has(job.id)) { announced.current.add(job.id); announce(job); }
  }, [scope, job?.id, state]);
  useEffect(() => { visit.current = { scope }; return () => { visit.current = { scope: 'unmounted' }; }; }, [scope]);
  const refresh = async () => { if (!savedJobId) await recent.refetch(); };
  const refreshStatus = () => { if (!savedJobId) void recent.refetch(); if (id) void status.refetch(); };
  const start = async (format: Format, recover = false) => {
    if (!merchantId || !canCreate || create.isPending) return;
    const submitted = visit.current; setProblem(null);
    try {
      const result = await (recover ? create.retryUnconfirmed() : create.mutateAsync({ data: { kind, format, ...(customerId ? { customerId } : {}), ...(closeReviewId ? { closeReviewId } : {}) }, params: { merchantId } }));
      if (submitted !== visit.current) return;
      setSelected({ scope, job: { ...result, kind, format } });
      queryClient.setQueryData(getGetExportJobQueryKey(result.id, { merchantId }), result);
      if ((result.status || 'ready') === 'ready') { announced.current.add(result.id); announce(result, true); }
      void refresh();
    } catch (error) {
      if (submitted === visit.current) {
        setProblem({ scope, action: 'start', message: saidBy(error, 'We do not know yet whether Valo Pay 1 received this request. Check the original request before you start another.') });
        if (kind === 'dispute-pack') notifyProblem(outcomeIsUnconfirmed(error) ? 'Dispute pack request not confirmed' : 'Dispute pack not started', `${saidBy(error, 'We do not know yet whether Valo Pay 1 received this request.')} Check saved exports before you start another request.`);
      }
    }
  };
  const retrySaved = async () => {
    if (!merchantId || !canCreate || !id || retry.isPending) return;
    const submitted = visit.current; setProblem(null);
    try {
      const result = await (retry.hasUnconfirmedOutcome ? retry.retryUnconfirmed() : retry.mutateAsync({ id, params: { merchantId } }));
      if (submitted !== visit.current) return;
      setSelected({ scope, job: result }); queryClient.setQueryData(getGetExportJobQueryKey(result.id, { merchantId }), result); void refresh();
    } catch (error) { if (submitted === visit.current) setProblem({ scope, action: 'restart', message: saidBy(error, 'We do not know yet whether Valo Pay 1 received the retry. Check this export’s status before you try again.') }); }
  };
  if (!merchantId) return null;
  return <div className="space-y-3 min-w-0 max-w-xl">
    <div className="flex flex-wrap gap-2">
      {formats.map((format, index) => <Button key={format} variant={index === 0 ? 'outline' : 'ghost'} size="sm" disabled={!canCreate || create.isPending || retry.isPending || create.hasUnconfirmedOutcome || retry.hasUnconfirmedOutcome} busy={create.isPending && create.variables?.data.format === format} busyLabel={`Preparing ${format.toUpperCase()}…`} onClick={() => { void start(format); }}>
        {index === 0 && <Download className="h-4 w-4" />}{index === 0 ? label : format.toUpperCase()}
      </Button>)}
    </div>
    {!canOpen ? <p className="text-xs text-muted-foreground">{sensitiveExportRefusal} Ask one of them for this file.</p> : !canCreate && <p className="text-xs text-muted-foreground">With read-only access you can download files that already exist. To create or retry an export, ask a team member with another role.</p>}
    {problem?.scope === scope && <div role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm"><p className="font-medium">{create.hasUnconfirmedOutcome || retry.hasUnconfirmedOutcome ? 'Request not confirmed' : problem.action === 'restart' ? 'Export not restarted' : 'Export not started'}</p><p>{problem.message}</p><p className="mt-2">Check saved exports before you start another request.</p><Button className="mt-2" variant="outline" size="sm" onClick={refreshStatus}>Check saved exports</Button></div>}
    {(create.hasUnconfirmedOutcome || retry.hasUnconfirmedOutcome) && <div className="rounded-lg border bg-secondary/20 p-3 text-sm"><p>Other export requests wait until this one is confirmed. Checking the original request does not create a second export. {KEPT_IN_OPERATIONS}</p><div className="mt-2 flex flex-wrap items-center gap-3"><Button variant="outline" size="sm" disabled={!canCreate} busy={create.isPending || retry.isPending} busyLabel="Checking original request…" onClick={() => { if (create.hasUnconfirmedOutcome) void start(create.variables!.data.format as Format, true); else void retrySaved(); }}>Check original request</Button><OpenOperations /><DiscardOriginalRequest disabled={create.isPending || retry.isPending} onDiscard={() => { create.abandonUnconfirmed(); retry.abandonUnconfirmed(); setProblem(null); }} /></div></div>}
    {(recent.error || status.error) && <div role="alert" className="text-sm"><p>We could not load the export status. The export may still be in progress.</p><Button variant="outline" size="sm" onClick={refreshStatus}>Refresh export status</Button></div>}
    {job && <div role={state === 'failed' ? 'alert' : 'status'} className="rounded-lg border bg-card p-3 text-sm space-y-2">
      <p className="font-medium">{title}: {exportStatusLabels[state ?? 'queued'] ?? readableLabel(state)}</p>
      {state === 'expired' && <><p className="text-muted-foreground">This file was deleted on {formatDate(job.expiredAt!)} under the lender’s data retention policy. Create a new export if you need the file.</p><p className="text-xs text-muted-foreground">A deletion record is saved with the deletion run that deleted it.{job.retentionRunId && workspace?.role !== 'Admin' ? ' An Admin can open it from this export.' : ''}</p>{job.retentionRunId && workspace?.role === 'Admin' && <Link href={`/lifecycle?run=${encodeURIComponent(job.retentionRunId)}`} className="inline-flex min-h-9 items-center text-xs text-primary underline">Open the deletion record</Link>}<TechnicalDetails explanation={job.checksum ? CHECKSUM_EXPLAINED : 'This export did not finish, so it had no checksum, the code that identifies a finished file.'}>{job.checksum && <p>Checksum (SHA-256) of the deleted file: {job.checksum}</p>}{job.retentionRunId && <p>Deletion run: {job.retentionRunId}</p>}</TechnicalDetails></>}
      {(state === 'queued' || state === 'running') && <><p className="text-muted-foreground">You can leave this page. The export and its progress will still be here when you return.</p>{job.stage && <p className="font-medium">{({queued:'Waiting to start',checking:'Checking for a finished copy',rendering:'Preparing the file',uploading:'Saving the file',confirming:'File saved; finishing',ready:'Ready to download',failed:'Stopped'})[job.stage]}</p>}{job.lastProgressAt && <p className="text-xs text-muted-foreground">Last progress: {formatDate(job.lastProgressAt)}</p>}</>}
      {job.stalled && (state==='queued'||state==='running') && <div role="alert" className="space-y-2 rounded-lg border border-warning-border bg-warning/10 p-3"><p className="font-medium">This export seems to be stuck</p><p>No progress has been recorded for a while. Your request and any finished file are kept. Restarting uses the same export, so no copy is made.</p>{job.retryAllowed ? <Button variant="outline" size="sm" disabled={!canCreate || create.isPending || create.hasUnconfirmedOutcome || retry.hasUnconfirmedOutcome} onClick={() => { void retrySaved(); }} busy={retry.isPending} busyLabel="Restarting…">Restart export</Button> : <p>{job.recoveryAt ? `You can restart this export after ${formatDate(job.recoveryAt)}. Refresh the page then.` : 'The export is waiting to start. If it does not start soon, contact the Valo Pay 1 team.'}</p>}<Button variant="outline" size="sm" onClick={refreshStatus}>Check this export</Button></div>}
      {state === 'failed' && <><p>{job.error || 'The file could not be prepared. Retry the export.'}</p><Button variant="outline" size="sm" disabled={!canCreate || create.isPending || create.hasUnconfirmedOutcome || retry.hasUnconfirmedOutcome} onClick={() => { void retrySaved(); }} busy={retry.isPending} busyLabel="Retrying…"><RefreshCw className="h-4 w-4" />Retry export</Button></>}
      {state === 'ready' && <><p className="text-xs text-muted-foreground">Sample data only{job.generatedAt ? ` · ${formatDate(job.generatedAt)}` : ''}</p>{canOpen && <Button asChild variant="outline" size="sm"><a href={job.downloadUrl} target="_blank" rel="noopener noreferrer">{openLabel}</a></Button>}<TechnicalDetails explanation={CHECKSUM_EXPLAINED}><p>Checksum (SHA-256): {job.checksum}</p><p className="font-sans text-muted-foreground">Access is checked every time the file is downloaded. After the lender’s retention period, this file can be deleted by an approved deletion run in Data retention. The checksum and a deletion record are kept. Copies already downloaded cannot be recalled.</p></TechnicalDetails></>}
    </div>}
    {!savedJobId && id && <Link href={`/exports?job=${encodeURIComponent(id)}`} className="inline-flex min-h-9 items-center text-xs text-primary underline">Open Saved exports</Link>}
    {previous.length > 1 && <details className="text-xs"><summary className="cursor-pointer font-medium">Recent exports ({formatNumber(previous.length)})</summary><ul className="mt-2 space-y-1">{previous.map(record => <li key={record.id}><button type="button" className="min-h-8 text-left underline" onClick={() => setSelected({ scope, job: { id: record.id, downloadUrl: `/api/v1/exports/${record.id}/download?merchantId=${merchantId}`, status: record.status as ExportResult['status'] } })}>{String(record.data.format).toUpperCase()} · {formatDate(record.createdAt)} · {exportStatusLabel(record)}</button></li>)}</ul></details>}
  </div>;
}
