import PDFDocument from "pdfkit";
import { createHash } from "node:crypto";
import { objectStorageClient } from "./objectStorage";
import type { Context, DomainState, ValopayRecord } from "../domain/types";
import { buildReports } from "../domain";
import { getGates } from "./valopay-readiness";
import { verifyAudit } from "./valopay-store";
import { collectExportBytes, readExportBytes, readExportMetadata, writeExportBytes } from "./export-download";
import { buildDisputePack, disputePackCsv, packFonts, renderDisputePackPdf, type DisputePack } from "./valopay-packs";
import { MAX_EXPORT_BYTES, publicExportRecord, type ClaimedExport, type ExportArtifact, type ExportJobStorage } from './export-jobs';
import { reviewedCloseEvidence } from '../domain/close-review';
import { exportKindName, notFoundText } from "@workspace/valopay-schema";

/** CSV downloads are UTF-8 and start with the byte order mark, which is what spreadsheet programs look for before they read accented letters correctly on opening; the importer skips it (csv-parse `bom`). */
const CSV_BOM="\uFEFF";
function escapeCsv(value:unknown){
 let text=typeof value==="object"?JSON.stringify(value):String(value??"");
 if(/^[=+\-@\t\r]/.test(text))text="'"+text;
 return `"${text.replaceAll('"','""')}"`;
}
async function pdfBytes(title:string,data:unknown,signal?:AbortSignal):Promise<Buffer>{
  signal?.throwIfAborted();
  const document=new PDFDocument({size:"A4",lang:"en-GB",margin:45,info:{Title:title,Author:"Valo Pay"}});
  const result=collectExportBytes(document,signal,MAX_EXPORT_BYTES,30_000), deadline=performance.now()+30_000;
  // Observe rejection immediately while synchronous layout is still running.
  void result.catch(()=>{});
  try {
  const fonts=packFonts();document.registerFont("Sans",fonts.regular).registerFont("Sans-Bold",fonts.bold).font("Sans");
  document.fontSize(24).fillColor("#102E2A").text("Valo Pay").moveDown(0.4);
  document.fontSize(15).text(title).moveDown();
  document.fillColor("#9B6524").fontSize(10).text("Sample data only: not live evidence").moveDown();
  document.fillColor("#333333").fontSize(9).text("Valo Pay never holds money. Amounts below are in kobo (100 kobo = ₦1). Money in another currency is in that currency’s smallest unit: otherCurrencies lists it by currency beside a naira total, never in it. Times are in UTC unless stated. This sample export cannot be used as go-live evidence.").moveDown();
  document.font("Sans").fontSize(7);
  const text=JSON.stringify(data,null,2);
  for(let start=0;start<text.length;){
    signal?.throwIfAborted();
    if(performance.now()>deadline)throw new Error('PDF rendering exceeded its time limit.');
    let end=Math.min(start+4096,text.length);
    if(end<text.length && /[\uD800-\uDBFF]/.test(text[end-1]!))end--;
    document.text(text.slice(start,end),{width:505,continued:end<text.length});
    start=end;
  }
  document.end();
  } catch(error) { document.destroy(error instanceof Error?error:new Error(String(error))); }
  return result;
}
/** A PDF export's title in words: the one name its saved export and the console give it (exportKindName). */
function exportTitle(kind:string):string{
 return exportKindName(kind);
}
/** The export kinds that are a customer's dispute pack (customer-pack is the older name). */
export const packKinds=["customer-pack","dispute-pack"] as const;
/** The export kinds that are not a record kind. */
export const exportKinds=["gate-pack","billing","reviewed-close",...packKinds] as const;
/** What to export and in which format. */
export interface ExportInput{kind:string;customerId?:string;closeReviewId?:string;format:"json"|"csv"|"pdf"}
/** The file for an export request and the payload it was made from. */
export interface ExportBytes{bytes:Buffer;contentType:string;payload:unknown;pack?:DisputePack}

/** Walk the rendered payload before PDF/JSON encoding allocates a second copy.
 * Each string is measured once; unrelated lender history is not an export limit. */
function assertPayloadSize(payload:unknown):void{
 let length=0;
 const visit=(value:unknown):void=>{
  if(value&&typeof value==='object'){
   length+=2;
   for(const [key,child] of Object.entries(value)){length+=Buffer.byteLength(JSON.stringify(key))+2;visit(child);}
  }else length+=Buffer.byteLength(JSON.stringify(value)??'null');
  if(length>MAX_EXPORT_BYTES)throw Object.assign(new Error('Export source exceeds the supported size.'),{exportTooLarge:true});
 };
 visit(payload);
}

/** Pure byte generation. The worker records the checksum and uploads outside database transactions. */
export async function buildExportBytes(state:DomainState,ctx:Context,input:ExportInput,options:{compress?:boolean;signal?:AbortSignal}={}):Promise<ExportBytes>{
 options.signal?.throwIfAborted();
 const generatedAt=ctx.now;
 if((packKinds as readonly string[]).includes(input.kind)){
  // AUD-02: one-page summary followed by the timeline, as PDF, CSV or JSON of the same data.
  const pack=buildDisputePack(state,ctx,input.customerId||"");
  assertPayloadSize(pack);
  if(input.format==="pdf")return {bytes:await renderDisputePackPdf(pack,options),contentType:"application/pdf",payload:pack,pack};
  if(input.format==="csv")return {bytes:Buffer.from(CSV_BOM+disputePackCsv(pack)),contentType:"text/csv; charset=utf-8",payload:pack,pack};
  return {bytes:Buffer.from(JSON.stringify(pack,null,2)),contentType:"application/json",payload:pack,pack};
 }
 const reports=input.kind==="gate-pack"||input.kind==="billing"?buildReports(state,ctx.now):undefined;
 // MEA-02 and RET-06: the gate pack carries the uplift report with the pre-registered rule and its result, frozen at generation.
 const payload=input.kind==='reviewed-close'?reviewedCloseEvidence(state,input.closeReviewId||''):input.kind==="gate-pack"?{...getGates(state),upliftReport:reports!.experiment,operational:reports!.operational,billing:reports!.billing}:input.kind==="billing"?reports!.billing:state.records.filter(r=>r.kind===input.kind).map(record=>record.kind==='exports'?publicExportRecord(record):record);
 const snapshot={merchant:state.merchant.name,environment:"synthetic_sandbox",generatedAt,generatedBy:ctx.actor,auditVerification:verifyAudit(state),data:payload};
 assertPayloadSize(snapshot);
 if(input.format==="pdf")return {bytes:await pdfBytes(exportTitle(input.kind),snapshot,options.signal),contentType:"application/pdf",payload:snapshot};
 if(input.format==="csv"){
  const rows=Array.isArray(payload)?payload:[payload];
  const keys=[...new Set(rows.flatMap(r=>Object.keys(r)))];
  return {bytes:Buffer.from(CSV_BOM+[["environment","merchant",...keys].join(","),...rows.map(r=>["synthetic_sandbox",state.merchant.name,...keys.map(k=>r[k])].map(escapeCsv).join(","))].join("\r\n")),contentType:"text/csv; charset=utf-8",payload:snapshot};
 }
 return {bytes:Buffer.from(JSON.stringify(snapshot,null,2)),contentType:"application/json",payload:snapshot};
}
/** Pure byte generation, called only after the durable worker claim transaction has committed. */
export async function generateExportArtifact(claim: ClaimedExport, signal?: AbortSignal): Promise<{ bytes: Buffer; artifact: ExportArtifact }> {
 const started=performance.now();
 const {bytes,contentType,pack}=await buildExportBytes(claim.state,claim.context,claim.input,{signal});
 signal?.throwIfAborted();
 return {bytes,artifact:{checksum:createHash('sha256').update(bytes).digest('hex'),contentType,byteLength:bytes.length,generationMs:Math.round(performance.now()-started),generatedAt:claim.context.now,
  ...(pack?{events:pack.timeline.length,customerReference:String(pack.customer.reference)}:{})}};
}
/** A stable private key and create-only upload make recovery safe after lost acknowledgements and failed commits. */
export const exportJobStorage: ExportJobStorage = {
 async existing(claim,signal) {
  const file=objectStorageClient.bucket(claim.location.bucket).file(claim.location.objectName);
  let metadata;
  try {
   metadata=await readExportMetadata(file,signal);
  } catch(error) { if(Number((error as {statusCode?:unknown;code?:unknown}).statusCode??(error as {code?:unknown}).code)===404)return null; throw error; }
  const custom=metadata.metadata||{};
  if(custom.valopayExportId!==claim.id||custom.valopayMerchantId!==claim.merchantId)throw new Error('Export object ownership metadata does not match its job.');
  const artifact=JSON.parse(String(custom.valopayArtifact||'null')) as ExportArtifact|null;
  if(!artifact||!/^[a-f0-9]{64}$/.test(artifact.checksum)||!Number.isSafeInteger(artifact.byteLength)||artifact.byteLength<0||artifact.byteLength>MAX_EXPORT_BYTES||Number(metadata.size)!==artifact.byteLength)throw new Error('Export object metadata is invalid.');
  const bytes=await readExportBytes(file,signal,MAX_EXPORT_BYTES);
  if(bytes.length!==artifact.byteLength||createHash('sha256').update(bytes).digest('hex')!==artifact.checksum)throw new Error('Export recovery checksum verification failed.');
  return artifact;
 },
 async put(claim,bytes,artifact,signal) {
  await writeExportBytes(objectStorageClient.bucket(claim.location.bucket).file(claim.location.objectName),bytes,{contentType:artifact.contentType,cacheControl:'private, no-store',metadata:{valopayExportId:claim.id,valopayMerchantId:claim.merchantId,valopayArtifact:JSON.stringify(artifact)}},signal);
 },
};
/** Where an export lives and what to check it against. */
export interface ExportDescriptor{id:string;bucket:string;objectName:string;checksum:string;contentType:string;filename:string}
/** The authorised export metadata from the lender's state; resolved inside the transaction, used after it. */
export function exportDescriptor(state:DomainState,id:string):ExportDescriptor{
 const record=state.records.find(r=>r.kind==="exports"&&r.id===id);
 if(!record)throw Object.assign(new Error(notFoundText("export")),{status:404});
 return exportDescriptorForRecord(record);
}
export function exportDescriptorForRecord(record:ValopayRecord):ExportDescriptor{
 if(record.data.fileDeletedAt)throw Object.assign(new Error('This export file was deleted under the lender’s data retention policy. Its deletion record is kept. Create a new export if you need the file.'),{status:410});
 if(record.status!=="ready")throw Object.assign(new Error("This export is not ready yet. Check its status in Saved exports, or retry it there."),{status:409});
 return {id:record.id,bucket:String(record.data.bucket),objectName:String(record.data.objectName),checksum:String(record.data.checksum),contentType:String(record.data.contentType),filename:`valopay-${record.data.kind}-${record.id}.${record.data.format}`};
}
/** Reads the object and verifies the immutable SHA-256 before any byte is returned; holds no database lock. */
export async function readExport(descriptor:ExportDescriptor,signal?:AbortSignal){
 const bytes=await readExportBytes(objectStorageClient.bucket(descriptor.bucket).file(descriptor.objectName),signal);
 // Evidence that no longer matches its recorded checksum is never sent, and is an error-level failure for the operators.
 if(createHash("sha256").update(bytes).digest("hex")!==descriptor.checksum)throw Object.assign(new Error("This export file has changed since it was made, so it was not sent. Create the export again, and quote this reference if it happens again."),{status:500,expose:true});
 return {bytes,contentType:descriptor.contentType,filename:descriptor.filename};
}
/** The export's bytes for a download, resolved from the lender's state and checksum verified. */
export function downloadExport(state:DomainState,id:string,signal?:AbortSignal){
 return readExport(exportDescriptor(state,id),signal);
}
