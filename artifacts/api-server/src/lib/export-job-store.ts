import { pool, type PoolClient } from '@workspace/valo-pay-1-db';
import { randomUUID } from 'node:crypto';
import type { Context, DomainState, ValopayRecord } from '../domain/types';
import { SYSTEM_ACTOR_PREFIX, chainSequenceSql } from './valo-pay-1-store';
import { auditEntryData, chainSequence } from './digests';
import { EXPORT_LEASE_MS, EXPORT_CONFIRM_LEASE_MS, exportIsClaimable, returnExportToQueue, type ClaimedExport, type ExportArtifact, type ExportJobRepository, type ExportWriteResult, type ExportQueueCursor } from './export-jobs';
import { bindRuntimeService, runtimeExportRequesterAllowed } from './runtime-isolation';
import { beginStatement, checkOut, databaseLimits } from './database-limits';

type Scope = { id: string; workspace_id: string; principal_hash: string; info: DomainState['merchant']; settings: DomainState['settings']; now: Date };
type Row = { id: string; merchant_id: string; kind: string; name: string; status: string; reference: string; amount_kobo: number | string; customer_id: string; data: Record<string, any>; created_at: Date; updated_at: Date };
const recordOf = (row: Row): ValopayRecord => ({ id: row.id, merchantId: row.merchant_id, kind: row.kind, name: row.name, status: row.status, reference: row.reference, amountKobo: Number(row.amount_kobo), customerId: row.customer_id, data: row.data, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });
const ownership = 'EXISTS (SELECT 1 FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id WHERE m.id=$1 AND m.workspace_id=$2 AND w.principal_hash=$3)';
const actor = `${SYSTEM_ACTOR_PREFIX}export worker`;

/**
 * This process's worker transactions on one lender take turns: the worker's
 * two slots never meet at the lender's lock, so one slot's claim no longer
 * skips the other's job, and neither holds a connection waiting for the other.
 * Requests and other processes still meet the lock.
 */
const turns = new Map<string, Promise<void>>();
async function inTurn<T>(merchantId: string, work: () => Promise<T>): Promise<T> {
  const current = (turns.get(merchantId) ?? Promise.resolve()).then(work);
  const done = current.then(() => undefined, () => undefined);
  turns.set(merchantId, done);
  try { return await current; }
  finally { if (turns.get(merchantId) === done) turns.delete(merchantId); }
}

/** This capability is system-only: every transaction derives the workspace and principal from its locked merchant.
 * The pool's checkout wait bounds the checkout, so a late connection never starts a background transaction, and
 * the worker limits bound what runs.
 *
 * A claim that finds the lender busy skips it, since the job stays queued for a later look. A write to a claimed job
 * (progress, completion, the hand-back of a job whose lender stayed busy) waits for the lender up to the worker's
 * lock limit instead, since giving up would leave the job running under its lease. A wait that reaches the limit is
 * 'busy', and retryExportWrite tries the write again. A stopping worker's hand-back skips a busy lender as a claim
 * does: the process's shutdown deadline cannot wait for it, and the lease recovers the job.
 *
 * Every one reads at READ COMMITTED, so each read after the lender's lock sees what every earlier holder committed,
 * and the audit head it appends after is the chain's latest. No snapshot may be older than the lock: one taken
 * before it (REPEATABLE READ takes it at the first statement, which under runtime isolation is the self-check's,
 * well before the lock) misses an entry another process's worker committed meanwhile without changing the lender's
 * row, and the entry appended after the stale head forks the chain. The claim reads the lender's records in one
 * statement, after the lock, so the export still sees one consistent state of the lender. */
async function transaction<T>(merchantId: string, lock: 'skip' | 'wait', work: (client: PoolClient, scope: Scope) => Promise<T>): Promise<T | null> {
  return inTurn(merchantId, async () => {
    const guard = await checkOut(() => pool.connect()), client = guard.client;
    try {
      await client.query(beginStatement(databaseLimits().worker));
      await bindRuntimeService(client);
      let scope: Scope | undefined;
      try {
        scope = (await client.query<Scope>(`SELECT m.id,m.workspace_id,w.principal_hash,m.info,m.settings,now() AS now
          FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id WHERE m.id=$1 FOR UPDATE OF m${lock === 'skip' ? ' SKIP LOCKED' : ''}`, [merchantId])).rows[0];
      } catch (error) { if ((error as { code?: unknown }).code !== '55P03') throw error; }
      if (!scope) { await client.query('ROLLBACK'); return null; }
      const result = await work(client, scope);
      const committed = await client.query('COMMIT');
      if (committed.command !== 'COMMIT') throw new Error('Export job transaction did not commit.');
      return result;
    } catch (error) { try { await client.query('ROLLBACK'); } catch { /* disconnected */ } throw error; }
    finally { guard.release(); }
  });
}

const headRead = (since: boolean) => `SELECT r.* FROM valopay_records r WHERE r.merchant_id=$1 AND r.kind='audit'${since ? " AND r.created_at >= $4::timestamptz - interval '1 hour'" : ''} AND ${ownership}
  ORDER BY ${chainSequenceSql} DESC NULLS LAST LIMIT 1`;
/** Of these entries, the one with the highest whole-number sequence, as a place in the chain. */
function highest(entries: ReadonlyArray<{ data: Record<string, any> }>): { sequence: number; hash: string } | undefined {
  let head: { sequence: number; hash: string } | undefined;
  for (const entry of entries) {
    const sequence = chainSequence(entry.data.sequence);
    if (sequence !== undefined && (!head || sequence > head.sequence)) head = { sequence, hash: String(entry.data.hash) };
  }
  return head;
}
/**
 * The head of the lender's audit chain, which the next entry follows: the
 * entry with the highest whole-number sequence, read after the lender's lock
 * (transaction). An entry whose sequence is anything else (text, null, a
 * fraction), which only damage leaves, is never the head and is never cast,
 * so it cannot stop the worker recording what it did. A claim finds the head
 * among the records it loads for the export anyway. A later write to the
 * claimed job reads it from the entries since an hour before the claim
 * (`since`, the job's startedAt), a range the lender-kind index serves: the
 * claim wrote an entry then, and every entry after it comes from a
 * transaction that took the lender after the claim, stamped with its own
 * start, at most a few lock waits earlier. So the read follows the lender's
 * recent work, not its whole history. Without a start to go by, or with no
 * whole-number entry in that hour, it reads the whole chain.
 *
 * The lender's settings keep the head its requests last appended (auditChain,
 * lib/valo-pay-1-store.ts), which this worker's own entries do not move. When
 * that head is further on than any entry, an entry has gone missing: the next
 * entry follows the stored head, as a request's does, so the missing sequence
 * is never issued again. The gap then stays in the chain: the overview
 * reports it whenever its check reaches it, and once a completed write,
 * verify_audit or the daily check has recorded the break, the lender keeps it
 * until a walk of the whole chain (verify_audit or the daily check) finds the
 * chain valid again.
 */
async function auditHead(client: PoolClient, scope: Scope, from: { records: ValopayRecord[] } | { since: unknown }): Promise<{ sequence: number; hash: string } | undefined> {
  let head: { sequence: number; hash: string } | undefined;
  if ('records' in from) head = highest(from.records.filter(record => record.kind === 'audit'));
  else {
    const scoped = [scope.id, scope.workspace_id, scope.principal_hash];
    const since = typeof from.since === 'string' && Number.isFinite(Date.parse(from.since)) ? from.since : undefined;
    // Damaged entries come last: the row read is a damaged one only when the range holds nothing else.
    if (since) head = highest((await client.query<Row>(headRead(true), [...scoped, since])).rows);
    head ??= highest((await client.query<Row>(headRead(false), scoped)).rows);
  }
  const stored = (scope.settings as { auditChain?: { sequence?: unknown; hash?: unknown } } | null)?.auditChain;
  if (stored && Number.isSafeInteger(stored.sequence) && typeof stored.hash === 'string' && stored.hash && (stored.sequence as number) > (head?.sequence ?? 0)) return { sequence: stored.sequence as number, hash: stored.hash };
  return head;
}
/** Appends the job's entry after `previous`, the chain's head; returns it as stored. */
async function audit(client: PoolClient, scope: Scope, job: ValopayRecord, action: string, summary: string, previous: { sequence: number; hash: string } | undefined): Promise<ValopayRecord | undefined> {
  const sequence=previous?previous.sequence+1:1;
  if(!Number.isSafeInteger(sequence)||sequence<1)throw new Error('Invalid audit sequence.');
  const now=scope.now.toISOString();
  const data=auditEntryData({sequence,actor,action,objectId:job.id,summary,changes:{status:job.status,attempt:job.data.attempts,checksum:job.data.checksum},previousHash:previous?.hash,timestamp:now});
  const entry:ValopayRecord={id:randomUUID(),merchantId:scope.id,kind:'audit',name:action,status:'recorded',reference:'',amountKobo:0,customerId:job.customerId,createdAt:now,updatedAt:now,data};
  const inserted=(await client.query<Row>(`INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data,created_at,updated_at)
    SELECT $4,$1,'audit',$5,$6,$7,$8,$9,$10,$11,$12 WHERE ${ownership} RETURNING *`,
  [scope.id, scope.workspace_id, scope.principal_hash, entry.id, entry.name, entry.status, entry.reference, entry.amountKobo, entry.customerId, entry.data, entry.createdAt, entry.updatedAt])).rows[0];
  return inserted && recordOf(inserted);
}
/** Saves the job; returns it as stored. */
async function writeJob(client: PoolClient, scope: Scope, job: ValopayRecord): Promise<ValopayRecord> {
  const result = await client.query<Row>(`UPDATE valopay_records r SET status=$5,data=$6,updated_at=GREATEST($7::timestamptz,r.updated_at+interval '1 millisecond')
    WHERE r.id=$4 AND r.merchant_id=$1 AND r.kind='exports' AND ${ownership} RETURNING r.*`,
  [scope.id, scope.workspace_id, scope.principal_hash, job.id, job.status, job.data, scope.now.toISOString()]);
  if (result.rowCount !== 1) throw new Error('Export job no longer belongs to this lender.');
  return recordOf(result.rows[0]!);
}
async function complete(claim: ClaimedExport, artifact?: ExportArtifact, message?: string): Promise<ExportWriteResult> {
  const intendedReady = !!artifact;
  return await transaction(claim.merchantId, 'wait', async (client, scope) => {
    const row = (await client.query<Row>(`SELECT r.* FROM valopay_records r WHERE r.id=$4 AND r.merchant_id=$1 AND r.kind='exports' AND ${ownership}`,
      [scope.id, scope.workspace_id, scope.principal_hash, claim.id])).rows[0];
    if (!row || row.status !== 'running' || row.data.leaseToken !== claim.token) return 'lost';
    const job = recordOf(row), head = await auditHead(client, scope, { since: row.data.startedAt });
    if (artifact && !await runtimeExportRequesterAllowed(client, scope.workspace_id, scope.id, job.data.requestedBy, job.data.requestedRole)) {
      artifact = undefined; message = 'The person who asked for this export lost access to it while it was being prepared. Ask someone with access to create it again.';
    }
    job.status = artifact ? 'ready' : 'failed';
    job.data.stage = job.status; job.data.lastProgressAt = scope.now.toISOString();
    if (artifact) Object.assign(job.data, artifact);
    else job.data.lastError = message;
    delete job.data.leaseToken; delete job.data.leaseExpiresAt;
    if (artifact) delete job.data.lastError;
    await writeJob(client, scope, job);
    await audit(client, scope, job, artifact ? 'export.ready' : 'export.failed', artifact ? 'Export ready to download.' : 'Export could not be prepared. It can be retried on Saved exports.', head);
    return intendedReady && !artifact ? 'lost' : 'saved';
  }) ?? 'busy';
}

async function queuePage(limit: number, after?: ExportQueueCursor, through?: ExportQueueCursor, newest = false) {
    // Bound checkout and the read itself so a queue scan cannot occupy both
    // worker slots forever. Claims still recheck ownership under the lender lock.
    // The kind and status conditions are the predicate of migration 008's partial
    // index of unfinished exports, kept in created_at and id order, so the look
    // reads only queued and running jobs, in order, and stops at the limit.
    const guard = await checkOut(() => pool.connect()), client = guard.client;
    try {
      await client.query(beginStatement(databaseLimits().worker, 'READ ONLY'));
      await bindRuntimeService(client);
      const targets = (await client.query<{ merchantId: string; id: string; createdAt: string }>(`SELECT merchant_id AS "merchantId",id,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt" FROM valopay_records
      WHERE kind='exports' AND status IN ('queued','running')
        AND (status='queued' OR COALESCE(data->>'leaseExpiresAt','') <= to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        ${after ? 'AND (created_at,id) > ($2::timestamptz,$3::text)' : ''}
        ${through ? `AND (created_at,id) <= ($${after ? 4 : 2}::timestamptz,$${after ? 5 : 3}::text)` : ''}
      ORDER BY created_at${newest ? ' DESC' : ''},id${newest ? ' DESC' : ''} LIMIT $1`, [Math.max(1, Math.min(20, limit)), ...(after ? [after.createdAt, after.id] : []), ...(through ? [through.createdAt, through.id] : [])])).rows;
      await client.query('COMMIT');
      return targets;
    } catch (error) { try { await client.query('ROLLBACK'); } catch { /* disconnected */ } throw error; }
    finally { guard.release(); }
}
export const exportJobRepository: ExportJobRepository = {
  queueEnd: async () => (await queuePage(1, undefined, undefined, true))[0],
  candidates: (limit, after, through) => queuePage(limit, after, through),
  async claim(merchantId, id) {
    return transaction(merchantId, 'skip', async (client, scope) => {
      const row = (await client.query<Row>(`SELECT r.* FROM valopay_records r WHERE r.id=$4 AND r.merchant_id=$1 AND r.kind='exports' AND ${ownership}`,
        [scope.id, scope.workspace_id, scope.principal_hash, id])).rows[0];
      if (!row) return null;
      const job = recordOf(row), now = scope.now.toISOString();
      if (!exportIsClaimable(job, now)) return null;
      // The export reads the lender's records, loaded once here; the audit chain's head is found among them.
      const records = (await client.query<Row>(`SELECT r.* FROM valopay_records r WHERE r.merchant_id=$1 AND ${ownership}`, [scope.id, scope.workspace_id, scope.principal_hash])).rows.map(recordOf);
      const head = await auditHead(client, scope, { records });
      if (!await runtimeExportRequesterAllowed(client, scope.workspace_id, scope.id, job.data.requestedBy, job.data.requestedRole)) {
        job.status = 'failed'; job.data.lastError = 'The person who asked for this export no longer has access to it. Ask someone with access to create it again.';
        job.data.stage = 'failed'; job.data.lastProgressAt = now;
        delete job.data.leaseToken; delete job.data.leaseExpiresAt;
        await writeJob(client, scope, job); await audit(client, scope, job, 'export.access_changed', 'Export stopped: the person who asked for it no longer has access.', head);
        return null;
      }
      const token = randomUUID();
      job.status = 'running'; Object.assign(job.data, { leaseToken: token, leaseExpiresAt: new Date(scope.now.getTime() + EXPORT_LEASE_MS).toISOString(), startedAt: now, stage: 'checking', lastProgressAt: now, attempts: Number(job.data.attempts || 0) + 1 });
      delete job.data.lastError;
      const claimed = await writeJob(client, scope, job);
      const started = await audit(client, scope, job, 'export.started', 'Started preparing a saved export.', head);
      // The export sees the lender as this transaction leaves it: the job running, its entry appended.
      const state = records.map(record => record.id === claimed.id ? claimed : record);
      if (started) state.push(started);
      const context: Context = { actor: String(job.data.requestedBy || actor), role: String(job.data.requestedRole || 'Read-only'), now };
      return { merchantId, id, token, state: { merchant: scope.info, settings: scope.settings, records: state }, context,
        input: { kind: String(job.data.kind), customerId: job.customerId || undefined, closeReviewId:job.data.closeReviewId, format: String(job.data.format) as 'pdf' | 'json' | 'csv' },
        location: { bucket: String(job.data.bucket), objectName: String(job.data.objectName) } };
    });
  },
  async progress(claim, stage) {
    if (!['rendering','uploading','confirming'].includes(stage)) throw new Error('Invalid worker progress stage.');
    return await transaction(claim.merchantId, 'wait', async (client, scope) => {
      const row = (await client.query<Row>(`SELECT r.* FROM valopay_records r WHERE r.id=$4 AND r.merchant_id=$1 AND r.kind='exports' AND ${ownership}`, [scope.id, scope.workspace_id, scope.principal_hash, claim.id])).rows[0];
      if (!row || row.status !== 'running' || row.data.leaseToken !== claim.token) return 'lost';
      const job = recordOf(row);
      job.data.stage = stage; job.data.lastProgressAt = scope.now.toISOString();
      // The file is already durable at this stage. A crashed confirmation can
      // be adopted shortly, with the same object/key, without waiting five minutes.
      if (stage === 'confirming') job.data.leaseExpiresAt = new Date(scope.now.getTime() + EXPORT_CONFIRM_LEASE_MS).toISOString();
      await writeJob(client, scope, job);
      return 'saved';
    }) ?? 'busy';
  },
  async release(claim, reason = 'stopping') {
    return await transaction(claim.merchantId, reason === 'stopping' ? 'skip' : 'wait', async (client, scope) => {
      const row = (await client.query<Row>(`SELECT r.* FROM valopay_records r WHERE r.id=$4 AND r.merchant_id=$1 AND r.kind='exports' AND ${ownership}`, [scope.id, scope.workspace_id, scope.principal_hash, claim.id])).rows[0];
      if (!row || row.status !== 'running' || row.data.leaseToken !== claim.token) return 'lost';
      // Attempts keep counting claims, and the private object key stays, so a file the stopped upload committed is adopted.
      const job = recordOf(row), head = await auditHead(client, scope, { since: row.data.startedAt });
      returnExportToQueue(job, scope.now.toISOString());
      await writeJob(client, scope, job);
      await audit(client, scope, job, 'export.released', reason === 'busy'
        ? 'The lender was busy, so this export goes back to the queue. It will be tried again shortly.'
        : 'Export preparation stopped before it finished. The export goes back to the queue and will be tried again.', head);
      return 'saved';
    }) ?? 'busy';
  },
  finish: (claim, artifact) => complete(claim, artifact),
  fail: (claim, message) => complete(claim, undefined, message),
};
