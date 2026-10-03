// The guard query in docs/database-migrations.md, which the database owner runs before publishing a build: a build
// that serves now may not check integrity guards at all, so its readiness cannot show a guard the new build needs.
// The query must name exactly the unique indexes and check constraints of integrityGuards (lib/valo-pay-1-store.ts)
// that the database lacks, and any superseded guard (supersededGuards) it still holds, as the new build's readiness
// does. It runs against this suite's pushed database, then against a copy of the eleven service tables in a scratch schema, read
// through the search path as the document says for a runtime schema, from which guards are taken away: dropped,
// rebuilt without their condition, added back without validation; and to which the provider event guard migration
// 009 replaces is added under a generated name, then left ready but not valid by an interrupted concurrent drop. Only
// the scratch schema changes, and it is dropped at the end.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

if (process.env.VALO_PAY_1_RUN_INTEGRATION !== "1") {
  console.log("Set VALO_PAY_1_RUN_INTEGRATION=1 to run the integrity guard query rehearsal.");
  process.exit(0);
}
const { pool } = await import("@workspace/valo-pay-1-db");
const { closeDatabase, integrityGuards, pingDatabase } = await import("../src/lib/valo-pay-1-store");
type Guard = (typeof integrityGuards)[number];

const documented = await readFile(new URL("../../../docs/database-migrations.md", import.meta.url), "utf8");
const blocks = [...documented.matchAll(/```sql\n([\s\S]*?)```/g)].map((match) => match[1]!);
assert.equal(blocks.length, 1, "docs/database-migrations.md holds one SQL block, the guard query");
const query = blocks[0]!;
const tables = [...new Set(integrityGuards.map((guard) => guard.table))];
assert.equal(tables.length, 11, "every application table has a guard");
const scratch = `valopay_guard_check_${randomBytes(6).toString("hex")}`;
const named = (guards: readonly Guard[]) => guards.map((guard) => `${guard.type} ${guard.name}`).sort();
const guardsNamed = (...names: string[]) => integrityGuards.filter((guard) => names.includes(guard.name));

const client = await pool.connect();
let created = false;
try {
  /** What the documented query lists on this connection, as the owner's psql session would, by kind and name. */
  const listed = async () => (await client.query<{ kind: string; name: string }>(query)).rows.map((row) => `${row.kind} ${row.name}`).sort();
  /** The unique indexes and check constraints the new build's readiness finds missing or superseded in a schema, by kind and name. */
  const readinessMissing = async (schema?: string) => {
    const readiness = await pingDatabase(schema ? { schema } : {});
    assert.equal(readiness.status, "ok", readiness.error);
    return { status: readiness.schema.status, guards: readiness.schema.missing.filter((entry) => /^(?:unique index|check|superseded unique index) /.test(entry)).map((entry) => entry.replace(/:.*$/, "")).sort(), missing: readiness.schema.missing };
  };

  // ---- The pushed database: nothing listed, and readiness misses no guard ----
  assert.deepEqual(await listed(), [], "on a pushed database the query lists nothing");
  assert.deepEqual((await readinessMissing()).guards, []);

  // ---- A copy of the eleven service tables, read through the search path: the query and readiness name the same guards ----
  await client.query(`CREATE SCHEMA "${scratch}"`);
  created = true;
  for (const table of tables) await client.query(`CREATE TABLE "${scratch}".${table} (LIKE public.${table} INCLUDING ALL)`);
  await client.query(`SET search_path TO "${scratch}"`);
  const agree = async (expected: string[], message: string) => {
    assert.deepEqual(await listed(), expected, `the query: ${message}`);
    const readiness = await readinessMissing(scratch);
    assert.deepEqual(readiness.guards, expected, `readiness: ${message}`);
    assert.equal(readiness.status, expected.length ? "incomplete" : "ok", message);
  };
  /** Takes a guard away from the copy, found by its definition, since the copy's indexes carry generated names. */
  const drop = async (guard: Guard) => {
    const found = guard.type === "check"
      ? (await client.query<{ constraint: string | null; index: string | null }>(
        "SELECT k.conname AS constraint, NULL AS index FROM pg_constraint k JOIN pg_class t ON t.oid=k.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname=$2 AND k.contype='c' AND pg_get_constraintdef(k.oid)=$3",
        [scratch, guard.table, guard.definition])).rows
      : (await client.query<{ constraint: string | null; index: string | null }>(
        `SELECT k.conname AS constraint, x.relname AS index FROM pg_index i JOIN pg_class x ON x.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
          LEFT JOIN pg_constraint k ON k.conindid=i.indexrelid AND k.contype IN ('p','u')
          WHERE n.nspname=$1 AND t.relname=$2 AND i.indisunique AND regexp_replace(pg_get_indexdef(i.indexrelid), '^CREATE (UNIQUE )?INDEX \\S+ ON (ONLY )?\\S+ ', '')=$3`,
        [scratch, guard.table, guard.definition])).rows;
    assert.equal(found.length, 1, `the copy holds ${guard.name} once`);
    const { constraint, index } = found[0]!;
    await client.query(constraint ? `ALTER TABLE "${scratch}".${guard.table} DROP CONSTRAINT "${constraint}"` : `DROP INDEX "${scratch}"."${index}"`);
  };
  await agree([], "a copy that holds every guard");

  const [inflight, ticketFloor, teamKey] = [guardsNamed("valopay_one_inflight")[0]!, guardsNamed("valopay_ticket_floor")[0]!, guardsNamed("valopay_teams_pkey")[0]!];
  for (const guard of [inflight, ticketFloor, teamKey]) await drop(guard);
  await agree(named([inflight, ticketFloor, teamKey]), "a partial unique index, a check and a primary key dropped");
  // Compared by definition, not by name: an index on the same columns without the guard's condition does not count,
  // nor does a check added back NOT VALID, which has not checked the rows already stored.
  await client.query("CREATE UNIQUE INDEX valopay_one_inflight ON valopay_records (merchant_id, (data->>'dueItemId'))");
  await client.query("ALTER TABLE valopay_records ADD CONSTRAINT valopay_ticket_floor CHECK (kind <> 'due-items' OR amount_kobo >= 500000) NOT VALID");
  await agree(named([inflight, ticketFloor, teamKey]), "a guard rebuilt without its condition, or added back without validation, is still missing");
  await client.query("ALTER TABLE valopay_records VALIDATE CONSTRAINT valopay_ticket_floor");
  await client.query("DROP INDEX valopay_one_inflight");
  await client.query("CREATE UNIQUE INDEX valopay_one_inflight ON valopay_records (merchant_id, (data->>'dueItemId')) WHERE kind = 'attempts' AND status IN ('scheduled', 'sent', 'unknown')");
  await agree(named([teamKey]), "a guard restored with its definition is in place again");
  // The provider event guard 009 replaces, still in place under the generated name a runtime schema's copy gives it:
  // the query and readiness name it by that name, and not once it is dropped.
  const copied = "valopay_records_merchant_id_expr_expr1_idx", teamKeyLine = "unique index valopay_teams_pkey: restore it as docs/database-migrations.md describes";
  const superseded = (valid: boolean) => `superseded unique index ${copied}: the earlier provider event guard, which refuses one event ID from two providers${valid ? ";" : ", left not valid but still enforced on writes; drop it by hand once reviewed, as the migration refuses it, then"} apply lib/db/migrations/009_record_identity_guards.sql with ${scratch} first on the search path`;
  await client.query(`CREATE UNIQUE INDEX ${copied} ON valopay_records (merchant_id, (data->>'source'), (data->>'eventId')) WHERE kind = 'observations' AND data->>'eventId' IS NOT NULL`);
  await agree([...named([teamKey]), `superseded unique index ${copied}`].sort(), "a superseded guard still in place");
  assert.deepEqual((await readinessMissing(scratch)).missing, [teamKeyLine, superseded(true)], "readiness says to apply 009 in that schema");
  // Dropped concurrently, to spare the reads 009's own drop holds back, and stopped while a read runs, the copy is left
  // not valid but still ready: maintained, and so still enforced, on every write. The query and readiness still name
  // it, and readiness says to drop it by hand first, since 009 refuses an index with that definition that is not valid.
  const reader = await pool.connect();
  try {
    await reader.query("BEGIN");
    await reader.query(`SELECT count(*) FROM "${scratch}".valopay_records`);
    await client.query("SET statement_timeout = '1s'");
    await assert.rejects(client.query(`DROP INDEX CONCURRENTLY ${copied}`), /statement timeout/);
  } finally {
    await client.query("RESET statement_timeout");
    await reader.query("ROLLBACK");
    reader.release();
  }
  assert.deepEqual((await client.query("SELECT indisvalid AS valid, indisready AS ready FROM pg_index WHERE indexrelid = $1::regclass", [copied])).rows, [{ valid: false, ready: true }], "the interrupted drop leaves the copy ready but not valid");
  await agree([...named([teamKey]), `superseded unique index ${copied}`].sort(), "a superseded guard left ready but not valid");
  assert.deepEqual((await readinessMissing(scratch)).missing, [teamKeyLine, superseded(false)], "readiness says to drop it by hand, then apply 009");
  await client.query(`DROP INDEX ${copied}`);
  await agree(named([teamKey]), "a superseded guard dropped");
  // Readiness names a missing guard with the migration that builds it again when applied: 009 its two guards, 003 the
  // membership index it creates on its own. 003 and 004 create every other guard of their tables with the table, and
  // applied again leave a table that exists as it is, so those, like the base tables' guards, point to the manual restore.
  const [lenderAccess, workspaceUser] = [guardsNamed("valopay_staff_lender_access_membership_id_merchant_id_pk")[0]!, guardsNamed("valopay_staff_workspace_user")[0]!];
  for (const guard of [lenderAccess, workspaceUser]) await drop(guard);
  await agree(named([teamKey, lenderAccess, workspaceUser]), "a primary key of a 003 table and of the 004 table, and 003's own membership index, dropped");
  assert.deepEqual((await readinessMissing(scratch)).missing, [
    teamKeyLine,
    "unique index valopay_staff_workspace_user: apply lib/db/migrations/003_pilot_workflow.sql",
    "unique index valopay_staff_lender_access_membership_id_merchant_id_pk: restore it as docs/database-migrations.md describes",
  ]);

  // Every guard taken away: the query names all of them, and readiness the first 20 and a count.
  for (const guard of integrityGuards) if (![teamKey, lenderAccess, workspaceUser].includes(guard)) await drop(guard);
  assert.deepEqual(await listed(), named(integrityGuards), "the query lists every guard of the catalogue");
  const all = await readinessMissing(scratch);
  // Each with the migration that builds it again when applied, or else the manual restore.
  const source = (guard: Guard) => ["valopay_unique_customer_reference", "valopay_unique_provider_event"].includes(guard.name) ? "apply lib/db/migrations/009_record_identity_guards.sql"
    : guard.name === "valopay_staff_workspace_user" ? "apply lib/db/migrations/003_pilot_workflow.sql"
    : "restore it as docs/database-migrations.md describes";
  assert.deepEqual(all.missing, [...integrityGuards.slice(0, 20).map((guard) => `${guard.type} ${guard.name}: ${source(guard)}`), `and ${integrityGuards.length - 20} more`]);
  console.log(`Integrity guard query rehearsal passed: the documented query lists nothing on a pushed database or a copy of its tables, and names exactly the guards readiness names when a partial unique index, a check and a primary key are dropped, rebuilt without the guard's condition or added back without validation, when the provider event guard 009 replaces is still in place, valid or left ready but not valid by an interrupted concurrent drop, and when all ${integrityGuards.length} are taken away, each with the migration that builds it again or the manual restore.`);
} finally {
  await client.query("RESET search_path").catch(() => { /* the connection is released either way */ });
  if (created) await client.query(`DROP SCHEMA IF EXISTS "${scratch}" CASCADE`);
  client.release();
  await closeDatabase();
}
