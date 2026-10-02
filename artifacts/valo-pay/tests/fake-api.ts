import { saveImportBatch, commitImportBatch, coordinateCase, batchView } from '../../api-server/src/domain/pilot-workflow';
import { listImportCorrections, previewImportCorrection, proposeImportCorrection, decideImportCorrection, reassignImportCorrection, assertNoDirectImportedCorrection } from '../../api-server/src/domain/import-corrections';
import { importCorrectionsResponseSchema, importCorrectionPreviewSchema, importCorrectionViewSchema, accessReadinessSchema, caseDetailSchema, closeReviewListSchema, connectedActionResultSchema, connectedViewSchema, importBatchDetailSchema, importBatchListSchema, lifecycleRunViewSchema, lifecycleViewSchema, operationListSchema, paystackFixtureResultSchema, pendingOperationsSchema, pilotJourneySchema, pilotProgressSchema, providerEventViewSchema, sourcesViewSchema, staffDirectorySchema, valopayRecordSchema, type LifecycleExternalCandidate } from '@workspace/valopay-schema';
import { saveSourceProfile, sourceQuality } from '../../api-server/src/domain/source-quality';
import { saveSourceManifest } from '../../api-server/src/domain/source-completeness';
import { providerEventView, replayProviderEvent, runPaystackFixture } from '../../api-server/src/providers/paystack-inbox';
import { pilotProgress, closeReviewHistory, closeReviewDetail, prepareCloseReview, decideCloseReview, reassignCloseReview, bindCloseReviewBasis, reviewIsCurrent } from '../../api-server/src/domain/close-review';
import { closeReviewHistorySchema, closeReviewDetailSchema, closeReviewHistoryQuerySchema, reassignCloseReviewSchema } from '@workspace/valopay-schema';
import { derivePersonalWork, recordWorkReceipt } from '../../api-server/src/domain/personal-work';
import { lifecycleView, lifecycleRunView, saveLifecyclePolicy, setLifecycleHold, lifecyclePreview, approveLifecycleRun } from '../../api-server/src/domain/lifecycle';
import { executeApprovedRun } from '../../api-server/src/domain/lifecycle-run';
import { sourceProfileInputSchema, paystackFixtureInputSchema, providerReplayInputSchema, prepareCloseReviewSchema, decideCloseReviewSchema, personalWorkQuerySchema, personalWorkViewSchema, workReceiptInputSchema, workReceiptSchema, ERROR_DETAIL_LIMIT, MONEY_REFUSAL_MESSAGE, MoneyArithmeticError } from '@workspace/valopay-schema';
import { advanceRecordVersions, mergeData } from '../../api-server/src/lib/edit-versions';
import { pageCustomerHistory } from '../../api-server/src/lib/customer-history';
import { connectedView, connectedActionSchema, runConnectedAction } from '../../api-server/src/domain/connected';
import { pageReconciliation, pageCloseHistory } from '../../api-server/src/lib/console-read-models';
// An in-memory Valo Pay API for the console tests: the real domain code (seed,
// validation, actions, reconciliation, reports, paging) behind the console's
// routes, with every response validated by the same zod contract the server
// uses, so a page is tested against what the API actually returns.  No
// database and no network.  What the server owns and this stands in for: the
// sandbox cookie and locks, the audit hash chain (built here by the server's
// entry builder over the whole state) and object storage (exports get a
// descriptor and a record, no file).
import { randomUUID } from "node:crypto";
import * as S from "@workspace/api-zod";
import { ZodError, type ZodTypeAny, type z } from "zod";
import {
  ABSOLUTE_TICKET_FLOOR_KOBO, authorisationModes, closeTimeOf, defaultStatus, executionWindow, exportPermitted, handBackOwners, isCloseTime,
  nextCloseInstant, recordKinds, roles, sensitiveExportRefusal,
} from "@workspace/valopay-schema";
import { allocationPayer, amendDueItem, customerTimeline, executeAction, makeRecord, rescheduleAfterSettings, validateRecord } from "../../api-server/src/domain";
import { enrolEligibleFailures } from "../../api-server/src/domain/policy-engine";
import type { Context, DomainState, TypedRecord, ValopayRecord } from "../../api-server/src/domain/types";
import { seedMerchant } from "../../api-server/src/lib/valopay-seed";
import { getGates } from "../../api-server/src/lib/valopay-readiness";
import { allocatableOnly, allocationChoices, pageRecords } from "../../api-server/src/lib/valopay-list";
import { pageQueue } from '../../api-server/src/lib/valopay-queues';
import { importCsv, withRowIdColumn } from "../../api-server/src/lib/valopay-import";
import { exportJobView, publicExportRecord, queueExport, retryExport } from '../../api-server/src/lib/export-jobs';
import { connectedActionDone, recordTypeName, recordTypesName, withAuditName } from '../../api-server/src/lib/action-names';
import { LENDER_NOT_FOUND, UNKNOWN_DEMO_ROLE, notFound, onlyRoles } from '../../api-server/src/lib/refusal-words';
import { buildConsoleOverview, buildConsoleReports, buildConsoleSettings } from "../../api-server/src/lib/valopay-close-views";
import type { CloseRuntime } from "../../api-server/src/domain/effective-close-schedule";
import { auditEntryData, canonicalDigest, verifyAuditChain, walkAuditChain } from "../../api-server/src/lib/digests";

export interface FakeCall { method: string; path: string; query: Record<string, string>; body: unknown; status: number }
export interface FakeApi {
  /** Lender ids in the order the workspace lists them. */
  merchantIds: string[];
  /** The persona every request runs as; set_role changes it like the server does. */
  role: string;
  /** One browser person remains the same when demo personas switch. Tests may set a second synthetic person explicitly. */
  principalId: string;
  /** Staff colleagues the lender's assignee lists name after the demo personas (none by default), and the one requests
   * run as instead of the persona of `role`, when a test sets it. */
  staff: Array<{ actor: string; name: string; role: string }>;
  actor?: string;
  /** The instant every request sees, fixed at install unless setNow is called. */
  now: string;
  scheduler: CloseRuntime;
  calls: FakeCall[];
  /** The current state of a lender (the first by default); mutations replace it, so read it fresh. */
  state(merchantId?: string): DomainState;
  /** Applies a change as a committed mutation with an audit entry, the way a request would. */
  mutate<T>(fn: (state: DomainState, ctx: Context) => T, merchantId?: string): T;
  /** The terminal request payloads and export files the server's storage inventory would list for retention (none by default). */
  lifecycleExternal: LifecycleExternalCandidate[];
  /** How long one retention execute request keeps starting sources: 0, the default, removes one source a request, so a test sees the console carry a run on; the server allows 2 s. */
  lifecycleStepBudgetMs: number;
  setNow(iso: string): void;
  /** Makes the next request whose path (and method, when given) matches fail: with an API-style error body and status, or as a network failure ("offline"). */
  failNext(pattern: RegExp, failure: { status: number; error: string; details?: Array<{ field: string; message: string }>; headers?: Record<string, string> } | "offline", method?: string): void;
  /** Holds every request whose path matches until the returned function is called, so a loading or busy state can be seen. */
  hold(pattern: RegExp): () => void;
  uninstall(): void;
}

const kinds = new Set<string>(recordKinds);
const packKinds = ["dispute-pack", "customer-pack"];
const exportKinds = ["gate-pack", "billing", "reviewed-close", ...packKinds];
/** A declared function returning never, so a check such as `if (!old) fail(...)` narrows the way the server's does. */
function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }

function appendAudit(state: DomainState, ctx: Context, action: string, objectId: string, summary: string, changes?: unknown): ValopayRecord {
  const chain = state.records.filter((record) => record.kind === "audit").sort((a, b) => Number(a.data.sequence || 0) - Number(b.data.sequence || 0));
  const data = auditEntryData({ sequence: chain.length + 1, actor: ctx.actor, action, objectId, summary, changes, previousHash: chain.at(-1)?.data.hash, timestamp: ctx.now });
  const record: ValopayRecord = { id: randomUUID(), merchantId: state.merchant.id, kind: "audit", name: action, status: "recorded", reference: "", amountKobo: 0, customerId: state.records.find((item) => item.id === objectId)?.customerId || "", createdAt: ctx.now, updatedAt: ctx.now, data };
  state.records.push(record);
  return record;
}
function verifyAudit(state: DomainState): { valid: boolean; count: number; headHash: string } {
  return verifyAuditChain(state.records.filter((record) => record.kind === "audit"));
}
/** The overview's audit check, with the last entry it verified, from which its alert names the entry that breaks the chain. */
function overviewAudit(state: DomainState) {
  const { valid, count, headHash, verified } = walkAuditChain(state.records.filter((record) => record.kind === "audit"));
  return { valid, count, headHash, verifiedSequence: verified.sequence };
}

/** An answer checked against the schema the server checks it with; one that does not match is the service's failure (500), as it is on the server. */
function contract<S extends ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail(`The fake API's answer does not match its contract: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`, 500);
  return parsed.data;
}

/** Mirrors the server's error handler: a money refusal's 422 and code, zod details (at most 20, with how many there were), a status carried by the error, or the permission wording that maps to 403. */
function toHttpError(error: unknown): { status: number; body: unknown } {
  if (error instanceof MoneyArithmeticError) return { status: 422, body: { error: MONEY_REFUSAL_MESSAGE, code: error.code } };
  if (error instanceof ZodError) return { status: 400, body: { error: "Validation failed.", details: error.issues.slice(0, ERROR_DETAIL_LIMIT).map((issue) => ({ field: issue.path.join("."), message: issue.message })), detailCount: error.issues.length } };
  const message = error instanceof Error ? error.message : String(error);
  const carried = (error as { status?: number } | null)?.status;
  const status = carried || (/not permitted|requires.*role|only.*admin|read-only|disabled|gate|instruction mode/i.test(message) ? 403 : 400);
  return { status, body: { error: message || "This request was refused." } };
}

type Handler = (params: Record<string, string>, query: Record<string, string>, body: any) => unknown;

export function installFakeApi(options: { now?: string; role?: string; queuedExports?: boolean } = {}): FakeApi {
  // One captured instant: separately reading the clock can make a simulated
  // service success newer than the failure a test arranges at api.now.
  const now = options.now ?? new Date().toISOString();
  const states = new Map<string, DomainState>();
  const failures: Array<{ pattern: RegExp; method?: string; failure: { status: number; error: string; details?: Array<{ field: string; message: string }>; headers?: Record<string, string> } | "offline" }> = [];
  const holds: Array<{ pattern: RegExp; promise: Promise<void> }> = [];
  const api: FakeApi = {
    merchantIds: [], role: options.role ?? "Admin", principalId: 'synthetic-console-person-1', staff: [], now, calls: [],
    scheduler: { state: 'running', intervalMs: 60_000, lastTickAt: now, lastSuccessAt: now, lastErrorAt: null },
    state(merchantId) { const id = merchantId ?? api.merchantIds[0]!; return states.get(id) ?? fail(LENDER_NOT_FOUND, 404); },
    mutate(fn, merchantId) { return withState(merchantId ?? api.merchantIds[0]!, fn, { action: "test.mutation", objectId: "workspace", summary: "Arranged by a console test" }); },
    lifecycleExternal: [],
    lifecycleStepBudgetMs: 0,
    setNow(iso) { api.now = iso; if (api.scheduler.state === 'running') { api.scheduler.lastTickAt = iso; api.scheduler.lastSuccessAt = iso; } },
    failNext(pattern, failure, method) { failures.push({ pattern, failure, method: method?.toUpperCase() }); },
    hold(pattern) {
      let release = (): void => { /* replaced by the promise's resolver */ };
      const entry = { pattern, promise: new Promise<void>((resolve) => { release = resolve; }) };
      holds.push(entry);
      return () => { holds.splice(holds.indexOf(entry), 1); release(); };
    },
    uninstall() { globalThis.fetch = originalFetch; },
  };
  const context = (): Context => ({ actor: api.actor ?? `Sandbox ${api.role}`, role: api.role, now: api.now, principalId: api.principalId });

  // Two lenders, as the repository seeds a workspace, each with its first close cursor.
  for (const smaller of [false, true]) {
    const state = seedMerchant(randomUUID(), smaller);
    state.settings.anonymousWorkspace = true;
    state.settings.nextCloseAt = nextCloseInstant(api.now, closeTimeOf(state.settings));
    appendAudit(state, { actor: "System · sandbox seed", role: "Admin", now: api.now }, "sandbox.created", "workspace", "Created a sample lender. Sample data only.");
    states.set(state.merchant.id, state);
  }
  api.merchantIds = [...states.keys()].sort();

  /** A request-shaped mutation: work on a copy, and only a completed operation replaces the lender's state (the server rolls back otherwise). */
  function withState<T>(merchantId: string, fn: (state: DomainState, ctx: Context) => T, audit?: { action: string; objectId: string; summary: string }): T {
    const current = states.get(merchantId) ?? fail(LENDER_NOT_FOUND, 404);
    const ctx = context();
    if (!audit) return fn(current, ctx);
    const draft = structuredClone(current);
    const before = canonicalDigest(draft);
    const result = fn(draft, ctx);
    commit(merchantId, current, draft, ctx, before, audit);
    return result;
  }
  /** withState for an operation that waits on something outside the lender, as a retention run's external deletions do: the state is replaced only once it finishes. */
  async function withStateAsync<T>(merchantId: string, fn: (state: DomainState, ctx: Context) => Promise<T>, audit: { action: string; objectId: string; summary: string }): Promise<T> {
    const current = states.get(merchantId) ?? fail(LENDER_NOT_FOUND, 404);
    const ctx = context(), draft = structuredClone(current), before = canonicalDigest(draft);
    const result = await fn(draft, ctx);
    commit(merchantId, current, draft, ctx, before, audit);
    return result;
  }
  function commit(merchantId: string, current: DomainState, draft: DomainState, ctx: Context, before: string, audit: { action: string; objectId: string; summary: string }): void {
    enrolEligibleFailures(draft, ctx);
    for (const close of draft.records.filter(r => r.kind === 'closes' && !current.records.some(old => old.id === r.id))) bindCloseReviewBasis(draft, close);
    advanceRecordVersions(current, draft, ctx.now);
    appendAudit(draft, ctx, audit.action, audit.objectId, audit.summary, { beforeDigest: before, afterDigest: canonicalDigest(draft) });
    states.set(merchantId, draft);
  }
  const merchantOf = (query: Record<string, string>) => S.GetOverviewQueryParams.parse(query).merchantId;

  const roster = () => [...roles.filter(role => role !== 'Read-only').map(role => ({ actor: 'Sandbox ' + role, name: 'Sandbox ' + role, role })), ...api.staff];
  const pilotWrite = (q: Record<string,string>, fn: (s: DomainState,c: Context)=>ValopayRecord) => withState(merchantOf(q), (state,ctx) => { const before=structuredClone(state); const result=fn(state,ctx); advanceRecordVersions(before,state,ctx.now); return contract(valopayRecordSchema, result); }, { action:'pilot.change',objectId:'workspace',summary:'Synthetic pilot workflow' });
  const routes: Array<[string, RegExp, Handler]> = [
    ['GET', /^\/v1\/team$/, () => contract(staffDirectorySchema, {mode:'sandbox', actor:context().actor, members:[], lenders:[], invitations:[], changes:[], events:[], message:'Team member accounts are not switched on here. Demo roles are for practice only.'})],
    ['GET', /^\/v1\/team\/readiness$/, () => contract(accessReadinessSchema, {syntheticOnly:true,canCommission:false,checkedAt:api.now,checks:[{id:'identity',name:'Team member sign-in',state:'not_configured',detail:'Not set up. The Valo Pay team sets up sign-in and the first Admin for a pilot.'},{id:'mfa',name:'Two-step verification',state:'not_configured',detail:'Demo roles do not check a team member or two-step verification.'},{id:'origin',name:'Allowed web addresses',state:'not_configured',detail:'Team members can make changes only from the address set up for the pilot.'},{id:'database',name:'Restricted database access',state:'not_configured',detail:'Not set up. The Valo Pay team sets up restricted database access for a pilot.'},{id:'encryption',name:'Data encryption',state:'not_configured',detail:'Not set up. The Valo Pay team sets up an encryption key. No key is stored on this page.'}]})],
    ['GET', /^\/v1\/operations$/, () => contract(operationListSchema, {items:[],total:0,offset:0})],
    ['GET', /^\/v1\/operations\/pending$/, () => contract(pendingOperationsSchema, {pending:0})],
    ['GET', /^\/v1\/pilot\/journey$/, (_p,q) => {const s=api.state(merchantOf(q)),count=(kind:string,statuses?:string[])=>s.records.filter(r=>r.kind===kind&&(!statuses||statuses.includes(r.status))).length,open=s.records.filter(r=>r.kind==='exceptions'&&!['closed','resolved'].includes(r.status));return contract(pilotJourneySchema,{lender:s.merchant,accessMode:'sandbox',actor:context().actor,syntheticOnly:true,counts:{customers:count('customers'),batches:count('import-batches',['committed']),receipts:count('payments'),openCases:open.length,unassignedCases:open.filter(r=>!r.data.case?.assignee).length,closes:count('closes'),exports:count('exports',['ready'])}});}],
    ['GET', /^\/v1\/pilot\/import-corrections$/, (_p,q) => importCorrectionsResponseSchema.parse({...listImportCorrections(api.state(merchantOf(q)),context(),q.batchId!),reviewers:roster().filter(p=>p.role==='Finance')} )],
    ['POST', /^\/v1\/pilot\/import-corrections\/preview$/, (_p,q,b) => importCorrectionPreviewSchema.parse(previewImportCorrection(api.state(merchantOf(q)),context(),b))],
    ['POST', /^\/v1\/pilot\/import-corrections$/, (_p,q,b) => withState(merchantOf(q),(s,c)=>importCorrectionViewSchema.parse(proposeImportCorrection(s,c,b,roster())),{action:'import.correction.propose',objectId:'imports',summary:'Propose an imported record correction'})],
    ['POST', /^\/v1\/pilot\/import-corrections\/(?<id>[^/]+)\/decision$/, (p,q,b) => withState(merchantOf(q),(s,c)=>importCorrectionViewSchema.parse(decideImportCorrection(s,c,p.id!,b,roster())),{action:'import.correction.decide',objectId:p.id!,summary:'Record independent correction decision'})],
    ['POST', /^\/v1\/pilot\/import-corrections\/(?<id>[^/]+)\/recovery$/, (p,q,b) => withState(merchantOf(q),(s,c)=>importCorrectionViewSchema.parse(reassignImportCorrection(s,c,p.id!,b,roster())),{action:'import.correction.reassign',objectId:p.id!,summary:'Reassign correction reviewer without approving'})],
    ['GET', /^\/v1\/pilot\/progress$/, (_p,q) => contract(pilotProgressSchema, pilotProgress(api.state(merchantOf(q)),'sandbox'))],
    ['GET', /^\/v1\/pilot\/close-reviews$/, (_p,q) => contract(closeReviewHistorySchema, closeReviewHistory(api.state(merchantOf(q)), closeReviewHistoryQuerySchema.parse(q)))],
    ['GET', /^\/v1\/pilot\/close-reviews\/(?<id>[^/]+)$/, (p,q) => contract(closeReviewDetailSchema, {...closeReviewDetail(api.state(merchantOf(q)),p.id!),actor:context().actor,reviewers:roster().filter(person=>person.role==='Finance'),accessMode:'sandbox',ownPrincipal:api.principalId})],
    ['POST', /^\/v1\/pilot\/close-reviews\/prepare$/, (_p,q,b) => pilotWrite(q,(s,c)=>prepareCloseReview(s,c,prepareCloseReviewSchema.parse(b),roster()))],
    ['POST', /^\/v1\/pilot\/close-reviews\/(?<id>[^/]+)\/decision$/, (p,q,b) => pilotWrite(q,(s,c)=>decideCloseReview(s,c,p.id!,decideCloseReviewSchema.parse(b)))],
    ['POST', /^\/v1\/pilot\/close-reviews\/(?<id>[^/]+)\/reassign$/, (p,q,b) => pilotWrite(q,(s,c)=>reassignCloseReview(s,c,p.id!,reassignCloseReviewSchema.parse(b),roster()))],
    ['GET', /^\/v1\/sources$/, (_p,q) => {const s=api.state(merchantOf(q)), events=s.records.filter(r=>r.kind==='provider-events').sort((a,b)=>b.createdAt.localeCompare(a.createdAt));return contract(sourcesViewSchema, {...sourceQuality(s,api.now,q.businessDate||undefined),paystack:{mode:'test_only',externalConnectionVerified:false,canRunFixtures:['Admin','Operations','Finance'].includes(api.role),state:'configuration_required',message:'An external test needs a Paystack account, test keys and a connection set up by the Valo Pay team. Practice messages on this page do not check a real Paystack connection.',events:events.slice(0,50).map(providerEventView),total:events.length,quarantined:events.filter(e=>e.status==='quarantined').length,duplicates:events.reduce((sum,e)=>sum+Math.max(0,Number(e.data.deliveryCount||0)-1),0)}});}],
    ['POST', /^\/v1\/sources\/manifests$/, (_p,q,b) => pilotWrite(q,(s,c)=>saveSourceManifest(s,c,b as any))],
    ['POST', /^\/v1\/sources\/profiles$/, (_p,q,b) => pilotWrite(q,(s,c)=>saveSourceProfile(s,c,sourceProfileInputSchema.parse(b)))],
    ['POST', /^\/v1\/sources\/profiles\/(?<id>[^/]+)\/save$/, (p,q,b) => pilotWrite(q,(s,c)=>saveSourceProfile(s,c,sourceProfileInputSchema.parse(b),p.id))],
    ['POST', /^\/v1\/sources\/paystack\/fixtures$/, (_p,q,b) => withState(merchantOf(q),(s,c)=>{const result=runPaystackFixture(s,c,paystackFixtureInputSchema.parse(b).scenario);return contract(paystackFixtureResultSchema, {...result,event:providerEventView(result.event)});},{action:'source.fixture',objectId:'sources',summary:'Explicit synthetic Paystack rehearsal'})],
    ['POST', /^\/v1\/sources\/events\/(?<id>[^/]+)\/replay$/, (p,q,b) => withState(merchantOf(q),(s,c)=>{const input=providerReplayInputSchema.parse(b);return contract(providerEventViewSchema, providerEventView(replayProviderEvent(s,c,p.id!,input.expectedUpdatedAt,input.reason)));},{action:'source.replay',objectId:p.id!,summary:'Recheck saved provider evidence'})],
    ['GET', /^\/v1\/work$/, (_p,q) => personalWorkViewSchema.parse(derivePersonalWork(api.state(merchantOf(q)),context(),roster(),personalWorkQuerySchema.parse(q)))],
    ['POST', /^\/v1\/work\/notifications\/read$/, (_p,q,b) => withState(merchantOf(q),(s,c)=>workReceiptSchema.parse(recordWorkReceipt(s,c,roster(),'read',workReceiptInputSchema.parse(b))),{action:'work.read',objectId:'work',summary:'Read in-app notification'})],
    ['POST', /^\/v1\/work\/handovers\/acknowledge$/, (_p,q,b) => withState(merchantOf(q),(s,c)=>workReceiptSchema.parse(recordWorkReceipt(s,c,roster(),'acknowledge',workReceiptInputSchema.parse(b))),{action:'work.acknowledge',objectId:'work',summary:'Acknowledge case handover'})],
    ['GET', /^\/v1\/lifecycle$/, (_p,q) => contract(lifecycleViewSchema, lifecycleView(api.state(merchantOf(q)),context(),api.lifecycleExternal,Number(q.offset||0)))],
    ['GET', /^\/v1\/lifecycle\/runs\/(?<id>[^/]+)$/, (p,q) => {if(api.role!=='Admin')fail(onlyRoles(['Admin'],'view data retention',undefined),403);const s=api.state(merchantOf(q)),r=s.records.find(r=>r.kind==='retention-runs'&&r.id===p.id);if(!r)fail('Deletion run not found. It may belong to another lender.',404);return contract(lifecycleRunViewSchema, lifecycleRunView(s,r));}],
    ['POST', /^\/v1\/lifecycle\/policy$/, (_p,q,b) => withState(merchantOf(q),(s,c)=>{saveLifecyclePolicy(s,c,b);return lifecycleView(s,c,api.lifecycleExternal);},{action:'retention.policy',objectId:'retention',summary:'Save synthetic retention policy'})],
    ['POST', /^\/v1\/lifecycle\/holds$/, (_p,q,b) => withState(merchantOf(q),(s,c)=>{setLifecycleHold(s,c,b,api.lifecycleExternal);return lifecycleView(s,c,api.lifecycleExternal);},{action:'retention.hold',objectId:'retention',summary:'Change preservation hold'})],
    ['POST', /^\/v1\/lifecycle\/runs$/, (_p,q,b) => withState(merchantOf(q),(s,c)=>lifecyclePreview(s,c,b,api.lifecycleExternal),{action:'retention.preview',objectId:'retention',summary:'Save bounded deletion preview'})],
    ['POST', /^\/v1\/lifecycle\/runs\/(?<id>[^/]+)\/approve$/, (p,q,b) => withState(merchantOf(q),(s,c)=>approveLifecycleRun(s,c,p.id!,b,api.lifecycleExternal),{action:'retention.approve',objectId:p.id!,summary:'Approve exact retention preview'})],
    ['POST', /^\/v1\/lifecycle\/runs\/(?<id>[^/]+)\/execute$/, (p,q,b) => withStateAsync(merchantOf(q),async(s,c)=>{if(c.role!=='Admin')fail(onlyRoles(['Admin'],'carry out a deletion run',c.accessMode),403);const run=s.records.find(r=>r.kind==='retention-runs'&&r.id===p.id);if(!run||run.data.previewDigest!==b.previewDigest)fail('This deletion run changed after you opened it. Reload the page and try again.',409);
      // No journal or private storage here: a request payload is simply gone, and an export file is marked deleted on its record.
      const remove=async(candidate:{kind:string;sourceId:string}):Promise<'deleted'|'already_absent'>=>{if(candidate.kind!=='export_file')return 'deleted';const file=s.records.find(r=>r.kind==='exports'&&r.id===candidate.sourceId);if(!file)return 'already_absent';file.data.fileDeletedAt=c.now;file.data.fileRetentionRunId=run.id;return 'deleted';};
      return executeApprovedRun(s,c,run.id,api.lifecycleExternal,remove,{budgetMs:api.lifecycleStepBudgetMs});},{action:'retention.execute',objectId:p.id!,summary:'Execute approved synthetic retention run'})],
    ['GET', /^\/v1\/pilot\/batches$/, (_p,q)=>{const all=api.state(merchantOf(q)).records.filter(r=>r.kind==='import-batches');return contract(importBatchListSchema, {items:all.slice(Number(q.offset||0),Number(q.offset||0)+25).map(r=>batchView(r)),total:all.length,offset:Number(q.offset||0)});}],
    ['GET', /^\/v1\/pilot\/batches\/(?<id>[^/]+)$/, (p,q)=>{const s=api.state(merchantOf(q)), batch=s.records.find(r=>r.kind==='import-batches'&&r.id===p.id);if(!batch)fail(notFound('Import batch'),404);if(!['Admin','Operations','Finance'].includes(api.role))fail(onlyRoles(['Admin','Operations','Finance'],'open the rows of an import batch',undefined),403);return contract(importBatchDetailSchema, {batch,revisions:s.records.filter(r=>r.kind==='import-revisions'&&r.data.batchId===p.id)});}],
    ['POST', /^\/v1\/pilot\/batches$/, (_p,q,b)=>pilotWrite(q,(s,c)=>saveImportBatch(s,c,b))],
    ['POST', /^\/v1\/pilot\/batches\/(?<id>[^/]+)\/save$/, (p,q,b)=>pilotWrite(q,(s,c)=>saveImportBatch(s,c,b,p.id))],
    ['POST', /^\/v1\/pilot\/batches\/(?<id>[^/]+)\/commit$/, (p,q,b)=>pilotWrite(q,(s,c)=>commitImportBatch(s,c,p.id!,b.expectedUpdatedAt))],
    ['GET', /^\/v1\/pilot\/cases\/(?<id>[^/]+)$/, (p,q)=>{const s=api.state(merchantOf(q)),record=s.records.find(r=>r.kind==='exceptions'&&r.id===p.id);if(!record)fail(notFound('Exception'),404);return contract(caseDetailSchema, {record,assignees:roster(),events:s.records.filter(r=>r.kind==='case-events'&&r.data.exceptionId===p.id),evidence:s.records.filter(r=>r.kind==='payments').map(r=>({id:r.id,name:r.name,reference:r.reference,kind:r.kind}))});}],
    ['POST', /^\/v1\/pilot\/cases\/(?<id>[^/]+)$/, (p,q,b)=>pilotWrite(q,(s,c)=>coordinateCase(s,c,p.id!,b,roster()))],
    ['GET', /^\/v1\/customers\/(?<id>[^/]+)\/history$/, (params,query)=>{const parsed=S.GetCustomerHistoryQueryParams.parse(query);return S.GetCustomerHistoryResponse.parse(withState(parsed.merchantId,state=>{const history=pageCustomerHistory(state,params.id!,parsed);return {...history,events:history.events.map(withAuditName),...(history.focusedRecord?{focusedRecord:withAuditName(history.focusedRecord)}:{})};}));}],
    ['GET', /^\/v1\/reconciliation\/(?<queue>[^/]+)$/, (params,query)=>{
      const {queue:name}=S.ListReconciliationParams.parse(params), parsed=S.ListReconciliationQueryParams.parse(query);
      return S.ListReconciliationResponse.parse(withState(parsed.merchantId,(state,ctx)=>pageReconciliation(state,name,parsed,ctx.now)));
    }],
    ['GET', /^\/v1\/close-history$/, (_p,query)=>{const parsed=S.ListCloseHistoryQueryParams.parse(query);return S.ListCloseHistoryResponse.parse(pageCloseHistory(api.state(parsed.merchantId).records,parsed));}],
    ['GET', /^\/v1\/close-history\/(?<id>[^/]+)$/, (params,query)=>{const row=api.state(merchantOf(query)).records.find(r=>r.kind==='closes' && r.id===params.id);if(!row) fail(notFound('Daily close'),404);return S.GetCloseDetailResponse.parse(row);}],
    ['GET', /^\/v1\/queues\/(?<queue>[^/]+)$/, (params, query) => {
      const { queue: name } = S.ListQueueParams.parse(params), filters = S.ListQueueQueryParams.parse(query);
      return S.ListQueueResponse.parse(withState(filters.merchantId, (state, ctx) => pageQueue(state.records, name, filters, ctx.now)));
    }],
    ["GET", /^\/v1\/workspace$/, () => S.GetWorkspaceResponse.parse({
      name: "Valo Pay", environment: "sandbox", actor: context().actor, role: api.role, authenticated: false,
      merchants: api.merchantIds.map((id) => states.get(id)!.merchant), roles: [...roles], productionEnabled: false, accessMode: "sandbox",
    })],
    ['GET', /^\/v1\/connected$/, (_p,query)=>withState(merchantOf(query),(state,ctx)=>contract(connectedViewSchema, connectedView(state,ctx)))],
    ['POST', /^\/v1\/connected\/actions$/, (_p,query,raw)=>{const input=connectedActionSchema.parse(raw);return withState(merchantOf(query),(state,ctx)=>contract(connectedActionResultSchema, {message:`${connectedActionDone(input.action)}. Sample data only.`,record:runConnectedAction(state,ctx,input),mode:'synthetic',externalInstructionPerformed:false}),{action:input.action,objectId:input.recordId||'connected-workspace',summary:input.reason});}],
    ["GET", /^\/v1\/overview$/, (_p, query) => S.GetOverviewResponse.parse(withState(merchantOf(query), (state, ctx) => buildConsoleOverview(state, ctx.now, overviewAudit(state), api.scheduler)))],
    ["GET", /^\/v1\/records\/(?<kind>[^/]+)$/, (params, query) => {
      if (!kinds.has(params.kind!)) fail("Unknown resource.", 404);
      const parsed = S.ListRecordsQueryParams.parse(query);
      allocatableOnly(params.kind!, parsed);
      return S.ListRecordsResponse.parse(withState(parsed.merchantId, (state) => {
        // One payment's allocation choices (paymentId) as the server's list reads them: the payer rule of its manual allocation.
        const payment = parsed.paymentId === undefined ? undefined : state.records.find((record) => record.kind === "payments" && record.id === parsed.paymentId) ?? fail("Payment not found. Reload the payments and choose one again.", 404);
        const named = payment && !payment.customerId && payment.data.dueItemId ? state.records.find((record) => record.kind === "due-items" && record.id === payment.data.dueItemId)?.customerId : undefined;
        const query = payment ? allocationChoices(parsed, allocationPayer(payment, named)) : parsed;
        const page = query ? pageRecords(state.records.filter((record) => record.kind === params.kind), query, params.kind) : { items: [], total: 0 };
        return { ...page, items: page.items.map((record) => record.kind === "exports" ? publicExportRecord(record) : withAuditName(record)) };
      }));
    }],
    ["POST", /^\/v1\/records\/(?<kind>[^/]+)$/, (params, query, raw) => {
      const kind = params.kind!;
      if (!kinds.has(kind)) fail("Unknown resource.", 404);
      const body = S.CreateRecordBody.parse(raw);
      return S.CreateRecordResponse.parse(withState(merchantOf(query), (state, ctx) => {
        const input = { ...body, status: body.status || defaultStatus[kind as keyof typeof defaultStatus] || "draft", data: { ...body.data, synthetic: true } as Record<string, any>, createdAt: ctx.now, updatedAt: ctx.now };
        if (["policies", "templates"].includes(kind)) { input.data.author = ctx.actor; input.data.version = 1; }
        if (kind === "due-items") input.data.outstandingKobo = body.amountKobo;
        if (kind === "attempts") { input.data.source = "external"; input.data.simulated = true; }
        validateRecord(state, ctx, kind, input);
        if (body.reference && state.records.some((record) => record.kind === kind && record.reference === body.reference && kind !== "observations")) fail("This reference is already used. Enter a different reference.", 409);
        return makeRecord(state, kind, input);
      }, { action: `post.records.${kind}`, objectId: "workspace", summary: "Change to sample data." }));
    }],
    ["PATCH", /^\/v1\/records\/(?<kind>[^/]+)\/(?<id>[^/]+)$/, (params, query, raw) => {
      const kind = params.kind!;
      if (!kinds.has(kind)) fail("Unknown resource.", 404);
      const body = S.UpdateRecordBody.parse(raw);
      return S.UpdateRecordResponse.parse(withState(merchantOf(query), (state, ctx) => {
        const old = state.records.find((record) => record.kind === kind && record.id === params.id);
        if (!old) fail(notFound(recordTypeName(kind)), 404);
        const {expectedUpdatedAt:_expected,...changes}=body;
        const input = { ...old, ...changes, data: { ...mergeData(old.data, body.data), synthetic: true } as Record<string, any>, updatedAt: ctx.now };
        assertNoDirectImportedCorrection(old,input);
        if (kind === "due-items") return amendDueItem(state, ctx, old as TypedRecord<"due-items">, input as TypedRecord<"due-items">);
        validateRecord(state, ctx, kind, input, true);
        Object.assign(old, input);
        return old;
      }, { action: `patch.records.${kind}.${params.id}`, objectId: params.id!, summary: "Change to sample data." }));
    }],
    ["POST", /^\/v1\/actions$/, (_p, query, raw) => {
      const body = S.PerformActionBody.parse(raw);
      const merchantId = merchantOf(query);
      if (body.action === "set_role") {
        const role = String(body.data?.role);
        if (!(roles as readonly string[]).includes(role)) fail(UNKNOWN_DEMO_ROLE);
        return S.PerformActionResponse.parse(withState(merchantId, () => { api.role = role; return { message: `Demo role changed to ${role}. It gives no access to real data or live payments.`, data: { role } }; }, { action: "set_role", objectId: "workspace", summary: body.reason || "Change to sample data." }));
      }
      if (body.action === "verify_audit") return S.PerformActionResponse.parse(withState(merchantId, (state) => ({ message: "Audit log check complete.", data: verifyAudit(state) }), { action: "verify_audit", objectId: "workspace", summary: body.reason || "Change to sample data." }));
      if (body.action === "mark_pack_used") fail("A dispute pack made from sample data cannot be recorded as used in a real case.", 403);
      return S.PerformActionResponse.parse(withState(merchantId, (state, ctx) => executeAction(state, ctx, body), { action: body.action, objectId: body.recordId || "workspace", summary: body.reason || "Change to sample data." }));
    }],
    ["POST", /^\/v1\/imports$/, (_p, query, raw) => {
      const body = S.ImportRecordsBody.parse(withRowIdColumn(raw));
      return S.ImportRecordsResponse.parse(withState(merchantOf(query), (state, ctx) => importCsv(state, ctx, body), body.commit ? { action: 'post.imports', objectId: 'workspace', summary: 'Synthetic CSV import' } : undefined));
    }],
    ["GET", /^\/v1\/customers\/(?<id>[^/]+)\/timeline$/, (params, query) => S.GetCustomerTimelineResponse.parse(withState(merchantOf(query), (state) => { const timeline = customerTimeline(state, params.id!); return { ...timeline, events: timeline.events.map(withAuditName) }; }))],
    ["GET", /^\/v1\/reports$/, (_p, query) => S.GetReportsResponse.parse(withState(merchantOf(query), (state, ctx) => ({...buildConsoleReports(state, ctx.now, api.scheduler), ...(query.includeCloses === 'false' ? {closes:[]} : {})})))],
    ["GET", /^\/v1\/gates$/, (_p, query) => S.GetGatesResponse.parse(withState(merchantOf(query), (state) => getGates(state)))],
    ["GET", /^\/v1\/settings$/, (_p, query) => S.GetSettingsResponse.parse(withState(merchantOf(query), (state, ctx) => buildConsoleSettings(state, ctx.role, ctx.now, api.scheduler)))],
    ["PATCH", /^\/v1\/settings$/, (_p, query, raw) => {
      const body = S.UpdateSettingsBody.parse(raw);
      return S.UpdateSettingsResponse.parse(withState(merchantOf(query), (state, ctx) => {
        if (ctx.role !== "Admin") fail(onlyRoles(["Admin"], "change lender settings", ctx.accessMode), 403);
        const start = body.executionStart ?? state.settings.executionStart ?? executionWindow.defaultStartHour, end = body.executionEnd ?? state.settings.executionEnd ?? executionWindow.defaultEndHour;
        if (start < executionWindow.earliestHour || end > executionWindow.latestHour || start >= end) fail(`Set the collection window between ${String(executionWindow.earliestHour).padStart(2, "0")}:00 and ${String(executionWindow.latestHour).padStart(2, "0")}:00 WAT, with the start before the end.`);
        if (body.minimumTicketKobo !== undefined && body.minimumTicketKobo < ABSOLUTE_TICKET_FLOOR_KOBO) fail("The minimum debit is ₦5,000.00. This limit cannot be overridden.");
        if (body.defaultOwner && !(handBackOwners as readonly string[]).includes(body.defaultOwner)) fail("Choose the loan management system, the lender team or the provider. Valo Pay can own collection only after a collection transfer for live use.");
        if (body.authorisationMode && !(authorisationModes as readonly string[]).includes(body.authorisationMode)) fail("Choose Daily approval or Standing approval.");
        for (const key of ["unallocatedAlertThreshold", "notificationCostAlertKobo"] as const) if (body[key] !== undefined && (!Number.isInteger(body[key]) || Number(body[key]) < 0)) fail(`${key} must be a whole number of zero or more.`);
        if (body.closeTime !== undefined && !isCloseTime(body.closeTime)) fail("closeTime must use HH:MM in West Africa Time, for example 07:00.");
        const previous = { time: closeTimeOf(state.settings), enabled: state.settings.scheduledCloseEnabled !== false };
        // The version the edit names is not a preference, as the API keeps it out of the saved settings.
        const { expectedRevision: _revision, ...preferences } = body;
        Object.assign(state.settings, preferences);
        rescheduleAfterSettings(state, previous, ctx.now);
        return buildConsoleSettings(state, ctx.role, ctx.now, api.scheduler);
      }, { action: "patch.settings", objectId: "workspace", summary: "Change to sample data." }));
    }],
    ["POST", /^\/v1\/exports$/, (_p, query, raw) => {
      const body = S.CreateExportBody.parse(raw);
      if (!kinds.has(body.kind) && !exportKinds.includes(body.kind)) fail("Choose what to export from the list.");
      if (packKinds.includes(body.kind) && !body.customerId) fail("Choose a customer for the dispute pack.");
      const merchantId = merchantOf(query);
      return S.CreateExportResponse.parse(withState(merchantId, (state, ctx) => {
        if(options.queuedExports)return queueExport(state,ctx,body,'/private/test');
        // export_sensitive, as queueExport checks it.
        if (!exportPermitted(ctx.role, body.kind)) fail(sensitiveExportRefusal, 403);
        if (body.customerId && !state.records.some((record) => record.kind === "customers" && record.id === body.customerId)) fail(notFound("Customer"), 404);
        const review = body.kind === 'reviewed-close' ? state.records.find(r=>r.kind==='close-reviews'&&r.id===(body as any).closeReviewId) : undefined;
        if(body.kind==='reviewed-close'&&(!review||review.status!=='approved'||!reviewIsCurrent(state,review)))fail('An approved, current close review is required.',409);
        const checksum = canonicalDigest({ kind: body.kind, format: body.format, customerId: body.customerId ?? null, at: ctx.now, records: state.records.length });
        const record = makeRecord(state, "exports", { name: `${recordTypesName(body.kind)} (${body.format.toUpperCase()})`, status: "ready", customerId: body.customerId ?? "", createdAt: ctx.now, data: { kind: body.kind, format: body.format, checksum, usedInRealCase: false, byteLength: 0, generationMs: 0, synthetic: true,...(review?{closeReviewId:review.id,closeSnapshotDigest:review.data.snapshotDigest}:{}) } });
        return { id: record.id, downloadUrl: `/api/v1/exports/${record.id}/download?merchantId=${merchantId}`, checksum, generatedAt: ctx.now };
      }, { action: "post.exports", objectId: "workspace", summary: "Change to sample data." }));
    }],
    ["GET", /^\/v1\/exports\/(?<id>[^/]+)$/, ({id}, query) => {
      const record=states.get(merchantOf(query))!.records.find(record=>record.kind==='exports'&&record.id===id);
      if(!record)fail(notFound('Export'),404);
      return S.GetExportJobResponse.parse(exportJobView(record));
    }],
    ["POST", /^\/v1\/exports\/(?<id>[^/]+)\/retry$/, ({id}, query) => S.RetryExportJobResponse.parse(withState(merchantOf(query),(state,ctx)=>retryExport(state,ctx,id),{action:'export.retry',objectId:id,summary:'Retry saved export'}))],
    ["GET", /^\/v1\/openapi\.json$/, () => ({ openapi: "3.1.0", info: { title: "Api", version: "1.0.0" }, paths: {} })],
  ];

  let failureCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, "http://localhost");
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    const query = Object.fromEntries(url.searchParams.entries());
    const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined;
    const path = url.pathname.startsWith("/api") ? url.pathname.slice(4) : url.pathname;
    for (const entry of holds.filter((held) => held.pattern.test(path))) await entry.promise;
    // A planned failure stands in for the server refusing or the network dropping the request.
    const planned = failures.findIndex((entry) => entry.pattern.test(path) && (!entry.method || entry.method === method));
    if (planned >= 0) {
      const { failure } = failures.splice(planned, 1)[0]!;
      if (failure === "offline") { api.calls.push({ method, path, query, body, status: 0 }); throw new TypeError("Failed to fetch"); }
      api.calls.push({ method, path, query, body, status: failure.status });
      // As the API does: the request id in the body and on the answer, so the console can quote it.
      const requestId = `fake-${(++failureCount).toString(16).padStart(4, "0")}`;
      return new Response(JSON.stringify({ error: failure.error, ...(failure.details ? { details: failure.details } : {}), requestId }), { status: failure.status, headers: { "content-type": "application/json", "x-request-id": requestId, ...failure.headers } });
    }
    let status = 200, payload: unknown;
    try {
      if (!url.pathname.startsWith("/api")) fail("Not found.", 404);
      const route = routes.find(([verb, pattern]) => verb === method && pattern.test(path));
      if (!route) fail(path.startsWith("/v1/webhooks/") ? "Disabled until a provider-specific signed adapter is configured." : "Unknown resource.", path.startsWith("/v1/webhooks/") ? 403 : 404);
      payload = await route[2](path.match(route[1])?.groups ?? {}, query, body);
    } catch (error) {
      ({ status, body: payload } = toHttpError(error));
    }
    api.calls.push({ method, path, query, body, status });
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  return api;
}
