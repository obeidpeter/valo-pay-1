import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { expectedRuntimeDefinition, normaliseRuntimeDefinition, reviewedRuntimeHelpers, reviewedRuntimePolicies, reviewedRuntimeTrigger } from "../src/lib/runtime-isolation-policy";

if (process.env.VALOPAY_RUN_INTEGRATION !== "1") { console.log("Opt in on disposable PostgreSQL to run restricted runtime isolation checks."); process.exit(0); }
const { Pool } = createRequire(new URL("../../../lib/db/package.json", import.meta.url))("pg") as Pick<typeof import("@workspace/db"), "Pool">;
const original = { ...process.env }, admin = new Pool({ connectionString: process.env.DATABASE_URL });
const suffix = randomBytes(6).toString("hex"), schema = `valopay_runtime_test_${suffix}`, appRole = `runtime_app_${suffix}`, helperRole = `runtime_helper_${suffix}`, password = randomBytes(24).toString("hex");
const tables = ["valopay_workspaces", "valopay_merchants", "valopay_records", "valopay_idempotency", "valopay_operations", "valopay_teams", "valopay_staff_memberships", "valopay_staff_invitations", "valopay_staff_events", "valopay_staff_lender_access"];
let runtimePool: InstanceType<typeof Pool> | undefined;
const scopeMigration = await readFile(new URL("../../../lib/db/migrations/006_runtime_isolation_scope.sql", import.meta.url), "utf8");
// The application's own tables, which nothing here may change.
const publicFlags = async () => (await admin.query("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname", [tables])).rows;
try {
  const publicBefore = await publicFlags();
  const owner = await admin.connect();
  try {
    // All destructive cleanup later is restricted to these generated names.
    await owner.query(`CREATE SCHEMA "${schema}"`);
    for (const table of tables) await owner.query(`CREATE TABLE "${schema}".${table} (LIKE public.${table} INCLUDING ALL)`);
    for (const [workspace, org, user] of [["workspace-a", "org_runtimeA", "user_adminA"], ["workspace-b", "org_runtimeB", "user_adminB"]]) {
      await owner.query(`INSERT INTO "${schema}".valopay_workspaces(id,principal_hash,role) VALUES($1,$2,'Read-only')`, [workspace, createHash("sha256").update(`staff-org:${org}`).digest("hex")]);
      await owner.query(`INSERT INTO "${schema}".valopay_teams(workspace_id,organization_id,name) VALUES($1,$2,'Synthetic isolation rehearsal')`, [workspace, org]);
      await owner.query(`INSERT INTO "${schema}".valopay_staff_memberships(id,workspace_id,user_id,display_name,role,expires_at) VALUES($1,$2,$3,'Synthetic administrator','Admin',now()+interval '30 days')`, [`member-${workspace}`, workspace, user]);
      await owner.query(`INSERT INTO "${schema}".valopay_staff_events(id,workspace_id,actor,action,subject,detail) VALUES($1,$2,'System','fixture','fixture','{}')`, [`event-${workspace}`, workspace]);
      await owner.query(`INSERT INTO "${schema}".valopay_staff_invitations(id,workspace_id,email,role,token_hash,invited_by,expires_at) VALUES($1,$2,$3,'Finance',$4,'System',now()+interval '1 day')`, [`invite-${workspace}`, workspace, `${workspace}@example.test`, createHash("sha256").update(`token-${workspace}`).digest("hex")]);
    }
    for (const [id, workspace] of [["lender-a", "workspace-a"], ["lender-a-private", "workspace-a"], ["lender-b", "workspace-b"]]) {
      const info = { id, name: id, shortName: id, segment: "Consumer lending", mode: "observation", status: "onboarding", provider: "Paystack", monthlyVolume: 0, killSwitch: true, preDataReady: false, preLiveReady: false };
      await owner.query(`INSERT INTO "${schema}".valopay_merchants(id,workspace_id,info,settings) VALUES($1,$2,$3,'{}')`, [id, workspace, info]);
      await owner.query(`INSERT INTO "${schema}".valopay_records(id,merchant_id,kind,name,status,data) VALUES($1,$2,'customers','Synthetic customer','active','{"synthetic":true}')`, [`record-${id}`, id]);
      await owner.query(`INSERT INTO "${schema}".valopay_idempotency(id,merchant_id,request_hash,response) VALUES($1,$2,'fixture','{}')`, [`key-${id}`, id]);
      await owner.query(`INSERT INTO "${schema}".valopay_operations(id,merchant_id,owner,actor,role,request_key,request_hash,request,label) VALUES($1,$2,'fixture','fixture','Admin','fixture','fixture','{}','fixture')`, [`operation-${id}`, id]);
    }
    for (const [id, user, role] of [["finance-a", "user_financeA", "Finance"], ["service-a", "user_serviceA", "Operations"], ["reader-a", "user_readerA", "Read-only"]]) {
      await owner.query(`INSERT INTO "${schema}".valopay_staff_memberships(id,workspace_id,user_id,display_name,role,expires_at) VALUES($1,'workspace-a',$2,'Synthetic member',$3,now()+interval '30 days')`, [id, user, role]);
      await owner.query(`INSERT INTO "${schema}".valopay_staff_lender_access(membership_id,merchant_id,granted_by) VALUES($1,'lender-a','fixture')`, [id]);
    }
    const migration = await readFile(new URL("../../../lib/db/migrations/005_runtime_isolation.sql", import.meta.url), "utf8");
    const roles = async () => (await owner.query("SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname=$2 DESC", [[appRole, helperRole], appRole])).rows;
    // 005 refuses without its explicit opt-in, and in the application's own schema even with it.
    await owner.query(`SET search_path TO "${schema}", public`);
    await owner.query("SELECT set_config('valopay.runtime_app_role',$1,false),set_config('valopay.runtime_helper_role',$2,false)", [appRole, helperRole]);
    await assert.rejects(() => owner.query(migration), /explicit commissioning/, "005 needs the explicit opt-in.");
    await owner.query("ROLLBACK");
    await owner.query("SET search_path TO public");
    await owner.query("SELECT set_config('valopay.runtime_migration','staging-only',false)");
    await assert.rejects(() => owner.query(migration), /public is refused/, "005 refuses the application's own schema.");
    await owner.query("ROLLBACK");
    assert.deepEqual([await roles(), await publicFlags()], [[], publicBefore], "A refused migration creates no role and leaves the application's tables as they were.");
    await owner.query(`SET search_path TO "${schema}", public`);
    await owner.query("SELECT set_config('valopay.runtime_migration','staging-only',false),set_config('valopay.runtime_app_role',$1,false),set_config('valopay.runtime_helper_role',$2,false)", [appRole, helperRole]);
    await owner.query(migration);
    assert.deepEqual(await roles(), [
      { rolname: appRole, rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false },
      { rolname: helperRole, rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: true },
    ], "005 creates a restricted login, and a helper owner that cannot log in.");
    // 006 runs as its own explicit step: 005 clears the commissioning opt-in when it finishes.
    await assert.rejects(() => owner.query(scopeMigration), /explicit commissioning/, "006 needs its own explicit opt-in.");
    await owner.query("ROLLBACK");
    await owner.query(`ALTER ROLE "${appRole}" PASSWORD '${password}'`);
  } finally { owner.release(); }
  const url = new URL(original.DATABASE_URL!); url.username = appRole; url.password = password;
  process.env.DATABASE_URL = url.toString();
  Object.assign(process.env, { VALOPAY_RUNTIME_ISOLATION: "staging", VALOPAY_RUNTIME_SCHEMA: schema, VALOPAY_RUNTIME_ROLE: appRole, VALOPAY_STAFF_ACCESS: "staging", VALOPAY_STAFF_ISSUER: "https://identity.example", VALOPAY_STAFF_ORIGINS: "https://pilot.example", VALOPAY_PAYLOAD_ENCRYPTION: "kms", VALOPAY_KMS_KEY: "projects/synthetic-test/locations/global/keyRings/test/cryptoKeys/test", VALOPAY_RUNTIME_SERVICE_ORG: "org_runtimeA", VALOPAY_RUNTIME_SERVICE_USER: "user_serviceA", CLERK_SECRET_KEY: "sk_test_placeholder" });
  const { pool } = await import("@workspace/db"); runtimePool = pool;
  const isolation = await import("../src/lib/runtime-isolation"), store = await import("../src/lib/valopay-store");
  // With 005 alone every lender check runs per row; the application refuses that schema.
  const early = await pool.connect();
  try {
    await early.query("BEGIN");
    await assert.rejects(() => isolation.bindRuntimeIdentity(early, { organizationId: "org_runtimeA", userId: "user_financeA" }), /Apply lib\/db\/migrations\/006_runtime_isolation_scope\.sql/, "The application refuses row-by-row lender policies.");
    await early.query("ROLLBACK");
  } finally { early.release(); }
  const upgrade = await admin.connect();
  try {
    await upgrade.query(`SET search_path TO "${schema}", public`);
    await upgrade.query("SELECT set_config('valopay.runtime_migration','staging-only',false)");
    await upgrade.query(scopeMigration);
    await upgrade.query("SELECT set_config('valopay.runtime_migration','staging-only',false)");
    await assert.rejects(() => upgrade.query(scopeMigration), /already evaluates lender scope once per statement/, "006 applies once.");
    await upgrade.query("ROLLBACK");
    await upgrade.query("SELECT set_config('valopay.runtime_migration','',false)");
  } finally { upgrade.release(); }
  // The reviewed set in runtime-isolation-policy.ts is exactly what 005 and 006
  // install, as PostgreSQL renders it with the search path the self-check uses.
  // A migration, or a PostgreSQL major version, that changes it fails here with
  // the difference to review. {role} is spelt out in the reviewed text, so a
  // migration that wrote the placeholder itself fails too.
  const golden = await admin.connect();
  try {
    await golden.query(`SET search_path TO pg_catalog, "${schema}", pg_temp`);
    const scope = { schema, role: appRole }, reviewed = (text: string | null) => expectedRuntimeDefinition(text, scope);
    const policies = (await golden.query(`SELECT tablename,policyname,cmd,permissive,roles::text[] AS roles,qual,with_check FROM pg_policies WHERE schemaname=$1 AND tablename=ANY($2::text[])`, [schema, tables])).rows;
    assert.deepEqual(Object.fromEntries(policies.map(row => [`${row.tablename}:${row.policyname}:${row.cmd}`, { using: normaliseRuntimeDefinition(row.qual, scope), check: normaliseRuntimeDefinition(row.with_check, scope) }])),
      Object.fromEntries(Object.entries(reviewedRuntimePolicies).map(([key, want]) => [key, { using: reviewed(want.using), check: reviewed(want.check) }])), "The reviewed policies are what 005 and 006 install.");
    assert.ok(policies.every(row => row.permissive === "PERMISSIVE" && row.roles.length === 1 && row.roles[0] === appRole), "Every installed policy is permissive and names only the runtime login.");
    const helpers = (await golden.query(`SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS args,pg_get_function_result(p.oid) AS result,p.provolatile::text AS volatility,l.lanname AS language,p.prosrc AS source FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname=$1`, [schema])).rows;
    assert.deepEqual(Object.fromEntries(helpers.map(row => [row.proname, { args: row.args, result: row.result, volatility: row.volatility, language: row.language, source: normaliseRuntimeDefinition(row.source, scope) }])),
      Object.fromEntries(Object.entries(reviewedRuntimeHelpers).map(([name, want]) => [name, { ...want, source: reviewed(want.source) }])), "The reviewed helpers are the schema's only functions, as 005 and 006 define them.");
    const triggers = (await golden.query(`SELECT t.tgname,c.relname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal`, [schema])).rows;
    assert.deepEqual(triggers.map(row => ({ name: row.tgname, table: row.relname, definition: normaliseRuntimeDefinition(row.definition, scope) })), [{ ...reviewedRuntimeTrigger, definition: reviewed(reviewedRuntimeTrigger.definition) }], "The workspace guard is the only trigger, as 005 defines it.");
  } finally { await golden.query("RESET search_path"); golden.release(); }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await isolation.bindRuntimeIdentity(client, { organizationId: "org_runtimeA", userId: "user_financeA" });
    assert.deepEqual((await client.query("SELECT id FROM valopay_merchants ORDER BY id")).rows.map(row => row.id), ["lender-a"]);
    for (const table of ["valopay_records", "valopay_idempotency", "valopay_operations"]) assert.deepEqual((await client.query(`SELECT DISTINCT merchant_id FROM ${table}`)).rows.map(row => row.merchant_id), ["lender-a"]);
    for (const table of ["valopay_teams", "valopay_staff_memberships", "valopay_staff_events"]) assert.deepEqual((await client.query(`SELECT DISTINCT workspace_id FROM ${table}`)).rows.map(row => row.workspace_id), ["workspace-a"]);
    assert.equal((await client.query("SELECT count(*)::int AS count FROM valopay_staff_invitations")).rows[0].count, 0, "A non-admin staff request cannot inspect invitation tokens or other invitees.");
    assert.deepEqual((await client.query("SELECT DISTINCT merchant_id FROM valopay_staff_lender_access")).rows.map(row => row.merchant_id), ["lender-a"]);
    assert.equal((await client.query("UPDATE valopay_records SET name='forbidden' WHERE merchant_id='lender-b'")).rowCount, 0);
    assert.equal((await client.query("UPDATE valopay_records SET name='forbidden' WHERE merchant_id='lender-a-private'")).rowCount, 0);
    assert.equal((await client.query("UPDATE valopay_merchants SET info=info WHERE id='lender-b'")).rowCount, 0);
    assert.equal((await client.query("UPDATE valopay_idempotency SET response='{}'::jsonb WHERE merchant_id='lender-a'")).rowCount, 0, "Only an administrator may replace a stored answer.");
    // Its own lender's records and journal it may write; a rolled-back write leaves nothing.
    await client.query("SAVEPOINT own_writes");
    assert.equal((await client.query("UPDATE valopay_records SET name='Synthetic edit' WHERE id='record-lender-a'")).rowCount, 1);
    assert.equal((await client.query("INSERT INTO valopay_records(id,merchant_id,kind,name,status,data) VALUES('finance-new','lender-a','customers','Synthetic addition','active','{}')")).rowCount, 1);
    assert.equal((await client.query("INSERT INTO valopay_idempotency(id,merchant_id,request_hash,response) VALUES('finance-key','lender-a','fixture','{}')")).rowCount, 1);
    await client.query("ROLLBACK TO SAVEPOINT own_writes");
    assert.equal((await client.query("SELECT count(*)::int AS count FROM valopay_records WHERE id='finance-new' OR name='Synthetic edit'")).rows[0].count, 0);
    // Nothing for another lender or workspace, no scope or identity column, no deletion and no change to row security itself.
    const refused: [string, RegExp][] = [
      ["INSERT INTO valopay_records(id,merchant_id,kind,name,status,data) VALUES('foreign-new','lender-b','customers','Forbidden','active','{}')", /row-level security/],
      ["INSERT INTO valopay_records(id,merchant_id,kind,name,status,data) VALUES('private-new','lender-a-private','customers','Forbidden','active','{}')", /row-level security/],
      ["INSERT INTO valopay_idempotency(id,merchant_id,request_hash,response) VALUES('foreign-key','lender-b','fixture','{}')", /row-level security/],
      ["INSERT INTO valopay_merchants(id,workspace_id,info,settings) VALUES('finance-lender','workspace-a','{}','{}')", /row-level security/],
      ["INSERT INTO valopay_workspaces(id,principal_hash) VALUES('unprovisioned','new-principal')", /permission denied/],
      ["UPDATE valopay_workspaces SET principal_hash='spoofed' WHERE id='workspace-a'", /permission denied/],
      ["UPDATE valopay_merchants SET workspace_id='workspace-b' WHERE id='lender-a'", /permission denied/],
      ["UPDATE valopay_records SET merchant_id='lender-b' WHERE id='record-lender-a'", /permission denied/],
      ["UPDATE valopay_records SET merchant_id='lender-a-private' WHERE id='record-lender-a'", /permission denied/],
      ["UPDATE valopay_records SET id='moved' WHERE id='record-lender-a'", /permission denied/],
      ["DELETE FROM valopay_records WHERE id='record-lender-a'", /permission denied/],
      ["ALTER TABLE valopay_records DISABLE ROW LEVEL SECURITY", /must be owner/],
      ["ALTER TABLE valopay_records NO FORCE ROW LEVEL SECURITY", /must be owner/],
      ["DROP POLICY valopay_runtime_scope ON valopay_records", /must be owner/],
      [`ALTER ROLE "${appRole}" BYPASSRLS`, /permission denied/],
      // Turning row security off makes a read fail, never skip a policy.
      ["SET LOCAL row_security = off; SELECT id FROM valopay_records", /row-level security/],
    ];
    for (const [sql, refusal] of refused) { await client.query("SAVEPOINT refused"); await assert.rejects(() => client.query(sql), refusal, sql); await client.query("ROLLBACK TO SAVEPOINT refused"); }
    await client.query("SAVEPOINT escalation");
    await assert.rejects(() => client.query("UPDATE valopay_staff_memberships SET role='Admin' WHERE id='finance-a'"), /row-level security/);
    await client.query("ROLLBACK TO SAVEPOINT escalation");
    await client.query("SAVEPOINT workspace_role");
    await assert.rejects(() => client.query("UPDATE valopay_workspaces SET role='Admin' WHERE id='workspace-a'"), /never changes them/, "The application role can lock its workspace row but never rewrite it; staff roles come from memberships.");
    await client.query("ROLLBACK TO SAVEPOINT workspace_role");
    assert.equal((await client.query("SELECT id FROM valopay_workspaces WHERE id='workspace-a' FOR SHARE")).rowCount, 1, "Row locks, which the store takes on every staff request, still work.");
    await client.query("ROLLBACK TO SAVEPOINT workspace_role");
    await assert.rejects(() => client.query("INSERT INTO valopay_staff_lender_access(membership_id,merchant_id,granted_by) VALUES('member-workspace-a','lender-a','forbidden')"), /row-level security/);
    await client.query("ROLLBACK TO SAVEPOINT escalation");
    assert.equal((await client.query("DELETE FROM valopay_staff_lender_access WHERE membership_id='service-a'")).rowCount, 0, "A worker cannot revoke another person's grants with raw SQL.");
    await assert.rejects(() => client.query("SELECT valopay_runtime_clear_invitee_grants()"), /verified-email invitation/);
    await client.query("ROLLBACK TO SAVEPOINT escalation");
    await client.query("COMMIT");
    await client.query("BEGIN"); await isolation.bindRuntimeIdentity(client, { organizationId: "org_runtimeA", userId: "user_readerA" });
    for (const [table, column, value] of [["valopay_merchants", "info", "info"], ["valopay_records", "name", "'forbidden'"], ["valopay_idempotency", "response", "'{}'::jsonb"], ["valopay_operations", "request", "'{}'::jsonb"]]) assert.equal((await client.query(`UPDATE ${table} SET ${column}=${value}`)).rowCount, 0, `Read-only SQL cannot update ${table}.`);
    const blockedInserts = [
      "INSERT INTO valopay_merchants(id,workspace_id,info,settings) VALUES('blocked-new','workspace-a','{}','{}')",
      "INSERT INTO valopay_records(id,merchant_id,kind,name,status,data) VALUES('blocked-new','lender-a','customers','Forbidden','active','{}')",
      "INSERT INTO valopay_idempotency(id,merchant_id,request_hash,response) VALUES('blocked-new','lender-a','blocked','{}')",
      "INSERT INTO valopay_operations(id,merchant_id,owner,actor,role,request_key,request_hash,request,label) VALUES('blocked-new','lender-a','fixture','fixture','Read-only','fixture','fixture','{}','fixture')",
    ];
    await client.query("SAVEPOINT reader_write");
    for (const sql of blockedInserts) { await assert.rejects(() => client.query(sql), /row-level security/); await client.query("ROLLBACK TO SAVEPOINT reader_write"); }
    await client.query("ROLLBACK");
    await client.query("BEGIN"); await isolation.bindRuntimeIdentity(client, { organizationId: "org_runtimeA", userId: "user_adminA" });
    assert.equal((await client.query("UPDATE valopay_idempotency SET response='{}'::jsonb WHERE merchant_id='lender-a'")).rowCount, 1, "Admin lifecycle redaction can replace the scoped idempotency response.");
    // An administrator adds lenders to its own workspace only: the workspace scope, not the role, refuses another's.
    await client.query("SAVEPOINT admin_scope");
    await assert.rejects(() => client.query("INSERT INTO valopay_merchants(id,workspace_id,info,settings) VALUES('admin-foreign','workspace-b','{}','{}')"), /row-level security/, "An administrator of workspace A cannot add a lender to workspace B.");
    await client.query("ROLLBACK TO SAVEPOINT admin_scope");
    assert.equal((await client.query("INSERT INTO valopay_merchants(id,workspace_id,info,settings) VALUES('admin-own','workspace-a','{}','{}')")).rowCount, 1, "It can add one to its own.");
    await client.query("ROLLBACK");
    await client.query("BEGIN"); await client.query(`SET LOCAL search_path TO "${schema}", pg_catalog`);
    for (const table of tables) assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0, `${table}: transaction scope does not leak through the pool.`);
    await client.query("SAVEPOINT unscoped");
    await assert.rejects(() => client.query("INSERT INTO valopay_records(id,merchant_id,kind,name,status,data) VALUES('unscoped-new','lender-a','customers','Forbidden','active','{}')"), /row-level security/, "Nothing is written without a scope.");
    await client.query("ROLLBACK TO SAVEPOINT unscoped");
    // Half a scope, or an empty one, is none: the organisation and the person must match an active membership together.
    for (const [org, user] of [["org_runtimeA", ""], ["", "user_financeA"], ["", ""]]) {
      await client.query("SELECT set_config('valopay.runtime_org',$1,true),set_config('valopay.runtime_user',$2,true)", [org, user]);
      for (const table of tables) assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0, `${table}: organisation "${org}" and user "${user}" see nothing.`);
    }
    await client.query("ROLLBACK");
    await client.query("BEGIN"); await isolation.bindRuntimeIdentity(client, { organizationId: "org_runtimeB", userId: "user_financeA" });
    for (const table of tables) assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0, `${table}: user/organisation mixing produces no authorised rows.`);
    await client.query("ROLLBACK");
    await client.query("BEGIN"); await isolation.bindRuntimeIdentity(client, { organizationId: "org_runtimeA", userId: "user_invitee" }, { token: "token-workspace-a", verifiedEmails: ["workspace-a@example.test"] });
    assert.equal((await client.query("SELECT id FROM valopay_staff_invitations")).rows[0].id, "invite-workspace-a");
    assert.equal((await client.query("SELECT count(*)::int AS count FROM valopay_merchants")).rows[0].count, 0, "An invitation scope has no lender grants."); await client.query("ROLLBACK");
    await client.query("BEGIN"); await isolation.bindRuntimeIdentity(client, { organizationId: "org_runtimeA", userId: "user_invitee" }, { token: "token-workspace-a", verifiedEmails: ["wrong@example.test"] });
    assert.equal((await client.query("SELECT count(*)::int AS count FROM valopay_staff_invitations")).rows[0].count, 0); await client.query("ROLLBACK");
    await client.query("BEGIN"); await isolation.bindRuntimeService(client);
    assert.equal(await isolation.runtimeExportRequesterAllowed(client, "workspace-a", "lender-a", "Clerk:user_financeA", "Finance"), true);
    assert.equal(await isolation.runtimeExportRequesterAllowed(client, "workspace-a", "lender-a-private", "Clerk:user_financeA", "Finance"), false);
    assert.equal(await isolation.runtimeExportRequesterAllowed(client, "workspace-a", "lender-a", "Clerk:user_financeA", "Admin"), false);
    assert.equal(await isolation.runtimeExportRequesterAllowed(client, "workspace-a", "lender-a", "Clerk:user_financeA", "invented-role"), false); await client.query("ROLLBACK");
  } finally { client.release(); }
  // Exercise the actual repository entry point under the restricted LOGIN,
  // including staff/MFA verification. No KMS call is needed to read this masked
  // synthetic fixture; encryption has its own injected-adapter acceptance suite.
  const now = Math.floor(Date.now() / 1000), auth = { userId: "user_financeA", orgId: "org_runtimeA", sessionId: "sess_runtime", tokenType: "session_token", sessionStatus: "active", factorVerificationAge: [0, 0], sessionClaims: { sub: "user_financeA", sid: "sess_runtime", iss: "https://identity.example", azp: "https://pilot.example", iat: now - 1, exp: now + 3600 } };
  const req = { headers: {}, auth: Object.assign(() => auth, { [Symbol.for("@clerk/express.auth")]: true }) } as any;
  // The self-check compares what each policy, helper and the workspace guard do,
  // not only their names. Every weakening below keeps the names and used to pass,
  // so the readiness page called the database verified while, for instance,
  // Finance A's SQL saw every workspace's lenders. Each is now refused with a 503
  // whose logged differences name it, and the restored set is accepted again.
  const readinessRoute = ((await import("../src/routes/access-readiness")).default as any).stack.find((layer: any) => layer.route?.path === "/v1/team/readiness" && layer.route.methods.get).route.stack[0].handle;
  const databaseReadiness = async () => { let body: any; const res: any = { cookie() {}, json(value: unknown) { body = value; return res; } }; await readinessRoute(req, res); return body.checks.find((check: any) => check.id === "database"); };
  const verified = await databaseReadiness();
  assert.equal(verified.state, "verified_this_request"); assert.match(verified.detail, /reviewed/, "Readiness says what this request verified.");
  const bindFinance = async () => { const probe = await pool.connect(); try { await probe.query("BEGIN"); await isolation.bindRuntimeIdentity(probe, { organizationId: "org_runtimeA", userId: "user_financeA" }); } finally { await probe.query("ROLLBACK"); probe.release(); } };
  // Behind a transaction-mode pooler a client's next transaction may run on another server connection, which holds
  // none of the statements the client prepared on the last one; DEALLOCATE ALL stands in for that move. The self-check
  // prepares no named statement, so every transaction's check still runs.
  const pooled = await pool.connect();
  try {
    for (let transaction = 1; transaction <= 3; transaction++) {
      await pooled.query("BEGIN");
      try {
        await isolation.bindRuntimeIdentity(pooled, { organizationId: "org_runtimeA", userId: "user_financeA" });
        assert.equal((await pooled.query("SELECT count(*)::int AS count FROM pg_prepared_statements")).rows[0].count, 0, "The self-check leaves no prepared statement for a pooler to lose.");
      } finally { await pooled.query("ROLLBACK"); }
      await pooled.query("DEALLOCATE ALL");
    }
  } finally { pooled.release(); }
  const dba = await admin.connect();
  try {
    await dba.query(`SET search_path TO pg_catalog, "${schema}", pg_temp`);
    const rendered = async (table: string, policy: string, column: "qual" | "with_check") => (await dba.query(`SELECT ${column} AS expression FROM pg_policies WHERE schemaname=$1 AND tablename=$2 AND policyname=$3`, [schema, table, policy])).rows[0].expression as string;
    const merchantsScope = await rendered("valopay_merchants", "valopay_runtime_scope", "qual"), recordsScope = await rendered("valopay_records", "valopay_runtime_scope", "qual");
    const recordsInsert = await rendered("valopay_records", "valopay_runtime_insert", "with_check"), eventsInsert = await rendered("valopay_staff_events", "valopay_runtime_insert", "with_check");
    const functionDefinition = async (name: string) => (await dba.query("SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname=$2", [schema, name])).rows[0].definition as string;
    const lendersDefinition = await functionDefinition("valopay_runtime_lenders"), guardFunction = await functionDefinition("valopay_runtime_guard_workspace");
    // CREATE OR REPLACE keeps the owner, SECURITY DEFINER and the fixed search path: only the body changes.
    const placeholderGuard = guardFunction.replace(`session_user='${appRole}'`, "session_user='{role}'");
    assert.notEqual(placeholderGuard, guardFunction, "The guard tests the runtime login by name.");
    const guard = "CREATE TRIGGER valopay_runtime_workspace_guard BEFORE UPDATE ON valopay_workspaces FOR EACH ROW EXECUTE FUNCTION valopay_runtime_guard_workspace()";
    const policyRefusal = /differ from the reviewed runtime policy set/, helperRefusal = /differs from the reviewed runtime helper set/, tableRefusal = /forced row security and a separate owner/;
    const roleRefusal = /refused an elevated or unexpected database connection/, grantRefusal = /privileges, or the objects in the runtime schema, differ from the reviewed set/;
    const probeView = `valopay_isolation_probe_${suffix}`;
    const tableOwner = (await dba.query("SELECT pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='valopay_teams'", [schema])).rows[0].owner as string;
    const weakenings = [
      { name: "a lender scope that admits every lender", apply: "ALTER POLICY valopay_runtime_scope ON valopay_merchants USING (true)", restore: `ALTER POLICY valopay_runtime_scope ON valopay_merchants USING (${merchantsScope})`, refusal: policyRefusal, differences: ["valopay_merchants:valopay_runtime_scope:SELECT: USING expression differs"] },
      { name: "an insert check that admits any lender", apply: "ALTER POLICY valopay_runtime_insert ON valopay_records WITH CHECK (true)", restore: `ALTER POLICY valopay_runtime_insert ON valopay_records WITH CHECK (${recordsInsert})`, refusal: policyRefusal, differences: ["valopay_records:valopay_runtime_insert:INSERT: WITH CHECK expression differs"] },
      { name: "a scope widened to every role", apply: "ALTER POLICY valopay_runtime_scope ON valopay_records TO public", restore: `ALTER POLICY valopay_runtime_scope ON valopay_records TO "${appRole}"`, refusal: policyRefusal, differences: ["valopay_records:valopay_runtime_scope:SELECT: applies to public instead of the runtime login"] },
      { name: "a scope recreated as restrictive", apply: `DROP POLICY valopay_runtime_scope ON valopay_records; CREATE POLICY valopay_runtime_scope ON valopay_records AS RESTRICTIVE FOR SELECT TO "${appRole}" USING (${recordsScope})`, restore: `DROP POLICY valopay_runtime_scope ON valopay_records; CREATE POLICY valopay_runtime_scope ON valopay_records FOR SELECT TO "${appRole}" USING (${recordsScope})`, refusal: policyRefusal, differences: ["valopay_records:valopay_runtime_scope:SELECT: restrictive instead of permissive"] },
      { name: "a lender helper that lists every lender", apply: `CREATE OR REPLACE FUNCTION "${schema}".valopay_runtime_lenders() RETURNS SETOF text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog,"${schema}",pg_temp AS $body$ SELECT id FROM "${schema}".valopay_merchants $body$`, restore: lendersDefinition, refusal: helperRefusal, differences: ["valopay_runtime_lenders: body differs"] },
      // Compares the session with the string '{role}', so it never fires; the runtime login could rewrite its workspace row.
      { name: "a workspace guard that watches the placeholder, not the login", apply: placeholderGuard, restore: guardFunction, refusal: helperRefusal, differences: ["valopay_runtime_guard_workspace: body differs"] },
      { name: "a disabled workspace guard", apply: "ALTER TABLE valopay_workspaces DISABLE TRIGGER valopay_runtime_workspace_guard", restore: "ALTER TABLE valopay_workspaces ENABLE TRIGGER valopay_runtime_workspace_guard", refusal: policyRefusal, differences: ["valopay_runtime_workspace_guard: disabled (state D)"] },
      { name: "a workspace guard narrowed to one column", apply: `DROP TRIGGER valopay_runtime_workspace_guard ON valopay_workspaces; ${guard.replace("UPDATE ON", "UPDATE OF principal_hash ON")}`, restore: `DROP TRIGGER valopay_runtime_workspace_guard ON valopay_workspaces; ${guard}`, refusal: policyRefusal, differences: ["valopay_runtime_workspace_guard: definition differs"] },
      // Read with the runtime schema first, this policy would render exactly as reviewed.
      { name: "a built-in shadowed from the runtime schema", apply: `CREATE FUNCTION "${schema}".current_setting(text, boolean) RETURNS text LANGUAGE sql STABLE AS $body$ SELECT pg_catalog.current_setting($1, $2) $body$; ALTER POLICY valopay_runtime_insert ON valopay_staff_events WITH CHECK (${eventsInsert.replace("current_setting(", `"${schema}".current_setting(`)})`, restore: `ALTER POLICY valopay_runtime_insert ON valopay_staff_events WITH CHECK (${eventsInsert}); DROP FUNCTION "${schema}".current_setting(text, boolean)`, refusal: policyRefusal, differences: ["valopay_staff_events:valopay_runtime_insert:INSERT: WITH CHECK expression differs"] },
      // The tables themselves, which the check has always refused: row security no longer forced, or a table the runtime login owns and so could unforce.
      { name: "a table whose row security is no longer forced", apply: "ALTER TABLE valopay_records NO FORCE ROW LEVEL SECURITY", restore: "ALTER TABLE valopay_records FORCE ROW LEVEL SECURITY", refusal: tableRefusal, differences: undefined },
      // Handing the table back merges the login's own grant into the owner's, so the restore grants it again.
      { name: "a table the runtime login owns", apply: `ALTER TABLE valopay_teams OWNER TO "${appRole}"`, restore: `ALTER TABLE valopay_teams OWNER TO "${tableOwner}"; GRANT SELECT ON valopay_teams TO "${appRole}"`, refusal: tableRefusal, differences: undefined },
      // What the login may do beside the policies (23 September audit, security item 4). Each of these passed the check:
      // TRUNCATE emptied every workspace's records, a view a superuser owns returned every lender's, and REPLICATION
      // or a server-file or server-program role reaches data without row security at all.
      { name: "TRUNCATE granted to the runtime login", apply: `GRANT TRUNCATE ON valopay_records TO "${appRole}"`, restore: `REVOKE TRUNCATE ON valopay_records FROM "${appRole}"`, refusal: grantRefusal, differences: ["valopay_records:TRUNCATE: not in the reviewed set"] },
      { name: "a column the login may not change", apply: `GRANT UPDATE(merchant_id) ON valopay_records TO "${appRole}"`, restore: `REVOKE UPDATE(merchant_id) ON valopay_records FROM "${appRole}"`, refusal: grantRefusal, differences: ["valopay_records.merchant_id:UPDATE: not in the reviewed set"] },
      { name: "a privilege granted to PUBLIC", apply: "GRANT DELETE ON valopay_records TO PUBLIC", restore: "REVOKE DELETE ON valopay_records FROM PUBLIC", refusal: grantRefusal, differences: ["valopay_records:DELETE: not in the reviewed set"] },
      { name: "the REPLICATION attribute", apply: `ALTER ROLE "${appRole}" REPLICATION`, restore: `ALTER ROLE "${appRole}" NOREPLICATION`, refusal: roleRefusal, differences: ["the login holds REPLICATION"] },
      { name: "membership of pg_execute_server_program", apply: `GRANT pg_execute_server_program TO "${appRole}"`, restore: `REVOKE pg_execute_server_program FROM "${appRole}"`, refusal: roleRefusal, differences: ["the login is a member of pg_execute_server_program"] },
      { name: "membership of pg_read_server_files", apply: `GRANT pg_read_server_files TO "${appRole}"`, restore: `REVOKE pg_read_server_files FROM "${appRole}"`, refusal: roleRefusal, differences: ["the login is a member of pg_read_server_files"] },
      { name: "membership of pg_read_all_data", apply: `GRANT pg_read_all_data TO "${appRole}"`, restore: `REVOKE pg_read_all_data FROM "${appRole}"`, refusal: roleRefusal, differences: ["the login is a member of pg_read_all_data"] },
      { name: "a view over every lender's records in the runtime schema", apply: `CREATE VIEW "${schema}".valopay_all_records AS SELECT * FROM "${schema}".valopay_records; GRANT SELECT ON "${schema}".valopay_all_records TO "${appRole}"`, restore: `DROP VIEW "${schema}".valopay_all_records`, refusal: grantRefusal, differences: ["valopay_all_records: a view the reviewed set does not have", "valopay_all_records:SELECT: not in the reviewed set"] },
      { name: "a view over every lender's records in another schema", apply: `CREATE VIEW public.${probeView} AS SELECT * FROM "${schema}".valopay_records; GRANT SELECT ON public.${probeView} TO "${appRole}"`, restore: `DROP VIEW public.${probeView}`, refusal: grantRefusal, differences: [`public.${probeView}:SELECT: not in the reviewed set`] },
      { name: "a sequence beside the ten tables", apply: `CREATE SEQUENCE "${schema}".valopay_probe_sequence`, restore: `DROP SEQUENCE "${schema}".valopay_probe_sequence`, refusal: grantRefusal, differences: ["valopay_probe_sequence: a sequence the reviewed set does not have"] },
      { name: "a function beside the reviewed helpers", apply: `CREATE FUNCTION "${schema}".valopay_count_records() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER AS $body$ SELECT count(*) FROM "${schema}".valopay_records $body$`, restore: `DROP FUNCTION "${schema}".valopay_count_records()`, refusal: grantRefusal, differences: ["valopay_count_records(): a function the reviewed set does not have"] },
    ];
    for (const weakening of weakenings) {
      await dba.query(weakening.apply);
      try {
        await assert.rejects(bindFinance, (error: any) => { assert.equal(error.status, 503, weakening.name); assert.match(error.message, weakening.refusal, weakening.name); assert.deepEqual(error.differences, weakening.differences, weakening.name); return true; }, `Refused: ${weakening.name}.`);
        if (weakening === weakenings[0]) {
          await assert.rejects(databaseReadiness, policyRefusal, "Readiness cannot call a weakened database verified.");
          await assert.rejects(() => store.inWorkspace(req, { cookie() {} } as any, ctx => store.listMerchants(ctx), "read"), policyRefusal, "No staff request runs on a weakened database.");
        }
      } finally { await dba.query(weakening.restore); }
      await bindFinance();
    }
  } finally { await dba.query("RESET search_path"); dba.release(); }
  assert.equal((await databaseReadiness()).state, "verified_this_request", "The restored set is verified again.");
  // Readiness reports the check its own transaction recorded, never the configuration:
  // a system transaction records none, so with isolation still set to staging its
  // database check is not configured.
  const { readinessChecks } = await import("../src/routes/access-readiness");
  assert.equal(process.env.VALOPAY_RUNTIME_ISOLATION, "staging");
  const unrecorded = await store.inMerchantAsSystem("lender-a", `${store.SYSTEM_ACTOR_PREFIX}readiness probe`, readinessChecks);
  assert.equal(unrecorded?.checks.find(check => check.id === "database")?.state, "not_configured", "Readiness follows the transaction's own check, not the environment.");
  // The Paystack ingress's read without the lock runs as the service member too, so it finds only what the lock could take.
  assert.deepEqual(await Promise.all([["lender-a", "workspace-a"], ["lender-a", "workspace-b"], ["lender-b", "workspace-b"], ["lender-gone", "workspace-a"]].map(([merchant, workspace]) => store.merchantInWorkspace(merchant!, workspace!))), [true, false, false, false], "A lender is found only in its own workspace, and never outside the service member's organisation.");
  assert.equal(await store.inMerchantAsSystem("lender-b", `${store.SYSTEM_ACTOR_PREFIX}isolation probe`, async () => true), undefined, "The lock cannot take another organisation's lender either.");
  // The daily audit check runs as the service member too: it walks and records its own organisation's lender, once a day, and cannot see another's.
  assert.equal((await store.checkAuditChainDaily("lender-a"))?.valid, true, "The daily audit check walks the service member's lender under the restricted login.");
  assert.equal(typeof (await admin.query(`SELECT settings->>'dailyAuditCheckAt' AS at FROM "${schema}".valopay_merchants WHERE id='lender-a'`)).rows[0].at, "string", "and records that it ran");
  assert.equal(await store.checkAuditChainDaily("lender-a"), undefined, "The day's check runs once.");
  assert.equal(await store.checkAuditChainDaily("lender-b"), undefined, "Another organisation's lender is not found.");
  // Actual acceptance and ON CONFLICT renewal under the restricted LOGIN.
  // Only Clerk's verified-email lookup is replaced; no external call is made.
  const { clerkClient } = await import("@clerk/express"), previousGetUser = clerkClient.users.getUser;
  const inviteeAuth = { ...auth, userId: "user_invitee", sessionClaims: { ...auth.sessionClaims, sub: "user_invitee" } };
  const inviteeRequest = { headers: {}, auth: Object.assign(() => inviteeAuth, { [Symbol.for("@clerk/express.auth")]: true }) } as any;
  let verifiedEmail = "wrong@example.test";
  clerkClient.users.getUser = (async () => ({ id: "user_invitee", emailAddresses: [{ emailAddress: verifiedEmail, verification: { status: "verified" } }] })) as any;
  try {
    await assert.rejects(() => store.acceptStaffInvitation(inviteeRequest, "token-workspace-a"), /organisation|invitation/i, "A verified but different email cannot accept the invitation.");
    verifiedEmail = "workspace-a@example.test";
    // A Finance invitation is accepted only once a second administrator approved it; the restricted login reads that approval.
    await assert.rejects(() => store.acceptStaffInvitation(inviteeRequest, "token-workspace-a"), /waiting for a second Admin’s approval/, "An unapproved Finance invitation cannot be accepted.");
    await admin.query(`INSERT INTO "${schema}".valopay_staff_events(id,workspace_id,actor,action,subject,detail) VALUES('approval-workspace-a','workspace-a','Clerk:user_adminA','staff.invitation_approved','invite-workspace-a','{}')`);
    const accepted = await Promise.allSettled([store.acceptStaffInvitation(inviteeRequest, "token-workspace-a"), store.acceptStaffInvitation(inviteeRequest, "token-workspace-a")]);
    assert.equal(accepted.filter(result => result.status === "fulfilled").length, 1, "Concurrent invitation acceptance commits exactly once.");
    assert.equal(accepted.filter(result => result.status === "rejected").length, 1);
    const firstMembership = (await admin.query(`SELECT id,role,status FROM "${schema}".valopay_staff_memberships WHERE workspace_id='workspace-a' AND user_id='user_invitee'`)).rows[0];
    assert.equal(firstMembership.role, "Finance"); assert.equal(firstMembership.status, "active");
    assert.equal((await admin.query(`SELECT status FROM "${schema}".valopay_staff_invitations WHERE id='invite-workspace-a'`)).rows[0].status, "accepted");
    assert.deepEqual(await store.inWorkspace(inviteeRequest, { cookie() {} } as any, ctx => store.listMerchants(ctx), "read"), [], "Accepting an invitation grants no lenders.");
    await admin.query(`INSERT INTO "${schema}".valopay_staff_invitations(id,workspace_id,email,role,token_hash,invited_by,expires_at) VALUES('invite-renewal','workspace-a','workspace-a@example.test','Read-only',$1,'System',now()+interval '1 day')`, [createHash("sha256").update("token-renewal").digest("hex")]);
    await assert.rejects(() => store.acceptStaffInvitation(inviteeRequest, "token-renewal"), /You are already a team member/, "An active member cannot use renewal to change their own role.");
    // Revoked as the team page records it: the membership's change time moves.
    await admin.query(`UPDATE "${schema}".valopay_staff_memberships SET status='revoked',updated_at=clock_timestamp() WHERE id=$1`, [firstMembership.id]);
    await admin.query(`INSERT INTO "${schema}".valopay_staff_lender_access(membership_id,merchant_id,granted_by) VALUES($1,'lender-a','fixture')`, [firstMembership.id]);
    await assert.rejects(() => store.acceptStaffInvitation(inviteeRequest, "token-renewal"), /sent before your access was suspended or revoked/, "An invitation sent before the revocation cannot restore access.");
    assert.equal((await admin.query(`SELECT status FROM "${schema}".valopay_staff_memberships WHERE id=$1`, [firstMembership.id])).rows[0].status, "revoked");
    await admin.query(`INSERT INTO "${schema}".valopay_staff_invitations(id,workspace_id,email,role,token_hash,invited_by,expires_at) VALUES('invite-renewal-2','workspace-a','workspace-a@example.test','Read-only',$1,'System',now()+interval '1 day')`, [createHash("sha256").update("token-renewal-2").digest("hex")]);
    const renewed = await store.acceptStaffInvitation(inviteeRequest, "token-renewal-2");
    assert.equal(renewed.role, "Read-only");
    const membershipRows = (await admin.query(`SELECT id,role,status FROM "${schema}".valopay_staff_memberships WHERE workspace_id='workspace-a' AND user_id='user_invitee'`)).rows;
    assert.deepEqual(membershipRows, [{ id: firstMembership.id, role: "Read-only", status: "active" }], "Renewal updates the original membership under the invitation policy.");
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM "${schema}".valopay_staff_lender_access WHERE membership_id=$1`, [firstMembership.id])).rows[0].count, 0, "The narrow renewal helper clears the revoked person's old grants.");
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM "${schema}".valopay_staff_events WHERE actor='Clerk:user_invitee' AND action='staff.accepted'`)).rows[0].count, 2, "Acceptance and renewal each preserve an audit event.");
    assert.deepEqual(await store.inWorkspace(inviteeRequest, { cookie() {} } as any, ctx => store.listMerchants(ctx), "read"), []);
    await assert.rejects(() => store.acceptStaffInvitation(inviteeRequest, "token-renewal-2"), /expired|used|revoked|invitation/i, "A consumed renewal token cannot be reused.");
  } finally { clerkClient.users.getUser = previousGetUser; }
  const result = await store.inWorkspace(req, { cookie() {} } as any, async ctx => ({ lenders: await store.listMerchants(ctx), state: await store.loadState(ctx, "lender-a", "share") }), "read");
  assert.deepEqual(result.lenders.map(lender => lender.id), ["lender-a"]); assert.equal(result.state.records[0]?.name, "Synthetic customer");
  const readerAuth = { ...auth, userId: "user_readerA", sessionClaims: { ...auth.sessionClaims, sub: "user_readerA" } };
  const readerRequest = { headers: {}, auth: Object.assign(() => readerAuth, { [Symbol.for("@clerk/express.auth")]: true }) } as any;
  const readerState = await store.inWorkspace(readerRequest, { cookie() {} } as any, ctx => store.loadState(ctx, "lender-a", "share"), "read");
  assert.equal(readerState.records[0]?.name, "Synthetic customer", "Restricted Read-only users can still inspect a consistent lender snapshot.");
  // A read here is REPEATABLE READ, with its snapshot taken before it waits for
  // the workspace lock. One that queued behind a team change to its own
  // membership is told its access changed; it is not answered from the older
  // snapshot, and the retry sees the change.
  {
    const adminAuth = { ...auth, userId: "user_adminA", sessionClaims: { ...auth.sessionClaims, sub: "user_adminA" } };
    const adminRequest = { headers: {}, auth: Object.assign(() => adminAuth, { [Symbol.for("@clerk/express.auth")]: true }) } as any;
    const waiting = async (count: number) => { for (let tries = 0; tries < 100; tries++) { if ((await admin.query("SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())")).rows[0].count === count) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error(`${count} requests never queued for the workspace lock`); };
    let releaseHeld!: () => void, heldIn!: () => void;
    const hold = new Promise<void>(resolve => { releaseHeld = resolve; }), entered = new Promise<void>(resolve => { heldIn = resolve; });
    const held = store.inWorkspace(readerRequest, { cookie() {} } as any, async () => { heldIn(); await hold; }, "read");
    await entered;
    const version = (await admin.query(`SELECT updated_at FROM "${schema}".valopay_staff_memberships WHERE id='finance-a'`)).rows[0].updated_at as Date;
    const change = store.inWorkspace(adminRequest, { cookie() {} } as any, ctx => store.updateStaff(ctx, "finance-a", { role: "Finance", status: "active", expectedUpdatedAt: version.toISOString(), reason: "Re-confirm the Finance membership for the rehearsal." }), "team");
    await waiting(1);
    const late = store.inWorkspace(req, { cookie() {} } as any, ctx => store.listMerchants(ctx), "read").then(() => undefined, (error: unknown) => error);
    await waiting(2);
    releaseHeld(); await held; await change;
    const refused = await late as { status?: number; message?: string } | undefined;
    assert.equal(refused?.status, 409, "A request whose membership changed while it waited is refused, not answered from its older snapshot.");
    assert.match(String(refused?.message), /access changed while this request was waiting/);
    assert.deepEqual((await store.inWorkspace(req, { cookie() {} } as any, ctx => store.listMerchants(ctx), "read")).map(lender => lender.id), ["lender-a"], "The retry reads the current membership.");
  }
  await assert.rejects(() => store.inWorkspace(req, { cookie() {} } as any, ctx => store.loadState(ctx, "lender-a-private", "share"), "read"), /not found/);
  // Pilot scale: a lender with 13,000 records loads through the policies in one
  // pass. The visible lenders are a hashed set built once per statement, never a
  // helper call per row (which took about ten seconds for this lender).
  await admin.query(`INSERT INTO "${schema}".valopay_records(id,merchant_id,kind,name,status,data) SELECT 'scale-'||g,'lender-a','customers','Synthetic customer '||g,'active','{"synthetic":true}' FROM generate_series(1,13000) g`);
  await admin.query(`ANALYZE "${schema}".valopay_records`);
  const scale = await pool.connect();
  try {
    await scale.query("BEGIN"); await isolation.bindRuntimeIdentity(scale, { organizationId: "org_runtimeA", userId: "user_financeA" });
    const plan = (await scale.query("EXPLAIN (COSTS OFF) SELECT * FROM valopay_records WHERE merchant_id='lender-a'")).rows.map(row => row["QUERY PLAN"]).join("\n");
    assert.match(plan, /hashed SubPlan/, `The lender policy is a hashed set, not a per-row helper call:\n${plan}`);
    assert.doesNotMatch(plan, /valopay_runtime_lender\(/, "No per-row lender helper remains in the records plan.");
    const started = performance.now();
    assert.equal((await scale.query("SELECT id FROM valopay_records WHERE merchant_id='lender-a'")).rowCount, 13001);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 3000, `A pilot-scale lender loads in ${Math.round(elapsed)} ms under row security.`);
    assert.equal((await scale.query("SELECT count(*)::int AS count FROM valopay_records WHERE merchant_id='lender-b'")).rows[0].count, 0, "Another workspace's lender stays invisible.");
    await scale.query("ROLLBACK");
  } finally { scale.release(); }
  const loaded = await store.inWorkspace(req, { cookie() {} } as any, ctx => store.loadState(ctx, "lender-a", "share"), "read");
  assert.equal(loaded.records.length, 13001, "The repository loads the whole pilot-scale lender under the restricted login.");
  await admin.query(`DELETE FROM "${schema}".valopay_staff_lender_access WHERE membership_id='finance-a'`);
  await assert.rejects(() => store.inWorkspace(req, { cookie() {} } as any, ctx => store.loadState(ctx, "lender-a", "share"), "read"), /not found/);
  const elevated = await admin.connect(); try { await elevated.query("BEGIN"); await assert.rejects(() => isolation.bindRuntimeIdentity(elevated, { organizationId: "org_runtimeA", userId: "user_adminA" }), /elevated/); await elevated.query("ROLLBACK"); } finally { elevated.release(); }
  const configured = process.env.VALOPAY_RUNTIME_SCHEMA; process.env.VALOPAY_RUNTIME_SCHEMA = "public"; assert.throws(() => isolation.runtimeIsolationConfiguration(), /public/); process.env.VALOPAY_RUNTIME_SCHEMA = configured;
  // /api/readyz reads the isolated schema, as the restricted login: its copied tables carry every column and, under generated names, every index this build needs.
  const ready = await store.pingDatabase();
  assert.deepEqual([ready.status, ready.schema], ["ok", { status: "ok", missing: [] }], "readiness checks the isolated runtime schema");
  // Tables copied while the application schema still held the provider event guard 009 replaces hold a copy of it under
  // a generated name, which 009 run before the review fixes of 26 September 2026 left. Readiness, as the restricted
  // login, names it and the schema to run 009 in; 009 run again there, as the migration owner, drops it.
  const leftover = "valopay_records_merchant_id_expr_expr1_idx";
  await admin.query(`CREATE UNIQUE INDEX ${leftover} ON "${schema}".valopay_records (merchant_id, (data->>'source'), (data->>'eventId')) WHERE kind = 'observations' AND data->>'eventId' IS NOT NULL`);
  const superseded = await store.pingDatabase();
  assert.deepEqual([superseded.status, superseded.schema], ["ok", { status: "incomplete", missing: [`superseded unique index ${leftover}: the earlier provider event guard, which refuses one event ID from two providers; apply lib/db/migrations/009_record_identity_guards.sql with ${schema} first on the search path`] }], "readiness names the earlier event guard left in the runtime schema");
  const identityMigration = await readFile(new URL("../../../lib/db/migrations/009_record_identity_guards.sql", import.meta.url), "utf8");
  const migrationOwner = await admin.connect();
  try { await migrationOwner.query(`SET search_path TO "${schema}"`); await migrationOwner.query(identityMigration); } finally { await migrationOwner.query("RESET search_path"); migrationOwner.release(); }
  assert.deepEqual((await store.pingDatabase()).schema, { status: "ok", missing: [] }, "009 run again in the runtime schema drops the earlier guard");
  await store.closeDatabase(); runtimePool = undefined;
  assert.deepEqual(await publicFlags(), publicBefore, "The rehearsal leaves the application's own tables as they were.");
  console.log("Runtime isolation passed: migrations refused without opt-in or in the application's schema, actual restricted login, ten forced-RLS tables, the reviewed policies, helpers, workspace guard, role attributes, memberships, privileges and schema objects compared by definition (twenty-two weakenings refused), readiness from the transaction's own check and of the isolated schema, an earlier event guard left there named by readiness and dropped by 009 run again, once-per-statement lender scope at pilot scale, pooled-scope reset, no rows or writes without a full scope, own-lender writes and rollback, cross-lender, identity-column, delete and row-security changes refused, mixed-tenant denial, per-lender grants, concurrent invitation acceptance and renewal, a read queued behind a change to its own membership refused with a 409, service requester checks, the daily audit check as the service member, and real repository/MFA integration.");
} finally {
  if (runtimePool) await runtimePool.end();
  if (!/^valopay_runtime_test_[a-f0-9]+$/.test(schema) || !/^runtime_(app|helper)_[a-f0-9]+$/.test(appRole) || !/^runtime_(app|helper)_[a-f0-9]+$/.test(helperRole)) throw new Error("Unsafe generated test cleanup target.");
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  for (const role of [appRole, helperRole]) if ((await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rowCount) { await admin.query(`DROP OWNED BY "${role}"`); await admin.query(`DROP ROLE "${role}"`); }
  await admin.end();
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
}
