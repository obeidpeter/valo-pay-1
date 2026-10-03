import { SANDBOX_COOKIE } from "../src/lib/sandbox-cookie";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { randomBytes, randomUUID, createCipheriv, createDecipheriv, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
if(process.env.VALO_PAY_1_RUN_INTEGRATION!=="1"){console.log("Operations controls integration requires a disposable local PostgreSQL database.");process.exit(0);}
assert.ok(["localhost","127.0.0.1","[::1]"].includes(new URL(process.env.DATABASE_URL||"").hostname),"Refuse a non-local integration database.");
const environmentNames=["VALO_PAY_1_STAFF_ACCESS","VALO_PAY_1_RUNTIME_ISOLATION","VALO_PAY_1_PAYLOAD_ENCRYPTION","VALO_PAY_1_KMS_KEY","VALO_PAY_1_PAYSTACK_INGRESS","VALO_PAY_1_PAYSTACK_CONNECTIONS","PAYSTACK_TEST_SECRET_KEY"] as const;
const previousEnvironment=Object.fromEntries(environmentNames.map(name=>[name,process.env[name]]));
process.env.VALO_PAY_1_STAFF_ACCESS="off";process.env.VALO_PAY_1_RUNTIME_ISOLATION="off";
process.env.VALO_PAY_1_PAYLOAD_ENCRYPTION="kms";
process.env.VALO_PAY_1_KMS_KEY="projects/synthetic-integration/locations/global/keyRings/fixture/cryptoKeys/v1";
const {pool}=await import("@workspace/valo-pay-1-db");
const {managedWrappingKeys,openPayload}=await import("../src/lib/protected-payloads");
const oldWrap=managedWrappingKeys.wrap,oldUnwrap=managedWrappingKeys.unwrap,master=randomBytes(32);
// Fixture injection is restricted to this test module; runtime keeps its managed KMS adapter.
managedWrappingKeys.wrap=async(_key,data,aad)=>{const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",master,iv);cipher.setAAD(aad);const encrypted=Buffer.concat([cipher.update(data),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),encrypted]);};
// Every opened payload is counted: a forged Paystack delivery must open none.
let unwraps=0;
managedWrappingKeys.unwrap=async(_key,data,aad)=>{unwraps++;const decipher=createDecipheriv("aes-256-gcm",master,data.subarray(0,12));decipher.setAAD(aad);decipher.setAuthTag(data.subarray(12,28));return Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]);};
const {default:router}=await import("../src/routes/index");
const {errorHandler}=await import("../src/lib/error-handler");
const {createPaystackIngress}=await import("../src/routes/sources");
const {paystackConnectionTransaction,paystackIngress}=await import("../src/lib/paystack-connection");
const {receivePaystackEvent}=await import("../src/providers/paystack-inbox");
const {runDueCloses}=await import("../src/lib/close-scheduler");
const {inMerchantAsSystem,loadState,revealImportPayloads,SYSTEM_ACTOR_PREFIX}=await import("../src/lib/valo-pay-1-store");
// The Paystack test ingress reads its own raw body, so it is mounted before JSON parsing, as in app.ts.
const app=express();app.use((req,_res,next)=>{(req as any).log={info(){},warn(){},error(){}};next();});app.use("/api",createPaystackIngress(paystackIngress));
app.use(express.json({limit:"2mb"}));app.use((req,_res,next)=>{(req as any).auth=Object.assign(()=>({userId:null}),{[Symbol.for("@clerk/express.auth")]:true});next();});app.use("/api",router);app.use(errorHandler);
const server=app.listen(0,"127.0.0.1");await once(server,"listening");
const base=`http://127.0.0.1:${(server.address() as any).port}/api`,cookie=`${SANDBOX_COOKIE}=${randomBytes(32).toString("hex")}`;
const workspaces=new Set<string>();
async function call(path:string,method="GET",body?:unknown,key?:string){const response=await fetch(base+path,{method,headers:{"Content-Type":"application/json",Cookie:cookie,...(key?{"Idempotency-Key":key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json()};}
const ok=(result:{status:number;data:any})=>{assert.equal(result.status,200,JSON.stringify(result.data));return result.data;};
const post=(path:string,body:unknown,key=randomUUID())=>call(path,"POST",body,key);
try{
  for(const name of ["003_pilot_workflow.sql","004_staff_lender_access.sql"])await pool.query(await readFile(new URL(`../../../lib/db/migrations/${name}`,import.meta.url),"utf8"));
  // Readiness finds every table, column and index this build needs (a missing table or column would answer 503; the log, not the answer, names it).
  const readyz=await fetch(`${base}/readyz`),readyzBody=await readyz.json() as {status:string;checks:{database:{status:string};schema:unknown}};
  assert.deepEqual([readyz.status,readyzBody.status,readyzBody.checks.database.status,readyzBody.checks.schema],[200,"ok","ok",{status:"ok"}]);
  const workspace=ok(await call("/v1/workspace")),lender=workspace.merchants[0].id,other=workspace.merchants[1].id;
  const workspaceId=(await pool.query("SELECT workspace_id FROM valopay_merchants WHERE id=$1",[lender])).rows[0].workspace_id;workspaces.add(workspaceId);
  const at=(days:number)=>new Date(Date.now()-days*86400000).toISOString();
  const source=`controls-${randomUUID()}`;
  const profileInput={name:"Controlled customer feed",source,kind:"customers",mapping:{},identityColumn:"source_row_id",amountUnit:"naira",firstExpectedAt:new Date().toISOString(),cadenceHours:24,graceMinutes:60,expectedRows:2,expectedAmountKobo:0,status:"active",syntheticOnly:true};
  const profile=ok(await post(`/v1/sources/profiles?merchantId=${lender}`,profileInput));
  const batchInput={name:"Protected source batch",source,sourceBatchId:"controls-001",kind:"customers",csv:"source_row_id,name,reference,consentProvenance\nrow-1,Synthetic controls customer,CONTROLS-C-001,Synthetic consent",mapping:{},identityColumn:"source_row_id",amountUnit:"naira",syntheticOnly:true};
  let batch=ok(await post(`/v1/pilot/batches?merchantId=${lender}`,batchInput));
  assert.equal(batch.data.sourceQuality.status,"needs_review");
  // Sources opens the rows of a batch not yet committed, so its checks are real, not "unavailable".
  assert.equal(ok(await call(`/v1/sources?merchantId=${lender}`)).batches.find((item:any)=>item.id===batch.id).quality.status,"needs_review");
  assert.equal((await post(`/v1/pilot/batches/${batch.id}/commit?merchantId=${lender}`,{expectedUpdatedAt:batch.updatedAt})).status,409);
  assert.equal((await post(`/v1/sources/profiles/${profile.id}/save?merchantId=${other}`,{...profileInput,expectedRows:1,expectedUpdatedAt:profile.updatedAt})).status,404);
  ok(await post(`/v1/sources/profiles/${profile.id}/save?merchantId=${lender}`,{...profileInput,expectedRows:1,expectedUpdatedAt:profile.updatedAt}));
  batch=ok(await post(`/v1/pilot/batches/${batch.id}/save?merchantId=${lender}`,{...batchInput,expectedUpdatedAt:batch.updatedAt}));
  batch=ok(await post(`/v1/pilot/batches/${batch.id}/commit?merchantId=${lender}`,{expectedUpdatedAt:batch.updatedAt}));
  assert.equal(batch.status,"committed");assert.equal(batch.data.sourceQuality.importedRows,1);
  const encryptedBatch=(await pool.query("SELECT data FROM valopay_records WHERE id=$1 AND merchant_id=$2",[batch.id,lender])).rows[0].data;
  assert.equal(encryptedBatch.csv.protectedPayload,1);assert.equal(encryptedBatch.check.protectedPayload,1);assert.equal(JSON.stringify(encryptedBatch).includes("Synthetic controls customer"),false);
  assert.equal(await openPayload(encryptedBatch.csv,{lender,record:batch.id,field:"csv"},managedWrappingKeys),batchInput.csv);
  assert.ok(unwraps>0,"the fixture counts every payload it opens");
  await assert.rejects(()=>openPayload(encryptedBatch.csv,{lender:other,record:batch.id,field:"csv"},managedWrappingKeys));
  // Only a view that shows or uses the raw source rows opens them. Overviews,
  // lists, unkeyed saves and the scheduled close make no key-service call, so
  // they keep working while the key service is down; the batch list opens only
  // the checks of batches saved before check summaries, and lists them without
  // counts when it cannot. A keyed save seals its journal entry, so it fails closed.
  // The fixture's unwrap above already counts every payload opened.
  const fixtureUnwrap=managedWrappingKeys.unwrap,fixtureWrap=managedWrappingKeys.wrap,storedSummary=encryptedBatch.checkSummary;
  assert.deepEqual(storedSummary,{valid:1,invalid:0,imported:1,skipped:0},"the check's counts are stored in plaintext beside it");
  try{
    for(const path of ["/v1/overview","/v1/work","/v1/pilot/journey","/v1/pilot/progress","/v1/pilot/batches"]){unwraps=0;ok(await call(`${path}?merchantId=${lender}`));assert.equal(unwraps,0,`${path} opens no protected payload`);}
    const listed=ok(await call(`/v1/pilot/batches?merchantId=${lender}`)).items.find((item:any)=>item.id===batch.id);
    assert.deepEqual(listed.data.check,{valid:1,invalid:0,imported:1,skipped:0},"the list's counts come from the stored check summary");
    // A write that changed a batch before opening its rows is a programming fault, refused before any key-service call.
    unwraps=0;
    await assert.rejects(inMerchantAsSystem(lender,`${SYSTEM_ACTOR_PREFIX}source row check`,async ctx=>{const state=await loadState(ctx,lender,"update");state.records.find(record=>record.id===batch.id)!.name="Changed before its rows were opened";await revealImportPayloads(ctx,state,record=>record.id===batch.id);}),/must be opened before the batch changes/);
    assert.equal(unwraps,0);
    // A batch saved before check summaries were stored has none, and a committed batch never gains one: the list opens its check, and only that.
    await pool.query("UPDATE valopay_records SET data=data-'checkSummary' WHERE id=$1 AND merchant_id=$2",[batch.id,lender]);
    unwraps=0;const older=ok(await call(`/v1/pilot/batches?merchantId=${lender}`)).items.find((item:any)=>item.id===batch.id);
    assert.deepEqual(older.data.check,{valid:1,invalid:0,imported:1,skipped:0},"a batch saved before check summaries lists the counts of its opened check");
    assert.equal(unwraps,1,"the list opens that batch's check and nothing else");assert.equal("csv" in older.data,false);
    unwraps=0;const detail=ok(await call(`/v1/pilot/batches/${batch.id}?merchantId=${lender}`));
    assert.equal(unwraps,2,"a batch's detail opens its own rows and check");assert.equal(detail.batch.data.csv,batchInput.csv);assert.equal(detail.batch.data.check.imported,1);
    unwraps=0;ok(await post(`/v1/records/customers?merchantId=${lender}`,{name:"Unrelated keyed save",reference:`UNRELATED-${randomUUID()}`,data:{consentProvenance:"Synthetic consent"}}));
    assert.equal(unwraps,0,"an unrelated keyed save opens no source rows");
    // The key service can neither open nor seal, and answers as the real client does.
    const outage=async():Promise<never>=>{throw Object.assign(new Error("Protected data cannot be opened. Ask the administrator to check the configured encryption key."),{status:503});};
    managedWrappingKeys.unwrap=async()=>{unwraps++;return outage();};managedWrappingKeys.wrap=outage;
    unwraps=0;
    ok(await call(`/v1/overview?merchantId=${lender}`));
    const uncounted=ok(await call(`/v1/pilot/batches?merchantId=${lender}`)).items.find((item:any)=>item.id===batch.id);
    assert.equal(uncounted.status,"committed");assert.equal("check" in uncounted.data,false,"a batch whose check cannot be opened is listed without counts instead of failing the list");
    assert.equal(uncounted.data.sourceBatchId,batchInput.sourceBatchId);
    unwraps=0;
    ok(await call(`/v1/records/customers?merchantId=${lender}`,"POST",{name:"Unkeyed save during the outage",reference:`UNKEYED-${randomUUID()}`,data:{consentProvenance:"Synthetic consent"}}));
    // Console saves carry a key, and a keyed save seals its journal entry: it fails closed and saves nothing.
    const keyedName=`Keyed save during the outage ${randomUUID()}`,keyed=await post(`/v1/records/customers?merchantId=${lender}`,{name:keyedName,reference:`KEYED-${randomUUID()}`,data:{consentProvenance:"Synthetic consent"}});
    assert.equal(keyed.status,503);assert.equal((keyed.data as {committed?:unknown}).committed,false);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM valopay_records WHERE merchant_id=$1 AND name=$2",[lender,keyedName])).rows[0].count,0);
    // Due an hour ago; the pass is scoped to this lender, so other due lenders in a reused database never crowd it out.
    // (A cursor years old would leave the lender owing a catch-up close for every business date since.)
    await pool.query("UPDATE valopay_merchants SET settings=settings||jsonb_build_object('nextCloseAt',$2::text) WHERE id=$1",[lender,new Date(Date.now()-60*60*1000).toISOString()]);
    const closes=await runDueCloses({batchSize:25,onlyMerchantIds:[lender]});
    assert.deepEqual(closes.failed.filter(failure=>failure.merchantId===lender),[],"the scheduled close does not need the key service");
    assert.ok(closes.closed.some(closed=>closed.merchantId===lender),"the scheduled close ran during the outage");
    assert.equal(unwraps,0);
    const unavailable=await call(`/v1/pilot/batches/${batch.id}?merchantId=${lender}`);
    assert.equal(unavailable.status,503,"a view that needs the rows fails closed");assert.match(String((unavailable.data as {error?:string}).error),/Protected data cannot be opened/);
  }finally{managedWrappingKeys.unwrap=fixtureUnwrap;managedWrappingKeys.wrap=fixtureWrap;await pool.query("UPDATE valopay_records SET data=data||jsonb_build_object('checkSummary',$3::jsonb) WHERE id=$1 AND merchant_id=$2",[batch.id,lender,JSON.stringify(storedSummary)]);}

  const customerPath=`/v1/records/customers?merchantId=${lender}`,customerKey=randomUUID(),customerBody={name:"Retention request fixture",reference:`RETAIN-${randomUUID()}`,data:{consentProvenance:"Synthetic retention consent"}};
  const customer=ok(await post(customerPath,customerBody,customerKey));
  const completed=(await pool.query("SELECT * FROM valopay_operations WHERE merchant_id=$1 AND request_key=$2",[lender,customerKey])).rows[0];
  assert.equal(completed.request.protectedPayload,1);
  const idempotent=(await pool.query("SELECT * FROM valopay_idempotency WHERE merchant_id=$1 AND response->>'protectedPayload'='1'",[lender])).rows;
  assert.ok(idempotent.length>0);
  // A completed request's answer is stored once, as the replay copy under its key; the journal keeps only a reference
  // to what it saved, which is what Operations shows. A daily close answers with its whole record (about 100 KB for a
  // pilot-scale lender), and both tables used to hold it. A retried key still replays the copy and never runs twice.
  // A journaled request's answer is kept under its journal entry.
  const replayCopy=async(key:string)=>{const row=(await pool.query("SELECT i.id,i.response,pg_column_size(i.response) AS size FROM valopay_idempotency i JOIN valopay_operations o ON o.id=i.id AND o.merchant_id=i.merchant_id WHERE i.merchant_id=$1 AND o.request_key=$2",[lender,key])).rows[0];return {size:Number(row.size),response:await openPayload(row.response,{lender,record:row.id,field:"response"},managedWrappingKeys)};};
  // The reference names only the record's ID and kind, so it is not sealed: Operations links to the saved result
  // without the key service, as it does with encryption off.
  assert.deepEqual(completed.receipt,{id:customer.id,kind:"customers"},"the journal keeps a reference to the saved record, unsealed");
  const listed=(ok(await call(`/v1/operations?merchantId=${lender}`)) as {items:Array<{id:string;recordId:string|null;recordKind:string|null}>}).items.find(item=>item.id===completed.id);
  assert.deepEqual([listed?.recordId,listed?.recordKind],[customer.id,"customers"],"so Operations offers the saved result while payloads are encrypted");
  assert.deepEqual((await replayCopy(customerKey)).response,customer,"the replay copy is the whole answer");
  assert.deepEqual(ok(await post(customerPath,customerBody,customerKey)),customer,"a retried key replays the saved answer");
  assert.deepEqual(ok(await post(`/v1/operations/${completed.id}/retry?merchantId=${lender}`,{})),customer,"so does a retry from Operations");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM valopay_records WHERE merchant_id=$1 AND kind='customers' AND reference=$2",[lender,customerBody.reference])).rows[0].n,1,"and neither ran the request again");
  const closeKey=randomUUID(),closed=ok(await post(`/v1/actions?merchantId=${lender}`,{action:"daily_close"},closeKey));
  const closeEntry=(await pool.query("SELECT id,receipt,pg_column_size(receipt) AS size FROM valopay_operations WHERE merchant_id=$1 AND request_key=$2",[lender,closeKey])).rows[0];
  assert.deepEqual(closeEntry.receipt,{record:{id:closed.record.id,kind:"closes"}},"a close's journal entry keeps a reference to the close");
  const closeCopy=await replayCopy(closeKey);
  assert.deepEqual(closeCopy.response,closed,"its replay copy is the whole answer");
  assert.ok(Number(closeEntry.size)<1024&&closeCopy.size>4*Number(closeEntry.size),`the journal's reference (${closeEntry.size} bytes) is a fraction of the answer (${closeCopy.size} bytes)`);
  const closes=(await pool.query("SELECT count(*)::int AS n FROM valopay_records WHERE merchant_id=$1 AND kind='closes'",[lender])).rows[0].n;
  assert.deepEqual(ok(await post(`/v1/operations/${closeEntry.id}/retry?merchantId=${lender}`,{})),closed,"a retried close replays its answer");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM valopay_records WHERE merchant_id=$1 AND kind='closes'",[lender])).rows[0].n,closes,"and closes nothing again");
  const pendingKey=randomUUID(),cancelledKey=randomUUID();
  assert.equal((await post(customerPath,{name:"Missing consent"},pendingKey)).status,400);
  assert.equal((await post(customerPath,{name:"Cancelled missing consent"},cancelledKey)).status,400);
  const pending=(await pool.query("SELECT * FROM valopay_operations WHERE merchant_id=$1 AND request_key=$2",[lender,pendingKey])).rows[0];
  const cancelled=(await pool.query("SELECT * FROM valopay_operations WHERE merchant_id=$1 AND request_key=$2",[lender,cancelledKey])).rows[0];
  // A definitive refusal closes the entry with its protected reason; it no longer counts as pending.
  assert.equal(pending.status,"cancelled");assert.equal(cancelled.status,"cancelled");
  assert.equal(pending.receipt.protectedPayload,1);
  assert.equal((await openPayload(pending.receipt,{lender,record:pending.id,field:"receipt"},managedWrappingKeys)).rejected.status,400);
  // A key-service outage inside the business transaction: nothing is saved, the
  // answer keeps its 503 and says so, and the journal entry closes instead of
  // waiting as unconfirmed. The journal's own request and refusal are sealed.
  const workingWrap=managedWrappingKeys.wrap;let wraps=0;
  managedWrappingKeys.wrap=async(...args)=>{if(++wraps===2)throw Object.assign(new Error("Protected data cannot be opened. Ask the administrator to check the configured encryption key."),{status:503});return workingWrap(...args);};
  const outageKey=randomUUID(),outageName=`Outage customer ${randomUUID()}`;
  const outage=await post(customerPath,{name:outageName,reference:`OUTAGE-${randomUUID()}`,data:{consentProvenance:"Synthetic outage consent"}},outageKey);
  managedWrappingKeys.wrap=workingWrap;
  assert.equal(outage.status,503,"an unavailable key service is not flattened to a general 500");
  const outageBody=outage.data as {committed?:unknown;error?:string};
  assert.equal(outageBody.committed,false,"the answer says nothing was saved");
  assert.match(String(outageBody.error),/Protected data cannot be opened/);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM valopay_records WHERE merchant_id=$1 AND name=$2",[lender,outageName])).rows[0].count,0);
  const outageEntry=(await pool.query("SELECT status,receipt FROM valopay_operations WHERE merchant_id=$1 AND request_key=$2",[lender,outageKey])).rows[0];
  assert.equal(outageEntry.status,"cancelled","a request that saved nothing closes its journal entry");
  assert.equal((await openPayload(outageEntry.receipt,{lender,record:(await pool.query("SELECT id FROM valopay_operations WHERE merchant_id=$1 AND request_key=$2",[lender,outageKey])).rows[0].id,field:"receipt"},managedWrappingKeys)).rejected.status,503);
  // Reopen one entry as pending: a request whose outcome never came back (a crash before completion).
  await pool.query("UPDATE valopay_operations SET status='pending',receipt=NULL WHERE merchant_id=$1 AND id=$2",[lender,pending.id]);
  // Pending entries are limited per person and lender; closed ones do not count towards the limit.
  await pool.query("INSERT INTO valopay_operations(id,merchant_id,owner,actor,role,request_key,request_hash,request,label) SELECT 'cap-'||i,$1,$2,$3,$4,'cap-key-'||i,'cap-hash','{}','Cap fixture' FROM generate_series(1,99) i",[lender,pending.owner,pending.actor,pending.role]);
  const capped=await post(customerPath,{name:"Beyond the pending limit"});
  assert.equal(capped.status,409);assert.match(String((capped.data as {error?:string}).error),/^You have 100 requests that Valo Pay 1 has not confirmed\. Check them in Request history before you send more\.$/);
  await pool.query("UPDATE valopay_operations SET status='cancelled' WHERE merchant_id=$1 AND id LIKE 'cap-%'",[lender]);
  assert.equal((await post(customerPath,{name:"Beyond the pending limit"})).status,400,"Closed entries free the limit; the request is then refused on its own merits.");
  await pool.query("DELETE FROM valopay_operations WHERE merchant_id=$1 AND (id LIKE 'cap-%' OR label IN ('Save records customers','Add a record') AND status='cancelled' AND id<>$2)",[lender,cancelled.id]);
  ok(await post(`/v1/operations/${cancelled.id}/cancel?merchantId=${lender}`,{}));
  await pool.query("UPDATE valopay_operations SET updated_at=$3::timestamptz WHERE merchant_id=$1 AND id=ANY($2::text[])",[lender,[completed.id,cancelled.id,pending.id],at(30)]);
  await pool.query("UPDATE valopay_records SET data=jsonb_set(data,'{committedAt}',to_jsonb($3::text)),updated_at=$3::timestamptz WHERE id=$1 AND merchant_id=$2",[batch.id,lender,at(30)]);
  let lifecycle=ok(await call(`/v1/lifecycle?merchantId=${lender}`));
  lifecycle=ok(await post(`/v1/lifecycle/policy?merchantId=${lender}`,{policy:{rawCsvDays:30,journalPayloadDays:30,exportFileDays:null,auditTrail:"retain"},expectedRevision:lifecycle.policyRevision,reason:"Synthetic retention integration rehearsal"}));
  lifecycle=ok(await post(`/v1/lifecycle/holds?merchantId=${lender}`,{kind:"raw_csv",sourceId:batch.id,held:true,expectedHoldRevision:lifecycle.holdRevision,reason:"Preserve raw source while journal tests run"}));
  assert.equal(lifecycle.targets.some((target:any)=>target.sourceId===pending.id),false);
  let run=ok(await post(`/v1/lifecycle/runs?merchantId=${lender}`,{expectedPolicyRevision:lifecycle.policyRevision}));
  assert.deepEqual(new Set(run.candidates.map((candidate:any)=>candidate.sourceId)),new Set([completed.id,cancelled.id]));
  run=ok(await post(`/v1/lifecycle/runs/${run.id}/approve?merchantId=${lender}`,{expectedUpdatedAt:run.updatedAt,previewDigest:run.previewDigest,reason:"Approve exact synthetic journal cleanup"}));
  const firstCandidate=run.candidates[0];
  lifecycle=ok(await call(`/v1/lifecycle?merchantId=${lender}`));
  lifecycle=ok(await post(`/v1/lifecycle/holds?merchantId=${lender}`,{kind:"journal_payload",sourceId:firstCandidate.sourceId,held:true,expectedHoldRevision:lifecycle.holdRevision,reason:"Hold added after approval must block deletion"}));
  const blocked=ok(await post(`/v1/lifecycle/runs/${run.id}/execute?merchantId=${lender}`,{previewDigest:run.previewDigest}));
  assert.equal(blocked.status,"attention");assert.equal(blocked.receipts[0].status,"blocked");
  assert.equal(blocked.receipts.length,1,"a blocked source stops the run with its reason; nothing after it is attempted");
  assert.match(blocked.receipts[0].detail,/is on hold/);
  lifecycle=ok(await post(`/v1/lifecycle/holds?merchantId=${lender}`,{kind:"journal_payload",sourceId:firstCandidate.sourceId,held:false,expectedHoldRevision:lifecycle.holdRevision,reason:"Release hold for checked synthetic cleanup"}));
  const stale=ok(await post(`/v1/lifecycle/runs?merchantId=${lender}`,{expectedPolicyRevision:lifecycle.policyRevision}));
  await pool.query("UPDATE valopay_operations SET updated_at=$3::timestamptz WHERE merchant_id=$1 AND id=$2",[lender,completed.id,at(31)]);
  assert.equal((await post(`/v1/lifecycle/runs/${stale.id}/approve?merchantId=${lender}`,{expectedUpdatedAt:stale.updatedAt,previewDigest:stale.previewDigest,reason:"A stale inventory must not be approved"})).status,409);
  run=ok(await post(`/v1/lifecycle/runs?merchantId=${lender}`,{expectedPolicyRevision:lifecycle.policyRevision}));
  run=ok(await post(`/v1/lifecycle/runs/${run.id}/approve?merchantId=${lender}`,{expectedUpdatedAt:run.updatedAt,previewDigest:run.previewDigest,reason:"Approve current exact source inventory"}));
  // One request executes every source of the run it can within its time budget, each checked and given a receipt.
  run=ok(await post(`/v1/lifecycle/runs/${run.id}/execute?merchantId=${lender}`,{previewDigest:run.previewDigest}));
  assert.equal(run.status,"completed");assert.equal(run.successful,2);
  const retained=(await pool.query("SELECT id,status,request,receipt FROM valopay_operations WHERE merchant_id=$1 AND id=ANY($2::text[])",[lender,[completed.id,cancelled.id,pending.id]])).rows;
  assert.equal(retained.find((r:any)=>r.id===completed.id).request.purged,true);
  assert.equal(retained.find((r:any)=>r.id===cancelled.id).status,"cancelled");
  assert.equal(retained.find((r:any)=>r.id===cancelled.id).request.purged,true);
  assert.equal(retained.find((r:any)=>r.id===pending.id).status,"pending");
  assert.equal(retained.find((r:any)=>r.id===pending.id).request.protectedPayload,1);
  assert.equal((await post(customerPath,customerBody,customerKey)).status,410);
  assert.equal((await post(`/v1/operations/${completed.id}/retry?merchantId=${lender}`,{})).status,410);
  assert.equal(Number((await pool.query("SELECT count(*) AS n FROM valopay_records WHERE merchant_id=$1 AND reference=$2 AND kind='customers'",[lender,customerBody.reference])).rows[0].n),1);
  assert.equal((await post(customerPath,{name:"Cancelled missing consent"},cancelledKey)).status,409);
  lifecycle=ok(await call(`/v1/lifecycle?merchantId=${lender}`));
  lifecycle=ok(await post(`/v1/lifecycle/holds?merchantId=${lender}`,{kind:"raw_csv",sourceId:batch.id,held:false,expectedHoldRevision:lifecycle.holdRevision,reason:"Source records retained; release original CSV"}));
  run=ok(await post(`/v1/lifecycle/runs?merchantId=${lender}`,{expectedPolicyRevision:lifecycle.policyRevision}));
  assert.equal(run.candidates.length,1);assert.equal(run.candidates[0].kind,"raw_csv");
  run=ok(await post(`/v1/lifecycle/runs/${run.id}/approve?merchantId=${lender}`,{expectedUpdatedAt:run.updatedAt,previewDigest:run.previewDigest,reason:"Approve erasure of the exact source file"}));
  run=ok(await post(`/v1/lifecycle/runs/${run.id}/execute?merchantId=${lender}`,{previewDigest:run.previewDigest}));
  assert.equal(run.status,"completed");
  const purgedBatch=(await pool.query("SELECT data FROM valopay_records WHERE id=$1",[batch.id])).rows[0].data;
  assert.equal("csv" in purgedBatch,false);assert.equal(purgedBatch.rawCsvRetentionRunId,run.id);
  assert.equal(purgedBatch.check.protectedPayload,1,"the check, opened for the retention run, is sealed again when saved");
  assert.equal("preview" in await openPayload(purgedBatch.check,{lender,record:batch.id,field:"check"},managedWrappingKeys),false);
  assert.ok((await pool.query("SELECT 1 FROM valopay_records WHERE id=$1 AND kind='customers'",[customer.id])).rows[0]);

  // Real repository callback, server-owned tenant map and durable test event receipt. No provider HTTP call.
  // One more protected batch, so that loading the lender has payloads to open.
  ok(await post(`/v1/pilot/batches?merchantId=${lender}`,{...batchInput,name:"Protected batch for the ingress",sourceBatchId:"controls-002"}));
  await pool.query("UPDATE valopay_merchants SET info=jsonb_set(jsonb_set(info,'{killSwitch}','true'::jsonb),'{mode}','\"observation\"'::jsonb) WHERE id=$1",[lender]);
  process.env.VALO_PAY_1_PAYSTACK_INGRESS="test";process.env.PAYSTACK_TEST_SECRET_KEY=["sk","test","OFFLINE","0".repeat(20)].join("_");
  const connectionId=randomBytes(32).toString("hex");
  process.env.VALO_PAY_1_PAYSTACK_CONNECTIONS=JSON.stringify({[connectionId]:{workspaceId,merchantId:lender}});
  const event={kind:"payment" as const,event:"charge.success" as const,dedupeKey:"paystack:test:charge.success:90210",payment:{provider:"paystack" as const,domain:"test" as const,transactionId:"90210",reference:"SYNTHETIC-MAPPED-001",amountKobo:2500,currency:"NGN" as const,state:"succeeded" as const,channel:"direct_debit"}};
  const ingest=()=>paystackConnectionTransaction(connectionId,({state,context})=>receivePaystackEvent(state,context,event,{connectionId,mode:"test"}));
  // A test delivery loads the lender without opening its protected source rows, so it is received while the key service is down.
  const workingUnwrap=managedWrappingKeys.unwrap,workingIngressWrap=managedWrappingKeys.wrap;managedWrappingKeys.unwrap=managedWrappingKeys.wrap=async()=>{throw new Error("key service unavailable");};
  let receipt:Awaited<ReturnType<typeof ingest>>;try{receipt=await ingest();}finally{managedWrappingKeys.unwrap=workingUnwrap;managedWrappingKeys.wrap=workingIngressWrap;}
  const audits=async()=>Number((await pool.query("SELECT count(*) AS n FROM valopay_records WHERE merchant_id=$1 AND kind='audit'",[lender])).rows[0].n);
  const storedReceipt=async()=>(await pool.query("SELECT data->>'deliveryCount' AS count,updated_at FROM valopay_records WHERE merchant_id=$1 AND kind='provider-events'",[lender])).rows[0];
  const auditsBefore=await audits(),receiptBefore=await storedReceipt();
  const duplicate=await ingest();assert.equal(receipt.event.id,duplicate.event.id);assert.equal(duplicate.duplicate,true);
  // A replayed delivery appends no audit entry, and within a minute of its receipt's last write it writes nothing at all.
  for(let replay=0;replay<5;replay++)assert.equal((await ingest()).duplicate,true);
  assert.equal(await audits(),auditsBefore,"repeat deliveries append no audit entry");
  assert.deepEqual(await storedReceipt(),receiptBefore,"and leave the receipt unwritten within a minute of its last write");
  assert.equal(Number((await pool.query("SELECT count(*) AS n FROM valopay_records WHERE merchant_id=$1 AND kind='provider-events'",[lender])).rows[0].n),1);
  await assert.rejects(()=>paystackConnectionTransaction("f".repeat(64),()=>true),/not found/);
  // Over HTTP: the signature is checked on the raw bytes before the lender is locked, loaded or decrypted.
  const providerEvents=async()=>Number((await pool.query("SELECT count(*) AS n FROM valopay_records WHERE merchant_id=$1 AND kind='provider-events'",[lender])).rows[0].n);
  const protectedBatches=Number((await pool.query("SELECT count(*) AS n FROM valopay_records WHERE merchant_id=$1 AND kind='import-batches' AND (data->'csv' ? 'protectedPayload' OR data->'check' ? 'protectedPayload')",[lender])).rows[0].n);
  assert.ok(protectedBatches>0,"the lender holds protected payloads a full load would open");
  const signedBody=JSON.stringify({event:"charge.success",data:{domain:"test",id:"90211",status:"success",amount:2500,currency:"NGN",reference:"SYNTHETIC-MAPPED-002",channel:"direct_debit"}});
  const deliver=(signature:string)=>fetch(`${base}/v1/providers/paystack/${connectionId}/events`,{method:"POST",headers:{"Content-Type":"application/json","X-Paystack-Signature":signature},body:signedBody});
  const signed=createHmac("sha512",process.env.PAYSTACK_TEST_SECRET_KEY!).update(signedBody).digest("hex"),forged="f".repeat(128);
  // Every connection taken from the pool is counted: a load no longer opens payloads, so only this tells the orders apart.
  let checkouts=0;const countCheckout=()=>{checkouts++;};pool.on("acquire",countCheckout);
  unwraps=0;
  const refused=await deliver(forged);
  assert.equal(refused.status,401);assert.equal(((await refused.json()) as {error:string}).error,"The Paystack webhook signature is invalid.");
  assert.equal(checkouts,0,"a forged delivery takes no database connection");
  assert.equal(unwraps,0,"a forged delivery opens no protected payload");
  const answer=async(response:Response)=>({status:response.status,error:((await response.json()) as {error:string}).error});
  const missingLender="The lender mapped to this Paystack test connection was not found. Correct the connection mapping.";
  const holder=await pool.connect();
  try{
    await holder.query("BEGIN");await holder.query("SELECT 1 FROM valopay_merchants WHERE id=$1 FOR UPDATE",[lender]);
    checkouts=0;
    assert.equal((await deliver(forged)).status,401,"a forged delivery never waits for or reports on the lender lock");
    assert.equal(checkouts,0,"a forged delivery to a locked lender takes no database connection");
    const busy=await answer(await deliver(signed));
    assert.equal(busy.status,503);assert.match(busy.error,/The test lender is busy/);
    // A lender that cannot be locked is looked for without the lock, in the mapped workspace only (docs/paystack.md).
    process.env.VALO_PAY_1_PAYSTACK_CONNECTIONS=JSON.stringify({[connectionId]:{workspaceId:"wrong-workspace",merchantId:lender}});
    assert.deepEqual(await answer(await deliver(signed)),{status:404,error:missingLender},"a busy lender is not found in another workspace, so the mapping is named for correction");
  }finally{await holder.query("ROLLBACK");holder.release();process.env.VALO_PAY_1_PAYSTACK_CONNECTIONS=JSON.stringify({[connectionId]:{workspaceId,merchantId:lender}});}
  // A mapping whose lender no longer exists matches no row to lock either: after the signature, and only then, it answers 404, not busy.
  process.env.VALO_PAY_1_PAYSTACK_CONNECTIONS=JSON.stringify({[connectionId]:{workspaceId,merchantId:`gone-${randomUUID()}`}});
  checkouts=0;
  assert.equal((await deliver(forged)).status,401);
  assert.equal(checkouts,0,"a forged delivery to a missing lender takes no database connection");
  assert.deepEqual(await answer(await deliver(signed)),{status:404,error:missingLender},"a signed delivery to a missing lender is told to correct the mapping, not to retry");
  pool.off("acquire",countCheckout);
  process.env.VALO_PAY_1_PAYSTACK_CONNECTIONS=JSON.stringify({[connectionId]:{workspaceId,merchantId:lender}});
  assert.equal(unwraps,0);assert.equal(await providerEvents(),1,"refused deliveries save nothing");
  const accepted=await deliver(signed);
  assert.equal(accepted.status,200);assert.deepEqual(await accepted.json(),{accepted:true,duplicate:false});
  assert.equal(await providerEvents(),2,"a verified delivery is saved in the mapped lender's inbox");
  assert.deepEqual(await (await deliver(signed)).json(),{accepted:true,duplicate:true});
  assert.equal(await providerEvents(),2);
  process.env.VALO_PAY_1_PAYSTACK_CONNECTIONS=JSON.stringify({[connectionId]:{workspaceId:"wrong-workspace",merchantId:lender}});
  await assert.rejects(ingest,/unavailable/);
  assert.equal((await deliver(signed)).status,403,"a free lender mapped to another workspace is refused");
  assert.equal(Number((await pool.query("SELECT count(*) AS n FROM valopay_records WHERE merchant_id=$1 AND kind='provider-events'",[other])).rows[0].n),0);
  console.log("Operations controls PostgreSQL integration passed: source checks, encrypted payloads opened only by the views that need them (overviews, lists, unkeyed saves, the scheduled close and test receipts work while the key service is down, older batches without their counts; keyed saves fail closed), holds/stale previews, verified retention receipts, preserved request tombstones, mapped Paystack test receipts and forged deliveries refused before the lender is locked or decrypted.");
}finally{
  managedWrappingKeys.wrap=oldWrap;managedWrappingKeys.unwrap=oldUnwrap;master.fill(0);
  for(const name of environmentNames){const value=previousEnvironment[name];if(value===undefined)delete process.env[name];else process.env[name]=value;}
  server.close();await once(server,"close");
  for(const workspaceId of workspaces){await pool.query("DELETE FROM valopay_idempotency WHERE merchant_id IN(SELECT id FROM valopay_merchants WHERE workspace_id=$1)",[workspaceId]);await pool.query("DELETE FROM valopay_records WHERE merchant_id IN(SELECT id FROM valopay_merchants WHERE workspace_id=$1)",[workspaceId]);await pool.query("DELETE FROM valopay_merchants WHERE workspace_id=$1",[workspaceId]);await pool.query("DELETE FROM valopay_workspaces WHERE id=$1",[workspaceId]);}
  await pool.end();
}
