// Rehearses drizzle-kit push, the way a development or CI database gets its schema, on a throwaway database. A push
// runs its statements one at a time, outside a transaction, so a push that plans statements every time drops and
// rebuilds whatever they name on every run, and one stopped part way leaves it missing. Every push used to drop and
// re-add three foreign keys whose generated names PostgreSQL had cut at 63 characters, and drop and rebuild the
// in-flight and provider-event uniqueness guards, whose plain lender column drizzle-kit read back as an expression.
// A second push must plan nothing, on a freshly pushed database and on one built the way an existing host's was: the
// base tables an earlier push made, then the migrations in order, 003 and 004 as their earlier copies named the keys.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { requireCreateDatabase, requireLoopback, throwawayDatabaseName } from './throwaway-database';

if (process.env.VALOPAY_RUN_INTEGRATION !== '1') {
  console.log('Schema push rehearsal requires a disposable local PostgreSQL instance.'); process.exit(0);
}
// Any loopback database whose login can create databases: the rehearsal builds its own throwaway one beside it.
const suite = 'Schema push rehearsal';
const connection = new URL(process.env.DATABASE_URL || '');
requireLoopback(suite, connection);
const { pool, Pool } = await import('@workspace/db');
await requireCreateDatabase(suite, pool);
const database = throwawayDatabaseName(connection, 'push_rehearsal');
const targetUrl = new URL(connection); targetUrl.pathname = `/${database}`;
const env = { ...process.env, DATABASE_URL: targetUrl.toString() };
const kit = fileURLToPath(new URL('../../../lib/db/node_modules/drizzle-kit/bin.cjs', import.meta.url));
const dbPackage = fileURLToPath(new URL('../../../lib/db/', import.meta.url));
const indexRunner = fileURLToPath(new URL('../../../scripts/apply-record-list-indexes.mjs', import.meta.url));
const migration = (name: string) => readFile(new URL(`../../../lib/db/migrations/${name}`, import.meta.url), 'utf8');
/** The three foreign keys as the Drizzle schema names them, and as earlier copies of 003 and 004 left them, cut at 63 characters. */
const earlierNames = [
  ['valopay_staff_memberships', 'valopay_staff_memberships_workspace_id_fk', 'valopay_staff_memberships_workspace_id_valopay_teams_workspace_'],
  ['valopay_staff_invitations', 'valopay_staff_invitations_workspace_id_fk', 'valopay_staff_invitations_workspace_id_valopay_teams_workspace_'],
  ['valopay_staff_lender_access', 'valopay_staff_lender_access_membership_id_fk', 'valopay_staff_lender_access_membership_id_valopay_staff_members'],
] as const;
/**
 * `pnpm --filter @workspace/db run push-force` with --verbose into the throwaway database: the statements it planned
 * and ran, as it printed them. drizzle-kit prints a statement that failed and still exits 0, so an error is a failure.
 */
function push(): string[] {
  const run = spawnSync(process.execPath, [kit, 'push', '--force', '--verbose', '--config', './drizzle.config.ts'], { cwd: dbPackage, env, encoding: 'utf8', timeout: 120_000 });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  assert.equal(run.status, 0, output);
  assert.doesNotMatch(output, /\berror\b/i, output);
  const statements = output.split('\n').map((line) => line.trim()).filter((line) => /^(ALTER|CREATE|DROP)\b/.test(line));
  assert.ok(statements.length > 0 || output.includes('No changes detected'), output);
  return statements;
}
let target: InstanceType<typeof Pool> | undefined, created = false;
try {
  await pool.query(`CREATE DATABASE "${database}"`); created = true;
  // A fresh database: the first push creates everything, the second must find nothing to do.
  assert.ok(push().length > 0, 'the first push creates the schema');
  assert.deepEqual(push(), [], 'a second push on a freshly pushed database plans nothing');
  // An existing host's database: take away what the migrations add, then apply them as a host did.
  target = new Pool({ connectionString: targetUrl.toString() });
  await target.query('DROP TABLE valopay_export_cleanup, valopay_staff_lender_access, valopay_staff_events, valopay_staff_invitations, valopay_staff_memberships, valopay_teams, valopay_operations');
  await target.query('DROP INDEX valopay_records_lender_kind_page, valopay_records_lender_kind_status_page, valopay_records_lender_customer, valopay_records_lender_kind_updated, valopay_merchants_workspace, valopay_records_export_queue');
  const readIndexes = spawnSync(process.execPath, [indexRunner, '--apply', '--database', database], { env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(readIndexes.status, 0, readIndexes.stderr);
  for (const name of ['003_pilot_workflow.sql', '004_staff_lender_access.sql']) await target.query(await migration(name));
  for (const [table, name, cut] of earlierNames) await target.query(`ALTER TABLE ${table} RENAME CONSTRAINT ${name} TO ${cut}`);
  await target.query('DROP INDEX valopay_unique_customer_reference, valopay_unique_provider_event');
  await target.query("CREATE UNIQUE INDEX valopay_unique_observation ON valopay_records (merchant_id,(data->>'source'),(data->>'eventId')) WHERE kind='observations' AND data->>'eventId' IS NOT NULL");
  for (const name of ['007_journal_and_lender_indexes.sql', '008_export_queue_index_and_foreign_key_names.sql', '009_record_identity_guards.sql', '013_export_cleanup.sql']) await target.query(await migration(name));
  assert.deepEqual(push(), [], 'a push on a database built by the migrations plans nothing');
  assert.deepEqual(push(), [], 'and neither does the next one');
  console.log('Schema push rehearsal passed: a second push plans nothing on a freshly pushed database, and a push plans nothing on a database built from the base tables and migrations 002, 003, 004 (with the earlier foreign key names), 007, 008, 009 and 013, nor does the push after it.');
} finally {
  await target?.end();
  if (created) await pool.query(`DROP DATABASE "${database}"`);
  await pool.end();
}
