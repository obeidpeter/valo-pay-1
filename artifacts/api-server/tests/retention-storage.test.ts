import assert from 'node:assert/strict';
import * as exportDownload from '../src/lib/export-download';
const { deleteRetainedExport } = exportDownload;
process.env.DATABASE_URL||='postgres://unused:unused@127.0.0.1:1/unused';
const {assertFinalState,removeSweptExportFiles,overrideSweptExportRemoval}=await import('../src/lib/valopay-store');
const {seedMerchant}=await import('../src/lib/valopay-seed');
const {makeRecord}=await import('../src/domain/records');
const {saveLifecyclePolicy,lifecyclePolicy,lifecyclePreview,approveLifecycleRun,eraseLifecycleRawCsv,recordLifecycleReceipt}=await import('../src/domain/lifecycle');
const originalFetch=globalThis.fetch;
const file={bucket:{name:'private-bucket'},name:'exports/lender/file?not-a-query.json',storage:{apiEndpoint:'https://storage.googleapis.com',authClient:{getRequestHeaders:async()=>new Headers()}}} as any;
const expected={id:'export-1',merchantId:'lender',checksum:'a'.repeat(64)};
let gets=0,deletes=0,mode='ok';
globalThis.fetch=async(input,options)=>{
 const url=new URL(String(input));assert.equal(url.host,'storage.googleapis.com');assert.ok(url.pathname.includes('%3F'));
 if(options?.method==='DELETE'){deletes++;assert.equal(url.searchParams.get('ifGenerationMatch'),'12345678901234567890');return new Response(null,{status:mode==='changed'?412:204});}
 gets++;if(mode==='absent'||mode==='down'||mode==='refused')return new Response(null,{status:mode==='absent'?404:mode==='down'?503:403});
 return new Response(JSON.stringify({generation:mode==='ungenerated'?'synthetic-generation':'12345678901234567890',metadata:{valopayExportId:mode==='other'?'export-other':expected.id,valopayMerchantId:expected.merchantId,valopayArtifact:mode==='unreadable'?'{synthetic':JSON.stringify({checksum:mode==='corrupt'?'b'.repeat(64):expected.checksum})}}));
};
try{
 assert.equal(await deleteRetainedExport(file,expected),'deleted');assert.equal(deletes,1);
 mode='absent';assert.equal(await deleteRetainedExport(file,expected),'already_absent');assert.equal(deletes,1);
 // A file whose identity does not match is refused with a bounded reason, which no retry changes; it is never deleted.
 for(const [scenario,mismatch] of [['other','ownership_mismatch'],['ungenerated','generation_invalid'],['unreadable','artifact_metadata_invalid'],['corrupt','checksum_mismatch']]){mode=scenario;await assert.rejects(()=>deleteRetainedExport(file,expected),(error:any)=>error.mismatch===mismatch,scenario);assert.equal(deletes,1);}
 // Storage that is down or refuses this service, and the delete's generation race, carry no such reason: they are retried.
 for(const scenario of ['down','refused']){mode=scenario;await assert.rejects(()=>deleteRetainedExport(file,expected),(error:any)=>error.mismatch===undefined,scenario);assert.equal(deletes,1);}
 mode='changed';await assert.rejects(()=>deleteRetainedExport(file,expected),(error:any)=>/could not be deleted/.test(error.message)&&error.mismatch===undefined);assert.equal(deletes,2);
}finally{globalThis.fetch=originalFetch;}
// A retry first obtains storage credentials, as every storage request does, within its limit, and is refused without
// them: a source that fails or never answers gives false. The sources are injected, so nothing leaves this machine.
{
 const available=(exportDownload as Record<string,any>).storageCredentialsAvailable;
 assert.equal(typeof available,'function','the cleanup command can check storage credentials before it claims a file');
 assert.equal(await available({getRequestHeaders:async()=>new Headers()},50),true);
 assert.equal(await available({getRequestHeaders:async()=>{throw new Error('connect ECONNREFUSED 127.0.0.1:1106');}},50),false);
 const started=performance.now();
 assert.equal(await available({getRequestHeaders:()=>new Promise(()=>{})},50),false);
 assert.ok(performance.now()-started<2000,'a source that never answers is given up at its limit');
}
const state=seedMerchant('retention-lender'),ctx={actor:'Sandbox Admin',role:'Admin',now:'2030-02-02T00:00:00.000Z'};
const batch=makeRecord(state,'import-batches',{status:'committed',createdAt:'2029-01-01T00:00:00.000Z',data:{csv:'SYNTHETIC ONLY',committedAt:'2029-01-01T00:00:00.000Z',check:{preview:[{synthetic:true}]}}});
saveLifecyclePolicy(state,ctx,{policy:{rawCsvDays:30,journalPayloadDays:null,exportFileDays:null,auditTrail:'retain'},expectedRevision:lifecyclePolicy(state).revision,reason:'Synthetic retention rehearsal policy.'});
const preview=lifecyclePreview(state,ctx,{expectedPolicyRevision:lifecyclePolicy(state).revision});
approveLifecycleRun(state,ctx,preview.id,{expectedUpdatedAt:preview.updatedAt,previewDigest:preview.previewDigest,reason:'Reviewed the one exact synthetic source.'});
const snapshot=structuredClone(state),candidate=preview.candidates[0];
eraseLifecycleRawCsv(state,ctx,preview.id,candidate);recordLifecycleReceipt(state,ctx,preview.id,candidate,'deleted','Synthetic raw CSV removed.');
assert.doesNotThrow(()=>assertFinalState(snapshot,state,state.merchant.id,ctx.now));
const forged=structuredClone(snapshot);delete forged.records.find(r=>r.id===batch.id)!.data.csv;
assert.throws(()=>assertFinalState(snapshot,forged,state.merchant.id,ctx.now),/An imported batch cannot be changed\. Propose an import correction instead\./);
state.records.find(r=>r.id===batch.id)!.name='Unrelated hidden change';
assert.throws(()=>assertFinalState(snapshot,state,state.merchant.id,ctx.now),/An imported batch cannot be changed\. Propose an import correction instead\./);
// Without the durable queue, the post-commit request fails safe: no deletion starts from transient memory alone.
// Retry budgets, leases, process loss and storage failures are exercised with the real queue in export-expiry.integration.
{
 const tried:string[]=[],lines:Array<Record<string,unknown>>=[];
 const file=(exportId:string,checksum?:string)=>({merchantId:'swept-lender',exportId,bucket:'private-bucket',objectName:`exports/swept-lender/${exportId}.json`,...(checksum?{checksum}:{})});
 const restore=overrideSweptExportRemoval(async swept=>{tried.push(swept.exportId);return 'deleted';});
 try{
  await removeSweptExportFiles([file('ready','a'.repeat(64)),file('refused'),file('slow'),file('late','b'.repeat(64))],{warn:fields=>lines.push(fields as Record<string,unknown>)},1000);
  assert.deepEqual(tried,[], 'no removal runs without a durable claim');
  assert.deepEqual(lines,[{event:'workspace.sweep_cleanup_deferred'}], 'the bootstrap survives queue failure without leaking private paths');
  await removeSweptExportFiles([file('refused')],{warn:()=>{throw new Error('Synthetic log failure');}});
 }finally{restore();}
}
console.log('Retention storage checks passed: ownership, checksum, generation fence, a bounded reason for each identity mismatch and none for storage failures or the generation race, storage credentials checked within a limit, absent-file retry, narrow immutable-record exception and the files a sandbox sweep leaves.');
