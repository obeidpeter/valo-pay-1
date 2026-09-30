import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

if (process.env.VALOPAY_RUN_INTEGRATION !== "1") {
  console.log("Set VALOPAY_RUN_INTEGRATION=1 to run repository integration tests.");
  process.exit(0);
}

const { pool } = await import("@workspace/db");
const { getAuth } = await import("@clerk/express");
const { inWorkspace, listMerchants, loadState, loadSettingsView, getCloseDetail, saveState, findIdempotency, saveIdempotency, changeRole, appendAudit, settleChanges, addedRecords, closeDatabase, prepareOperation, digest, inMerchantAsSystem, SYSTEM_ACTOR_PREFIX, pingDatabase, integrityGuards, sweepExpiredWorkspaces } = await import("../src/lib/valopay-store.js");
const { exportJobRepository } = await import("../src/lib/export-job-store.js");
const { overrideDatabaseLimits } = await import("../src/lib/database-limits.js");

const requestFor = (token: string) => {
  // Verify this is the real Clerk request shape used by principalFor rather
  // than relying on an unbranded look-alike auth function.
  const auth = Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true });
  assert.equal(getAuth({ auth } as any).userId, null);
  return { headers: { cookie: `valopay_sandbox=${token}` }, secure: false, auth } as any;
};
const response = () => ({ cookie() { /* a valid test cookie is already supplied */ } }) as any;
const token = () => randomBytes(32).toString("hex");
/** Runs `work` and returns the text and values of the first statement the store sent that matches `pattern`. */
async function statementOf(pattern: RegExp, work: () => Promise<unknown>) {
  const holder = await pool.connect(), clients = Object.getPrototypeOf(holder) as { query: (this: unknown, ...args: unknown[]) => unknown };
  holder.release();
  const query = clients.query;
  let found: { text: string; values: unknown[] } | undefined;
  clients.query = function (this: unknown, ...args: unknown[]) {
    if (!found && typeof args[0] === "string" && pattern.test(args[0])) found = { text: args[0], values: Array.isArray(args[1]) ? args[1] : [] };
    return query.apply(this, args);
  };
  try { await work(); } finally { clients.query = query; }
  assert.ok(found, `the store sent a statement matching ${pattern}`);
  return found!;
}
/** The indexes PostgreSQL would read to run a statement with its own values. */
async function indexesRead(statement: { text: string; values: unknown[] }) {
  const plan = (await pool.query(`EXPLAIN (FORMAT JSON) ${statement.text}`, statement.values)).rows[0]["QUERY PLAN"][0].Plan;
  const names = new Set<string>(), walk = (node: any) => { if (node["Index Name"]) names.add(node["Index Name"]); for (const child of node.Plans ?? []) walk(child); };
  walk(plan);
  return names;
}
/** The kinds of step (Index Scan, Sort, ...) PostgreSQL would take to run a statement with its own values. */
async function nodesRun(statement: { text: string; values: unknown[] }) {
  const plan = (await pool.query(`EXPLAIN (FORMAT JSON) ${statement.text}`, statement.values)).rows[0]["QUERY PLAN"][0].Plan;
  const kinds = new Set<string>(), walk = (node: any) => { kinds.add(node["Node Type"]); for (const child of node.Plans ?? []) walk(child); };
  walk(plan);
  return kinds;
}

try {
  const role = await pool.query("SELECT 1 FROM pg_roles WHERE rolname='valopay_runtime'");
  assert.equal(role.rowCount, 0, "legacy runtime role must be absent");
  const policies = await pool.query(
    "SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename=ANY($1::text[])",
    [["valopay_workspaces", "valopay_merchants", "valopay_records", "valopay_idempotency"]],
  );
  assert.equal(policies.rowCount, 0, "legacy Valo Pay RLS policies must be absent");
  const triggers = await pool.query(
    `SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
     WHERE c.relname='valopay_records' AND NOT t.tgisinternal`,
  );
  assert.equal(triggers.rowCount, 0, "legacy record protection trigger must be absent");
  const functions = await pool.query("SELECT 1 FROM pg_proc WHERE proname='valopay_protect_records'");
  assert.equal(functions.rowCount, 0, "legacy record protection function must be absent");

  const bootstrapPrincipal = token();
  const bootstrapResults = await Promise.all(Array.from({ length: 4 }, () =>
    inWorkspace(requestFor(bootstrapPrincipal), response(), async (context) =>
      (await listMerchants(context)).map((merchant) => merchant.id).sort(),
    ),
  ));
  assert.equal(bootstrapResults[0]!.length, 2);
  for (const result of bootstrapResults) assert.deepEqual(result, bootstrapResults[0], "Concurrent bootstrap must create only one workspace and its two lenders.");
  const legacyRequest = requestFor(bootstrapPrincipal);
  legacyRequest.headers.cookie = `valo_sandbox=${bootstrapPrincipal}`;
  await inWorkspace(legacyRequest, response(), async (context) => {
    const fresh = (await listMerchants(context)).map((merchant) => merchant.id).sort();
    assert.equal(fresh.length, 2);
    assert.notDeepEqual(fresh, bootstrapResults[0], "A legacy cookie cannot select an existing anonymous workspace.");
  });

  const principalA = token();
  let merchantA = "";
  let originalCustomerName = "";
  let retainedContext: any;
  // Bootstrap must commit separately; otherwise rollback correctly removes the
  // entire fresh workspace, including the IDs the next assertion would load.
  await inWorkspace(requestFor(principalA), response(), async (context) => {
    merchantA = (await listMerchants(context))[0]!.id;
  });
  await assert.rejects(
    () => inWorkspace(requestFor(principalA), response(), async (context) => {
      retainedContext = context;
      assert.equal("db" in context, false, "routes never receive a database client");
      merchantA = (await listMerchants(context))[0]!.id;
      const state = await loadState(context, merchantA);
      const customer = state.records.find((record) => record.kind === "customers")!;
      originalCustomerName = customer.name;
      customer.name = `rollback-${randomUUID()}`;
      await changeRole(context, "Finance");
      await saveState(context, state);
      throw new Error("intentional repository rollback");
    }, "persona"),
    /intentional repository rollback/,
  );

  await assert.rejects(() => listMerchants(retainedContext), (error: any) => error?.status === 409);
  await inWorkspace(requestFor(principalA), response(), async (context) => {
    assert.equal(context.role, "Admin", "role update must be rolled back with the record write");
    const state = await loadState(context, merchantA);
    assert.equal(state.records.find((record) => record.kind === "customers")!.name, originalCustomerName);
    state.records.pop();
    await assert.rejects(() => saveState(context, state), (error: any) => error?.status === 409);
  });

  const principalB = token();
  let merchantB = "";
  const idempotencyId = `integration-${randomUUID()}`;
  await inWorkspace(requestFor(principalB), response(), async (context) => {
    merchantB = (await listMerchants(context))[0]!.id;
    await loadState(context, merchantB);
    await saveIdempotency(context, idempotencyId, "original-request", { response: "original" });
  });
  await assert.rejects(
    () => inWorkspace(requestFor(principalB), response(), async (context) => {
      await loadState(context, merchantB);
      assert.deepEqual(await findIdempotency(context, idempotencyId), { request_hash: "original-request", response: { response: "original" } });
      // saveIdempotency maps the SQL duplicate to 409.  Swallowing it must not
      // turn the already-aborted PostgreSQL transaction into an apparent commit.
      await assert.rejects(
        () => saveIdempotency(context, idempotencyId, "different-request", { response: "rewritten" }),
        (error: any) => error?.status === 409,
      );
    }),
    /workspace transaction was rolled back/,
  );
  await inWorkspace(requestFor(principalB), response(), async (context) => {
    await loadState(context, merchantB);
    assert.deepEqual(await findIdempotency(context, idempotencyId), { request_hash: "original-request", response: { response: "original" } });
  });

  const principalC = token();
  await inWorkspace(requestFor(principalC), response(), async (context) => {
    await assert.rejects(() => loadState(context, merchantA), (error: any) => error?.status === 404);
    await assert.rejects(() => listMerchants({ ...context } as typeof context), (error: any) => error?.status === 409);
  });

  // Expiry: an anonymous sandbox older than the cookie lifetime with no change in that time is swept by the next bootstrap.
  const staleToken = token();
  let staleMerchant = "";
  await inWorkspace(requestFor(staleToken), response(), async (context) => { staleMerchant = (await listMerchants(context))[0]!.id; });
  const staleWorkspace = (await pool.query<{ workspace_id: string }>("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [staleMerchant])).rows[0]!.workspace_id;
  await pool.query("UPDATE valopay_workspaces SET created_at = now() - interval '40 days' WHERE id=$1", [staleWorkspace]);
  await pool.query("UPDATE valopay_records SET created_at = created_at - interval '40 days', updated_at = updated_at - interval '40 days' WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)", [staleWorkspace]);
  // Cleanup is opt-in (VALOPAY_EXPIRED_WORKSPACE_CLEANUP=on): by default a new bootstrap leaves the expired sandbox alone.
  await inWorkspace(requestFor(token()), response(), async (context) => { await listMerchants(context); });
  assert.equal((await pool.query("SELECT 1 FROM valopay_workspaces WHERE id=$1", [staleWorkspace])).rowCount, 1, "with cleanup off, the default, the expired sandbox is kept");
  process.env.VALOPAY_EXPIRED_WORKSPACE_CLEANUP = "on";
  {
    // A sweep that cannot finish (here, a record of the expired sandbox is locked elsewhere past the lock limit) rolls back to its savepoint: the visitor is still seeded.
    const restore = overrideDatabaseLimits({ request: { lockMs: 300 } });
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM valopay_records WHERE merchant_id=$1 LIMIT 1 FOR UPDATE", [staleMerchant]);
      const seeded = await inWorkspace(requestFor(token()), response(), listMerchants);
      assert.equal(seeded.length, 2, "a stuck sweep never fails a new visitor's bootstrap");
      assert.equal((await pool.query("SELECT 1 FROM valopay_workspaces WHERE id=$1", [staleWorkspace])).rowCount, 1, "the expired sandbox is left whole for a later sweep");
      assert.equal((await pool.query("SELECT 1 FROM valopay_merchants WHERE workspace_id=$1", [staleWorkspace])).rowCount, 2, "with both its lenders");
    } finally { await holder.query("ROLLBACK"); holder.release(); restore(); }
  }
  await inWorkspace(requestFor(token()), response(), async (context) => { await listMerchants(context); });
  assert.equal((await pool.query("SELECT 1 FROM valopay_workspaces WHERE id=$1", [staleWorkspace])).rowCount, 0, "with cleanup on, the expired anonymous sandbox is removed");
  assert.equal((await pool.query("SELECT 1 FROM valopay_merchants WHERE workspace_id=$1", [staleWorkspace])).rowCount, 0, "with its lenders and records");
  assert.equal((await pool.query("SELECT 1 FROM valopay_workspaces WHERE id=(SELECT workspace_id FROM valopay_merchants WHERE id=$1)", [merchantA])).rowCount, 1, "a live sandbox stays");
  // A sandbox that is old but recently changed by a person stays; activity is read from the audit chain, and the seed's own system entry does not count.
  const activeToken = token();
  let activeMerchant = "";
  await inWorkspace(requestFor(activeToken), response(), async (context) => { activeMerchant = (await listMerchants(context))[0]!.id; });
  const activeWorkspace = (await pool.query<{ workspace_id: string }>("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [activeMerchant])).rows[0]!.workspace_id;
  await pool.query("UPDATE valopay_workspaces SET created_at = now() - interval '40 days' WHERE id=$1", [activeWorkspace]);
  await pool.query("UPDATE valopay_records SET created_at = created_at - interval '40 days', updated_at = updated_at - interval '40 days' WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)", [activeWorkspace]);
  await inWorkspace(requestFor(activeToken), response(), async (context) => {
    const state = await loadState(context, activeMerchant);
    appendAudit(state, context, "patch.settings", "workspace", "A person changed a setting");
    await saveState(context, state);
  });
  await inWorkspace(requestFor(token()), response(), async (context) => { await listMerchants(context); });
  assert.equal((await pool.query("SELECT 1 FROM valopay_workspaces WHERE id=$1", [activeWorkspace])).rowCount, 1, "a recent change by a person keeps an old sandbox alive");
  {
    // The sweep and a scheduled close of the same expired sandbox. A close holds its lender's row from the start and
    // writes the lender's records at the end. The sweep used to delete the sandbox's records first and then wait for
    // that lender's row, so the close, saving, waited for a record the sweep had deleted: a deadlock, which PostgreSQL
    // broke after a second by failing one of the two. The sweep now locks a sandbox's lenders first, in order and
    // without waiting, and leaves a sandbox with a lender held elsewhere whole for a later sweep.
    const heldToken = token();
    const heldLender = (await inWorkspace(requestFor(heldToken), response(), listMerchants)).map((merchant) => merchant.id).sort()[0]!;
    const heldWorkspace = (await pool.query<{ workspace_id: string }>("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [heldLender])).rows[0]!.workspace_id;
    // Older than every other expired sandbox a reused database may hold, so this sweep reaches it first.
    await pool.query("UPDATE valopay_workspaces SET created_at = now() - interval '400 days' WHERE id=$1", [heldWorkspace]);
    await pool.query("UPDATE valopay_records SET created_at = created_at - interval '400 days', updated_at = updated_at - interval '400 days' WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)", [heldWorkspace]);
    let holding!: () => void, release!: () => void;
    const held = new Promise<void>((resolve) => { holding = resolve; }), released = new Promise<void>((resolve) => { release = resolve; });
    const close = inMerchantAsSystem(heldLender, `${SYSTEM_ACTOR_PREFIX}scheduled close`, async (context) => {
      const state = await loadState(context, heldLender);
      holding(); await released;
      const customer = state.records.find((record) => record.kind === "customers")!;
      customer.name = `${customer.name} (closed)`;
      appendAudit(state, context, "daily_close", customer.id, "Synthetic close while the sweep runs", settleChanges(context, state));
      await saveState(context, state);
      return customer.id;
    });
    await held;
    // A sandbox left for later is undone at once: while the sweeping transaction is still open, its free lender and
    // its row can be taken by anyone else, so they are not held for the rest of a stranger's request.
    {
      const otherLender = (await pool.query<{ id: string }>("SELECT id FROM valopay_merchants WHERE workspace_id=$1 AND id<>$2", [heldWorkspace, heldLender])).rows[0]!.id;
      const sweeper = await pool.connect(), probe = await pool.connect();
      try {
        await sweeper.query("BEGIN");
        await sweepExpiredWorkspaces(sweeper, 50);
        await probe.query("BEGIN");
        await probe.query("SELECT 1 FROM valopay_merchants WHERE id=$1 FOR UPDATE NOWAIT", [otherLender]);
        await probe.query("SELECT 1 FROM valopay_workspaces WHERE id=$1 FOR UPDATE NOWAIT", [heldWorkspace]);
        await probe.query("ROLLBACK");
        assert.equal((await sweeper.query("SELECT 1 FROM valopay_workspaces WHERE id=$1", [heldWorkspace])).rowCount, 1, "the busy sandbox is still there inside the sweep's own transaction");
      } catch (error) {
        release(); // let the close finish, so the failure is reported rather than left waiting
        throw error;
      } finally {
        await sweeper.query("ROLLBACK"); await probe.query("ROLLBACK").catch(() => undefined);
        sweeper.release(); probe.release();
      }
    }
    const warnings: Array<{ event?: string }> = [];
    const visitor = inWorkspace({ ...requestFor(token()), log: { warn: (fields: { event?: string }) => warnings.push(fields) } }, response(), listMerchants);
    const sweepWaits = async () => {
      for (let waited = 0; waited < 5_000; waited += 25) {
        if ((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'DELETE FROM valopay_%'")).rowCount) return "sweep waited";
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return "timed out";
    };
    const first = await Promise.race([visitor.then(() => "sweep finished", () => "visitor failed"), sweepWaits()]);
    release();
    const [closed, seeded] = await Promise.allSettled([close, visitor]);
    assert.equal(first, "sweep finished", "the sweep never waits for a lender a close holds");
    assert.equal(closed.status, "fulfilled", `the close saves: ${closed.status === "rejected" ? String(closed.reason?.message) : ""}`);
    assert.equal(seeded.status === "fulfilled" && seeded.value.length, 2, "and the visitor is seeded");
    assert.deepEqual(warnings.map((fields) => fields.event), [], "without a failed sweep");
    assert.equal((await pool.query("SELECT 1 FROM valopay_merchants WHERE workspace_id=$1", [heldWorkspace])).rowCount, 2, "the sandbox with a busy lender is left whole");
    // Once the close has finished, the next sweep removes the sandbox; the close's own entry is not activity.
    await inWorkspace(requestFor(token()), response(), listMerchants);
    assert.equal((await pool.query("SELECT 1 FROM valopay_workspaces WHERE id=$1", [heldWorkspace])).rowCount, 0, "a later sweep removes it");
    assert.equal((await pool.query("SELECT 1 FROM valopay_records WHERE merchant_id=$1", [heldLender])).rowCount, 0, "with the close's records");
  }
  // A save touches only what the request changed. Earlier closes load as
  // summaries for writes, stay whole in PostgreSQL and in reads, and a save
  // cannot change them.
  const savesToken = token();
  let savesMerchant = "";
  await inWorkspace(requestFor(savesToken), response(), async (context) => { savesMerchant = (await listMerchants(context))[0]!.id; });
  const report = { unallocated: { count: 1, kobo: 5, olderThan24Hours: 0 }, exceptions: { openAtClose: 2, overdueAtClose: 1 }, customerPositionsChanged: Array.from({ length: 200 }, (_, index) => ({ customerId: `c${index}`, note: "x".repeat(200) })) };
  for (const [id, days] of [["close-old", 30], ["close-recent", 2], ["close-latest", 0]] as const) {
    await pool.query("INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data,created_at,updated_at) VALUES($1,$2,'closes',$1,'completed','',0,'',$3,now()-make_interval(days=>$4),now()-make_interval(days=>$4))",
      [`${savesMerchant}-${id}`, savesMerchant, { summary: id, closedAt: new Date(Date.now() - days * 86400000).toISOString(), report, operational: { rows: 1 }, metrics: [{ key: "m" }], synthetic: true }, days]);
  }
  const stamps = async () => new Map((await pool.query<{ id: string; updated_at: Date }>("SELECT id,updated_at FROM valopay_records WHERE merchant_id=$1", [savesMerchant])).rows.map((row) => [row.id, row.updated_at.toISOString()]));
  const beforeSave = await stamps();
  await inWorkspace(requestFor(savesToken), response(), async (context) => {
    const state = await loadState(context, savesMerchant);
    const old = state.records.find((record) => record.id === `${savesMerchant}-close-old`)!;
    assert.deepEqual(Object.keys(old.data).sort(), ["closedAt", "report", "summary", "synthetic"], "an earlier close loads for a write as its summary");
    assert.deepEqual(old.data.report, { unallocated: report.unallocated, exceptions: report.exceptions }, "with the totals the domain reads");
    assert.equal(state.records.find((record) => record.id === `${savesMerchant}-close-recent`)!.data.operational?.rows, 1, "recent closes, and so the latest, stay whole");
    const customer = state.records.find((record) => record.kind === "customers")!;
    customer.name = `${customer.name} (renamed)`;
    const added = { ...structuredClone(customer), id: randomUUID(), reference: `SAVE-${randomUUID()}`, name: "Added in this save", createdAt: context.now, updatedAt: context.now };
    state.records.push(added);
    assert.deepEqual(addedRecords(context, state).map((record) => record.id), [added.id]);
    const changes = settleChanges(context, state);
    assert.equal(changes.changedRecords, 2, "the audit digests cover the renamed and the added customer only");
    assert.ok(customer.updatedAt > beforeSave.get(customer.id)!, "the changed record gets a newer version before the response is built");
    appendAudit(state, context, "patch.records.customers", customer.id, "Renamed in the save test", changes);
    await saveState(context, state);
  });
  const afterSave = await stamps();
  const rewritten = [...beforeSave].filter(([id, at]) => afterSave.get(id) !== at).map(([id]) => id);
  assert.equal(rewritten.length, 1, "only the renamed record was rewritten; the rest of the lender was left alone");
  assert.equal(afterSave.size, beforeSave.size + 2, "the added customer and the audit entry were inserted");
  const stored = (await pool.query("SELECT data FROM valopay_records WHERE id=$1", [`${savesMerchant}-close-old`])).rows[0].data;
  assert.equal(stored.report.customerPositionsChanged.length, 200, "the earlier close keeps its full report in PostgreSQL");
  assert.equal(stored.operational.rows, 1);
  // A read loads earlier closes as summaries too (audit item 32): a view that shows the newest closes asks for them
  // whole, settings read only the latest close, and the close history opens any close whole.
  await inWorkspace(requestFor(savesToken), response(), async (context) => {
    const read = await loadState(context, savesMerchant, "share");
    assert.deepEqual(Object.keys(read.records.find((record) => record.id === `${savesMerchant}-close-old`)!.data).sort(), ["closedAt", "report", "summary", "synthetic"], "a read loads an earlier close as its summary");
    assert.equal(read.records.find((record) => record.id === `${savesMerchant}-close-recent`)!.data.operational?.rows, 1, "and the latest week's closes whole");
    assert.equal(read.records.some((record) => record.kind === "audit"), false, "and never the audit chain");
    assert.equal((await getCloseDetail(context, savesMerchant, `${savesMerchant}-close-old`)).data.report.customerPositionsChanged.length, 200, "the close history opens an earlier close whole");
    const settings = await loadSettingsView(context, savesMerchant);
    assert.deepEqual(settings.records.filter((record) => record.kind === "closes").map((record) => [record.id, record.data.operational]), [[`${savesMerchant}-close-latest`, undefined]], "settings read only the latest close, as its summary");
  }, "read");
  await inWorkspace(requestFor(savesToken), response(), async (context) => {
    const newest = await loadState(context, savesMerchant, "share", { wholeCloses: 3 });
    assert.equal(newest.records.find((record) => record.id === `${savesMerchant}-close-old`)!.data.report.customerPositionsChanged.length, 200, "a view that shows the newest closes loads them whole");
  }, "read");
  await assert.rejects(() => inWorkspace(requestFor(savesToken), response(), async (context) => {
    const state = await loadState(context, savesMerchant);
    state.records.find((record) => record.id === `${savesMerchant}-close-old`)!.data.summary = "rewritten";
    await saveState(context, state);
  }), /Saved evidence cannot be changed/, "a summarised close can never be written back over its full report");
  assert.equal((await pool.query("SELECT data->>'summary' AS summary FROM valopay_records WHERE id=$1", [`${savesMerchant}-close-old`])).rows[0].summary, "close-old");
  // A save writes a run of changed or added records in one statement, 500 at most (audit of 23 September, item 33):
  // a month-end close changes thousands of records, each of which used to be a statement of its own.
  {
    let writes = 0;
    const holder = await pool.connect(), clients = Object.getPrototypeOf(holder) as { query: (this: unknown, ...args: unknown[]) => unknown };
    holder.release();
    const query = clients.query;
    clients.query = function (this: unknown, ...args: unknown[]) {
      if (typeof args[0] === "string" && /^\s*(UPDATE|INSERT INTO) valopay_records\b/.test(args[0])) writes += 1;
      return query.apply(this, args);
    };
    try {
      await inWorkspace(requestFor(savesToken), response(), async (context) => {
        const state = await loadState(context, savesMerchant);
        const customers = state.records.filter((record) => record.kind === "customers");
        for (const customer of customers) customer.data = { ...customer.data, batchedNote: "Changed with 1,200 others" };
        for (let index = 0; index < 1_200; index++) state.records.push({ id: randomUUID(), merchantId: savesMerchant, kind: "notifications", name: `Batched notice ${index}`, status: "submitted", reference: "", amountKobo: 0, customerId: "", createdAt: context.now, updatedAt: context.now, data: { synthetic: true } });
        appendAudit(state, context, "batch.fixture", "workspace", "Many records in one save", settleChanges(context, state));
        await saveState(context, state);
        assert.equal(writes, 1 + 3, `${customers.length} changed records in one statement, and 1,201 added ones in three (${writes})`);
      });
    } finally { clients.query = query; }
    assert.equal(Number((await pool.query("SELECT count(*) FROM valopay_records WHERE merchant_id=$1 AND kind='notifications' AND name LIKE 'Batched notice %'", [savesMerchant])).rows[0].count), 1_200, "every added record was written");
    assert.equal(Number((await pool.query("SELECT count(*) FROM valopay_records WHERE merchant_id=$1 AND kind='customers' AND data->>'batchedNote' IS NOT NULL", [savesMerchant])).rows[0].count) > 0, true, "and every changed one");
  }
  // The pending-request limit counts a person's pending journal entries, and a workspace's lenders are read by
  // workspace; each has its own index (lib/db/migrations/007_journal_and_lender_indexes.sql). Without them the count
  // read every entry the person had ever made, and the lender lookups every lender. The store's own statements are
  // captured as they run and explained with their own values, on a journal and a lender table big enough to choose.
  {
    const indexToken = token(), filler = `index-filler-${randomUUID()}`;
    const indexLender = (await inWorkspace(requestFor(indexToken), response(), listMerchants))[0]!.id;
    try {
      await pool.query(`INSERT INTO valopay_operations(id,merchant_id,owner,actor,role,request_key,request_hash,request,label,status)
        SELECT $3||'-'||i,$1,$2,'Sandbox Admin','Admin',$3||'-key-'||i,'hash','{}','Save records customers',CASE WHEN i<=3 THEN 'pending' ELSE 'completed' END FROM generate_series(1,20000) i`, [indexLender, digest(`demo:${indexToken}`), filler]);
      await pool.query("INSERT INTO valopay_workspaces(id,principal_hash,role) SELECT $1||'-'||i,$1||'-principal-'||i,'Admin' FROM generate_series(1,3000) i", [filler]);
      await pool.query(`INSERT INTO valopay_merchants(id,workspace_id,info,settings) SELECT $1||'-lender-'||i,$1||'-'||(i%3000+1),'{}','{"scheduledCloseEnabled":false}' FROM generate_series(1,6000) i`, [filler]);
      await pool.query("ANALYZE valopay_operations"); await pool.query("ANALYZE valopay_merchants");
      const pending = await statementOf(/^SELECT count\(\*\) FROM valopay_operations WHERE merchant_id=\$1 AND owner=\$2 AND status='pending'/, () =>
        inWorkspace(requestFor(indexToken), response(), (context) => prepareOperation(context, indexLender, randomUUID(), { method: "POST", path: "/v1/records/customers", body: { name: "Index check" } })));
      assert.deepEqual([...await indexesRead(pending)], ["valopay_operations_pending"], "the pending-request limit reads only pending entries");
      const lenders = await statementOf(/^SELECT m\.info FROM valopay_merchants m/, () => inWorkspace(requestFor(indexToken), response(), listMerchants, "read"));
      assert.ok((await indexesRead(lenders)).has("valopay_merchants_workspace"), "a workspace's lenders are read through the workspace index");
      // The export worker looks for queued exports, and running ones whose lease has run out, across every lender, oldest
      // first, every few seconds. Its partial index (lib/db/migrations/008_export_queue_index_and_foreign_key_names.sql)
      // holds only those jobs, in that order, so the look-up reads a few entries, with no sort, instead of every record.
      await pool.query(`INSERT INTO valopay_records(id,merchant_id,kind,name,status,data)
        SELECT $2||'-record-'||i,$1,CASE WHEN i%50=0 THEN 'exports' ELSE 'notifications' END,'Index filler',CASE WHEN i%50=0 THEN 'ready' ELSE 'sent' END,'{}' FROM generate_series(1,20000) i`, [indexLender, filler]);
      await pool.query("ANALYZE valopay_records");
      const queue = await statementOf(/^SELECT merchant_id AS "merchantId",id,to_char/, () => exportJobRepository.candidates(2));
      assert.deepEqual([...await indexesRead(queue)], ["valopay_records_export_queue"], "the export worker's look-up reads only its queue index");
      assert.ok(!(await nodesRun(queue)).has("Sort"), "which gives the jobs in the order the worker takes them, with no sort");
    } finally {
      await pool.query("DELETE FROM valopay_records WHERE merchant_id=$1 AND id LIKE $2", [indexLender, `${filler}-record-%`]);
      await pool.query("ANALYZE valopay_records");
      await pool.query("DELETE FROM valopay_operations WHERE merchant_id=$1 AND (id LIKE $2 OR label='Save records customers')", [indexLender, `${filler}-%`]);
      await pool.query("DELETE FROM valopay_merchants WHERE id LIKE $1", [`${filler}-lender-%`]);
      await pool.query("DELETE FROM valopay_workspaces WHERE id LIKE $1", [`${filler}-%`]);
      await pool.query("ANALYZE valopay_operations"); await pool.query("ANALYZE valopay_merchants");
    }
  }
  // Readiness asks the database for what this build needs, not only for an answer: every table the Drizzle schema
  // declares with every column it declares, its integrity guards (every unique index and check constraint) and the
  // indexes later migrations add, the last two compared by definition (the copied tables of an isolated schema carry
  // generated index names). A database missing a migration used to answer SELECT 1 and read as ready, and one missing a
  // guard, as an interrupted push left it, read as ready too. A missing table, column or guard fails the check; a
  // missing read index is only reported.
  {
    const ready = await pingDatabase();
    assert.deepEqual([ready.status, ready.schema], ["ok", { status: "ok", missing: [] }], "the pushed schema is complete");
    const tables = ["valopay_workspaces", "valopay_merchants", "valopay_records", "valopay_idempotency", "valopay_operations", "valopay_teams", "valopay_staff_memberships", "valopay_staff_invitations", "valopay_staff_events", "valopay_staff_lender_access", "valopay_export_cleanup"];
    // The guards readiness requires are exactly the unique indexes and check constraints the pushed schema holds, so
    // one the Drizzle schema gains or loses fails here until the catalogue follows.
    const held = (await pool.query<{ table: string; type: string; definition: string }>(`SELECT t.relname AS table,'unique index' AS type,regexp_replace(pg_get_indexdef(i.indexrelid),'^CREATE UNIQUE INDEX \\S+ ON \\S+ ','') AS definition
        FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname=ANY($1::text[]) AND i.indisunique
      UNION ALL SELECT t.relname,'check',pg_get_constraintdef(k.oid)
        FROM pg_constraint k JOIN pg_class t ON t.oid=k.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname=ANY($1::text[]) AND k.contype='c'`, [tables])).rows;
    const described = (guards: Array<{ table: string; type: string; definition: string }>) => guards.map(({ table, type, definition }) => `${table} ${type} ${definition}`).sort();
    assert.deepEqual(described([...integrityGuards]), described(held), "readiness requires every unique index and check constraint the pushed schema holds, and nothing else");
    const scratch = `valopay_readiness_test_${randomBytes(6).toString("hex")}`;
    const guardSource = "restore it as docs/database-migrations.md describes";
    try {
      await pool.query(`CREATE SCHEMA "${scratch}"`);
      for (const table of tables) await pool.query(`CREATE TABLE "${scratch}".${table} (LIKE public.${table} INCLUDING ALL)`);
      assert.deepEqual((await pingDatabase({ schema: scratch })).schema, { status: "ok", missing: [] }, "copied tables whose indexes carry generated names are complete");
      const copied = async (table: string, like: string) => (await pool.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND tablename=$2 AND indexdef LIKE $3", [scratch, table, like])).rows[0]!.indexname;
      await pool.query(`DROP INDEX "${scratch}"."${await copied("valopay_operations", "%WHERE (status%")}"`);
      await pool.query(`DROP INDEX "${scratch}"."${await copied("valopay_records", "%exports%")}"`);
      // Without a read index every request still works, only slower: reported, not a reason to leave rotation.
      assert.deepEqual((await pingDatabase({ schema: scratch })).schema, { status: "indexes_missing", missing: [
        "index valopay_operations_pending: apply lib/db/migrations/007_journal_and_lender_indexes.sql",
        "index valopay_records_export_queue: apply lib/db/migrations/008_export_queue_index_and_foreign_key_names.sql",
      ] }, "a missing read index alone is named, with its migration, without failing");
      // Without an integrity guard the database accepts what the application relies on it to refuse (here a second
      // attempt in flight for one instalment, and an instalment below the ticket floor): not ready. An index of the
      // same columns that is not unique, or a check added NOT VALID, which leaves the rows already stored unchecked, is
      // not the guard.
      const inflight = await copied("valopay_records", "%dueItemId%"), inflightColumns = (await pool.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname=$2", [scratch, inflight])).rows[0]!.indexdef.replace(/^CREATE UNIQUE INDEX \S+ ON \S+ /, "");
      await pool.query(`DROP INDEX "${scratch}"."${inflight}"`);
      await pool.query(`CREATE INDEX valopay_one_inflight_lookalike ON "${scratch}".valopay_records ${inflightColumns}`);
      await pool.query(`ALTER TABLE "${scratch}".valopay_records DROP CONSTRAINT valopay_ticket_floor`);
      await pool.query(`ALTER TABLE "${scratch}".valopay_records ADD CONSTRAINT valopay_ticket_floor CHECK (kind <> 'due-items' OR amount_kobo >= 500000) NOT VALID`);
      const unguarded = await pingDatabase({ schema: scratch });
      assert.deepEqual([unguarded.status, unguarded.schema.status], ["ok", "incomplete"], "a database that answers but lacks a guard the build relies on is not ready");
      assert.deepEqual(unguarded.schema.missing, [
        `unique index valopay_one_inflight: ${guardSource}`,
        `check valopay_ticket_floor: ${guardSource}`,
        "index valopay_operations_pending: apply lib/db/migrations/007_journal_and_lender_indexes.sql",
        "index valopay_records_export_queue: apply lib/db/migrations/008_export_queue_index_and_foreign_key_names.sql",
      ], "and names each missing guard and index");
      await pool.query(`DROP TABLE "${scratch}".valopay_staff_events`);
      await pool.query(`ALTER TABLE "${scratch}".valopay_operations DROP COLUMN receipt`);
      const incomplete = await pingDatabase({ schema: scratch });
      assert.deepEqual([incomplete.status, incomplete.schema.status], ["ok", "incomplete"], "a database that answers but lacks a table or column the build uses is not ready");
      assert.deepEqual(incomplete.schema.missing, [
        "column valopay_operations.receipt: add it from the Drizzle schema in lib/db",
        "table valopay_staff_events: apply lib/db/migrations/003_pilot_workflow.sql",
        `unique index valopay_one_inflight: ${guardSource}`,
        `check valopay_ticket_floor: ${guardSource}`,
        "index valopay_operations_pending: apply lib/db/migrations/007_journal_and_lender_indexes.sql",
        "index valopay_records_export_queue: apply lib/db/migrations/008_export_queue_index_and_foreign_key_names.sql",
      ], "and names each missing table, column, guard and index, with where it comes from");
      // Each migration creates its tables whole (CREATE TABLE IF NOT EXISTS), and applying one again leaves a table that
      // exists as it is: 003 builds the dropped table again, but not the dropped column, which is why the column's line
      // does not name it.
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO "${scratch}"`);
        await client.query(await readFile(new URL("../../../lib/db/migrations/003_pilot_workflow.sql", import.meta.url), "utf8"));
      } finally {
        await client.query("RESET search_path");
        client.release();
      }
      assert.deepEqual((await pingDatabase({ schema: scratch })).schema.missing.filter((line) => /^(table|column) /.test(line)),
        ["column valopay_operations.receipt: add it from the Drizzle schema in lib/db"], "003 applied again builds the dropped table, not the dropped column");
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${scratch}" CASCADE`);
    }
    // Unqualified queries reach the tables along the search path, which is not always its first schema: by default a
    // schema named after the login comes first, and it may exist without the tables. Readiness reads the tables the
    // queries reach, and migrations 007 and 008 check their indexes and names on those tables, so such a schema does
    // not make a working database read as incomplete or stop a migration.
    const login = (await pool.query<{ login: string }>("SELECT current_user AS login")).rows[0]!.login, quoted = `"${login.replaceAll('"', '""')}"`;
    if (!(await pool.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [login])).rowCount) {
      await pool.query(`CREATE SCHEMA ${quoted}`);
      try {
        assert.equal((await pool.query<{ schema: string }>("SELECT current_schema() AS schema")).rows[0]!.schema, login, "the login's own empty schema now comes first");
        assert.deepEqual((await pingDatabase()).schema, { status: "ok", missing: [] }, "readiness reads the tables the queries reach");
        await pool.query(await readFile(new URL("../../../lib/db/migrations/007_journal_and_lender_indexes.sql", import.meta.url), "utf8"));
        await pool.query(await readFile(new URL("../../../lib/db/migrations/008_export_queue_index_and_foreign_key_names.sql", import.meta.url), "utf8"));
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS ${quoted}`);
      }
    }
  }
  // Audit item 26: a record whose keys were only reordered holds the value PostgreSQL already stores. A save neither
  // writes it nor gives it a new version, so evidence (a close) is not refused as changed. The audit chain is never loaded.
  const beforeReorder = await stamps();
  await inWorkspace(requestFor(savesToken), response(), async (context) => {
    const state = await loadState(context, savesMerchant);
    const reordered = [
      state.records.find((record) => record.id === `${savesMerchant}-close-recent`)!,
      state.records.find((record) => record.id === `${savesMerchant}-close-latest`)!,
      state.records.find((record) => record.kind === "customers")!,
    ];
    const versions = reordered.map((record) => record.updatedAt);
    for (const record of reordered) record.data = Object.fromEntries(Object.entries(record.data).reverse());
    assert.equal(settleChanges(context, state).changedRecords, 0, "reordered keys are not a change");
    assert.deepEqual(reordered.map((record) => record.updatedAt), versions, "and give no record a new version");
    await saveState(context, state);
  });
  assert.deepEqual(await stamps(), beforeReorder, "nothing was written");
  console.log("valopay repository integration tests passed");
} finally {
  delete process.env.VALOPAY_EXPIRED_WORKSPACE_CLEANUP;
  await closeDatabase();
}
