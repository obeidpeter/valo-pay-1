// API smoke checks use a fresh, synthetic sandbox only; never production data.
// This script must never be pointed at a production host.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { probeSandboxCookieName } from "./sandbox-cookie-name.mjs";
const domain=process.env.REPLIT_DEV_DOMAIN;
if(!domain||!/^[a-z0-9.-]+\.replit\.dev(?::\d+)?$/i.test(domain))throw new Error("Refusing to run: REPLIT_DEV_DOMAIN must be a *.replit.dev host.");
const base=`https://${domain}`;
const sandboxCookie=probeSandboxCookieName();
// A planted legacy cookie must not select a fresh browser's sandbox.
const legacyToken=randomBytes(32).toString("hex");
let cookie=`valo_sandbox=${legacyToken}`,merchantId="",checks=0;
async function call(path,{method="GET",body,key,expected=200,foreign=false}={}){
 const response=await fetch(`${base}/api/v1/${path}${path.includes("?")?"&":"?"}${merchantId?"merchantId="+merchantId:""}`,{
  method,headers:{"Content-Type":"application/json",...(!foreign&&cookie?{Cookie:cookie}:{}),...(key?{"Idempotency-Key":key}:{})},
  ...(body?{body:JSON.stringify(body)}:{})
 });
 if(!foreign&&response.headers.get("set-cookie"))cookie=response.headers.get("set-cookie").split(";")[0];
 const data=await response.json();
 assert.equal(response.status,expected,`${method} ${path}: ${JSON.stringify(data).slice(0,250)}`);checks++;
 return data;
}
const workspace=await call("workspace");assert.equal(workspace.merchants.length,2);assert.equal(workspace.productionEnabled,false);merchantId=workspace.merchants[0].id;
// The answer sets this generation's environment-specific secure cookie first, then clears the legacy one.
assert.match(cookie,new RegExp(`^${sandboxCookie}=[a-f0-9]{64}$`));
assert.notEqual(cookie,`${sandboxCookie}=${legacyToken}`,"Legacy cookies must not select a sandbox.");
const restoredWorkspace=await call("workspace");
assert.deepEqual(restoredWorkspace.merchants.map(m=>m.id),workspace.merchants.map(m=>m.id),"The new host cookie retains the same lender workspaces.");
for(const path of ["overview","reports","gates","settings","records/mandates","records/exceptions","records/payments","openapi.json"])await call(path);
const list=async kind=>(await call(`records/${kind}`)).items;
const action=(action,recordId,extra={})=>call("actions",{method:"POST",body:{action,recordId,reason:"Synthetic API smoke verification",...extra}});
const due=(await list("due-items")).find(d=>d.status==="scheduled"&&d.amountKobo>=1000000);
assert(due);
await call("records/due-items",{method:"POST",expected:400,body:{name:"Floor refusal",customerId:due.customerId,amountKobo:499999,reference:"SMOKE-FLOOR",data:{dueDate:"2027-01-10",owner:"lms",mandateId:due.data.mandateId}}});
await call("actions",{method:"POST",expected:400,body:{action:"request_instruction",reason:"Must remain blocked"}});
await call("imports",{method:"POST",expected:403,body:{kind:"customers",csv:"row_id,name\nr1,Synthetic",identityColumn:"row_id",syntheticOnly:false,commit:true}});
// Every quick-import row needs a source row ID: a file without its row ID column is refused, naming what to map.
await call("imports",{method:"POST",expected:400,body:{kind:"customers",csv:"name,consentProvenance\nSynthetic,Synthetic consent",identityColumn:"row_id",syntheticOnly:true,commit:false}});
await call("records/customers",{expected:404,foreign:true});
const customers=await list("customers");
await call(`customers/${customers[0].id}/timeline`);
const before=(await list("payments")).length;
for(const source of ["webhook","settlement"]){
 await call("records/observations",{method:"POST",body:{name:`Synthetic replay ${source}`,status:"unresolved",reference:"SMOKE-CANONICAL-001",customerId:due.customerId,amountKobo:due.amountKobo,data:{source,provider:"Sandbox Rail",dueItemId:due.id,eventId:`smoke-${source}`,settlementStatus:"settled"}}});
}
await action("run_reconciliation");
const payments=await list("payments");assert.equal(payments.length,before+1,"Two observations must create only one payment.");
await action("run_reconciliation");
assert.equal((await list("payments")).length,payments.length,"Reconciliation replay must not create another payment.");
const pending=payments.find(p=>p.status==="proposed");
if(pending){
 // A decision names the proposal it was made on: its id and the version read.
 const proposal=(await list("allocations")).find(a=>a.data.paymentId===pending.id&&a.status==="proposed");
 assert(proposal,"A proposed payment must have its proposed allocation.");
 await call("actions",{method:"POST",expected:400,body:{action:"confirm_allocation",recordId:pending.id,reason:"Must name the proposal"}});
 await action("confirm_allocation",pending.id,{data:{proposalId:proposal.id,proposalUpdatedAt:proposal.updatedAt}});
 const allocations=await list("allocations");
 assert(allocations.filter(a=>a.data.paymentId===pending.id&&a.status==="confirmed").reduce((sum,a)=>sum+a.amountKobo,0)<=pending.amountKobo);
}
const create={name:"Synthetic smoke customer",reference:"SMOKE-CUSTOMER",data:{consentProvenance:"Synthetic",accountMasked:"•••• 4242",phoneMasked:"+234 ••• 20"}};
const first=await call("records/customers",{method:"POST",body:create,key:"smoke-idempotency"});
const replay=await call("records/customers",{method:"POST",body:create,key:"smoke-idempotency"});assert.equal(first.id,replay.id);
await call("records/customers",{method:"POST",expected:409,body:{...create,name:"Different payload"},key:"smoke-idempotency"});
await action("set_role",undefined,{data:{role:"Read-only"}});
await call("records/customers",{method:"POST",expected:403,body:{...create,reference:"SMOKE-DENIED"}});
await action("set_role",undefined,{data:{role:"Admin"}});
const policy=(await list("policies"))[0];
await action("submit_policy",policy.id);
await call("actions",{method:"POST",expected:403,body:{action:"approve_policy",recordId:policy.id,reason:"Author cannot approve own policy"}});
await action("set_role",undefined,{data:{role:"Compliance reviewer"}});
await action("approve_policy",policy.id);
await action("set_role",undefined,{data:{role:"Admin"}});
const backtest=await action("backtest_policy",policy.id);
assert(backtest.data.decisions.length>0,"Backtest must include obligations linked through their mandates.");
assert(backtest.data.decisions.every(d=>d.decision!=="would_schedule"),"Observation sandbox must not suggest dispatch eligibility.");
const experiment=(await list("experiments"))[0];
await action("preregister_experiment",experiment.id);
assert((await list("due-items")).every(d=>!d.data.experimentId),"Preregistration must not assign obligations before a future first failure.");
await action("daily_close");
const verify=await action("verify_audit");assert.equal(verify.data.valid,true,"Audit chain must verify after all writes.");
const exp=await call("exports",{method:"POST",body:{kind:"customer-pack",customerId:customers[0].id,format:"pdf"}});
const download=await fetch(base+exp.downloadUrl,{headers:{Cookie:cookie}});
assert.equal(download.status,200);
const bytes=Buffer.from(await download.arrayBuffer());
assert.equal(bytes.subarray(0,4).toString(),"%PDF");
assert.equal(createHash("sha256").update(bytes).digest("hex"),exp.checksum);
const afterExport=await action("verify_audit");assert.equal(afterExport.data.valid,true);
console.log(`Passed ${checks} API responses plus canonicalisation, allocation, idempotency, isolation, gate, audit and PDF checksum assertions.`);
