import { useState } from "react";
import { Link, useSearchParams } from "wouter";
import { CheckCircle2, FileCheck2, ShieldCheck } from "lucide-react";
import { useWorkspace } from "@/lib/workspace-context";
import { usePilotMutation, usePilotQuery } from "@/lib/pilot";
import { closeReviewHistorySchema, closeReviewDetailSchema } from "@workspace/valopay-schema";
import { confirmUnsavedChanges, useUnsavedChanges } from "@/lib/unsaved-changes";
import { PilotError, PilotHeading, PilotPanel, RecoveryNotice, pilotField } from "@/components/pilot-ui";
import { Button } from "@/components/ui/button";
import { formatCount, formatDate, formatNumber } from "@/lib/formatters";
import { ExportJobControl } from "@/components/export-job-control";
import { SourceCompletenessPanel } from "@/components/source-manifest-editor";
import { CloseStatement } from "@/components/close-statement";

export default function CloseReviewPage() {
  const { merchantId } = useWorkspace(), [params, setParams] = useSearchParams();
  const search = params.get("search") || "", rawOffset = Number(params.get("offset") || 0), offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? Math.min(rawOffset, 1000000) : 0;
  const query = usePilotQuery(`/pilot/close-reviews?${new URLSearchParams({ search, offset: String(offset) })}`, closeReviewHistorySchema);
  const items = query.data?.closes || [], requested = params.get("close"), selectedId = requested || items[0]?.id;
  const updatePage = (values: Record<string, string | null>) => { if (!confirmUnsavedChanges()) return; setParams(current => { const next = new URLSearchParams(current); for (const [key, value] of Object.entries(values)) value ? next.set(key, value) : next.delete(key); return next; }); };
  return <div className="space-y-6 pb-8">
    <PilotHeading title="Finance close review">Prepare the evidence, explain differences and ask a different Finance user to review it. Every decision refers to one saved close snapshot.</PilotHeading>
    <div className="flex flex-wrap gap-4 text-sm"><Link href="/reports" className="text-primary underline">Run a daily close</Link><Link href="/pilot" className="text-primary underline">View pilot progress</Link><Link href="/operations" className="text-primary underline">Recover a request</Link></div>
    <PilotError error={query.error} retry={() => { void query.refetch(); }} />
    {query.isLoading && <p role="status">Loading close snapshots and Finance decisions…</p>}
    <form key={`${merchantId}:${search}`} className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); updatePage({ search: String(new FormData(event.currentTarget).get("search") || "").trim(), offset: null }); }}><label className="grow text-sm font-medium">Search close history<input name="search" maxLength={200} defaultValue={search} placeholder="Date, reference, preparer or reviewer" className={pilotField} /></label><Button variant="outline" type="submit">Search history</Button>{search && <Button variant="ghost" type="button" onClick={() => updatePage({ search: null, offset: null })}>Clear search</Button>}</form>
    {query.data && !items.length && <PilotPanel title={search ? "No matching closes" : "No close to review"}><p className="text-sm text-muted-foreground">{search ? "Try another date, reference or reviewer. A directly linked close remains available below." : "Reconcile the sample payments and run a daily close from Reports. Its exact results will appear here for preparation."}</p><Link href="/reports" className="inline-flex min-h-11 items-center text-primary underline">Open Reports</Link></PilotPanel>}
    {(!!items.length || requested) && <div className="grid min-w-0 gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <div><nav aria-label="Close snapshots" tabIndex={0} className="max-h-80 space-y-2 overflow-y-auto p-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring lg:max-h-[48rem]"><p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Close history</p>{items.map(item => <Link key={item.id} href={`/close-review?${new URLSearchParams({ ...(search ? { search } : {}), ...(offset ? { offset: String(offset) } : {}), close: item.id })}`} onClick={event => {
        // A different query remounts the form without changing the page. Link leaves modified/new-tab clicks native.
        if (selectedId !== item.id && !confirmUnsavedChanges()) event.preventDefault();
      }} aria-current={selectedId === item.id ? "page" : undefined} className={`block rounded-lg border p-3 text-sm ${selectedId === item.id ? "border-primary/50 bg-primary/5" : "bg-card"}`}><p className="font-semibold">{item.latest ? "Latest close" : "Earlier close"}</p><p className="mt-1 text-muted-foreground">{formatDate(item.createdAt)}</p><p className="mt-2">{item.reviewStatus === "approved" ? "Approved snapshot" : item.reviewStatus === "awaiting_review" ? "Awaiting Finance" : item.reviewStatus === "changes_requested" ? "Changes requested" : "Not yet reviewed"}</p></Link>)}</nav>
      {query.data && <div className="mt-4 space-y-3"><p className="text-xs text-muted-foreground">{formatNumber(query.data.total)} matching closes · page {formatNumber(Math.floor(query.data.offset / query.data.limit) + 1)}</p><div className="flex gap-2"><Button variant="outline" disabled={query.isFetching || query.data.offset === 0} onClick={() => updatePage({ offset: String(Math.max(0, query.data!.offset - query.data!.limit)) })}>Previous</Button><Button variant="outline" disabled={query.isFetching || query.data.offset + query.data.limit >= query.data.total} onClick={() => updatePage({ offset: String(query.data!.offset + query.data!.limit) })}>Next</Button></div></div>}</div>
      {selectedId && <SelectedClose key={`${merchantId}:${selectedId}`} id={selectedId} />}
    </div>}
  </div>;
}

function SelectedClose({ id }: { id: string }) {
  const query = usePilotQuery(`/pilot/close-reviews/${encodeURIComponent(id)}`, closeReviewDetailSchema);
  return <div className="min-w-0 space-y-5"><PilotError error={query.error} retry={() => { void query.refetch(); }} />{query.isLoading && <p role="status">Loading the complete close and its Finance history…</p>}{query.data && <>{query.data.accessMode !== "staff" && <section className="rounded-xl border bg-secondary/20 p-4 text-sm"><p className="font-semibold">Independent approval needs two people</p><p className="mt-1 text-muted-foreground">Demo roles belong to the same person. Configure separate staff accounts to rehearse independent approval.</p></section>}<CloseWork item={query.data.entry} data={query.data} refresh={() => query.refetch()} /></>}</div>;
}

function CloseWork({ item, data, refresh }: { item: any; data: any; refresh(): Promise<any> }) {
  const { workspace } = useWorkspace(), close = item.close, review = item.reviews[0];
  return <div className="min-w-0 space-y-5">
    <PilotPanel title="1. Saved close evidence">
      <p className="text-sm text-muted-foreground">{close.data.summary || close.name}</p>
      <dl className="grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">Recorded at</dt><dd>{formatDate(close.createdAt)}</dd></div><div><dt className="text-muted-foreground">Discrepancies and unresolved items</dt><dd>{formatNumber(item.issues.length)} to explain</dd></div></dl>
      {item.problem && <p role="status" className="rounded-lg border border-warning-border bg-warning/15 p-3 text-sm">{item.problem}</p>}
      {!!data.pendingCorrections?.length && <div className="rounded-lg border p-3 text-sm"><p className="font-semibold">Corrections needing a decision</p><ul className="mt-2 space-y-2">{data.pendingCorrections.map((correction: any) => <li key={correction.id}><Link className="text-primary underline" href={`/imports?${new URLSearchParams({ batch: correction.batchId, correction: correction.id })}`}>{correction.name || "Review import correction"}</Link></li>)}</ul></div>}
      <CloseStatement close={close} />
    </PilotPanel>
    {close.data.reviewBasis?.sourceCompleteness && <SourceCompletenessPanel completeness={close.data.reviewBasis.sourceCompleteness} frozen/>}
    {!item.problem && (!review || review.status === "changes_requested") && <PrepareForm key={`${close.id}:${review?.id || "new"}`} item={item} reviewers={data.reviewers} />}
    {!!item.reviews.length && item.reviews.map((saved: any, index: number) => <PilotPanel key={saved.id} title={index === 0 ? "2. Finance review" : "Earlier review"}>
      <div className="flex flex-wrap items-center gap-2 text-sm font-semibold"><ShieldCheck aria-hidden="true" className="h-5 w-5 text-primary" />{saved.status === "approved" ? "Approved" : saved.status === "changes_requested" ? "Changes requested" : "Awaiting review"}{!saved.current && <span className="font-normal text-muted-foreground">· Historical snapshot</span>}</div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">Prepared by</dt><dd className="break-words">{saved.data.preparedBy}</dd></div><div><dt className="text-muted-foreground">Named Finance reviewer</dt><dd className="break-words">{saved.data.reviewer}</dd></div></dl>
      <p className="whitespace-pre-wrap text-sm">{saved.data.preparationNote}</p>
      {!!saved.data.discrepancyResponses?.length && <details className="rounded-lg border p-3"><summary className="min-h-8 cursor-pointer text-sm font-medium">Read the explanations ({formatNumber(saved.data.discrepancyResponses.length)})</summary><dl className="mt-3 space-y-4 text-sm">{saved.data.discrepancyResponses.map((response: any) => <div key={response.issueId}><dt className="font-medium">{item.issues.find((issue: any) => issue.id === response.issueId)?.label || response.issueId}</dt><dd className="mt-1 whitespace-pre-wrap text-muted-foreground">{response.explanation}</dd></div>)}</dl></details>}
      {!!saved.data.unresolvedAcceptance && <div className="rounded-lg bg-secondary/20 p-3 text-sm"><p className="font-semibold">Proposed acceptance of unresolved items</p><p className="mt-1 whitespace-pre-wrap">{saved.data.unresolvedAcceptance}</p></div>}
      {!!saved.data.sourceExceptions?.length && <div className="rounded-lg border border-warning-border bg-warning/10 p-3 text-sm"><p className="font-semibold">Finance accepted incomplete source evidence</p>{saved.data.sourceExceptions.map((exception:any)=><div key={exception.issueId} className="mt-3"><p className="font-medium">{saved.data.snapshot.data.reviewBasis.sourceCompleteness.issues.find((issue:any)=>issue.id===exception.issueId)?.label || exception.issueId}</p><p className="whitespace-pre-wrap">{exception.reason}</p><p className="mt-1 break-words text-muted-foreground">Evidence: {exception.evidence}</p></div>)}</div>}
      <p className="break-all font-mono text-xs text-muted-foreground">Snapshot SHA-256: {saved.data.snapshotDigest}</p>
      {saved.data.decidedAt && <div className="border-t pt-3 text-sm"><p className="font-medium">{saved.data.decidedBy} · {formatDate(saved.data.decidedAt)}</p><p className="mt-2 whitespace-pre-wrap text-muted-foreground">{saved.data.decisionNote}</p></div>}
      {saved.status === "awaiting_review" && workspace?.actor === saved.data.reviewer && workspace?.role === "Finance" && (data.ownPrincipal && data.ownPrincipal === saved.data.preparedPrincipal ? <p className="text-sm text-muted-foreground">You prepared this close. A different staff user must review it; switching roles does not provide independent approval.</p> : <DecisionForm key={`${saved.id}:${saved.updatedAt}`} review={saved} />)}
      {saved.status === "awaiting_review" && workspace?.actor !== saved.data.reviewer && <p className="text-sm text-muted-foreground">Waiting for the named Finance reviewer. They will find this request in My work.</p>}
      {saved.status === "awaiting_review" && workspace?.role === "Admin" && <ReassignForm key={`assign:${saved.id}:${saved.updatedAt}`} review={saved} reviewers={data.reviewers} />}
      {!!data.events?.filter((event: any) => event.data.reviewId === saved.id && event.data.action === "reassign").length && <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">Reviewer assignment history</summary><ol className="mt-3 space-y-3 text-sm">{data.events.filter((event: any) => event.data.reviewId === saved.id && event.data.action === "reassign").map((event: any) => <li key={event.id}><p>{event.data.previousReviewer} → {event.data.reviewer}</p><p className="text-muted-foreground">{event.data.actor} · {formatDate(event.createdAt)}</p><p className="whitespace-pre-wrap">{event.data.note}</p></li>)}</ol></details>}
      {saved.status === "approved" && saved.current && <ReviewExport review={saved} />}
    </PilotPanel>)}
    <Button variant="outline" onClick={() => { void refresh(); }}>Refresh review status</Button>
  </div>;
}

function PrepareForm({ item, reviewers }: { item: any; reviewers: any[] }) {
  const { workspace } = useWorkspace(), [reviewer, setReviewer] = useState(""), [note, setNote] = useState(""), [acceptance, setAcceptance] = useState(""), [explanations, setExplanations] = useState<Record<string, string>>({});
  const mutation = usePilotMutation(() => { setReviewer(""); setNote(""); setAcceptance(""); setExplanations({}); });
  useUnsavedChanges(Boolean(reviewer || note || acceptance || Object.values(explanations).some(Boolean)));
  const permitted = ["Admin", "Operations", "Finance"].includes(workspace?.role || ""), busy = mutation.isPending || mutation.hasUnconfirmedOutcome;
  return <PilotPanel title="2. Prepare for Finance"><p className="text-sm text-muted-foreground">Explain each issue and name the person who will review your work. Approval records acceptance of this evidence; it does not resolve exceptions or move money.</p>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); mutation.mutate({ path: "/pilot/close-reviews/prepare", data: { closeId: item.close.id, expectedUpdatedAt: item.close.updatedAt, reviewer, preparationNote: note, discrepancyResponses: item.issues.map((issue: any) => ({ issueId: issue.id, explanation: explanations[issue.id] || "" })), unresolvedAcceptance: acceptance } }); }}>
      <fieldset disabled={busy || !permitted} className="space-y-4">
        <label className="block space-y-2 text-sm font-medium">Finance reviewer<select required className={pilotField} value={reviewer} onChange={event => setReviewer(event.target.value)}><option value="">Choose another person</option>{reviewers.filter(person => person.actor !== workspace?.actor).map(person => <option key={person.actor} value={person.actor}>{person.name || person.actor}</option>)}</select></label>
        <label className="block space-y-2 text-sm font-medium">Preparation summary<textarea required minLength={10} maxLength={3000} rows={3} className={pilotField} value={note} onChange={event => setNote(event.target.value)} placeholder="What did you check, and what should Finance pay attention to?" /></label>
        {item.issues.map((issue: any) => <div key={issue.id} className="rounded-lg border p-3"><label className="block space-y-2 text-sm font-medium">{issue.label}<span className="block font-normal text-muted-foreground">{issue.detail}</span><textarea required minLength={10} maxLength={3000} rows={3} className={pilotField} value={explanations[issue.id] || ""} onChange={event => setExplanations(previous => ({ ...previous, [issue.id]: event.target.value }))} /></label></div>)}
        {item.issues.some((issue: any) => issue.unresolved) && <label className="block space-y-2 text-sm font-medium">Why the unresolved items may remain open<textarea required minLength={10} maxLength={3000} rows={3} className={pilotField} value={acceptance} onChange={event => setAcceptance(event.target.value)} /><span className="block font-normal text-muted-foreground">Record the responsible owners, next steps and reason for accepting these items at this close.</span></label>}
        <Button type="submit" busy={mutation.isPending}><FileCheck2 aria-hidden="true" className="mr-2 h-4 w-4" />Submit for Finance review</Button>
      </fieldset>
    </form>
    {!permitted && <p className="text-sm text-muted-foreground">An Operations, Finance or administrator role must prepare this close.</p>}<RecoveryNotice mutation={mutation} />
  </PilotPanel>;
}
function DecisionForm({ review }: { review: any }) {
  const [initialDecision] = useState(review.current ? "approve" : "return");
  const [note, setNote] = useState(""), [decision, setDecision] = useState(initialDecision), [checked, setChecked] = useState(false);
  const sourceIssues:any[] = review.data.snapshot.data.reviewBasis?.sourceCompleteness?.issues || [], [exceptions,setExceptions]=useState<Record<string,{reason:string;evidence:string}>>({});
  const mutation = usePilotMutation(() => { setNote(""); setDecision(initialDecision); setChecked(false); setExceptions({}); });
  useUnsavedChanges(Boolean(note || checked || decision !== initialDecision || Object.values(exceptions).some(item=>item.reason||item.evidence)));
  const busy = mutation.isPending || mutation.hasUnconfirmedOutcome;
  return <form className="space-y-4 border-t pt-4" onSubmit={event => { event.preventDefault(); mutation.mutate({ path: `/pilot/close-reviews/${review.id}/decision`, data: { expectedUpdatedAt: review.updatedAt, action: decision, note, sourceExceptions:decision==='approve'?sourceIssues.map(issue=>({issueId:issue.id,reason:exceptions[issue.id]?.reason||'',evidence:exceptions[issue.id]?.evidence||''})):[] } }); }}>
    <fieldset disabled={busy} className="space-y-4"><legend className="mb-3 text-sm font-semibold">Your independent Finance decision</legend>
      <label className="block space-y-2 text-sm font-medium">Decision<select className={pilotField} value={decision} onChange={event => setDecision(event.target.value)}><option value="approve" disabled={!review.current}>Approve this snapshot</option><option value="return">Return for changes</option></select></label>
      <label className="block space-y-2 text-sm font-medium">Review note<textarea required minLength={10} maxLength={3000} rows={3} className={pilotField} value={note} onChange={event => setNote(event.target.value)} /></label>
      {decision==='approve' && !!sourceIssues.length && <div className="space-y-3 rounded-lg border border-warning-border bg-warning/10 p-4"><p className="font-semibold text-sm">Source completeness exceptions need your explicit acceptance</p><p className="text-sm text-muted-foreground">The source set is incomplete or excluded. Record your own reason and supporting evidence for each item, or return the close for changes. Approval does not relabel missing data as complete.</p>{sourceIssues.map(issue=><fieldset key={issue.id} className="space-y-3"><legend className="text-sm font-medium">{issue.label}</legend><label className="block text-sm">Finance acceptance reason · {issue.label}<textarea required minLength={10} maxLength={3000} className={pilotField} value={exceptions[issue.id]?.reason||''} onChange={e=>setExceptions(previous=>({...previous,[issue.id]:{reason:e.target.value,evidence:previous[issue.id]?.evidence||''}}))}/></label><label className="block text-sm">Finance supporting evidence · {issue.label}<input required minLength={5} maxLength={1000} className={pilotField} value={exceptions[issue.id]?.evidence||''} onChange={e=>setExceptions(previous=>({...previous,[issue.id]:{reason:previous[issue.id]?.reason||'',evidence:e.target.value}}))}/></label></fieldset>)}</div>}
      {decision === "approve" && <label className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" className="mt-1" required checked={checked} onChange={event => setChecked(event.target.checked)} /><span>I inspected this snapshot and its explanations, including the recorded acceptance of any unresolved items.</span></label>}
      {!review.current && <p className="text-sm text-muted-foreground">The inputs changed or a newer close exists. Return this review for a new close; historical evidence is preserved.</p>}
      <Button type="submit" busy={mutation.isPending} disabled={decision === "approve" && (!review.current || !checked)}>{decision === "approve" ? "Record Finance approval" : "Request changes"}</Button>
    </fieldset><RecoveryNotice mutation={mutation} />
  </form>;
}
function ReassignForm({ review, reviewers }: { review: any; reviewers: any[] }) {
  const [reviewer, setReviewer] = useState(""), [reason, setReason] = useState("");
  const mutation = usePilotMutation(() => { setReviewer(""); setReason(""); });
  useUnsavedChanges(Boolean(reviewer || reason));
  const eligible = reviewers.filter(person => person.actor !== review.data.reviewer && person.actor !== review.data.preparedBy && !person.actor.startsWith("Sandbox "));
  return <details className="rounded-lg border p-3"><summary className="min-h-8 cursor-pointer text-sm font-medium">Reviewer unavailable? Reassign this review</summary><p className="my-3 text-sm text-muted-foreground">An administrator can choose another active Finance colleague. The evidence and original preparation stay unchanged; the new reviewer must make their own decision.</p>{eligible.length ? <form onSubmit={event => { event.preventDefault(); mutation.mutate({ path: `/pilot/close-reviews/${review.id}/reassign`, data: { expectedUpdatedAt: review.updatedAt, reviewer, reason } }); }}><fieldset disabled={mutation.isPending || mutation.hasUnconfirmedOutcome} className="space-y-3"><label className="block text-sm font-medium">Replacement Finance reviewer<select required className={pilotField} value={reviewer} onChange={event => setReviewer(event.target.value)}><option value="">Choose an independent colleague</option>{eligible.map(person => <option key={person.actor} value={person.actor}>{person.name || person.actor}</option>)}</select></label><label className="block text-sm font-medium">Reason for reassignment<textarea required minLength={10} maxLength={3000} rows={3} className={pilotField} value={reason} onChange={event => setReason(event.target.value)} /></label><Button type="submit" busy={mutation.isPending}>Reassign Finance review</Button></fieldset></form> : <p className="text-sm text-muted-foreground">No other independent Finance reviewer has access to this lender. Arrange their staff access in Team before reassigning.</p>}<RecoveryNotice mutation={mutation} /></details>;
}
function ReviewExport({ review }: { review: any }) {
  return <div className="space-y-3 border-t pt-4"><p className="flex items-center gap-2 text-sm font-semibold"><CheckCircle2 aria-hidden="true" className="h-4 w-4 text-primary" />3. Export the approved evidence</p><p className="text-sm text-muted-foreground">The JSON and PDF exports include this exact snapshot, its explanations and the named Finance decision.</p><ExportJobControl kind="reviewed-close" closeReviewId={review.id} formats={['json', 'pdf']} label="Generate reviewed close evidence (JSON)" /></div>;
}
