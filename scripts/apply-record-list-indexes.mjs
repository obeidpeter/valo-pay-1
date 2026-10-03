// Narrow, manually invoked deployment operation. Defaults to read-only inspection.
// No schema push, row writes, index drops, security activation, or credential output.
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const requireDb = createRequire(new URL('../lib/db/package.json', import.meta.url));
const { Client } = requireDb('pg');
export const expectedIndexes = [
  { name: 'valopay_records_lender_kind_page', columns: ['merchant_id', 'kind', 'created_at', 'id'] },
  { name: 'valopay_records_lender_kind_status_page', columns: ['merchant_id', 'kind', 'status', 'created_at', 'id'] },
  { name: 'valopay_records_lender_customer', columns: ['merchant_id', 'customer_id', 'created_at', 'id'] },
  { name: 'valopay_records_lender_kind_updated', columns: ['merchant_id', 'kind', 'updated_at'] },
];
const migrationUrl = new URL('../lib/db/migrations/002_record_list_indexes.sql', import.meta.url);
const lockName = 'valopay-record-list-indexes-v1';

export async function migrationStatements() {
  const sql = (await readFile(migrationUrl, 'utf8')).replace(/^\s*--.*$/gm, '');
  const statements = sql.split(';').map(statement => statement.trim()).filter(Boolean);
  const approved = expectedIndexes.map(index => `CREATE INDEX CONCURRENTLY ${index.name} ON public.valopay_records USING btree (${index.columns.join(', ')})`);
  if (JSON.stringify(statements) !== JSON.stringify(approved)) throw new Error('The SQL migration no longer matches the four reviewed read indexes. Review both files before running.');
  return statements;
}

/** All index choices come from the fixed manifest. Existing definitions are
 * inspected before any DDL; matching names alone are never enough. */
export async function inspectRecordListIndexes(client, expectedDatabase) {
  const identity = (await client.query('SELECT current_database() AS database, current_setting(\'server_version_num\')::int AS version')).rows[0];
  if (expectedDatabase && identity.database !== expectedDatabase) throw new Error('The connected database does not match --database. No index changes were attempted.');
  if (identity.version < 160000) throw new Error('This migration is reviewed for PostgreSQL 16 or later. No index changes were attempted.');
  const target = (await client.query("SELECT c.oid,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='valopay_records'")).rows[0];
  if (!target || target.relkind !== 'r') throw new Error('Expected an ordinary public.valopay_records table. Partitioned, missing, and replacement objects require review.');
  const existing = (await client.query(`SELECT c.relname AS name,c.relkind,i.indrelid,
      am.amname AS method,i.indisvalid AS valid,i.indisready AS ready,i.indislive AS live,
      i.indisunique AS unique,i.indisprimary AS primary,i.indnkeyatts AS keys,i.indnatts AS attributes,
      pg_get_expr(i.indpred,i.indrelid) AS predicate,pg_get_expr(i.indexprs,i.indrelid) AS expressions,
      CASE WHEN i.indexrelid IS NOT NULL THEN ARRAY(SELECT pg_get_indexdef(i.indexrelid,k,true) FROM generate_series(1,i.indnkeyatts) k) END AS columns,
      pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_index i ON i.indexrelid=c.oid LEFT JOIN pg_am am ON am.oid=c.relam
    WHERE n.nspname='public' AND (i.indrelid=$1::oid OR c.relname=ANY($2::text[])) ORDER BY c.relname`,
    [target.oid, expectedIndexes.map(index => index.name)])).rows;
  const matches = (row, index) => row.relkind === 'i' && String(row.indrelid) === String(target.oid) && row.method === 'btree'
    && row.valid && row.ready && row.live && !row.unique && !row.primary && !row.predicate && !row.expressions
    && row.keys === index.columns.length && row.attributes === index.columns.length && JSON.stringify(row.columns) === JSON.stringify(index.columns);
  const plan = expectedIndexes.map(index => {
    const named = existing.find(row => row.name === index.name);
    if (named) return { ...index, state: matches(named, index) ? 'present' : 'conflict', definition: named.definition, reason: matches(named, index) ? undefined : 'The existing name has a different definition, targets another object, or is not valid/ready/live.' };
    const equivalent = existing.find(row => matches(row, index));
    if (equivalent) return { ...index, state: 'conflict', definition: equivalent.definition, reason: `Equivalent index ${equivalent.name} already exists. Review its name before creating a duplicate.` };
    return { ...index, state: 'missing' };
  });
  return { database: identity.database, table: 'public.valopay_records', existing: existing.map(row => ({ name: row.name, valid: row.valid, ready: row.ready, definition: row.definition })), plan };
}

export async function runIndexMigration({ connectionString, apply = false, expectedDatabase, log = value => console.log(JSON.stringify(value, null, 2)) }) {
  if (!connectionString) throw new Error('DATABASE_URL must be supplied by the deployment environment; do not paste it into logs or the command line.');
  if (apply && !expectedDatabase) throw new Error('Applying indexes requires --database with the database name verified during inspection.');
  const identity = await tsImport('../artifacts/api-server/src/lib/product-identity.ts', import.meta.url);
  const environment = { ...process.env, DATABASE_URL: connectionString };
  identity.assertOperatorConfiguration(environment);
  identity.assertPublicOperatorSchema(environment);
  const binding = identity.readResourceBindings(environment);
  const statements = await migrationStatements();
  const client = new Client({ connectionString, application_name: 'valo-pay-1-record-list-indexes' });
  let locked = false;
  await client.connect();
  try {
    await client.query("SET lock_timeout='5s'");
    await client.query("SET statement_timeout='15min'");
    if (binding) {
      const observed = (await client.query('SELECT current_database() AS database,current_user AS "user",current_schema() AS schema,to_regnamespace($1) IS NOT NULL AS bound_schema_exists', [binding.database.schema])).rows[0];
      identity.assertObservedDatabaseIdentity(binding, observed);
    }
    if (apply) {
      // Session lock spans each concurrent build's own transactions. It affects
      // only another invocation of this migration, never application row locks.
      locked = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [lockName])).rows[0].locked;
      if (!locked) throw new Error('Another record-list index migration holds the deployment lock.');
    }
    const before = await inspectRecordListIndexes(client, expectedDatabase);
    log({ mode: apply ? 'apply' : 'inspect', ...before });
    if (before.plan.some(index => index.state === 'conflict')) throw new Error('Index conflicts need review. No CREATE INDEX statements were run.');
    if (!apply) return before;
    for (const [position, index] of before.plan.entries()) {
      if (index.state !== 'missing') continue;
      // No IF NOT EXISTS. Unexpected concurrent DDL must fail visibly instead
      // of silently accepting a different index with this name.
      log({ building: index.name, concurrently: true });
      await client.query(statements[position]);
    }
    const after = await inspectRecordListIndexes(client, expectedDatabase);
    if (after.plan.some(index => index.state !== 'present')) throw new Error('Index verification did not complete. Inspect the database before retrying.');
    log({ mode: 'verified', database: after.database, indexes: after.plan.map(index => index.name), rowDataChanged: false });
    return after;
  } catch (error) {
    if (apply) log({ stopped: true, reason: error.message, databaseErrorCode: error.code ?? null, recovery: 'Existing completed indexes are retained. A failed concurrent build may leave an invalid index: inspect before any reviewed retry or cleanup. Nothing is dropped automatically.' });
    throw error;
  } finally {
    if (locked) { try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lockName]); } catch { /* closing the session also releases the lock */ } }
    await client.end();
  }
}

// Real paths: started through a symlinked path, argv names the link while this module's URL names the file, and the
// command would exit 0 without inspecting anything.
const startedDirectly = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (startedDirectly()) {
  try {
    const args = process.argv.slice(2);
    let apply = false, expectedDatabase;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--apply') apply = true;
      else if (args[i] === '--database' && args[i + 1]) expectedDatabase = args[++i];
      else throw new Error('Usage: node scripts/apply-record-list-indexes.mjs [--apply --database <verified-database-name>]');
    }
    await runIndexMigration({ connectionString: process.env.DATABASE_URL, apply, expectedDatabase });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
