import assert from "node:assert/strict";
import { seedMerchant } from "../src/lib/valo-pay-1-seed";
import { makeRecord } from "../src/domain/records";
import { saveSourceManifest, sourceCompleteness, sourceFileId, watBusinessDate } from "../src/domain/source-completeness";
import { saveImportBatch, commitImportBatch } from "../src/domain/pilot-workflow";
import { bindCloseReviewBasis, prepareCloseReview, closeReviewIssues, decideCloseReview, reviewIsCurrent, closeReviewCurrentProblem } from "../src/domain/close-review";
import type { DomainState } from "../src/domain/types";
import { sourceCompletenessSchema } from "@workspace/valo-pay-1-schema";

const ctx = { actor:"Clerk:operator",principalId:"operator",role:"Operations",now:"2026-09-23T09:00:00.000Z" }, finance={...ctx,actor:"Clerk:finance",principalId:"finance",role:"Finance"};
const date="2026-09-22", file={source:"loan-system",sourceBatchId:"customers-2026-09-22",kind:"customers" as const,expectedRows:1,expectedAmountKobo:0};
const declaration={businessDate:date,files:[file],noFilesExpected:false,reason:"The source owner confirms the complete daily file set.",evidence:"Source control report CONTROL-22.",syntheticOnly:true as const};
const fresh=()=>{const state=seedMerchant("source-completeness-test",true);state.records=[];return state;};
function imported(state:DomainState,businessDate?:string) {
  const batch=saveImportBatch(state,ctx,{name:"Original customer delivery",source:file.source,sourceBatchId:file.sourceBatchId,kind:"customers",businessDate,csv:"source_row_id,name,reference,consentProvenance\nc-1,Sample customer,C-001,Synthetic consent",mapping:{},identityColumn:"source_row_id",amountUnit:"naira",syntheticOnly:true});
  commitImportBatch(state,ctx,batch.id,batch.updatedAt);return state.records.find(r=>r.id===batch.id)!;
}
function prepared(state:DomainState) {
  const close=makeRecord(state,"closes" as string,{name:"Close source day",status:"completed",createdAt:ctx.now,data:{sourceBusinessDate:date,closedAt:ctx.now,report:{}}});bindCloseReviewBasis(state,close);
  const review=prepareCloseReview(state,ctx,{closeId:close.id,expectedUpdatedAt:close.updatedAt,reviewer:finance.actor,preparationNote:"Compared the close against the original source controls.",discrepancyResponses:closeReviewIssues(close).map(issue=>({issueId:issue.id,explanation:"The source owner is investigating and Finance must review the gap."})),unresolvedAcceptance:"The source owner will deliver the missing evidence tomorrow."},[finance]);
  return {close,review};
}
const decision=(review:any)=>({action:"approve" as const,expectedUpdatedAt:review.updatedAt,note:"Independently checked the recorded source evidence.",sourceExceptions:review.data.snapshot.data.reviewBasis.sourceCompleteness.issues.map((issue:any)=>({issueId:issue.id,reason:"Accepted for this synthetic rehearsal with follow-up tomorrow.",evidence:"Finance review case FIN-22."}))});

assert.equal(watBusinessDate("2026-09-21T23:30:00.000Z"),date);
{
  const state=fresh();assert.equal(sourceCompleteness(state,date).status,"incomplete");
  assert.throws(()=>saveSourceManifest(state,ctx,{...declaration,businessDate:"2026-02-30"}),/Enter a real business date/);
  assert.throws(()=>saveSourceManifest(state,{...ctx,role:"Read-only"},declaration),/role/);
  assert.throws(()=>saveSourceManifest(state,ctx,{...declaration,files:[file,file]}),/once/);
  const original=saveSourceManifest(state,ctx,declaration), snapshot=JSON.stringify(original);
  assert.equal(sourceCompleteness(state,date).files[0].batchStatus,"missing");
  assert.throws(()=>saveSourceManifest(state,ctx,declaration),/changed/);
  assert.throws(()=>saveSourceManifest(state,ctx,{...declaration,businessDate:"2026-09-23"}),/another business date/);
  imported(state,date);
  assert.equal(sourceCompleteness(state,date).status,"complete","A late delivery counts for its explicit original business date, not its arrival day.");
  assert.equal(sourceCompleteness(state,"2026-09-23").status,"incomplete");
  const {review}=prepared(state);assert.equal(review.data.snapshot!.data.reviewBasis.sourceCompleteness.businessDate,date);
  const batch=state.records.find(r=>r.kind==='import-batches')!;delete batch.data.csv;batch.data.rawCsvRemovedAt=ctx.now;
  assert.equal(reviewIsCurrent(state,review),true,"Raw-file retention preserves the original source control totals.");
  saveSourceManifest(state,ctx,{...declaration,files:[{...file,expectedRows:2}],previousManifestId:original.id,expectedUpdatedAt:original.updatedAt});
  assert.equal(JSON.stringify(original),snapshot,"A revised declaration never overwrites its predecessor.");
  assert.equal(reviewIsCurrent(state,review),false);
  assert.throws(()=>decideCloseReview(state,finance,review.id,decision(review)),/no longer current/);
}
{
  const state=fresh();const batch=imported(state,undefined);saveSourceManifest(state,ctx,declaration);
  assert.equal(sourceCompleteness(state,date).status,"incomplete","An undated legacy batch cannot acquire a business date from arrival time.");
  assert.match(sourceCompleteness(state,date).files[0].problems.join(" "),/older batch/);
  const {review}=prepared(state), approve=decision(review);
  assert.throws(()=>decideCloseReview(state,finance,review.id,{...approve,sourceExceptions:[]}),/Accept each missing or incomplete source file/);
  assert.throws(()=>decideCloseReview(state,finance,review.id,{...approve,sourceExceptions:[...approve.sourceExceptions,...approve.sourceExceptions]}),/Accept each missing or incomplete source file/);
  assert.throws(()=>decideCloseReview(state,finance,review.id,{...approve,sourceExceptions:[{...approve.sourceExceptions[0],evidence:""}]}));
  assert.throws(()=>decideCloseReview(state,{...finance,principalId:ctx.principalId},review.id,approve),/different person/);
  decideCloseReview(state,finance,review.id,approve);
  assert.equal(review.status,"approved");assert.equal(sourceCompleteness(state,date).status,"incomplete","Acceptance never relabels an incomplete source set as complete.");
  assert.equal(review.data.sourceExceptions![0]!.evidence,"Finance review case FIN-22.");
  assert.equal(batch.data.businessDate,undefined);
  makeRecord(state,"import-corrections",{id:"pending-money",data:{preview:{financial:true}}});
  assert.equal(reviewIsCurrent(state,review),false,"A new pending financial correction prevents claiming old approval is current.");
  assert.match(closeReviewCurrentProblem(state,review.data.snapshot!)!,/Import corrections to instalments are waiting for a decision/);
}
{
  const state=fresh();saveSourceManifest(state,ctx,declaration);
  assert.throws(()=>saveImportBatch(state,ctx,{name:"Wrong date",source:file.source,sourceBatchId:file.sourceBatchId,kind:"customers",businessDate:"2026-09-23",csv:"id,name\n1,Name",mapping:{},identityColumn:"id",amountUnit:"naira",syntheticOnly:true}),/declared for another business date/);
  const fake=makeRecord(state,"import-batches",{status:"committed",data:{source:file.source,sourceBatchId:file.sourceBatchId,kind:file.kind,businessDate:date,sourceExpectationId:sourceFileId(date,file),sourceQuality:{profileId:null,profileVersion:null,sourceRows:2,sourceAmountKobo:100,importedRows:2,importedAmountKobo:100,duplicateRows:0,conflictRows:0,invalidRows:0,status:"checked",issues:[]}}});
  assert.match(sourceCompleteness(state,date).files[0].problems.join(" "),/Declared 1 rows/);
  assert.match(sourceCompleteness(state,date).files[0].problems.join(" "),/Declared 0 kobo/);
  fake.data.sourceQuality!.sourceRows=1;fake.data.sourceQuality!.sourceAmountKobo=0;assert.equal(sourceCompleteness(state,date).status,"complete");
  makeRecord(state,"source-profiles",{status:"active",data:{source:"another-feed",kind:"observations"}});
  assert.match(sourceCompleteness(state,date).issues[0].label,/another-feed/);
  makeRecord(state,"source-profiles",{status:"active",data:{source:"future-feed",kind:"payments",firstExpectedAt:"2026-09-25T08:00:00.000Z"}});
  assert.equal(sourceCompleteness(state,date).issues.some(issue=>/future-feed/.test(issue.label)),false,"A profile expecting its first delivery after this business date has nothing to declare for it.");
  assert.equal(sourceCompleteness(state,"2026-09-25").issues.some(issue=>/future-feed/.test(issue.label)),true);
}
{
  // Integration fix: a declared total is in naira, so it is compared with the file's naira rows only, and a file with
  // rows in another currency says so and lists them beside what it received, never adding them to the naira total.
  const state=fresh(), evidence={source:"card-feed",sourceBatchId:"cards-2026-09-22",kind:"observations" as const,expectedRows:3,expectedAmountKobo:1000};
  saveSourceManifest(state,ctx,{...declaration,files:[evidence]});
  const quality={profileId:null,profileVersion:null,sourceRows:3,sourceAmountKobo:1000,importedRows:3,importedAmountKobo:1000,duplicateRows:0,conflictRows:0,invalidRows:0,status:"checked" as const,issues:[]};
  const batch=makeRecord(state,"import-batches",{status:"committed",data:{...evidence,businessDate:date,sourceExpectationId:sourceFileId(date,evidence),sourceQuality:quality}});
  const naira=sourceCompleteness(state,date);
  assert.equal(naira.files[0].status,"complete");
  assert.equal("receivedOtherCurrencies" in naira.files[0],false,"a file in naira alone lists no other currency, so the evidence a close recorded before this is unchanged");
  batch.data.sourceQuality={...quality,sourceOtherCurrencies:{JPY:{count:1,amount:1000},USD:{count:1,amount:1000}}};
  const mixed=sourceCompleteness(state,date);
  assert.deepEqual([mixed.files[0].status,mixed.files[0].receivedAmountKobo,mixed.files[0].receivedOtherCurrencies],["incomplete",1000,{JPY:{count:1,amount:1000},USD:{count:1,amount:1000}}]);
  assert.deepEqual(mixed.files[0].problems,["The declared total is in naira, so it is compared with the naira rows only; this file also has JPY 1,000 and USD 10.00 in other currencies, which no declared total covers."]);
  assert.notEqual(mixed.basisDigest,naira.basisDigest);
  assert.equal(sourceCompletenessSchema.safeParse(mixed).success,true);
}
{
  const state=fresh();saveSourceManifest(state,ctx,{...declaration,files:[],noFilesExpected:true});
  assert.equal(sourceCompleteness(state,date).status,"incomplete","An explicit no-file exclusion requires independent Finance acceptance.");
  const {review}=prepared(state);decideCloseReview(state,finance,review.id,decision(review));assert.equal(review.status,"approved");
}
console.log("Source completeness passed: business-date slots, late/undated files, exact totals, immutable revisions, stale review, Finance exceptions and correction gates.");
