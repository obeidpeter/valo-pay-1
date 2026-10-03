import { getCustomerHistory } from '../lib/valo-pay-1-store';
import { listReconciliation, listCloseHistory, getCloseDetail, loadReportsView } from '../lib/valo-pay-1-store';
import { Router, type Request, type Response, type IRouter } from "express";
import * as S from "@workspace/valo-pay-1-api-zod";
import { z } from "zod";
import { inWorkspace, loadState, loadCustomerView, loadSettingsView, listRecords, saveState, settleChanges, addedRecords, auditObject, roles, fail, appendAudit, auditOverview, verifyAuditTrail, listMerchants, findIdempotency, findStoredAnswer, saveIdempotency, receiptOf, changeRole, dailyAuditCheckDue, writeAuditCheck, type StoreContext } from "../lib/valo-pay-1-store";
import { requestFingerprint } from "../lib/digests";
import { amendDueItem, customerTimeline, makeRecord, rescheduleAfterSettings, validateRecord, executeAction, withAuditNote, type TypedRecord } from "../domain";
import { enrolEligibleFailures } from "../domain/policy-engine";
import { bindCloseReviewBasis } from '../domain/close-review';
import { assertNoDirectImportedCorrection } from '../domain/import-corrections';
import { ABSOLUTE_TICKET_FLOOR_KOBO, authorisationModes, closeTimeOf, defaultStatus, executionWindow, handBackOwners, instantInputSchema, isCloseTime, pathId, recordKinds } from "@workspace/valo-pay-1-schema";
import type { DomainState, ValopayRecord } from "../domain/types";
import { getGates } from "../lib/valo-pay-1-readiness";
import { importCsv, withRowIdColumn } from "../lib/valo-pay-1-import";
import { exportDescriptorForRecord, exportKinds, readExport } from "../lib/valo-pay-1-exports";
import { recordTypeName, withAuditName } from "../lib/action-names";
import { UNKNOWN_DEMO_ROLE, demoRoleHint, notFound, onlyRoles } from "../lib/refusal-words";
import { assertExportPermitted, exportJobView, publicExportRecord, queueExport, retryExport } from '../lib/export-jobs';
import { assertRecordVersion, assertSettingsVersion, mergeData } from "../lib/edit-versions";
import { schedulerStatus } from "../lib/close-scheduler";
import { requestDailyAuditCheck } from "../lib/background-worker";
import { buildConsoleOverview, buildConsoleReports, buildConsoleSettings } from "../lib/valo-pay-1-close-views";
import { listQueue } from '../lib/valo-pay-1-store';
import { completeOperation, viewerScope } from '../lib/valo-pay-1-store';
import { contractAnswer, lenderQuery, optionalKey, replayedAnswer, requiredKey } from '../lib/contract';
import { routerOptions } from './router-options';

const router:IRouter=Router(routerOptions);
const kinds=new Set<string>(recordKinds);
/** A list's query: an incremental sync's watermark is an RFC 3339 instant with Z or an offset, refused (400, naming updatedSince) otherwise. */
const listRecordsQuery=S.ListRecordsQueryParams.extend({updatedSince:instantInputSchema.optional()});
function safeKind(value:unknown):string { const kind=z.string().parse(value,{path:["kind"]});if(!kinds.has(kind))fail("Unknown resource.",404);return kind; }
/**
 * An edit's body, parsed before the lender is loaded, and the version it names,
 * checked in the lender's transaction: a keyed repeat is answered from its
 * receipt first, so an edit an earlier build saved without a version keeps its
 * result, and any other edit without one is refused (400, naming it).
 */
const recordEdit=S.UpdateRecordBody.omit({expectedUpdatedAt:true}),recordVersion=S.UpdateRecordBody.pick({expectedUpdatedAt:true});
const settingsEdit=S.UpdateSettingsBody.omit({expectedRevision:true}),settingsVersion=S.UpdateSettingsBody.pick({expectedRevision:true});
/**
 * What a write's audit entry takes from its request, as the route's schema
 * parsed it: the action a route runs by name, the record its body names and
 * the reason. A route passes only fields its schema has.
 */
export type AuditInput = { action?: string; recordId?: string; reason?: string };
/**
 * One lender's state for a route: read from the read's snapshot, or written
 * under the exclusive lock with an audit entry and, when the request carries
 * an Idempotency-Key, a receipt its repeat is answered from. A fresh answer is
 * checked against the route's response schema before COMMIT, so an answer that
 * does not match its contract is a 500 that saved nothing. A replayed receipt
 * was saved with its request, so it is never answered as saving nothing: it is
 * given without fields the contract no longer lists, or as a 500 that says the
 * request was saved (replayedAnswer, lib/contract.ts). A receipt is kept where
 * receiptOf says, and a read is never fingerprinted. A repeat is answered from
 * its receipt before the lender is loaded, so it neither loads nor waits for
 * the lender. `wholeCloses` keeps that many of the newest closes whole in the
 * load (loadState).
 *
 * A write's audit entry takes nothing from the raw body: its action is the
 * route's (or the action the route parsed), its object comes from the route or
 * the record the write changed (auditObject), and its summary is the reason
 * the route's own schema carries, passed in `audit`, or the default.
 */
export async function withState<S extends z.ZodTypeAny>(req:Request,res:Response,operation:(state:DomainState,context:StoreContext)=>unknown,mutating:boolean,responseSchema:S,audit:AuditInput={},options:{wholeCloses?:number;wholeCloseIds?:string[];closeReviewIds?:string[]}={}):Promise<z.output<S>>{
 const {merchantId}=lenderQuery(req);
 // A write's key is checked by name before anything runs; a read ignores one, and nothing of a read is fingerprinted.
 const key=mutating?optionalKey(req):undefined;
 const setRole=req.path==="/v1/actions"&&req.body?.action==="set_role";
 // Where a keyed write's answer is kept for its repeats; a demo-role switch is never journaled, so it keeps its own (receiptOf).
 const receipt=key?receiptOf(req,merchantId,key,setRole?"persona":"workspace"):undefined;
 return inWorkspace(req,res,async ctx=>{
  // A demo-role switch changes ctx.actor itself. Its unchanged retry must keep
  // the original request identity; all other actions stay persona-bound.
  const fingerprint=receipt?requestFingerprint({path:req.path,method:req.method,body:req.body,actor:setRole?"Sandbox role switch":ctx.actor}):"";
  const replay=async(found:{request_hash:string;response:unknown})=>{if(found.request_hash!==fingerprint)fail("This request was already sent with different details. Reload the page and try again.",409);const saved=replayedAnswer(req,responseSchema,found.response);await completeOperation(ctx,saved);return saved;};
  if(receipt){const found=await findStoredAnswer(ctx,merchantId,receipt.id,receipt.earlier);if(found)return replay(found);}
  // A read loads from its snapshot and takes no lock; a mutation takes the exclusive lock (and holds its journal entry first).
  const state=await loadState(ctx,merchantId,mutating?"update":"share",options);
  // Again once the entry is held: an attempt with the key that finished after the first look is visible only now.
  if(receipt){const found=await findIdempotency(ctx,receipt.id,receipt.earlier);if(found)return replay(found);}
   const rawResult=await operation(state,ctx);
   // Versions advance before the response is built, so it carries them; the audit entry commits to exactly what changed.
   let changes:ReturnType<typeof settleChanges>|undefined;
   if(mutating){enrolEligibleFailures(state,ctx);for(const close of addedRecords(ctx,state).filter(r=>r.kind==='closes'))bindCloseReviewBasis(state,close);changes=settleChanges(ctx,state);}
   // Validate before committing: an invalid response must not leave durable writes.
   const result=contractAnswer(responseSchema,rawResult);
  if(mutating){
   // A domain action may add what it established to the reason, such as the payer Finance identified: server-built text in its answer.
   const reason=audit.reason?.trim()||"Change to sample data.",auditNote=audit.action===undefined?undefined:(rawResult as {data?:{auditNote?:unknown}}|undefined)?.data?.auditNote;
   appendAudit(state,ctx,audit.action??`${req.method.toLowerCase()}.${req.path.split("/").slice(2).join(".")}`,auditObject(ctx,state,{path:req.params.id,body:audit.recordId,answer:rawResult},"workspace"),withAuditNote(reason,auditNote),changes);
    await saveState(ctx,state);
    if(receipt)await saveIdempotency(ctx,receipt.id,fingerprint,result);
  }
  return result;
 },!mutating?"read":req.path==="/v1/actions"&&req.body?.action==="set_role"?"persona":"write");
}
router.get("/v1/workspace",async(req,res)=>{
 res.json(await inWorkspace(req,res,async ctx=>contractAnswer(S.GetWorkspaceResponse,{
  name:"Valo Pay 1",environment:"sandbox",actor:ctx.actor,role:ctx.role,authenticated:ctx.authenticated,
   merchants:await listMerchants(ctx),roles,productionEnabled:false,accessMode:ctx.accessMode,viewerScope:viewerScope(ctx)
 }),"read"));
});
router.get("/v1/overview",async(req,res)=>{
 // The audit chain is not in the loaded state: the store checks the entries since the last verified one and reads the eight latest.
 res.json(await withState(req,res,async(state,ctx)=>{const audit=await auditOverview(ctx,state);return buildConsoleOverview({...state,records:[...state.records,...audit.recent]},ctx.now,audit.verification,schedulerStatus());},false,S.GetOverviewResponse));
});
router.get("/v1/records/:kind",async(req,res)=>{
 lenderQuery(req);
 const kind=safeKind(req.params.kind),query=listRecordsQuery.parse(req.query);
 res.json(await inWorkspace(req,res,async ctx=>{
  const page=await listRecords(ctx,query.merchantId,kind,query);
  // Never leak internal storage location through collection APIs.
  // An audit entry is named in words; its stored action stays in data.action.
  return contractAnswer(S.ListRecordsResponse,{...page,items:page.items.map(r=>r.kind==="exports"?publicExportRecord(r):withAuditName(r))});
 },"read"));
});
router.get('/v1/queues/:queue', async (req, res) => {
 lenderQuery(req);
 const { queue } = S.ListQueueParams.parse(req.params), query = S.ListQueueQueryParams.parse(req.query);
 res.json(await inWorkspace(req, res, async ctx => contractAnswer(S.ListQueueResponse, await listQueue(ctx, query.merchantId, queue, query)), 'read'));
});
router.post("/v1/records/:kind",async(req,res)=>{
 const kind=safeKind(req.params.kind),body=S.CreateRecordBody.parse(req.body);
 const result=await withState(req,res,(state,ctx)=>{
  const input={...body,status:body.status||defaultStatus[kind as keyof typeof defaultStatus]||"draft",data:{...body.data,synthetic:true} as Record<string,any>,createdAt:ctx.now,updatedAt:ctx.now};
  if(["policies","templates"].includes(kind)){input.data.author=ctx.actor;input.data.version=1;}
  if(kind==="due-items")input.data.outstandingKobo=body.amountKobo;
  if(kind==="attempts"){input.data.source="external";input.data.simulated=true;}
  validateRecord(state,ctx,kind,input);
  if(body.reference&&state.records.some(r=>r.kind===kind&&r.reference===body.reference&&kind!=="observations"))fail("This reference is already used. Enter a different reference.",409);
  return makeRecord(state,kind,input);
  },true,S.CreateRecordResponse);
 res.json(result);
});
router.patch("/v1/records/:kind/:id",async(req,res)=>{
 const kind=safeKind(req.params.kind),{id}=S.UpdateRecordParams.parse(req.params),body=recordEdit.parse(req.body);
 const result=await withState(req,res,(state,ctx)=>{
  // Every edit names the version it was made on (the contract requires expectedUpdatedAt), a coordinated case's included.
  const {expectedUpdatedAt}=recordVersion.parse(req.body);
  const old=state.records.find(r=>r.kind===kind&&r.id===id);if(!old)fail(notFound(recordTypeName(kind)),404);
  if (kind === 'exceptions' && old.data.case?.assignee && old.data.case.assignee !== ctx.actor && ctx.role !== 'Admin') fail(`Only the person who owns this case or an Admin can change it.${demoRoleHint(ctx.accessMode)}`,403);
  assertRecordVersion(old,expectedUpdatedAt);
  const input={...old,...body,data:{...mergeData(old.data,body.data),synthetic:true} as Record<string,any>,updatedAt:ctx.now};
  assertNoDirectImportedCorrection(old,input);
  // An instalment's balance is rebuilt from its allocations and its status follows it.
  if(kind==="due-items")return amendDueItem(state,ctx,old as TypedRecord<"due-items">,input as TypedRecord<"due-items">);
  validateRecord(state,ctx,kind,input,true);Object.assign(old,input);return old;
  },true,S.UpdateRecordResponse);
 res.json(result);
});
router.post("/v1/actions",async(req,res)=>{
 const {merchantId}=lenderQuery(req);
 const body=S.PerformActionBody.parse(req.body);
 // A second person's confirmation of discount dates is a financial decision: it is keyed, so the operations journal records it.
 if(body.action==="confirm_discount_terms")requiredKey(req);
 // A person's first close of the day: once it commits, the background worker checks the lender's whole audit chain.
 let auditCheckDue=false;
 const result=await withState(req,res,async(state,ctx)=>{
  if (body.action === 'resolve_exception' && state.records.find(r=>r.id===body.recordId)?.data.case && !body.expectedUpdatedAt) fail('Reload this case before you resolve it.',409);
  if(body.expectedUpdatedAt!==undefined){
   const record=state.records.find(r=>r.id===body.recordId);if(!record)fail(notFound("Record"),404);
   assertRecordVersion(record,body.expectedUpdatedAt);
  }
  if(body.action==="set_role"){
   const role=String(body.data?.role);if(!roles.includes(role))fail(UNKNOWN_DEMO_ROLE);
    await changeRole(ctx,role);
   return {message:`Demo role changed to ${role}. It gives no access to real data or live payments.`,data:{role}};
  }
  // The whole chain, from its first entry, as the lender's database holds it.
  if(body.action==="verify_audit")return {message:"Audit log check complete.",data:await verifyAuditTrail(ctx,state)};
  if(body.action==="mark_pack_used")fail("A dispute pack made from sample data cannot be recorded as used in a real case.",403);
  // A daily close lists a broken audit chain as this write checked it.
  const answer=executeAction(state,ctx,body,{audit:writeAuditCheck(ctx,state)});
  auditCheckDue=body.action==="daily_close"&&dailyAuditCheckDue(state.settings,ctx.now);
  return answer;
  },true,S.PerformActionResponse,{action:body.action,recordId:body.recordId,reason:body.reason});
 if(auditCheckDue)requestDailyAuditCheck(merchantId);
 res.json(result);
});
router.post("/v1/imports",async(req,res)=>{
 lenderQuery(req);
 const body=S.ImportRecordsBody.parse(withRowIdColumn(req.body));
 res.json(await withState(req,res,(state,ctx)=>importCsv(state,ctx,body),body.commit,S.ImportRecordsResponse));
});
router.get('/v1/customers/:id/history',async(req,res)=>{
 lenderQuery(req);
 const {id}=S.GetCustomerHistoryParams.parse(req.params), query=S.GetCustomerHistoryQueryParams.parse(req.query);
 res.json(await inWorkspace(req,res,async ctx=>{
  const result=await getCustomerHistory(ctx,query.merchantId,id,query);
  return contractAnswer(S.GetCustomerHistoryResponse,{...result,events:result.events.map(record=>record.kind==='exports'?publicExportRecord(record):withAuditName(record)),...(result.focusedRecord?{focusedRecord:result.focusedRecord.kind==='exports'?publicExportRecord(result.focusedRecord):withAuditName(result.focusedRecord)}:{})});
 },'read'));
});
router.get("/v1/customers/:id/timeline",async(req,res)=>{
 const {merchantId}=lenderQuery(req);
 const {id}=S.GetCustomerTimelineParams.parse(req.params);
 res.json(await inWorkspace(req,res,async ctx=>{
  const timeline=customerTimeline(await loadCustomerView(ctx,merchantId,id),id);
  return contractAnswer(S.GetCustomerTimelineResponse,{...timeline,events:timeline.events.map(record=>record.kind==='exports'?publicExportRecord(record):withAuditName(record))});
 },"read"));
});
router.get('/v1/reconciliation/:queue',async(req,res)=>{
 lenderQuery(req);
 const {queue}=S.ListReconciliationParams.parse(req.params), query=S.ListReconciliationQueryParams.parse(req.query);
 res.json(await inWorkspace(req,res,async ctx=>contractAnswer(S.ListReconciliationResponse,await listReconciliation(ctx,query.merchantId,queue,query)),'read'));
});
router.get('/v1/close-history',async(req,res)=>{
 lenderQuery(req);
 const query=S.ListCloseHistoryQueryParams.parse(req.query);
 res.json(await inWorkspace(req,res,async ctx=>contractAnswer(S.ListCloseHistoryResponse,await listCloseHistory(ctx,query.merchantId,query)),'read'));
});
router.get('/v1/close-history/:id',async(req,res)=>{
 const {merchantId}=lenderQuery(req),{id}=S.GetCloseDetailParams.parse(req.params);
 res.json(await inWorkspace(req,res,async ctx=>contractAnswer(S.GetCloseDetailResponse,await getCloseDetail(ctx,merchantId,id)),'read'));
});
router.get('/v1/reports',async(req,res)=>{
 lenderQuery(req);
 const {merchantId,includeCloses}=S.GetReportsQueryParams.parse(req.query);
 res.json(includeCloses==='false' ? await inWorkspace(req,res,async ctx=>contractAnswer(S.GetReportsResponse,{...buildConsoleReports(await loadReportsView(ctx,merchantId),ctx.now,schedulerStatus()),closes:[]}),'read') : await withState(req,res,(state,ctx)=>buildConsoleReports(state,ctx.now,schedulerStatus()),false,S.GetReportsResponse));
});
router.get("/v1/gates",async(req,res)=>{
 res.json(await withState(req,res,getGates,false,S.GetGatesResponse));
});
router.get("/v1/settings",async(req,res)=>{
 const {merchantId}=lenderQuery(req);
 res.json(await inWorkspace(req,res,async ctx=>contractAnswer(S.GetSettingsResponse,buildConsoleSettings(await loadSettingsView(ctx,merchantId),ctx.role,ctx.now,schedulerStatus())),"read"));
});
router.patch("/v1/settings",async(req,res)=>{
 const body=settingsEdit.parse(req.body);
 const result=await withState(req,res,(state,ctx)=>{
  const {expectedRevision}=settingsVersion.parse(req.body);
  if(ctx.role!=="Admin")fail(onlyRoles(["Admin"],"change lender settings",ctx.accessMode),403);
  assertSettingsVersion(state.settings,expectedRevision);
  const start=body.executionStart??state.settings.executionStart??executionWindow.defaultStartHour,end=body.executionEnd??state.settings.executionEnd??executionWindow.defaultEndHour;
  if(start<executionWindow.earliestHour||end>executionWindow.latestHour||start>=end)fail(`Set the collection window between ${String(executionWindow.earliestHour).padStart(2,"0")}:00 and ${String(executionWindow.latestHour).padStart(2,"0")}:00 WAT, with the start before the end.`);
  if(body.minimumTicketKobo!==undefined&&body.minimumTicketKobo<ABSOLUTE_TICKET_FLOOR_KOBO)fail("The minimum debit is ₦5,000.00. This limit cannot be overridden.");
  if(body.defaultOwner&&!(handBackOwners as readonly string[]).includes(body.defaultOwner))fail("Choose the loan management system, the lender team or the provider. Valo Pay 1 can own collection only after a collection transfer for live use.");
  if(body.authorisationMode&&!(authorisationModes as readonly string[]).includes(body.authorisationMode))fail("Choose Daily approval or Standing approval.");
  for(const key of ["unallocatedAlertThreshold","notificationCostAlertKobo"] as const)if(body[key]!==undefined&&(!Number.isInteger(body[key])||Number(body[key])<0))fail(`${key} must be a whole number of zero or more.`);
  if(body.closeTime!==undefined&&!isCloseTime(body.closeTime))fail("closeTime must use HH:MM in West Africa Time, for example 07:00.");
  const previous={time:closeTimeOf(state.settings),enabled:state.settings.scheduledCloseEnabled!==false};
  Object.assign(state.settings,body);
  // REC-01: a changed close time or a switched-on schedule starts from its next occurrence; an unchanged save leaves a pending close pending.
  rescheduleAfterSettings(state,previous,ctx.now);
  return buildConsoleSettings(state,ctx.role,ctx.now,schedulerStatus());
  },true,S.UpdateSettingsResponse);
 res.json(result);
});
router.post("/v1/exports",async(req,res)=>{
 const body=S.CreateExportBody.parse(req.body);
 if(!kinds.has(body.kind)&&!(exportKinds as readonly string[]).includes(body.kind))fail("Choose what to export from the list.");
 if(["customer-pack","dispute-pack"].includes(body.kind)&&!body.customerId)fail("Choose a customer for the dispute pack.");
 // A reviewed close is checked as current against its whole close, which the load keeps as a summary once more than a
 // week older than the newest: that one close is loaded whole, as for the review's decision.
 const whole=body.kind==='reviewed-close'&&body.closeReviewId?{closeReviewIds:[body.closeReviewId]}:{};
  const result=await withState(req,res,(state,ctx)=>queueExport(state,ctx,body,process.env.PRIVATE_OBJECT_DIR||''),true,S.CreateExportResponse,{},whole);
 req.log.info({event:"export.queued",kind:body.kind,format:body.format,exportId:result.id},"Export queued durably");
 res.json(result);
});
/** An export of the request's lender, read in the tenant transaction and handed to `use` there, with the transaction clock. A download also needs the role its kind requires (export_sensitive). */
async function authorisedExport<T>(req:Request,res:Response,use:(record:ValopayRecord,now:string)=>T,download=false){
 const {merchantId}=lenderQuery(req),id=pathId(req.params.id);
 return inWorkspace(req,res,async ctx=>{
  const page=await listRecords(ctx,merchantId,'exports',{id,limit:1});
  if(!page.items[0])fail(notFound('Export'),404);
  if(download)assertExportPermitted(ctx.role,page.items[0].data.kind);
  // The transaction clock decides whether the export is stalled or its lease expired.
  return use(page.items[0],ctx.now);
 },'read');
}
router.get('/v1/exports/:id',async(req,res)=>{
 res.setHeader('Cache-Control','private, no-store');
 res.json(await authorisedExport(req,res,(record,now)=>contractAnswer(S.GetExportJobResponse,exportJobView(record,now))));
});
router.post('/v1/exports/:id/retry',async(req,res)=>{
 const id=pathId(req.params.id);
 req.body={};
 res.json(await withState(req,res,(state,ctx)=>retryExport(state,ctx,id),true,S.RetryExportJobResponse));
});
router.get("/v1/exports/:id/download",async(req,res)=>{
 const cancellation=new AbortController();
 const abort=()=>cancellation.abort();
 const close=()=>{if(!res.writableEnded)abort();};
 req.once("aborted",abort);
 res.once("close",close);
 try{
 // The authorised metadata is read inside the transaction; the object-storage read happens after it ends, so no merchant lock is held across the download.
 const descriptor=await authorisedExport(req,res,record=>exportDescriptorForRecord(record),true);
 if(cancellation.signal.aborted)return;
 const result=await readExport(descriptor,cancellation.signal);
 if(cancellation.signal.aborted)return;
 res.setHeader("Content-Type",result.contentType);
 res.setHeader("Content-Disposition",`attachment; filename="${result.filename}"`);
 res.setHeader("Cache-Control","private, no-store");
 res.send(result.bytes);
 }catch(error){
 if(!cancellation.signal.aborted)throw error;
 }finally{
 req.off("aborted",abort);
 res.off("close",close);
 }
});
// Unconfigured ingress fails closed; fabricated webhooks can never become evidence.
router.post("/v1/webhooks/:provider",(req,res)=>{
 res.status(403).json({error:"Production provider webhook ingress is disabled. No partner signature configuration is available.",requestId:req.id});
});
router.get("/v1/openapi.json",async(_req,res)=>{
 const {readFile}=await import("node:fs/promises");
 res.type("application/json").send(await readFile(new URL("./openapi.json",import.meta.url),"utf8"));
});
export default router;
