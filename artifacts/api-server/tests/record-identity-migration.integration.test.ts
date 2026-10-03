// Owner-only rehearsal in isolated schemas of a disposable loopback database.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { requireLoopback } from './throwaway-database';
if (process.env.VALO_PAY_1_RUN_INTEGRATION !== '1') { console.log('Record identity migration requires disposable local PostgreSQL.'); process.exit(0); }
requireLoopback('Record identity migration', new URL(process.env.DATABASE_URL || ''));
const { pool } = await import('@workspace/valo-pay-1-db');
const { closeDatabase, integrityGuards, pingDatabase } = await import('../src/lib/valo-pay-1-store');
const migration = await readFile(new URL('../../../lib/db/migrations/009_record_identity_guards.sql', import.meta.url), 'utf8');
// A record table the checks change; an application schema as it was before 009; runtime schemas copied from that one.
const suffix = randomBytes(8).toString('hex'), schema = `valopay_identity_${suffix}`, earlier = `valopay_identity_earlier_${suffix}`, runtime = `valopay_identity_runtime_${suffix}`, applied = `valopay_identity_applied_${suffix}`;
const client = await pool.connect();
let checks = 0;
const insert = (id: string, kind: string, reference: string, data: Record<string, unknown> = {}, lender = 'lender-a') => client.query('INSERT INTO valopay_records VALUES ($1,$2,$3,$4,$5)', [id,lender,kind,reference,data]);
const definitionOf = "regexp_replace(pg_get_indexdef(i.indexrelid), '^CREATE (UNIQUE )?INDEX \\S+ ON (ONLY )?\\S+ ', '')";
const indexRows = async (table = 'valopay_records') => (await client.query<{ name: string; definition: string }>(`SELECT c.relname AS name,${definitionOf} AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=$1::regclass ORDER BY c.relname`, [table])).rows;
/** The unique indexes of a schema's record table that hold a definition, whatever their names. */
const uniqueIndexes = async (target: string, definition: string) => (await client.query<{ name: string }>(`SELECT c.relname AS name FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=$1::regclass AND i.indisunique AND ${definitionOf}=$2 ORDER BY 1`, [`"${target}".valopay_records`, definition])).rows.map(row => row.name);
// The provider event guard before 009: one event ID per lender and source, whatever the provider.
const oldGuard = "(merchant_id,(data->>'source'),(data->>'eventId')) WHERE kind='observations' AND data->>'eventId' IS NOT NULL";
const oldDefinition = "USING btree (merchant_id, ((data ->> 'source'::text)), ((data ->> 'eventId'::text))) WHERE ((kind = 'observations'::text) AND ((data ->> 'eventId'::text) IS NOT NULL))";
const refusedMigration = async (refusal: RegExp | ((error: any) => void)) => {
 const before = await indexRows(), rows = (await client.query('SELECT * FROM valopay_records ORDER BY id')).rows;
 await assert.rejects(client.query(migration), refusal instanceof RegExp ? refusal : (error: any) => { refusal(error); return true; });
 await client.query('ROLLBACK');
 assert.deepEqual(await indexRows(), before, 'a failed migration preserves all indexes');
 assert.deepEqual((await client.query('SELECT * FROM valopay_records ORDER BY id')).rows, rows, 'a failed migration preserves every source row'); checks++;
};
try {
 await client.query(`CREATE SCHEMA "${schema}"`);
 await client.query(`SET search_path TO "${schema}", pg_catalog`);
 await client.query('CREATE TABLE valopay_records (id text PRIMARY KEY,merchant_id text NOT NULL,kind text NOT NULL,reference text NOT NULL,data jsonb NOT NULL)');
 await client.query(`CREATE UNIQUE INDEX valopay_unique_observation ON valopay_records ${oldGuard}`);
 await insert('customer-a','customers','SHARED'); await insert('customer-b','customers','SHARED');
 // Six references each held twice: the refusal counts them and names the first five, by lender and reference alone.
 for (const n of [1,2,3,4,5]) { await insert(`twice-${n}-a`,'customers',`TWICE-${n}`,{},'lender-b'); await insert(`twice-${n}-b`,'customers',`TWICE-${n}`,{},'lender-b'); }
 await refusedMigration(error => {
  assert.match(error.message, /^Duplicate customer references exist within a lender \(groups to review: 6\)\. Migration 009 changed nothing\./);
  assert.equal(error.detail, "Up to five examples (lender, reference): ('lender-a', 'SHARED'), ('lender-b', 'TWICE-1'), ('lender-b', 'TWICE-2'), ('lender-b', 'TWICE-3'), ('lender-b', 'TWICE-4').");
 });
 await client.query("UPDATE valopay_records SET reference=id WHERE id='customer-b' OR id LIKE 'twice-%'");
 await insert('long-provider','observations','LONG',{provider:'x'.repeat(201),source:'webhook',eventId:'evt-long'});
 await refusedMigration(/exceeds 200 characters/);
 await client.query("UPDATE valopay_records SET data=jsonb_set(data,'{provider}','\"short-provider\"') WHERE id='long-provider'");
 await client.query(migration); checks++;
 const guards = integrityGuards.filter(guard => ['valopay_unique_customer_reference','valopay_unique_provider_event'].includes(guard.name));
 assert.deepEqual((await indexRows()).filter(row => guards.some(guard => guard.name === row.name)), guards.map(guard => ({name:guard.name,definition:guard.definition})).sort((a,b)=>a.name.localeCompare(b.name))); checks++;
 assert.ok(!(await indexRows()).some(row => row.name === 'valopay_unique_observation')); checks++;
 const first = await indexRows(); await client.query(migration); assert.deepEqual(await indexRows(), first); checks++;
 await assert.rejects(insert('customer-c','customers','SHARED'), (error: any) => error.code === '23505'); checks++;
 await insert('customer-other-lender','customers','SHARED',{},'lender-b'); checks++;
 await insert('event-a','observations','PA',{provider:'Provider A',source:'webhook',eventId:'evt-1'});
 await insert('event-b','observations','PB',{provider:'Provider B',source:'webhook',eventId:'evt-1'}); checks++;
 await assert.rejects(insert('event-a-duplicate','observations','PAD',{providerConnection:' PROVIDER A ',source:'webhook',eventId:'evt-1'}), (error: any) => error.code === '23505'); checks++;
 await insert('event-a-settlement','observations','PAS',{provider:'Provider A',source:'settlement',eventId:'evt-1'}); checks++;
 // Simulate an older database lacking a guard: duplicates must be refused, not silently removed by migration. The refusal
 // names the delivery by lender, provider namespace (as the guard compares it), source and event ID, and nothing else.
 await client.query('DROP INDEX valopay_unique_provider_event');
 await insert('event-conflict','observations','CONFLICT',{providerConnection:'provider a',source:'webhook',eventId:'evt-1'});
 await refusedMigration(error => {
  assert.match(error.message, /^Duplicate provider delivery identities exist within a lender \(groups to review: 1\)\. Migration 009 changed nothing\./);
  assert.equal(error.detail, "Up to five examples (lender, provider namespace, source, event ID): ('lender-a', 'provider a', 'webhook', 'evt-1').");
 });
 // A conflicting same-name index must not be accepted by IF NOT EXISTS.
 await client.query("UPDATE valopay_records SET data=jsonb_set(data,'{eventId}','\"evt-other\"') WHERE id='event-conflict'");
 await client.query('CREATE UNIQUE INDEX valopay_unique_provider_event ON valopay_records(id)');
 await refusedMigration(/not the reviewed definition/);
 await client.query('DROP INDEX valopay_unique_provider_event');
 // Nor is anything but the reviewed definition under the earlier guard's own name, here its columns without uniqueness.
 await client.query(`CREATE INDEX valopay_unique_observation ON valopay_records ${oldGuard}`);
 await refusedMigration(/old observation guard is not the reviewed definition/);
 await client.query('DROP INDEX valopay_unique_observation');
 // A concurrent build of the earlier guard that failed, under any name, leaves an index that is not valid and may still be
 // enforced on writes: it is left for review, not dropped unseen.
 await assert.rejects(client.query(`CREATE UNIQUE INDEX CONCURRENTLY valopay_earlier_attempt ON valopay_records ${oldGuard}`), /could not create unique index/);
 await refusedMigration(/An index with the old observation guard's definition is not valid \(valopay_earlier_attempt\)/);
 await client.query('DROP INDEX valopay_earlier_attempt');
 await client.query(migration); checks++;

 // ---- Runtime schemas: copies of an application schema that still held the earlier guard ----
 // docs/database-migrations.md commissions a runtime schema's tables as CREATE TABLE ... (LIKE public.<table> INCLUDING ALL),
 // which copies every index under a generated name. The application schema as it was before 009 stands in for public.
 await client.query('RESET search_path');
 const tables = [...new Set(integrityGuards.map(guard => guard.table))];
 await client.query(`CREATE SCHEMA "${earlier}"`);
 for (const table of tables) await client.query(`CREATE TABLE "${earlier}".${table} (LIKE public.${table} INCLUDING ALL)`);
 for (const guard of guards) for (const copy of await uniqueIndexes(earlier, guard.definition)) await client.query(`DROP INDEX "${earlier}"."${copy}"`);
 await client.query(`CREATE UNIQUE INDEX valopay_unique_observation ON "${earlier}".valopay_records ${oldGuard}`);
 await client.query(`CREATE SCHEMA "${runtime}"`);
 for (const table of tables) await client.query(`CREATE TABLE "${runtime}".${table} (LIKE "${earlier}".${table} INCLUDING ALL)`);
 const [copied] = await uniqueIndexes(runtime, oldDefinition);
 assert.ok(copied && copied !== 'valopay_unique_observation', 'the copy holds the earlier guard under a generated name'); checks++;
 // Readiness names each guard 009 installs, with the file, and the earlier guard by its own name, with where to run 009.
 const apply = 'apply lib/db/migrations/009_record_identity_guards.sql';
 const superseded = (name: string, target: string) => `superseded unique index ${name}: the earlier provider event guard, which refuses one event ID from two providers; ${apply} with ${target} first on the search path`;
 assert.deepEqual((await pingDatabase({ schema: runtime })).schema, { status: 'incomplete', missing: [...guards.map(guard => `unique index ${guard.name}: ${apply}`), superseded(copied!, runtime)] }, 'readiness before 009'); checks++;
 const delivery = (id: string, provider: string) => client.query(`INSERT INTO "${runtime}".valopay_records(id,merchant_id,kind,name,status,data) VALUES($1,'lender-a','observations','Synthetic delivery','new',$2)`, [id, { provider, source: 'webhook', eventId: 'evt-runtime' }]);
 await delivery('runtime-a', 'Provider A');
 await client.query(`SET search_path TO "${runtime}"`);
 await client.query(migration); checks++;
 assert.deepEqual(await uniqueIndexes(runtime, oldDefinition), [], 'the copied earlier guard is dropped, whatever its name'); checks++;
 for (const guard of guards) assert.deepEqual(await uniqueIndexes(runtime, guard.definition), [guard.name], guard.name); checks++;
 // Provider-scoped identity is in force in the runtime schema: a second provider's delivery with the same event ID is recorded.
 await delivery('runtime-b', 'Provider B'); checks++;
 await assert.rejects(delivery('runtime-a-again', ' PROVIDER A '), (error: any) => error.code === '23505'); checks++;
 assert.deepEqual((await pingDatabase({ schema: runtime })).schema, { status: 'ok', missing: [] }, 'a migrated runtime schema is ready'); checks++;
 const migrated = await indexRows(`"${runtime}".valopay_records`); await client.query(migration); assert.deepEqual(await indexRows(`"${runtime}".valopay_records`), migrated); checks++;
 // A host that applied 009 before it looked past the earlier guard's name: the new guards are in place, and so is the copy.
 // Readiness refuses that schema, naming the copy; 009, run again there, drops it and nothing else.
 await client.query('RESET search_path');
 await client.query(`CREATE SCHEMA "${applied}"`);
 for (const table of tables) await client.query(`CREATE TABLE "${applied}".${table} (LIKE "${earlier}".${table} INCLUDING ALL)`);
 await client.query(`SET search_path TO "${applied}"`);
 const guardStatements = migration.match(/^CREATE UNIQUE INDEX IF NOT EXISTS [\s\S]*?;$/gm)!;
 assert.equal(guardStatements.length, 2, 'the two guard statements of 009');
 for (const statement of guardStatements) await client.query(statement);
 const [leftover] = await uniqueIndexes(applied, oldDefinition);
 assert.deepEqual((await pingDatabase({ schema: applied })).schema, { status: 'incomplete', missing: [superseded(leftover!, applied)] }, 'readiness names the leftover and where to run 009'); checks++;
 const withLeftover = await indexRows(`"${applied}".valopay_records`);
 await client.query(migration);
 assert.deepEqual(await indexRows(`"${applied}".valopay_records`), withLeftover.filter(row => row.name !== leftover), 'run again, 009 drops the leftover and nothing else'); checks++;
 assert.deepEqual((await pingDatabase({ schema: applied })).schema, { status: 'ok', missing: [] }); checks++;
 // A pushed schema never holds the earlier guard: readiness of this suite's own database finds none.
 assert.deepEqual((await pingDatabase()).schema, { status: 'ok', missing: [] }, 'the pushed schema is ready'); checks++;
 console.log(`Record identity migration passed (${checks} checks): duplicate preflight counting and naming up to five groups, atomic rollback, scope/case equivalence, unchanged rows, exact definitions, the earlier guard dropped under any name (a runtime schema's generated copy, and a leftover when run again), readiness naming each missing guard's migration and a superseded guard, and repeat application.`);
} finally {
 await client.query('ROLLBACK').catch(()=>{});
 await client.query('RESET search_path');
 for (const target of [schema, earlier, runtime, applied]) await client.query(`DROP SCHEMA IF EXISTS "${target}" CASCADE`);
 client.release(); await closeDatabase();
}
