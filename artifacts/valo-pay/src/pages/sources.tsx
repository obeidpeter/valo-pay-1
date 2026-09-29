import { useRef, useState } from "react";
import { Link, useSearchParams } from "wouter";
import type { SourceProfileInput } from "@workspace/valopay-schema";
import { useWorkspace } from "@/lib/workspace-context";
import { useTypedPilotMutation, usePilotQuery } from "@/lib/pilot";
import { amountUnitName, paystackFixtureResultSchema, providerEventViewSchema } from "@workspace/valopay-schema";
import { useUnsavedChanges, confirmUnsavedChanges } from "@/lib/unsaved-changes";
import { PilotHeading, PilotPanel, PilotError, RecoveryNotice, pilotField } from "@/components/pilot-ui";
import { Button } from "@/components/ui/button";
import { ScrollFrame } from "@/components/scroll-frame";
import { formatCount, formatDate, formatNumber } from "@/lib/formatters";
import { formatWithOtherCurrencies } from "@/lib/currencies";
import { readableLabel } from "@/components/record-label";
import { SourceCompletenessPanel, SourceManifestEditor } from "@/components/source-manifest-editor";
import { useFocusWhenLost } from "@/lib/focus";
import { consoleSourcesViewSchema, sourceProfileRecordSchema, type SourceProfile, type ProviderEvent } from "@/lib/source-models";

const kinds = { customers: "Customers", mandates: "Mandates", "due-items": "Instalments", attempts: "Collection attempts", observations: "Payment evidence" };
const wat = (iso: string) => {
  const date = new Date(Date.parse(iso) + 3600000);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0,16) : "";
};
// Native controls can emit seconds or an empty value while a date is edited.
// Validate the complete calendar value before converting it; Date.parse alone
// silently rolls some impossible dates into the next month.
function deliveryInstant(value: string): string | null {
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
  if (!parts || value.startsWith("0000-")) return null;
  const local = `${parts[1]}T${parts[2]}:${parts[3]}:${parts[4] || "00"}.${(parts[5] || "").padEnd(3,"0")}`;
  const date = new Date(`${local}+01:00`);
  if (!Number.isFinite(date.getTime())) return null;
  return new Date(date.getTime()+3600000).toISOString().slice(0,-1) === local ? date.toISOString() : null;
}
const deliveryError = "Enter a complete, valid delivery date and time in West Africa Time (UTC+01:00).";
const blank = (): SourceProfileInput => ({ name: "", source: "", kind: "customers", mapping: {}, identityColumn: "source_row_id", amountUnit: "naira", firstExpectedAt: new Date(Date.now()+86400000).toISOString(), cadenceHours: 24, graceMinutes: 60, expectedRows: null, expectedAmountKobo: null, status: "active", syntheticOnly: true });
export default function SourcesPage() { const { merchantId } = useWorkspace(); return <Sources key={merchantId || "none"} />; }
function Sources() {
  const { workspace } = useWorkspace(), [params] = useSearchParams();
  const [businessDate,setBusinessDate] = useState(params.get("businessDate") || new Date(Date.now()+3600000).toISOString().slice(0,10));
  const query = usePilotQuery(`/sources?businessDate=${encodeURIComponent(businessDate)}`, consoleSourcesViewSchema);
  const problem = useRef<HTMLDivElement>(null), recovered = useRef<HTMLParagraphElement>(null);
  const recoveryKey = JSON.stringify([workspace?.actor, businessDate]);
  const [recovery, setRecovery] = useState<{ key: string } | null>(null);
  const currentRecovery = recovery?.key === recoveryKey && query.data ? recovery : null;
  useFocusWhenLost(recovered, currentRecovery, problem);
  const [selected, setSelected] = useState<SourceProfile | null>(null), [revision, setRevision] = useState(0), [message, setMessage] = useState("");
  const fixture = useTypedPilotMutation(paystackFixtureResultSchema, result => setMessage(result.event.message));
  const canWrite = ["Admin", "Operations", "Finance"].includes(workspace?.role || "");
  const canReplay = ["Admin", "Finance"].includes(workspace?.role || "");
  return <div className="space-y-6">
    <PilotHeading title="Data sources">Check what arrived, what is missing and whether every source row is accounted for. All records in this pilot remain synthetic.</PilotHeading>
    <PilotError error={query.error} noticeRef={problem} retry={() => { void query.refetch().then(result => { if (!result.error && result.data) setRecovery({ key: recoveryKey }); }); }} />
    {currentRecovery && !query.error && <p ref={recovered} role="status" className="text-sm">Source information reloaded.</p>}
    {query.error && query.data && <p role="status" className="text-sm text-muted-foreground">Showing the last loaded source information. Try again to check for updates.</p>}
    {query.isLoading && <p role="status">Loading source controls…</p>}
    <label className="block max-w-xs text-sm font-medium">Business date (WAT)<input type="date" required className={pilotField} value={businessDate} onChange={event=>{if(event.target.value&&confirmUnsavedChanges())setBusinessDate(event.target.value);}}/></label>
    {query.data?.completeness && <SourceCompletenessPanel completeness={query.data.completeness}/>}
    {query.data?.completeness && canWrite && <SourceManifestEditor key={`${businessDate}:${query.data.completeness.manifest?.id || 'new'}`} completeness={query.data.completeness}/>}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[["Late sources", query.data?.summary.lateSources], ["Batches to review", query.data?.summary.batchesNeedingReview], ["Duplicate source rows", query.data?.summary.duplicateRows], ["Conflicting source rows", query.data?.summary.conflictRows]].map(([label,value]) => <div key={label} className="rounded-xl border bg-card p-5"><p className="text-sm text-muted-foreground">{label}</p><p className="mt-2 text-3xl font-semibold tabular-nums">{value ?? "—"}</p></div>)}</div>
    <PilotPanel title="Delivery schedules & reusable mappings">
      <p className="text-sm text-muted-foreground">Each source profile belongs to this lender and one record type. Expected totals are checked before a batch can be committed. A missed delivery remains visible even if a later delivery arrives.</p>
      {!query.data && <p className="text-sm text-muted-foreground">{query.error ? "Source profiles could not be loaded. Try again above." : "Loading source profiles…"}</p>}
      {query.data && !query.data.profiles.length && !query.error && <p className="text-sm">{canWrite ? "No source profiles yet. Add one below, then reuse it in Import batches." : "No source profiles yet. Ask an Admin, Operations or Finance team member to add a source profile."}</p>}
      <div className="grid gap-3 lg:grid-cols-2">{query.data?.profiles.map((profile) => <article key={profile.id} className="rounded-lg border p-4 space-y-3">
        <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">{profile.name}</h3><span className="rounded-full bg-muted px-2 py-1 text-xs">{readableLabel(profile.delivery.status)}</span></div>
        <p className="text-sm">{profile.data.source} · {kinds[profile.data.kind]}</p>
        <dl className="text-sm space-y-1"><div><dt className="inline text-muted-foreground">Next expected: </dt><dd className="inline">{formatDate(profile.delivery.nextExpectedAt)}</dd></div><div><dt className="inline text-muted-foreground">Last committed: </dt><dd className="inline">{profile.delivery.lastCommittedAt ? formatDate(profile.delivery.lastCommittedAt) : "No delivery yet"}</dd></div><div><dt className="inline text-muted-foreground">Missed deliveries: </dt><dd className="inline">{profile.delivery.missedDeliveries}</dd></div></dl>
        <div className="flex flex-wrap gap-3">{canWrite && <Button variant="outline" onClick={() => { if (!confirmUnsavedChanges()) return; setSelected(profile); setRevision(n=>n+1); }}>Edit {profile.name}</Button>}<Link className="inline-flex min-h-11 items-center text-sm text-primary underline" href={`/imports?profile=${encodeURIComponent(profile.id)}`}>Use mapping</Link></div>
      </article>)}</div>
    </PilotPanel>
    {canWrite && <ProfileEditor key={`${selected?.id || "new"}:${revision}`} profile={selected} onSaved={() => { setSelected(null); setRevision(n=>n+1); setMessage("Source profile saved. Its expectations will be checked on the next batch."); }} onNew={() => { if (!confirmUnsavedChanges()) return; setSelected(null); setRevision(n=>n+1); }} />}
    <PilotPanel title="Source totals & import evidence">
      <p className="text-sm text-muted-foreground">Source totals include every uploaded row. Newly imported totals exclude rows already saved by an earlier batch. Each total adds the naira rows; money in another currency is listed beside it, never added to it. A batch committed by an earlier build keeps the totals it was committed with, which may add rows in other currencies. Open a batch to inspect its original source IDs and row checks.</p>
      {!query.data && <p className="text-sm text-muted-foreground">{query.error ? "Saved batches could not be loaded. Try again above." : "Loading saved batches…"}</p>}
      {query.data && !query.data.batches.length && !query.error && <p className="text-sm">Saved batches will appear here. <Link href="/imports" className="text-primary underline">Open Import batches</Link></p>}
      {query.data && query.data.batches.length > 0 && <ScrollFrame label="Source batch checks"><table className="w-full min-w-[760px] text-sm"><thead><tr className="border-b text-left"><th className="p-3">Batch / source</th><th className="p-3">Source rows / total</th><th className="p-3">New rows / total</th><th className="p-3">Duplicates / conflicts</th><th className="p-3">Checks</th></tr></thead><tbody>{query.data.batches.map((batch) => <tr className="border-b align-top" key={batch.id}><td className="p-3"><Link className="font-medium text-primary underline" href={`/imports?batch=${encodeURIComponent(batch.id)}`}>{batch.name}</Link><p className="text-muted-foreground">{batch.source} · {batch.sourceBatchId}</p></td><td className="p-3 tabular-nums">{batch.quality.sourceRows}<p>{batch.quality.sourceAmountKobo == null ? "Not available" : formatWithOtherCurrencies(batch.quality.sourceAmountKobo, batch.quality.sourceOtherCurrencies, "row")}</p></td><td className="p-3 tabular-nums">{batch.quality.importedRows}<p>{batch.quality.importedAmountKobo == null ? "Not available" : formatWithOtherCurrencies(batch.quality.importedAmountKobo, batch.quality.importedOtherCurrencies, "row")}</p></td><td className="p-3">{batch.quality.duplicateRows} / {batch.quality.conflictRows}</td><td className="p-3 max-w-xs"><p>{readableLabel(batch.quality.status)}</p>{batch.quality.issues.map((issue) => <p className="mt-1 text-muted-foreground" key={issue}>{issue}</p>)}</td></tr>)}</tbody></table></ScrollFrame>}
    </PilotPanel>
    <PilotPanel title="Paystack test connection">
      <div className="rounded-lg border border-warning-border bg-warning/10 p-4 text-sm space-y-2"><p className="font-semibold">{query.data ? "External connection not verified" : query.error ? "Connection status unavailable" : "Loading connection status…"}</p><p>{query.data?.paystack.message || (query.error ? "Paystack test connection details could not be loaded. Try again above." : "Connection details will appear when the source information has loaded.")}</p><p>Fixtures use fixed local sample events to rehearse signed receipt handling. They do not contact Paystack, activate mandates or create payments.</p></div>
      <ol className="list-decimal pl-5 space-y-2 text-sm"><li>Create a Paystack account and obtain test credentials when ready.</li><li>Have the platform operator provision a test connection for the intended lender and configure its webhook address.</li><li>Verify a real test delivery and transaction independently before relying on it as evidence.</li></ol>
      {canWrite && query.data?.paystack.canRunFixtures && <div className="flex flex-wrap gap-2">{([ ["payment", "Receive sample payment"], ["duplicate", "Repeat delivery"], ["amount_mismatch", "Rehearse amount conflict"], ["out_of_order", "Rehearse out-of-order events"], ["tampered", "Check tampered signature"] ] as const).map(([scenario,label]) => <Button key={scenario} variant="outline" disabled={fixture.isPending || fixture.hasUnconfirmedOutcome} onClick={() => fixture.mutate({ path: "/sources/paystack/fixtures", data: { scenario, syntheticOnly: true } })}>{label}</Button>)}</div>}
      <RecoveryNotice mutation={fixture} /><p role="status" className="text-sm">{message}</p>
      <div className="space-y-3">{query.data?.paystack.events.map((event) => <EventCard key={event.id} event={event} canReplay={canReplay} />)}</div>
      {query.data && query.data.paystack.total > 50 && <p className="text-sm text-muted-foreground">Showing the latest 50 of {formatNumber(query.data.paystack.total)} receipts. Earlier receipts remain saved.</p>}
    </PilotPanel>
  </div>;
}

function ProfileEditor({ profile, onSaved, onNew }: { profile: SourceProfile | null; onSaved(): void; onNew(): void }) {
  const [input, setInput] = useState<SourceProfileInput>(() => profile ? { ...blank(), ...profile.data, name: profile.name, status: profile.status, expectedUpdatedAt: profile.updatedAt, syntheticOnly: true } : blank());
  const [deliveryDraft, setDeliveryDraft] = useState(() => wat(input.firstExpectedAt)), [deliveryInvalid, setDeliveryInvalid] = useState(false);
  const [dirty, setDirty] = useState(false), [mappingRows, setMappingRows] = useState(() => Object.entries(input.mapping).map(([from,to]) => ({from,to})));
  useUnsavedChanges(dirty);
  const mutation = useTypedPilotMutation(sourceProfileRecordSchema, () => { setDirty(false); onSaved(); });
  const update = (patch: Partial<SourceProfileInput>) => { setInput(v=>({...v,...patch})); setDirty(true); };
  const locked = mutation.isPending || mutation.hasUnconfirmedOutcome;
  return <PilotPanel title={profile ? `Edit ${profile.name}` : "Add a source profile"}><form className="space-y-4" onSubmit={e=>{e.preventDefault(); const parsedDelivery = deliveryInstant(deliveryDraft); if (!parsedDelivery) { setDeliveryInvalid(true); document.getElementById("source-first-delivery")?.focus(); return; } const { name, source, kind, identityColumn, amountUnit, cadenceHours, graceMinutes, expectedRows, expectedAmountKobo, status, expectedUpdatedAt } = input; const firstExpectedAt = deliveryDraft === wat(input.firstExpectedAt) ? input.firstExpectedAt : parsedDelivery; mutation.mutate({path: profile ? `/sources/profiles/${profile.id}/save` : "/sources/profiles", data: { name, source, kind, identityColumn, amountUnit, firstExpectedAt, cadenceHours, graceMinutes, expectedRows, expectedAmountKobo, status, expectedUpdatedAt, syntheticOnly: true, mapping: Object.fromEntries(mappingRows.filter(r=>r.from).map(r=>[r.from,r.to])) } });}}>
    <fieldset disabled={locked} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <label className="text-sm space-y-1">Profile name<input className={pilotField} required maxLength={120} value={input.name} onChange={e=>update({name:e.target.value})}/></label>
      <label className="text-sm space-y-1">Source name<input className={pilotField} required maxLength={100} disabled={!!profile} value={input.source} onChange={e=>update({source:e.target.value})}/></label>
      <label className="text-sm space-y-1">Record type<select className={pilotField} disabled={!!profile} value={input.kind} onChange={e=>update({kind:e.target.value as SourceProfileInput["kind"]})}>{Object.entries(kinds).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      <label className="text-sm space-y-1">Source row ID column<input className={pilotField} required value={input.identityColumn} onChange={e=>update({identityColumn:e.target.value})}/></label>
      <label className="text-sm space-y-1">Source amounts<select className={pilotField} value={input.amountUnit} onChange={e=>update({amountUnit:e.target.value as "naira"|"kobo"})}><option value="naira">{amountUnitName("naira", input.kind)}</option><option value="kobo">{amountUnitName("kobo", input.kind)}</option></select></label>
      <div className="text-sm space-y-1"><label htmlFor="source-first-delivery">First delivery expected (WAT)</label><input id="source-first-delivery" className={pilotField} required type="datetime-local" step="any" value={deliveryDraft} aria-invalid={deliveryInvalid || undefined} aria-describedby={deliveryInvalid ? "source-first-delivery-error" : undefined} onChange={e=>{setDeliveryDraft(e.target.value); setDirty(true); if (deliveryInvalid) setDeliveryInvalid(!deliveryInstant(e.target.value));}} onBlur={()=>setDeliveryInvalid(!deliveryInstant(deliveryDraft))} onInvalid={()=>setDeliveryInvalid(true)}/>{deliveryInvalid && <p id="source-first-delivery-error" role="alert" className="text-destructive">{deliveryError}</p>}</div>
      <label className="text-sm space-y-1">Delivery interval (hours)<input className={pilotField} type="number" min={1} max={8760} required value={input.cadenceHours} onChange={e=>update({cadenceHours:Number(e.target.value)})}/></label>
      <label className="text-sm space-y-1">Grace period (minutes)<input className={pilotField} type="number" min={0} max={10080} required value={input.graceMinutes} onChange={e=>update({graceMinutes:Number(e.target.value)})}/></label>
      <label className="text-sm space-y-1">Expected source rows (optional)<input className={pilotField} type="number" min={0} max={500} value={input.expectedRows ?? ""} onChange={e=>update({expectedRows:e.target.value === "" ? null : Number(e.target.value)})}/></label>
      <label className="text-sm space-y-1">Expected total (kobo, optional)<input className={pilotField} type="number" min={0} step={1} max={Number.MAX_SAFE_INTEGER} value={input.expectedAmountKobo ?? ""} onChange={e=>update({expectedAmountKobo:e.target.value === "" ? null : Number(e.target.value)})}/></label>
      <label className="text-sm space-y-1">Schedule<select className={pilotField} value={input.status} onChange={e=>update({status:e.target.value as "active"|"paused"})}><option value="active">Active</option><option value="paused">Paused</option></select></label>
    </fieldset>
    <fieldset disabled={locked} className="space-y-2"><legend className="text-sm font-medium">Column mapping</legend><p className="text-sm text-muted-foreground">Columns with the same names use the standard import fields. Add a mapping where the source uses a different name; leave the destination blank to skip a column.</p>{mappingRows.map((row,index)=><div className="flex gap-2" key={index}><label className="flex-1 text-sm">Source column<input className={pilotField} required value={row.from} onChange={e=>{setMappingRows(v=>v.map((r,i)=>i===index?{...r,from:e.target.value}:r));setDirty(true);}}/></label><label className="flex-1 text-sm">Valo Pay field<input className={pilotField} value={row.to} onChange={e=>{setMappingRows(v=>v.map((r,i)=>i===index?{...r,to:e.target.value}:r));setDirty(true);}}/></label><Button className="self-end" type="button" variant="outline" aria-label={`Remove mapping ${index+1}`} onClick={()=>{setMappingRows(v=>v.filter((_,i)=>i!==index));setDirty(true);}}>Remove</Button></div>)}<Button variant="outline" type="button" onClick={()=>{setMappingRows(v=>[...v,{from:"",to:""}]);setDirty(true);}}>Add column mapping</Button></fieldset>
    <RecoveryNotice mutation={mutation}/><div className="flex flex-wrap gap-3"><Button type="submit" disabled={locked} busy={mutation.isPending}>Save source profile</Button>{profile&&<Button type="button" variant="outline" disabled={locked} onClick={onNew}>Start another profile</Button>}</div>
  </form></PilotPanel>;
}

/** Receipts the service will not replay: a quarantine or rejected fixture it cannot clear, and verified evidence it must not replace. */
const replayRefused = ["quarantined", "rejected_fixture", "verified"];
function EventCard({ event, canReplay }: { event: ProviderEvent; canReplay: boolean }) {
  const [reason,setReason] = useState(""), mutation = useTypedPilotMutation(providerEventViewSchema, ()=>setReason(""));
  return <article className="rounded-lg border p-4 space-y-2"><div className="flex flex-wrap justify-between gap-2"><h3 className="font-medium">{event.name}</h3><span className="text-xs rounded-full bg-muted px-2 py-1">{event.mode === "fixture" ? "Synthetic fixture" : "Signed test event"} · {readableLabel(event.status)}</span></div><p className="text-sm">{event.message}</p><p className="text-xs text-muted-foreground">{formatDate(event.createdAt)} · {formatCount(event.deliveryCount, "delivery", "deliveries")} · {formatCount(event.replayCount, "replay")} · No financial records created</p>{canReplay && !replayRefused.includes(event.status) && <form className="flex flex-wrap gap-2" onSubmit={e=>{e.preventDefault();mutation.mutate({path:`/sources/events/${event.id}/replay`,data:{expectedUpdatedAt:event.updatedAt,reason}});}}><label className="flex-1 min-w-[180px] text-sm">Reason to recheck this receipt<input className={pilotField} minLength={3} maxLength={500} required value={reason} disabled={mutation.isPending||mutation.hasUnconfirmedOutcome} onChange={e=>setReason(e.target.value)}/></label><Button className="self-end" variant="outline" disabled={mutation.isPending||mutation.hasUnconfirmedOutcome} type="submit">Recheck saved receipt</Button></form>}<RecoveryNotice mutation={mutation}/></article>;
}
