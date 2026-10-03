import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireCreateDatabase, requireLoopback, throwawayDatabaseName } from './throwaway-database';

if (process.env.VALO_PAY_1_RUN_INTEGRATION !== '1') {
  console.log('Record index migration tests require a disposable local PostgreSQL instance.'); process.exit(0);
}
// Any loopback database whose login can create databases: the rehearsal builds its own throwaway one beside it.
const suite = 'Record index migration rehearsal';
const connection = new URL(process.env.DATABASE_URL || '');
requireLoopback(suite, connection);
const { pool, Pool } = await import('@workspace/valo-pay-1-db');
await requireCreateDatabase(suite, pool);
const database = throwawayDatabaseName(connection, 'index_rehearsal');
const targetUrl = new URL(connection); targetUrl.pathname = `/${database}`;
const script = fileURLToPath(new URL('../../../scripts/apply-record-list-indexes.mjs', import.meta.url));
const names = ['valopay_records_lender_kind_page', 'valopay_records_lender_kind_status_page', 'valopay_records_lender_customer', 'valopay_records_lender_kind_updated'];
const run = (args: string[] = []) => spawnSync(process.execPath, [script, ...args], { env: { ...process.env, DATABASE_URL: targetUrl.toString() }, encoding: 'utf8', timeout: 60_000 });
let target: InstanceType<typeof Pool> | undefined, created = false;
try {
  await pool.query(`CREATE DATABASE "${database}"`); created = true;
  target = new Pool({ connectionString: targetUrl.toString() });
  await target.query(`CREATE TABLE public.valopay_records (id text PRIMARY KEY,merchant_id text NOT NULL,kind text NOT NULL,status text NOT NULL,customer_id text NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL)`);
  await target.query(`INSERT INTO public.valopay_records SELECT 'synthetic-'||i,'lender-'||(i%2),'customers','active','',now(),now() FROM generate_series(1,1000) i`);
  const indexes = async () => (await target!.query('SELECT c.relname,c.oid,i.indisvalid,i.indisready FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid WHERE c.relname=ANY($1::text[]) ORDER BY c.relname', [names])).rows;
  const initialRows = (await target.query('SELECT * FROM public.valopay_records ORDER BY id')).rows;
  const inspect = run(); assert.equal(inspect.status, 0, inspect.stderr); assert.match(inspect.stdout, /"mode": "inspect"/);
  assert.equal((await indexes()).length, 0, 'default invocation is read-only');
  assert.notEqual(run(['--apply']).status, 0, 'application requires verified database name');
  assert.notEqual(run(['--apply', '--database', 'wrong-database']).status, 0);
  assert.equal((await indexes()).length, 0, 'wrong database check happens before DDL');
  const apply = run(['--apply', '--database', database]); assert.equal(apply.status, 0, apply.stderr);
  assert.match(apply.stdout, /"mode": "verified"/);
  const first = await indexes(); assert.equal(first.length, 4); assert.ok(first.every(row => row.indisvalid && row.indisready));
  const again = run(['--apply', '--database', database]); assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(await indexes(), first, 'reapplying verifies and retains exact existing indexes');
  // A same-name but wrong definition must block every change before building
  // another missing index; IF NOT EXISTS alone would silently accept it.
  await target.query('DROP INDEX public.valopay_records_lender_kind_page');
  await target.query('DROP INDEX public.valopay_records_lender_customer');
  await target.query('CREATE INDEX valopay_records_lender_kind_page ON public.valopay_records(status)');
  const conflict = run(['--apply', '--database', database]); assert.notEqual(conflict.status, 0); assert.match(conflict.stdout, /"state": "conflict"/);
  assert.equal((await indexes()).length, 3, 'conflict prevents creation of other missing indexes');
  await target.query('DROP INDEX public.valopay_records_lender_kind_page');
  await target.query('CREATE INDEX equivalent_existing_page ON public.valopay_records(merchant_id,kind,created_at,id)');
  const duplicate = run(['--apply', '--database', database]); assert.notEqual(duplicate.status, 0); assert.match(duplicate.stdout, /Equivalent index equivalent_existing_page already exists/);
  assert.equal((await indexes()).length, 2, 'equivalent renamed index requires review rather than duplicate creation');
  assert.deepEqual((await target.query('SELECT * FROM public.valopay_records ORDER BY id')).rows, initialRows, 'index operation never changes row data');
  console.log('Read-index migration rehearsal passed: inspect-only default, database guard, four concurrent builds, exact reapply, conflicting-name refusal, equivalent-index refusal and unchanged rows.');
} finally {
  await target?.end();
  if (created) await pool.query(`DROP DATABASE "${database}"`);
  await pool.end();
}
