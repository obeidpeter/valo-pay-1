import { SANDBOX_COOKIE } from "../src/lib/sandbox-cookie";
// The operator's re-wrap step on PostgreSQL (scripts/rewrap-payloads.ts, rewrapProtectedPayloads): after the
// payload wrapping key changes name, bounded runs re-seal every protected payload (an import batch's source rows
// and check, a journal entry's request and refusal receipt, a replay copy's answer) under the new key, each in
// its own scope, report how many still name an earlier key, and can be run again at any point; a payload a
// request rewrote while the run worked is left to it and checked again; a payload whose key the key service no
// longer opens stops the run with the key named. Once none remain, the earlier key is retired and every view,
// replay and recovery still opens its payloads. A restricted runtime's schema is scanned when VALO_PAY_1_RUNTIME_SCHEMA
// names it, every run names the schema it scanned and the others it did not, and a connection that could miss a
// payload (the restricted runtime login, or a login that neither owns the tables nor bypasses row security) is
// refused before it reads one. The key service is a local fixture that knows each key by name.
import assert from "node:assert/strict";
import express from "express";
import path from "node:path";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";

if (process.env.VALO_PAY_1_RUN_INTEGRATION !== "1") { console.log("Opt in on a disposable PostgreSQL database to test the payload re-wrap."); process.exit(0); }
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL || "").hostname), "Refuse a non-local integration database.");
const names = ["VALO_PAY_1_STAFF_ACCESS", "VALO_PAY_1_RUNTIME_ISOLATION", "VALO_PAY_1_RUNTIME_SCHEMA", "VALO_PAY_1_PAYLOAD_ENCRYPTION", "VALO_PAY_1_KMS_KEY", "VALO_PAY_1_KMS_PREVIOUS_KEYS"] as const;
const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
const key = (name: string) => `projects/synthetic-rewrap/locations/global/keyRings/fixture/cryptoKeys/${name}`;
const [first, second, third] = [key("first"), key("second"), key("third")];
Object.assign(process.env, { VALO_PAY_1_STAFF_ACCESS: "off", VALO_PAY_1_RUNTIME_ISOLATION: "off", VALO_PAY_1_PAYLOAD_ENCRYPTION: "kms", VALO_PAY_1_KMS_KEY: first });
delete process.env.VALO_PAY_1_KMS_PREVIOUS_KEYS; delete process.env.VALO_PAY_1_RUNTIME_SCHEMA;
const { pool } = await import("@workspace/valo-pay-1-db");
// The owner's own pool for the runtime schema's commissioning, whose session settings never reach the store's pool.
const { Pool } = createRequire(new URL("../../../lib/db/package.json", import.meta.url))("pg") as Pick<typeof import("@workspace/valo-pay-1-db"), "Pool">;
const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const { runtimeIsolationTables } = await import("../src/lib/runtime-isolation");
const { managedWrappingKeys, openPayload, sealPayload } = await import("../src/lib/protected-payloads");
// The key service fixture: one secret per key name; a retired key opens nothing, as a disabled Cloud KMS key would.
const masters = new Map<string, Buffer>([[first, randomBytes(32)]]);
const { wrap: realWrap, unwrap: realUnwrap } = managedWrappingKeys;
let beforeUnwrap: (() => Promise<void>) | undefined;
managedWrappingKeys.wrap = async (name, data, aad) => { const master = masters.get(name); if (!master) throw new Error("key unavailable"); const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", master, iv); cipher.setAAD(aad); const sealed = Buffer.concat([cipher.update(data), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), sealed]); };
managedWrappingKeys.unwrap = async (name, data, aad) => { const hook = beforeUnwrap; beforeUnwrap = undefined; await hook?.(); const master = masters.get(name); if (!master) throw new Error("key unavailable"); const decipher = createDecipheriv("aes-256-gcm", master, data.subarray(0, 12)); decipher.setAAD(aad); decipher.setAuthTag(data.subarray(12, 28)); return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]); };
const { default: router } = await import("../src/routes/index"), { errorHandler } = await import("../src/lib/error-handler"), store = await import("../src/lib/valo-pay-1-store");
const app = express(); app.use(express.json({ limit: "2mb" }));
app.use((req, _res, next) => { (req as any).auth = Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true }); (req as any).log = { info() {}, warn() {}, error() {} }; next(); });
app.use("/api", router); app.use(errorHandler);
const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as any).port}/api`, cookie = `${SANDBOX_COOKIE}=${randomBytes(32).toString("hex")}`;
async function call(path: string, method = "GET", body?: unknown, idempotencyKey?: string) { const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie, ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() as any }; }
const ok = (result: { status: number; data: any }) => { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
let workspaceId = "", checks = 0, runtime: { schema: string; app: string; helper: string; reader: string } | undefined;
try {
  const lender = ok(await call("/v1/workspace")).merchants[0].id;
  workspaceId = (await pool.query("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [lender])).rows[0].workspace_id;
  const q = `?merchantId=${lender}`;
  // Protected payloads of every kind: a keyed save (its journal request and replay answer), a batch (its rows and check, and its own
  // request and answer) and a refused keyed save (its request and its refusal receipt).
  const customerKey = randomUUID(), customerBody = { name: "Re-wrap customer", reference: `REWRAP-${randomUUID()}`, data: { consentProvenance: "Synthetic consent" } };
  const customer = ok(await call(`/v1/records/customers${q}`, "POST", customerBody, customerKey));
  const batch = ok(await call(`/v1/pilot/batches${q}`, "POST", { name: "Re-wrap source", kind: "customers", source: "rewrap", sourceBatchId: randomUUID(), csv: "source_row_id,name,reference,consentProvenance\nrow-1,Re-wrap row,REWRAP-ROW-1,Synthetic consent", mapping: {}, identityColumn: "source_row_id", amountUnit: "naira", syntheticOnly: true }, randomUUID()));
  assert.equal((await call(`/v1/records/mandates${q}`, "POST", { name: "Refused mandate", customerId: customer.id, amountKobo: 1, data: {} }, randomUUID())).status, 400);
  const envelopes = async () => (await pool.query<{ key: string; n: string }>(`SELECT value->>'key' AS key,count(*) AS n FROM (
      SELECT f.value FROM valopay_records r JOIN valopay_merchants m ON m.id=r.merchant_id CROSS JOIN LATERAL (VALUES (r.data->'csv'),(r.data->'check')) f(value) WHERE m.workspace_id=$1 AND r.kind='import-batches'
      UNION ALL SELECT f.value FROM valopay_operations o JOIN valopay_merchants m ON m.id=o.merchant_id CROSS JOIN LATERAL (VALUES (o.request),(o.receipt)) f(value) WHERE m.workspace_id=$1
      UNION ALL SELECT i.response FROM valopay_idempotency i JOIN valopay_merchants m ON m.id=i.merchant_id WHERE m.workspace_id=$1) payload
    WHERE jsonb_typeof(value)='object' AND value ? 'protectedPayload' GROUP BY 1 ORDER BY 1`, [workspaceId])).rows.map(row => [row.key, Number(row.n)]);
  const sealedFirst = (await envelopes()).find(([name]) => name === first)?.[1] as number;
  assert.equal(sealedFirst, 8, "two for the customer, four for the batch and two for the refusal"); checks += 1;
  assert.equal((await pool.query("SELECT count(*) AS n FROM valopay_operations WHERE merchant_id=$1 AND receipt ? 'protectedPayload'", [lender])).rows[0].n, "1", "the refusal receipt is sealed too"); checks += 1;

  // The key changes name: new payloads are sealed under the second key, and the first stays listed to open the older ones.
  masters.set(second, randomBytes(32));
  Object.assign(process.env, { VALO_PAY_1_KMS_KEY: second, VALO_PAY_1_KMS_PREVIOUS_KEYS: first });
  const rewrap = (limit: number) => store.rewrapProtectedPayloads({ limit, workspaces: [workspaceId] });
  // A payload a request rewrote while the run worked is left to it: the first one opened is sealed afresh behind the run's back.
  beforeUnwrap = async () => {
    const row = (await pool.query("SELECT i.id,i.merchant_id,i.response FROM valopay_idempotency i JOIN valopay_merchants m ON m.id=i.merchant_id WHERE m.workspace_id=$1 AND i.response->>'key'=$2 ORDER BY i.merchant_id,i.id LIMIT 1", [workspaceId, first])).rows[0];
    const scope = { lender: row.merchant_id, record: row.id, field: "response" };
    await pool.query("UPDATE valopay_idempotency SET response=$3 WHERE id=$1 AND merchant_id=$2", [row.id, row.merchant_id, await sealPayload(await openPayload(row.response, scope, managedWrappingKeys), scope, first, managedWrappingKeys)]);
  };
  let run = await rewrap(3);
  assert.deepEqual([run.key, run.rewrapped, run.changed, run.remaining, run.remainingByKey], [second, 2, 1, sealedFirst - 2, [{ key: first, payloads: sealedFirst - 2 }]]); checks += 1;
  assert.match(run.message, /Re-sealed 2 protected payloads in public under .*cryptoKeys\/second; 1 changed while this run worked and will be checked again\. \d+ in public still name an earlier key: run the command again until none remain/); checks += 1;
  let runs = 1, total = run.rewrapped;
  while (run.remaining && runs < 20) { run = await rewrap(3); total += run.rewrapped; runs += 1; }
  assert.deepEqual([run.remaining, total, run.remainingByKey, run.schema], [0, sealedFirst, [], "public"], "every payload is re-sealed, the one rewritten meanwhile included, in the schema the search path reaches"); checks += 1;
  assert.match(run.message, run.otherSchemas.length ? /No protected payload in public names an earlier key, but .* the application's tables: re-wrap/ : /No protected payload in public names an earlier key: an earlier key may be retired once no backup you may restore still needs it/); checks += 1;
  assert.deepEqual(await envelopes(), [[second, sealedFirst]]); checks += 1;
  const again = await rewrap(3);
  assert.deepEqual([again.rewrapped, again.changed, again.remaining], [0, 0, 0], "running it again changes nothing"); checks += 1;

  // The first key is retired: the views, a replay and a recovery still open every payload under the second.
  masters.delete(first); delete process.env.VALO_PAY_1_KMS_PREVIOUS_KEYS;
  assert.match(ok(await call(`/v1/pilot/batches/${batch.id}${q}`)).batch.data.csv, /Re-wrap row/); checks += 1;
  assert.equal(ok(await call(`/v1/records/customers${q}`, "POST", customerBody, customerKey)).id, customer.id, "the replay copy opens"); checks += 1;
  const journal = ok(await call(`/v1/operations${q}`)).items.find((item: any) => item.recordId === customer.id);
  assert.equal(ok(await call(`/v1/operations/${journal.id}/retry${q}`, "POST", {})).id, customer.id, "the journal request opens"); checks += 1;

  // A payload whose key the key service no longer opens stops the run, naming the key; with the key back, the run finishes.
  masters.set(third, randomBytes(32)); process.env.VALO_PAY_1_KMS_KEY = third;
  ok(await call(`/v1/records/customers${q}`, "POST", { name: "Third key customer", reference: `REWRAP-${randomUUID()}`, data: { consentProvenance: "Synthetic consent" } }, randomUUID()));
  const thirdMaster = masters.get(third)!; masters.delete(third); process.env.VALO_PAY_1_KMS_KEY = second;
  await assert.rejects(() => rewrap(10), (error: any) => error.status === 503 && /sealed under .*cryptoKeys\/third could not be opened, so the run stopped after re-sealing 0\. Keep that key in VALO_PAY_1_KMS_PREVIOUS_KEYS/.test(error.message)); checks += 1;
  masters.set(third, thirdMaster);
  assert.equal((await rewrap(10)).remaining, 0); checks += 1;
  // Without a configured key, with too large a batch or with a schema that is not a restricted runtime's, the step refuses before it reads anything.
  process.env.VALO_PAY_1_PAYLOAD_ENCRYPTION = "off";
  await assert.rejects(() => rewrap(1), /Set VALO_PAY_1_PAYLOAD_ENCRYPTION=kms/); checks += 1;
  process.env.VALO_PAY_1_PAYLOAD_ENCRYPTION = "kms";
  await assert.rejects(() => store.rewrapProtectedPayloads({ limit: 1001, workspaces: [workspaceId] }), /between 1 and 1000/); checks += 1;

  // ---- A restricted runtime's schema, and the connection that reads it (the review of b9b10ef, finding 3) ----
  // A restricted runtime keeps the staff pilot's payloads in a schema of its own, whose ten tables force row security.
  // With VALO_PAY_1_RUNTIME_SCHEMA set the step scans that schema's tables, qualified; every run names the schema it
  // scanned and the other schemas that hold the application's tables. A connection that row security filters, or that
  // neither owns the tables nor bypasses row security, is refused before it reads anything: it would count none left
  // and say an earlier key may be retired. The runtime schema is commissioned as docs/database-migrations.md does it.
  const suffix = randomBytes(5).toString("hex"), password = randomBytes(16).toString("hex");
  runtime = { schema: `valopay_runtime_test_rewrap${suffix}`, app: `rewrap_app_${suffix}`, helper: `rewrap_helper_${suffix}`, reader: `rewrap_reader_${suffix}` };
  const scope = { lender: "rewrap-runtime-lender", record: "rewrap-runtime-operation", field: "request" };
  const owner = await admin.connect();
  try {
    await owner.query(`CREATE SCHEMA "${runtime.schema}"`);
    for (const table of runtimeIsolationTables) await owner.query(`CREATE TABLE "${runtime.schema}".${table} (LIKE public.${table} INCLUDING ALL)`);
    await owner.query(`INSERT INTO "${runtime.schema}".valopay_workspaces(id,principal_hash,role) VALUES('rewrap-runtime','rewrap-runtime-principal','Admin')`);
    await owner.query(`INSERT INTO "${runtime.schema}".valopay_merchants(id,workspace_id,info,settings) VALUES($1,'rewrap-runtime',$2,'{}')`, [scope.lender, { id: scope.lender, name: "Runtime lender", shortName: "RL", segment: "Consumer lending", mode: "observation", status: "onboarding", provider: "Paystack", monthlyVolume: 0, killSwitch: true, preDataReady: false, preLiveReady: false }]);
    await owner.query(`INSERT INTO "${runtime.schema}".valopay_operations(id,merchant_id,owner,actor,role,request_key,request_hash,request,label) VALUES($1,$2,'fixture','fixture','Admin','fixture','fixture',$3,'Save records customers')`, [scope.record, scope.lender, await sealPayload({ method: "POST", path: "/v1/records/customers", body: { name: "Runtime customer" } }, scope, third, managedWrappingKeys)]);
    await owner.query(`SET search_path TO "${runtime.schema}", public`);
    await owner.query("SELECT set_config('valopay.runtime_migration','staging-only',false),set_config('valopay.runtime_app_role',$1,false),set_config('valopay.runtime_helper_role',$2,false)", [runtime.app, runtime.helper]);
    await owner.query(await readFile(new URL("../../../lib/db/migrations/005_runtime_isolation.sql", import.meta.url), "utf8"));
    await owner.query("SELECT set_config('valopay.runtime_migration','staging-only',false)");
    await owner.query(await readFile(new URL("../../../lib/db/migrations/006_runtime_isolation_scope.sql", import.meta.url), "utf8"));
    await owner.query(`ALTER ROLE "${runtime.app}" PASSWORD '${password}'`);
    // A login that may read and change the application's own tables, but neither owns them nor bypasses row security.
    await owner.query(`CREATE ROLE "${runtime.reader}" LOGIN PASSWORD '${password}'`);
    await owner.query(`GRANT SELECT, UPDATE ON public.valopay_records, public.valopay_operations, public.valopay_idempotency, public.valopay_merchants TO "${runtime.reader}"`);
  } finally { owner.release(true); } // closed, not pooled: its search path and settings go with it
  const runtimeRewrap = () => store.rewrapProtectedPayloads({ limit: 10, workspaces: ["rewrap-runtime"] });
  process.env.VALO_PAY_1_RUNTIME_SCHEMA = runtime.schema;
  const isolated = await runtimeRewrap();
  assert.deepEqual([isolated.schema, isolated.rewrapped, isolated.remaining, isolated.otherSchemas.includes("public")], [runtime.schema, 1, 0, true], "the runtime schema's own tables are scanned and named, and public is named as not scanned"); checks += 1;
  assert.match(isolated.message, new RegExp(`^Re-sealed 1 protected payload in ${runtime.schema} under .*cryptoKeys/second\\. No protected payload in ${runtime.schema} names an earlier key, but .*public.* the application's tables: re-wrap`)); checks += 1;
  assert.equal((await admin.query(`SELECT request->>'key' AS key FROM "${runtime.schema}".valopay_operations`)).rows[0].key, second, "the runtime journal request is sealed under the current key"); checks += 1;
  delete process.env.VALO_PAY_1_RUNTIME_SCHEMA;
  const shared = await rewrap(10);
  assert.deepEqual([shared.schema, shared.otherSchemas.includes(runtime.schema)], ["public", true], "unset, the search path's tables are scanned, and the runtime schema is named as not scanned"); checks += 1;
  assert.match(shared.message, new RegExp(`No protected payload in public names an earlier key, but .*${runtime.schema}.* the application's tables: re-wrap .* retire an earlier key only once every schema reports none`)); checks += 1;
  for (const [setting, refusal] of [["public", /^VALO_PAY_1_RUNTIME_SCHEMA must name a restricted runtime's schema/], [`valopay_runtime_test_missing${suffix}`, /^VALO_PAY_1_RUNTIME_SCHEMA names valopay_runtime_test_missing\w+, which does not hold the application's tables/]] as const) {
    process.env.VALO_PAY_1_RUNTIME_SCHEMA = setting;
    await assert.rejects(runtimeRewrap, (error: any) => error.status === 503 && refusal.test(error.message)); checks += 1;
  }
  delete process.env.VALO_PAY_1_RUNTIME_SCHEMA;
  // The operator's command itself, in its own process (whose key service is Cloud KMS, never reached here): the
  // restricted login as the review ran it, with the runtime schema on its search path and VALO_PAY_1_RUNTIME_SCHEMA
  // unset, then with it set, and a login that neither owns the tables nor bypasses row security, are each refused
  // before a payload is read; the migration owner with the runtime schema first on its search path, as
  // docs/pilot-security.md gives the step, scans that schema.
  const root = path.resolve(import.meta.dirname, "..", "..", ".."), tsx = path.join(root, "scripts", "node_modules", "tsx", "dist", "cli.mjs");
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:VALO_PAY_1_|DATABASE_URL$|PGOPTIONS$)/.test(name)));
  const command = (login: string | undefined, env: Record<string, string>) => {
    const url = new URL(process.env.DATABASE_URL!);
    if (login) { url.username = login; url.password = password; }
    const run = spawnSync(process.execPath, [tsx, "scripts/rewrap-payloads.ts", "--limit", "10"], { cwd: root, encoding: "utf8", timeout: 60_000, env: { ...clean, DATABASE_URL: url.toString(), VALO_PAY_1_PAYLOAD_ENCRYPTION: "kms", VALO_PAY_1_KMS_KEY: second, ...env } });
    return { status: run.status, stdout: run.stdout, stderr: run.stderr.split("\n").filter((line) => line && !/DEP0040|trace-deprecation/.test(line)).join("\n") };
  };
  for (const [login, env, refusal] of [
    [runtime.app, { PGOPTIONS: `-c search_path=${runtime.schema}` }, new RegExp(`^Row security filters what this connection reads in ${runtime.schema}, so the re-wrap could miss payloads there`)],
    [runtime.app, { VALO_PAY_1_RUNTIME_SCHEMA: runtime.schema }, new RegExp(`^Row security filters what this connection reads in ${runtime.schema}`)],
    [runtime.reader, {}, /^This connection neither owns the application's tables in public nor bypasses row security/],
  ] as const) {
    const refused = command(login, env);
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, refusal); assert.doesNotMatch(refused.stdout, /"rewrapped"/); checks += 1;
  }
  const documented = command(undefined, { PGOPTIONS: `-c search_path=${runtime.schema},public` });
  assert.equal(documented.status, 0, documented.stderr);
  const answer = JSON.parse(documented.stdout.slice(documented.stdout.indexOf("{\n")));
  assert.deepEqual([answer.schema, answer.rewrapped, answer.remaining, answer.otherSchemas.includes("public")], [runtime.schema, 0, 0, true], "the documented step scans the runtime schema"); checks += 1;
  console.log(`Payload re-wrap PostgreSQL checks passed (${checks} checks): bounded, resumable re-sealing of every protected payload under a renamed key, a concurrent rewrite left to its request, the remaining count by key, a retired key no view needs, a stop that names a key the service cannot open, a restricted runtime's schema scanned and named, and the restricted login and a login without ownership or BYPASSRLS refused before a payload is read.`);
} finally {
  managedWrappingKeys.wrap = realWrap; managedWrappingKeys.unwrap = realUnwrap;
  for (const master of masters.values()) master.fill(0);
  for (const name of names) { const value = previous[name]; if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  server.close(); await once(server, "close");
  if (workspaceId) { for (const table of ["valopay_operations", "valopay_idempotency", "valopay_records"]) await pool.query(`DELETE FROM ${table} WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)`, [workspaceId]); await pool.query("DELETE FROM valopay_merchants WHERE workspace_id=$1", [workspaceId]); await pool.query("DELETE FROM valopay_workspaces WHERE id=$1", [workspaceId]); }
  // Only the schema and roles this run created, by their generated names.
  if (runtime) {
    await admin.query(`DROP SCHEMA IF EXISTS "${runtime.schema}" CASCADE`);
    for (const role of [runtime.reader, runtime.app, runtime.helper]) if ((await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rowCount) { await admin.query(`DROP OWNED BY "${role}"`); await admin.query(`DROP ROLE "${role}"`); }
  }
  await admin.end();
  await pool.end();
}
