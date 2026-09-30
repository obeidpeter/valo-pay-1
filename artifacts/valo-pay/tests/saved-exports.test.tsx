import { afterEach, beforeEach, expect, it } from 'vitest';
import { renderApp, screen, userEvent, waitFor, within } from './harness';
import { formatDate } from '@/lib/formatters';
import { installFakeApi, type FakeApi } from './fake-api';
import { queueExport } from '../../api-server/src/lib/export-jobs';
import { makeRecord } from '../../api-server/src/domain/records';
import { approveLifecycleRun, lifecyclePolicy, lifecyclePreview, saveLifecyclePolicy } from '../../api-server/src/domain/lifecycle';
import { executeApprovedRun } from '../../api-server/src/domain/lifecycle-run';

let api: FakeApi;
beforeEach(() => { api = installFakeApi({ queuedExports: true }); });
afterEach(() => api.uninstall());
function running(stage='confirming', expired=false, kind='customers') {
  return api.mutate((state,ctx)=>{
    const view=queueExport(state,ctx,{kind,format:'json'},'sample/private');
    const job=state.records.find(record=>record.id===view.id)!;
    job.status='running';Object.assign(job.data,{stage,lastProgressAt:ctx.now,leaseToken:'private-token',leaseExpiresAt:new Date(Date.now()+(expired?-1000:60000)).toISOString()});
    return job.id;
  });
}
it('retries an unavailable exact export lookup without claiming it was not found',async()=>{
  const id=running(),user=userEvent.setup(),base=globalThis.fetch;
  running('uploading',false,'mandates');
  let failLookup=true;
  globalThis.fetch=async(input,init)=>{
    const url=new URL(String(input),'http://localhost');
    if(failLookup&&url.pathname==='/api/v1/records/exports'&&url.searchParams.get('id')===id)return new Response(JSON.stringify({error:''}),{status:503,headers:{'content-type':'application/json'}});
    return base(input,init);
  };
  renderApp(`/exports?job=${id}`);
  const selection=(await screen.findByRole('heading',{name:'Selected export'})).closest('section')!;
  await within(selection).findByText('We could not load this export. Check your connection and try again.');
  expect(screen.queryByText(/Export not found/)).toBeNull();
  expect(screen.getByRole('link',{name:/Customers \(JSON\)/})).toBeTruthy();
  expect(api.calls.filter(call=>call.path===`/v1/exports/${id}`)).toHaveLength(0);
  failLookup=false;
  await user.click(within(selection).getByRole('button',{name:'Try again'}));
  await screen.findByText('File saved; finishing');
  expect(within(selection).queryByRole('alert')).toBeNull();
  await waitFor(()=>expect(document.activeElement).toBe(screen.getByText('Export details reloaded.')));
  const releaseNextJob=api.hold(/^\/v1\/records\/exports$/);
  await user.click(screen.getByRole('link',{name:/Mandates \(JSON\)/}));
  await screen.findByText('Loading this export…');
  expect(screen.queryByText('Export details reloaded.')).toBeNull();
  releaseNextJob();
  await screen.findByText('Saving the file');
  expect(screen.queryByText('Export details reloaded.')).toBeNull();
});
it('distinguishes export history loading and failure from a confirmed empty result',async()=>{
  const user=userEvent.setup(),release=api.hold(/^\/v1\/records\/exports$/);
  api.failNext(/^\/v1\/records\/exports$/,'offline','GET');
  renderApp('/exports');
  await screen.findByText('Loading saved exports…');
  expect(screen.queryByText(/No exports (yet|match)/)).toBeNull();
  expect(screen.queryByText(/Select a saved export to see/)).toBeNull();
  release();
  await screen.findByText('We could not load the export history. Check your connection and try again.');
  expect(screen.queryByText(/No exports (yet|match)/)).toBeNull();
  expect(screen.queryByText(/Export not found/)).toBeNull();
  await user.click(screen.getByRole('button',{name:'Try again'}));
  await screen.findByText(/No exports yet\. To create one, open a customer, Reports or an approved close review\./);
  expect(screen.getByText('Select a saved export to see its progress and available actions.')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  await waitFor(()=>expect(document.activeElement).toBe(screen.getByText('Export history reloaded.')));
  const releaseNextFilter=api.hold(/^\/v1\/records\/exports$/);
  await user.selectOptions(screen.getByRole('combobox',{name:'Export status'}),'ready');
  await screen.findByText('Loading saved exports…');
  expect(screen.queryByText('Export history reloaded.')).toBeNull();
  releaseNextFilter();
  await screen.findByText(/No exports match this status\. Choose All exports in Export status to see every export for this lender\./);
  expect(screen.queryByText('Export history reloaded.')).toBeNull();
});
it('retains export history and selected details when both refreshes fail',async()=>{
  const id=running(),user=userEvent.setup();renderApp(`/exports?job=${id}`);
  await screen.findByText('File saved; finishing');
  api.failNext(/^\/v1\/records\/exports$/,'offline','GET');
  api.failNext(/^\/v1\/records\/exports$/,'offline','GET');
  await user.click(screen.getByRole('button',{name:'Refresh saved exports'}));
  await screen.findByText('Showing the last loaded export history. Try again to check for updates.');
  expect(screen.getByText('Showing the last loaded export details. Try again to check for updates.')).toBeTruthy();
  expect(screen.getByRole('link',{name:/Customers \(JSON\)/})).toBeTruthy();
  expect(screen.getByText(`Export ID: ${id}`)).toBeTruthy();
  expect(screen.getAllByRole('alert')).toHaveLength(2);
  expect(screen.queryByText(/Export not found/)).toBeNull();
  expect(screen.queryByText(/No exports on this page/)).toBeNull();
});
it('shows saved file confirmation progress and recovers an expired lease using the same job',async()=>{
  const id=running('confirming',true),user=userEvent.setup();renderApp(`/exports?job=${id}`);
  await screen.findByText('File saved; finishing');
  await screen.findByText('This export seems to be stuck');
  expect(screen.queryByRole('link',{name:'Open saved export'})).toBeNull();
  await user.click(screen.getByRole('button',{name:'Restart export'}));
  await screen.findByText('Waiting to start');
  expect(api.calls.filter(call=>call.path===`/v1/exports/${id}/retry`&&call.method==='POST')).toHaveLength(1);
  expect(api.calls.filter(call=>call.path==='/v1/exports'&&call.method==='POST')).toHaveLength(0);
  expect(api.state().records.filter(record=>record.kind==='exports')).toHaveLength(1);
  expect(api.state().records.find(record=>record.id===id)!.data.stage).toBe('queued');
});
it('waits for the current worker deadline and gives Read-only users status without retry authority',async()=>{
  // A mandate export: Read-only may download it, where the customer register is for Admin, Finance and Compliance reviewer only.
  const id=running('uploading',false,'mandates');api.mutate(state=>{state.records.find(record=>record.id===id)!.data.lastProgressAt=new Date(Date.now()-180000).toISOString();});
  api.role='Read-only';renderApp(`/exports?job=${id}`);
  await screen.findByText('Saving the file');
  await screen.findByText(/You can restart this export after/);
  expect(screen.queryByRole('button',{name:'Restart export'})).toBeNull();
  expect(screen.getByText(/With read-only access you can download files that already exist/)).toBeTruthy();
});
it('loads an older exact job outside the first history page and never loads a foreign lender job',async()=>{
  const id=running();
  api.mutate(state=>{for(let i=0;i<26;i++)makeRecord(state,'exports',{status:'ready',name:`Recent synthetic ${i}`,createdAt:new Date(Date.now()+i+1000).toISOString(),data:{kind:'customers',format:'json',checksum:'a'.repeat(64),generatedAt:api.now}});});
  const foreign=api.mutate((state,ctx)=>queueExport(state,ctx,{kind:'customers',format:'json'},'sample/private').id,api.merchantIds[1]);
  const view=renderApp(`/exports?job=${id}`);
  await screen.findByText('File saved; finishing');
  expect(screen.getByText('1–25 of 27')).toBeTruthy();
  view.unmount();renderApp(`/exports?job=${foreign}`);
  await screen.findByText(/Export not found\. It may have been deleted, or it belongs to another lender\./);
  expect(api.calls.filter(call=>call.path===`/v1/exports/${foreign}`)).toHaveLength(0);
});
it.each(['wrong identity','missing status','malformed checksum','foreign download'])('does not offer a download with %s in the status response',async(condition)=>{
  const id=running(),base=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{
    if(String(input).includes(`/exports/${id}?`))return new Response(JSON.stringify({id:condition==='wrong identity'?'wrong-job':id,status:condition==='missing status'?undefined:'ready',checksum:condition==='malformed checksum'?'undefined':'b'.repeat(64),downloadUrl:condition==='foreign download'?`https://example.invalid/exports/${id}`:`/api/v1/exports/${id}/download?merchantId=${api.merchantIds[0]}`}),{headers:{'content-type':'application/json'}});
    return base(input,init);
  };
  renderApp(`/exports?job=${id}`);
  await screen.findByText(/We could not load the export status/);
  expect(screen.queryByRole('link',{name:'Open saved export'})).toBeNull();
  await waitFor(()=>expect(api.calls.filter(call=>call.path==='/v1/exports'&&call.method==='POST')).toHaveLength(0));
});
it('lists deleted files under File deleted, never under Ready to download or Failed',async()=>{
  const user=userEvent.setup();
  const saved=(state:Parameters<Parameters<FakeApi['mutate']>[0]>[0],minute:number,status:string,removed:boolean)=>makeRecord(state,'exports',{status,name:`Synthetic ${minute}`,createdAt:`2026-09-19T0${minute}:00:00.000Z`,data:{kind:'customers',format:'json',...(status==='ready'?{checksum:'a'.repeat(64),generatedAt:api.now}:{lastError:'Generation could not finish.'}),...(removed?{fileDeletedAt:'2026-09-19T09:30:00.000Z'}:{})}});
  api.mutate(state=>{saved(state,1,'ready',false);saved(state,2,'ready',true);saved(state,3,'failed',false);saved(state,4,'failed',true);});
  const rows=()=>screen.getAllByText(/^\d.* · (Ready to download|Failed|File deleted)$/).map(row=>row.textContent!.replace(/^.* · /,''));
  renderApp('/exports?status=expired');
  const filter=await screen.findByRole('combobox',{name:'Export status'});
  expect([...filter.querySelectorAll('option')].map(option=>[option.value,option.textContent])).toEqual([['all','All exports'],['queued','Waiting'],['running','In progress'],['ready','Ready to download'],['failed','Failed'],['expired','File deleted']]);
  expect((filter as HTMLSelectElement).value).toBe('expired');
  await waitFor(()=>expect(rows()).toEqual(['File deleted','File deleted']));
  expect(api.calls.some(call=>call.path==='/v1/records/exports'&&call.query.status==='expired')).toBe(true);
  await user.selectOptions(filter,'ready');
  await waitFor(()=>expect(rows()).toEqual(['Ready to download']));
  await user.selectOptions(filter,'failed');
  await waitFor(()=>expect(rows()).toEqual(['Failed']));
  await user.selectOptions(filter,'all');
  await waitFor(()=>expect(rows()).toEqual(['File deleted','Failed','File deleted','Ready to download']));
});
it('names the deletion run that deleted a file and opens its deletion record under Data retention, however many runs follow it',async()=>{
  const user=userEvent.setup(),minute=(n:number)=>new Date(Date.UTC(2026,8,25,10,n)).toISOString();
  api.now=minute(0);
  const id=api.mutate(state=>makeRecord(state,'exports',{status:'ready',name:'Synthetic customers',createdAt:'2026-06-01T09:00:00.000Z',data:{kind:'customers',format:'json',checksum:'c'.repeat(64),generatedAt:'2026-06-01T09:00:00.000Z',byteLength:12}}).id);
  api.mutate((state,ctx)=>saveLifecyclePolicy(state,ctx,{policy:{rawCsvDays:null,journalPayloadDays:null,exportFileDays:30,auditTrail:'retain'},expectedRevision:lifecyclePolicy(state).revision,reason:'Remove synthetic export files after thirty days.'}));
  // The stored file, as the store's retention inventory lists it.
  const file=[{kind:'export_file' as const,merchantId:api.merchantIds[0]!,sourceId:id,version:'generation-1',createdAt:'2026-06-01T09:00:00.000Z',label:'Private export file',digest:'d'.repeat(64),status:'ready' as const}];
  // The run that removes the file, then ten newer previews: Data retention lists only the newest ten runs.
  const run=api.mutate((state,ctx)=>lifecyclePreview(state,ctx,{expectedPolicyRevision:lifecyclePolicy(state).revision},file));
  for(let n=1;n<=10;n++){api.now=minute(n);api.mutate((state,ctx)=>lifecyclePreview(state,ctx,{expectedPolicyRevision:lifecyclePolicy(state).revision},file));}
  api.now=minute(11);
  const ctx=api.mutate((state,ctx)=>{approveLifecycleRun(state,ctx,run.id,{expectedUpdatedAt:run.updatedAt,previewDigest:run.previewDigest,reason:'Approved the exact synthetic export file.'},file);return ctx;});
  // As the Data retention page's execute leaves it (fake-api.ts).
  const state=api.state();
  expect((await executeApprovedRun(state,ctx,run.id,file,async candidate=>{Object.assign(state.records.find(record=>record.id===candidate.sourceId)!.data,{fileDeletedAt:ctx.now,fileRetentionRunId:run.id});return 'deleted';})).status).toBe('completed');
  renderApp(`/exports?job=${id}`);
  await screen.findByText('Saved export: File deleted');
  expect(screen.getByText(`Deletion run: ${run.id}`)).toBeTruthy();
  await user.click(screen.getByRole('link',{name:'Open the deletion record'}));
  const receipts=(await screen.findByRole('heading',{name:'Deletion records'})).parentElement!;
  expect(screen.getByText(`Deletion run ${run.id} is shown below, with its deletion records.`)).toBeTruthy();
  expect(within(receipts).getByText(id).closest('li')!.textContent).toMatch(/^Export file · Deleted/);
  // The page's list of saved runs holds the newest ten, which no longer include it.
  const listed=screen.getByRole('heading',{name:'Deletion runs'}).closest('section')!.querySelectorAll('li');
  expect(listed).toHaveLength(10);
  expect([...listed].some(item=>item.textContent!.includes(formatDate(minute(0))))).toBe(false);
  expect(api.calls.some(call=>call.method==='GET'&&call.path===`/v1/lifecycle/runs/${run.id}`)).toBe(true);
});
