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
import { koboToNaira, nairaToKobo } from "@/lib/money-input";
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
const deliveryError = "Enter the full date and time of the first delivery, in WAT.";
/** A saved expected total in naira for its field; a value that is not whole kobo is shown as it is. */
const nairaText = (kobo: number | null | undefined) => { if (kobo == null) return ""; try { return koboToNaira(kobo); } catch { return String(kobo); } };
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
    <PilotHeading title="Data sources">See which files arrived, which are missing, and whether every source row is accounted for. Sample data only.</PilotHeading>
    <PilotError error={query.error} what="data sources" noticeRef={problem} retry={() => { void query.refetch().then(result => { if (!result.error && result.data) setRecovery({ key: recoveryKey }); }); }} />
    {currentRecovery && !query.error && <p ref={recovered} role="status" className="text-sm">Source information reloaded.</p>}
    {query.error && query.data && <p role="status" className="text-sm text-muted-foreground">Showing the last loaded source information. Try again to check for updates.</p>}
    {query.isLoading && <p role="status">Loading data sources…</p>}
    <label className="block max-w-xs text-sm font-medium">Business date (WAT)<input type="date" required className={pilotField} value={businessDate} onChange={event=>{if(event.target.value&&confirmUnsavedChanges())setBusinessDate(event.target.value);}}/></label>
    {query.data?.completeness && <SourceCompletenessPanel completeness={query.data.completeness}/>}
    {query.data?.completeness && canWrite && <SourceManifestEditor key={`${businessDate}:${query.data.completeness.manifest?.id || 'new'}`} completeness={query.data.completeness}/>}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[["Late sources", query.data?.summary.lateSources], ["Batches to review", query.data?.summary.batchesNeedingReview], ["Duplicate source rows", query.data?.summary.duplicateRows], ["Conflicting source rows", query.data?.summary.conflictRows]].map(([label,value]) => <div key={label} className="rounded-xl border bg-card p-5"><p className="text-sm text-muted-foreground">{label}</p><p className="mt-2 text-3xl font-semibold tabular-nums">{value ?? (query.isLoading ? "…" : "Not recorded")}</p></div>)}</div>
    <PilotPanel title="Source profiles">
      <p className="text-sm text-muted-foreground">Each source profile belongs to this lender and one record type. Its expected rows and total are checked before a batch is imported. A missed delivery stays on the list, even if a later delivery arrives.</p>
      {!query.data && <p className="text-sm text-muted-foreground">{query.error ? "We could not load source profiles. Select Try again above." : "Loading source profiles…"}</p>}
      {query.data && !query.data.profiles.length && !query.error && <p className="text-sm">{canWrite ? "No source profiles yet. Add one below, then reuse it in Import batches." : "No source profiles yet. Ask an Admin, Operations or Finance team member to add a source profile."}</p>}
      <div className="grid gap-3 lg:grid-cols-2">{query.data?.profiles.map((profile) => <article key={profile.id} className="rounded-lg border p-4 space-y-3">
        <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">{profile.name}</h3><span className="rounded-full bg-muted px-2 py-1 text-xs">{readableLabel(profile.delivery.status)}</span></div>
        <p className="text-sm">{profile.data.source} · {kinds[profile.data.kind]}</p>
        <dl className="text-sm space-y-1"><div><dt className="inline text-muted-foreground">Next expected: </dt><dd className="inline">{formatDate(profile.delivery.nextExpectedAt)}</dd></div><div><dt className="inline text-muted-foreground">Last imported: </dt><dd className="inline">{profile.delivery.lastCommittedAt ? formatDate(profile.delivery.lastCommittedAt) : "No delivery yet"}</dd></div><div><dt className="inline text-muted-foreground">Missed deliveries: </dt><dd className="inline">{profile.delivery.missedDeliveries}</dd></div></dl>
        <div className="flex flex-wrap gap-3">{canWrite && <Button variant="outline" onClick={() => { if (!confirmUnsavedChanges()) return; setSelected(profile); setRevision(n=>n+1); }}>Edit {profile.name}</Button>}<Link className="inline-flex min-h-11 items-center text-sm text-primary underline" href={`/imports?profile=${encodeURIComponent(profile.id)}`}>Use in a new batch</Link></div>
      </article>)}</div>
    </PilotPanel>
    {canWrite && <ProfileEditor key={`${selected?.id || "new"}:${revision}`} profile={selected} onSaved={() => { setSelected(null); setRevision(n=>n+1); setMessage("Source profile saved. Valo Pay checks its expected rows and total on the next batch."); }} onNew={() => { if (!confirmUnsavedChanges()) return; setSelected(null); setRevision(n=>n+1); }} />}
    <PilotPanel title="Batch totals and checks">
      <p className="text-sm text-muted-foreground">Source totals count every uploaded row. New totals leave out rows that an earlier batch already imported. Totals add up naira only. Money in another currency is listed beside the total, never added to it. Some older batches kept totals that also added rows in other currencies. Open a batch to see its source row IDs and row checks.</p>
      {!query.data && <p className="text-sm text-muted-foreground">{query.error ? "We could not load saved batches. Select Try again above." : "Loading saved batches…"}</p>}
      {query.data && !query.data.batches.length && !query.error && <p className="text-sm">No saved batches yet. <Link href="/imports" className="text-primary underline">Open Import batches</Link></p>}
      {query.data && query.data.batches.length > 0 && <ScrollFrame label="Batch totals and checks"><table className="w-full min-w-[760px] text-sm"><thead><tr className="border-b text-left"><th className="p-3">Batch and source</th><th className="p-3">Source rows and total</th><th className="p-3">New rows and total</th><th className="p-3">Duplicates and conflicts</th><th className="p-3">Checks</th></tr></thead><tbody>{query.data.batches.map((batch) => <tr className="border-b align-top" key={batch.id}><td className="p-3"><Link className="font-medium text-primary underline" href={`/imports?batch=${encodeURIComponent(batch.id)}`}>{batch.name}</Link><p className="text-muted-foreground">{batch.source} · {batch.sourceBatchId}</p></td><td className="p-3 tabular-nums">{batch.quality.sourceRows}<p>{batch.quality.sourceAmountKobo == null ? "Not recorded" : formatWithOtherCurrencies(batch.quality.sourceAmountKobo, batch.quality.sourceOtherCurrencies, "row")}</p></td><td className="p-3 tabular-nums">{batch.quality.importedRows}<p>{batch.quality.importedAmountKobo == null ? "Not recorded" : formatWithOtherCurrencies(batch.quality.importedAmountKobo, batch.quality.importedOtherCurrencies, "row")}</p></td><td className="p-3">{batch.quality.duplicateRows} / {batch.quality.conflictRows}</td><td className="p-3 max-w-xs"><p>{readableLabel(batch.quality.status)}</p>{batch.quality.issues.map((issue) => <p className="mt-1 text-muted-foreground" key={issue}>{issue}</p>)}</td></tr>)}</tbody></table></ScrollFrame>}
    </PilotPanel>
    <PilotPanel title="Paystack test connection">
      <div className="rounded-lg border border-warning-border bg-warning/10 p-4 text-sm space-y-2"><p className="font-semibold">{query.data ? "Not connected" : query.error ? "Connection status not loaded" : "Loading connection status…"}</p><p>{query.data?.paystack.message || (query.error ? "We could not load the Paystack test connection. Select Try again above." : "Connection details will appear when the source information has loaded.")}</p><p>The practice buttons simulate messages from Paystack, signed the way Paystack signs them. They do not contact Paystack, activate mandates or create payments.</p><p>Before you use a Paystack test payment as evidence, check it with Paystack yourself.</p></div>
      {workspace?.role === "Admin" && <details className="rounded-lg border p-3 text-sm"><summary className="min-h-8 cursor-pointer font-medium">Technical setup</summary><p className="mt-2 text-muted-foreground">To test with a real Paystack account:</p><ol className="mt-2 list-decimal space-y-2 pl-5"><li>Create a Paystack account and get its test keys.</li><li>Ask the Valo Pay team to set up a test connection for this lender, including the web address Paystack sends its messages to.</li></ol></details>}
      {canWrite && query.data?.paystack.canRunFixtures && <div className="flex flex-wrap gap-2">{([ ["payment", "Simulate a Paystack payment"], ["duplicate", "Simulate the same payment again"], ["amount_mismatch", "Simulate the same payment with a different amount"], ["out_of_order", "Simulate mandate messages out of order"], ["tampered", "Simulate a message with a bad signature"] ] as const).map(([scenario,label]) => <Button key={scenario} variant="outline" disabled={fixture.isPending || fixture.hasUnconfirmedOutcome} onClick={() => fixture.mutate({ path: "/sources/paystack/fixtures", data: { scenario, syntheticOnly: true } })}>{label}</Button>)}</div>}
      <RecoveryNotice mutation={fixture} /><p role="status" className="text-sm">{message}</p>
      <div className="space-y-3">{query.data?.paystack.events.map((event) => <EventCard key={event.id} event={event} canReplay={canReplay} />)}</div>
      {query.data && query.data.paystack.total > 50 && <p className="text-sm text-muted-foreground">Showing the latest 50 of {formatNumber(query.data.paystack.total)} Paystack messages. Earlier messages are still saved.</p>}
    </PilotPanel>
  </div>;
}

function ProfileEditor({ profile, onSaved, onNew }: { profile: SourceProfile | null; onSaved(): void; onNew(): void }) {
  const [input, setInput] = useState<SourceProfileInput>(() => profile ? { ...blank(), ...profile.data, name: profile.name, status: profile.status, expectedUpdatedAt: profile.updatedAt, syntheticOnly: true } : blank());
  const [deliveryDraft, setDeliveryDraft] = useState(() => wat(input.firstExpectedAt)), [deliveryInvalid, setDeliveryInvalid] = useState(false);
  const [dirty, setDirty] = useState(false), [mappingRows, setMappingRows] = useState(() => Object.entries(input.mapping).map(([from,to]) => ({from,to})));
  // The expected total is typed in naira and saved in kobo exactly; blank means no expected total.
  const [totalDraft, setTotalDraft] = useState(() => nairaText(input.expectedAmountKobo)), [totalError, setTotalError] = useState("");
  const totalInKobo = (draft: string): number | null => draft.trim() === "" ? null : nairaToKobo(draft);
  const checkTotal = (draft: string) => { try { totalInKobo(draft); setTotalError(""); return true; } catch (error) { setTotalError((error as Error).message); return false; } };
  useUnsavedChanges(dirty);
  const mutation = useTypedPilotMutation(sourceProfileRecordSchema, () => { setDirty(false); onSaved(); });
  const update = (patch: Partial<SourceProfileInput>) => { setInput(v=>({...v,...patch})); setDirty(true); };
  const locked = mutation.isPending || mutation.hasUnconfirmedOutcome;
  return <PilotPanel title={profile ? `Edit ${profile.name}` : "Add source profile"}><form className="space-y-4" onSubmit={e=>{e.preventDefault(); const parsedDelivery = deliveryInstant(deliveryDraft); if (!parsedDelivery) { setDeliveryInvalid(true); document.getElementById("source-first-delivery")?.focus(); return; } if (!checkTotal(totalDraft)) { document.getElementById("source-expected-total")?.focus(); return; } const expectedAmountKobo = totalInKobo(totalDraft); const { name, source, kind, identityColumn, amountUnit, cadenceHours, graceMinutes, expectedRows, status, expectedUpdatedAt } = input; const firstExpectedAt = deliveryDraft === wat(input.firstExpectedAt) ? input.firstExpectedAt : parsedDelivery; mutation.mutate({path: profile ? `/sources/profiles/${profile.id}/save` : "/sources/profiles", data: { name, source, kind, identityColumn, amountUnit, firstExpectedAt, cadenceHours, graceMinutes, expectedRows, expectedAmountKobo, status, expectedUpdatedAt, syntheticOnly: true, mapping: Object.fromEntries(mappingRows.filter(r=>r.from).map(r=>[r.from,r.to])) } });}}>
    <fieldset disabled={locked} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <label className="text-sm space-y-1">Profile name<input className={pilotField} required maxLength={120} value={input.name} onChange={e=>update({name:e.target.value})}/></label>
      <label className="text-sm space-y-1">Source name<input className={pilotField} required maxLength={100} disabled={!!profile} value={input.source} onChange={e=>update({source:e.target.value})}/></label>
      <label className="text-sm space-y-1">Record type<select className={pilotField} disabled={!!profile} value={input.kind} onChange={e=>update({kind:e.target.value as SourceProfileInput["kind"]})}>{Object.entries(kinds).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      <label className="text-sm space-y-1">Source row ID column<input className={pilotField} required value={input.identityColumn} onChange={e=>update({identityColumn:e.target.value})}/></label>
      <label className="text-sm space-y-1">Amounts in the source file<select className={pilotField} value={input.amountUnit} onChange={e=>update({amountUnit:e.target.value as "naira"|"kobo"})}><option value="naira">{amountUnitName("naira", input.kind)}</option><option value="kobo">{amountUnitName("kobo", input.kind)}</option></select></label>
      <div className="text-sm space-y-1"><label htmlFor="source-first-delivery">First delivery expected (WAT)</label><input id="source-first-delivery" className={pilotField} required type="datetime-local" step="any" value={deliveryDraft} aria-invalid={deliveryInvalid || undefined} aria-describedby={deliveryInvalid ? "source-first-delivery-error" : undefined} onChange={e=>{setDeliveryDraft(e.target.value); setDirty(true); if (deliveryInvalid) setDeliveryInvalid(!deliveryInstant(e.target.value));}} onBlur={()=>setDeliveryInvalid(!deliveryInstant(deliveryDraft))} onInvalid={()=>setDeliveryInvalid(true)}/>{deliveryInvalid && <p id="source-first-delivery-error" role="alert" className="text-destructive">{deliveryError}</p>}</div>
      <label className="text-sm space-y-1">Delivery interval (hours)<input className={pilotField} type="number" min={1} max={8760} required value={input.cadenceHours} onChange={e=>update({cadenceHours:Number(e.target.value)})}/></label>
      <label className="text-sm space-y-1">Grace period (minutes)<input className={pilotField} type="number" min={0} max={10080} required value={input.graceMinutes} onChange={e=>update({graceMinutes:Number(e.target.value)})}/></label>
      <label className="text-sm space-y-1">Expected rows (optional)<input className={pilotField} type="number" min={0} max={500} value={input.expectedRows ?? ""} onChange={e=>update({expectedRows:e.target.value === "" ? null : Number(e.target.value)})}/></label>
      <div className="text-sm space-y-1"><label htmlFor="source-expected-total">Expected total (₦, optional)</label><input id="source-expected-total" className={pilotField} inputMode="decimal" value={totalDraft} aria-invalid={totalError ? true : undefined} aria-describedby={totalError ? "source-expected-total-error" : "source-expected-total-help"} onChange={e=>{setTotalDraft(e.target.value); setDirty(true); if (totalError) checkTotal(e.target.value);}} onBlur={()=>checkTotal(totalDraft)}/>{totalError ? <p id="source-expected-total-error" role="alert" className="text-destructive">{totalError}</p> : <p id="source-expected-total-help" className="text-xs text-muted-foreground">In naira, for example 25,000.00. Leave blank if the total is not known.</p>}</div>
      <label className="text-sm space-y-1">Schedule status<select className={pilotField} value={input.status} onChange={e=>update({status:e.target.value as "active"|"paused"})}><option value="active">Active</option><option value="paused">Paused</option></select></label>
    </fieldset>
    <fieldset disabled={locked} className="space-y-2"><legend className="text-sm font-medium">Column mapping</legend><p className="text-sm text-muted-foreground">A column named like a Valo Pay field is imported into that field. Add a row for each column with a different name. Leave Valo Pay field blank to skip that column.</p>{mappingRows.map((row,index)=><div className="flex gap-2" key={index}><label className="flex-1 text-sm">Source column<input className={pilotField} required value={row.from} onChange={e=>{setMappingRows(v=>v.map((r,i)=>i===index?{...r,from:e.target.value}:r));setDirty(true);}}/></label><label className="flex-1 text-sm">Valo Pay field<input className={pilotField} value={row.to} onChange={e=>{setMappingRows(v=>v.map((r,i)=>i===index?{...r,to:e.target.value}:r));setDirty(true);}}/></label><Button className="self-end" type="button" variant="outline" aria-label={`Remove column mapping ${index+1}`} onClick={()=>{setMappingRows(v=>v.filter((_,i)=>i!==index));setDirty(true);}}>Remove</Button></div>)}<Button variant="outline" type="button" onClick={()=>{setMappingRows(v=>[...v,{from:"",to:""}]);setDirty(true);}}>Add column mapping</Button></fieldset>
    <RecoveryNotice mutation={mutation}/><div className="flex flex-wrap gap-3"><Button type="submit" disabled={locked} busy={mutation.isPending} busyLabel={profile ? "Saving changes…" : "Adding source profile…"}>{profile ? "Save changes" : "Add source profile"}</Button>{profile&&<Button type="button" variant="outline" disabled={locked} onClick={onNew}>Start another profile</Button>}</div>
  </form></PilotPanel>;
}

/** Messages the service will not recheck: one held for review or rejected that it cannot clear, and verified evidence it must not replace. */
const replayRefused = ["quarantined", "rejected_fixture", "verified"];
function EventCard({ event, canReplay }: { event: ProviderEvent; canReplay: boolean }) {
  const [reason,setReason] = useState(""), mutation = useTypedPilotMutation(providerEventViewSchema, ()=>setReason(""));
  return <article className="rounded-lg border p-4 space-y-2"><div className="flex flex-wrap justify-between gap-2"><h3 className="font-medium">{event.name}</h3><span className="text-xs rounded-full bg-muted px-2 py-1">{event.mode === "fixture" ? "Practice message" : "Signed test message"} · {readableLabel(event.status)}</span></div><p className="text-sm">{event.message}</p><p className="text-xs text-muted-foreground">{formatDate(event.createdAt)} · {formatCount(event.deliveryCount, "delivery", "deliveries")} · {formatCount(event.replayCount, "recheck")} · No financial records created</p>{canReplay && !replayRefused.includes(event.status) && <form className="flex flex-wrap gap-2" onSubmit={e=>{e.preventDefault();mutation.mutate({path:`/sources/events/${event.id}/replay`,data:{expectedUpdatedAt:event.updatedAt,reason}});}}><div className="flex-1 min-w-[180px] space-y-1"><label className="block text-sm">Reason for rechecking this message<input className={pilotField} minLength={3} maxLength={500} required value={reason} aria-describedby={`recheck-reason-help-${event.id}`} disabled={mutation.isPending||mutation.hasUnconfirmedOutcome} onChange={e=>setReason(e.target.value)}/></label><p id={`recheck-reason-help-${event.id}`} className="text-xs text-muted-foreground">At least 3 characters.</p></div><Button className="self-end" variant="outline" disabled={mutation.isPending||mutation.hasUnconfirmedOutcome} type="submit">Recheck message</Button></form>}<RecoveryNotice mutation={mutation}/></article>;
}
