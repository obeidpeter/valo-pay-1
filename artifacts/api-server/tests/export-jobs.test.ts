import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { seedMerchant } from '../src/lib/valopay-seed';
import { queueExport, retryExport, exportJobView, exportHealth, exportIsClaimable, processExportJob, retryExportWrite, EXPORT_WRITE_ATTEMPTS, EXPORT_LEASE_MS, EXPORT_STALL_MS, EXPORT_CONFIRM_LEASE_MS, MAX_EXPORT_BYTES, type ClaimedExport, type ExportArtifact, type ExportJobRepository, type ExportJobStorage, type ExportStage } from '../src/lib/export-jobs';
import type { DomainState } from '../src/domain/types';
import { makeRecord } from '../src/domain/records';
import { bindCloseReviewBasis, closeReviewIssues, decideCloseReview, prepareCloseReview, summariseLoadedClose } from '../src/domain/close-review';
// Imports initialize the shared pool, but this suite never connects to it.
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
const {generateExportArtifact,exportDescriptor}=await import('../src/lib/valopay-exports');
const {runExportPass,startExportWorker}=await import('../src/lib/export-worker');

let checks = 0;
const now = '2026-09-18T10:00:00.000Z';
const ctx = { actor: 'Sandbox Finance', role: 'Finance', now };
const initial = seedMerchant('export-jobs-fixture');
const state: DomainState = initial;
let clock = Date.parse(now), transaction = false, failFinish = false, failFailure = false;
const objects = new Map<string, { bytes: Buffer; artifact: ExportArtifact }>();
let uploads = 0, generations = 0, lostUploadResponse = false, failUpload = false;
const job = queueExport(state, ctx, { kind: 'customers', format: 'json' }, '/private/test');
assert.equal(job.status, 'queued'); assert.equal(objects.size, 0); checks += 2;
// A read-only role downloads existing evidence; it neither queues nor requeues generation. The customer register is a
// sensitive export (export_sensitive), which Read-only may not have at all, so it is refused in those words.
const readOnly = { ...ctx, role: 'Read-only' };
assert.throws(() => queueExport(state, readOnly, { kind: 'mandates', format: 'json' }, '/private/test'), (error: any) => error.status === 403 && /^Only an Admin, Operations, Finance or Compliance reviewer can create exports\. Read-only can still download exports already made\./.test(error.message));
assert.throws(() => queueExport(state, readOnly, { kind: 'customers', format: 'json' }, '/private/test'), (error: any) => error.status === 403 && /Only an Admin, Finance or Compliance reviewer/.test(error.message));
assert.throws(() => retryExport(state, readOnly, job.id), (error: any) => error.status === 403 && /Only an Admin, Finance or Compliance reviewer/.test(error.message));
assert.equal(state.records.filter(record => record.kind === 'exports').length, 1); checks += 4;
{
  // Another lender's mandate export: Read-only may download it, and is refused its retry as read-only.
  const other = seedMerchant('export-jobs-read-only'), mandates = queueExport(other, ctx, { kind: 'mandates', format: 'json' }, '/private/test');
  assert.throws(() => retryExport(other, readOnly, mandates.id), (error: any) => error.status === 403 && /^Only an Admin, Operations, Finance or Compliance reviewer can retry exports\. Read-only can still download exports already made\./.test(error.message)); checks++;
}
const repository: ExportJobRepository = {
  async queueEnd() { return state.records.filter(record => record.kind === 'exports' && exportIsClaimable(record, new Date(clock).toISOString())).sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).at(-1); },
  async candidates(limit, after) { return state.records.filter(record => record.kind === 'exports' && exportIsClaimable(record, new Date(clock).toISOString()) && (!after || record.createdAt > after.createdAt || (record.createdAt === after.createdAt && record.id > after.id))).sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).slice(0, limit).map(record => ({ merchantId: record.merchantId, id: record.id, createdAt: record.createdAt })); },
  async claim(merchantId, id) {
    transaction = true;
    try {
      const record = state.records.find(record => record.kind === 'exports' && record.id === id && record.merchantId === merchantId);
      if (!record || !exportIsClaimable(record, new Date(clock).toISOString())) return null;
      const token = randomUUID(); record.status = 'running'; Object.assign(record.data, { leaseToken: token, leaseExpiresAt: new Date(clock + EXPORT_LEASE_MS).toISOString(), attempts: Number(record.data.attempts || 0) + 1 });
      return { merchantId, id, token, state: structuredClone(state), context: { ...ctx, now: new Date(clock).toISOString() }, input: { kind: record.data.kind, format: record.data.format }, location: { bucket: record.data.bucket, objectName: record.data.objectName } };
    } finally { transaction = false; }
  },
  async finish(claim, artifact) {
    if (failFinish) throw new Error('Commit failed');
    const record = state.records.find(record => record.id === claim.id)!;
    if (record.data.leaseToken !== claim.token) return 'lost';
    record.status = 'ready'; Object.assign(record.data, artifact, {stage:'ready',lastProgressAt:new Date(clock).toISOString()}); delete record.data.leaseToken; return 'saved';
  },
  async fail(claim, message) {
    if (failFailure) throw new Error('Database unavailable');
    const record = state.records.find(record => record.id === claim.id)!;
    if (record.data.leaseToken !== claim.token) return 'lost';
    record.status = 'failed'; record.data.lastError = message; delete record.data.leaseToken; return 'saved';
  },
  async release(claim) {
    const record = state.records.find(record => record.id === claim.id)!;
    if (record.status !== 'running' || record.data.leaseToken !== claim.token) return 'lost';
    record.status = 'queued'; record.data.stage = 'queued'; record.data.lastProgressAt = new Date(clock).toISOString();
    delete record.data.leaseToken; delete record.data.leaseExpiresAt; delete record.data.lastError; return 'saved';
  },
  async progress(claim,stage) {
    const record=state.records.find(record=>record.id===claim.id)!;
    if(record.data.leaseToken!==claim.token)return 'lost';
    record.data.stage=stage;record.data.lastProgressAt=new Date(clock).toISOString();
    if(stage==='confirming')record.data.leaseExpiresAt=new Date(clock+EXPORT_CONFIRM_LEASE_MS).toISOString();
    return 'saved';
  },
};
const storage: ExportJobStorage = {
  async existing(claim) { assert.equal(transaction, false); checks++; return objects.get(claim.location.objectName)?.artifact || null; },
  async put(claim, bytes, artifact) {
    assert.equal(transaction, false); checks++;
    if (failUpload) throw new Error('Private provider detail must not leak');
    assert.equal(objects.has(claim.location.objectName), false); checks++;
    objects.set(claim.location.objectName, { bytes, artifact }); uploads++;
    if (lostUploadResponse) throw new Error('Acknowledgement lost');
  },
};
const generate = async (claim: ClaimedExport) => { assert.equal(transaction, false); checks++; generations++; return generateExportArtifact(claim); };
const target = { merchantId: state.merchant.id, id: job.id, createdAt: now };
lostUploadResponse = true;
assert.equal(await processExportJob(repository, storage, generate, target), 'ready'); checks++;
assert.equal(uploads, 1); assert.equal(generations, 1); checks += 2;
const checksum = exportJobView(state.records.find(record => record.id === job.id)!).checksum;
assert.equal(checksum, createHash('sha256').update([...objects.values()][0]!.bytes).digest('hex')); checks++;
assert.equal(await processExportJob(repository, storage, generate, target), 'skipped'); checks++;
// A file an approved retention run removed says when, keeps its checksum and names the run that holds its deletion receipt.
const removedRow = structuredClone(state.records.find(record => record.id === job.id)!);
Object.assign(removedRow.data, { fileDeletedAt: '2026-09-01T09:00:00.000Z', fileRetentionRunId: 'retention-run-1' });
assert.deepEqual((({ expiredAt, retentionRunId, checksum: kept }) => ({ expiredAt, retentionRunId, kept }))(exportJobView(removedRow)), { expiredAt: '2026-09-01T09:00:00.000Z', retentionRunId: 'retention-run-1', kept: checksum }); checks++;
assert.equal('retentionRunId' in exportJobView(state.records.find(record => record.id === job.id)!), false); checks++;

// Upload succeeded but final database commit failed. Retry adopts the same immutable bytes and key.
const second = queueExport(state, ctx, { kind: 'customers', format: 'csv' }, '/private/test');
failFinish = true; lostUploadResponse = false;
assert.equal(await processExportJob(repository, storage, generate, { ...target, id: second.id }), 'failed'); checks++;
assert.equal(exportJobView(state.records.find(record => record.id === second.id)!).status, 'failed'); checks++;
retryExport(state, ctx, second.id); failFinish = false;
assert.equal(await processExportJob(repository, storage, generate, { ...target, id: second.id }), 'ready'); checks++;
assert.equal(uploads, 2); assert.equal(generations, 2); checks += 2;

// A process dies after upload and cannot record a failure; another worker recovers only after lease expiry.
const third = queueExport(state, ctx, { kind: 'customers', format: 'json' }, '/private/test');
failFinish = true; failFailure = true;
await processExportJob(repository, storage, generate, { ...target, id: third.id });
assert.equal(await repository.claim(target.merchantId, third.id), null); checks++;
clock += EXPORT_LEASE_MS + 1; failFinish = false; failFailure = false;
assert.equal(await processExportJob(repository, storage, generate, { ...target, id: third.id }), 'ready'); checks++;
assert.equal(uploads, 3); assert.equal(generations, 3); checks += 2;

// Fencing prevents an expired worker from completing over the successor's claim.
const fourth = queueExport(state, ctx, { kind: 'customers', format: 'csv' }, '/private/test');
const old = (await repository.claim(target.merchantId, fourth.id))!;
clock += EXPORT_LEASE_MS + 1;
const newer = (await repository.claim(target.merchantId, fourth.id))!;
assert.notEqual(old.token, newer.token); checks++;
assert.equal(await repository.finish(old, [...objects.values()][0]!.artifact), 'lost'); checks++;
assert.equal(await repository.finish(newer, [...objects.values()][0]!.artifact), 'saved'); checks++;

const failed = queueExport(state, ctx, { kind: 'customers', format: 'json' }, '/private/test');
failUpload = true;
await processExportJob(repository, storage, generate, { ...target, id: failed.id });
assert.doesNotMatch(exportJobView(state.records.find(record => record.id === failed.id)!).error!, /Private provider/); checks++;
assert.throws(() => exportDescriptor(state, failed.id), (error: any) => error.status === 409); checks++;
assert.throws(() => retryExport({ ...state, records: [] }, ctx, failed.id), (error: any) => error.status === 404); checks++;
assert.throws(() => queueExport(state, ctx, { kind: 'dispute-pack', customerId: 'other-lender-customer', format: 'pdf' }, '/private/test'), (error: any) => error.status === 404); checks++;

// A bounded lookahead prevents a locked lender's old jobs from starving others;
// the consumer pool still runs only two generations/uploads at once.
failUpload = false;
for (let index = 0; index < 4; index++) queueExport(state, ctx, { kind: 'customers', format: 'json' }, '/private/test');
let concurrent = 0, peak = 0;
await runExportPass({ repository, storage, generate: async claim => { concurrent++; peak = Math.max(peak, concurrent); await new Promise(resolve => setTimeout(resolve, 5)); try { return await generate(claim); } finally { concurrent--; } } });
assert.equal(peak, 2); checks++;
assert.ok(MAX_EXPORT_BYTES <= 32 * 1024 * 1024); checks++;
let attempted:string[]=[];
const targets=Array.from({length:5},(_,index)=>({merchantId:target.merchantId,id:`blocked-${index}`,createdAt:now}));
await runExportPass({repository:{...repository,candidates:async limit=>{assert.equal(limit,20);return targets;},claim:async(_merchant,id)=>{attempted.push(id);return null;}},storage,generate});
assert.equal(attempted.length,5);checks++;

// Two full lender queues used to hide every newer job forever. The actual
// worker continues its bounded scan across ticks, then revisits skipped work.
{
 const pending = Array.from({length:61},(_,index)=>({merchantId:`lender-${Math.floor(index/10)}`,id:`fair-${String(index).padStart(3,'0')}`,createdAt:now}));
 const visited:string[]=[];
 const scans:Array<string|undefined>=[];
 const fair = startExportWorker({intervalMs:60_000,repository:{...repository,
  queueEnd:async()=>pending.at(-1),
  candidates:async(limit,after)=>{scans.push(after?.id);return pending.filter(row=>!after || row.id>after.id).slice(0,limit);},
  claim:async(_merchant,id)=>{visited.push(id);return null;}
 },storage,generate});
 await fair.settle();
 for(let pass=0;pass<3;pass++)await fair.tick();
 assert.equal(new Set(visited).size,61,'all jobs beyond multiple full pages are attempted despite busy oldest lenders');
 assert.deepEqual(scans,[undefined,'fair-019','fair-039','fair-059']);
 await fair.tick();
 assert.equal(visited.filter(id=>id==='fair-000').length,2,'the next cycle revisits the oldest skipped work');
 fair.stop();await fair.settle();checks+=3;
 // Sustained arrivals cannot postpone a return to work skipped at the head.
 const growing = pending.slice(0,40), growthVisits:string[]=[];
 const growth = startExportWorker({intervalMs:60_000,repository:{...repository,
  queueEnd:async()=>growing.at(-1),
  candidates:async(limit,after,through)=>growing.filter(row=>(!after||row.id>after.id)&&(!through||row.id<=through.id)).slice(0,limit),
  claim:async(_merchant,id)=>{growthVisits.push(id);return null;}
 },storage,generate});
 await growth.settle();
 for(let page=0;page<3;page++){
  for(let n=0;n<20;n++)growing.push({...pending[0]!,id:`fair-${String(growing.length).padStart(3,'0')}`});
  await growth.tick();
 }
 assert.equal(growthVisits.filter(id=>id==='fair-000').length,2,'fixed sweep end revisits old work even as a full page arrives each pass');
 growth.stop();await growth.settle();checks++;
 // A removed final page wraps immediately; failed scans preserve the cursor.
 const scan={after:{id:'removed',createdAt:now}};
 let reads=0;
 await runExportPass({scan,repository:{...repository,candidates:async(_limit,after)=>{reads++;return after?[]:[pending[0]!];},claim:async()=>null},storage,generate});
 assert.equal(reads,2);assert.equal(scan.after,undefined);checks+=2;
}

// A large output is rejected before upload, and an oversized source is rejected
// before rendering. The successful sample records a real byte-generation cost.
const oversized=queueExport(state,ctx,{kind:'customers',format:'json'},'/private/test');
const oversizedTarget={...target,id:oversized.id};
const beforeOversized=uploads;
await processExportJob(repository,storage,async()=>({bytes:Buffer.alloc(MAX_EXPORT_BYTES+1),artifact:[...objects.values()][0]!.artifact}),oversizedTarget);
assert.equal(uploads,beforeOversized);assert.match(exportJobView(state.records.find(r=>r.id===oversized.id)!).error!,/32 MB/);checks+=2;
const volumeState=seedMerchant('volume-fixture');
const template=volumeState.records.find(record=>record.kind==='customers')!;
volumeState.records=Array.from({length:10000},(_,index)=>({...structuredClone(template),id:`volume-${index}`,name:`Synthetic customer ${index}`,reference:`SAMPLE-${index}`}));
const volumeClaim:ClaimedExport={...newer,state:volumeState,input:{kind:'customers',format:'json'}};
const volume=await generateExportArtifact(volumeClaim);
assert.equal(JSON.parse(volume.bytes.toString()).data.length,10000);assert.ok(volume.bytes.length<MAX_EXPORT_BYTES);checks+=2;
volumeState.records[0]!.data.note='x'.repeat(MAX_EXPORT_BYTES+1);
await assert.rejects(generateExportArtifact(volumeClaim),(error:any)=>error.exportTooLarge===true);checks++;
volumeState.records.push({...structuredClone(template),id:'unrelated-large-history',kind:'observations',data:{note:volumeState.records[0]!.data.note}});
delete volumeState.records[0]!.data.note;
assert.equal(JSON.parse((await generateExportArtifact(volumeClaim)).bytes.toString()).data.length,10000,'unrelated lender history does not block a smaller category export');checks++;
const {buildReports}=await import('../src/domain/reports');
const metricsState=seedMerchant('metric-fixture');
const customerId=metricsState.records.find(record=>record.kind==='customers')!.id;
const pendingPack=queueExport(metricsState,ctx,{kind:'dispute-pack',customerId,format:'json'},'/private/test');
const pack=metricsState.records.find(record=>record.id===pendingPack.id)!;
assert.equal(buildReports(metricsState,now).operational.disputePacksGenerated,0);pack.status='failed';assert.equal(buildReports(metricsState,now).operational.packsGenerated,0);pack.status='ready';assert.equal(buildReports(metricsState,now).operational.disputePacksGenerated,1);checks+=3;

// A transient merchant-lock conflict after upload is retried in this attempt,
// without another render, upload, claim or five-minute lease wait.
const contention=queueExport(state,ctx,{kind:'customers',format:'json'},'/private/test');
let finishes=0;
const beforeContention={uploads,generations};
assert.equal(await processExportJob({...repository,finish:async(claim,artifact)=>++finishes<3?'busy':repository.finish(claim,artifact)},storage,generate,{...target,id:contention.id},{backoffMs:0}),'ready');
assert.equal(finishes,3);assert.equal(uploads,beforeContention.uploads+1);assert.equal(generations,beforeContention.generations+1);checks+=4;
const stages:string[]=[];
const stuck=queueExport(state,ctx,{kind:'customers',format:'json'},'/private/test');
assert.equal(await processExportJob({...repository,progress:async(claim,stage)=>{stages.push(stage);return repository.progress!(claim,stage);},finish:async()=> 'busy'},storage,generate,{...target,id:stuck.id},{backoffMs:0}),'skipped');
const stuckRow=state.records.find(record=>record.id===stuck.id)!;
assert.deepEqual(stages,['rendering','uploading','confirming']);assert.equal(stuckRow.data.stage,'confirming');
assert.equal(Date.parse(stuckRow.data.leaseExpiresAt)-clock,EXPORT_CONFIRM_LEASE_MS);
assert.equal(exportHealth(stuckRow,new Date(clock+EXPORT_CONFIRM_LEASE_MS+1).toISOString()).retryAllowed,true);
const uploadedBeforeAdoption=uploads;
clock+=EXPORT_CONFIRM_LEASE_MS+1;
assert.equal(await processExportJob(repository,storage,async()=>{throw new Error('Must recover immutable file.');},{...target,id:stuck.id}),'ready');
assert.equal(uploads,uploadedBeforeAdoption);checks+=7;
let writes=0;
assert.equal(await retryExportWrite(async()=>{writes++;return 'busy';},undefined,0),'busy');assert.equal(writes,EXPORT_WRITE_ATTEMPTS);
writes=0;assert.equal(await retryExportWrite(async()=>{writes++;return 'lost';},undefined,0),'lost');assert.equal(writes,1);checks+=4;
const stalled=queueExport(state,ctx,{kind:'customers',format:'json'},'/private/test'),stalledRow=state.records.find(record=>record.id===stalled.id)!;
assert.equal(exportJobView(stalledRow,ctx.now).stalled,false);
const later=new Date(Date.parse(ctx.now)+EXPORT_STALL_MS).toISOString();
assert.equal(exportJobView(stalledRow,later).stalled,true);assert.equal(exportJobView(stalledRow,later).retryAllowed,false);
const {buildAlerts}=await import('../src/domain/alerts');
assert.ok(buildAlerts(state,later).some(alert=>alert.key==='exports_stalled'&&alert.linkedRecordId===stalled.id));checks+=4;

// Timeout reaches the actual blocked I/O, which unwinds before process returns.
const blocked=queueExport(state,ctx,{kind:'customers',format:'json'},'/private/test');
let cancelled=false,writeAfterCancellation=false;
const blockedStorage:ExportJobStorage={existing:async(_claim,signal)=>new Promise((_resolve,reject)=>{
  const abort=()=>{cancelled=true;reject(signal!.reason);};signal!.addEventListener('abort',abort,{once:true});if(signal!.aborted)abort();
}),put:async()=>{writeAfterCancellation=true;}};
assert.equal(await processExportJob(repository,blockedStorage,generate,{...target,id:blocked.id},{timeoutMs:10,backoffMs:0}),'failed');
assert.equal(cancelled,true);assert.equal(writeAfterCancellation,false);checks+=3;
const cancelledSignal=AbortSignal.abort(new Error('stop'));
await assert.rejects(generateExportArtifact(volumeClaim,cancelledSignal),/stop/);checks++;

// Shutdown cancels the two active reads and waits for their cleanup before
// releasing the pass; a third queued job cannot start after stop.
const stopTargets=Array.from({length:3},()=>({...target,id:queueExport(state,ctx,{kind:'customers',format:'json'},'/private/test').id}));
let stopClaims=0,activeReads=0;
let reachedTwo!:()=>void;
const twoReading=new Promise<void>(resolve=>{reachedTwo=resolve;});
const stopping=startExportWorker({intervalMs:60_000,repository:{...repository,candidates:async()=>stopTargets,claim:async(...args)=>{stopClaims++;return repository.claim(...args);}},storage:{existing:async(_claim,signal)=>new Promise((_resolve,reject)=>{
 activeReads++;if(activeReads===2)reachedTwo();
 const abort=()=>{setTimeout(()=>{activeReads--;reject(signal!.reason);},5);};
 signal!.addEventListener('abort',abort,{once:true});if(signal!.aborted)abort();
}),put:async()=>{throw new Error('Stopped reads must never upload.');}},generate});
await twoReading;stopping.stop();await stopping.settle();
assert.equal(activeReads,0);assert.equal(stopClaims,2);await stopping.tick();assert.equal(stopClaims,2);checks+=3;
// The stop says nothing about the exports: both return to the queue, unfailed.
for(const stopped of stopTargets.slice(0,2)){const row=state.records.find(record=>record.id===stopped.id)!;assert.equal(row.status,'queued');assert.equal(row.data.lastError,undefined);checks+=2;}

// A stop mid-upload hands the claim back instead of failing the job, so the
// next worker resumes it at once without a Retry or a five-minute lease wait.
const stopReason=()=>new Error('Export worker is stopping.');
const blockedUpload=(onUpload:()=>void):ExportJobStorage=>({existing:async()=>null,put:async(_claim,_bytes,_artifact,signal)=>new Promise((_resolve,reject)=>{
 signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true});onUpload();
})});
const releasedJob=queueExport(state,ctx,{kind:'customers',format:'json'},'/private/test');
const stopRelease=new AbortController();
assert.equal(await processExportJob(repository,blockedUpload(()=>stopRelease.abort(stopReason())),generate,{...target,id:releasedJob.id},{signal:stopRelease.signal,backoffMs:0}),'released');
const releasedRow=state.records.find(record=>record.id===releasedJob.id)!,releasedView=exportJobView(releasedRow,new Date(clock).toISOString());
assert.equal(releasedRow.status,'queued');assert.equal(releasedView.stage,'queued');assert.equal(releasedView.error,undefined);
assert.equal(releasedView.stalled,false);assert.equal(releasedView.retryAllowed,false);assert.equal(releasedRow.data.leaseToken,undefined);
assert.equal(exportIsClaimable(releasedRow,new Date(clock).toISOString()),true);checks+=7;
assert.equal(await processExportJob(repository,storage,generate,{...target,id:releasedJob.id}),'ready');assert.equal(releasedRow.data.attempts,2);checks+=2;
// The per-attempt timeout is not a stop: it still records a failure.
const timedOut=queueExport(state,ctx,{kind:'customers',format:'json'},'/private/test');
assert.equal(await processExportJob(repository,blockedUpload(()=>{}),generate,{...target,id:timedOut.id},{signal:new AbortController().signal,timeoutMs:10,backoffMs:0}),'failed');
assert.equal(state.records.find(record=>record.id===timedOut.id)!.status,'failed');checks+=2;

// The worker's stop() hands both active claims back and says so in its log.
const workerIds=[0,1].map(()=>queueExport(state,ctx,{kind:'customers',format:'json'},'/private/test').id);
let uploading=0,bothUploading!:()=>void;const bothBlocked=new Promise<void>(resolve=>{bothUploading=resolve;});
const lines:Array<{event:string;status?:string}>=[];
const releasing=startExportWorker({intervalMs:60_000,log:{info:(line:any)=>lines.push(line),error:(line:any)=>lines.push(line)} as any,
 repository:{...repository,candidates:async()=>workerIds.map(id=>({...target,id}))},storage:blockedUpload(()=>{if(++uploading===2)bothUploading();}),generate});
await bothBlocked;releasing.stop();await releasing.settle();
for(const id of workerIds){const row=state.records.find(record=>record.id===id)!;assert.equal(row.status,'queued');assert.equal(row.data.lastError,undefined);checks+=2;}
assert.deepEqual(lines.map(line=>[line.event,line.status]),[['export.job','released'],['export.job','released']]);checks++;

// When the hand-back cannot be written, the job keeps its lease and is never
// failed; a later poll recovers it once the lease expires.
for(const release of [async()=>{throw new Error('Database unavailable');},async()=>'busy' as const]){
 const unreleased=queueExport(state,ctx,{kind:'customers',format:'json'},'/private/test'),stop=new AbortController();
 assert.equal(await processExportJob({...repository,release},blockedUpload(()=>stop.abort(stopReason())),generate,{...target,id:unreleased.id},{signal:stop.signal,backoffMs:0}),'interrupted');
 const row=state.records.find(record=>record.id===unreleased.id)!;
 assert.equal(row.status,'running');assert.equal(row.data.lastError,undefined);assert.equal(exportIsClaimable(row,new Date(clock).toISOString()),false);
 clock+=EXPORT_LEASE_MS+1;
 assert.equal(await processExportJob(repository,storage,generate,{...target,id:unreleased.id}),'ready');checks+=5;
}
// A worker whose lease was superseded cannot hand back its successor's job.
const handedOver=queueExport(state,ctx,{kind:'customers',format:'json'},'/private/test');
const staleClaim=(await repository.claim(target.merchantId,handedOver.id))!;
clock+=EXPORT_LEASE_MS+1;
const currentClaim=(await repository.claim(target.merchantId,handedOver.id))!;
const staleStop=new AbortController();
assert.equal(await processExportJob({...repository,claim:async()=>staleClaim,progress:async()=>'saved'},blockedUpload(()=>staleStop.abort(stopReason())),generate,{...target,id:handedOver.id},{signal:staleStop.signal,backoffMs:0}),'skipped');
const handedOverRow=state.records.find(record=>record.id===handedOver.id)!;
assert.equal(handedOverRow.status,'running');assert.equal(handedOverRow.data.leaseToken,currentClaim.token);
assert.equal(await repository.release(currentClaim),'saved');assert.equal(handedOverRow.status,'queued');checks+=5;

// A progress write the lender stays too busy for hands the claim back: the job is queued again at once, never left
// running under a lease minutes away with Retry unavailable, and the next attempt finishes it.
for(const stage of ['rendering','uploading','confirming'] as const){
 const busyJob=queueExport(state,ctx,{kind:'customers',format:'json'},'/private/test'),reasons:unknown[]=[];
 const busyAt=async(claim:ClaimedExport,written:ExportStage)=>written===stage?'busy' as const:repository.progress!(claim,written);
 assert.equal(await processExportJob({...repository,progress:busyAt,release:async(claim,reason)=>{reasons.push(reason);return repository.release(claim,reason);}},storage,generate,{...target,id:busyJob.id},{backoffMs:0}),'requeued',stage);
 const requeued=state.records.find(record=>record.id===busyJob.id)!;
 assert.deepEqual(reasons,['busy']);assert.equal(requeued.status,'queued');assert.equal(requeued.data.leaseExpiresAt,undefined);
 assert.equal(exportIsClaimable(requeued,new Date(clock).toISOString()),true);assert.equal(exportJobView(requeued,new Date(clock).toISOString()).stalled,false);
 assert.equal(await processExportJob(repository,storage,generate,{...target,id:busyJob.id}),'ready');checks+=6;
}
// So does a failure the lender stays too busy to record: the job is queued again, not left running under its lease.
const failedBusy=queueExport(state,ctx,{kind:'customers',format:'json'},'/private/test'),failReasons:unknown[]=[];
assert.equal(await processExportJob({...repository,fail:async()=>'busy',release:async(claim,reason)=>{failReasons.push(reason);return repository.release(claim,reason);}},{existing:async()=>null,put:async()=>{throw new Error('Private provider failure');}},generate,{...target,id:failedBusy.id},{backoffMs:0}),'requeued');
assert.deepEqual(failReasons,['busy']);assert.equal(state.records.find(record=>record.id===failedBusy.id)!.status,'queued');checks+=2;
// A hand-back the lender is still too busy for leaves the lease to recover the job, as a stop does; a superseded lease is left alone.
const stillBusy=queueExport(state,ctx,{kind:'customers',format:'json'},'/private/test');
assert.equal(await processExportJob({...repository,progress:async()=>'busy',release:async()=>'busy'},storage,generate,{...target,id:stillBusy.id},{backoffMs:0}),'interrupted');
assert.equal(state.records.find(record=>record.id===stillBusy.id)!.status,'running');
const supersededBusy=queueExport(state,ctx,{kind:'customers',format:'json'},'/private/test');
assert.equal(await processExportJob({...repository,progress:async()=>'busy',release:async()=>'lost'},storage,generate,{...target,id:supersededBusy.id},{backoffMs:0}),'skipped');checks+=3;
const {renderDisputePackPdf,buildDisputePack}=await import('../src/lib/valopay-packs');
const renderState=seedMerchant('bounded-pack');
const renderCustomer=renderState.records.find(record=>record.kind==='customers')!;
await assert.rejects(renderDisputePackPdf(buildDisputePack(renderState,ctx,renderCustomer.id),{timeoutMs:0}),/time limit|timed out/);checks++;
const oversizedField=buildDisputePack(renderState,ctx,renderCustomer.id);oversizedField.note='x'.repeat(50_001);
await assert.rejects(renderDisputePackPdf(oversizedField),(error:any)=>error.exportPdfFieldTooLarge===true);checks++;
{
  // Review of PR #71: loadState keeps a close more than seven days older than the newest as its summary, and the export
  // route loaded the lender that way, so an approved review of such a close, still current, was refused as no longer
  // current. Its currency check compares the whole close with the review's snapshot: the route now loads that close
  // whole (closeReviewIds), as the decision does, and a review that is stale is still refused.
  const lender = seedMerchant('reviewed-close-export'); lender.records = [];
  const at = (day: number) => `2026-09-${String(day).padStart(2, '0')}T08:00:00.000Z`;
  const daily = (day: number) => bindCloseReviewBasis(lender, makeRecord<string>(lender, 'closes', { name: `Synthetic close ${day} September`, status: 'completed', createdAt: at(day), data: { closedAt: at(day), report: { unallocated: { count: 0 }, proposed: { count: 0 }, possibleDuplicates: { count: 0 } }, operational: { attempts: 1 } } }));
  const close = daily(1), finance = { actor: 'Clerk:finance', principalId: 'person-finance', role: 'Finance', now: at(1) };
  const review = prepareCloseReview(lender, { actor: 'Clerk:operator', principalId: 'person-operator', role: 'Operations', now: at(1) }, { closeId: close.id, expectedUpdatedAt: close.updatedAt, reviewer: finance.actor, preparationNote: 'Checked the synthetic close inputs.', unresolvedAcceptance: 'Synthetic owners follow up the open items.', discrepancyResponses: closeReviewIssues(close).map(issue => ({ issueId: issue.id, explanation: 'Synthetic explanation for this check.' })) }, [finance]);
  decideCloseReview(lender, finance, review.id, { action: 'approve', expectedUpdatedAt: review.updatedAt, note: 'Independently checked this synthetic snapshot.', sourceExceptions: review.data.snapshot!.data.reviewBasis.sourceCompleteness.issues.map((issue: any) => ({ issueId: issue.id, reason: 'Accepted for this synthetic rehearsal only.', evidence: 'Synthetic delivery register.' })) });
  // Later business dates' closes leave the 1 September close more than seven days older than the newest.
  for (let day = 2; day <= 10; day++) daily(day);
  const input = { kind: 'reviewed-close', format: 'json' as const, closeReviewId: review.id };
  const summarised = { ...structuredClone(lender), records: structuredClone(lender).records.map(record => record.id === close.id ? summariseLoadedClose(record) : record) };
  assert.throws(() => queueExport(summarised, ctx, input, '/private/test'), (error: any) => error.status === 409 && /no longer current/.test(error.message), 'with its close only a summary, the check cannot find the review current');
  assert.equal(queueExport(structuredClone(lender), ctx, input, '/private/test').status, 'queued', 'with its close whole, the current review exports');
  const changed = structuredClone(lender);
  makeRecord(changed, 'customers', { name: 'Synthetic customer recorded after the close', status: 'active' });
  assert.throws(() => queueExport(changed, ctx, input, '/private/test'), (error: any) => error.status === 409 && /no longer current/.test(error.message), 'a review whose records changed is still refused');
  checks += 3;
}
console.log(JSON.stringify({benchmark:'synthetic-export-volume',rows:10000,bytes:volume.bytes.length,generationMs:volume.artifact.generationMs,limitBytes:MAX_EXPORT_BYTES}));
console.log(`Export job tests passed (${checks} checks): durable queue, no I/O in a transaction, upload acknowledgement recovery, commit failure, expired leases, fencing, safe failures, tenant denial, two-worker bound, hand-back on stop and hand-back when the lender stays busy.`);
