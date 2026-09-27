// Reload recovery identifies a caller's original operation without exposing its body. A missing row is not proof
// of failure: cancellation fences the original key under the same lock used to receive its delayed request.
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
if (process.env.VALOPAY_RUN_INTEGRATION !== '1') { console.log('Submission recovery requires a disposable local PostgreSQL database.'); process.exit(0); }
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL || '').hostname));
for (const setting of ['VALOPAY_STAFF_ACCESS', 'VALOPAY_RUNTIME_ISOLATION', 'VALOPAY_PAYLOAD_ENCRYPTION']) process.env[setting] = 'off';
const { pool } = await import('@workspace/db');
const { default: router } = await import('../src/routes/index');
const { errorHandler } = await import('../src/lib/error-handler');
const store = await import('../src/lib/valopay-store');
const { requestFingerprint } = await import('../src/lib/digests');
const app = express(), quiet = { info() {}, warn() {}, error() {} };
const anonymous = () => Object.assign(() => ({ userId: null }), { [Symbol.for('@clerk/express.auth')]: true });
app.use(express.json()); app.use((req, _res, next) => { (req as any).auth = anonymous(); (req as any).log = quiet; next(); });
app.use('/api', router); app.use(errorHandler);
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`, cookie = `valopay_sandbox=${randomBytes(32).toString('hex')}`;
const otherCookie = `valopay_sandbox=${randomBytes(32).toString('hex')}`;
const workspaceIds: string[] = [];
async function call(path: string, method = 'GET', body?: unknown, key?: string, as = cookie) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: as, ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() as any };
}
function ok(answer: { status: number; data: any }) { assert.equal(answer.status, 200, JSON.stringify(answer.data)); return answer.data; }
const request = () => ({ headers: { cookie }, query: {}, secure: false, log: quiet, auth: anonymous() }) as any;
const response = { cookie() {} } as any;
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
let checks = 0;
try {
  const workspace = ok(await call('/v1/workspace')), lender = workspace.merchants[0].id as string, otherLender = workspace.merchants[1].id as string;
  const another = ok(await call('/v1/workspace', 'GET', undefined, undefined, otherCookie));
  for (const id of [lender, another.merchants[0].id]) workspaceIds.push((await pool.query('SELECT workspace_id FROM valopay_merchants WHERE id=$1', [id])).rows[0].workspace_id);
  const q = (path: string, id = lender) => `${path}?merchantId=${id}`;
  const identity = (key = randomUUID()) => ({ key, method: 'POST' as const, path: '/v1/records/customers' });
  const customer = (name: string) => ({ name, reference: `RECOVER-${randomUUID()}`, data: { consentProvenance: 'Private synthetic evidence for this request only' } });
  const lookup = async (input: ReturnType<typeof identity>, id = lender) => ok(await call(q('/v1/operations/lookup', id), 'POST', input)).operation;

  // One exact completed request, even after it leaves the first page of Operations; no body or private text.
  const savedIdentity = identity(), savedBody = customer('Private synthetic name');
  const saved = ok(await call(q(savedIdentity.path), 'POST', savedBody, savedIdentity.key));
  const found = await lookup(savedIdentity);
  assert.equal(found.status, 'completed'); assert.equal(found.recordId, saved.id);
  assert.equal(JSON.stringify(found).includes('Private synthetic'), false);
  assert.equal('request' in found, false); assert.equal('request_key' in found, false);
  assert.equal(await lookup(savedIdentity, otherLender), null);
  assert.equal((await call(q('/v1/operations/lookup'), 'POST', savedIdentity, undefined, otherCookie)).status, 404);
  const memberFields = (await pool.query('SELECT actor,role FROM valopay_operations WHERE id=$1', [found.id])).rows[0];
  await pool.query("UPDATE valopay_operations SET actor='another-person' WHERE id=$1", [found.id]);
  assert.equal(await lookup(savedIdentity), null, 'same owner but different actor receives no saved summary');
  await pool.query('UPDATE valopay_operations SET actor=$2,role=$3 WHERE id=$1', [found.id, memberFields.actor, 'Finance']);
  assert.equal(await lookup(savedIdentity), null, 'same owner but different role receives no saved summary');
  await pool.query('UPDATE valopay_operations SET role=$2 WHERE id=$1', [found.id, memberFields.role]);
  assert.equal((await call(q('/v1/operations/cancel-unreceived'), 'POST', savedIdentity)).status, 409, 'completed requests cannot be cancelled');
  assert.equal((await lookup(savedIdentity)).status, 'completed');
  checks += 11;

  // A cancellation fence wins before a delayed original arrives. It never permits an execution with the same key.
  const missing = identity(), delayed = customer('Delayed after cancellation');
  assert.equal(await lookup(missing), null);
  ok(await call(q('/v1/operations/cancel-unreceived'), 'POST', missing));
  assert.equal((await lookup(missing)).status, 'cancelled');
  const late = await call(q(missing.path), 'POST', delayed, missing.key);
  assert.deepEqual([late.status, late.data.operation], [409, 'cancelled']);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM valopay_records WHERE merchant_id=$1 AND reference=$2', [lender, delayed.reference])).rows[0].n), 0);
  ok(await call(q('/v1/operations/cancel-unreceived'), 'POST', missing));
  checks += 5;

  // An earlier stored receipt is conclusive even when its journal entry is still pending.
  const old = identity(), oldRequest = { method: old.method, path: old.path, body: customer('Earlier receipt') };
  const prepared = await store.inWorkspace(request(), response, ctx => store.prepareOperation(ctx, lender, old.key, oldRequest));
  await pool.query("INSERT INTO valopay_idempotency(id,merchant_id,request_hash,response) VALUES($1,$2,$3,$4)", [prepared.id, lender, requestFingerprint(oldRequest), { id: saved.id, kind: 'customers' }]);
  assert.equal((await call(q('/v1/operations/cancel-unreceived'), 'POST', old)).status, 409);
  assert.equal((await lookup(old)).status, 'pending');
  checks += 2;

  // A fence held open competes with prepareOperation's creation lock. The late original waits, then is refused.
  const racing = identity(), entered = gate(), release = gate();
  const fencing = store.inWorkspace(request(), response, async ctx => {
    await store.cancelOwnOperation(ctx, lender, racing); entered.resolve(); await release.promise;
  });
  let settled = false;
  let raced: Promise<{ status: number; data: any }> | undefined;
  try {
    await entered.promise;
    raced = call(q(racing.path), 'POST', customer('Race loser'), racing.key).then(answer => { settled = true; return answer; });
    // The API has to be waiting on the journal-creation advisory lock, not merely unscheduled.
    const deadline = Date.now() + 2000;
    let waiting = false;
    while (Date.now() < deadline) {
      waiting = (await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%valopay.operations:%'")).rowCount! > 0;
      if (waiting) break;
      await new Promise(done => setTimeout(done, 10));
    }
    assert.equal(waiting, true); assert.equal(settled, false);
  } finally { release.resolve(); await fencing; }
  const answer = await raced!;
  assert.deepEqual([answer.status, answer.data.operation], [409, 'cancelled']);
  assert.equal((await lookup(racing)).status, 'cancelled'); checks += 4;
  // Invalid input is rejected before any journal entry can be constructed.
  assert.equal((await call(q('/v1/operations/lookup'), 'POST', { ...identity(), key: 'not-a-key' })).status, 400);
  assert.equal((await call(q('/v1/operations/cancel-unreceived'), 'POST', { ...identity(), path: 'https://external.example/write' })).status, 400);
  checks += 2;
  console.log(`Submission recovery PostgreSQL integration passed (${checks} checks): owner/actor/role/lender privacy, private-payload exclusion, original status lookup, completed-receipt protection, cancellation before arrival, and concurrent late-request fencing.`);
} finally {
  server.close(); await once(server, 'close');
  for (const id of workspaceIds) {
    for (const table of ['valopay_idempotency', 'valopay_operations', 'valopay_records']) await pool.query(`DELETE FROM ${table} WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)`, [id]);
    await pool.query('DELETE FROM valopay_merchants WHERE workspace_id=$1', [id]); await pool.query('DELETE FROM valopay_workspaces WHERE id=$1', [id]);
  }
  await pool.end();
}
