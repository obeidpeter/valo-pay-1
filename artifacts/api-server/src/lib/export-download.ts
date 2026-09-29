import type { File } from "@google-cloud/storage";
import { Readable } from "node:stream";
import { createHash, randomUUID } from 'node:crypto';

/**
 * A storage answer other than success. The storage status stays as statusCode
 * for callers that treat a missing object as already deleted; status is how
 * this API answers, and none of these is the person's fault: an outage is a
 * 503, and a missing file or a refusal of this service's own access is a 502,
 * logged as an error for the operators.
 */
export function storageFailure(statusCode: number | undefined, verb: "downloaded" | "saved" = "downloaded"): Error {
  const status = statusCode === 429 || (statusCode ?? 0) >= 500 ? 503 : 502;
  const message = statusCode === 404 ? "The export file is missing from storage. Generate the export again, and quote this reference if it happens again."
    : status === 503 ? `Export storage is unavailable, so the file could not be ${verb}. Try again shortly.`
    : `Export storage refused this service's request, so the file could not be ${verb}. Ask the administrator to check storage access.`;
  return Object.assign(new Error(message), { statusCode, status });
}
/** A storage request that did not finish: no answer in time is a 504; a broken answer is a 502. */
const storageTimeout = (message: string) => Object.assign(new Error(message), { status: 504 });
const storageBroken = (message: string) => Object.assign(new Error(message), { status: 502 });

/** One consumer owns buffering, cancellation and cleanup for an export read. */
export const EXPORT_STORAGE_TIMEOUT_MS = 60_000;
export function collectExportBytes(stream: Readable, signal?: AbortSignal, maxBytes = 32 * 1024 * 1024, timeoutMs = EXPORT_STORAGE_TIMEOUT_MS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let tearingDown = false;
    let length = 0;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.off("close", onClose);
      stream.off("response", onResponse);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const bytes = error ? undefined : Buffer.concat(chunks);
      chunks.length = 0;
      // A producer may still be attaching its body pipe inside a response
      // callback. Defer teardown until that callback has returned. Network
      // cancellation belongs to readStorageObject's AbortController; calling
      // retry-request's duck-typed abort() here used to clear its live pipe.
      setImmediate(() => {
        tearingDown = true;
        let failure = error;
        try { stream.destroy(); }
        catch (cause) { failure ??= cause instanceof Error ? cause : new Error(String(cause)); }
        // Keep the error handler through destroy and until close: transport
        // transport errors may still arrive while cancellation is unwinding.
        if (stream.closed) cleanup();
        if (failure) reject(failure); else resolve(bytes!);
      });
    };
    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > maxBytes) { finish(new Error('Export download exceeds the supported file size.')); return; }
      chunks.push(bytes);
    };
    const onEnd = () => finish();
    const onError = (error: Error) => finish(error);
    const onClose = () => {
      if (!settled) finish(storageBroken("Export download closed before completion."));
      else if (tearingDown) cleanup();
    };
    const onAbort = () => finish(signal?.reason instanceof Error ? signal.reason : Object.assign(new Error("Export download cancelled."), { name: "AbortError" }));
    const onResponse = (response: { statusCode?: number }) => {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        finish(storageFailure(response.statusCode));
      }
    };
    stream.on("error", onError);
    stream.once("end", onEnd);
    stream.once("close", onClose);
    stream.on("response", onResponse);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(storageTimeout('Export storage request timed out.')), timeoutMs);
    if (signal?.aborted) { onAbort(); return; }
    stream.on("data", onData);
  });
}

/** Bound the wait for SDK-managed credentials; its underlying token refresh is
 * not cancellable through the public API. A late result never starts a read. */
function beforeAbort<T>(pending:Promise<T>,signal:AbortSignal):Promise<T>{
 return new Promise((resolve,reject)=>{
  const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
  signal.addEventListener('abort',abort,{once:true});
  pending.then(value=>{signal.removeEventListener('abort',abort);if(!signal.aborted)resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  if(signal.aborted)abort();
 });
}
/** Keep SDK authentication, but avoid its non-cancellable teeny-request read
 * transport. Native fetch aborts before headers and during the response body. */
async function readStorageObject(file:File,media:boolean,signal?:AbortSignal,maxBytes=32*1024*1024,timeoutMs=EXPORT_STORAGE_TIMEOUT_MS):Promise<Buffer>{
 const controller=new AbortController();
 const abort=()=>controller.abort(Object.assign(new Error('Export download cancelled.'),{name:'AbortError'}));
 if(signal?.aborted){abort();throw controller.signal.reason;}
 signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>controller.abort(storageTimeout('Export storage request timed out.')),timeoutMs);
 try{
  // Both path segments are encoded independently; a slash, space or question
  // mark in an object name cannot change the endpoint or its query parameters.
  const url=new URL(`${media?'/download':''}/storage/v1/b/${encodeURIComponent(file.bucket.name)}/o/${encodeURIComponent(file.name)}`,file.storage.apiEndpoint);
  if(media)url.searchParams.set('alt','media');
  const authHeaders=await beforeAbort(file.storage.authClient.getRequestHeaders(url.toString()),controller.signal);
  controller.signal.throwIfAborted();
  const headers=new Headers(authHeaders);headers.set('Accept-Encoding','identity');headers.set('Cache-Control','no-store');
  const response=await globalThis.fetch(url,{headers,signal:controller.signal,redirect:'error'});
  if(!response.ok){await response.body?.cancel();throw storageFailure(response.status);}
  if(!response.body)throw storageBroken('Export storage response has no body.');
  const stream=Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  return await collectExportBytes(stream,controller.signal,maxBytes,timeoutMs);
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
}
export function readExportBytes(file:File,signal?:AbortSignal,maxBytes?:number,timeoutMs?:number):Promise<Buffer>{
 // The caller verifies SHA-256 before returning these immutable artifact bytes.
 return readStorageObject(file,true,signal,maxBytes,timeoutMs);
}
export async function readExportMetadata(file:File,signal?:AbortSignal,timeoutMs?:number):Promise<Record<string,any>>{
 return JSON.parse((await readStorageObject(file,false,signal,256*1024,timeoutMs)).toString('utf8'));
}
/** A create-only upload with one cancellable native request. A late credential
 * refresh never starts a write; a lost acknowledgement is recovered by the
 * caller through the same key and verified artifact metadata. */
export async function writeExportBytes(file:File,bytes:Buffer,metadata:Record<string,unknown>,signal?:AbortSignal,timeoutMs=EXPORT_STORAGE_TIMEOUT_MS):Promise<void>{
 const contentType=String(metadata.contentType||'application/octet-stream');
 if(!/^(application\/(json|pdf|octet-stream)|text\/csv(?:; charset=utf-8)?)$/.test(contentType))throw new Error('Export content type is invalid.');
 const controller=new AbortController();
 const abort=()=>controller.abort(signal?.reason instanceof Error?signal.reason:Object.assign(new Error('Export upload cancelled.'),{name:'AbortError'}));
 if(signal?.aborted){abort();throw controller.signal.reason;}
 signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>controller.abort(storageTimeout('Export upload timed out.')),timeoutMs);
 try{
  const url=new URL(`/upload/storage/v1/b/${encodeURIComponent(file.bucket.name)}/o`,file.storage.apiEndpoint);
  url.searchParams.set('uploadType','multipart');url.searchParams.set('name',file.name);url.searchParams.set('ifGenerationMatch','0');
  const headers=new Headers(await beforeAbort(file.storage.authClient.getRequestHeaders(url.toString()),controller.signal));
  controller.signal.throwIfAborted();
  const boundary=`valopay-${randomUUID()}`;
  const properties={...metadata,contentType,name:file.name,md5Hash:createHash('md5').update(bytes).digest('base64')};
  const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(properties)}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  headers.set('Content-Type',`multipart/related; boundary=${boundary}`);
  const response=await globalThis.fetch(url,{method:'POST',headers,body,signal:controller.signal,redirect:'error'});
  await response.body?.cancel();
  if(!response.ok)throw storageFailure(response.status,'saved');
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
}
/** Why a stored file is not the export it should be: its ownership, generation or checksum metadata does not match,
 * which no retry changes, so it is never deleted. A bounded reason, never a storage response, path or credential. */
export const EXPORT_IDENTITY_MISMATCHES=['ownership_mismatch','generation_invalid','artifact_metadata_invalid','checksum_mismatch'] as const;
export type ExportIdentityMismatch=typeof EXPORT_IDENTITY_MISMATCHES[number];
const identityMismatch=(mismatch:ExportIdentityMismatch,message:string)=>Object.assign(new Error(message),{mismatch});
/** The mismatch a deletion was refused for; none for storage, network, a timeout or the delete's generation race, which a retry can clear. */
export function exportIdentityMismatch(error:unknown):ExportIdentityMismatch|undefined{
 const mismatch=error instanceof Error?(error as {mismatch?:unknown}).mismatch:undefined;
 return EXPORT_IDENTITY_MISMATCHES.find(reason=>reason===mismatch);
}
/** Delete only the observed generation of this lender's immutable export.
 * A timed-out/lost acknowledgement is retried by reading metadata first. */
export async function deleteRetainedExport(file:File,expected:{id:string;merchantId:string;checksum?:string}):Promise<'deleted'|'already_absent'>{
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
 try{
  let metadata:Record<string,any>;
  try{metadata=await readExportMetadata(file,controller.signal,8000);}catch(error){if((error as any).statusCode===404)return 'already_absent';throw error;}
  const custom=metadata.metadata||{};
  if(custom.valopayExportId!==expected.id||custom.valopayMerchantId!==expected.merchantId)throw identityMismatch('ownership_mismatch','Export ownership could not be verified.');
  if(!/^\d+$/.test(String(metadata.generation)))throw identityMismatch('generation_invalid','Export generation could not be verified.');
  if(expected.checksum){let artifact;try{artifact=JSON.parse(String(custom.valopayArtifact));}catch{throw identityMismatch('artifact_metadata_invalid','Export artifact metadata is invalid.');}if(artifact?.checksum!==expected.checksum)throw identityMismatch('checksum_mismatch','Export checksum metadata changed.');}
  const url=new URL(`/storage/v1/b/${encodeURIComponent(file.bucket.name)}/o/${encodeURIComponent(file.name)}`,file.storage.apiEndpoint);
  url.searchParams.set('ifGenerationMatch',String(metadata.generation));
  const headers=await beforeAbort(file.storage.authClient.getRequestHeaders(url.toString()),controller.signal);
  const response=await globalThis.fetch(url,{method:'DELETE',headers,signal:controller.signal,redirect:'error'});
  await response.body?.cancel();
  if(response.status===404)return 'already_absent';
  if(!response.ok)throw new Error('The export generation could not be deleted.');
  return 'deleted';
 }finally{clearTimeout(timer);controller.abort();}
}
