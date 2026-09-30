import { ExportJobControl } from '@/components/export-job-control';
import React, { useEffect, useRef, useState } from 'react';
import { ScrollFrame } from '@/components/scroll-frame';
import { EmptyRow } from '@/components/empty-state';
import { Loading, LoadingRow } from '@/components/loading';
import { useWorkspace } from '@/lib/workspace-context';
import { useGetGates, useListRecords, getGetGatesQueryKey, getListRecordsQueryKey } from '@workspace/api-client-react';
import { ShieldCheck, AlertTriangle, FileCheck, CheckCircle, Search } from 'lucide-react';
import { PermissionButton as Button } from '@/components/permission-button';
import { formatCount, formatKobo, formatDate, formatNumber, formatPercent } from '@/lib/formatters';
import { RecordDialog } from '@/components/record-dialog';
import { readableLabel } from '@/components/record-label';
import { LoadProblem } from '@/components/load-problem';
import { ReviewDialog, reviewJobs } from '@/components/review-dialog';
import { discountTermsStatus, termsReplaced } from '@workspace/valopay-schema';

/**
 * A design partner's discount dates as the service reads them, in its words: why the terms cannot price a new invoice,
 * or the confirmed dates, and who proposed and confirmed them. Unsigned terms bill nothing, and replaced terms (other
 * signed terms start billing in the same month and come first, `termsReplaced`) bill no month, so neither carries a
 * note. Display only: invoice authority remains server-side.
 */
function DiscountTermsNote({ data, replaced }: { data: unknown; replaced: boolean }) {
  const status = discountTermsStatus(data);
  if (status.state === 'full_price' || status.state === 'unsigned' || replaced) return null;
  const terms = data as Record<string, unknown>;
  return <div className="mt-1 max-w-64 space-y-1 text-xs">
    {status.ready ? <p className="text-muted-foreground">Discount from {formatDate(String(terms.discountStartDate))}; full price from {formatDate(String(terms.fullPriceStartDate))}.</p> : <p className="text-warning-strong">{status.explanation}</p>}
    {status.proposal && <p className="text-muted-foreground">Proposed by {status.proposal.by} · {formatDate(status.proposal.at)}</p>}
    {status.confirmation && <p className="text-muted-foreground">Confirmed by {status.confirmation.by} · {formatDate(status.confirmation.at)}</p>}
  </div>;
}

/** What a second person checks before confirming proposed discount dates, and what confirming records. */
function ConfirmDiscountContext({ data }: { data: Record<string, unknown> }) {
  const proposal = discountTermsStatus(data).proposal;
  return <div className="space-y-2 rounded-lg border bg-secondary/20 p-3 text-sm">
    <p>Check these against the signed agreement before you confirm: 50% discount from {formatDate(String(data.discountStartDate))}; full price from {formatDate(String(data.fullPriceStartDate))}; signed agreement reference {String(data.discountTermsReference)}.</p>
    {proposal && <p className="text-muted-foreground">Proposed by {proposal.by} · {formatDate(proposal.at)}</p>}
    <p className="text-muted-foreground">Confirming records your demo role or staff account as the second person, with the time. New invoices are then priced from these dates; issued invoices stay unchanged.</p>
  </div>;
}

/**
 * The requirement and decision ids the evidence register matches evidence on (data.gateId), named as the go-live
 * requirements name them. Only P1 to P5 keep their code, as a tag beside the name; the other codes stay in the data.
 */
const gateOptions = [
  { value: 'P1', label: 'P1 · Legal opinion' },
  { value: 'P2', label: 'P2 · Aggregator partner access' },
  { value: 'P3', label: 'P3 · Permission to process data' },
  { value: 'P4', label: 'P4 · Security and operational readiness' },
  { value: 'P5', label: 'P5 · Two design-partner lenders' },
  { value: 'F1', label: 'Stage 2 funding: both lenders pass the operational test' },
  { value: 'F2', label: 'Stage 2 funding: signed prices meet the list-price test' },
  { value: 'F3', label: 'Stage 2 funding: variable cost of ₦15 or less per collection' },
  { value: 'F4', label: 'Stage 2 funding: money for at least three months of running costs' },
  { value: 'T1b', label: 'Provider choice at setup' },
  { value: 'T2', label: 'Recovery fee' },
];

export default function EvidencePage() {
  const { merchantId } = useWorkspace();
  const [selectedRecord, setSelectedRecord] = useState<any>(null);
  const [actionKind, setActionKind] = useState<'evidence' | 'commercial' | ''>('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [gateFilter, setGateFilter] = useState('all');
  const [confirming, setConfirming] = useState<any>(null);
  const [termsNotice, setTermsNotice] = useState('');
  const termsAnswer = useRef<HTMLParagraphElement>(null);
  useEffect(() => { setSearch(''); setGateFilter('all'); setIsDialogOpen(false); setReviewOpen(false); setConfirming(null); setTermsNotice(''); }, [merchantId]);

  const { data: gates, isLoading: isLoadingGates, error: gatesError, refetch: retryGates, isFetching: fetchingGates } = useGetGates(
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getGetGatesQueryKey({ merchantId: merchantId! }) } }
  );

  const { data: commercial, isLoading: isLoadingComm, error: commercialError, refetch: retryCommercial, isFetching: fetchingCommercial } = useListRecords(
    'commercial',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('commercial', { merchantId: merchantId! }) } }
  );

  const { data: evidence, isLoading: isLoadingEvidence, error: evidenceError, refetch: retryEvidence, isFetching: fetchingEvidence } = useListRecords(
    'evidence',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('evidence', { merchantId: merchantId! }) } }
  );

  const { data: reviews, isLoading: isLoadingReviews, error: reviewsError, refetch: retryReviews, isFetching: fetchingReviews } = useListRecords(
    'reviews',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('reviews', { merchantId: merchantId! }) } }
  );


  const handleCreate = (kind: 'evidence' | 'commercial') => {
    setSelectedRecord(null);
    setActionKind(kind);
    setIsDialogOpen(true);
  };

  const handleEdit = (record: any, kind: 'evidence' | 'commercial') => {
    setSelectedRecord(record);
    setActionKind(kind);
    setIsDialogOpen(true);
  };

  if (!merchantId) return null;
  const fold = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const evidenceRows = (evidence?.items || []).filter(item => {
    const gate = String(item.data?.gateId || item.reference);
    const label = gateOptions.find(option => option.value === gate)?.label || gate;
    return (gateFilter === 'all' || gate === gateFilter) && fold(`${item.name} ${label} ${item.status} ${JSON.stringify(item.data)}`).includes(fold(search.trim()));
  });

  return (
    <div className="space-y-8">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Go-live evidence</h1>
          <p className="text-muted-foreground mt-1">Track the go-live requirements, the commercial terms and the evidence for each decision. Sample data cannot show that you are ready to go live.</p>
        </div>
        <ExportJobControl kind="gate-pack" formats={['pdf']} label="Export evidence pack" />
      </header>

      {/* Gates */}
      <section className="bg-card border rounded-xl shadow-sm overflow-hidden">
        <div className="p-4 border-b bg-secondary/20 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            <h2 className="font-semibold text-lg">Go-live requirements</h2>
          </div>
          {gates?.limitations.length ? (
            <span className="text-xs font-medium bg-destructive/10 text-destructive px-2 py-1 rounded border border-destructive/20 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" /> Not ready to go live
            </span>
          ) : (
            <span className="text-xs font-medium bg-success/10 text-success px-2 py-1 rounded border border-success/20 flex items-center gap-1">
              <CheckCircle className="h-3 w-3" /> {gates ? 'Requirements recorded' : 'Not yet checked'}
            </span>
          )}
        </div>
        
        {isLoadingGates ? (
          <Loading what="go-live requirements" />
        ) : gatesError || !gates ? (
          <LoadProblem what="go-live requirements" error={gatesError} retry={() => { void retryGates(); }} busy={fetchingGates} />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-0 divide-y md:divide-y-0 md:divide-x">
            <div className="p-6">
              <h3 className="font-medium text-muted-foreground text-xs mb-4 flex justify-between">
                Requirements
                <a href="#evidence-register" className="text-primary underline">Go to the evidence register</a>
              </h3>
              <div className="space-y-4">
                {gates.prerequisites.map(gate => (
                  <div key={gate.id} className="flex gap-3">
                    {gate.status === 'proven' ? 
                      <CheckCircle className="h-5 w-5 text-success shrink-0" /> : 
                      <AlertTriangle className="h-5 w-5 text-warning-strong shrink-0" />
                    }
                    <div>
                      <p className="font-medium text-sm">{gate.title}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{gate.description}</p>
                      <p className="text-xs font-mono text-muted-foreground mt-1 bg-secondary/50 inline-block px-1.5 py-0.5 rounded">Evidence: {gate.evidence}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            
            <div className="p-6">
              <h3 className="font-medium text-muted-foreground text-xs mb-4">Decisions</h3>
              <div className="space-y-4">
                {gates.decisions.map(gate => (
                  <div key={gate.id} className="flex gap-3">
                    {gate.status === 'proven' ? 
                      <CheckCircle className="h-5 w-5 text-success shrink-0" /> : 
                      <AlertTriangle className="h-5 w-5 text-warning-strong shrink-0" />
                    }
                    <div>
                      <p className="font-medium text-sm">{gate.title}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{gate.description}</p>
                    </div>
                  </div>
                ))}
              </div>
              
              {gates.limitations.length > 0 && (
                <div className="mt-8 bg-destructive/5 border border-destructive/20 rounded-lg p-4">
                  <h4 className="text-sm font-bold text-destructive flex items-center gap-2 mb-2">
                    <AlertTriangle className="h-4 w-4" /> What this sandbox cannot show
                  </h4>
                  <ul className="list-disc list-inside text-xs text-destructive ml-4 space-y-1">
                    {gates.limitations.map((lim, i) => <li key={i}>{lim}</li>)}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      <section id="evidence-register" aria-labelledby="evidence-register-title" className="scroll-mt-6 rounded-xl border bg-card shadow-sm overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-5">
          <div><h2 id="evidence-register-title" className="text-lg font-semibold">Evidence register</h2><p className="mt-1 text-sm text-muted-foreground">Evidence for each requirement and decision, including funding, recovery and provider choice. Adding evidence here does not mean a live requirement is met.</p></div>
          <Button size="sm" kind="evidence" onClick={() => handleCreate('evidence')}>Add evidence</Button>
        </div>
        <div className="flex flex-col gap-3 border-b p-5 sm:flex-row print:hidden">
          <div className="relative flex-1"><Search aria-hidden="true" className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><input aria-label="Search evidence" placeholder="Search by title, owner or reference…" value={search} onChange={event => setSearch(event.target.value)} className="w-full rounded-md border bg-background py-2.5 pl-9 pr-3 text-sm" /></div>
          <select aria-label="Filter evidence by requirement" value={gateFilter} onChange={event => setGateFilter(event.target.value)} className="min-w-0 rounded-md border bg-background px-3 py-2 text-sm sm:max-w-xs">
            <option value="all">All requirements and decisions</option>
            {gateOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
        {evidenceError ? <LoadProblem what="evidence" error={evidenceError} retry={() => { void retryEvidence(); }} busy={fetchingEvidence} /> : <ScrollFrame label="Evidence register table" className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-secondary/30 text-muted-foreground"><tr>{['Evidence', 'Requirement or decision', 'Owner', 'Date', 'Status', 'Action'].map(label => <th key={label} scope="col" className="px-5 py-3 font-medium">{label}</th>)}</tr></thead>
            <tbody className="divide-y">
              {isLoadingEvidence ? <LoadingRow colSpan={6} what="evidence" /> : evidenceRows.length === 0 ? <EmptyRow colSpan={6} title={search || gateFilter !== 'all' ? 'No evidence matches these filters' : 'No evidence yet'}>{search || gateFilter !== 'all' ? <Button variant="link" onClick={() => { setSearch(''); setGateFilter('all'); }}>Clear filters</Button> : 'Select Add evidence to record the first one.'}</EmptyRow> : evidenceRows.map(item => {
                const gate = String(item.data?.gateId || item.reference);
                return <tr key={item.id} className="hover:bg-secondary/10">
                  <td className="max-w-sm px-5 py-4"><p className="font-medium">{item.name}</p><p className="mt-1 break-all text-xs text-muted-foreground">{String(item.data?.reference || item.reference || 'No reference')}</p></td>
                  <td className="px-5 py-4 text-xs">{gateOptions.find(option => option.value === gate)?.label || gate || 'Not assigned'}</td>
                  <td className="px-5 py-4">{String(item.data?.owner || 'Not assigned')}</td>
                  <td className="whitespace-nowrap px-5 py-4 text-xs text-muted-foreground">{formatDate(String(item.data?.evidenceDate || item.createdAt))}{!item.data?.evidenceDate && <span className="mt-1 block">Date added</span>}</td>
                  <td className="px-5 py-4"><span className="rounded-md bg-secondary/50 px-2 py-1 text-xs">{readableLabel(item.status)}</span></td>
                  <td className="px-5 py-4"><Button size="sm" variant="outline" aria-label={`Edit evidence: ${item.name}`} kind="evidence" record={item} onClick={() => handleEdit(item, 'evidence')}>Edit</Button></td>
                </tr>;
              })}
            </tbody>
          </table>
        </ScrollFrame>}
      </section>

      {/* Commercial terms */}
      <section className="bg-card border rounded-xl shadow-sm overflow-hidden">
        <div className="p-4 border-b bg-secondary/20 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileCheck className="h-5 w-5 text-primary" />
            <h2 className="font-semibold text-lg">Commercial terms</h2>
          </div>
          <Button size="sm" kind="commercial" onClick={() => handleCreate('commercial')}>Add terms</Button>
        </div>
        <div role="status">{termsNotice && <p ref={termsAnswer} tabIndex={-1} className="border-b bg-secondary/20 px-4 py-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">{termsNotice}</p>}</div>
        <ScrollFrame label="Commercial terms" className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-secondary/30 border-b text-muted-foreground">
              <tr>
                <th className="px-6 py-4 font-medium">Lender</th>
                <th className="px-6 py-4 font-medium">Monthly collections</th>
                <th className="px-6 py-4 font-medium">Average collection</th>
                <th className="px-6 py-4 font-medium">Licence</th>
                <th className="px-6 py-4 font-medium">Usage fees</th>
                <th className="px-6 py-4 font-medium">Status</th>
                <th className="px-6 py-4 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoadingComm ? (
                <LoadingRow colSpan={7} what="commercial terms" />
              ) : commercialError ? (
                <tr><td colSpan={7}><LoadProblem what="commercial terms" error={commercialError} retry={() => { void retryCommercial(); }} busy={fetchingCommercial} /></td></tr>
              ) : !commercial || commercial.items.length === 0 ? (
                <EmptyRow colSpan={7} title="No commercial terms yet">Select Add terms to record signed terms, licence plans and prices. They count towards the go-live requirements.</EmptyRow>
              ) : (
                commercial.items.map(comm => (
                  <tr key={comm.id} className="hover:bg-secondary/10">
                    <td className="px-6 py-4 font-medium">{comm.name}</td>
                    <td className="px-6 py-4 font-mono">{formatNumber(Number(comm.data?.monthlyVolume || 0))}</td>
                    <td className="px-6 py-4 font-mono">{formatKobo(Number(comm.data?.averageTicketKobo || 0))}</td>
                    <td className="px-6 py-4 font-mono">{formatKobo(Number(comm.data?.licenceKobo || 0))}</td>
                    <td className="px-6 py-4 font-mono text-xs text-muted-foreground">
                      {formatPercent(Number(comm.data?.usageBps || 30) / 10000)} (up to {formatKobo(Number(comm.data?.usageCapKobo || 15000))} per collection)
                    </td>
                    <td className="px-6 py-4">
                      {comm.data?.signed ? (
                        <span className="text-success text-xs font-bold flex items-center gap-1"><CheckCircle className="h-3 w-3" /> Signed</span>
                      ) : (
                        <span className="text-warning-strong text-xs font-bold">Not signed</span>
                      )}
                      {!!comm.data?.effectiveDate && <p className="text-[10px] text-muted-foreground mt-1">From {formatDate(String(comm.data.effectiveDate))}</p>}
                      <DiscountTermsNote data={comm.data} replaced={termsReplaced(comm, commercial.items)} />
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex flex-col items-end gap-2">
                        <Button size="sm" variant="outline" kind="commercial" record={comm} onClick={() => handleEdit(comm, 'commercial')}>Edit</Button>
                        {discountTermsStatus(comm.data).state === 'awaiting_confirmation' && !termsReplaced(comm, commercial.items) && <Button size="sm" action="confirm_discount_terms" record={comm} onClick={() => setConfirming(comm)}>Confirm discount dates</Button>}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </ScrollFrame>
      </section>

      {/* Reviews every two weeks */}
      <section className="bg-card border rounded-xl shadow-sm overflow-hidden">
        <div className="p-4 border-b bg-secondary/20 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileCheck className="h-5 w-5 text-primary" />
            <h2 className="font-semibold text-lg">Reviews every two weeks</h2>
          </div>
          <Button size="sm" kind="reviews" onClick={() => setReviewOpen(true)}>Record review</Button>
        </div>
        <ScrollFrame label="Reviews every two weeks" className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-secondary/30 border-b text-muted-foreground">
              <tr>
                <th className="px-6 py-4 font-medium">Review date</th>
                <th className="px-6 py-4 font-medium">Reviewer</th>
                <th className="px-6 py-4 font-medium">Tasks confirmed</th>
                <th className="px-6 py-4 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoadingReviews ? (
                <LoadingRow colSpan={4} what="reviews" />
              ) : reviewsError ? (
                <tr><td colSpan={4}><LoadProblem what="reviews" error={reviewsError} retry={() => { void retryReviews(); }} busy={fetchingReviews} /></td></tr>
              ) : !reviews || reviews.items.length === 0 ? (
                <EmptyRow colSpan={4} title="No reviews yet">Every two weeks, select Record review and tick the tasks you checked: mandate operations, retries, payment matching, and audit and dispute records. Valo Pay records the review in your name, with the time it is saved.</EmptyRow>
              ) : (
                reviews.items.map(rev => (
                  <tr key={rev.id} className="hover:bg-secondary/10">
                    <td className="px-6 py-4 font-mono text-xs">{formatDate(String(rev.data?.reviewedAt || rev.createdAt))}</td>
                    <td className="px-6 py-4 font-medium">{String(rev.data?.reviewer || 'Not recorded')}</td>
                    <td className="px-6 py-4 text-xs">{Array.isArray(rev.data?.confirmedJobs) ? reviewJobs.filter(job => (rev.data!.confirmedJobs as string[]).includes(job.value)).map(job => job.label).join(', ') || 'No tasks confirmed' : `${formatCount(Number(rev.data?.confirmedJobs || 0), 'task')} (an older review that did not save task names)`}</td>
                    <td className="px-6 py-4 text-xs text-muted-foreground">{String(rev.data?.note || 'No notes')}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </ScrollFrame>
      </section>
      {reviewOpen && <ReviewDialog onClose={() => setReviewOpen(false)} />}

      <RecordDialog
        kind="commercial"
        record={confirming}
        isOpen={!!confirming}
        onOpenChange={open => { if (!open) setConfirming(null); }}
        title="Confirm discount dates"
        actionMutation="confirm_discount_terms"
        fields={[]}
        defaultValues={{ data: { discountStartDate: confirming?.data?.discountStartDate, fullPriceStartDate: confirming?.data?.fullPriceStartDate, discountTermsReference: confirming?.data?.discountTermsReference } }}
        context={confirming && <ConfirmDiscountContext data={confirming.data} />}
        onDone={response => setTermsNotice(String(response?.message || 'Discount dates confirmed.'))}
        answer={() => termsAnswer.current}
      />
      <RecordDialog
        kind={actionKind || 'evidence'}
        record={selectedRecord}
        isOpen={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        onDone={response => {
          if (actionKind !== 'commercial') return;
          // Said at save time: saved terms that cannot price a new invoice yet, and why, in the service's words. Unsigned
          // or replaced terms bill nothing, so, as in their row, nothing is said about pricing them.
          const status = discountTermsStatus(response?.data);
          const silent = status.ready || status.state === 'unsigned' || (!!response && termsReplaced(response, commercial?.items ?? []));
          setTermsNotice(silent ? '' : `Terms saved. ${status.explanation}`);
        }}
        answer={() => actionKind === 'commercial' ? termsAnswer.current : null}
        title={`${selectedRecord ? 'Edit' : 'Add'} ${actionKind === 'commercial' ? 'commercial terms' : 'evidence'}`}
        fields={
          actionKind === 'evidence' ? [
            { name: 'name', label: 'Evidence title', type: 'text', required: true },
            { name: 'gateId', label: 'Requirement or decision', type: 'select', isData: true, required: true, options: gateOptions },
            { name: 'status', label: 'Status', type: 'select', options: [{label: 'Pending', value: 'pending'}, {label: 'Recorded', value: 'recorded'}], required: true },
            { name: 'reference', label: 'Evidence link or reference', type: 'text', isData: true, required: true },
            { name: 'owner', label: 'Evidence owner', type: 'text', isData: true, required: true },
            { name: 'evidenceDate', label: 'Evidence date', type: 'date', isData: true, required: true },
            { name: 'notes', label: 'Notes', type: 'textarea', isData: true }
          ] : actionKind === 'commercial' ? [
            { name: 'name', label: 'Lender name', type: 'text', required: true },
            { name: 'monthlyVolume', label: 'Monthly collection count', type: 'number', isData: true, required: true },
            { name: 'averageTicketKobo', label: 'Average collection amount (₦)', type: 'number', isData: true, required: true, help: 'In naira, for example 25,000.00.' },
            { name: 'licenceKobo', label: 'Monthly licence fee (₦)', type: 'number', isData: true, required: true },
            { name: 'usageBps', label: 'Usage fee rate (%)', type: 'number', percent: 'basisPoints', isData: true, required: true, help: 'A percentage with up to 2 decimal places, for example 0.3.' },
            { name: 'usageCapKobo', label: 'Maximum usage fee per collection (₦)', type: 'number', isData: true, required: true },
            { name: 'signed', label: 'Signed', type: 'checkbox', isData: true },
            { name: 'effectiveDate', label: 'Takes effect on', type: 'date', isData: true, help: 'Each billing month is billed on the signed terms in effect on its last day, for the whole month. Leave blank if these terms apply from the start.' },
            { name: 'designPartner', label: 'Design-partner agreement', type: 'checkbox', isData: true },
            { name: 'signedFullPriceTerms', label: 'Full-price terms are signed', type: 'checkbox', isData: true, help: 'Tick this once the full-price terms are signed. Until then, the discount dates are not proposed and cannot be used on an invoice.' },
            { name: 'discountStartDate', label: '50% discount starts on', type: 'date', isData: true, help: 'Use the first day of the billing month agreed in the signed contract. No discount starts automatically.' },
            { name: 'fullPriceStartDate', label: 'Full-price billing starts on', type: 'date', isData: true, help: 'Use the first day of the first full-price billing month in the signed contract. Prices never change part-way through a month.' },
            { name: 'discountTermsReference', label: 'Signed agreement reference for these dates', type: 'text', isData: true, help: 'Saving signed design-partner terms with these dates proposes them. Valo Pay records your demo role or staff account, and the time. A different Admin or Finance team member must then confirm them before new invoices use them. Issued invoices stay unchanged. Leave the dates blank until the agreement has been reviewed; new invoices will wait.' }
          ] : []
        }
      />
    </div>
  );
}
