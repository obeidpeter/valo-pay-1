import { historySections, historyKind, positionNote, type CustomerHistoryQuery, type HistorySection } from './customer-history';
import { pool, Pool, poolSize, type PoolClient } from "@workspace/db";
import * as tables from "@workspace/db/schema";
import { getTableConfig } from "drizzle-orm/pg-core";
import { getAuth, clerkClient } from "@clerk/express";
import { signedInUser, staffMode, verifyStaff } from './staff-access';
import { validateLenderAccessChange } from './staff-lender-access';
import { bindRuntimeIdentity, bindRuntimeService, clearRuntimeInviteeGrants, runtimeIsolationConfiguration, runtimeIsolationEnabled, runtimeServiceRead } from './runtime-isolation';
import type { StaffLenderAccessInput } from '@workspace/valopay-schema';
import type { VerifiedClerkSession } from './pilot-access';
import { randomBytes, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { approvalRoles, closeTimeOf, definitiveRefusalStatuses, grantNeedsApproval, invitationAcceptedSchema, nextCloseInstant, sameJson, observationEventKey, sumMoney } from "@workspace/valopay-schema";
import { databaseMoney } from './database-money';
import { sha256Hex, canonicalDigest, requestFingerprint, auditEntryData, verifyAuditChain, walkAuditChain, chainSequence, AUDIT_GENESIS, type AuditPoint } from "./digests";
import { recordChanged, nextRecordVersion } from "./edit-versions";
import { contractAnswer } from './contract';
import type { Context, DomainState, ValopayRecord } from "../domain/types";
import { recordsOf } from "../domain/records";
import { watDate } from "../domain/calendar";
import type { AuditVerification } from "../domain/alerts";
import { nextCloseRetry, type CloseRetry } from "../domain/close";
import { seedMerchant } from "./valopay-seed";
import { createSandboxCreationLimits, creationRefusalMessage, WORKSPACE_CREATION_RETRY_AFTER_SECONDS } from "./creation-limit";
import { readSandboxCookie, sandboxPrincipal, secureRequest, writeSandboxCookie } from "./sandbox-cookie";
import { rememberSandbox } from "./request-limits";
import { allocatableOnly, allocationChoices, EXPIRED_EXPORT_STATUS, foldForSearch, listLimit, LIST_PAGE_CEILING, matchesSearch, updatedSinceInstant, type ListQuery } from "./valopay-list";
import { allocationPayer, exceptionCurrency } from "../domain/reconciliation";
import { publicExportRecord } from "./export-jobs";
import { queueView, queueViews, type QueueName, type QueueQuery } from './valopay-queues';
import { validateCloseRange, pageOffset, type ReadPageQuery, type ReconciliationQueue } from './console-read-models';
import { precisionAudit } from '../domain/reports';
import { periodBounds, previousMonth } from '../domain/billing';
import { allocationClosedStatuses, measurementRules } from '@workspace/valopay-schema';
import { protectStored, revealStored, protectRecordData, revealRecordsData, payloadEncryptionKey, isProtectedPayload, PROTECTED_IMPORT_FIELDS, type ProtectedImportField } from './protected-payloads';
import { markRolledBack } from './transaction-outcome';
import { markOperationClosed, markOperationState, type OperationState } from './refused-operations';
import { summariseRequest } from './operation-summary';
import { beginStatement, checkOut, databaseLimits, failedTransaction, DatabaseLimitError, type Checkout } from './database-limits';
import { createLenderGate } from './lender-gate';
import { assertImportedCorrectionChange } from '../domain/import-corrections';
import type { LifecycleExternalCandidate, LifecycleCandidate } from '@workspace/valopay-schema';
import { lifecycleRunView, journalPayloadRule, type JournalWindow } from '../domain/lifecycle';
import { executeApprovedRun } from '../domain/lifecycle-run';
import { deleteRetainedExport } from './export-download';
import { objectStorageClient } from './objectStorage';
import { assertProviderEventChange } from '../providers/paystack-inbox';
import { exceptionDecisionChanged, exceptionReviewSubjectChanged } from '../domain/exception-integrity';
import { financialProjectionSchema, syncFinancialProjection } from './financial-projection';

/** The demo persona roles, the same list as the shared schema's. */
export const roles = ["Admin", "Operations", "Finance", "Compliance reviewer", "Read-only"];
/** SHA-256 of a string, as hex. */
export const digest = sha256Hex;

type WorkspaceRow = { id: string; principal_hash: string; role: string };
/**
 * The lender as a write transaction loaded it, one JSON string per record.
 * A save serialises the lender once more and compares strings: whatever is
 * identical is untouched, so checks, versions, audit digests and writes look
 * only at what the request changed.
 */
type StateSnapshot = { merchant: string; settings: string; records: Map<string, string> };
const snapshotOf = (state: DomainState): StateSnapshot => ({
  merchant: JSON.stringify(state.merchant), settings: JSON.stringify(state.settings),
  records: new Map(state.records.map((record) => [record.id, JSON.stringify(record)])),
});
/**
 * One JSON pass: the records added or changed since the lender was loaded,
 * and the IDs left untouched. Only a record whose JSON differs is compared in
 * canonical form (recordChanged), so a reordering of keys is not a change.
 */
function changesSince(snapshot: StateSnapshot, state: DomainState): { changed: ValopayRecord[]; unchanged: Set<string> } {
  const changed: ValopayRecord[] = [], unchanged = new Set<string>();
  for (const record of state.records) {
    const loaded = snapshot.records.get(record.id);
    if (loaded !== undefined && !recordChanged(loaded, record)) unchanged.add(record.id);
    else changed.push(record);
  }
  return { changed, unchanged };
}
/** Every changed stored record gets a strictly newer version, even when two actions share a millisecond. */
function advanceChanged(snapshot: StateSnapshot, changed: ValopayRecord[], now: string): void {
  for (const record of changed) {
    const original = snapshot.records.get(record.id);
    if (original === undefined) continue;
    record.updatedAt = nextRecordVersion(record, (JSON.parse(original) as ValopayRecord).updatedAt, now);
  }
}
type MerchantRow = { id: string; info: DomainState["merchant"]; settings: Record<string, any> };
type RecordRow = {
  id: string; merchant_id: string; kind: string; name: string; status: string; reference: string;
  amount_kobo: string | number; customer_id: string; data: Record<string, any>; created_at: Date; updated_at: Date;
};
type Session = {
  client: PoolClient; workspace: WorkspaceRow; principal: string; active: boolean;
  access: WorkspaceAccess;
  lockedMerchantId?: string; snapshot?: StateSnapshot; summarised?: Set<string>;
  owner?: string; operationId?: string; userId?: string; organizationId?: string;
  /** This transaction passed the restricted-database self-check (runtime isolation). */
  isolationVerified?: boolean;
  /** A read on one REPEATABLE READ snapshot, read only once its identity checks passed: it takes no lender lock (inWorkspace). */
  snapshotRead?: boolean;
  /** Where the loaded lender's audit chain stands, as its write found it (loadState); appendAudit continues from it. */
  auditChain?: AuditChain;
  /** That check of the chain, which a daily close lists among its alerts (writeAuditCheck). */
  auditCheck?: AuditVerification;
};

/**
 * This is an opaque transaction capability.  Its database handle and locked
 * merchant are deliberately private to this module; a route cannot construct a
 * useful context or issue an unscoped query.
 */
export interface StoreContext extends Context {
  readonly authenticated: boolean;
  readonly accessMode?: 'sandbox' | 'staff';
}
const sessions = new WeakMap<StoreContext, Session>();
const requestOperations = new WeakMap<Request, { id: string; merchantId: string; created: boolean }>();
/** Binds a request to its journal entry; `created` says this attempt created the entry (prepareOperation). */
export function bindOperation(req: Request, id: string, merchantId: string, created = false) { requestOperations.set(req, { id, merchantId, created }); }
/** The journal entry the recovery middleware bound to this request, if any. */
export function boundOperation(req: Request) { return requestOperations.get(req); }
const databaseConflictCodes = new Set(["23503", "23505", "23514", "P0001"]);
/**
 * Connection fairness, per tenant and per lender: one tenant's requests for
 * its lenders hold at most a third of this process's connections, and those
 * for one of its lenders at most half of that (at least one each), so neither
 * a busy lender nor a busy sandbox with its own lenders can take the pool from
 * everyone else. A request past either share waits, without a connection, for
 * up to the lock limit in all.
 */
export const tenantConnections = Math.max(1, Math.floor(poolSize / 3));
export const lenderConnections = Math.max(1, Math.ceil(tenantConnections / 2));
const tenantGate = createLenderGate({ capacity: tenantConnections, waitMs: () => databaseLimits().request.lockMs });
const lenderGate = createLenderGate({ capacity: lenderConnections, waitMs: () => databaseLimits().request.lockMs });
/**
 * The gate lanes of the lender a request names: every lender-scoped route
 * carries it as the merchantId query value. The value is read before anything
 * is authorised, so the lanes are the caller's own (the staff organisation, or
 * the sandbox principal) and its lender's: a caller that names another
 * tenant's lender only queues behind its own requests, never that tenant's.
 */
function gatedLanes(req: Request, principal: string): { tenant: string; lender: string } | undefined {
  const lender = (req.query as Record<string, unknown> | undefined)?.merchantId;
  if (typeof lender !== "string" || lender.length < 1 || lender.length > 100) return undefined;
  const caller = staffMode() ? `org:${getAuth(req).orgId || ""}` : `principal:${principal}`;
  return { tenant: caller, lender: `${caller}\u0000${lender}` };
}
/** Enters a request's lender lane, then its tenant's, within one wait: a request waiting for its tenant holds no other lender's place. */
async function enterGate(lanes: { tenant: string; lender: string }, write: boolean): Promise<() => void> {
  const deadline = Date.now() + databaseLimits().request.lockMs;
  const leaveLender = await lenderGate.enter(lanes.lender, write);
  try {
    const leaveTenant = await tenantGate.enter(lanes.tenant, write, Math.max(1, deadline - Date.now()));
    return () => { leaveTenant(); leaveLender(); };
  } catch (error) { leaveLender(); throw error; }
}

/** Throws an error carrying the HTTP status the error handler answers with (400 unless given). */
export function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}
const conflict = (message = "Operation conflicts with the current lender state."): never => fail(message, 409);
/** Anonymous sandboxes expire after this many days without a change; the cookie carries the same lifetime. */
export const ANONYMOUS_WORKSPACE_DAYS = 30;
/** Lenders a sandbox workspace can hold, the two samples included, so one visitor cannot fill the scheduler's queue. */
export const SANDBOX_LENDER_LIMIT = 5;
/** How many expired sandboxes one bootstrap removes, so a request never pays for a large backlog. */
const SWEEP_BATCH = 5;
/** Automatic deletion is opt-in so importing the application cannot remove existing workspaces. */
export const expiredWorkspaceCleanupEnabled = (value: string | undefined) => value === "on";
/** Actor prefix for platform-initiated changes (the seed, the scheduled close); the expiry sweep does not count them as sandbox activity. */
export const SYSTEM_ACTOR_PREFIX = "System · ";
/** A UTC ISO instant as the platform writes it; guards the timestamptz cast on the stored close cursor. */
const ISO_INSTANT_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$";
const sandboxCreation = createSandboxCreationLimits();

export interface StoredRequest { method: 'POST' | 'PATCH'; path: string; body: unknown; }
type OperationRow = { id: string; merchant_id: string; owner: string; actor: string; role: string; request_key: string; request_hash: string; request: StoredRequest; label: string; status: string; receipt: any; created_at: Date; updated_at: Date };
// An entry's request is the keyed write as it was sent, up to the 2 MB body limit, and an entry an earlier build
// completed keeps its whole answer as its receipt. Only what needs them selects them (a retry, the payload protection
// batch, a retention run an earlier build prepared): every other read of the journal names the columns it uses, so
// none parses or digests a body, and none costs more because a lender's entries hold large ones, but for the
// operations list, which opens its page of requests in the database for their summaries' few fields.
/** Whether retention purged an entry's payload, read without opening its request: the purge leaves a marker of about
 * 100 bytes in its place, so only a request that small is opened to look for it. */
const PURGED_REQUEST = "CASE WHEN pg_column_size(request)>1024 THEN false ELSE request ? 'purged' END";
/** A body field the operations summary reads, by jsonb operators: a string of 1 to 100 characters, else nothing. */
const shortField = (field: string) => `CASE WHEN jsonb_typeof(q#>'{body,${field}}')='string' AND length(q#>>'{body,${field}}') BETWEEN 1 AND 100 THEN q#>>'{body,${field}}' END`;
/** What Operations lists of an entry: its identity and outcome and, by jsonb operators, the refusal a cancelled request
 * was given, the saved record's ID and kind, and the facts its summary is made from (summariseRequest): the request's
 * method and path and a few short body fields, read only from a request stored as JSON, never a sealed or purged one.
 * The body itself is never selected, so a lender whose entries hold large bodies costs one page of them, opened in
 * the database, and the API parses none. The record the body names, and the one the answer names, are looked up for
 * their kind alone. */
const OPERATION_LIST = `SELECT o.id,o.label,o.actor,o.role,o.status,o.created_at,o.updated_at,o.receipt->'rejected' AS rejected,
    o.receipt->'record'->'id' AS record_id,o.receipt->'record'->'kind' AS record_kind,o.receipt->'id' AS receipt_id,o.receipt->'kind' AS receipt_kind,
    (SELECT r.kind FROM valopay_records r WHERE r.id=o.receipt->>'id' AND r.merchant_id=o.merchant_id) AS answered_kind,
    f.method,f.path,f.action,f.decision,f.status AS body_status,f.kind,f.format,f.target,(SELECT r.kind FROM valopay_records r WHERE r.id=f.target AND r.merchant_id=o.merchant_id) AS target_kind
  FROM (SELECT id,merchant_id,label,actor,role,status,created_at,updated_at,receipt,request FROM valopay_operations
    WHERE merchant_id=$1 AND owner=$2 ORDER BY created_at DESC,id DESC LIMIT 25 OFFSET $3) o
  LEFT JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(q->'method')='string' AND length(q->>'method')<=10 THEN q->>'method' END AS method,
      CASE WHEN jsonb_typeof(q->'path')='string' AND length(q->>'path')<=1000 THEN q->>'path' END AS path,
      ${shortField('action')} AS action,${shortField('decision')} AS decision,${shortField('status')} AS status,${shortField('kind')} AS kind,${shortField('format')} AS format,
      COALESCE(${['recordId', 'targetId', 'closeId', 'batchId'].map(shortField).join(',')}) AS target
    FROM (SELECT o.request || '{}'::jsonb AS q OFFSET 0) opened WHERE NOT (q ? 'protectedPayload' OR q ? 'purged')) f ON true
  ORDER BY o.created_at DESC,o.id DESC`;
type OperationListRow = Pick<OperationRow, 'id' | 'label' | 'actor' | 'role' | 'status' | 'created_at' | 'updated_at'> & { rejected: any; record_id: unknown; record_kind: unknown; receipt_id: unknown; receipt_kind: unknown; answered_kind: string | null }
  & { method: string | null; path: string | null; action: string | null; decision: string | null; body_status: string | null; kind: string | null; format: string | null; target: string | null; target_kind: string | null };
const operationView = (row: OperationListRow) => {
  const described = summariseRequest({ method: row.method, path: row.path, action: row.action, decision: row.decision, status: row.body_status, kind: row.kind, format: row.format, target: row.target, targetKind: row.target_kind });
  const record = textOrNull(row.record_id), answered = textOrNull(row.receipt_id);
  return { id: row.id, label: row.label, actor: row.actor, role: row.role, status: row.status,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    message: row.status === 'completed' ? 'The service saved this request.'
      : row.status === 'cancelled' ? (row.rejected ? `The service refused this request: ${row.rejected.message} Correct it and submit it again.` : 'Cancelled before completion. This request cannot run again.')
      : 'Completion has not been confirmed. Check the original request.',
    // Only a compact result reference. Original payloads and export locations stay private. The saved record's kind is
    // the lender's record's, else the answer's own, else its route's: an export's answer named the kind it exports
    // before the journal recorded the export itself, a sealed request names no route, and some answers name no kind.
    recordId: record ?? answered,
    recordKind: record ? textOrNull(row.record_kind) : !answered ? null
      : textOrNull(row.answered_kind) ?? (described?.resultOverrides ? described.resultKind : textOrNull(row.receipt_kind) ?? described?.resultKind ?? null),
    summary: described?.summary ?? null };
};
/** A receipt field as the journal names it: text, or null for anything else (a sealed receipt, a count, nothing). */
function textOrNull(value: unknown): string | null { return typeof value === 'string' && value ? value : null; }

/** The lock of one journal entry: the attempt running its request holds it for its whole transaction (holdOperation). */
const OPERATION_LOCK = "hashtextextended('valopay.operation:' || $1, 0)";
/**
 * The journal entry of a keyed request: the one its key already has, or a new
 * pending one. An existing entry is read without the lender's lock, so a repeat
 * of a saved or running request is never turned away by a busy lender before
 * it can be answered for its key. A new entry is made under a lock of the
 * person's own in that lender, so the pending limit holds and a duplicate sent
 * at the same moment binds the same entry (the entry's reference to the lender
 * still waits for a write holding the lender). `created` says whether this
 * attempt made the entry: only that attempt, or a definitive refusal, may close
 * it (rejectOperation). `unused` is told, just before a new entry is made, that
 * nothing is saved under the key (no entry and no stored answer), so a failure
 * that follows may say nothing was saved.
 */
export async function prepareOperation(ctx: StoreContext, merchantId: string, key: string, request: StoredRequest, unused?: () => void): Promise<{ id: string; created: boolean }> {
  const session = sessionFor(ctx); await readMerchant(ctx, merchantId, 'none');
  const owner = session.owner || session.principal, id = digest(`operation:${merchantId}:${owner}:${key}`);
  const hash = requestFingerprint(request);
  const existing = async () => {
    // A cancelled entry's receipt holds the refusal its answer repeats; no other part of the entry is read.
    const prior = (await session.client.query<PriorEntry>("SELECT id,actor,role,status,request_hash,CASE WHEN status='cancelled' THEN receipt END AS receipt FROM valopay_operations WHERE id=$1 AND merchant_id=$2 AND owner=$3", [id, merchantId, owner])).rows[0];
    if (!prior) return undefined;
    // A cancelled entry is final (completeOperation refuses it), whatever the role now: the answer says so, and the
    // person who sent it hears the original reason.
    if (prior.status === 'cancelled') throw markOperationClosed(Object.assign(new Error(await cancelledRefusal(ctx, merchantId, prior)), { status: 409 }));
    if (prior.request_hash !== hash) fail('This request key belongs to a different request. Recover the original request first.', 409);
    if (prior.actor !== ctx.actor || prior.role !== ctx.role) fail('Return to the original role before checking this request.', 403);
    return { id: prior.id, created: false };
  };
  const found = await existing();
  if (found) return found;
  await session.client.query("SELECT pg_advisory_xact_lock(hashtextextended('valopay.operations:' || $1 || ':' || $2, 0))", [merchantId, owner]);
  // Another attempt with the key may have created the entry while this one waited.
  const raced = await existing();
  if (raced) return raced;
  if (!(await receiptStored(session.client, merchantId, key, id))) unused?.();
  if (ctx.role === 'Read-only') fail('Your read-only role cannot submit operations.', 403);
  const count = Number((await session.client.query<{ count: string }>("SELECT count(*) FROM valopay_operations WHERE merchant_id=$1 AND owner=$2 AND status='pending'", [merchantId, owner])).rows[0]!.count);
  if (count >= 100) fail('Review your pending operations before submitting more requests.', 409);
  const label = request.path.includes('/actions') && request.body && typeof request.body === 'object'
    ? String((request.body as { action?: unknown }).action || 'Workspace action').replaceAll('_', ' ').slice(0, 100)
    : `${request.method === 'PATCH' ? 'Update' : 'Save'} ${request.path.split('/').filter(Boolean).slice(1, 3).join(' ').replaceAll('-', ' ')}`;
  await session.client.query(`INSERT INTO valopay_operations(id,merchant_id,owner,actor,role,request_key,request_hash,request,label,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`, [id, merchantId, owner, ctx.actor, ctx.role, key, hash, await protectStored(request,{lender:merchantId,record:id,field:'request'}), label, ctx.now]);
  return { id, created: true };
}
/**
 * A journaled write holds its entry, before it waits for the lender, until its
 * transaction ends. A repeat of the request meanwhile (a double submission, a
 * retry after a lost answer) is turned away at once as still running (503 with
 * Retry-After) and leaves the entry to the attempt running it: it neither waits
 * for that attempt nor closes the entry when its own wait fails.
 */
async function holdOperation(session: Session): Promise<void> {
  const held = (await session.client.query<{ held: boolean }>(`SELECT pg_try_advisory_xact_lock(${OPERATION_LOCK}) AS held`, [session.operationId])).rows[0]?.held;
  if (!held) throw markRolledBack(new DatabaseLimitError('operation_running'));
}
/** Why a cancelled request cannot run again, in the words of its original refusal when the same person and role
 * ask and it was refused outright. The receipt may be absent (cancelled from Operations), expired under retention,
 * unreadable or a failure that saved nothing ("try again" would mislead here), so a general sentence stands in. */
type PriorEntry = Pick<OperationRow, 'id' | 'actor' | 'role' | 'status' | 'request_hash' | 'receipt'>;
async function cancelledRefusal(ctx: StoreContext, merchantId: string, prior: PriorEntry): Promise<string> {
  let reason: unknown;
  if (prior.actor === ctx.actor && prior.role === ctx.role) {
    try {
      const rejected = (await revealStored(prior.receipt, { lender: merchantId, record: prior.id, field: 'receipt' }))?.rejected;
      if ((definitiveRefusalStatuses as readonly unknown[]).includes(rejected?.status)) reason = rejected.message;
    } catch { reason = undefined; }
  }
  return typeof reason === 'string' && reason.trim()
    ? `The service refused this request and saved nothing: ${reason.trim()} It cannot run again; review the latest records and submit a new request.`
    : 'This request was cancelled before it completed and saved nothing. It cannot run again; review the latest records and submit a new request.';
}
// The journal is read without the lender's lock: a busy lender never holds up Operations, a retry or a cancel's checks.
export async function listOperations(ctx: StoreContext, merchantId: string, offset = 0) {
  const session = sessionFor(ctx); await readMerchant(ctx, merchantId, 'none');
  const scope = [merchantId, session.owner || session.principal];
  const total = Number((await session.client.query<{ count: string }>('SELECT count(*) FROM valopay_operations WHERE merchant_id=$1 AND owner=$2', scope)).rows[0]!.count);
  const items = (await session.client.query<OperationListRow>(OPERATION_LIST, [...scope, offset])).rows.map(operationView);
  return { items, total, offset };
}
/** How many of the caller's requests in the lender wait for confirmation: the console shows it where a person who
 * reloads sees it. Counted on the journal's pending index; no request is read. */
export async function countPendingOperations(ctx: StoreContext, merchantId: string) {
  const session = sessionFor(ctx); await readMerchant(ctx, merchantId, 'none');
  const pending = Number((await session.client.query<{ count: string }>("SELECT count(*) FROM valopay_operations WHERE merchant_id=$1 AND owner=$2 AND status='pending'", [merchantId, session.owner || session.principal])).rows[0]!.count);
  return { pending };
}
type EntryRow = Pick<OperationRow, 'id' | 'actor' | 'role' | 'status' | 'request_key'> & { purged: boolean; request?: unknown };
/** The caller's own entry in the lender, as its current role may act on it. Its receipt is not read, and its request
 * only to repeat it (`withRequest`). */
async function operationEntry(ctx: StoreContext, merchantId: string, id: string, withRequest = false) {
  const session = sessionFor(ctx); await readMerchant(ctx, merchantId, 'none');
  const row = (await session.client.query<EntryRow>(`SELECT id,actor,role,status,request_key,${PURGED_REQUEST} AS purged${withRequest ? ',request' : ''} FROM valopay_operations WHERE id=$1 AND merchant_id=$2 AND owner=$3`, [id, merchantId, session.owner || session.principal])).rows[0];
  if (!row) fail('Request not found in your lender history.', 404);
  if (row.actor !== ctx.actor || row.role !== ctx.role) fail('This request was submitted under a different role. Your current role cannot repeat it.', 403);
  if(row.purged)fail('This terminal request payload expired under the lender retention policy. Its identity and completion history are retained; it cannot run again.',410);
  return row;
}
/** An entry with its request opened, to repeat it. The receipt is not opened: a retry replays the answer saved for
 * the request. A request that cannot be opened is refused naming the entry's state, so the answer never says nothing
 * was saved for a request that was. */
export async function readOperation(ctx: StoreContext, merchantId: string, id: string) {
  const { purged: _purged, request, ...entry } = await operationEntry(ctx, merchantId, id, true);
  try { return { ...entry, request: await revealStored(request, { lender: merchantId, record: id, field: 'request' }) as StoredRequest }; }
  catch (error) { throw markOperationState(error, entry.status as OperationState); }
}
/**
 * Where a keyed write's answer is kept for its repeats. A journaled request's is
 * kept under its journal entry's own id: the entry holds one person's request
 * on one route, so the same key used on another route, or by a colleague,
 * never answers it or leaves its entry stranded. A write the journal does not
 * record (a demo persona switch) keeps it under its key in a name of its own.
 * `earlier` is where an earlier build kept every answer, under the key alone
 * (with the connected workspace's prefix): it is read, never written, so a
 * request saved before still replays.
 */
export function receiptOf(req: Request, merchantId: string, key: string, kind: 'workspace' | 'connected' | 'persona') {
  const earlier = digest(`${kind === 'connected' ? 'connected:' : ''}${merchantId}:${key}`);
  const entry = requestOperations.get(req)?.id;
  return { id: entry ?? (kind === 'persona' ? digest(`persona:${merchantId}:${key}`) : earlier), earlier };
}
/** Every place a journal entry's answer may be kept: its own id, then the key alone as earlier builds kept it. */
const receiptIds = (merchantId: string, key: string, entryId: string) => [entryId, digest(`${merchantId}:${key}`), digest(`connected:${merchantId}:${key}`)];
/** Whether an answer is stored for this entry's request. An entry that is not completed but has one belongs to a
 * write saved outside the journal, before it existed: that request was saved, so its entry is never cancelled. */
async function receiptStored(client: PoolClient, merchantId: string, key: string, entryId: string): Promise<boolean> {
  return (await client.query('SELECT 1 FROM valopay_idempotency WHERE merchant_id=$1 AND id=ANY($2::text[])', [merchantId, receiptIds(merchantId, key, entryId)])).rows.length > 0;
}
export async function cancelOperation(ctx: StoreContext, merchantId: string, id: string) {
  const session = sessionFor(ctx); await readMerchant(ctx, merchantId, 'update');
  const row = await operationEntry(ctx, merchantId, id);
  if (row.status === 'completed') fail('This request already completed. Refresh Operations to see its saved result.', 409);
  if (await receiptStored(session.client, merchantId, row.request_key, row.id)) fail('A receipt already exists for this request. Check the original request to recover it.', 409);
  await session.client.query("UPDATE valopay_operations SET status='cancelled',updated_at=$4 WHERE id=$1 AND merchant_id=$2 AND owner=$3 AND status='pending'", [id, merchantId, session.owner || session.principal, ctx.now]);
  return { message: 'The server confirmed this request has not completed and cancelled it. It cannot run again.' };
}
/** Resolve only this person's exact key and original role, without returning its private request body. */
export async function lookupOwnOperation(ctx: StoreContext, merchantId: string, input: { key: string; method: 'POST' | 'PATCH'; path: string }) {
  const session = sessionFor(ctx); await readMerchant(ctx, merchantId, 'none');
  const owner = session.owner || session.principal, id = digest(`operation:${merchantId}:${owner}:${input.key}`);
  const query = OPERATION_LIST.replace('WHERE merchant_id=$1 AND owner=$2 ORDER BY created_at DESC,id DESC LIMIT 25 OFFSET $3',
    'WHERE merchant_id=$1 AND owner=$2 AND id=$3 AND actor=$4 AND role=$5');
  const row = (await session.client.query<OperationListRow>(query, [merchantId, owner, id, ctx.actor, ctx.role])).rows[0];
  return { operation: row ? operationView(row) : null };
}
/** Fence a key even when its original request has not arrived yet. Absence alone is never permission to resubmit.
 * The journal-creation lock orders this fence against prepareOperation; the lender lock then waits for any write
 * already running. Both locks last through commit. A delayed request sees the terminal entry and cannot execute. */
export async function cancelOwnOperation(ctx: StoreContext, merchantId: string, input: { key: string; method: 'POST' | 'PATCH'; path: string }) {
  const session = sessionFor(ctx); await readMerchant(ctx, merchantId, 'none');
  if (ctx.role === 'Read-only') fail('Your read-only role cannot cancel operations.', 403);
  const owner = session.owner || session.principal, id = digest(`operation:${merchantId}:${owner}:${input.key}`);
  await session.client.query("SELECT pg_advisory_xact_lock(hashtextextended('valopay.operations:' || $1 || ':' || $2, 0))", [merchantId, owner]);
  await readMerchant(ctx, merchantId, 'update');
  const found = (await session.client.query('SELECT id FROM valopay_operations WHERE id=$1 AND merchant_id=$2 AND owner=$3', [id, merchantId, owner])).rows[0];
  if (found) return cancelOperation(ctx, merchantId, id);
  if (await receiptStored(session.client, merchantId, input.key, id)) fail('A receipt already exists for this request. Check the original request to recover it.', 409);
  const fence = { method: input.method, path: input.path, body: null, cancelledBeforeReceipt: true };
  await session.client.query(`INSERT INTO valopay_operations(id,merchant_id,owner,actor,role,request_key,request_hash,request,label,status,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'Cancelled interrupted submission','cancelled',$9,$9)`,
  [id, merchantId, owner, ctx.actor, ctx.role, input.key, requestFingerprint(fence), await protectStored(fence, { lender: merchantId, record: id, field: 'request' }), ctx.now]);
  return { message: 'The server cancelled this request key. Even if the original request arrives later, it cannot run. You can now prepare a new submission.' };
}
/**
 * After a request bound to a journal entry was refused or failed, closes the
 * entry when it may be closed, and resolves to its state afterwards (undefined
 * when there is no entry). Runs in its own transaction, after the request's own
 * transaction ended. `close` says why it may close: a definitive refusal (a 4xx
 * the same request would receive again, `refused`) closes it whatever else is
 * running, and an attempt already past its checks is then refused at
 * completeOperation; a failure that saved nothing (`unsaved`), of the attempt
 * that created the entry, closes it only while no other attempt holds it
 * (holdOperation), so a repeat's failure never cancels the request its original
 * attempt is still running. A closed entry neither waits for confirmation nor
 * counts towards the pending limit, and its key cannot run again. Without
 * `close`, the state is only read, for the answer to say. An entry an earlier
 * attempt completed stays `completed`; one cancelled meanwhile (by another
 * attempt's refusal, or from Operations) is `cancelled`; an entry held by an
 * attempt running it is `running`. As in cancelOperation, an entry whose
 * request has a stored answer (a write saved before the journal existed) stays
 * pending, and is `completed` for the answer: that request was saved.
 */
export async function rejectOperation(req: Request, bound: { id: string; merchantId: string }, rejection: { status: number; message: string }, close: 'refused' | 'unsaved' | undefined): Promise<OperationState | undefined> {
  const guard = await checkOut(() => pool.connect()), client = guard.client;
  try {
    await client.query(beginStatement(databaseLimits().request));
    if (runtimeIsolationEnabled()) {
      const verified = getAuth(req) as unknown as VerifiedClerkSession;
      await bindRuntimeIdentity(client, { organizationId: verified.orgId || '', userId: verified.userId || '' });
    }
    // Held by this transaction when no attempt is running the request; kept until it ends, so none starts meanwhile.
    const idle = (await client.query<{ held: boolean }>(`SELECT pg_try_advisory_xact_lock(${OPERATION_LOCK}) AS held`, [bound.id])).rows[0]?.held === true;
    // The row lock orders this against an attempt completing the entry: whichever commits first decides.
    const entry = (await client.query<{ status: string; request_key: string }>('SELECT status,request_key FROM valopay_operations WHERE id=$1 AND merchant_id=$2 FOR UPDATE', [bound.id, bound.merchantId])).rows[0];
    let state = entry?.status as OperationState | undefined;
    if (entry?.status === 'pending') {
      if (await receiptStored(client, bound.merchantId, entry.request_key, bound.id)) state = 'completed';
      else if (close === 'refused' || (close === 'unsaved' && idle)) {
        const receipt = await protectStored({ rejected: rejection }, { lender: bound.merchantId, record: bound.id, field: 'receipt' });
        await client.query("UPDATE valopay_operations SET status='cancelled',receipt=$3,updated_at=now() WHERE id=$1 AND merchant_id=$2 AND status='pending'", [bound.id, bound.merchantId, receipt]);
        state = 'cancelled';
      } else if (!idle) state = 'running';
    }
    const committed = await client.query('COMMIT');
    return committed.command === 'COMMIT' ? state : undefined;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* the transaction is already closed */ }
    throw error;
  } finally { guard.release(); }
}
/**
 * What the journal keeps of a completed request's answer: a reference to the
 * record it saved, the only part Operations reads (its "Open saved result"
 * link). The whole answer is stored once in valopay_idempotency, under the
 * request's journal entry (receiptOf), and that copy is what a retried key or
 * a retry from Operations replays. A daily close answers with its whole record, about
 * 100 KB for a pilot-scale lender, and used to be stored in both tables.
 * Entries completed earlier keep their whole answer until retention removes it.
 * The reference names only the saved record's ID and kind, so it is stored
 * unsealed: sealed, Operations could not read it without the key service.
 */
/** A journal receipt that is only such a reference, which is never sealed. */
function isJournalReference(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => key === "record" || key === "id" || key === "kind");
}
export function journalReceipt(response: unknown): { id?: string; kind?: string; record?: { id: string; kind?: string } } {
  const reference = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const { id, kind } = value as { id?: unknown; kind?: unknown };
    return typeof id === "string" ? { id, ...(typeof kind === "string" ? { kind } : {}) } : undefined;
  };
  const record = reference((response as { record?: unknown } | null | undefined)?.record), own = reference(response);
  // An export job's answer names the kind of record it exports: the record it saved is the export.
  const exported = own && typeof (response as { downloadUrl?: unknown }).downloadUrl === "string";
  return { ...(record ? { record } : {}), ...(exported ? { ...own, kind: "exports" } : own) };
}
/** Receipt and domain writes commit together. A process crash cannot leave a
 * completed journal entry without the corresponding business write.
 *
 * A cancelled entry never completes. This guard is what makes cancellation
 * final: an attempt already past its checks when a retry's refusal (or
 * Cancel if unfinished) cancelled its entry is refused here and rolls back,
 * so an answer that says `operation: "cancelled"` proves that nothing sent
 * with the key was saved. Every journaled write must commit through this
 * function for that to hold. */
export async function completeOperation(ctx: StoreContext, receipt: unknown) {
  const session = sessionFor(ctx);
  if (!session.operationId) return;
  const merchantId = boundMerchant(session), owner = session.owner || session.principal;
  const result = await session.client.query(`UPDATE valopay_operations SET status='completed',receipt=$5,updated_at=$6
    WHERE id=$1 AND merchant_id=$2 AND owner=$3 AND actor=$4 AND status<>'cancelled'`, [session.operationId, merchantId, owner, ctx.actor, journalReceipt(receipt), ctx.now]);
  if (rowsAffected(result)) return;
  const current = (await session.client.query<{ status: string }>('SELECT status FROM valopay_operations WHERE id=$1 AND merchant_id=$2 AND owner=$3', [session.operationId, merchantId, owner])).rows[0];
  if (current?.status === 'cancelled') fail('This request was cancelled before it completed. Nothing was saved, and it cannot run again.', 409);
  fail('The recovery request no longer belongs to this session.', 409);
}

type StaffRow = { id: string; workspace_id: string; user_id: string; display_name: string; role: string; status: 'active' | 'suspended' | 'revoked'; expires_at: Date; created_at: Date; updated_at: Date };
const staffProvision = (row: StaffRow, organizationId: string) => ({ id: row.id, userId: row.user_id, organizationId, tenantId: row.workspace_id, role: row.role, status: row.status, validFrom: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString() });
const staffView = (row: StaffRow) => ({ id: row.id, actor: `Clerk:${row.user_id}`, name: row.display_name, role: row.role, status: row.status, expiresAt: row.expires_at.toISOString(), updatedAt: row.updated_at.toISOString() });
export async function caseAssignees(ctx: StoreContext) {
  const session = sessionFor(ctx);
  // A demo persona is named as its changes are recorded (the context's actor), so the lists and the history agree.
  if (ctx.accessMode !== 'staff') return roles.filter(role => role !== 'Read-only').map(role => ({ actor: `Sandbox ${role}`, name: `Sandbox ${role}`, role }));
  if (!session.lockedMerchantId) fail('Select a lender before looking up available assignees.', 409);
  // The same three fields as a demo role: who, their name and their role; the membership's other details stay in the team directory.
  return (await session.client.query<StaffRow>(`SELECT member.* FROM valopay_staff_memberships member
    WHERE member.workspace_id=$1 AND member.status='active' AND member.expires_at>$2 AND member.role<>'Read-only'
      AND (member.role='Admin' OR EXISTS (SELECT 1 FROM valopay_staff_lender_access grant_row WHERE grant_row.membership_id=member.id AND grant_row.merchant_id=$3))
    ORDER BY member.display_name,member.id`, [session.workspace.id, ctx.now, session.lockedMerchantId])).rows.map(row => { const { actor, name, role } = staffView(row); return { actor, name, role }; });
}
/** A membership change that grants one of `approvalRoles`, waiting for a second administrator: its request in the access history. */
type ChangeRequestRow = { id: string; actor: string; subject: string; detail: { before: { role: string; status: string }; after: { role: string; status: string }; reason: string; version: string }; created_at: Date; name: string; member_version: Date };
const changeView = (row: ChangeRequestRow) => ({ id: row.id, memberId: row.subject, name: row.name, from: row.detail.before, to: row.detail.after, reason: row.detail.reason, requestedBy: row.actor, requestedAt: row.created_at.toISOString() });
/** Change requests nobody has approved or declined, with the membership they change as it stands now, newest first. */
const changeRequestsSql = `SELECT request.id,request.actor,request.subject,request.detail,request.created_at,member.display_name AS name,member.updated_at AS member_version
  FROM valopay_staff_events request JOIN valopay_staff_memberships member ON member.id=request.subject AND member.workspace_id=request.workspace_id
  WHERE request.workspace_id=$1 AND request.action='staff.change_requested' AND ($2::text IS NULL OR request.id=$2) AND ($3::text IS NULL OR request.subject=$3)
    AND NOT EXISTS (SELECT 1 FROM valopay_staff_events decision WHERE decision.workspace_id=request.workspace_id AND decision.action IN ('staff.change_approved','staff.change_declined') AND decision.detail->>'requestId'=request.id)
  ORDER BY request.created_at DESC,request.id DESC LIMIT 200`;
/** A request is current while the membership is still the version it was made against; any later change leaves it out of date. */
const currentRequest = (row: ChangeRequestRow) => row.member_version.toISOString() === row.detail.version;
/** The administrator who approved a pending invitation, never the one who sent it; undefined while it waits. */
async function invitationApprover(client: PoolClient, workspaceId: string, invitation: { id: string; invited_by: string }): Promise<string | undefined> {
  return (await client.query<{ actor: string }>("SELECT actor FROM valopay_staff_events WHERE workspace_id=$1 AND subject=$2 AND action='staff.invitation_approved' AND actor<>$3 ORDER BY created_at,id LIMIT 1", [workspaceId, invitation.id, invitation.invited_by])).rows[0]?.actor;
}
const needsApproval = (role: string) => (approvalRoles as readonly string[]).includes(role);
/** What a person refused as their own approver is told: the rule, and how a pilot with one administrator gets a second. */
const secondAdministrator = (what: string, who: string) => `A different administrator must approve this ${what}: the administrator who ${who} cannot approve it. A pilot with one administrator asks the operator to add a second with the provisioning command's --add-administrator mode.`;
export async function staffDirectory(ctx: StoreContext) {
  const session = sessionFor(ctx);
  if (ctx.accessMode !== 'staff') return { mode: 'sandbox', actor: ctx.actor, members: [], lenders: [], invitations: [], changes: [], events: [], message: 'Real staff access is not enabled on this host. Demo roles are for practice only.' };
  const memberRows = (await session.client.query<StaffRow>('SELECT * FROM valopay_staff_memberships WHERE workspace_id=$1 ORDER BY display_name,id', [session.workspace.id])).rows;
  const grants = (await session.client.query<{ membership_id: string; merchant_id: string }>(`SELECT grant_row.membership_id,grant_row.merchant_id FROM valopay_staff_lender_access grant_row JOIN valopay_staff_memberships member ON member.id=grant_row.membership_id JOIN valopay_merchants lender ON lender.id=grant_row.merchant_id WHERE member.workspace_id=$1 AND lender.workspace_id=$1 ORDER BY grant_row.merchant_id`, [session.workspace.id])).rows;
  const lendersOf = (id: string) => grants.filter(grant => grant.membership_id === id).map(grant => grant.merchant_id);
  const admin = ctx.role === 'Admin', own = memberRows.find(row => row.user_id === session.userId), shared = new Set(own ? lendersOf(own.id) : []);
  // An administrator sees everyone. Anyone else sees the colleagues who can open one of their lenders (an administrator opens
  // every lender), only the lenders they share, and no one's expiry but their own.
  const colleague = (row: StaffRow) => row.status === 'active' && row.expires_at.getTime() > Date.parse(ctx.now) && (row.role === 'Admin' ? shared.size > 0 : lendersOf(row.id).some(id => shared.has(id)));
  const members = memberRows.filter(row => admin || row.id === own?.id || colleague(row)).map(row => {
    const whole = admin || row.id === own?.id;
    return { ...staffView(row), expiresAt: whole ? row.expires_at.toISOString() : null, lenderIds: row.role === 'Admin' ? [] : lendersOf(row.id).filter(id => whole || shared.has(id)), allLenders: row.role === 'Admin' };
  });
  if (!admin) return { mode: 'staff', actor: ctx.actor, members, lenders: [], invitations: [], changes: [], events: [], message: 'Verified staff access. Membership, lender access and MFA are checked for every request. You see the colleagues who work on your lenders. Financial records remain synthetic.' };
  const lenders = await listMerchants(ctx);
  // Timestamps as the ISO text the answer carries, as every other view writes them.
  const invitations = (await session.client.query<{ id: string; email: string; role: string; status: string; expiresAt: Date; invitedBy: string; approvedBy: string | null }>(`SELECT invitation.id,invitation.email,invitation.role,invitation.status,invitation.expires_at AS "expiresAt",invitation.invited_by AS "invitedBy",
    (SELECT approval.actor FROM valopay_staff_events approval WHERE approval.workspace_id=invitation.workspace_id AND approval.subject=invitation.id AND approval.action='staff.invitation_approved' AND approval.actor<>invitation.invited_by ORDER BY approval.created_at,approval.id LIMIT 1) AS "approvedBy"
    FROM valopay_staff_invitations invitation WHERE invitation.workspace_id=$1 ORDER BY invitation.created_at DESC LIMIT 100`, [session.workspace.id])).rows
    .map(row => ({ ...row, expiresAt: row.expiresAt.toISOString(), approval: !needsApproval(row.role) ? 'not_required' : row.approvedBy ? 'approved' : 'awaiting' }));
  const changes = (await session.client.query<ChangeRequestRow>(changeRequestsSql, [session.workspace.id, null, null])).rows.filter(currentRequest).slice(0, 100).map(changeView);
  const events = (await session.client.query<{ id: string; actor: string; action: string; subject: string; detail: unknown; createdAt: Date }>('SELECT id,actor,action,subject,detail,created_at AS "createdAt" FROM valopay_staff_events WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100', [session.workspace.id])).rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString() }));
  return { mode: 'staff', actor: ctx.actor, members, lenders, invitations, changes, events, message: 'Verified staff access. Membership, lender access and MFA are checked for every request. Financial records remain synthetic.' };
}
export function viewerScope(ctx: StoreContext) { const session = sessionFor(ctx); return digest(`viewer:${session.workspace.id}:${session.owner || session.principal}`); }
function teamAdmin(ctx: StoreContext) {
  const session = sessionFor(ctx);
  if (ctx.accessMode !== 'staff' || ctx.role !== 'Admin' || session.access !== 'team') fail('A verified pilot administrator with recent MFA is required.', 403);
  return session;
}
async function staffEvent(client: PoolClient, workspaceId: string, actor: string, action: string, subject: string, detail: unknown): Promise<{ id: string; createdAt: Date }> {
  return (await client.query<{ id: string; createdAt: Date }>('INSERT INTO valopay_staff_events(id,workspace_id,actor,action,subject,detail) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,created_at AS "createdAt"', [randomUUID(), workspaceId, actor, action, subject, detail])).rows[0]!;
}
export async function inviteStaff(ctx: StoreContext, email: string, role: string) {
  const session = teamAdmin(ctx);
  const token = randomBytes(32).toString('hex'), id = randomUUID(), approval = needsApproval(role) ? 'awaiting' as const : 'not_required' as const;
  await session.client.query("UPDATE valopay_staff_invitations SET status='revoked' WHERE workspace_id=$1 AND email=$2 AND status='pending'", [session.workspace.id, email]);
  await session.client.query(`INSERT INTO valopay_staff_invitations(id,workspace_id,email,role,token_hash,invited_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)`, [id, session.workspace.id, email, role, digest(token), ctx.actor, new Date(Date.parse(ctx.now) + 7 * 86400000)]);
  await staffEvent(session.client, session.workspace.id, ctx.actor, 'staff.invited', id, { email, role, ...(approval === 'awaiting' ? { approval } : {}) });
  if (approval === 'not_required') return { id, token, approval, message: 'Invitation created. Share the link directly with this person; no email has been sent. It expires in seven days.' };
  const administrators = Number((await session.client.query<{ count: string }>("SELECT count(*) FROM valopay_staff_memberships WHERE workspace_id=$1 AND role='Admin' AND status='active' AND expires_at>$2", [session.workspace.id, ctx.now])).rows[0]!.count);
  return { id, token, approval, message: `Invitation created. It waits for a second administrator's approval before it can be accepted: an Admin, Finance or Compliance reviewer grant needs two administrators, and the one who sent it cannot approve it.${administrators < 2 ? " This pilot has one active administrator: ask the operator to add a second with the provisioning command's --add-administrator mode." : ''} Share the link directly; no email has been sent. It expires in seven days.` };
}
/** A second administrator's approval of an invitation to Admin, Finance or Compliance reviewer, recorded in the access history; the invitee can accept it afterwards. */
export async function approveInvitation(ctx: StoreContext, id: string) {
  const session = teamAdmin(ctx);
  const invitation = (await session.client.query<{ id: string; email: string; role: string; invited_by: string; status: string; expires_at: Date }>('SELECT id,email,role,invited_by,status,expires_at FROM valopay_staff_invitations WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [session.workspace.id, id])).rows[0];
  if (!invitation) fail('Invitation not found.', 404);
  if (invitation.status !== 'pending' || invitation.expires_at.getTime() <= Date.parse(ctx.now)) fail('This invitation is no longer pending.', 409);
  if (!needsApproval(invitation.role)) fail('This invitation needs no approval: only Admin, Finance and Compliance reviewer invitations do.', 409);
  if (invitation.invited_by === ctx.actor) fail(secondAdministrator('invitation', 'sent it'), 403);
  if (await invitationApprover(session.client, session.workspace.id, invitation)) fail('This invitation is already approved.', 409);
  await staffEvent(session.client, session.workspace.id, ctx.actor, 'staff.invitation_approved', id, { email: invitation.email, role: invitation.role, invitedBy: invitation.invited_by });
  return { message: `Invitation approved: ${invitation.email} can now accept it as ${invitation.role}.` };
}
/** Applies a membership change, clearing lender grants on a role change or revocation and pending invitations on a suspension or revocation, with its event. */
async function applyStaffChange(session: Session, ctx: StoreContext, row: StaffRow, after: { role: string; status: string }, action: string, detail: Record<string, unknown>) {
  const result = await session.client.query<StaffRow>(`UPDATE valopay_staff_memberships SET role=$3,status=$4,updated_at=greatest(now(),updated_at+interval '1 millisecond') WHERE workspace_id=$1 AND id=$2 RETURNING *`, [session.workspace.id, row.id, after.role, after.status]);
  if (after.status === 'revoked' || after.role !== row.role) await session.client.query('DELETE FROM valopay_staff_lender_access WHERE membership_id=$1', [row.id]);
  // Suspension and revocation withdraw the person's pending invitations: an
  // invitation sent earlier must not hand the access straight back.
  const invitationsRevoked = after.status === 'active' ? 0 : (await session.client.query("UPDATE valopay_staff_invitations SET status='revoked' WHERE workspace_id=$1 AND lower(email)=lower($2) AND status='pending'", [session.workspace.id, row.display_name])).rowCount || 0;
  await staffEvent(session.client, session.workspace.id, ctx.actor, action, row.id, { before: { role: row.role, status: row.status }, after, ...detail, ...(invitationsRevoked ? { invitationsRevoked } : {}) });
  return result.rows[0]!;
}
export async function updateStaff(ctx: StoreContext, id: string, input: { role: string; status: string; expectedUpdatedAt: string; reason: string }) {
  const session = teamAdmin(ctx);
  const row = (await session.client.query<StaffRow>('SELECT * FROM valopay_staff_memberships WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [session.workspace.id, id])).rows[0];
  if (!row) fail('Staff membership not found.', 404);
  if (row.user_id === session.userId) fail('Ask another administrator to change your membership.', 403);
  if (row.updated_at.toISOString() !== input.expectedUpdatedAt) fail('This membership changed. Refresh the team and review it again.', 409);
  if (row.status === 'revoked' && input.status !== 'revoked') fail('A revoked person must accept a new invitation before access is restored.', 409);
  const after = { role: input.role, status: input.status };
  if (grantNeedsApproval(row, after)) {
    // The grant waits for a second administrator: the request is recorded, and the membership stays as it is until one approves it.
    const waiting = (await session.client.query<ChangeRequestRow>(changeRequestsSql, [session.workspace.id, null, id])).rows.find(request => currentRequest(request) && sameJson(request.detail.after, after));
    const pending = waiting ? changeView(waiting) : await (async () => {
      const request = await staffEvent(session.client, session.workspace.id, ctx.actor, 'staff.change_requested', id, { before: { role: row.role, status: row.status }, after, reason: input.reason, version: row.updated_at.toISOString() });
      return changeView({ id: request.id, actor: ctx.actor, subject: id, detail: { before: { role: row.role, status: row.status }, after, reason: input.reason, version: row.updated_at.toISOString() }, created_at: request.createdAt, name: row.display_name, member_version: row.updated_at });
    })();
    return { ...staffView(row), message: `This change waits for a second administrator: an Admin, Finance or Compliance reviewer grant takes effect only when a different administrator approves it in Team & access. ${row.display_name} keeps their current access until then.`, pendingChange: pending };
  }
  const updated = await applyStaffChange(session, ctx, row, after, 'staff.changed', { reason: input.reason });
  return { ...staffView(updated), message: 'Access change saved. Existing sessions must pass it on their next request.', pendingChange: null };
}
/** The request a second administrator approves or declines: current, not decided, in this workspace. */
async function changeRequest(session: Session, requestId: string): Promise<ChangeRequestRow> {
  const found = (await session.client.query<ChangeRequestRow>(`SELECT request.id,request.actor,request.subject,request.detail,request.created_at,member.display_name AS name,member.updated_at AS member_version
    FROM valopay_staff_events request JOIN valopay_staff_memberships member ON member.id=request.subject AND member.workspace_id=request.workspace_id
    WHERE request.workspace_id=$1 AND request.id=$2 AND request.action='staff.change_requested'`, [session.workspace.id, requestId])).rows[0];
  if (!found) fail('Change request not found.', 404);
  if (!(await session.client.query(changeRequestsSql, [session.workspace.id, requestId, null])).rows.length) fail('This change was already approved or declined.', 409);
  return found;
}
/** A second administrator's approval of a waiting change: the exact change requested, applied now and recorded with who asked and who approved. */
export async function approveStaffChange(ctx: StoreContext, requestId: string) {
  const session = teamAdmin(ctx);
  const request = await changeRequest(session, requestId);
  const row = (await session.client.query<StaffRow>('SELECT * FROM valopay_staff_memberships WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [session.workspace.id, request.subject])).rows[0];
  if (!row) fail('Staff membership not found.', 404);
  if (row.updated_at.toISOString() !== request.detail.version) fail('This membership changed after the change was requested. Review the membership and ask for the change again.', 409);
  if (request.actor === ctx.actor) fail(secondAdministrator('change', 'asked for it'), 403);
  if (row.user_id === session.userId) fail('Ask another administrator to approve a change to your own membership.', 403);
  const updated = await applyStaffChange(session, ctx, row, request.detail.after, 'staff.change_approved', { reason: request.detail.reason, requestId, requestedBy: request.actor });
  return { ...staffView(updated), message: `Change approved: ${row.display_name} is now ${updated.role} (${updated.status}). Existing sessions must pass it on their next request.`, pendingChange: null };
}
/** Declines a waiting change (or withdraws it, for the administrator who asked), recorded in the access history; the membership is unchanged. Like an approval, never by the person it changes. */
export async function declineStaffChange(ctx: StoreContext, requestId: string) {
  const session = teamAdmin(ctx);
  const request = await changeRequest(session, requestId);
  // Declining a change to one's own membership would keep the access it takes away.
  const subject = (await session.client.query<{ user_id: string }>('SELECT user_id FROM valopay_staff_memberships WHERE workspace_id=$1 AND id=$2', [session.workspace.id, request.subject])).rows[0];
  if (subject?.user_id === session.userId) fail('Ask another administrator to decline a change to your own membership.', 403);
  await staffEvent(session.client, session.workspace.id, ctx.actor, 'staff.change_declined', request.subject, { requestId, before: request.detail.before, after: request.detail.after, requestedBy: request.actor });
  return { message: request.actor === ctx.actor ? 'Change request withdrawn. The membership is unchanged.' : 'Change request declined. The membership is unchanged.' };
}
/** The workspace's exclusive team lock serialises grant changes with every
 * read/write transaction, so removing a grant blocks later requests using an
 * already-issued session token after current authorised work completes. */
export async function updateStaffLenders(ctx: StoreContext, id: string, input: StaffLenderAccessInput) {
  const session = teamAdmin(ctx);
  const member = (await session.client.query<StaffRow>('SELECT * FROM valopay_staff_memberships WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [session.workspace.id, id])).rows[0];
  if (!member) fail('Staff membership not found.', 404);
  const available = await listMerchants(ctx);
  const checked = validateLenderAccessChange(input, { userId: member.user_id, role: member.role, status: member.status, updatedAt: member.updated_at.toISOString(), expiresAt: member.expires_at.toISOString() }, session.userId || '', available.map(lender => lender.id), ctx.now);
  const before = (await session.client.query<{ merchant_id: string }>('SELECT merchant_id FROM valopay_staff_lender_access WHERE membership_id=$1 ORDER BY merchant_id', [id])).rows.map(row => row.merchant_id);
  await session.client.query('DELETE FROM valopay_staff_lender_access WHERE membership_id=$1', [id]);
  for (const merchantId of checked.lenderIds) await session.client.query('INSERT INTO valopay_staff_lender_access(membership_id,merchant_id,granted_by,granted_at) VALUES($1,$2,$3,$4)', [id, merchantId, ctx.actor, ctx.now]);
  const updated = (await session.client.query<StaffRow>(`UPDATE valopay_staff_memberships SET updated_at=greatest(now(),updated_at+interval '1 millisecond') WHERE id=$1 AND workspace_id=$2 RETURNING *`, [id, session.workspace.id])).rows[0]!;
  await staffEvent(session.client, session.workspace.id, ctx.actor, 'staff.lender_access_changed', id, { before, after: [...checked.lenderIds].sort(), reason: checked.reason });
  return { ...staffView(updated), lenderIds: checked.lenderIds, allLenders: false, message: 'Lender access saved. Existing sessions must pass these permissions on their next request.' };
}
export async function revokeInvitation(ctx: StoreContext, id: string) {
  const session = teamAdmin(ctx);
  const result = await session.client.query("UPDATE valopay_staff_invitations SET status='revoked' WHERE workspace_id=$1 AND id=$2 AND status='pending'", [session.workspace.id, id]);
  if (!rowsAffected(result)) fail('This invitation is no longer pending.', 409);
  await staffEvent(session.client, session.workspace.id, ctx.actor, 'staff.invitation_revoked', id, {});
  return { message: 'Invitation revoked.' };
}

/** Acceptance has no existing membership. Clerk supplies the verified email;
 * the browser supplies only the invitation token, never an email or role. */
export async function acceptStaffInvitation(req: Request, token: string) {
  if (!staffMode()) fail('Staff access is not enabled on this host.', 403);
  const auth = getAuth(req) as unknown as VerifiedClerkSession;
  const now = new Date().toISOString();
  verifyStaff(auth, { id: 'invitation-check', userId: auth.userId || '', organizationId: auth.orgId || '', tenantId: 'invitation-check', role: 'Read-only', status: 'active', validFrom: '2020-01-01T00:00:00.000Z', expiresAt: '2100-01-01T00:00:00.000Z' }, true, now);
  const user = await clerkClient.users.getUser(auth.userId!);
  const emails = user.emailAddresses.filter(address => address.verification?.status === 'verified').map(address => address.emailAddress.toLowerCase());
  return acceptVerifiedInvitation(auth, token, emails);
}
async function acceptVerifiedInvitation(auth: VerifiedClerkSession, token: string, verifiedEmails: string[]) {
  const guard = await checkOut(() => pool.connect()), client = guard.client;
  let committing = false;
  try {
    await client.query(beginStatement(databaseLimits().request));
    await bindRuntimeIdentity(client, { organizationId: auth.orgId || '', userId: auth.userId || '' }, { token, verifiedEmails });
    // A membership change, like a team change: the workspace lock exclusively (waiting only for work already running), then its row.
    const found = (await client.query<{ workspace_id: string }>('SELECT t.workspace_id FROM valopay_teams t WHERE t.organization_id=$1', [auth.orgId])).rows[0];
    if (!found) fail('Select the organisation named in your invitation.', 403);
    await lockWorkspace(client, found.workspace_id, 'exclusive', true);
    const team = (await client.query<{ workspace_id: string }>(`SELECT t.workspace_id FROM valopay_teams t JOIN valopay_workspaces w ON w.id=t.workspace_id WHERE t.organization_id=$1 AND w.id=$2 FOR UPDATE OF w`, [auth.orgId, found.workspace_id])).rows[0];
    if (!team) fail('Select the organisation named in your invitation.', 403);
    const checkedAt = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.toISOString();
    verifyStaff(auth, { id: 'invitation-check', userId: auth.userId || '', organizationId: auth.orgId || '', tenantId: 'invitation-check', role: 'Read-only', status: 'active', validFrom: '2020-01-01T00:00:00.000Z', expiresAt: '2100-01-01T00:00:00.000Z' }, true, checkedAt);
    const invite = (await client.query<{ id: string; email: string; role: string; invited_by: string; created_at: Date }>(`SELECT id,email,role,invited_by,created_at FROM valopay_staff_invitations WHERE workspace_id=$1 AND token_hash=$2 AND status='pending' AND expires_at>clock_timestamp() FOR UPDATE`, [team.workspace_id, digest(token)])).rows[0];
    if (!invite || !verifiedEmails.includes(invite.email)) fail('This invitation is expired, used, revoked or belongs to another verified email address.', 403);
    const existing = (await client.query<StaffRow>('SELECT * FROM valopay_staff_memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE', [team.workspace_id, auth.userId])).rows[0];
    if (existing?.status === 'active' && existing.expires_at > new Date(checkedAt)) fail('You already have an active membership. Ask an administrator to change its role.', 409);
    if (existing && existing.status !== 'active') {
      // Only an invitation an administrator sent after the suspension or
      // revocation restores access; an older one, sent to any of the person's
      // verified addresses, is refused.
      const withdrawnAt = (await client.query<{ at: Date | null }>(`SELECT max(created_at) AS at FROM valopay_staff_events WHERE workspace_id=$1 AND subject=$2 AND action='staff.changed' AND detail->'after'->>'status' IN ('suspended','revoked')`, [team.workspace_id, existing.id])).rows[0]?.at ?? existing.updated_at;
      if (invite.created_at <= withdrawnAt) fail('This invitation was sent before your access was suspended or revoked, so it cannot restore it. Ask an administrator for a new invitation.', 403);
    }
    // An Admin, Finance or Compliance reviewer grant takes effect only once a second administrator approved the invitation.
    const approvedBy = needsApproval(invite.role) ? await invitationApprover(client, team.workspace_id, invite) : undefined;
    if (needsApproval(invite.role) && !approvedBy) fail("This invitation is waiting for a second administrator's approval. Ask the administrator who sent it to have another administrator approve it in Team & access, then accept it again.", 403);
    if(existing) {
      if (runtimeIsolationEnabled()) await clearRuntimeInviteeGrants(client);
      else await client.query('DELETE FROM valopay_staff_lender_access WHERE membership_id=$1',[existing.id]);
    }
    await client.query(`INSERT INTO valopay_staff_memberships(id,workspace_id,user_id,display_name,role,status,expires_at) VALUES($1,$2,$3,$4,$5,'active',now()+interval '90 days')
      ON CONFLICT(workspace_id,user_id) DO UPDATE SET display_name=EXCLUDED.display_name,role=EXCLUDED.role,status='active',expires_at=EXCLUDED.expires_at,updated_at=greatest(now(),valopay_staff_memberships.updated_at+interval '1 millisecond')`, [randomUUID(), team.workspace_id, auth.userId, invite.email, invite.role]);
    await client.query("UPDATE valopay_staff_invitations SET status='accepted' WHERE id=$1 AND workspace_id=$2", [invite.id, team.workspace_id]);
    await staffEvent(client, team.workspace_id, `Clerk:${auth.userId}`, 'staff.accepted', invite.id, { role: invite.role, ...(approvedBy ? { approvedBy } : {}) });
    // Checked before COMMIT: an answer that does not match its contract saves nothing.
    const accepted = contractAnswer(invitationAcceptedSchema, { message: 'Invitation accepted. Your pilot membership lasts 90 days.', role: invite.role });
    committing = true;
    await client.query('COMMIT'); return accepted;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* the transaction is already closed */ }
    const failed = failedTransaction(error, { committing, lost: guard.lost(), write: true });
    // Before COMMIT was sent nothing was saved, and the answer may say so (as inWorkspace's do).
    if (failed === error && !committing) markRolledBack(error);
    throw failed;
  } finally { guard.release(); }
}

/**
 * Operator-only (scripts/provision-pilot.ts); never called by an HTTP route.
 * An organisation's staff workspace and its administrators: the first
 * administrator with the workspace, another administrator, and renewal of an
 * administrator's 90 days. Each change is one transaction with its staff
 * event; running a command again never fails on a duplicate row, it says
 * where things stand.
 */
const OPERATOR_ACTOR = 'System · operator provisioning';
/** What an operator command did: its outcome, the workspace and administrator, and the expiry, in plain words too. */
export type OperatorProvisioning = { outcome: 'provisioned' | 'added' | 'renewed' | 'unchanged'; workspaceId: string; userId: string; status: string; expiresAt: string; previousExpiresAt?: string; message: string };
/** The checks every operator command makes before it opens a connection. */
function operatorCheck(organizationId: string, userId: string, name?: { value: string; label: string }) {
  if (runtimeIsolationEnabled()) fail('Provision isolated staff workspaces through the separate migration-owner connection before starting the restricted runtime.', 503);
  if (!staffMode() || !/^org_[A-Za-z0-9]+$/.test(organizationId) || !/^user_[A-Za-z0-9]+$/.test(userId) || (name && (!name.value.trim() || name.value.length > 100))) fail(`Provide a staging organisation${name ? `, administrator user ID and ${name.label}` : ' and administrator user ID'}.`);
}
/** One operator change in its own bounded transaction: committed, or rolled back and thrown. */
async function operatorTransaction<T>(change: (client: PoolClient) => Promise<T>): Promise<T> {
  const guard = await checkOut(() => pool.connect()), client = guard.client;
  let committing = false;
  try {
    await client.query(beginStatement(databaseLimits().request));
    const result = await change(client);
    committing = true;
    const committed = await client.query('COMMIT');
    if (committed.command !== 'COMMIT') throw markRolledBack(new Error('The provisioning transaction was rolled back.'));
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* the transaction is already closed */ }
    // A row another run wrote at the same moment: named in plain words, never with the key the database quotes.
    if ((error as { code?: unknown }).code === '23505') fail('Another provisioning run changed this organisation at the same moment, and nothing was saved. Run the command again to see where it stands.', 409);
    throw failedTransaction(error, { committing, lost: guard.lost(), write: true });
  } finally { guard.release(); }
}
type OperatorMember = StaffRow & { current: boolean };
const memberFor = async (client: PoolClient, workspaceId: string, userId: string) => (await client.query<OperatorMember>('SELECT *, expires_at > clock_timestamp() AS current FROM valopay_staff_memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE', [workspaceId, userId])).rows[0];
const operatorAnswer = (outcome: OperatorProvisioning['outcome'], workspaceId: string, member: StaffRow, message: string, previous?: StaffRow): OperatorProvisioning => ({ outcome, workspaceId, userId: member.user_id, status: member.status, expiresAt: member.expires_at.toISOString(), ...(previous ? { previousExpiresAt: previous.expires_at.toISOString() } : {}), message });
/** The organisation's workspace, locked as a team change locks it (exclusively, waiting only for work already running), or a 404. */
async function lockedTeam(client: PoolClient, organizationId: string): Promise<string> {
  const missing = () => fail('This organisation has not been provisioned yet. Provision it with its first administrator.', 404);
  const found = (await client.query<{ workspace_id: string }>('SELECT workspace_id FROM valopay_teams WHERE organization_id=$1', [organizationId])).rows[0] ?? missing();
  await lockWorkspace(client, found.workspace_id, 'exclusive', true);
  const team = (await client.query<{ workspace_id: string }>('SELECT t.workspace_id FROM valopay_teams t JOIN valopay_workspaces w ON w.id=t.workspace_id WHERE t.organization_id=$1 AND w.id=$2 FOR UPDATE OF w', [organizationId, found.workspace_id])).rows[0] ?? missing();
  return team.workspace_id;
}

/** The organisation's workspace with its first administrator for 90 days; for an organisation already provisioned with this administrator, nothing changes and the answer says where it stands. */
export async function provisionStaffWorkspace(organizationId: string, userId: string, name: string): Promise<OperatorProvisioning> {
  operatorCheck(organizationId, userId, { value: name, label: 'workspace name' });
  const principal = digest(`staff-org:${organizationId}`);
  return operatorTransaction(async (client) => {
    // The lock a first visit takes for its principal: two runs for one organisation run one after the other.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [principal]);
    const existing = (await client.query<{ workspace_id: string }>('SELECT workspace_id FROM valopay_teams WHERE organization_id=$1', [organizationId])).rows[0];
    if (existing) {
      const member = await memberFor(client, existing.workspace_id, userId);
      if (member?.role !== 'Admin') fail('This organisation is already provisioned, with another first administrator. Add this person with --add-administrator, or renew an administrator with --renew.', 409);
      const state = member.status !== 'active' ? `this administrator's membership is ${member.status}` : member.current ? `this person is an administrator until ${member.expires_at.toISOString()}` : `this administrator's access ended on ${member.expires_at.toISOString()}; renew it with --renew`;
      return operatorAnswer('unchanged', existing.workspace_id, member, `Already provisioned, so nothing changed: ${state}.`);
    }
    const workspaceId = randomUUID();
    await client.query("INSERT INTO valopay_workspaces(id,principal_hash,role) VALUES($1,$2,'Read-only')", [workspaceId, principal]);
    await client.query('INSERT INTO valopay_teams(workspace_id,organization_id,name) VALUES($1,$2,$3)', [workspaceId, organizationId, name]);
    const member = (await client.query<StaffRow>("INSERT INTO valopay_staff_memberships(id,workspace_id,user_id,display_name,role,expires_at) VALUES($1,$2,$3,$4,'Admin',now()+interval '90 days') RETURNING *", [randomUUID(), workspaceId, userId, 'Pilot administrator'])).rows[0]!;
    await staffEvent(client, workspaceId, OPERATOR_ACTOR, 'staff.provisioned', userId, { organizationId });
    return operatorAnswer('provisioned', workspaceId, member, `Provisioned: the first administrator's access lasts until ${member.expires_at.toISOString()}. Add a second administrator with --add-administrator, and renew with --renew before access ends.`);
  });
}

/** Another administrator for a provisioned organisation, for 90 days; for a person who is already an active administrator, nothing changes. A suspended or revoked membership is never restored this way. */
export async function addStaffAdministrator(organizationId: string, userId: string, displayName: string): Promise<OperatorProvisioning> {
  operatorCheck(organizationId, userId, { value: displayName, label: 'display name' });
  return operatorTransaction(async (client) => {
    const workspaceId = await lockedTeam(client, organizationId);
    const member = await memberFor(client, workspaceId, userId);
    if (member?.role === 'Admin' && member.status === 'active' && member.current) return operatorAnswer('unchanged', workspaceId, member, `Already an administrator until ${member.expires_at.toISOString()}, so nothing changed. Renew with --renew before then.`);
    if (member?.role === 'Admin' && member.status === 'active') fail(`This administrator's access ended on ${member.expires_at.toISOString()}. Renew it with --renew.`, 409);
    if (member) fail(member.status === 'active' ? `This person is already a ${member.role} member. An administrator changes their role in Team & access.` : `This person's membership is ${member.status}, and adding an administrator never restores it: an administrator invites them again.`, 409);
    const added = (await client.query<StaffRow>("INSERT INTO valopay_staff_memberships(id,workspace_id,user_id,display_name,role,expires_at) VALUES($1,$2,$3,$4,'Admin',now()+interval '90 days') RETURNING *", [randomUUID(), workspaceId, userId, displayName.trim()])).rows[0]!;
    await staffEvent(client, workspaceId, OPERATOR_ACTOR, 'staff.administrator_added', added.id, { userId, organizationId });
    return operatorAnswer('added', workspaceId, added, `Added: this administrator's access lasts until ${added.expires_at.toISOString()}.`);
  });
}

/** An administrator's access, active or already ended, extended to 90 days from now, with a staff event; a suspended or revoked membership, or another role's, is refused. */
export async function renewStaffAdministrator(organizationId: string, userId: string): Promise<OperatorProvisioning> {
  operatorCheck(organizationId, userId);
  return operatorTransaction(async (client) => {
    const workspaceId = await lockedTeam(client, organizationId);
    const member = await memberFor(client, workspaceId, userId);
    if (!member) fail('This person has no membership in the organisation\'s workspace. Add them with --add-administrator.', 404);
    if (member.role !== 'Admin') fail(`Renewal is for administrators, and this membership is ${member.role}. An administrator renews anyone else with a new invitation.`, 409);
    if (member.status !== 'active') fail(`This administrator's membership is ${member.status}, and renewal never restores it: an administrator invites them again, or add another administrator with --add-administrator.`, 409);
    const renewed = (await client.query<StaffRow>("UPDATE valopay_staff_memberships SET expires_at=greatest(expires_at,now()+interval '90 days'),updated_at=greatest(now(),updated_at+interval '1 millisecond') WHERE id=$1 AND workspace_id=$2 RETURNING *", [member.id, workspaceId])).rows[0]!;
    await staffEvent(client, workspaceId, OPERATOR_ACTOR, 'staff.renewed', member.id, { userId, previousExpiresAt: member.expires_at.toISOString(), expiresAt: renewed.expires_at.toISOString(), ended: !member.current });
    return operatorAnswer('renewed', workspaceId, renewed, `Renewed: this administrator's access ${member.current ? 'now lasts' : 'is restored and lasts'} until ${renewed.expires_at.toISOString()}.`, member);
  });
}

/** A new synthetic lender, or, for a repeat of the same request (repeated), the lender its key created earlier. */
export async function createPilotLender(ctx: StoreContext, input: { name: string; segment: string }, key: string): Promise<{ lender: DomainState["merchant"]; repeated: boolean }> {
  const session = sessionFor(ctx);
  if (ctx.role !== 'Admin' || session.access !== 'team') fail('An administrator must set up a lender.', 403);
  // Workspace lock and deterministic ID make a repeated onboarding request safe.
  const id = digest(`onboarding:${session.workspace.id}:${session.owner}:${key}`), fingerprint = requestFingerprint(input);
  const found = (await session.client.query<MerchantRow>('SELECT id,info,settings FROM valopay_merchants WHERE workspace_id=$1 AND id=$2', [session.workspace.id, id])).rows[0];
  if (found) { if (found.settings.onboardingFingerprint !== fingerprint) fail('This setup request was already used for different details.', 409); return { lender: found.info, repeated: true }; }
  // The journal does not record lender creation, so a creation whose answer was lost and is sent again after a reload
  // has a new key: a name already in the workspace, ignoring case and surrounding or repeated spaces, is refused
  // naming that lender, in every mode, rather than making a second one.
  const same = (await session.client.query<{ name: string }>(`SELECT info->>'name' AS name FROM valopay_merchants WHERE workspace_id=$1
    AND lower(btrim(regexp_replace(info->>'name','\\s+',' ','g')))=lower(btrim(regexp_replace($2,'\\s+',' ','g'))) ORDER BY id LIMIT 1`, [session.workspace.id, input.name])).rows[0];
  if (same) fail(`A lender named "${same.name}" already exists in this workspace. Select it in the lender list, or choose another name.`, 409);
  // 'team' access holds the workspace lock exclusively (lockWorkspace), so two creations at once are counted one after the other.
  if (ctx.accessMode !== 'staff') {
    const held = (await session.client.query<{ count: number }>('SELECT count(*)::int AS count FROM valopay_merchants WHERE workspace_id=$1', [session.workspace.id])).rows[0]!.count;
    if (held >= SANDBOX_LENDER_LIMIT) fail(`This sandbox already holds ${SANDBOX_LENDER_LIMIT} lenders, the most a sandbox can have. Continue with an existing lender; a staff workspace can hold more.`, 409);
  }
  const state = seedMerchant(id, true);
  state.records = [];
  Object.assign(state.merchant, { name: input.name, shortName: input.name, segment: input.segment, provider: 'Paystack', mode: 'observation', status: 'onboarding', monthlyVolume: 0, killSwitch: true, preDataReady: false, preLiveReady: false });
  Object.assign(state.settings, { onboardingFingerprint: fingerprint, scheduledCloseEnabled: false, anonymousWorkspace: !ctx.authenticated, nextCloseAt: null });
  await session.client.query('INSERT INTO valopay_merchants(id,workspace_id,info,settings) VALUES($1,$2,$3,$4)', [id, session.workspace.id, state.merchant, state.settings]);
  await loadState(ctx, id, 'update');
  appendAudit(state, ctx, 'lender.created', id, 'Created an empty synthetic lender for pilot rehearsal.');
  await saveState(ctx, state);
  return { lender: state.merchant, repeated: false };
}

function principalFor(req: Request, res: Response) {
  const userId = signedInUser(req);
  if (staffMode() && !userId) fail('Sign in with your pilot staff account. Anonymous access is unavailable in this environment.', 401);
  if (userId) return { principal: digest(`clerk:${userId}`), authenticated: true, address: req.ip };
  // A request with two different sandbox tokens is refused here, before anything is read (sandbox-cookie.ts).
  const secure = secureRequest(req), cookie = readSandboxCookie(req.headers.cookie, secure);
  const token = cookie.token ?? randomBytes(32).toString("hex");
  // The cookie slides: an active sandbox keeps its 30 days from the last visit, matching the expiry sweep below.
  writeSandboxCookie(res, cookie, token, secure, ANONYMOUS_WORKSPACE_DAYS * 86400000);
  return { principal: sandboxPrincipal(token), authenticated: false, address: req.ip };
}

function sessionFor(context: StoreContext): Session {
  const session = sessions.get(context);
  if (!session || !session.active) fail("This workspace transaction is no longer available.", 409);
  return session;
}
/** Whether this request's own transaction verified the restricted database: the readiness page reports this, never the configuration alone. */
export function runtimeIsolationVerified(context: StoreContext): boolean { return sessionFor(context).isolationVerified === true; }
export function systemWorkspaceMatches(context:StoreContext,workspaceId:string):boolean {return context.actor.startsWith(SYSTEM_ACTOR_PREFIX)&&sessionFor(context).workspace.id===workspaceId;}
export async function verifyWorkspaceEncryption(context:StoreContext) {
  const session=teamAdmin(context);
  if(!payloadEncryptionKey())fail('Configure managed payload encryption before running this check.',503);
  const scope={lender:session.workspace.id,record:randomUUID(),field:'synthetic-key-check'},value={synthetic:true,nonce:randomUUID()};
  const sealed=await protectStored(value,scope),opened=await revealStored(sealed,scope);
  if(!sameJson(value,opened))fail('The encryption check failed.',503);
  await staffEvent(session.client,session.workspace.id,context.actor,'encryption.verified','workspace',{synthetic:true,checkedAt:context.now});
  return {message:'Managed encryption and decryption succeeded for a synthetic payload.',checkedAt:context.now,verified:true};
}
/** Bounded, repeatable protection of legacy payloads. Metadata and request
 * fingerprints remain stable; no recovery key is erased or reused. */
export async function protectWorkspacePayloads(context:StoreContext) {
  const session=teamAdmin(context);
  if(!payloadEncryptionKey())fail('Configure managed payload encryption first.',503);
  // One record per request bounds managed-key calls and keeps progress restartable.
  const batch=1;let protectedCount=0;
  const imports=(await session.client.query<RecordRow>(`SELECT r.* FROM valopay_records r JOIN valopay_merchants m ON m.id=r.merchant_id WHERE m.workspace_id=$1 AND r.kind='import-batches' AND (r.data ? 'csv' AND NOT (jsonb_typeof(r.data->'csv')='object' AND r.data->'csv' ? 'protectedPayload')) ORDER BY r.id LIMIT $2 FOR UPDATE OF r`,[session.workspace.id,batch])).rows;
  for(const row of imports){await session.client.query('UPDATE valopay_records SET data=$3 WHERE id=$1 AND merchant_id=$2',[row.id,row.merchant_id,await protectRecordData(rowToRecord(row))]);protectedCount++;}
  const operations=(await session.client.query<OperationRow>(`SELECT o.* FROM valopay_operations o JOIN valopay_merchants m ON m.id=o.merchant_id WHERE m.workspace_id=$1 AND ((NOT(o.request ? 'protectedPayload') AND NOT(o.request ? 'purged')) OR (o.receipt IS NOT NULL AND NOT(o.receipt ? 'protectedPayload') AND NOT(o.receipt ? 'purged') AND CASE WHEN jsonb_typeof(o.receipt)='object' THEN o.receipt-'record'-'id'-'kind'<>'{}'::jsonb ELSE true END)) ORDER BY o.id LIMIT $2 FOR UPDATE OF o`,[session.workspace.id,batch])).rows;
  for(const row of operations){if(protectedCount)break;const scope={lender:row.merchant_id,record:row.id};const request=isProtectedPayload(row.request)?row.request:await protectStored(row.request,{...scope,field:'request'});const receipt=row.receipt===null||isProtectedPayload(row.receipt)||isJournalReference(row.receipt)?row.receipt:await protectStored(row.receipt,{...scope,field:'receipt'});await session.client.query('UPDATE valopay_operations SET request=$3,receipt=$4 WHERE id=$1 AND merchant_id=$2',[row.id,row.merchant_id,request,receipt]);protectedCount++;}
  const receipts=(await session.client.query<{id:string;merchant_id:string;response:unknown}>(`SELECT i.* FROM valopay_idempotency i JOIN valopay_merchants m ON m.id=i.merchant_id WHERE m.workspace_id=$1 AND NOT(i.response ? 'protectedPayload') AND NOT(i.response ? 'purged') ORDER BY i.id LIMIT $2 FOR UPDATE OF i`,[session.workspace.id,batch])).rows;
  for(const row of receipts){if(protectedCount)break;await session.client.query('UPDATE valopay_idempotency SET response=$3 WHERE id=$1 AND merchant_id=$2',[row.id,row.merchant_id,await protectStored(row.response,{lender:row.merchant_id,record:row.id,field:'response'})]);protectedCount++;}
  await staffEvent(session.client,session.workspace.id,context.actor,'encryption.protected','workspace',{protectedCount,at:context.now});
  return {message:protectedCount?'Protected another batch of stored payloads. Run again until no payloads remain.':'No unprotected import or recovery payloads remain in this workspace.',protectedCount,mayHaveMore:protectedCount>0};
}
/** What one run of the operator's re-wrap step did (scripts/rewrap-payloads.ts): in which schema, and which other schemas hold the application's tables and were not scanned. */
export type PayloadRewrap = { key: string; schema: string; rewrapped: number; changed: number; remaining: number; remainingByKey: Array<{ key: string; payloads: number }>; otherSchemas: string[]; message: string };
/** A restricted runtime's schema, as runtime-isolation.ts accepts its name. */
const RUNTIME_SCHEMA_NAME = /^valopay_runtime_(staging|test)_[a-z0-9_]+$/;
/** The four tables the re-wrap reads: in the named schema, qualified, or unqualified, where the connection's search path finds them. The schema's name is checked first, never input. */
const rewrapTables = (schema: string | undefined) => {
  const table = (name: string) => (schema ? `"${schema}".${name}` : name);
  return { records: table('valopay_records'), operations: table('valopay_operations'), idempotency: table('valopay_idempotency'), merchants: table('valopay_merchants') };
};
type RewrapTables = ReturnType<typeof rewrapTables>;
/**
 * Every protected payload and the scope it was sealed in, with the table it
 * lives in: an import batch's source rows and check, a journal entry's request
 * and receipt, and a replay copy's answer. The fields are fixed here, never
 * input. $1 is the current key; $2, when not null, limits it to those
 * workspaces (tests).
 */
const sealedPayloadsSql = (tables: RewrapTables) => `WITH sealed AS (
    SELECT 'records' AS source, r.id, r.merchant_id, f.field, f.value FROM ${tables.records} r CROSS JOIN LATERAL (VALUES ('csv', r.data->'csv'), ('check', r.data->'check')) AS f(field, value) WHERE r.kind='import-batches'
    UNION ALL SELECT 'operations', o.id, o.merchant_id, f.field, f.value FROM ${tables.operations} o CROSS JOIN LATERAL (VALUES ('request', o.request), ('receipt', o.receipt)) AS f(field, value)
    UNION ALL SELECT 'idempotency', i.id, i.merchant_id, 'response', i.response FROM ${tables.idempotency} i)
  SELECT sealed.source, sealed.id, sealed.merchant_id, sealed.field, sealed.value FROM sealed JOIN ${tables.merchants} m ON m.id=sealed.merchant_id
  WHERE jsonb_typeof(sealed.value)='object' AND sealed.value ? 'protectedPayload' AND sealed.value->>'key' IS DISTINCT FROM $1 AND ($2::text[] IS NULL OR m.workspace_id=ANY($2::text[]))`;
/** Writes a re-sealed payload back only while it is still the envelope that was read, so a request that changed it meanwhile wins. */
const rewrapWrites = (tables: RewrapTables): Record<string, string> => ({
  'records:csv': `UPDATE ${tables.records} SET data=jsonb_set(data,'{csv}',$3::jsonb) WHERE id=$1 AND merchant_id=$2 AND kind='import-batches' AND data->'csv'=$4::jsonb`,
  'records:check': `UPDATE ${tables.records} SET data=jsonb_set(data,'{check}',$3::jsonb) WHERE id=$1 AND merchant_id=$2 AND kind='import-batches' AND data->'check'=$4::jsonb`,
  'operations:request': `UPDATE ${tables.operations} SET request=$3::jsonb WHERE id=$1 AND merchant_id=$2 AND request=$4::jsonb`,
  'operations:receipt': `UPDATE ${tables.operations} SET receipt=$3::jsonb WHERE id=$1 AND merchant_id=$2 AND receipt=$4::jsonb`,
  'idempotency:response': `UPDATE ${tables.idempotency} SET response=$3::jsonb WHERE id=$1 AND merchant_id=$2 AND response=$4::jsonb`,
});
/**
 * What the connection makes of the four tables before a payload is read: how
 * many it finds and in which schema, whether row security filters any of them
 * for it, whether it owns them all or bypasses row security, and the other
 * schemas that hold the application's tables.
 */
const rewrapScopeSql = `WITH scanned AS (SELECT c.oid, c.relowner, n.nspname::text AS schema FROM unnest($1::text[]) AS t(name) JOIN pg_class c ON c.oid=to_regclass(t.name) JOIN pg_namespace n ON n.oid=c.relnamespace)
  SELECT (SELECT count(*)::int FROM scanned) AS tables, (SELECT string_agg(DISTINCT schema, ', ') FROM scanned) AS schema,
    (SELECT coalesce(bool_or(row_security_active(oid)), false) FROM scanned) AS filtered,
    (SELECT coalesce(bool_and(pg_has_role(current_user, relowner, 'USAGE')), false) FROM scanned) AS owns,
    (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypasses,
    (SELECT coalesce(array_agg(DISTINCT n.nspname::text ORDER BY n.nspname::text), '{}') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relname='valopay_operations' AND c.relkind='r' AND n.nspname::text NOT IN (SELECT schema FROM scanned)) AS "otherSchemas"`;
/**
 * The schema the re-wrap reads, checked on the connection that reads it: a
 * connection that could miss a payload is refused before it reads one, since
 * it would count none left and say an earlier key may be retired. Row
 * security filters a login that does not bypass it wherever a table enables
 * it (the restricted runtime's schema forces it even on the tables' owner),
 * and a login that neither owns the tables nor bypasses row security sees
 * every row only for as long as no one enables it.
 */
async function rewrapScope(client: PoolClient, tables: RewrapTables, named: string | undefined): Promise<{ schema: string; otherSchemas: string[] }> {
  const scope = (await client.query<{ tables: number; schema: string | null; filtered: boolean; owns: boolean; bypasses: boolean | null; otherSchemas: string[] }>(rewrapScopeSql, [Object.values(tables)])).rows[0]!;
  if (scope.tables !== Object.keys(tables).length) fail(named ? `VALOPAY_RUNTIME_SCHEMA names ${named}, which does not hold the application's tables; nothing was read.` : "The connection's search path does not reach the application's tables; nothing was read.", 503);
  if (scope.filtered) fail(`Row security filters what this connection reads in ${scope.schema}, so the re-wrap could miss payloads there; nothing was read. Run it with the migration owner's connection, which bypasses row security, never the restricted runtime login.`, 503);
  if (!scope.owns && !scope.bypasses) fail(`This connection neither owns the application's tables in ${scope.schema} nor bypasses row security, so the re-wrap could miss payloads there; nothing was read. Run it with the migration owner's connection, never the restricted runtime login.`, 503);
  return { schema: scope.schema!, otherSchemas: scope.otherSchemas };
}
/**
 * Operator-only (scripts/rewrap-payloads.ts); never called by an HTTP route.
 * After the payload wrapping key changes name (VALOPAY_KMS_KEY), re-seals at
 * most `limit` protected payloads that still name an earlier key: each is
 * opened with the key it names, which must still be listed in
 * VALOPAY_KMS_PREVIOUS_KEYS, and sealed again under the current key with a
 * fresh data key, in the scope it was sealed in. It reads one schema: the
 * restricted runtime's that VALOPAY_RUNTIME_SCHEMA names, whose tables it
 * names in full, or else the one the connection's search path reaches, and
 * only through a connection that sees every row there (rewrapScope). Nothing
 * is locked while the key service works: a payload is read, re-sealed, then
 * written back in a short transaction of its own only if it is still the
 * envelope that was read, so a run can stop at any point and be run again,
 * and a payload a request rewrote meanwhile is left to it (counted as
 * changed). Returns the schema it read, how many it re-sealed, how many still
 * name each earlier key, and the other schemas that hold the application's
 * tables: an earlier key may be retired once every schema reports none left
 * (docs/pilot-security.md, "Key rotation").
 */
export async function rewrapProtectedPayloads(options: { limit?: number; workspaces?: readonly string[] } = {}): Promise<PayloadRewrap> {
  const key = payloadEncryptionKey();
  if (!key) fail('Set VALOPAY_PAYLOAD_ENCRYPTION=kms and VALOPAY_KMS_KEY to the key payloads should be sealed under.', 503);
  const limit = options.limit ?? 100, workspaces = options.workspaces ? [...options.workspaces] : null;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail('Re-wrap between 1 and 1000 payloads at a time.');
  const named = process.env.VALOPAY_RUNTIME_SCHEMA || undefined;
  if (named && !RUNTIME_SCHEMA_NAME.test(named)) fail("VALOPAY_RUNTIME_SCHEMA must name a restricted runtime's schema (valopay_runtime_staging_<suffix>), or be unset for the tables the connection's search path reaches.", 503);
  const tables = rewrapTables(named), sealedSql = sealedPayloadsSql(tables), writes = rewrapWrites(tables);
  type Sealed = { source: string; id: string; merchant_id: string; field: string; value: { key?: string } };
  const { schema, batch } = await operatorTransaction(async client => ({ schema: (await rewrapScope(client, tables, named)).schema, batch: (await client.query<Sealed>(`${sealedSql} ORDER BY sealed.source,sealed.merchant_id,sealed.id,sealed.field LIMIT $3`, [key, workspaces, limit])).rows }));
  let rewrapped = 0, changed = 0;
  for (const payload of batch) {
    const scope = { lender: payload.merchant_id, record: payload.id, field: payload.field };
    let sealed: unknown;
    try { sealed = await protectStored(await revealStored(payload.value, scope), scope); }
    catch (error) {
      if ((error as { status?: unknown }).status !== 503) throw error;
      fail(`A payload sealed under ${String(payload.value.key)} could not be opened, so the run stopped after re-sealing ${rewrapped}. Keep that key in VALOPAY_KMS_PREVIOUS_KEYS and check this service may decrypt with it, then run the command again.`, 503);
    }
    const written = await operatorTransaction(client => client.query(writes[`${payload.source}:${payload.field}`]!, [payload.id, payload.merchant_id, JSON.stringify(sealed), JSON.stringify(payload.value)]));
    if (rowsAffected(written)) rewrapped++; else changed++;
  }
  // The count that may say none are left is checked on its own connection too.
  const { otherSchemas, counted } = await operatorTransaction(async client => ({ otherSchemas: (await rewrapScope(client, tables, named)).otherSchemas, counted: (await client.query<{ key: string; payloads: string }>(`SELECT payload.value->>'key' AS key, count(*) AS payloads FROM (${sealedSql}) payload GROUP BY 1 ORDER BY 1`, [key, workspaces])).rows }));
  const remainingByKey = counted.map(row => ({ key: row.key, payloads: Number(row.payloads) }));
  const remaining = remainingByKey.reduce((sum, row) => sum + row.payloads, 0);
  const moved = `Re-sealed ${rewrapped} protected payload${rewrapped === 1 ? '' : 's'} in ${schema} under ${key}${changed ? `; ${changed} changed while this run worked and will be checked again` : ''}.`;
  return { key, schema, rewrapped, changed, remaining, remainingByKey, otherSchemas, message: remaining
    ? `${moved} ${remaining} in ${schema} still name an earlier key: run the command again until none remain, and keep the earlier keys in VALOPAY_KMS_PREVIOUS_KEYS until then.`
    : otherSchemas.length
      ? `${moved} No protected payload in ${schema} names an earlier key, but ${otherSchemas.join(', ')} also ${otherSchemas.length === 1 ? 'holds' : 'hold'} the application's tables: re-wrap ${otherSchemas.length === 1 ? 'it' : 'each'} too (docs/pilot-security.md, "Key rotation"), and retire an earlier key only once every schema reports none and no backup you may restore still needs it.`
      : `${moved} No protected payload in ${schema} names an earlier key: an earlier key may be retired once no backup you may restore still needs it.` };
}
function rowsAffected(result: { rowCount: number | null }): boolean { return (result.rowCount || 0) === 1; }
function rowToRecord(row: RecordRow): ValopayRecord {
  return {
    id: row.id, merchantId: row.merchant_id, kind: row.kind, name: row.name, status: row.status,
    reference: row.reference, amountKobo: databaseMoney(row.amount_kobo), customerId: row.customer_id,
    data: row.data, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}
/** Row lock a load takes on the merchant: exclusive for a mutation, shared for a read so reads never queue behind each other. */
export type MerchantLock = "update" | "share" | "none";
export type WorkspaceAccess = "read" | "write" | "persona" | 'team';
function scopedMerchantQuery(lock: MerchantLock = "none") {
  return `SELECT m.id,m.info,m.settings FROM valopay_merchants m
    JOIN valopay_workspaces w ON w.id=m.workspace_id
    WHERE m.id=$1 AND m.workspace_id=$2 AND w.id=$2 AND w.principal_hash=$3${lock === "update" ? " FOR UPDATE OF m" : lock === "share" ? " FOR SHARE OF m" : ""}`;
}

/**
 * The workspace's own lock, taken before its row: shared by ordinary work,
 * exclusive for a team, lender-access, invitation or persona change.
 * PostgreSQL grants advisory locks in arrival order, so a request that arrives
 * while a change waits queues behind it; a row share lock is granted past a
 * waiting exclusive one, so steady polling could hold a revocation off for
 * ever. The wait is the transaction's own lock limit (database-limits.ts):
 * past it a change answers 503 and nothing changed, and a request queued
 * behind a change that holds the lock too long is turned away the same way.
 * The key's prefix keeps it apart from the principal's bootstrap lock.
 */
async function lockWorkspace(client: PoolClient, workspaceId: string, mode: "shared" | "exclusive", write: boolean): Promise<void> {
  try {
    await client.query(`SELECT ${mode === "exclusive" ? "pg_advisory_xact_lock" : "pg_advisory_xact_lock_shared"}(hashtextextended('valopay.workspace:' || $1, 0))`, [workspaceId]);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "55P03") throw error;
    throw markRolledBack(new DatabaseLimitError(mode === "exclusive" ? "workspace_busy" : "workspace_changing", { write, cause: error }));
  }
}

/** Persona, team, lender-access and invitation changes take the workspace
 * lock exclusively (lockWorkspace). Ordinary work shares it, fixing the
 * persona and memberships for the transaction while lender locks serialize
 * mutations; a change waits only for the work already running, and work that
 * arrives meanwhile waits behind the change. The workspace row is still locked
 * after it (shared or exclusive), so the expiry sweep skips busy workspaces.
 * Only first-visit bootstrap needs the principal advisory lock. Every
 * transaction is bounded (database-limits.ts): a lock wait, a statement and
 * idle time each have a limit, and a tenant holds at most a third of the pool
 * (one of its lenders half of that), so a busy lender or a busy sandbox turns
 * its own requests away with a 503 instead of taking every connection.
 *
 * A read answers from one snapshot (REPEATABLE READ): it takes no lender lock,
 * so it never waits for a lender's writes and sees the state before any write
 * still running, and all its statements see the same state. Its identity
 * checks are those of a write (the workspace lock and row, the membership
 * locked for share, which refuses a request whose access changed while it
 * waited), after which the transaction is read only. A first visit creates its
 * sandbox in a read-committed transaction instead, as a write does. */
export async function inWorkspace<T>(req: Request, res: Response, fn: (context: StoreContext) => Promise<T>, access: WorkspaceAccess = "write"): Promise<T> {
  const identity = principalFor(req, res);
  const write = access !== "read", lanes = gatedLanes(req, identity.principal);
  const leave = lanes ? await enterGate(lanes, write) : undefined;
  let guard: Checkout<PoolClient> | undefined;
  let context: StoreContext | undefined, committing = false, isolationVerified = false, snapshotRead = access === "read";
  // Export files of sandboxes this bootstrap swept, and of those, the ones whose deletion committed (removeSweptExportFiles).
  let swept: SweptExportFile[] = [], sweptAndCommitted: SweptExportFile[] = [];
  try {
    guard = await checkOut(() => pool.connect(), write);
    const client = guard.client;
    const exclusive = access === "persona" || access === 'team', lockMode = exclusive ? "exclusive" : "shared";
    const workspaceQuery = `SELECT id,principal_hash,role FROM valopay_workspaces WHERE principal_hash=$1 AND id=$2 FOR ${exclusive ? "UPDATE" : "SHARE"}`;
    /** The principal's sandbox, found without a lock and then locked; one removed meanwhile (the expiry sweep) is created afresh. */
    const lockedSandbox = async (): Promise<WorkspaceRow | undefined> => {
      const found = (await client.query<{ id: string }>("SELECT id FROM valopay_workspaces WHERE principal_hash=$1", [identity.principal])).rows[0];
      if (!found) return undefined;
      await lockWorkspace(client, found.id, lockMode, write);
      return (await client.query<WorkspaceRow>(workspaceQuery, [identity.principal, found.id])).rows[0];
    };
    let now = "";
    let workspace: WorkspaceRow | undefined;
    let staff: StaffRow | undefined;
    let auth: VerifiedClerkSession | undefined;
    for (let attempt = 1; ; attempt += 1) {
      await client.query(beginStatement(databaseLimits().request, snapshotRead ? 'ISOLATION LEVEL REPEATABLE READ' : undefined));
      if (runtimeIsolationEnabled()) {
        const verified = getAuth(req) as unknown as VerifiedClerkSession;
        isolationVerified = await bindRuntimeIdentity(client, { organizationId: verified.orgId || '', userId: verified.userId || '' });
      }
      // Single source of time: the database clock, read once per transaction.
      now = (await client.query<{ now: Date }>("SELECT now() AS now")).rows[0]!.now.toISOString();
      if (staffMode()) {
        auth = getAuth(req) as unknown as VerifiedClerkSession;
        if (access === 'persona') fail('Staff roles are assigned by an administrator. Demo role switching is unavailable.', 403);
        // Lock the organisation before its membership, consistently with team
        // changes. A revocation waits for in-flight work and blocks later work.
        const found = (await client.query<{ id: string }>('SELECT w.id FROM valopay_workspaces w JOIN valopay_teams t ON t.workspace_id=w.id WHERE t.organization_id=$1', [auth.orgId || ''])).rows[0];
        if (!found) fail('This organisation has not been provisioned for the pilot.', 403);
        await lockWorkspace(client, found.id, lockMode, write);
        workspace = (await client.query<WorkspaceRow>(`SELECT w.id,w.principal_hash,w.role FROM valopay_workspaces w JOIN valopay_teams t ON t.workspace_id=w.id WHERE t.organization_id=$1 AND w.id=$2 FOR ${access === 'team' ? 'UPDATE' : 'SHARE'} OF w`, [auth.orgId || '', found.id])).rows[0];
        if (!workspace) fail('This organisation has not been provisioned for the pilot.', 403);
        try {
          staff = (await client.query<StaffRow>('SELECT * FROM valopay_staff_memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE', [workspace.id, auth.userId])).rows[0];
        } catch (error) {
          if ((error as { code?: unknown }).code !== '40001') throw error;
          // A read whose membership a team change altered while it waited behind it. Under runtime isolation it is
          // refused, as it always was; otherwise it starts again, once, on a fresh snapshot, and so meets the change
          // as a read-committed read did.
          if (snapshotRead && attempt === 1 && !runtimeIsolationEnabled()) { await client.query("ROLLBACK"); continue; }
          fail('Your access changed while this request was waiting. Refresh and try again.', 409);
        }
        if (!staff) fail('An active staff membership is required. Accept an invitation or contact your administrator.', 403);
        now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.toISOString();
        verifyStaff(auth, staffProvision(staff, auth.orgId!), access !== 'read', now);
        break;
      }
      try { workspace = await lockedSandbox(); }
      catch (error) {
        // A read that waited behind a persona change finds its sandbox's row changed since its snapshot: it starts again, once, on a fresh one.
        if (!(snapshotRead && attempt === 1 && (error as { code?: unknown }).code === '40001')) throw error;
        await client.query("ROLLBACK");
        continue;
      }
      // A snapshot taken before another first visit committed the same sandbox could not see it.
      if (!workspace && snapshotRead) { await client.query("ROLLBACK"); snapshotRead = false; continue; }
      break;
    }
    if (!workspace && !staffMode()) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [identity.principal]);
      // Another first visit may have finished seeding while we waited.
      workspace = await lockedSandbox();
    }
    if (!workspace) {
      // A new anonymous sandbox seeds two lenders; creation is bounded per client network, per IPv6 /48 and per process on top of the request limit.
      const refused = identity.authenticated ? undefined : sandboxCreation.take(identity.address);
      if (refused) throw Object.assign(new Error(creationRefusalMessage(refused)), { status: 429, retryAfterSeconds: WORKSPACE_CREATION_RETRY_AFTER_SECONDS });
      const inserted = (await client.query<WorkspaceRow>(
        `INSERT INTO valopay_workspaces(id,principal_hash,role) VALUES($1,$2,'Admin')
         ON CONFLICT (principal_hash) DO NOTHING RETURNING id,principal_hash,role`,
        [randomUUID(), identity.principal],
      )).rows[0];
      // No other transaction can see the new row before this one commits, so its lock never waits.
      if (inserted) await lockWorkspace(client, inserted.id, lockMode, write);
      workspace = inserted || await lockedSandbox();
      if (!workspace) throw new Error("Workspace bootstrap could not be completed.");
      if (inserted) {
        await seedWorkspace(client, workspace, identity.principal, !identity.authenticated, now);
        // When explicitly enabled, each new anonymous sandbox pays for a few expired ones without a scheduler.
        // The sweep runs inside a savepoint: one that is slow, meets a lock or deadlocks is undone and left to
        // a later bootstrap, and never fails this visitor's.
        if (!identity.authenticated && expiredWorkspaceCleanupEnabled(process.env["VALOPAY_EXPIRED_WORKSPACE_CLEANUP"])) {
          await client.query("SAVEPOINT expired_workspace_sweep");
          try {
            const { files } = await sweepExpiredWorkspaces(client, SWEEP_BATCH);
            await client.query("RELEASE SAVEPOINT expired_workspace_sweep");
            swept = files;
          } catch (error) {
            try { await client.query("ROLLBACK TO SAVEPOINT expired_workspace_sweep"); } catch { throw error; }
            (req as { log?: SweepLog }).log?.warn?.({ event: "workspace.sweep_failed", err: error }, "Expired sandboxes were left for a later sweep");
          }
        }
      }
    }
    context = Object.freeze({
      authenticated: identity.authenticated, role: staff?.role || workspace.role, principalId: identity.principal,
      actor: staff ? `Clerk:${staff.user_id}` : `Sandbox ${workspace.role}`, now, accessMode: staff ? 'staff' : 'sandbox',
    });
    sessions.set(context, { client, workspace, principal: workspace.principal_hash, owner: identity.principal, active: true, access,
      operationId: requestOperations.get(req)?.id, userId: staff?.user_id, organizationId: auth?.orgId || undefined, isolationVerified, snapshotRead });
    // Every identity check has passed: from here a read cannot write.
    if (snapshotRead) await client.query("SET TRANSACTION READ ONLY");
    const result = await fn(context);
    committing = true;
    const committed = await client.query("COMMIT");
    // PostgreSQL accepts COMMIT after a caught statement error by returning
    // ROLLBACK.  Do not let a caller that swallowed that error observe success.
    if (committed.command !== "COMMIT") throw markRolledBack(new Error("The workspace transaction was rolled back."));
    sweptAndCommitted = swept;
    // The sandbox exists now: requests that name it are limited as it, not as their network (request-limits.ts).
    if (!staff && !identity.authenticated) rememberSandbox(identity.principal);
    return result;
  } catch (error) {
    if (guard) try { await guard.client.query("ROLLBACK"); } catch { /* transaction is already closed */ }
    // A limit reached before COMMIT is a 503 that says nothing was saved; a connection lost during COMMIT stays unconfirmed.
    const failed = failedTransaction(error, { committing, lost: guard?.lost(), write });
    if (failed !== error) throw failed;
    // Before COMMIT was sent nothing was saved; a failed COMMIT's outcome is unknown.
    if (!committing) markRolledBack(error);
    if (databaseConflictCodes.has((error as { code?: string } | undefined)?.code || "")) {
      conflict("Operation conflicts with the current lender state.");
    }
    throw error;
  } finally {
    if (context) {
      const session = sessions.get(context);
      if (session) { session.active = false; session.snapshot = undefined; session.summarised = undefined; session.auditChain = undefined; session.auditCheck = undefined; session.lockedMerchantId = undefined; }
    }
    guard?.release();
    leave?.();
    // Private storage, with the connection and the lender share already given back; it never fails this request.
    if (sweptAndCommitted.length) await removeSweptExportFiles(sweptAndCommitted, (req as { log?: SweepLog }).log);
  }
}

/** List is explicitly constrained by the server-derived workspace principal. */
export async function listMerchants(context: StoreContext) {
  const session = sessionFor(context);
  return (await session.client.query<{ info: DomainState["merchant"] }>(
    `SELECT m.info FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id
     WHERE m.workspace_id=$1 AND w.id=$1 AND w.principal_hash=$2
       AND ($3::boolean OR EXISTS (SELECT 1 FROM valopay_staff_lender_access grant_row JOIN valopay_staff_memberships member ON member.id=grant_row.membership_id WHERE grant_row.merchant_id=m.id AND member.workspace_id=$1 AND member.user_id=$4 AND member.status='active' AND member.expires_at>clock_timestamp())) ORDER BY m.id`,
    [session.workspace.id, session.principal, context.accessMode !== 'staff' || context.role === 'Admin', session.userId || ''],
  )).rows.map((row) => row.info);
}

/**
 * Lock membership before loading records.  A context becomes bound to one
 * merchant, preventing a confused caller from switching tenant mid-operation.
 * A mutation takes the exclusive row lock that serializes validation, allocations,
 * idempotency and audit sequencing. A read takes none: its snapshot is one
 * consistent state, so it never waits for a mutation (inWorkspace); a share
 * lock remains for a read in a read-committed transaction (a first visit's).
 * The journal's own reads take none. A journaled write holds its entry before
 * it waits for the lender (holdOperation).
 */
async function readMerchant(context: StoreContext, merchantId: string, lock: MerchantLock = "share"): Promise<MerchantRow> {
  const session = sessionFor(context);
  if (session.access === "read" && lock === "update") conflict("A read transaction cannot acquire a lender write lock.");
  if (session.lockedMerchantId && session.lockedMerchantId !== merchantId) conflict("A transaction may operate on only one lender.");
  if (session.operationId && lock === 'update') await holdOperation(session);
  const merchant = (await session.client.query<MerchantRow>(
    scopedMerchantQuery(lock === 'share' && (session.snapshotRead || (runtimeIsolationEnabled() && context.role === 'Read-only')) ? 'none' : lock),
    [merchantId, session.workspace.id, session.principal],
  )).rows[0];
  if (!merchant) fail("Lender not found in this workspace.", 404);
  if (context.accessMode === 'staff' && context.role !== 'Admin') {
    const grant = (await session.client.query(`SELECT 1 FROM valopay_staff_lender_access grant_row JOIN valopay_staff_memberships member ON member.id=grant_row.membership_id WHERE grant_row.merchant_id=$1 AND member.workspace_id=$2 AND member.user_id=$3 AND member.status='active' AND member.expires_at>clock_timestamp()`, [merchantId, session.workspace.id, session.userId])).rows[0];
    if (!grant) fail('Lender not found in your permitted workspace access.', 404);
  }
  if (session.operationId && lock === 'update') {
    const operation = (await session.client.query<Pick<OperationRow, 'actor' | 'role' | 'status'>>('SELECT actor,role,status FROM valopay_operations WHERE id=$1 AND merchant_id=$2 AND owner=$3', [session.operationId, merchantId, session.owner || session.principal])).rows[0];
    if (!operation || operation.actor !== context.actor || operation.role !== context.role || operation.status === 'cancelled') fail('This request has been cancelled or your authority changed. Refresh Operations.', 409);
  }
  session.lockedMerchantId = merchantId;
  if (merchant.info.id !== merchantId) conflict("Lender identity does not match its stored scope.");
  return merchant;
}

/**
 * A daily close as the domain reads earlier closes: its summary and the
 * unallocated and exception totals, without the full REC-07 arrays. The stored
 * close is decompressed once (`|| '{}'` makes an in-memory copy of a close's
 * data object), not once for each part taken from it: for a year of closes
 * that is about a quarter of the time.
 */
const closeSummarySql = "(SELECT (s.d - 'report' - 'operational' - 'metrics') || CASE WHEN s.d ? 'report' THEN jsonb_build_object('report',jsonb_build_object('unallocated',s.d#>'{report,unallocated}','exceptions',s.d#>'{report,exceptions}')) ELSE '{}'::jsonb END FROM (SELECT r.data || '{}'::jsonb AS d OFFSET 0) s)";
/** Closes this recent stay whole in a load; the latest close, which a Finance review hashes, is always among them. */
const FULL_CLOSE_DAYS = 7;

/**
 * Where a lender's audit chain stands, kept in its settings (`auditChain`) as
 * the close cursor is: the head, which the next entry follows, `verified`,
 * the last entry read back from the database and verified, and `broken` once
 * a completed write, verify_audit or the daily check has recorded a break:
 * the entry it stopped at, the one after `verified` (a read such as the
 * overview stores nothing). `at` is an entry's creation time, and `walkedAt`
 * when the last walk of the whole chain that recorded its result began reading
 * (readAuditChain). The entries stay in valopay_records (kind `audit`) and are
 * not part of a loaded state: appendAudit needs only the head.
 */
type ChainPoint = AuditPoint & { at?: string };
type AuditChain = ChainPoint & { verified: ChainPoint; broken?: { sequence: number }; walkedAt?: string };
function chainPoint(value: unknown): ChainPoint | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { sequence, hash, at } = value as Record<string, unknown>;
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 0 || typeof hash !== "string" || !hash) return undefined;
  if (at !== undefined && (typeof at !== "string" || !Number.isFinite(Date.parse(at)))) return undefined;
  return { sequence: sequence as number, hash, ...(at === undefined ? {} : { at }) };
}
/** The stored chain position, or undefined for a lender that has none yet (created before it was kept) or a state built in memory. */
function storedChain(settings: Record<string, any>): AuditChain | undefined {
  const head = chainPoint(settings.auditChain), verified = chainPoint(settings.auditChain?.verified);
  if (!head || !verified || verified.sequence > head.sequence) return undefined;
  // A break is kept as a check records it, at the entry after the verified one.
  const broken = settings.auditChain.broken?.sequence === verified.sequence + 1, walkedAt = settings.auditChain.walkedAt;
  return { ...head, verified, ...(broken ? { broken: { sequence: verified.sequence + 1 } } : {}), ...(typeof walkedAt === "string" && Number.isFinite(Date.parse(walkedAt)) ? { walkedAt } : {}) };
}
/**
 * An entry's sequence when it is a whole number from 1, as chainSequence
 * reads it, else NULL: the sequence of a damaged entry (text, null, a
 * fraction) is never cast. The entry is `r`.
 */
export const chainSequenceSql = `CASE WHEN jsonb_typeof(r.data->'sequence')='number' THEN CASE WHEN (r.data->>'sequence')::numeric BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
  AND trunc((r.data->>'sequence')::numeric)=(r.data->>'sequence')::numeric THEN (r.data->>'sequence')::numeric END END`;
/**
 * How much earlier than the verified entry a later entry may be stamped. An
 * entry carries its transaction's start time, and a transaction appends only
 * once it holds the lender, after waits each bounded by the lock limit.
 */
const CHAIN_MARGIN_MINUTES = 5;
/**
 * Reads the lender's audit entries after the verified entry, or after the head
 * while the lender keeps a break (all of them with `full`, or for a lender
 * with no stored position), and walks them from there. The head is the last
 * entry by sequence, whoever wrote it: the export worker and an earlier build
 * append without moving the stored head. A stored head further on than any
 * entry means entries went missing: the chain is broken and that sequence is
 * never issued again. Each read also takes in the entries of its time range
 * whose sequence is not a whole number, whatever that holds (only a whole
 * number can be the head), and the walk finds each one a break.
 *
 * The verified entry it returns, which the next entry appended records, is
 * always before the first entry that breaks the chain: a changed entry, a
 * missing one, a sequence two entries claim (a fork) or a damaged one; and
 * the break is recorded with it. While the lender keeps a break, a check
 * reads only the entries after the head, still following what other writers
 * appended, so the overview's alert stays on at the recorded entry after any
 * later write, and a save or an overview costs what it costs on a valid
 * chain however many entries follow the break. Only the walk of the whole
 * chain (`full`, verify_audit's and the daily check's) reads every entry
 * again: it records the break it finds, or none once the chain is valid again,
 * and `walkedAt`, the database's time as it began reading: before the
 * snapshot of verify_audit's read, and after that of the daily check's, which
 * its transaction took with its first statement (checkAuditChainDaily).
 */
async function readAuditChain(session: Session, merchantId: string, settings: Record<string, any>, full = false) {
  const stored = storedChain(settings), known = full ? undefined : stored?.broken;
  const walkedAt = full ? (await session.client.query<{ at: Date }>("SELECT statement_timestamp() AS at")).rows[0]!.at.toISOString() : stored?.walkedAt;
  const stamp = walkedAt ? { walkedAt } : {};
  const storedHead: ChainPoint | undefined = stored && { sequence: stored.sequence, hash: stored.hash, ...(stored.at ? { at: stored.at } : {}) };
  const from: ChainPoint = full || !stored ? AUDIT_GENESIS : known ? storedHead! : stored.verified;
  const rows = (await session.client.query<{ id: string; data: Record<string, any>; created_at: Date }>(
    `SELECT r.id,r.data,r.created_at ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND r.kind='audit'
       AND ($4::timestamptz IS NULL OR r.created_at >= $4::timestamptz - make_interval(mins => ${CHAIN_MARGIN_MINUTES}))
       AND ($5::bigint = 0 OR COALESCE(${chainSequenceSql} > $5::bigint, true))
     ORDER BY r.created_at,r.id`,
    [merchantId, session.workspace.id, session.principal, from.sequence ? from.at ?? null : null, from.sequence],
  )).rows;
  const walk = walkAuditChain(rows, from);
  let head: ChainPoint = from, valid = walk.valid;
  for (const row of rows) {
    const sequence = chainSequence(row.data.sequence);
    if (sequence !== undefined && sequence > head.sequence) head = { sequence, hash: String(row.data.hash), at: row.created_at.toISOString() };
  }
  if (storedHead && storedHead.sequence > head.sequence) { head = storedHead; valid = false; }
  if (known) return { chain: { ...head, verified: stored!.verified, broken: known, ...stamp } as AuditChain, verification: { valid: false, count: walk.count, headHash: walk.headHash } };
  const verified: ChainPoint = walk.entry ? { ...walk.verified, at: walk.entry.created_at.toISOString() } : from;
  return { chain: { ...head, verified, ...(valid ? {} : { broken: { sequence: verified.sequence + 1 } }), ...stamp } as AuditChain, verification: { valid, count: walk.count, headHash: walk.headHash } };
}

export async function loadState(context: StoreContext, merchantId: string, lock: Exclude<MerchantLock, "none"> = "update", options: { wholeCloses?: number; wholeCloseIds?: string[]; closeReviewIds?: string[] } = {}): Promise<DomainState> {
  const session = sessionFor(context);
  const merchant = await readMerchant(context, merchantId, lock);
  // Every load has earlier closes as summaries: each stored report is about
  // 100 KB, and a year of them used to be reloaded with every request. The
  // latest week's stay whole, and `wholeCloses` more of the newest for a view
  // that shows them. The full reports stay in PostgreSQL (the close history
  // opens one); saveState refuses to change them. The audit chain is never
  // loaded: a write continues it from the head in the lender's settings.
  const whole = Math.max(0, Math.floor(options.wholeCloses ?? 0));
  if ((options.wholeCloseIds?.length ?? 0) > 1 || (options.closeReviewIds?.length ?? 0) > 1) fail('Open one historical close at a time.', 400);
  const rows = (await session.client.query<RecordRow & { summarised: boolean }>(
    `WITH recent AS (SELECT least(max(created_at) - make_interval(days => $4), CASE WHEN $5::int > 0 THEN
         (SELECT created_at FROM valopay_records WHERE merchant_id=$1 AND kind='closes' ORDER BY created_at DESC OFFSET $5::int - 1 LIMIT 1) END) AS cutoff
       FROM valopay_records WHERE merchant_id=$1 AND kind='closes'),
     loaded AS (SELECT r.*, (r.kind='closes' AND r.created_at < recent.cutoff AND NOT (r.id=ANY($6::text[]) OR r.id IN
       (SELECT data->>'closeId' FROM valopay_records WHERE merchant_id=$1 AND kind='close-reviews' AND id=ANY($7::text[])))) AS summarised
       FROM valopay_records r JOIN valopay_merchants m ON m.id=r.merchant_id
       JOIN valopay_workspaces w ON w.id=m.workspace_id CROSS JOIN recent
       WHERE r.merchant_id=$1 AND m.workspace_id=$2 AND w.id=$2 AND w.principal_hash=$3 AND r.kind<>'audit')
     SELECT r.id,r.merchant_id,r.kind,r.name,r.status,r.reference,r.amount_kobo,r.customer_id,
       CASE WHEN r.summarised THEN ${closeSummarySql} ELSE r.data END AS data,r.created_at,r.updated_at,r.summarised
     FROM loaded r ORDER BY r.created_at,r.id`,
    [merchantId, session.workspace.id, session.principal, FULL_CLOSE_DAYS, whole, options.wholeCloseIds ?? [], options.closeReviewIds ?? []],
  )).rows;
  // Protected source rows stay sealed: only the views that show or use them open them (revealImportPayloads).
  const state: DomainState = { merchant: merchant.info, settings: merchant.settings, records: rows.map(rowToRecord) };
  if (state.merchant.id !== merchantId) conflict("Lender identity does not match its stored scope.");
  // A write verifies the entries appended since the last verified one (usually the previous write's), or since the
  // head once the lender keeps a break, and takes the head from them, so an entry written without moving the stored
  // head is followed, never forked. The position is kept aside until an entry is appended: the lender's settings stay
  // as a read sees them.
  const checked = lock === "update" ? await readAuditChain(session, merchantId, state.settings) : undefined;
  session.auditChain = checked?.chain;
  // The write records a break it found with its entry, so the lender keeps it once the write commits.
  session.auditCheck = checked && { ...checked.verification, verifiedSequence: checked.chain.verified.sequence, kept: !checked.verification.valid };
  // A shared load is read-only, even in an otherwise write-capable context.
  // Avoid serialising the entire history just to serve a dashboard or export lookup.
  session.snapshot = lock === "update" ? snapshotOf(state) : undefined;
  session.summarised = lock === "update" ? new Set(rows.filter((row) => row.summarised).map((row) => row.id)) : undefined;
  return state;
}

/**
 * The overview's view of the audit chain, from the same snapshot as its load:
 * the entries after the last verified one checked (incrementally, as each
 * write checks them, and from the head while the lender keeps a break), and
 * the eight most recent entries, newest first. A read stores nothing: a break
 * it finds is kept only once a completed write, verify_audit or the daily
 * check records it, and until then it clears if the chain is repaired.
 */
export async function auditOverview(context: StoreContext, state: DomainState) {
  const session = sessionFor(context), merchantId = state.merchant.id;
  if (session.lockedMerchantId !== merchantId) conflict("Load this lender before reading its audit log.");
  const { chain, verification } = await readAuditChain(session, merchantId, state.settings);
  const recent = (await session.client.query<RecordRow>(`SELECT ${recordColumns} ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND r.kind='audit' ORDER BY r.created_at DESC,r.id LIMIT 8`,
    [merchantId, session.workspace.id, session.principal])).rows.map(rowToRecord);
  // The alert names the entry after the last verified one: the break the lender keeps, or the one this check found.
  return { verification: { ...verification, verifiedSequence: chain.verified.sequence, kept: Boolean(storedChain(state.settings)?.broken) }, recent };
}

/**
 * The lender's audit chain as this write checked it when it loaded the lender
 * (loadState), for a daily close's alerts: a break it found is recorded with
 * the write's entry, so the lender keeps it once the write commits.
 */
export function writeAuditCheck(context: StoreContext, state: DomainState): AuditVerification | undefined {
  const session = sessionFor(context);
  return session.lockedMerchantId === state.merchant.id ? session.auditCheck : undefined;
}

/**
 * The whole audit chain verified from its first entry (verify_audit): the
 * lender's position records how far it held and the break it found, or none
 * once the chain is valid again (readAuditChain), and the entry verify_audit
 * appends stores it. So a break found here, however early in the chain, is
 * what the overview reports from then on, and only a walk of the whole chain,
 * this or the daily check (checkAuditChainDaily), clears it.
 */
export async function verifyAuditTrail(context: StoreContext, state: DomainState) {
  const session = sessionFor(context), merchantId = lockedMerchant(session);
  if (state.merchant.id !== merchantId) conflict("Load this lender before checking its audit log.");
  const { chain, verification } = await readAuditChain(session, merchantId, state.settings, true);
  session.auditChain = chain;
  return verification;
}

/** Whether the daily check of the lender's whole audit chain is still to run on the WAT day of `now` (settings.dailyAuditCheckAt). */
export function dailyAuditCheckDue(settings: Record<string, any>, now: string): boolean {
  const at = typeof settings.dailyAuditCheckAt === "string" ? Date.parse(settings.dailyAuditCheckAt) : Number.NaN;
  return !Number.isFinite(at) || watDate(at) !== watDate(Date.parse(now));
}

/** What the daily check found: the chain valid or not, its entries, the last verified entry, the entry it stopped at, and whether it cleared a recorded break. */
export interface DailyAuditCheck { valid: boolean; entries: number; verifiedSequence: number; brokenAt?: number; cleared: boolean; walkMs: number }

/**
 * The daily check of a lender's whole audit chain, which the background
 * worker runs once the lender's first daily close of each WAT day has
 * committed (close-scheduler.ts). It walks every entry from the first, as
 * verify_audit does, on one snapshot that takes no lock, so no write waits
 * for the walk. Then, holding the lender for a moment, it checks the entries
 * appended since from where the walk verified to (readAuditChain, as a write
 * does) and stores what it found as verify_audit does: the last verified
 * entry and the break, or none once the chain is valid again, which clears a
 * recorded break. What is newer than the walk stays: the result of a walk of
 * the whole chain that began reading after this one did (verify_audit's, by
 * `walkedAt`), and a break a write recorded after the snapshot at an entry
 * the walk read intact. `dailyAuditCheckAt` records the check, and undefined
 * means none ran: the day's check had already run, or the lender is gone.
 */
export async function checkAuditChainDaily(merchantId: string): Promise<DailyAuditCheck | undefined> {
  const started = Date.now();
  const walked = await lenderTransaction(merchantId, false, async (session, settings, now) => {
    if (!dailyAuditCheckDue(settings, now)) return undefined;
    return { ...(await readAuditChain(session, merchantId, settings, true)), recorded: storedChain(settings)?.broken?.sequence };
  });
  if (!walked) return undefined;
  const walkMs = Date.now() - started;
  return lenderTransaction(merchantId, true, async (session, settings, now) => {
    if (!dailyAuditCheckDue(settings, now)) return undefined;
    const stored = storedChain(settings), found = walked.chain;
    const newer = (stored?.walkedAt !== undefined && Date.parse(stored.walkedAt) > Date.parse(found.walkedAt!))
      || (stored?.broken && stored.broken.sequence !== walked.recorded && stored.broken.sequence <= found.verified.sequence);
    let chain = stored!;
    if (!newer) {
      // The later head of the two, so an entry missing since the snapshot is still a break and its sequence never issued again.
      const { sequence, hash, at } = stored && stored.sequence > found.sequence ? stored : found;
      ({ chain } = await readAuditChain(session, merchantId, { auditChain: { sequence, hash, at, verified: found.verified, ...(found.broken ? { broken: found.broken } : {}), walkedAt: found.walkedAt } }));
    }
    await session.client.query("UPDATE valopay_merchants SET settings = settings || jsonb_build_object('auditChain', $2::jsonb, 'dailyAuditCheckAt', $3::text) WHERE id=$1", [merchantId, JSON.stringify(chain), now]);
    return { valid: !chain.broken, entries: walked.verification.count, verifiedSequence: chain.verified.sequence, ...(chain.broken ? { brokenAt: chain.broken.sequence } : {}), cleared: Boolean(stored?.broken && !chain.broken), walkMs };
  });
}

/**
 * One system transaction on a lender for a background job, with the system
 * limits and, under runtime isolation, the service identity. With `lock` it
 * holds the lender until it commits, waiting up to the lock limit for a write
 * that holds it; without, it reads one snapshot and takes no lock. Undefined
 * when the lender no longer exists.
 */
async function lenderTransaction<T>(merchantId: string, lock: boolean, fn: (session: Session, settings: Record<string, any>, now: string) => Promise<T>): Promise<T | undefined> {
  const guard = await checkOut(() => pool.connect()), client = guard.client;
  let committing = false;
  try {
    await client.query(beginStatement(databaseLimits().system, lock ? undefined : "ISOLATION LEVEL REPEATABLE READ"));
    await bindRuntimeService(client);
    const scope = (await client.query<{ workspace_id: string; principal_hash: string; role: string; settings: Record<string, any> | null; now: Date }>(
      `SELECT m.workspace_id,w.principal_hash,w.role,m.settings,now() AS now FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id
       WHERE m.id=$1${lock ? " FOR UPDATE OF m" : ""}`,
      [merchantId],
    )).rows[0];
    if (!scope) { await client.query("ROLLBACK"); return undefined; }
    const session: Session = { client, workspace: { id: scope.workspace_id, principal_hash: scope.principal_hash, role: scope.role }, principal: scope.principal_hash, active: true, access: lock ? "write" : "read" };
    const result = await fn(session, scope.settings ?? {}, scope.now.toISOString());
    committing = true;
    const committed = await client.query("COMMIT");
    if (committed.command !== "COMMIT") throw new Error("The system transaction was rolled back.");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* transaction is already closed */ }
    throw failedTransaction(error, { committing, lost: guard.lost(), write: lock });
  } finally {
    guard.release();
  }
}

/**
 * Opens the protected source rows (original CSV and validation check) of this
 * lender's import batches that `select` names, at most four key-service calls
 * at a time, and returns how many batches it opened. A full-state load keeps
 * them sealed, so overviews, saves, the scheduled close and Paystack test
 * deliveries never need the key service to open them (a keyed save still seals
 * its journal entry, and a batch save its rows). Only a view that shows or
 * uses raw source rows calls this, and in a write it must call it before the
 * domain changes the batch: the opened form becomes the batch's loaded form,
 * so an opened but unchanged batch is not written back and the immutability
 * checks compare like with like. A field already open costs nothing.
 */
export async function revealImportPayloads(context: StoreContext, state: DomainState, select: (record: ValopayRecord) => boolean, fields: readonly ProtectedImportField[] = PROTECTED_IMPORT_FIELDS): Promise<number> {
  const session = sessionFor(context);
  if (!session.lockedMerchantId || session.lockedMerchantId !== state.merchant.id) conflict("Load this lender before opening its source rows.");
  const targets = state.records.filter((record) => record.kind === "import-batches" && record.merchantId === session.lockedMerchantId
    && fields.some((field) => isProtectedPayload(record.data[field])) && select(record));
  if (!targets.length) return 0;
  const snapshot = session.snapshot;
  if (snapshot && targets.some((record) => snapshot.records.get(record.id) !== JSON.stringify(record))) throw new Error("Protected source rows must be opened before the batch changes.");
  const opened = await revealRecordsData(targets, fields);
  targets.forEach((record, index) => {
    record.data = opened[index]!.data;
    snapshot?.records.set(record.id, JSON.stringify(record));
  });
  return targets.length;
}

/**
 * After a mutation and before its response is built: every changed record
 * gets a strictly newer version, so the response carries it, and the audit
 * entry receives digests of exactly the records the request added or changed,
 * before and after, with the lender's settings. Unchanged records are never
 * canonicalised; before this, every save hashed the whole lender twice.
 */
export function settleChanges(context: StoreContext, state: DomainState): { beforeDigest: string; afterDigest: string; changedRecords: number } {
  const session = sessionFor(context);
  lockedMerchant(session);
  const snapshot = session.snapshot!;
  const { changed } = changesSince(snapshot, state);
  advanceChanged(snapshot, changed, context.now);
  const byId = (a: ValopayRecord, b: ValopayRecord) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const previous = changed.filter((record) => snapshot.records.has(record.id)).map((record) => JSON.parse(snapshot.records.get(record.id)!) as ValopayRecord).sort(byId);
  return {
    // In the audit entry's form: they are committed to by its change digest.
    beforeDigest: canonicalDigest({ merchant: JSON.parse(snapshot.merchant), settings: JSON.parse(snapshot.settings), records: previous }, "legacy-en-us-null"),
    afterDigest: canonicalDigest({ merchant: state.merchant, settings: state.settings, records: [...changed].sort(byId) }, "legacy-en-us-null"),
    changedRecords: changed.length,
  };
}

/** Records this write transaction added since it loaded the lender. */
export function addedRecords(context: StoreContext, state: DomainState): ValopayRecord[] {
  const session = sessionFor(context);
  lockedMerchant(session);
  return state.records.filter((record) => !session.snapshot!.records.has(record.id));
}

/**
 * The record a write's audit entry is about, of those its route can vouch for:
 * the one its path names; else the one its parsed body names, when the write
 * added or changed it or answers with it; else the one its answer names
 * (`record.id`, or `id`), when the lender has it; else `fallback`. An id a
 * client wrote that the write did not act on is never the object.
 */
export function auditObject(context: StoreContext, state: DomainState, names: { path?: unknown; body?: string; answer?: unknown }, fallback: string): string {
  const session = sessionFor(context);
  lockedMerchant(session);
  if (typeof names.path === "string" && names.path) return names.path;
  const shown = names.answer as { id?: unknown; record?: { id?: unknown } } | null | undefined;
  const answered = typeof shown?.record?.id === "string" ? shown.record.id : typeof shown?.id === "string" ? shown.id : undefined;
  const byId = (id: string) => state.records.find((record) => record.id === id);
  if (names.body) {
    const named = byId(names.body), loaded = session.snapshot!.records.get(names.body);
    if (named && (names.body === answered || loaded === undefined || recordChanged(loaded, named))) return names.body;
  }
  return answered && byId(answered) ? answered : fallback;
}

const recordColumns = "r.id,r.merchant_id,r.kind,r.name,r.status,r.reference,r.amount_kobo,r.customer_id,r.data,r.created_at,r.updated_at";
const scopedRecordsFrom = `FROM valopay_records r JOIN valopay_merchants m ON m.id=r.merchant_id
  JOIN valopay_workspaces w ON w.id=m.workspace_id`;
const scopedRecordsWhere = "r.merchant_id=$1 AND m.workspace_id=$2 AND w.id=$2 AND w.principal_hash=$3";

/** A list never loads unrelated kinds or constructs a writable DomainState.
 * No search: PostgreSQL calculates the count and returns only the page.
 * Search: the JavaScript fold (matchesSearch) over each record's name,
 * reference and data values as the list shows them (an export without its
 * private storage fields), scanning bounded batches of this kind; only the
 * requested page is retained. Search indexing is a separate change. Closes are
 * listed, and searched, as their summaries, as the reports view reads them: a
 * whole close carries its full report (about 100 KB), which the close history
 * opens one at a time (getCloseDetail).
 */
export async function listRecords(context: StoreContext, merchantId: string, kind: string, query: ListQuery) {
  const session = sessionFor(context);
  await readMerchant(context, merchantId);
  const columns = kind === "closes" ? recordColumns.replace("r.data", `${closeSummarySql} AS data`) : recordColumns;
  const params: unknown[] = [merchantId, session.workspace.id, session.principal, kind];
  let where = `${scopedRecordsWhere} AND r.kind=$4`;
  const filter = (column: string, value: unknown) => { params.push(value); where += ` AND ${column}=$${params.length}`; };
  if (query.status && query.status !== "all") {
    // inListStatus: a saved export whose file retention removed is listed as expired, never under its job's status.
    const removed = "coalesce(r.data->>'fileDeletedAt','') <> ''";
    if (kind !== "exports") filter("r.status", query.status);
    else if (query.status === EXPIRED_EXPORT_STATUS) where += ` AND ${removed}`;
    else { filter("r.status", query.status); where += ` AND NOT ${removed}`; }
  }
  if (query.customerId) filter("r.customer_id", query.customerId);
  if (query.id) filter("r.id", query.id);
  // canTakeAllocation in SQL: something still owed (the outstanding balance when it is a whole number, else the amount), a status that takes one,
  // and no hold for a renewed reversal review (a non-empty legacyReversalReviewIds list). CASE tries its conditions in order, so a balance is read as
  // a number only once it is known to be one, and a list's length is read only once it is known to be a list.
  if (allocatableOnly(kind, query)) {
    params.push([...allocationClosedStatuses]);
    where += ` AND r.status <> ALL($${params.length}::text[]) AND (CASE WHEN jsonb_typeof(r.data->'outstandingKobo') IS DISTINCT FROM 'number' THEN r.amount_kobo WHEN (r.data->>'outstandingKobo')::numeric % 1 <> 0 THEN r.amount_kobo ELSE (r.data->>'outstandingKobo')::numeric END) > 0`
      + ` AND (CASE WHEN jsonb_typeof(r.data->'legacyReversalReviewIds') = 'array' THEN jsonb_array_length(r.data->'legacyReversalReviewIds') = 0 ELSE true END)`;
    // One payment's choices: the payer rule of its manual allocation (allocationPayer) becomes a customer filter.
    if (query.paymentId !== undefined) {
      const scope = [merchantId, session.workspace.id, session.principal];
      const row = (await session.client.query<RecordRow>(`SELECT ${recordColumns} ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND r.kind='payments' AND r.id=$4`, [...scope, query.paymentId])).rows[0];
      const payment = row ? rowToRecord(row) : fail("Payment not found in this lender. Refresh the payments and choose one again.", 404);
      const named = !payment.customerId && typeof payment.data.dueItemId === "string" && payment.data.dueItemId
        ? (await session.client.query<{ customer_id: string }>(`SELECT r.customer_id ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND r.kind='due-items' AND r.id=$4`, [...scope, payment.data.dueItemId])).rows[0]?.customer_id : undefined;
      const choices = allocationChoices(query, allocationPayer(payment, named));
      if (!choices) return { items: [], total: 0 };
      if (choices.customerId !== query.customerId) filter("r.customer_id", choices.customerId);
    }
  }
  if (query.updatedSince) {
    params.push(new Date(updatedSinceInstant(query.updatedSince)).toISOString()); where += ` AND r.updated_at >= $${params.length}::timestamptz`;
  }
  const offset = Number.isInteger(query.offset) && Number(query.offset) > 0 ? Number(query.offset) : 0;
  // A kind that grows with history is capped even without a limit (listLimit).
  const limit = listLimit(kind, query.limit);
  let items: ValopayRecord[] = [], total: number;
  if (!query.search) {
    // The read's snapshot keeps the separate total and page coherent with writes.
    total = Number((await session.client.query<{ total: string }>(`SELECT count(*) AS total ${scopedRecordsFrom} WHERE ${where}`, params)).rows[0]!.total);
    const values = [...params, offset];
    let paging = ` OFFSET $${values.length}`;
    if (limit !== undefined) { values.push(limit); paging += ` LIMIT $${values.length}`; }
    if (offset < total) items = (await session.client.query<RecordRow>(`SELECT ${columns} ${scopedRecordsFrom} WHERE ${where} ORDER BY r.created_at DESC,r.id DESC${paging}`, values)).rows.map(rowToRecord);
  } else {
    const search = foldForSearch(query.search);
    total = 0;
    let cursor: { at: string; id: string } | undefined;
    while (true) {
      const values = [...params];
      let after = "";
      if (cursor) { values.push(cursor.at, cursor.id); after = ` AND (r.created_at,r.id) < ($${values.length - 1}::timestamptz,$${values.length}::text)`; }
      const batch = (await session.client.query<RecordRow & { cursor_at: string }>(`SELECT ${columns},r.created_at::text AS cursor_at ${scopedRecordsFrom} WHERE ${where}${after} ORDER BY r.created_at DESC,r.id DESC LIMIT ${LIST_PAGE_CEILING}`, values)).rows;
      for (const row of batch) {
        const record = rowToRecord(row);
        if (!matchesSearch(record.kind === "exports" ? publicExportRecord(record) : record, search)) continue;
        if (total >= offset && (limit === undefined || items.length < limit)) items.push(record);
        total++;
      }
      if (batch.length < LIST_PAGE_CEILING) break;
      const last = batch.at(-1)!; cursor = { at: last.cursor_at, id: last.id };
    }
  }
  const nextOffset = offset + items.length < total ? offset + items.length : undefined;
  return nextOffset === undefined ? { items, total } : { items, total, nextOffset };
}

/** Priority queues are counted and paged by PostgreSQL. Only the page and its
 * linked records cross the repository boundary; no writable state is loaded. */
export async function listQueue(context: StoreContext, merchantId: string, queue: QueueName, query: QueueQuery) {
  const session = sessionFor(context);
  await readMerchant(context, merchantId);
  const view = queueView(queue, query.view), limit = query.limit || 25;
  const values: unknown[] = [merchantId, session.workspace.id, session.principal, context.now, query.owner || '', query.type || '', query.record || '', foldForSearch(query.q || '')];
  // PostgreSQL 16's input check also handles malformed legacy dates without failing a queue.
  const timestamp = (text: string) => `CASE WHEN pg_input_is_valid(${text},'timestamp with time zone') THEN (CASE WHEN length(${text})=10 THEN ${text} || 'T00:00:00Z' ELSE ${text} END)::timestamptz END`;
  // When a deadline passes (deadlineEnds in the shared schema): a date-only one at the end of its WAT day, so it is
  // due all day and overdue after it; an impossible date (2026-02-30) is no deadline.
  const deadlineAt = (text: string) => `CASE WHEN (${text}) ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN (CASE WHEN pg_input_is_valid(${text},'date') THEN ((${text}) || 'T23:59:59.999+01:00')::timestamptz END)
    WHEN pg_input_is_valid(${text},'timestamp with time zone') THEN (${text})::timestamptz END`;
  const dueData = `CASE WHEN r.kind='attempts' THEN d.data ELSE r.data END`;
  const deadline = queue === 'exceptions' ? "r.data->>'dueBy'" : queue === 'mandates' ? "r.data->>'activationDeadline'" : `(${dueData})->>'dueDate'`;
  const owner = queue === 'collections' ? `coalesce(nullif((${dueData})->>'owner',''),'unassigned')` : "coalesce(nullif(r.data->>'owner',''),'Unassigned')";
  const kind = queue === 'collections' ? "(r.kind='due-items' OR r.kind='attempts' AND r.status='failed')" : `r.kind='${queue}'`;
  const unpaid = `coalesce((CASE WHEN r.kind='attempts' THEN d.status ELSE r.status END) NOT IN ('paid','closed','cancelled'),false)`;

  // Count/order only this queue's kinds. A failed attempt's instalment is read
  // by primary key from the same lender, one index probe per attempt: joining
  // the scoped set to itself made PostgreSQL compare every attempt with every
  // instalment (38 million pairs for one page of a 6,000-instalment lender).
  // OFFSET 0 keeps the lookup a primary-key probe whatever the statistics say:
  // as a plain join, a lender loaded since the last ANALYZE was estimated at
  // one row and each attempt scanned all its instalments (22 s for a
  // 25,000-record lender, past the statement limit). The lender and kind are
  // checked on the row the probe found.
  // A search term is matched once per queue row, in a lateral column (OFFSET 0 keeps it from being written back into
  // every filter) that the counts, the total, the page and its target all read, and against a customer only by a probe
  // of the row's own customer (OFFSET 0 keeps it a probe, which PostgreSQL caches per customer), so a customer the
  // queue holds many times is folded once and one it does not hold is never read. Written into each filter, the search
  // was folded again for every count, with a customer lookup and fold per row each time: about 300 ms for a searched
  // pilot-scale collections queue. Without a search term none of it is in the statement.
  const searching = values[7] !== '';
  const searchText = (expression: string) => `lower(regexp_replace(normalize(${expression},NFD), U&'[\\0300-\\036f]', '', 'g'))`;
  const matched = searching ? `
        LEFT JOIN LATERAL (SELECT true AS hit FROM valopay_records c WHERE c.id=r.customer_id AND c.merchant_id=$1 AND c.kind='customers' AND position($8 in ${searchText("concat_ws(' ',c.name,c.reference)")})>0 OFFSET 0) customer ON true
        CROSS JOIN LATERAL (SELECT (customer.hit IS NOT NULL OR position($8 in ${searchText("concat_ws(' ',r.name,r.reference)")})>0) AS matched OFFSET 0) m` : '';
  const cte = `WITH scoped AS (SELECT ${recordColumns} ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND ${kind}),
    b AS (SELECT r.*,${searching ? ' m.matched,' : ''} ${deadlineAt(deadline)} AS deadline_at, ${owner} AS queue_owner,
      ${unpaid} AS unpaid, ${timestamp("r.data->>'occurredAt'")} AS attempt_at
      FROM scoped r LEFT JOIN LATERAL (SELECT d.merchant_id,d.kind,d.status,d.data FROM valopay_records d WHERE r.kind='attempts' AND d.id=r.data->>'dueItemId' OFFSET 0) d
        ON d.merchant_id=r.merchant_id AND d.kind='due-items'${matched} WHERE ${kind}),
    q AS (SELECT b.*,coalesce(deadline_at < $4::timestamptz,false) AS overdue,
      coalesce(to_char(deadline_at AT TIME ZONE 'Africa/Lagos','YYYY-MM-DD') = to_char($4::timestamptz AT TIME ZONE 'Africa/Lagos','YYYY-MM-DD'),false) AS today FROM b)`;
  const conditions: Record<string, string> = queue === 'exceptions' ? {
    open: "status NOT IN ('closed','resolved')", high: "status NOT IN ('closed','resolved') AND data->>'severity'='high'",
    overdue: "status NOT IN ('closed','resolved') AND overdue", 'due-today': "status NOT IN ('closed','resolved') AND today", resolved: "status IN ('closed','resolved')",
  } : queue === 'mandates' ? { all: 'true', 'awaiting-activation': "status='pending_activation'", overdue: "status='pending_activation' AND overdue", 'due-today': "status='pending_activation' AND today" }
    : { all: "kind='due-items'", overdue: "kind='due-items' AND unpaid AND overdue", 'due-today': "kind='due-items' AND unpaid AND today", failed: "kind='attempts'" };
  // Without a search term the statement still names $8, so PostgreSQL knows its type.
  const ownerFilter = `${searching ? 'matched' : "$8=''"} AND ($5='' OR queue_owner=$5) AND ($6='' OR data->>'type'=$6)`;
  const selected = `${ownerFilter} AND (CASE WHEN $7<>'' THEN id=$7 ELSE (${conditions[view]}) END)`;
  const order = (queue === 'exceptions' ? "overdue DESC,CASE data->>'severity' WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,"
    : queue === 'mandates' ? "(status='pending_activation') DESC," : '(unpaid AND overdue) DESC,unpaid DESC,') + `deadline_at ASC NULLS LAST,${queue === 'collections' ? 'attempt_at ASC NULLS LAST,' : ''}id COLLATE "C"`;
  const summary = (await session.client.query<{ counts: Record<string, number>; owners: string[]; types: string[]; total: string }>(`${cte} SELECT
    json_build_object(${queueViews[queue].map(key => `'${key}',count(*) FILTER (WHERE ${ownerFilter} AND (${conditions[key]}))`).join(',')}) AS counts,
    coalesce(array_agg(DISTINCT queue_owner),ARRAY[]::text[]) AS owners,
    coalesce(array_agg(DISTINCT coalesce(data->>'type','unknown')),ARRAY[]::text[]) AS types,
    count(*) FILTER (WHERE ${selected}) AS total FROM q`, values)).rows[0]!;
  const total = Number(summary.total);
  let offset = Math.min(query.offset || 0, Math.max(0, Math.ceil(total / limit) - 1) * limit);
  if (query.target) {
    const located = (await session.client.query<{ position: string }>(`${cte}, ranked AS (SELECT id,row_number() OVER (ORDER BY ${order})-1 AS position FROM q WHERE ${selected}) SELECT position FROM ranked WHERE id=$9`, [...values, query.target])).rows[0];
    if (located) offset = Math.floor(Number(located.position) / limit) * limit;
  }
  const items = (await session.client.query<RecordRow>(`${cte} SELECT * FROM q WHERE ${selected} ORDER BY ${order} OFFSET $9 LIMIT $10`, [...values, offset, limit])).rows.map(rowToRecord);
  const related = new Map<string, ValopayRecord>();
  // Up to three link hops: attempt → instalment → mandate → policy. Each hop is lender scoped.
  for (let hop = 0; hop < 3; hop++) {
    const ids = [...new Set([...items, ...related.values()].flatMap(row => [row.customerId, row.data.dueItemId, row.data.mandateId, row.data.policyId]).filter((id): id is string => typeof id === 'string' && !!id && !related.has(id)))];
    if (!ids.length) break;
    const rows = (await session.client.query<RecordRow>(`SELECT ${recordColumns} ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND r.kind IN ('customers','due-items','mandates','policies') AND r.id=ANY($4::text[])`, values.slice(0, 3).concat([ids]))).rows;
    for (const row of rows) related.set(row.id, rowToRecord(row));
  }
  const dueIds = [...items, ...related.values()].filter(row => row.kind === 'due-items').map(row => row.id);
  if (dueIds.length) {
    const rows = (await session.client.query<RecordRow>(`SELECT DISTINCT ON (r.data->>'dueItemId') ${recordColumns} ${scopedRecordsFrom}
      WHERE ${scopedRecordsWhere} AND r.kind='attempts' AND r.status='failed' AND r.data->>'dueItemId'=ANY($4::text[])
      ORDER BY r.data->>'dueItemId',coalesce(${timestamp("r.data->>'occurredAt'")},r.created_at) DESC,r.id COLLATE "C"`, values.slice(0, 3).concat([dueIds]))).rows;
    for (const row of rows) related.set(row.id, rowToRecord(row));
  }
  if (queue === 'mandates' && query.record) {
    const rows = (await session.client.query<RecordRow>(`SELECT ${recordColumns} ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND r.kind='mandates' AND r.data->>'reissuedFrom'=$4 ORDER BY r.created_at DESC,r.id LIMIT 100`, values.slice(0, 3).concat(query.record))).rows;
    for (const row of rows) related.set(row.id, rowToRecord(row));
  }
  return { items, related: [...related.values()], total, offset, counts: summary.counts, owners: summary.owners.sort(), types: summary.types.sort(), asOf: context.now };
}

/** All queue predicates execute on the same snapshot of the read transaction. */
export async function listReconciliation(context: StoreContext, merchantId: string, queue: ReconciliationQueue, query: ReadPageQuery) {
  const session = sessionFor(context), merchant = await readMerchant(context, merchantId);
  const scope = [merchantId, session.workspace.id, session.principal];
  const limit = query.limit || 25;
  const select = (where: string) => `SELECT ${recordColumns} ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND ${where}`;
  let precision: ReturnType<typeof precisionAudit> | undefined;
  let sampledIds: string[] = [];
  if (queue === 'audit') {
    const month = previousMonth(context.now), seed = `${merchantId}:${month}`, { start, end } = periodBounds(month);
    // The audit month is a WAT month: confirmedAt (or the creation time) as a UTC ISO string inside [start, end). Stored
    // instants are UTC timestamps or dates, which compare as strings in the "C" collation the way the domain parses them.
    const at = `coalesce(nullif(r.data->>'confirmedAt',''),to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) COLLATE "C"`;
    const predicate = `r.kind='allocations' AND r.status IN ('confirmed','superseded') AND r.data->'automatic'='true'::jsonb AND r.data->>'confidence'='certain' AND ${at}>=$4 AND ${at}<$5`;
    const population = Number((await session.client.query<{total:string}>(`SELECT count(*) AS total ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND ${predicate}`, [...scope,start,end])).rows[0]!.total);
    const sample = (await session.client.query<RecordRow>(`${select(predicate)} ORDER BY sha256(convert_to($6 || ':' || r.id,'UTF8')),r.id COLLATE "C" LIMIT $7`, [...scope,start,end,seed,measurementRules.precisionSampleSize])).rows.map(rowToRecord);
    precision = { ...precisionAudit({merchant:merchant.info,settings:merchant.settings,records:sample},context.now), population, requiredSample:Math.min(measurementRules.precisionSampleSize,population) };
    sampledIds = precision.sampledAllocationIds;
  }
  const conditions = { proposals:"r.kind='allocations' AND r.status='proposed'", duplicates:"r.kind='payments' AND r.status='possible_duplicate'", payments:`r.kind='payments' AND r.status IN ('unallocated','partial','overpaid') AND ${paymentUnappliedSql}>0`, observations:"r.kind='observations' AND r.status='unresolved'", audit:"r.kind='allocations' AND r.id=ANY($5::text[])", batches:"r.kind='settlement-batches'" };
  const due = query.dueItem ? (await session.client.query<RecordRow>(select("r.kind='due-items' AND r.id=$4"),[...scope,query.dueItem])).rows[0] : undefined;
  const related = new Map<string,ValopayRecord>();
  if (due) related.set(due.id,rowToRecord(due));
  // An unavailable focus fails closed rather than showing the whole lender.
  const focus = !query.dueItem ? 'true' : !due ? 'false' : queue === 'proposals' ? "r.data->>'dueItemId'=$4" : queue === 'observations' ? "(r.data->>'dueItemId'=$4 OR ($6<>'' AND r.customer_id=$6))" : "($6<>'' AND r.customer_id=$6)";
  // All parameters are referenced in every variant so PostgreSQL can infer their types.
  const fold = (value:string) => `lower(regexp_replace(normalize(${value},NFD), U&'[\\0300-\\036f]', '', 'g'))`;
  const searchFilter = `($7='' OR position($7 in ${fold("concat_ws(' ',r.name,r.reference)")})>0 OR EXISTS (
    SELECT 1 FROM valopay_records linked LEFT JOIN valopay_records customer ON customer.merchant_id=r.merchant_id AND customer.kind='customers' AND customer.id=linked.customer_id
    WHERE linked.merchant_id=r.merchant_id AND linked.kind IN ('customers','payments','due-items') AND linked.id=ANY(ARRAY[r.customer_id,r.data->>'paymentId',r.data->>'dueItemId'])
    AND position($7 in ${fold("concat_ws(' ',linked.name,linked.reference,customer.name,customer.reference)")})>0))`;
  const where = `${searchFilter} AND (${conditions[queue]}) AND (${focus}) AND $4::text IS NOT NULL AND $5::text[] IS NOT NULL AND $6::text IS NOT NULL`;
  const values = [...scope, query.dueItem || '', sampledIds, due?.customer_id || '', foldForSearch(query.q || '').trim()];
  const total = Number((await session.client.query<{total:string}>(`SELECT count(*) AS total ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND ${where}`,values)).rows[0]!.total);
  const offset = pageOffset(total,limit,query.offset);
  const items = (await session.client.query<RecordRow>(`${select(where)} ORDER BY r.created_at DESC,r.id DESC OFFSET $8 LIMIT $9`,[...values,offset,limit])).rows.map(rowToRecord);
  for (let hop=0;hop<2;hop++) {
    const ids = [...new Set([...items,...related.values()].flatMap(r=>[r.customerId,r.data.paymentId,r.data.dueItemId]).filter((id):id is string=>typeof id==='string' && !!id && !related.has(id)))];
    if (!ids.length) break;
    const rows = (await session.client.query<RecordRow>(select("r.kind IN ('customers','payments','due-items') AND r.id=ANY($4::text[])"),[...scope,ids])).rows;
    for (const row of rows) related.set(row.id,rowToRecord(row));
  }
  return {items,related:[...related.values()],total,offset,asOf:context.now,...(precision?{precision}:{})};
}

const closeSummaryData = `jsonb_strip_nulls(jsonb_build_object('summary',r.data->'summary','closedAt',r.data->'closedAt','schedule',r.data->'schedule','positionAlert',r.data->'positionAlert',
  'report',CASE WHEN r.data ? 'report' THEN jsonb_build_object('unallocated',jsonb_build_object('kobo',r.data#>'{report,unallocated,kobo}'),'exceptions',jsonb_build_object('openAtClose',r.data#>'{report,exceptions,openAtClose}')) END))`;

export async function listCloseHistory(context: StoreContext, merchantId: string, query: ReadPageQuery) {
  validateCloseRange(query.from,query.to);
  const session = sessionFor(context); await readMerchant(context,merchantId);
  const values = [merchantId,session.workspace.id,session.principal,query.from || '',query.to || ''];
  const base = `${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND r.kind='closes'`;
  const day = "to_char(r.created_at AT TIME ZONE 'Africa/Lagos','YYYY-MM-DD')";
  const range = `($4='' OR ${day}>=$4) AND ($5='' OR ${day}<=$5)`;
  const counts = (await session.client.query<{total:string;all_total:string}>(`SELECT count(*) AS all_total,count(*) FILTER(WHERE ${range}) AS total ${base}`,values)).rows[0]!;
  const total = Number(counts.total),limit=query.limit || 25,offset=pageOffset(total,limit,query.offset);
  const select = `SELECT ${recordColumns.replace('r.data',closeSummaryData+' AS data')} ${base} AND ${range}`;
  const items = (await session.client.query<RecordRow>(`${select} ORDER BY r.created_at DESC,r.id DESC OFFSET $6 LIMIT $7`,[...values,offset,limit])).rows.map(rowToRecord);
  const endpoints = total ? (await session.client.query<RecordRow>(`(${select} ORDER BY r.created_at,r.id LIMIT 1) UNION ALL (${select} ORDER BY r.created_at DESC,r.id DESC LIMIT 1)`,values)).rows.map(rowToRecord) : [];
  return {items,total,allTotal:Number(counts.all_total),offset,...(total?{first:endpoints[0]!,latest:endpoints[1]!}:{})};
}
export async function getCloseDetail(context: StoreContext, merchantId:string, id:string) {
  const session=sessionFor(context); await readMerchant(context,merchantId);
  const row=(await session.client.query<RecordRow>(`SELECT ${recordColumns} ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND r.kind='closes' AND r.id=$4`,[merchantId,session.workspace.id,session.principal,id])).rows[0];
  if (!row) fail('Close record not found in this lender.',404);
  return rowToRecord(row);
}

/** Read-only reports keep the measures needed by historical calculations, without
 * pulling large REC-07 evidence arrays into every summary request. */
export async function loadReportsView(context:StoreContext,merchantId:string):Promise<DomainState> {
  const session=sessionFor(context),merchant=await readMerchant(context,merchantId);
  const data = `CASE WHEN r.kind='closes' THEN ${closeSummarySql} ELSE r.data END AS data`;
  const rows=(await session.client.query<RecordRow>(`SELECT ${recordColumns.replace('r.data',data)} ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND r.kind NOT IN ('audit','observations','notifications','retry-decisions') ORDER BY r.created_at,r.id`,[merchantId,session.workspace.id,session.principal])).rows;
  return {merchant:merchant.info,settings:merchant.settings,records:rows.map(rowToRecord)};
}

/** paymentRefundedKobo in SQL: for a refund (including the legacy spelling), data.refundedKobo when it is a whole non-negative safe number, else the whole payment. */
const paymentRefundedSql = `(CASE WHEN coalesce(r.data->>'refundStatus','') IN ('refunded','recorded_externally') THEN CASE WHEN jsonb_typeof(r.data->'refundedKobo')='number'
  THEN CASE WHEN (r.data->>'refundedKobo')::numeric BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER} AND (r.data->>'refundedKobo')::numeric=trunc((r.data->>'refundedKobo')::numeric) THEN (r.data->>'refundedKobo')::numeric ELSE r.amount_kobo END
  ELSE r.amount_kobo END ELSE 0 END)`;
/** paymentMoneyReturned in SQL: reversed by the provider, or refunded in full. Returned money is no customer's credit. */
const paymentReturnedSql = `(coalesce(r.data->>'reversalStatus','')='reversed' OR (coalesce(r.data->>'refundStatus','') IN ('refunded','recorded_externally') AND ${paymentRefundedSql}>=r.amount_kobo))`;
/** paymentUnappliedKobo in SQL: what a payment holds that is neither applied nor returned by a refund. */
const paymentUnappliedSql = `CASE WHEN ${paymentReturnedSql} THEN 0 ELSE greatest(0,r.amount_kobo-coalesce((r.data->>'allocatedKobo')::numeric,0)-${paymentRefundedSql}) END`;
/** currencyOf in SQL: the currency a payment names, trimmed and in capitals, or NGN when it names none. */
const paymentCurrencySql = `upper(btrim(coalesce(nullif(r.data->>'currency',''),'NGN'),E' \\t\\n\\r'))`;
/** The payment is in naira. Money in another currency is no naira credit. */
const paymentInNairaSql = `${paymentCurrencySql}='NGN'`;

/** Read-only customer cards and events are paged; balances aggregate every related record. */
export async function getCustomerHistory(context: StoreContext, merchantId: string, id: string, query: CustomerHistoryQuery) {
  const session = sessionFor(context); await readMerchant(context, merchantId);
  const values = [merchantId, session.workspace.id, session.principal, id];
  const base = `${scopedRecordsFrom} WHERE ${scopedRecordsWhere}`;
  const customerRow = (await session.client.query<RecordRow>(`SELECT ${recordColumns} ${base} AND r.kind='customers' AND r.id=$4`, values)).rows[0];
  if (!customerRow) fail('Customer not found.', 404);
  const totalsRow = (await session.client.query<Record<string,string>>(`SELECT count(*) AS events,
    count(*) FILTER(WHERE r.kind='mandates') AS mandates, count(*) FILTER(WHERE r.kind='due-items') AS "dueItems", count(*) FILTER(WHERE r.kind='payments') AS payments,
    coalesce(sum(r.amount_kobo) FILTER(WHERE r.kind='due-items' AND r.status<>'cancelled'),0) AS obligations,
    coalesce(sum(r.amount_kobo) FILTER(WHERE r.kind='allocations' AND r.status='confirmed'),0) AS allocated,
    coalesce(sum(${paymentUnappliedSql}) FILTER(WHERE r.kind='payments' AND ${paymentInNairaSql}),0) AS credit
    ${base} AND r.customer_id=$4`,values)).rows[0]!;
  const totals = {} as Record<HistorySection,number>, offsets = {} as Record<HistorySection,number>;
  const pages = {} as Record<HistorySection,ValopayRecord[]>;
  for (const section of historySections) {
    const limit = Math.min(query[`${section}Limit`] || 25,100);
    totals[section] = Number(totalsRow[section]);
    offsets[section] = pageOffset(totals[section],limit,query[`${section}Offset`]);
    const predicate = historyKind[section] ? `AND r.kind='${historyKind[section]}'` : '';
    pages[section] = (await session.client.query<RecordRow>(`SELECT ${recordColumns} ${base} AND r.customer_id=$4 ${predicate} ORDER BY r.created_at DESC,r.id DESC OFFSET $5 LIMIT $6`,[...values,offsets[section],limit])).rows.map(rowToRecord);
  }
  const focusedRow = query.record ? (await session.client.query<RecordRow>(`SELECT ${recordColumns} ${base} AND r.customer_id=$4 AND r.id=$5`,[...values,query.record])).rows[0] : undefined;
  const obligationsKobo = databaseMoney(totalsRow.obligations!), allocatedKobo = databaseMoney(totalsRow.allocated!);
  // Money in another currency that the customer's payments hold unapplied, by currency, beside the naira credit (unallocatedOtherCurrencies).
  const elsewhere = (await session.client.query<{currency:string;count:string;amount:string}>(`SELECT ${paymentCurrencySql} AS currency,count(*) AS count,sum(${paymentUnappliedSql}) AS amount
    ${base} AND r.customer_id=$4 AND r.kind='payments' AND NOT ${paymentInNairaSql} AND ${paymentUnappliedSql}>0 GROUP BY 1`,values)).rows.sort((a,b)=>a.currency<b.currency?-1:a.currency>b.currency?1:0);
  const unallocatedOtherCurrencies = elsewhere.length ? Object.fromEntries(elsewhere.map(row=>[row.currency,{count:Number(row.count),amount:databaseMoney(row.amount)}])) : undefined;
  return {customer:rowToRecord(customerRow),position:{obligationsKobo,allocatedKobo,outstandingKobo:Math.max(0,sumMoney([obligationsKobo,-allocatedKobo])),unallocatedKobo:databaseMoney(totalsRow.credit!),...(unallocatedOtherCurrencies?{unallocatedOtherCurrencies}:{}),note:positionNote},...pages,totals,offsets,...(focusedRow?{focusedRecord:rowToRecord(focusedRow)}:{})};
}

/** Complete customer history and balances without every other customer's data.
 * This read has no mutable snapshot: passing it to saveState is rejected. */
export async function loadCustomerView(context: StoreContext, merchantId: string, customerId: string): Promise<DomainState> {
  const session = sessionFor(context), merchant = await readMerchant(context, merchantId);
  const records = (await session.client.query<RecordRow>(`SELECT ${recordColumns} ${scopedRecordsFrom}
    WHERE ${scopedRecordsWhere} AND ((r.kind='customers' AND r.id=$4) OR r.customer_id=$4) ORDER BY r.created_at,r.id`,
    [merchantId, session.workspace.id, session.principal, customerId])).rows.map(rowToRecord);
  return { merchant: merchant.info, settings: merchant.settings, records };
}

/**
 * Settings only need integrations, the calendar and the latest close,
 * summarised: the page shows when it ran and how, never a report. The latest
 * is the newest by creation, read through the paging index; a close's
 * closedAt is the time it was created (runDailyClose), so it is the one the
 * close schedule picks, and no other close's report is read.
 */
export async function loadSettingsView(context: StoreContext, merchantId: string): Promise<DomainState> {
  const session = sessionFor(context), merchant = await readMerchant(context, merchantId);
  const records = (await session.client.query<RecordRow>(`(SELECT ${recordColumns} ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND r.kind IN ('integrations','calendar'))
    UNION ALL (SELECT ${recordColumns.replace('r.data', `${closeSummarySql} AS data`)} ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND r.kind='closes' ORDER BY r.created_at DESC,r.id DESC LIMIT 1)
    ORDER BY created_at,id`,
    [merchantId, session.workspace.id, session.principal])).rows.map(rowToRecord);
  return { merchant: merchant.info, settings: merchant.settings, records };
}

/** The stored answer for an idempotency key, when the request was already made: kept under `id` (receiptOf), or
 * under `earlier`, where an earlier build kept it. */
export async function findIdempotency(context: StoreContext, id: string, earlier?: string) {
  const session = sessionFor(context);
  const merchantId = boundMerchant(session);
  const found = (await session.client.query<{ id: string; request_hash: string; response: any }>(
    `SELECT i.id,i.request_hash,i.response FROM valopay_idempotency i JOIN valopay_merchants m ON m.id=i.merchant_id
     JOIN valopay_workspaces w ON w.id=m.workspace_id
     WHERE i.id=ANY($1::text[]) AND i.merchant_id=$2 AND m.workspace_id=$3 AND w.id=$3 AND w.principal_hash=$4
     ORDER BY i.id=$5 DESC LIMIT 1`,
    [earlier === undefined || earlier === id ? [id] : [id, earlier], merchantId, session.workspace.id, session.principal, id],
  )).rows[0];
  if(found?.response?.purged)fail('This request already completed and its retained payload has expired. It cannot run again.',410);
  return found ? { request_hash: found.request_hash, response: await revealStored(found.response,{lender:merchantId,record:found.id,field:'response'}) } : undefined;
}
/**
 * A keyed write's stored answer before its lender is loaded: the transaction
 * is bound to the lender without its lock (the workspace and, for staff, the
 * person's lender access are checked as for any load), so a repeat of a saved
 * request is answered without loading the lender or waiting for it. A caller
 * that finds nothing loads the lender and looks again: an attempt that
 * finished meanwhile is visible once the journal entry is held.
 */
export async function findStoredAnswer(context: StoreContext, merchantId: string, id: string, earlier?: string) {
  await readMerchant(context, merchantId, "none");
  return findIdempotency(context, id, earlier);
}
/** Stores the answer where receiptOf keeps it (`id`), with the request's fingerprint, so a replay with different input is refused. */
export async function saveIdempotency(context: StoreContext, id: string, requestHash: string, response: unknown) {
  const session = sessionFor(context);
  const merchantId = lockedMerchant(session);
  const owned = await session.client.query(scopedMerchantQuery(), [merchantId, session.workspace.id, session.principal]);
  if (!owned.rows[0]) fail("Lender not found in this workspace.", 404);
  try {
    const inserted = await session.client.query(
      `INSERT INTO valopay_idempotency(id,merchant_id,request_hash,response)
       SELECT $1,$2,$3,$4 WHERE EXISTS (
         SELECT 1 FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id
         WHERE m.id=$2 AND m.workspace_id=$5 AND w.id=$5 AND w.principal_hash=$6)`,
      [id, merchantId, requestHash, await protectStored(response,{lender:merchantId,record:id,field:'response'}), session.workspace.id, session.principal],
    );
    if (!rowsAffected(inserted)) fail("Lender not found in this workspace.", 404);
    await completeOperation(context, response);
  } catch (error: any) {
    if (error?.code === "23505") conflict("This idempotency key is already in use.");
    throw error;
  }
}
/** Switches the workspace's demo persona. */
export async function changeRole(context: StoreContext, role: string) {
  const session = sessionFor(context);
  if (context.accessMode === 'staff') fail('Staff cannot switch demo personas.', 403);
  if (session.access !== "persona") conflict("A persona change requires an exclusive workspace transaction.");
  if (!roles.includes(role)) fail("Unknown sandbox persona.");
  const result = await session.client.query(
    "UPDATE valopay_workspaces SET role=$3 WHERE id=$1 AND principal_hash=$2",
    [session.workspace.id, session.principal, role],
  );
  if (!rowsAffected(result)) fail("Workspace not found.", 404);
  session.workspace.role = role;
}

function lockedMerchant(session: Session): string {
  if (session.access === "read") fail("A read transaction cannot write lender data.", 409);
  if (!session.lockedMerchantId || !session.snapshot) fail("Load a lender before using this repository operation.", 409);
  return session.lockedMerchantId;
}
/** The lender a write transaction is bound to, loaded or not: the journal's own reads and writes need no lender lock. */
function boundMerchant(session: Session): string {
  if (session.access === "read") fail("A read transaction cannot write lender data.", 409);
  if (!session.lockedMerchantId) fail("Load a lender before using this repository operation.", 409);
  return session.lockedMerchantId;
}
function reference(record: ValopayRecord, id: unknown, kind: string, label: string, all: Map<string, ValopayRecord>): ValopayRecord {
  const recordId = typeof id === "string" && id ? id : conflict(`${label} is required.`);
  const target = all.get(recordId) ?? conflict(`${label} must reference a ${kind} in this lender.`);
  if (target.kind !== kind || target.merchantId !== record.merchantId) conflict(`${label} must reference a ${kind} in this lender.`);
  return target;
}
/** Pure guard exported for focused repository guard tests. */
function isExportRetry(before: ValopayRecord, after: ValopayRecord, now?: string): boolean {
  const expired = before.status === "running" && !!now && (!before.data.leaseExpiresAt || Date.parse(String(before.data.leaseExpiresAt)) <= Date.parse(now));
  if (after.status !== "queued" || !(before.status === "failed" || expired)) return false;
  const cleared = ["leaseToken", "leaseExpiresAt", "lastError"];
  if (cleared.some(key => after.data[key] !== undefined)) return false;
  if (after.data.stage !== 'queued' || after.data.lastProgressAt !== now) return false;
  const stableData = (record: ValopayRecord) => Object.fromEntries(Object.entries(record.data).filter(([key]) => ![...cleared, 'stage', 'lastProgressAt'].includes(key)));
  // A retry cannot change the request, private object identity, attempts,
  // checksum, customer or any prior evidence; it only clears the old lease/error.
  return sameJson({ ...after, status: before.status, updatedAt: before.updatedAt, data: stableData(after) }, { ...before, data: stableData(before) });
}

/**
 * The one change of a recorded payer the repository accepts: Finance's
 * identification withdrawn, back to no payer, while nothing of the payment is
 * applied and with the identification kept in its history
 * (withdrawPayerIdentification). A payer the evidence named never changes,
 * including one that evidence resolved to the payment since names.
 */
function payerWithdrawn(before: ValopayRecord, after: ValopayRecord, final: ReadonlyMap<string, ValopayRecord>): boolean {
  const identification = before.data.payerIdentification;
  if (after.customerId !== "" || !identification || identification.customerId !== before.customerId || after.data.payerIdentification !== undefined || Number(after.data.allocatedKobo || 0) !== 0) return false;
  const history: unknown[] = Array.isArray(after.data.payerIdentificationHistory) ? after.data.payerIdentificationHistory : [];
  if (!history.some((entry: any) => entry?.customerId === identification.customerId && entry?.allocationId === identification.allocationId)) return false;
  for (const record of final.values()) {
    if (record.kind === "allocations" && record.status === "confirmed" && record.data.paymentId === after.id) return false;
    if (record.kind === "observations" && record.status === "resolved" && record.data.paymentId === after.id && record.customerId === identification.customerId) return false;
  }
  return true;
}
/** A match taken out of use keeps the payer it was applied for once the payment's history shows that identification withdrawn. */
const withdrawnPayerOf = (allocation: ValopayRecord, payment: ValopayRecord): boolean => allocation.status === "superseded"
  && Array.isArray(payment.data.payerIdentificationHistory) && payment.data.payerIdentificationHistory.some((entry: any) => entry?.customerId === allocation.customerId);

/**
 * The repository's final-state checks. `unchanged` names records whose JSON is
 * identical to the loaded snapshot: they passed these checks when they were
 * written, so only added and changed records are compared field by field.
 */
export function assertFinalState(snapshot: DomainState, state: DomainState, merchantId: string, now?: string, unchanged: ReadonlySet<string> = new Set()) {
  if (state.merchant.id !== merchantId || snapshot.merchant.id !== merchantId) conflict("Lender identity cannot be reassigned.");
  const final = new Map<string, ValopayRecord>();
  for (const record of state.records) {
    if (final.has(record.id)) conflict("Duplicate record IDs are not permitted.");
    if (record.merchantId !== merchantId) conflict("Records cannot be moved between lenders.");
    if (!Number.isSafeInteger(record.amountKobo) || record.amountKobo < 0 || record.amountKobo > Number.MAX_SAFE_INTEGER) conflict("Amounts must be safe non-negative integer kobo.");
    if (record.kind === "due-items" && record.amountKobo < 500000) conflict("Debits under ₦5,000 are refused.");
    final.set(record.id, record);
  }
  const original = new Map(snapshot.records.map((record) => [record.id, record]));
  for (const [id, before] of original) {
    const after = final.get(id);
    const present = after ?? conflict("Records cannot be deleted.");
    if (unchanged.has(id)) continue;
    if (present.id !== before.id || present.merchantId !== before.merchantId || present.kind !== before.kind || present.createdAt !== before.createdAt) {
      conflict("Record identity, lender, kind, and creation time are immutable.");
    }
    // A payment's payer, once its evidence named one or Finance identified it, is never reassigned; Finance's identification may only be withdrawn (payerWithdrawn).
    if (before.kind === "payments" && before.customerId && present.customerId !== before.customerId && !payerWithdrawn(before, present, final)) conflict("A payment's payer cannot change once it is recorded.");
    const retentionChange=()=>{
      const kind=before.kind==='exports'?'export_file':'raw_csv';
      const receipt=[...final.values()].find(r=>r.kind==='retention-receipts'&&!original.has(r.id)&&r.data.sourceId===before.id&&r.data.kind===kind&&['deleted','already_absent'].includes(r.data.result));
      const run=receipt&&original.get(receipt.data.runId);
      if(!run||run.kind!=='retention-runs'||!['approved','running','attention'].includes(run.status)||!run.data.candidates.some((c:any)=>c.sourceId===before.id&&c.kind===kind&&c.version===before.updatedAt))return false;
      const expected=structuredClone(before);expected.updatedAt=present.updatedAt;
      if(kind==='raw_csv'){delete expected.data.csv;if(expected.data.check)delete expected.data.check.preview;expected.data.rawCsvRemovedAt=now;expected.data.rawCsvRetentionRunId=run.id;}
      else {expected.data.fileDeletedAt=now;expected.data.fileRetentionRunId=run.id;}
      return sameJson(expected,present);
    };
    if (["audit", "exports", "reviews", "closes", "retry-decisions", "invoices", "connected-credit-assessments", "connected-credit-reviews", "case-events", "import-revisions", "import-corrections", "import-correction-events", "source-manifests", "close-review-events", "work-events", "retention-policies", "retention-holds", "retention-receipts"].includes(before.kind) && !sameJson(present, before)
      && !(before.kind === "exports" && (isExportRetry(before, present, now)||retentionChange()))) conflict("Evidence records are immutable.");
    if (["policies", "templates", "experiments"].includes(before.kind) && ["approved", "preregistered", "closed"].includes(before.status) && !sameJson(present, before)) {
      conflict("Approved, preregistered, and closed versions are immutable.");
    }
    if (before.kind === 'provider-events') assertProviderEventChange(before,present);
    if (exceptionReviewSubjectChanged(before, present, original.get(before.data.linkedRecordId))) conflict('The subject of a historical evidence review is immutable.');
    if (before.kind === 'settlement-batches' && before.data.providerIdentityReview !== undefined && !sameJson(before.data.providerIdentityReview, present.data.providerIdentityReview)) conflict('A recorded settlement provider review snapshot is immutable.');
    if (before.kind === 'settlement-batches' && before.data.providerIdentityKey !== undefined
      && (before.reference !== present.reference || ['batchReference', 'provider', 'providerConnection', 'providerIdentityKey'].some(key => !sameJson(before.data[key], present.data[key])))) conflict('A recorded settlement provider identity is immutable.');
    // A legacy exception can acquire only the currency its original linked money already had; it cannot change the decision's monetary meaning.
    const derivedCurrency = before.kind === 'exceptions' && !before.data.currency && present.data.currency
      ? exceptionCurrency(before, (kind, id) => { const record = original.get(id); return record?.kind === kind ? record : undefined; }) : undefined;
    if (exceptionDecisionChanged(before, present, derivedCurrency)) conflict('A completed exception decision and its recorded attribution are immutable. Record a new review instead.');
    if (before.kind === 'source-profiles' && ['source','kind'].some(key=>!sameJson(before.data[key],present.data[key]))) conflict('A source profile cannot change its source or record type.');
    if (before.kind === 'import-batches' && before.status === 'committed' && !sameJson(present, before)&&!retentionChange()) conflict('Committed source batches are immutable.');
    if(before.kind==='close-reviews'&&!sameJson(present,before)){
      const expected=structuredClone(before);expected.status=present.status;expected.updatedAt=present.updatedAt;
      if (before.status === 'awaiting_review' && present.status === 'awaiting_review') {
        expected.data.reviewer = present.data.reviewer;
        const evidence = state.records.some(event => !original.has(event.id) && event.kind === 'close-review-events' && event.status === 'recorded'
          && event.data.action === 'reassign' && event.data.reviewId === before.id && event.data.closeId === before.data.closeId
          && event.data.previousReviewer === before.data.reviewer && event.data.reviewer === present.data.reviewer
          && event.data.snapshotDigest === before.data.snapshotDigest && typeof event.data.note === 'string' && event.data.note.trim().length >= 10);
        if (before.data.reviewer === present.data.reviewer || !evidence || !sameJson(expected, present)) conflict('Reassignments must retain the prepared snapshot and append their reason to the review history.');
      } else {
        for(const field of ['decidedBy','decidedPrincipal','decidedAt','decisionNote','sourceExceptions'])expected.data[field]=present.data[field];
        if(before.status!=='awaiting_review'||!['approved','changes_requested'].includes(present.status)||!sameJson(expected,present))conflict('The prepared close snapshot and recorded decision are immutable.');
      }
    }
    if(before.kind==='retention-runs'&&['candidates','previewDigest','policyRevision','expiresAt','preparedBy'].some(key=>!sameJson(before.data[key],present.data[key])))conflict('The approved retention manifest is immutable.');
    if (before.data.importIdentity && !sameJson(present.data.importIdentity, before.data.importIdentity)) conflict('Source row provenance is immutable.');
    assertImportedCorrectionChange(before, present, snapshot, state);
  }
  const dueReferences = new Set<string>(), customerReferences = new Set<string>(), observations = new Set<string>(), inflight = new Set<string>();
  const allocatedPayments = new Map<string, number>(), allocatedDues = new Map<string, number>();
  const changed = (record: ValopayRecord, ...keys: string[]) => {
    if (unchanged.has(record.id)) return false;
    const before = original.get(record.id);
    return !before || keys.some((key) => !sameJson(before.data[key], record.data[key]));
  };
  const changedCustomer = (record: ValopayRecord) => {
    if (unchanged.has(record.id)) return false;
    const before = original.get(record.id);
    return !before || before.customerId !== record.customerId;
  };
  const optionalReference = (record: ValopayRecord, key: string, kind: string, label: string) => {
    if (record.data[key] !== undefined && record.data[key] !== null && record.data[key] !== "" && changed(record, key)) {
      return reference(record, record.data[key], kind, label, final);
    }
    return undefined;
  };
  const anyReference = (record: ValopayRecord, key: string, label: string) => {
    if (record.data[key] === undefined || record.data[key] === null || record.data[key] === "" || !changed(record, key)) return;
    const target = final.get(String(record.data[key]));
    if (!target || target.merchantId !== record.merchantId) conflict(`${label} must belong to this lender.`);
  };
  for (const record of final.values()) {
    if (record.kind === 'customers' && record.reference) {
      if (customerReferences.has(record.reference)) conflict('Customer references must be unique within a lender.');
      customerReferences.add(record.reference);
    }
    if (record.customerId && changedCustomer(record)) reference(record, record.customerId, "customers", "Customer", final);
    // Shared data links are verified only when a new/changed state introduces
    // them; this protects writes without reinterpreting historical snapshots.
    optionalReference(record, "policyId", "policies", "Policy");
    optionalReference(record, "mandateId", "mandates", "Mandate");
    optionalReference(record, "dueItemId", "due-items", "Due item");
    optionalReference(record, "paymentId", "payments", "Payment");
    optionalReference(record, "noticeId", "notifications", "Notice");
    optionalReference(record, "experimentId", "experiments", "Experiment");
    optionalReference(record, "proposedDueItemId", "due-items", "Proposed due item");
    optionalReference(record, "virtualAccountCustomerId", "customers", "Virtual-account customer");
    optionalReference(record, "settlementBatchId", "settlement-batches", "Settlement batch");
    optionalReference(record, "countedInBatchId", "settlement-batches", "Settlement batch counting the line");
    optionalReference(record, "statementObservationId", "observations", "Statement observation");
    anyReference(record, "linkedRecordId", "Exception link");
    if (record.data.lineObservationIds !== undefined && changed(record, "lineObservationIds")) {
      if (!Array.isArray(record.data.lineObservationIds)) conflict("Settlement batch observation IDs must be an array.");
      for (const id of record.data.lineObservationIds) reference(record, id, "observations", "Settlement batch observation", final);
    }
    if (record.data.otherCurrencyLineIds !== undefined && changed(record, "otherCurrencyLineIds")) {
      if (!Array.isArray(record.data.otherCurrencyLineIds)) conflict("Settlement batch lines in another currency must be an array.");
      for (const id of record.data.otherCurrencyLineIds) reference(record, id, "observations", "Settlement batch line in another currency", final);
    }
    if (record.kind === "due-items") {
      if (record.reference) { if (dueReferences.has(record.reference)) conflict("Due-item reference already exists."); dueReferences.add(record.reference); }
      const mandate = optionalReference(record, "mandateId", "mandates", "Due-item mandate")
        || (changedCustomer(record) && record.data.mandateId ? reference(record, record.data.mandateId, "mandates", "Due-item mandate", final) : undefined);
      if (mandate && mandate.customerId !== record.customerId) conflict("Due-item mandate must belong to the same customer.");
      const outstanding = record.data.outstandingKobo;
      if (outstanding !== undefined && (!Number.isSafeInteger(outstanding) || outstanding < 0 || outstanding > record.amountKobo)) conflict("Outstanding balance is invalid.");
    }
    if (record.kind === "attempts") {
      // Attempts are facts, so their required parent remains checked on every
      // save.  This also permits the in-flight uniqueness calculation below.
      const due = reference(record, record.data.dueItemId, "due-items", "Attempt due item", final);
      const before = original.get(record.id);
      if ((!before || changed(record, "dueItemId") || changedCustomer(record) || before.amountKobo !== record.amountKobo)
        && (due.customerId !== record.customerId || record.amountKobo !== due.amountKobo)) {
        conflict("Attempt must match its due item and customer.");
      }
      if (["scheduled", "sent", "unknown"].includes(record.status)) {
        if (inflight.has(due.id)) conflict("Only one in-flight attempt is allowed for a due item.");
        inflight.add(due.id);
      }
    }
    if (record.kind === "observations") {
      const due = optionalReference(record, "dueItemId", "due-items", "Observation due item")
        || (changedCustomer(record) && record.data.dueItemId ? reference(record, record.data.dueItemId, "due-items", "Observation due item", final) : undefined);
      if (due && record.customerId && due.customerId !== record.customerId) conflict("Observation due item must belong to its customer.");
      if (record.data.eventId !== undefined && record.data.eventId !== null) {
        const key = observationEventKey(record.data)!;
        if (observations.has(key)) conflict("Observation already exists for this source event.");
        observations.add(key);
      }
    }
    if (record.kind === "payments") {
      const due = optionalReference(record, "dueItemId", "due-items", "Payment due item")
        || optionalReference(record, "proposedDueItemId", "due-items", "Proposed due item")
        || (changedCustomer(record) && record.data.dueItemId ? reference(record, record.data.dueItemId, "due-items", "Payment due item", final) : undefined)
        || (changedCustomer(record) && record.data.proposedDueItemId ? reference(record, record.data.proposedDueItemId, "due-items", "Proposed due item", final) : undefined);
      if (due && record.customerId && due.customerId !== record.customerId) conflict("Payment due item must belong to its customer.");
    }
    if (record.kind === "allocations") {
      // Every allocation status carries durable parent IDs; confirmed rows add
      // the final-state amount constraints below.
      const payment = reference(record, record.data.paymentId, "payments", "Allocation payment", final);
      const due = reference(record, record.data.dueItemId, "due-items", "Allocation due item", final);
      // A superseded allocation applies nothing, such as a proposal withdrawn when Finance identified another payer.
      if (record.status !== "superseded" && payment.customerId && due.customerId && payment.customerId !== due.customerId) conflict("Allocation payment and due item must have the same customer.");
      // A proposal for a payment whose evidence named no payer carries no customer until Finance identifies the payer, and a
      // match taken out of use keeps a payer whose identification was withdrawn (withdrawnPayerOf).
      if (record.customerId && (record.customerId !== due.customerId || (record.customerId !== payment.customerId && !withdrawnPayerOf(record, payment)))) conflict("Allocation customer must match its parents.");
      if (record.status === "confirmed") {
        // Evidence that named no payer is applied only once Finance has identified the payer.
        if (!payment.customerId || record.customerId !== payment.customerId) conflict("A payment is applied to an instalment only once its payer is identified.");
        allocatedPayments.set(payment.id, sumMoney([allocatedPayments.get(payment.id) || 0, record.amountKobo]));
        allocatedDues.set(due.id, sumMoney([allocatedDues.get(due.id) || 0, record.amountKobo]));
      }
    }
  }
  for(const record of final.values()) {
    if(record.kind==='connected-intents' && ['authorised','pending','unknown'].includes(record.status)) {
      const due=reference(record,record.data.dueItemId,'due-items','Checkout instalment',final);
      if(due.customerId!==record.customerId) conflict('Checkout customer must match the instalment.');
      if(inflight.has(due.id)) conflict('A pay-by-bank checkout and another collection cannot be in flight together.');
      inflight.add(due.id);
    }
  }
  for (const [id, amount] of allocatedPayments) if (amount > final.get(id)!.amountKobo) conflict("Allocations exceed the payment amount.");
  for (const [id, amount] of allocatedDues) if (amount > final.get(id)!.amountKobo) conflict("Allocations exceed the due-item amount.");
}

/** How many records one of saveState's write statements carries. */
const WRITE_BATCH = 500;
const recordsetColumns = "id text,kind text,name text,status text,reference text,amount_kobo bigint,customer_id text,data jsonb,created_at timestamptz,updated_at timestamptz";
/** Persist only a checked diff against the repository-owned snapshot. */
export async function saveState(context: StoreContext, state: DomainState): Promise<void> {
  const session = sessionFor(context);
  const merchantId = lockedMerchant(session);
  const snapshot = session.snapshot!;
  const { changed, unchanged } = changesSince(snapshot, state);
  // A summarised close would overwrite its full stored report; closes are evidence and never change.
  if (changed.some((record) => session.summarised?.has(record.id))) conflict("Evidence records are immutable.");
  advanceChanged(snapshot, changed, context.now);
  // An unchanged record is its own "before": identical JSON is identical content.
  const current = new Map(state.records.map((record) => [record.id, record]));
  const before: DomainState = {
    merchant: JSON.parse(snapshot.merchant), settings: JSON.parse(snapshot.settings),
    records: [...snapshot.records].map(([id, json]) => (unchanged.has(id) ? current.get(id)! : JSON.parse(json) as ValopayRecord)),
  };
  assertFinalState(before, state, merchantId, context.now, unchanged);
  const owned = await session.client.query(scopedMerchantQuery(), [merchantId, session.workspace.id, session.principal]);
  if (!owned.rows[0]) fail("Lender not found in this workspace.", 404);
  // Explicit synthetic staging dual-write only. A typed failure rolls back the
  // same transaction as the v1 write; no migration runs here or on startup.
  const projectionMode = process.env.VALOPAY_FINANCIAL_PROJECTION || 'off';
  if (!['off', 'staging'].includes(projectionMode)) throw new Error('VALOPAY_FINANCIAL_PROJECTION must be off or staging.');
  if (projectionMode === 'staging') {
    await syncFinancialProjection(session.client, financialProjectionSchema(process.env.VALOPAY_FINANCIAL_PROJECTION_SCHEMA || ''), session.workspace.id, state);
  }
  const sorted = [...changed].sort((a, b) => {
    const priority = (record: ValopayRecord) => record.kind === "allocations" ? (record.status === "confirmed" ? 3 : 0) : record.kind === "audit" ? 4 : 1;
    return priority(a) - priority(b);
  });
  const rows: Array<Record<string, unknown> & { existing: boolean }> = [];
  for (const record of sorted) rows.push({ existing: snapshot.records.has(record.id), id: record.id, kind: record.kind, name: record.name, status: record.status, reference: record.reference, amount_kobo: record.amountKobo, customer_id: record.customerId, data: await protectRecordData(record), created_at: record.createdAt, updated_at: record.updatedAt });
  // A run of updates, or of inserts, in the order above is one statement (up to WRITE_BATCH records): a month-end
  // close changes thousands of records, each once its own statement. The order still puts an update that frees a
  // unique value before the insert that takes it.
  for (let start = 0; start < rows.length;) {
    const existing = rows[start]!.existing;
    let end = start + 1;
    while (end < rows.length && end - start < WRITE_BATCH && rows[end]!.existing === existing) end += 1;
    const batch = rows.slice(start, end).map(({ existing: _existing, ...row }) => row);
    const result = await session.client.query(existing
      ? `UPDATE valopay_records r SET name=v.name,status=v.status,reference=v.reference,amount_kobo=v.amount_kobo,customer_id=v.customer_id,data=v.data,updated_at=v.updated_at
         FROM jsonb_to_recordset($1::jsonb) AS v(${recordsetColumns})
         WHERE r.id=v.id AND r.merchant_id=$2 AND r.kind=v.kind AND r.created_at=v.created_at AND EXISTS (
           SELECT 1 FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id
           WHERE m.id=$2 AND m.workspace_id=$3 AND w.id=$3 AND w.principal_hash=$4)`
      : `INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data,created_at,updated_at)
         SELECT v.id,$2,v.kind,v.name,v.status,v.reference,v.amount_kobo,v.customer_id,v.data,v.created_at,v.updated_at
         FROM jsonb_to_recordset($1::jsonb) AS v(${recordsetColumns}) WHERE EXISTS (
           SELECT 1 FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id
           WHERE m.id=$2 AND m.workspace_id=$3 AND w.id=$3 AND w.principal_hash=$4)`,
      [JSON.stringify(batch), merchantId, session.workspace.id, session.principal]);
    if ((result.rowCount || 0) !== batch.length) {
      if (existing) conflict("Record was changed concurrently; reload before retrying.");
      fail("Lender not found in this workspace.", 404);
    }
    start = end;
  }
  const merchantUpdate = await session.client.query(
    `UPDATE valopay_merchants m SET info=$4,settings=$5 WHERE m.id=$1 AND m.workspace_id=$2 AND EXISTS
      (SELECT 1 FROM valopay_workspaces w WHERE w.id=$2 AND w.principal_hash=$3)`,
    [merchantId, session.workspace.id, session.principal, state.merchant, state.settings],
  );
  if (!rowsAffected(merchantUpdate)) fail("Lender not found in this workspace.", 404);
  // A subsequent repository save in this transaction validates against what
  // was just written, never a caller-supplied "previous" array.
  for (const record of changed) snapshot.records.set(record.id, JSON.stringify(record));
  snapshot.merchant = JSON.stringify(state.merchant); snapshot.settings = JSON.stringify(state.settings);
}

/**
 * A terminal journal entry as a retention source, read without its request or receipt. Its payload changes only when
 * the entry settles, which moves its version, and when retention purges it; sealing or re-wrapping changes how it is
 * stored, not what it holds. So its digest is of what identifies that payload: the fingerprint of the request as it was
 * sent (the digest a repeat of its key is compared with), the key, the outcome and the version.
 */
type JournalSource = Pick<OperationRow, 'id' | 'request_key' | 'request_hash' | 'updated_at'> & { status: 'completed' | 'cancelled'; row_version: string };
const journalSourceDigest = (row: JournalSource) => canonicalDigest({ hash: row.request_hash, key: row.request_key, status: row.status, version: row.updated_at.toISOString() });
/**
 * The digest an earlier build gave a journal payload, of its stored request and receipt themselves, which it read
 * whole for every entry at every retention request. A run that build prepared holds it, and approving or executing
 * that run compares its sources with it, so the entries it names are digested so again, and match exactly when that
 * build's would have. Each digest is kept for the row version it was computed from (xmin, which any change to the row
 * moves), so a run repeated or resumed reads each request once in a process; at most 10,000 are kept.
 */
const earlierDigests = new Map<string, string>();
async function earlierJournalDigests(client: PoolClient, merchantId: string, sources: JournalSource[]): Promise<Map<string, string>> {
  const found = new Map<string, string>(), keyOf = (id: string, version: string) => `${merchantId}\u0000${id}\u0000${version}`;
  const missing = sources.filter((source) => { const known = earlierDigests.get(keyOf(source.id, source.row_version)); if (known) found.set(source.id, known); return !known; }).map((source) => source.id);
  // Ten at a time: a run names at most 100 sources, each up to the 2 MB body limit.
  for (let start = 0; start < missing.length; start += 10) {
    const rows = (await client.query<OperationRow & { row_version: string }>('SELECT id,request,receipt,request_key,request_hash,status,xmin::text AS row_version FROM valopay_operations WHERE merchant_id=$1 AND id=ANY($2::text[])', [merchantId, missing.slice(start, start + 10)])).rows;
    for (const row of rows) {
      const earlier = canonicalDigest({ request: row.request, receipt: row.receipt, key: row.request_key, hash: row.request_hash, status: row.status }, "legacy-en-us-null");
      if (earlierDigests.size >= 10_000) earlierDigests.delete(earlierDigests.keys().next().value!);
      earlierDigests.set(keyOf(row.id, row.row_version), earlier); found.set(row.id, earlier);
    }
  }
  return found;
}
/** What a retention request reads of the journal: a page of the view (its offset), a preview's first eligible sources, a run's own sources or one named source. */
export type JournalNeed = { page: number } | { preview: true } | { run: string } | { source: string };
/** A terminal entry not purged under retention; and the inventory's order of those, by retention start and then ID. */
const RETAINED_JOURNAL = `merchant_id=$1 AND status IN ('completed','cancelled') AND NOT(${PURGED_REQUEST})`, JOURNAL_ORDER = `date_trunc('milliseconds',updated_at),id COLLATE "C"`;
/**
 * The retention sources kept outside the lender's records: the export files, and the terminal journal entries' payloads
 * a request needs (`need`), read without their requests (journalSourceDigest). The view and a preview read a window of
 * the journal in the inventory's order and count the rest (JournalWindow), so their cost does not grow with the
 * requests a lender's people have made. An approval or execution reads its run's own sources, and gives one the
 * digest an earlier build computed when the run holds it and the entry still has it.
 */
export async function lifecycleInventory(context:StoreContext,state:DomainState,need:JournalNeed={page:0}):Promise<{external:LifecycleExternalCandidate[];journal?:JournalWindow}> {
 const session=sessionFor(context),merchantId=session.lockedMerchantId;
 // Inventory is also used by GET after loadState acquired a shared lender lock.
 // Physical execution still requires lockedMerchant's exclusive write snapshot.
 if(context.role!=='Admin'||!merchantId||state.merchant.id!==merchantId)fail('An administrator in this lender is required.',403);
 const files=state.records.filter(r=>r.kind==='exports'&&['ready','failed'].includes(r.status)&&!r.data.fileDeletedAt&&r.data.bucket&&r.data.objectName).map(r=>({kind:'export_file' as const,merchantId,sourceId:r.id,version:r.updatedAt,createdAt:String(r.data.generatedAt||r.updatedAt),label:'Private export file',digest:canonicalDigest({id:r.id,status:r.status,data:r.data},"legacy-en-us-null"),status:r.status as 'ready'|'failed'}));
 const listed=(rows:JournalSource[],digests=new Map<string,string>())=>rows.map(row=>({kind:'journal_payload' as const,merchantId,sourceId:row.id,version:row.updated_at.toISOString(),createdAt:row.updated_at.toISOString(),label:'Terminal operation payload',digest:digests.get(row.id)??journalSourceDigest(row),status:row.status}));
 const columns='id,status,updated_at,request_key,request_hash,xmin::text AS row_version';
 if('run' in need||'source' in need){
  const run='run' in need?state.records.find(r=>r.id===need.run&&r.kind==='retention-runs'&&r.merchantId===merchantId):undefined;
  const saved=(Array.isArray(run?.data.candidates)?run.data.candidates as LifecycleCandidate[]:[]).filter(candidate=>candidate.kind==='journal_payload');
  const ids='source' in need?[need.source]:saved.map(candidate=>candidate.sourceId);
  const rows=ids.length?(await session.client.query<JournalSource>(`SELECT ${columns} FROM valopay_operations WHERE ${RETAINED_JOURNAL} AND id=ANY($2::text[])`,[merchantId,ids])).rows:[];
  // A source whose version or outcome has changed matches no digest the run holds, so its request is not read.
  const byId=new Map(rows.map(row=>[row.id,row])),digests=new Map<string,string>();
  const earlier=saved.filter(candidate=>{const row=byId.get(candidate.sourceId);return !!row&&candidate.digest!==journalSourceDigest(row)&&candidate.version===row.updated_at.toISOString()&&candidate.status===row.status;});
  if(earlier.length){const computed=await earlierJournalDigests(session.client,merchantId,earlier.map(candidate=>byId.get(candidate.sourceId)!));for(const candidate of earlier)if(computed.get(candidate.sourceId)===candidate.digest)digests.set(candidate.sourceId,candidate.digest);}
  return {external:[...listed(rows,digests),...files]};
 }
 const rule=journalPayloadRule(state,context);
 const counted=(await session.client.query<{total:string;eligible:string}>(`SELECT count(*) AS total,count(*) FILTER (WHERE date_trunc('milliseconds',updated_at)<=$2::timestamptz AND id<>ALL($3::text[])) AS eligible FROM valopay_operations WHERE ${RETAINED_JOURNAL}`,[merchantId,rule.oldEnough,rule.held])).rows[0]!;
 // The lender's import batches and exports bound its other sources (committed CSV and export files): a page's journal
 // payloads are among that many and 100 from its offset less that many. A preview's first 100 eligible are among the
 // first 100 and the held ones.
 const others=state.records.filter(r=>r.kind==='import-batches'||r.kind==='exports').length;
 const [skipped,limit]='preview' in need?[0,100+rule.held.length]:[Math.max(0,need.page-others),others+100];
 const rows=(await session.client.query<JournalSource>(`SELECT ${columns} FROM valopay_operations WHERE ${RETAINED_JOURNAL} ORDER BY ${JOURNAL_ORDER} OFFSET $2 LIMIT $3`,[merchantId,skipped,limit])).rows;
 return {external:[...listed(rows),...files],journal:{total:Number(counted.total),eligible:Number(counted.eligible),skipped}};
}
/**
 * Executes an approved retention run under the lender lock: as many of its
 * sources as fit in the step budget, each checked again and given a receipt,
 * stopping at a blocked source or a deletion that cannot be confirmed
 * (executeApprovedRun). The console repeats the request until the run is done.
 */
export async function executeLifecycleRun(context:StoreContext,state:DomainState,id:string) {
 const session=sessionFor(context),merchantId=lockedMerchant(session);
 if(context.role!=='Admin'||session.access!=='write'||state.merchant.id!==merchantId)fail('An administrator in this lender is required.',403);
 const run=state.records.find(r=>r.id===id&&r.kind==='retention-runs');if(!run)fail('Retention run not found.',404);
 if(run.status==='completed')return lifecycleRunView(state,run);
 const {external}=await lifecycleInventory(context,state,{run:id});
 // A completed request's payload is purged in this transaction; an export file is deleted from private storage.
 const remove=async(candidate:LifecycleCandidate):Promise<'deleted'|'already_absent'>=>{
  if(candidate.kind==='journal_payload'){
   const row=(await session.client.query<Pick<OperationRow,'id'|'status'|'request_key'>>('SELECT id,status,request_key FROM valopay_operations WHERE merchant_id=$1 AND id=$2 FOR UPDATE',[merchantId,candidate.sourceId])).rows[0];
   if(!row||!['completed','cancelled'].includes(row.status))fail('The terminal request is no longer eligible.',409);
   const tombstone={purged:true,at:context.now,retentionRunId:id};
   await session.client.query("UPDATE valopay_operations SET request=$3,receipt=$3 WHERE merchant_id=$1 AND id=$2 AND status IN ('completed','cancelled')",[merchantId,row.id,tombstone]);
   await session.client.query('UPDATE valopay_idempotency SET response=$3 WHERE merchant_id=$1 AND id=ANY($2::text[])',[merchantId,receiptIds(merchantId,row.request_key,row.id),tombstone]);
   return 'deleted';
  }
  const record=state.records.find(r=>r.id===candidate.sourceId&&r.kind==='exports')!;
  const result=await deleteRetainedExport(objectStorageClient.bucket(record.data.bucket).file(record.data.objectName),{id:record.id,merchantId,checksum:record.data.checksum});
  record.data.fileDeletedAt=context.now;record.data.fileRetentionRunId=id;
  return result;
 };
 // A SQL error aborts the whole transaction; never mask it as a receipt.
 return executeApprovedRun(state,context,id,external,remove,{fatal:error=>typeof (error as any)?.code==='string'&&/^[A-Z0-9]{5}$/.test((error as any).code)});
}

/**
 * Anonymous sandboxes older than the cookie lifetime with no change by a
 * person in that time are removed, children first; signed-in workspaces never
 * carry the flag and are never swept.  Activity is read from the audit chain,
 * which every request mutation appends to, so the scheduled close (a system
 * actor) never keeps an abandoned sandbox alive.  Ordinary DML inside the
 * caller's transaction.
 *
 * Nothing is deleted until the workspace row and every one of its lenders
 * are locked, in lender order and without waiting (SKIP LOCKED). The
 * scheduled close, the export worker, Paystack test deliveries and requests
 * all hold a lender's row while they write its records, and a request holds
 * its workspace row, so a sandbox with either held elsewhere is left whole
 * for a later sweep. Deleting the records first and then waiting for such a
 * lender deadlocked with a close that saved it. Each sandbox is locked in a
 * savepoint of its own and a busy one is undone at once, so its free lenders
 * and its row are not held for the rest of the caller's transaction. An export
 * renders and uploads outside that lock: any running export, even one with an
 * expired lease, keeps its workspace until the worker settles or recovers it.
 *
 * Answers the swept sandboxes' export files, read before their records go:
 * private storage is not part of the transaction, so the caller removes them
 * once the deletion has committed (removeSweptExportFiles).
 */
export async function sweepExpiredWorkspaces(client: PoolClient, limit: number): Promise<{ workspaces: number; files: SweptExportFile[] }> {
  const staleness = `w.created_at < now() - make_interval(days => $1)
       AND EXISTS (SELECT 1 FROM valopay_merchants m WHERE m.workspace_id=w.id AND m.settings->>'anonymousWorkspace'='true')
       AND NOT EXISTS (SELECT 1 FROM valopay_records r JOIN valopay_merchants m ON m.id=r.merchant_id
                       WHERE m.workspace_id=w.id AND r.kind='audit' AND r.created_at >= now() - make_interval(days => $1)
                         AND COALESCE(r.data->>'actor','') NOT LIKE $2)`;
  const candidates = (await client.query<{ id: string }>(
    `SELECT w.id FROM valopay_workspaces w WHERE ${staleness} ORDER BY w.created_at LIMIT $3`,
    [ANONYMOUS_WORKSPACE_DAYS, `${SYSTEM_ACTOR_PREFIX}%`, limit],
  )).rows.map((row) => row.id);
  const expired: string[] = [];
  for (const id of candidates) {
    await client.query("SAVEPOINT expired_workspace");
    // Read again once locked: a person may have used the sandbox since the list above was read.
    const still = rowsAffected(await client.query(`SELECT w.id FROM valopay_workspaces w WHERE w.id=$3 AND ${staleness} FOR UPDATE OF w SKIP LOCKED`, [ANONYMOUS_WORKSPACE_DAYS, `${SYSTEM_ACTOR_PREFIX}%`, id]));
    // The workspace row, once locked, keeps the lender list fixed: adding a lender needs its workspace.
    const lenders = still ? (await client.query<{ total: number }>("SELECT count(*)::int AS total FROM valopay_merchants WHERE workspace_id=$1", [id])).rows[0]!.total : 0;
    const locked = still ? (await client.query("SELECT id FROM valopay_merchants WHERE workspace_id=$1 ORDER BY id FOR UPDATE SKIP LOCKED", [id])).rowCount || 0 : 0;
    // Recheck only after every lender is locked. A claim cannot start between
    // this check and deletion, and an upload in progress retains its job and
    // future cleanup identity even when its database lease has expired.
    const uploading = still && locked === lenders && rowsAffected(await client.query(`SELECT 1 FROM valopay_records r
      JOIN valopay_merchants m ON m.id=r.merchant_id WHERE m.workspace_id=$1 AND r.kind='exports' AND r.status='running' LIMIT 1`, [id]));
    if (still && locked === lenders && !uploading) { await client.query("RELEASE SAVEPOINT expired_workspace"); expired.push(id); }
    else await client.query("ROLLBACK TO SAVEPOINT expired_workspace");
  }
  if (!expired.length) return { workspaces: 0, files: [] };
  // Every export that names a stored file, whatever its status; one an approved retention run removed is gone already.
  const files = (await client.query<{ merchant_id: string; id: string; bucket: string; object_name: string; checksum: string | null }>(
    `SELECT r.merchant_id, r.id, r.data->>'bucket' AS bucket, r.data->>'objectName' AS object_name, r.data->>'checksum' AS checksum
     FROM valopay_records r JOIN valopay_merchants m ON m.id=r.merchant_id
     WHERE m.workspace_id = ANY($1::text[]) AND r.kind='exports' AND coalesce(r.data->>'bucket','') <> '' AND coalesce(r.data->>'objectName','') <> ''
       AND coalesce(r.data->>'fileDeletedAt','') = '' ORDER BY r.merchant_id, r.id`, [expired],
  )).rows.map((row): SweptExportFile => ({ merchantId: row.merchant_id, exportId: row.id, bucket: row.bucket, objectName: row.object_name, ...(row.checksum ? { checksum: row.checksum } : {}) }));
  // Written in the same transaction, before their source records disappear. A rolled-back sweep leaves no cleanup
  // work; a committed sweep keeps every remaining private file identifiable through outages and process restarts.
  // An interrupted upload may have lost its answer just before its job became
  // failed or queued. Retain that tombstone for five minutes before the first
  // storage check, covering the bounded four-minute attempt and one-minute
  // storage request. This is a quiescence allowance, not proof that an external
  // provider can never commit arbitrarily late after a client cancellation.
  if (files.length) await client.query(`INSERT INTO valopay_export_cleanup(id,merchant_id,bucket,object_name,checksum,next_attempt_at)
    SELECT r.id,r.merchant_id,r.data->>'bucket',r.data->>'objectName',r.data->>'checksum',
      CASE WHEN r.status<>'ready' AND CASE WHEN jsonb_typeof(r.data->'attempts')='number' THEN (r.data->>'attempts')::numeric>0 ELSE false END
        THEN now()+interval '5 minutes' ELSE now() END
    FROM valopay_records r JOIN valopay_merchants m ON m.id=r.merchant_id
    WHERE m.workspace_id=ANY($1::text[]) AND r.kind='exports' AND coalesce(r.data->>'bucket','')<>'' AND coalesce(r.data->>'objectName','')<>''
      AND coalesce(r.data->>'fileDeletedAt','')='' ORDER BY r.merchant_id,r.id
    ON CONFLICT (id) DO NOTHING`, [expired]);
  await client.query("DELETE FROM valopay_idempotency WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id = ANY($1::text[]))", [expired]);
  await client.query("DELETE FROM valopay_records WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id = ANY($1::text[]))", [expired]);
  await client.query("DELETE FROM valopay_merchants WHERE workspace_id = ANY($1::text[])", [expired]);
  await client.query("DELETE FROM valopay_workspaces WHERE id = ANY($1::text[])", [expired]);
  return { workspaces: expired.length, files };
}

/** An export file a swept sandbox's lender wrote to private storage: where it is and, once ready, its checksum. */
export interface SweptExportFile { merchantId: string; exportId: string; bucket: string; objectName: string; checksum?: string }
type SweepLog = { warn?(fields: object, message: string): void };
/** How long one bootstrap goes on starting removals of swept export files, so a new visitor never waits long for private storage. */
const SWEPT_FILE_BUDGET_MS = 5_000;
/** Removes one swept export's file: only the generation whose metadata names this export and lender, and its checksum once ready (deleteRetainedExport). */
let removeSweptFile = (file: SweptExportFile) => deleteRetainedExport(objectStorageClient.bucket(file.bucket).file(file.objectName), { id: file.exportId, merchantId: file.merchantId, ...(file.checksum ? { checksum: file.checksum } : {}) });
/** For tests only: replaces how a swept export's file is removed from private storage, and returns what restores it. */
export function overrideSweptExportRemoval(remove: typeof removeSweptFile): () => void {
  const previous = removeSweptFile;
  removeSweptFile = remove;
  return () => { removeSweptFile = previous; };
}
/**
 * Removes the export files of the sandboxes a sweep deleted, one at a time.
 * inWorkspace calls it once that deletion has committed, so a sweep that was
 * undone keeps its files with its records. It never throws, so it never fails
 * the request or undoes the sweep. A file not removed within the budget stays
 * in the durable queue, whose background worker retries after outages and
 * restarts. Logs identify only the job; private storage paths stay in the queue.
 */
export async function removeSweptExportFiles(files: SweptExportFile[], log?: SweepLog, budgetMs = SWEPT_FILE_BUDGET_MS): Promise<void> {
  try { await runExportCleanupPass({ ids: files.map(file => file.exportId), limit: files.length, budgetMs, log }); }
  catch { try { log?.warn?.({ event: 'workspace.sweep_cleanup_deferred' }, 'Private export cleanup remains queued for retry'); } catch { /* logging cannot fail a bootstrap */ } }
}

/** Claim one tombstone atomically. No connection is held during storage I/O; crashed claims become available after
 * two minutes. The token prevents a late worker from removing a newer worker's claim. Restricted tenant runtimes
 * neither read this global queue nor receive its database privileges. */
export async function runExportCleanupPass(options: { ids?: string[]; limit?: number; budgetMs?: number; stopped?: () => boolean; log?: SweepLog } = {}) {
  if (runtimeIsolationEnabled()) return { attempted: 0, removed: 0, deferred: 0 };
  const started = performance.now(), result = { attempted: 0, removed: 0, deferred: 0 };
  const limit = Math.max(0, Math.min(20, Math.floor(options.limit ?? 5)));
  for (let n = 0; n < limit && performance.now() - started < (options.budgetMs ?? 10_000) && !options.stopped?.(); n++) {
    const token = randomUUID();
    const row = await runtimeServiceRead(async client => (await client.query<{ id: string; merchant_id: string; bucket: string; object_name: string; checksum: string | null; attempts: number }>(`WITH candidate AS (
      SELECT id FROM valopay_export_cleanup WHERE next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<=now())
        AND ($2::text[] IS NULL OR id=ANY($2::text[])) ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE valopay_export_cleanup q SET lease_token=$1,lease_until=now()+interval '2 minutes',attempts=least(q.attempts::bigint+1,2147483647)::int,updated_at=now()
      FROM candidate c WHERE q.id=c.id RETURNING q.id,q.merchant_id,q.bucket,q.object_name,q.checksum,q.attempts`, [token, options.ids ?? null])).rows[0]);
    if (!row) break;
    result.attempted++;
    const file: SweptExportFile = { exportId: row.id, merchantId: row.merchant_id, bucket: row.bucket, objectName: row.object_name, ...(row.checksum ? { checksum: row.checksum } : {}) };
    try {
      await removeSweptFile(file);
      await runtimeServiceRead(client => client.query('DELETE FROM valopay_export_cleanup WHERE id=$1 AND lease_token=$2', [row.id, token]));
      result.removed++;
    } catch (error) {
      result.deferred++;
      // A bounded code, never a storage response, private path or credential. Retry retains the ownership guard;
      // an object whose identity changed remains queued for an operator to investigate, never deleted by force.
      const retrySeconds = Math.min(3600, 30 * 2 ** Math.min(row.attempts - 1, 7));
      await runtimeServiceRead(client => client.query(`UPDATE valopay_export_cleanup SET lease_token=NULL,lease_until=NULL,last_failure='storage_or_queue_unavailable',
        next_attempt_at=now()+make_interval(secs=>$3),updated_at=now() WHERE id=$1 AND lease_token=$2`, [row.id, token, retrySeconds]));
      try { options.log?.warn?.({ event: 'workspace.sweep_file_left', exportId: row.id, merchantId: row.merchant_id, reason: 'failed', retrySeconds }, 'Private export cleanup failed and remains queued for retry'); } catch { /* no effect on work */ }
    }
  }
  return result;
}

/** Operator-only aggregate status. No export payload, customer identifier or private storage path is returned. */
export async function exportCleanupStatus() {
  if (runtimeIsolationEnabled()) fail('Export cleanup is owned by the sandbox service, outside restricted tenant runtimes.', 403);
  const row = await runtimeServiceRead(async client => (await client.query(`SELECT count(*)::int AS pending,
    count(*) FILTER (WHERE lease_until>now())::int AS leased,
    count(*) FILTER (WHERE next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<=now()))::int AS ready,
    count(*) FILTER (WHERE attempts>0)::int AS retried,
    min(created_at) AS oldest FROM valopay_export_cleanup`)).rows[0]);
  return { ...row, oldest: row.oldest?.toISOString() ?? null };
}

async function seedWorkspace(client: PoolClient, workspace: WorkspaceRow, principal: string, anonymous: boolean, now: string) {
  for (const smaller of [false, true]) {
    const state = seedMerchant(randomUUID(), smaller);
    state.settings.anonymousWorkspace = anonymous;
    // REC-01: the first scheduled close is the next configured time after creation, from the database clock.
    state.settings.nextCloseAt = nextCloseInstant(now, closeTimeOf(state.settings));
    // Before the lender row is written, so its settings carry the audit chain's head.
    appendAudit(state, { actor: `${SYSTEM_ACTOR_PREFIX}sandbox seed`, role: "Admin", now }, "sandbox.created", "workspace", "Created an isolated synthetic lender. Not live evidence.");
    const merchant = await client.query(
      `INSERT INTO valopay_merchants(id,workspace_id,info,settings)
       SELECT $1,$2,$3,$4 WHERE EXISTS (SELECT 1 FROM valopay_workspaces WHERE id=$2 AND principal_hash=$5)`,
      [state.merchant.id, workspace.id, state.merchant, state.settings, principal],
    );
    if (!rowsAffected(merchant)) throw new Error("Workspace seed ownership check failed.");
    assertFinalState({ merchant: structuredClone(state.merchant), settings: {}, records: [] }, state, state.merchant.id);
    for (const record of state.records) {
      const inserted = await client.query(
        `INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data,created_at,updated_at)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11 WHERE EXISTS (
           SELECT 1 FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id
           WHERE m.id=$2 AND m.workspace_id=$12 AND w.id=$12 AND w.principal_hash=$13)`,
        [record.id, record.merchantId, record.kind, record.name, record.status, record.reference, record.amountKobo, record.customerId, record.data, record.createdAt, record.updatedAt, workspace.id, principal],
      );
      if (!rowsAffected(inserted)) throw new Error("Workspace seed record ownership check failed.");
    }
  }
}

/**
 * A system transaction scoped to one merchant, for the scheduled close.  The
 * scope is the merchant's own workspace and principal, so every repository
 * query keeps its tenant predicate.  The merchant row is taken with SKIP
 * LOCKED: two instances never close the same lender at once and a request in
 * flight is never queued behind the scheduler.  Returns undefined when the
 * merchant is locked elsewhere or no longer exists.  It carries the system
 * limits (database-limits.ts) and is not gated: SKIP LOCKED already keeps it
 * from waiting on a busy lender.
 */
export async function inMerchantAsSystem<T>(merchantId: string, actor: string, fn: (context: StoreContext) => Promise<T>): Promise<T | undefined> {
  if (!actor.startsWith(SYSTEM_ACTOR_PREFIX)) throw new Error("A system transaction needs a system actor.");
  const guard = await checkOut(() => pool.connect()), client = guard.client;
  let context: StoreContext | undefined, committing = false;
  try {
    await client.query(beginStatement(databaseLimits().system));
    await bindRuntimeService(client);
    const scope = (await client.query<{ id: string; workspace_id: string; principal_hash: string; role: string }>(
      `SELECT m.id,m.workspace_id,w.principal_hash,w.role FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id
       WHERE m.id=$1 FOR UPDATE OF m SKIP LOCKED`,
      [merchantId],
    )).rows[0];
    if (!scope) { await client.query("ROLLBACK"); return undefined; }
    const now = (await client.query<{ now: Date }>("SELECT now() AS now")).rows[0]!.now.toISOString();
    context = Object.freeze({ authenticated: true, role: "Operations", actor, now });
    sessions.set(context, { client, workspace: { id: scope.workspace_id, principal_hash: scope.principal_hash, role: scope.role }, principal: scope.principal_hash, active: true, access: "write" });
    const result = await fn(context);
    committing = true;
    const committed = await client.query("COMMIT");
    if (committed.command !== "COMMIT") throw new Error("The system transaction was rolled back.");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* transaction is already closed */ }
    throw failedTransaction(error, { committing, lost: guard.lost(), write: true });
  } finally {
    if (context) {
      const session = sessions.get(context);
      if (session) { session.active = false; session.snapshot = undefined; session.summarised = undefined; session.auditChain = undefined; session.auditCheck = undefined; session.lockedMerchantId = undefined; }
    }
    guard.release();
  }
}

/**
 * Whether a lender exists in a workspace, read without its lock: when
 * inMerchantAsSystem finds no row to lock, this tells a lender busy elsewhere
 * from one that is not there.  A plain read with the system limits; under
 * runtime isolation it runs as the service member, as the lock does.
 */
export async function merchantInWorkspace(merchantId: string, workspaceId: string): Promise<boolean> {
  return runtimeServiceRead(async client => Boolean((await client.query("SELECT 1 FROM valopay_merchants WHERE id=$1 AND workspace_id=$2", [merchantId, workspaceId])).rows[0]));
}

/**
 * The next lenders whose scheduled close is due, in a fair order: staff and
 * signed-in lenders before anonymous sandboxes; lenders waiting to retry a
 * failed attempt after the rest; one lender per workspace per turn, so one
 * workspace's many lenders never hold another's back; then the earliest
 * time.  A lender waiting for its retry time is not due.  Each says whether
 * it is a public anonymous sandbox (settings.anonymousWorkspace, set only when
 * a visitor's sandbox is seeded with a lender or creates one), whose failed
 * close a pass counts apart.  `exclude` leaves out lenders a pass has already
 * dealt with; `only` limits the read to the lenders named (tests and operator
 * tooling).  A plain read with the system limits (runtimeServiceRead binds
 * the service identity only under runtime isolation): the caller re-checks
 * under the merchant lock before closing.
 */
export async function dueScheduledCloses(limit: number, options: { exclude?: readonly string[]; only?: readonly string[] } = {}): Promise<Array<{ id: string; publicSandbox: boolean }>> {
  return runtimeServiceRead(async client => (await client.query<{ id: string; anonymous: boolean }>(
    `WITH ready AS (
       SELECT m.id, m.workspace_id,
         (CASE WHEN m.settings->>'nextCloseAt' ~ $2 THEN (m.settings->>'nextCloseAt')::timestamptz END) AS due_at,
         -- A retry counts only for the pending time and when well formed, as closeRetryOf reads it.
         CASE WHEN m.settings->'closeRetry'->>'cursor' = m.settings->>'nextCloseAt' AND m.settings->'closeRetry'->>'failures' ~ '^[1-9][0-9]{0,5}$' AND m.settings->'closeRetry'->>'retryAt' ~ $2
              THEN (m.settings->'closeRetry'->>'failures')::int ELSE 0 END AS failures,
         CASE WHEN m.settings->'closeRetry'->>'cursor' = m.settings->>'nextCloseAt' AND m.settings->'closeRetry'->>'failures' ~ '^[1-9][0-9]{0,5}$' AND m.settings->'closeRetry'->>'retryAt' ~ $2
              THEN (m.settings->'closeRetry'->>'retryAt')::timestamptz END AS retry_at,
         COALESCE(m.settings->>'anonymousWorkspace', 'false') = 'true' AS anonymous
       FROM valopay_merchants m
       WHERE COALESCE(m.settings->>'scheduledCloseEnabled','true') <> 'false'
         AND NOT (m.id = ANY($3::text[])) AND ($4::text[] IS NULL OR m.id = ANY($4::text[]))
     ), due AS (
       SELECT * FROM ready WHERE due_at <= now() AND (retry_at IS NULL OR retry_at <= now())
     ), ranked AS (
       SELECT id, anonymous, failures, due_at, row_number() OVER (PARTITION BY workspace_id ORDER BY failures > 0, due_at, id) AS turn FROM due
     )
     SELECT id, anonymous FROM ranked ORDER BY anonymous, failures > 0, turn, due_at, id LIMIT $1`,
    [limit, ISO_INSTANT_PATTERN, [...(options.exclude ?? [])], options.only ? [...options.only] : null],
  )).rows.map((row) => ({ id: row.id, publicSandbox: row.anonymous })));
}

/** Lenders still owed a scheduled close, counted without naming any: every lender but public anonymous sandboxes, whose own counts are apart. */
export interface OwedCloses { overdue: number; failing: number; publicSandboxes: { overdue: number; failing: number } }

/**
 * What the scheduled close still owes, counted without naming a lender: the
 * lenders whose automatic close is on and whose pending close is more than
 * `lateAfterMinutes` past its time (missed, as the close_missed alert reads
 * it), and those with a failed scheduled attempt recorded at their pending
 * time (settings.closeRetry, as closeRetryOf reads it), which only a close of
 * that lender, or a change to its schedule, ends.  Public anonymous sandboxes
 * (settings.anonymousWorkspace, a visitor's synthetic lenders, whose own data
 * can make a close fail) are counted apart, in publicSandboxes.  Durable facts
 * on the database clock, so no other lender's close clears them and a
 * restarted process reads them again.  `only` limits the count to the lenders
 * named (tests and operator tooling).  A plain read with the system limits,
 * as dueScheduledCloses is.
 */
export async function scheduledCloseBacklog(lateAfterMinutes: number, options: { only?: readonly string[] } = {}): Promise<OwedCloses> {
  return runtimeServiceRead(async client => {
    const row = (await client.query<{ overdue: number; failing: number; sandboxes_overdue: number; sandboxes_failing: number }>(
      `SELECT count(*) FILTER (WHERE NOT anonymous AND late)::int AS overdue, count(*) FILTER (WHERE NOT anonymous AND failing)::int AS failing,
              count(*) FILTER (WHERE anonymous AND late)::int AS sandboxes_overdue, count(*) FILTER (WHERE anonymous AND failing)::int AS sandboxes_failing
       FROM (SELECT
         floor(extract(epoch FROM now() - CASE WHEN m.settings->>'nextCloseAt' ~ $1 THEN (m.settings->>'nextCloseAt')::timestamptz END) / 60) > $2 AS late,
         m.settings->>'nextCloseAt' ~ $1 AND m.settings->'closeRetry'->>'cursor' = m.settings->>'nextCloseAt'
           AND m.settings->'closeRetry'->>'failures' ~ '^[1-9][0-9]{0,5}$' AND m.settings->'closeRetry'->>'retryAt' ~ $1 AS failing,
         COALESCE(m.settings->>'anonymousWorkspace', 'false') = 'true' AS anonymous
         FROM valopay_merchants m
         WHERE COALESCE(m.settings->>'scheduledCloseEnabled','true') <> 'false' AND ($3::text[] IS NULL OR m.id = ANY($3::text[]))) lenders`,
      [ISO_INSTANT_PATTERN, lateAfterMinutes, options.only ? [...options.only] : null],
    )).rows[0];
    return { overdue: row?.overdue ?? 0, failing: row?.failing ?? 0, publicSandboxes: { overdue: row?.sandboxes_overdue ?? 0, failing: row?.sandboxes_failing ?? 0 } };
  });
}

/**
 * Records a failed scheduled attempt on the lender (settings.closeRetry): one
 * more failure at its pending close time and when to try again, from the
 * database clock.  Its own small service transaction, after the failed close
 * rolled back; the row is taken with SKIP LOCKED, so a request or another
 * instance holding the lender is never waited for.  Returns undefined when
 * nothing was recorded: the lender is gone or locked, or its close is no
 * longer pending because someone closed it meanwhile.  The error text is never
 * stored, because the lender's settings are shown to its users.
 */
export async function recordScheduledCloseFailure(merchantId: string): Promise<CloseRetry | undefined> {
  return runtimeServiceRead(async client => {
    const row = (await client.query<{ settings: Record<string, unknown>; now: Date }>("SELECT settings, now() AS now FROM valopay_merchants WHERE id=$1 FOR UPDATE SKIP LOCKED", [merchantId])).rows[0];
    const retry = row ? nextCloseRetry(row.settings, row.now.toISOString()) : null;
    if (!retry) return undefined;
    const updated = await client.query("UPDATE valopay_merchants SET settings = settings || jsonb_build_object('closeRetry', $2::jsonb) WHERE id=$1", [merchantId, JSON.stringify(retry)]);
    return rowsAffected(updated) ? retry : undefined;
  });
}

/**
 * Whether nobody has changed this context's workspace for `days`: it is older
 * than that and no audit entry by a person was written within it.  The same
 * definition of activity as the expiry sweep, so the scheduled close's own
 * entries never count.
 */
export async function sandboxInactiveFor(context: StoreContext, days: number): Promise<boolean> {
  const session = sessionFor(context);
  return (await session.client.query<{ idle: boolean }>(
    `SELECT (w.created_at < now() - make_interval(days => $2)) AND NOT EXISTS (
       SELECT 1 FROM valopay_merchants m JOIN valopay_records r ON r.merchant_id=m.id
       WHERE m.workspace_id=w.id AND r.kind='audit' AND r.created_at >= now() - make_interval(days => $2)
         AND COALESCE(r.data->>'actor','') NOT LIKE $3) AS idle
     FROM valopay_workspaces w WHERE w.id=$1`,
    [session.workspace.id, days, `${SYSTEM_ACTOR_PREFIX}%`],
  )).rows[0]?.idle === true;
}

/**
 * Merchants created before the scheduler existed carry no cursor.  Each gets
 * the next configured time after the database clock, without a close, so the
 * first scheduled close comes at its time rather than at the next tick.
 */
export async function initialiseCloseCursors(): Promise<number> {
  return runtimeServiceRead(async client => {
    if (runtimeIsolationEnabled()) {
      const rows = (await client.query<{ id: string; settings: Record<string, unknown>; now: Date }>("SELECT m.id,m.settings,now() AS now FROM valopay_merchants m WHERE m.settings->>'nextCloseAt' IS NULL FOR UPDATE", [])).rows;
      for (const row of rows) await client.query("UPDATE valopay_merchants SET settings=settings || jsonb_build_object('nextCloseAt',$2::text) WHERE id=$1 AND settings->>'nextCloseAt' IS NULL", [row.id, nextCloseInstant(row.now.toISOString(), closeTimeOf(row.settings))]);
      return rows.length;
    }
    const rows = (await client.query<{ id: string; settings: Record<string, unknown>; now: Date }>(
      "SELECT m.id,m.settings,now() AS now FROM valopay_merchants m WHERE m.settings->>'nextCloseAt' IS NULL",
    )).rows;
    if (!rows.length) return 0;
    const updated = await client.query(
      `UPDATE valopay_merchants m SET settings = m.settings || jsonb_build_object('nextCloseAt', v.next_at)
       FROM (SELECT unnest($1::text[]) AS id, unnest($2::text[]) AS next_at) v
       WHERE m.id = v.id AND m.settings->>'nextCloseAt' IS NULL`,
      [rows.map((row) => row.id), rows.map((row) => nextCloseInstant(row.now.toISOString(), closeTimeOf(row.settings)))],
    );
    return updated.rowCount || 0;
  });
}

/** Where a table comes from: the base schema, or the migration in lib/db/migrations that adds it. */
const tableMigrations: Record<string, string> = {
  valopay_operations: "003_pilot_workflow.sql", valopay_teams: "003_pilot_workflow.sql", valopay_staff_memberships: "003_pilot_workflow.sql",
  valopay_staff_invitations: "003_pilot_workflow.sql", valopay_staff_events: "003_pilot_workflow.sql", valopay_staff_lender_access: "004_staff_lender_access.sql",
  valopay_export_cleanup: '013_export_cleanup.sql',
};
const schemaSource = (table: string) => tableMigrations[table] ? `apply lib/db/migrations/${tableMigrations[table]}` : "create it from the Drizzle schema in lib/db";
/**
 * Where a missing column comes from: no migration adds one, since each creates its tables whole (CREATE TABLE IF NOT
 * EXISTS) and applying it again leaves a table that exists as it is, so a column is added as the Drizzle schema declares it.
 */
const columnSource = "add it from the Drizzle schema in lib/db";
/** Every table this build uses, with every column the Drizzle schema in lib/db gives it. */
const requiredTables = [tables.workspaces, tables.merchants, tables.records, tables.idempotency, tables.operations, tables.teams, tables.staffMemberships, tables.staffInvitations, tables.staffEvents, tables.staffLenderAccess, tables.exportCleanup]
  .map((table) => { const config = getTableConfig(table); return { name: config.name, columns: config.columns.map((column) => column.name) }; });
/**
 * The integrity guards the Drizzle schema in lib/db declares: every unique
 * index (those behind primary keys and unique constraints included) and every
 * check constraint, as PostgreSQL 16 writes their definitions. Without one the
 * database accepts what the application relies on it to refuse: a second
 * workspace for one principal, two attempts in flight for one instalment, a
 * provider event recorded twice, money outside the safe range. So a missing
 * guard makes the schema incomplete, not slower. Compared by definition, not
 * by name, like the indexes below.
 */
export const integrityGuards = [
  { type: "unique index", name: "valopay_workspaces_pkey", table: "valopay_workspaces", definition: "USING btree (id)" },
  { type: "unique index", name: "valopay_workspaces_principal_hash_unique", table: "valopay_workspaces", definition: "USING btree (principal_hash)" },
  { type: "unique index", name: "valopay_merchants_pkey", table: "valopay_merchants", definition: "USING btree (id)" },
  { type: "unique index", name: "valopay_records_pkey", table: "valopay_records", definition: "USING btree (id)" },
  { type: "unique index", name: "valopay_unique_due_reference", table: "valopay_records", definition: "USING btree (merchant_id, reference) WHERE ((kind = 'due-items'::text) AND (reference <> ''::text))" },
  { type: "unique index", name: "valopay_unique_customer_reference", table: "valopay_records", definition: "USING btree (merchant_id, reference) WHERE ((kind = 'customers'::text) AND (reference <> ''::text))" },
  { type: "unique index", name: "valopay_unique_provider_event", table: "valopay_records", definition: "USING btree (merchant_id, translate(COALESCE(NULLIF(btrim((data ->> 'providerConnection'::text)), ''::text), NULLIF(btrim((data ->> 'provider'::text)), ''::text), ''::text), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'::text, 'abcdefghijklmnopqrstuvwxyz'::text), COALESCE((data ->> 'source'::text), ''::text), ((data ->> 'eventId'::text))) WHERE ((kind = 'observations'::text) AND ((data ->> 'eventId'::text) IS NOT NULL))" },
  { type: "unique index", name: "valopay_one_inflight", table: "valopay_records", definition: "USING btree (merchant_id, ((data ->> 'dueItemId'::text))) WHERE ((kind = 'attempts'::text) AND (status = ANY (ARRAY['scheduled'::text, 'sent'::text, 'unknown'::text])))" },
  { type: "check", name: "valopay_money_integer", table: "valopay_records", definition: "CHECK (((amount_kobo >= 0) AND (amount_kobo <= '9007199254740991'::bigint)))" },
  { type: "check", name: "valopay_ticket_floor", table: "valopay_records", definition: "CHECK (((kind <> 'due-items'::text) OR (amount_kobo >= 500000)))" },
  { type: "unique index", name: "valopay_idempotency_pkey", table: "valopay_idempotency", definition: "USING btree (id)" },
  { type: "unique index", name: "valopay_idempotency_tenant_key", table: "valopay_idempotency", definition: "USING btree (merchant_id, id)" },
  { type: "unique index", name: "valopay_operations_pkey", table: "valopay_operations", definition: "USING btree (id)" },
  { type: "check", name: "valopay_operation_status", table: "valopay_operations", definition: "CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'cancelled'::text])))" },
  { type: "unique index", name: "valopay_teams_pkey", table: "valopay_teams", definition: "USING btree (workspace_id)" },
  { type: "unique index", name: "valopay_teams_organization_id_unique", table: "valopay_teams", definition: "USING btree (organization_id)" },
  { type: "unique index", name: "valopay_staff_memberships_pkey", table: "valopay_staff_memberships", definition: "USING btree (id)" },
  { type: "unique index", name: "valopay_staff_workspace_user", table: "valopay_staff_memberships", definition: "USING btree (workspace_id, user_id)" },
  { type: "check", name: "valopay_staff_status", table: "valopay_staff_memberships", definition: "CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'revoked'::text])))" },
  { type: "check", name: "valopay_staff_role", table: "valopay_staff_memberships", definition: "CHECK ((role = ANY (ARRAY['Admin'::text, 'Operations'::text, 'Finance'::text, 'Compliance reviewer'::text, 'Read-only'::text])))" },
  { type: "unique index", name: "valopay_staff_invitations_pkey", table: "valopay_staff_invitations", definition: "USING btree (id)" },
  { type: "unique index", name: "valopay_staff_invitations_token_hash_unique", table: "valopay_staff_invitations", definition: "USING btree (token_hash)" },
  { type: "check", name: "valopay_invitation_status", table: "valopay_staff_invitations", definition: "CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'revoked'::text])))" },
  { type: "unique index", name: "valopay_staff_events_pkey", table: "valopay_staff_events", definition: "USING btree (id)" },
  { type: "unique index", name: "valopay_staff_lender_access_membership_id_merchant_id_pk", table: "valopay_staff_lender_access", definition: "USING btree (membership_id, merchant_id)" },
  { type: 'unique index', name: 'valopay_export_cleanup_pkey', table: 'valopay_export_cleanup', definition: 'USING btree (id)' },
  { type: 'check', name: 'valopay_export_cleanup_attempts', table: 'valopay_export_cleanup', definition: 'CHECK ((attempts >= 0))' },
] as const;
/**
 * The migration in lib/db/migrations that builds an integrity guard again
 * when applied: 009 its two, and 003 the membership index it creates on its
 * own. Every other guard comes with its table, from the Drizzle schema or
 * inside the CREATE TABLE IF NOT EXISTS of 003 or 004, which leaves a table
 * that exists as it is, so it is restored by hand (docs/database-migrations.md).
 */
export const guardMigrations: Partial<Record<(typeof integrityGuards)[number]["name"], string>> = {
  valopay_unique_customer_reference: "009_record_identity_guards.sql", valopay_unique_provider_event: "009_record_identity_guards.sql",
  valopay_staff_workspace_user: "003_pilot_workflow.sql",
};
const guardSource = (name: (typeof integrityGuards)[number]["name"]) => guardMigrations[name] ? `apply lib/db/migrations/${guardMigrations[name]}` : "restore it as docs/database-migrations.md describes";
/**
 * Unique indexes this build must not find, compared by definition: the
 * provider event guard before migration 009, one event ID per lender and
 * source whatever the provider, which refuses a second provider's delivery.
 * 009 drops it under any name; tables copied with LIKE ... INCLUDING ALL, as
 * an isolated runtime schema's are, hold it under a generated one.
 */
export const supersededGuards = [
  { name: "valopay_unique_observation", table: "valopay_records", definition: "USING btree (merchant_id, ((data ->> 'source'::text)), ((data ->> 'eventId'::text))) WHERE ((kind = 'observations'::text) AND ((data ->> 'eventId'::text) IS NOT NULL))", description: "the earlier provider event guard, which refuses one event ID from two providers", migration: "009_record_identity_guards.sql" },
] as const;
/**
 * The read indexes later migrations add, as PostgreSQL 16 writes their
 * definitions after the name and table. They are compared by definition, not
 * by name: an isolated runtime schema holds copies of the tables whose indexes
 * carry generated names.
 */
const requiredIndexes = [
  { name: 'valopay_export_cleanup_due', table: 'valopay_export_cleanup', definition: 'USING btree (next_attempt_at, id)', migration: '013_export_cleanup.sql' },
  { name: "valopay_records_lender_kind_page", table: "valopay_records", definition: "USING btree (merchant_id, kind, created_at, id)", migration: "002_record_list_indexes.sql" },
  { name: "valopay_records_lender_kind_status_page", table: "valopay_records", definition: "USING btree (merchant_id, kind, status, created_at, id)", migration: "002_record_list_indexes.sql" },
  { name: "valopay_records_lender_customer", table: "valopay_records", definition: "USING btree (merchant_id, customer_id, created_at, id)", migration: "002_record_list_indexes.sql" },
  { name: "valopay_records_lender_kind_updated", table: "valopay_records", definition: "USING btree (merchant_id, kind, updated_at)", migration: "002_record_list_indexes.sql" },
  { name: "valopay_staff_lender_access_lender", table: "valopay_staff_lender_access", definition: "USING btree (merchant_id, membership_id)", migration: "004_staff_lender_access.sql" },
  { name: "valopay_operations_pending", table: "valopay_operations", definition: "USING btree (merchant_id, owner) WHERE (status = 'pending'::text)", migration: "007_journal_and_lender_indexes.sql" },
  { name: "valopay_merchants_workspace", table: "valopay_merchants", definition: "USING btree (workspace_id, id)", migration: "007_journal_and_lender_indexes.sql" },
  { name: "valopay_records_export_queue", table: "valopay_records", definition: "USING btree (created_at, id) WHERE ((kind = 'exports'::text) AND (status = ANY (ARRAY['queued'::text, 'running'::text])))", migration: "008_export_queue_index_and_foreign_key_names.sql" },
] as const;
type SchemaCatalogue = {
  columns: Array<{ table: string; column: string }>;
  indexes: Array<{ table: string; schema: string; name: string; unique: boolean; valid: boolean; definition: string }>;
  checks: Array<{ table: string; definition: string }>;
};
/**
 * The columns, ready indexes and validated check constraints of the
 * application's tables, in one catalogue read: in the schema named, or else the
 * tables the connection's unqualified queries reach along its search path
 * (pg_table_is_visible), which is not always the first schema on it. A check
 * added NOT VALID is left out: it has not checked the rows already stored. An
 * index that is ready but not valid, as an interrupted concurrent build or drop
 * leaves it, is kept on every write, so a unique one still refuses duplicates,
 * but it may not cover every row: it counts as a guard or read index only once
 * valid, and as a superseded guard while ready.
 */
const schemaCatalogue = `SELECT
  (SELECT coalesce(json_agg(json_build_object('table',c.relname,'column',a.attname)),'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE CASE WHEN $1::text IS NULL THEN pg_table_is_visible(c.oid) ELSE n.nspname=$1::text END AND c.relname=ANY($2::text[]) AND c.relkind IN ('r','p')) AS columns,
  (SELECT coalesce(json_agg(json_build_object('table',t.relname,'schema',n.nspname,'name',x.relname,'unique',i.indisunique,'valid',i.indisvalid,'definition',regexp_replace(pg_get_indexdef(i.indexrelid),'^CREATE (UNIQUE )?INDEX \\S+ ON (ONLY )?\\S+ ',''))),'[]')
    FROM pg_index i JOIN pg_class x ON x.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE CASE WHEN $1::text IS NULL THEN pg_table_is_visible(t.oid) ELSE n.nspname=$1::text END AND t.relname=ANY($2::text[]) AND i.indisready) AS indexes,
  (SELECT coalesce(json_agg(json_build_object('table',t.relname,'definition',pg_get_constraintdef(k.oid))),'[]')
    FROM pg_constraint k JOIN pg_class t ON t.oid=k.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE CASE WHEN $1::text IS NULL THEN pg_table_is_visible(t.oid) ELSE n.nspname=$1::text END AND t.relname=ANY($2::text[]) AND k.contype='c' AND k.convalidated) AS checks`;
/**
 * What the catalogue lacks of what this build needs, each with where it comes
 * from: the tables and columns the queries use and the integrity guards, and
 * any superseded guard still in place, by its own name and with the schema to
 * migrate; then the read indexes; at most 20 of each, then a count.
 */
function schemaGaps(catalogue: SchemaCatalogue): { required: string[]; indexes: string[] } {
  const present = new Map<string, Set<string>>(), required: string[] = [], indexes: string[] = [];
  for (const { table, column } of catalogue.columns) present.set(table, (present.get(table) ?? new Set<string>()).add(column));
  for (const table of requiredTables) {
    if (table.name === 'valopay_export_cleanup' && runtimeIsolationEnabled()) continue;
    const columns = present.get(table.name);
    if (!columns) { required.push(`table ${table.name}: ${schemaSource(table.name)}`); continue; }
    for (const column of table.columns) if (!columns.has(column)) required.push(`column ${table.name}.${column}: ${columnSource}`);
  }
  const valid = catalogue.indexes.filter((index) => index.valid);
  const defined = new Set(valid.map((index) => `${index.table} ${index.definition}`));
  const guarded = new Set([...valid.filter((index) => index.unique).map((index) => `${index.table} unique index ${index.definition}`), ...catalogue.checks.map((check) => `${check.table} check ${check.definition}`)]);
  // A missing table is named above; its guards and indexes are not listed again.
  for (const guard of integrityGuards) if (present.has(guard.table) && !guarded.has(`${guard.table} ${guard.type} ${guard.definition}`)) required.push(`${guard.type} ${guard.name}: ${guardSource(guard.name)}`);
  // One that is not valid is still enforced; the migration refuses it, so it is dropped by hand first.
  for (const guard of supersededGuards) for (const index of catalogue.indexes.filter((index) => index.unique && index.table === guard.table && index.definition === guard.definition).sort((a, b) => a.name.localeCompare(b.name)))
    required.push(`superseded unique index ${index.name}: ${guard.description}${index.valid ? ";" : ", left not valid but still enforced on writes; drop it by hand once reviewed, as the migration refuses it, then"} apply lib/db/migrations/${guard.migration} with ${index.schema} first on the search path`);
  for (const index of requiredIndexes) if (present.has(index.table) && !defined.has(`${index.table} ${index.definition}`)) indexes.push(`index ${index.name}: apply lib/db/migrations/${index.migration}`);
  const capped = (list: string[]) => list.length > 20 ? [...list.slice(0, 20), `and ${list.length - 20} more`] : list;
  return { required: capped(required), indexes: capped(indexes) };
}
/**
 * The readiness check's findings: whether the database answered, and whether
 * it holds everything this build needs. `incomplete` means a table or column
 * the queries use is missing, so requests would fail, or an integrity guard
 * is, so the database would accept what the application relies on it to
 * refuse, or a superseded guard remains, so it would refuse what the
 * application relies on it to accept; `indexes_missing` means only a read
 * index a migration adds is missing, so some reads are slower but every
 * request still works. `missing` names each, for the log.
 */
export interface DatabaseReadiness {
  status: "ok" | "failed"; latencyMs: number; error?: string;
  /** The schema checked, when one is named (the isolated runtime schema); absent when the connection's search path decides. */
  searched?: string;
  schema: { status: "ok" | "indexes_missing" | "incomplete" | "unchecked"; missing: string[] };
}
let readiness: InstanceType<typeof Pool> | undefined;
/**
 * Readiness: one bounded round trip to the database, on its own connection,
 * so a request pool that is busy does not read as a database that cannot be
 * reached. The round trip reads the catalogue, so a database that answers but
 * lacks a table or a column this build needs (a migration not yet applied), or
 * a unique index or check constraint it relies on (a push stopped part way),
 * or that still holds a guard this build replaced, is not ready either; a
 * missing read index is reported without failing, since every request still
 * works, only slower. A SELECT 1 could not tell. It checks
 * the application's schema: the isolated runtime schema when runtime isolation
 * is on, otherwise the connection's own (`schema` names another, for tests).
 * Never throws; a connection error stays in the caller's log, not in an
 * answer.
 */
export async function pingDatabase(options: { timeoutMs?: number; schema?: string } = {}): Promise<DatabaseReadiness> {
  const timeoutMs = options.timeoutMs ?? 2000, started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    if (!readiness) {
      readiness = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: timeoutMs, idleTimeoutMillis: 10_000, allowExitOnIdle: true });
      // An idle connection that fails is replaced; the next ping reports whether the database answers.
      readiness.on("error", () => {});
    }
    const schema = options.schema ?? runtimeIsolationConfiguration()?.schema ?? null;
    const catalogue = (await Promise.race([
      readiness.query<SchemaCatalogue>(schemaCatalogue, [schema, requiredTables.map((table) => table.name)]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs); }),
    ])).rows[0]!;
    const gaps = schemaGaps(catalogue);
    const status = gaps.required.length ? "incomplete" : gaps.indexes.length ? "indexes_missing" : "ok";
    return { status: "ok", latencyMs: Math.round(performance.now() - started), ...(schema ? { searched: schema } : {}), schema: { status, missing: [...gaps.required, ...gaps.indexes] } };
  } catch (error) {
    return { status: "failed", latencyMs: Math.round(performance.now() - started), error: error instanceof Error ? error.message : String(error), schema: { status: "unchecked", missing: [] } };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** An idle connection that fails emits an error on the pool; unheard, that event ends the process. Heard, it is a log line and the pool replaces the connection. */
export function watchDatabase(log: { error: (fields: object, message: string) => void }): void {
  pool.on("error", (error) => log.error({ event: "database.pool_error", err: error }, "Database connection error on an idle client"));
}

/** Ends the pools on shutdown, after the last transaction. */
export async function closeDatabase(): Promise<void> {
  const ending = readiness;
  readiness = undefined;
  await Promise.all([pool.end(), ending?.end()]);
}

/**
 * Appends a hash-chained audit entry for an action to the lender's state and
 * moves the chain's head in its settings. A lender loaded for a write
 * continues from where its load found the chain (loadState); a state built in
 * memory (a new lender's seed, a test) from its stored head or its own entries.
 */
export function appendAudit(state: DomainState, ctx: Context, action: string, objectId: string, summary: string, changes?: unknown): ValopayRecord {
  const session = sessions.get(ctx as StoreContext), loaded = session?.active && session.lockedMerchantId === state.merchant.id ? session.auditChain : undefined;
  let head = loaded ?? storedChain(state.settings);
  if (!head) {
    // One pass for the chain's length and head; it is not sorted here.
    let length = 0, previous: ValopayRecord | undefined;
    for (const record of state.records) {
      if (record.kind !== "audit") continue;
      length += 1;
      if (!previous || Number(record.data.sequence || 0) >= Number(previous.data.sequence || 0)) previous = record;
    }
    head = { sequence: length, hash: previous?.data.hash ?? AUDIT_GENESIS.hash, verified: AUDIT_GENESIS };
  }
  const data = auditEntryData({ sequence: head.sequence + 1, actor: ctx.actor, action, objectId, summary, changes, previousHash: head.hash, timestamp: ctx.now });
  const record: ValopayRecord = { id: randomUUID(), merchantId: state.merchant.id, kind: "audit", name: action, status: "recorded", reference: "", amountKobo: 0, customerId: state.records.find((item) => item.id === objectId)?.customerId || "", createdAt: ctx.now, updatedAt: ctx.now, data };
  state.records.push(record);
  const chain: AuditChain = { sequence: data.sequence, hash: data.hash, at: ctx.now, verified: head.verified, ...(head.broken ? { broken: head.broken } : {}), ...(head.walkedAt ? { walkedAt: head.walkedAt } : {}) };
  state.settings.auditChain = chain;
  if (loaded) session!.auditChain = chain;
  return record;
}
/** Walks the chain of the entries in a state that holds them all (an export's): valid when every entry's sequence, previous hash and digest agree; returns the count and the head hash. */
export function verifyAudit(state: DomainState) {
  return verifyAuditChain(recordsOf(state, "audit"));
}
