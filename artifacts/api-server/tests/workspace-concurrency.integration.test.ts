import { SANDBOX_COOKIE } from "../src/lib/sandbox-cookie";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

if (process.env.VALO_PAY_1_RUN_INTEGRATION !== "1") {
  console.log("Set VALO_PAY_1_RUN_INTEGRATION=1 for the disposable-database concurrency tests.");
  process.exit(0);
}
const { pool, Pool, poolSize, POOL_WAIT_MS } = await import("@workspace/valo-pay-1-db");
const { inWorkspace, listMerchants, loadState, saveState, changeRole, appendAudit, auditOverview, saveIdempotency, findIdempotency, digest, pingDatabase, closeDatabase, lenderConnections, tenantConnections } = await import("../src/lib/valo-pay-1-store");
const { verifyAuditChain } = await import("../src/lib/digests");
const { databaseLimitOf, DatabaseLimitError, overrideDatabaseLimits } = await import("../src/lib/database-limits");
const { wasRolledBack } = await import("../src/lib/transaction-outcome");
const token = randomBytes(32).toString("hex"), otherToken = randomBytes(32).toString("hex");
/** A request as a route makes it; with a lender in the query string, the per-lender gate applies. */
const reqFor = (merchantId?: string, sandbox = token) => ({ headers: { cookie: `${SANDBOX_COOKIE}=${sandbox}` }, query: merchantId ? { merchantId } : {}, secure: false, auth: Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true }) }) as any;
const req = () => reqFor();
const res = () => ({ cookie() {} }) as any;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function within<T>(promise: Promise<T>, label: string, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} blocked for ${ms} ms`)), ms); })]); }
  finally { clearTimeout(timer!); }
}
/** A 503 for this database limit, with nothing saved. */
function turnedAway(error: unknown, limits: string[], label: string) {
  assert.ok(error instanceof DatabaseLimitError, `${label}: ${error instanceof Error ? error.message : String(error)}`);
  assert.ok(limits.includes(error.limit), `${label}: ${error.limit}`);
  assert.equal(error.status, 503, label);
  assert.equal(wasRolledBack(error), true, `${label}: nothing was saved`);
}
async function staysBlocked(entered: Promise<void>, label: string) {
  const winner = await Promise.race([entered.then(() => "entered"), new Promise<string>(resolve => setTimeout(() => resolve("blocked"), 100))]);
  assert.equal(winner, "blocked", label);
}
const cleanup: Array<() => void> = [];
const pending: Promise<unknown>[] = [];
function track<T>(promise: Promise<T>) { pending.push(promise); void promise.catch(() => {}); return promise; }
try {
  const bootstrap = await Promise.all(Array.from({ length: 4 }, (_, index) => inWorkspace(req(), res(), listMerchants, index % 2 ? "write" : "read")));
  const ids = bootstrap[0]!.map(row => row.id);
  for (const rows of bootstrap) assert.deepEqual(rows.map(row => row.id), ids, "concurrent read/write bootstrap shares one fully seeded workspace");
  const [first, second] = ids as [string, string];

  // A read answers from one snapshot and takes no lender lock (decision 4 of the 23 September audit): a write never
  // waits for it, it never waits for a write, and it sees the state from before a write still running.
  const readerReady = gate(), releaseReader = gate(); cleanup.push(releaseReader.resolve);
  const heldReader = track(inWorkspace(req(), res(), async context => {
    const before = await loadState(context, first, "share");
    readerReady.resolve(); await releaseReader.promise;
    const after = await loadState(context, first, "share");
    assert.deepEqual(after, before, "a read's lender state cannot change between reads, even across a committed write");
    assert.equal(after.settings.concurrencyFixture, undefined, "the write committed meanwhile is not in the read's snapshot");
    assert.equal(context.role, "Admin");
    await assert.rejects(() => saveState(context, after), /read transaction cannot write/);
    await assert.rejects(() => loadState(context, first, "update"), /read transaction cannot acquire/);
    await assert.rejects(() => changeRole(context, "Finance"), /exclusive workspace transaction/);
  }, "read"));
  await within(readerReady.promise, "first reader");
  await within(inWorkspace(req(), res(), async context => { await loadState(context, first, "share"); }, "read"), "simultaneous reader");
  await within(inWorkspace(req(), res(), async context => {
    const state = await loadState(context, second);
    state.settings.concurrencyFixture = "other lender";
    await saveState(context, state);
  }), "other lender write during read");

  const writerReady = gate(), releaseWriter = gate(); cleanup.push(releaseWriter.resolve);
  const heldWriter = track(inWorkspace(req(), res(), async context => {
    const state = await loadState(context, first);
    writerReady.resolve(); await releaseWriter.promise;
    state.settings.concurrencyFixture = "committed writer";
    appendAudit(state, context, "concurrency.fixture", "workspace", "Synthetic concurrent write");
    await saveState(context, state);
    await saveIdempotency(context, `concurrency-${token}`, "fixed-request", { committed: true });
  }));
  await within(writerReady.promise, "a same-lender writer does not wait for an open read");
  await within(inWorkspace(req(), res(), async context => { await loadState(context, second, "share"); }, "read"), "other lender read during write");
  // A read during a long write answers at once, with the state from before the write.
  const duringWrite = await within(inWorkspace(req(), res(), context => loadState(context, first, "share"), "read"), "a read of the lender during its write", 1_000);
  assert.equal(duringWrite.settings.concurrencyFixture, undefined, "a read during a write sees the state before it");
  releaseWriter.resolve(); await heldWriter;
  await inWorkspace(req(), res(), async context => {
    const state = await loadState(context, first, "share");
    assert.equal(state.settings.concurrencyFixture, "committed writer", "a read after the commit sees the write");
    assert.equal(state.records.some(record => record.kind === "audit"), false, "the audit chain is not part of a loaded state");
    assert.equal((await auditOverview(context, state)).verification.valid, true, "audit chain survives concurrent reads and writes");
  }, "read");
  const chain = (await pool.query<{ data: Record<string, any> }>("SELECT data FROM valopay_records WHERE merchant_id=$1 AND kind='audit'", [first])).rows;
  assert.deepEqual(verifyAuditChain(chain), { valid: true, count: 2, headHash: chain.find(row => row.data.sequence === 2)!.data.hash }, "and verifies from its first entry");
  releaseReader.resolve(); await within(heldReader, "the first reader, whose snapshot held");
  await inWorkspace(req(), res(), async context => {
    await loadState(context, first);
    assert.deepEqual(await findIdempotency(context, `concurrency-${token}`), { request_hash: "fixed-request", response: { committed: true } });
    await assert.rejects(() => changeRole(context, "Finance"), /exclusive workspace transaction/);
  });

  const roleReaderReady = gate(), releaseRoleReader = gate(); cleanup.push(releaseRoleReader.resolve);
  const roleReader = track(inWorkspace(req(), res(), async context => { roleReaderReady.resolve(); await releaseRoleReader.promise; assert.equal(context.role, "Admin"); }, "read"));
  await within(roleReaderReady.promise, "role reader");
  const personaReady = gate(), releasePersona = gate(); cleanup.push(releasePersona.resolve);
  const persona = track(inWorkspace(req(), res(), async context => { await changeRole(context, "Finance"); personaReady.resolve(); await releasePersona.promise; }, "persona"));
  await staysBlocked(personaReady.promise, "persona waits for all active workspace readers");
  // A reader that arrives while the change waits queues behind it, so steady reads cannot hold a change off.
  const lateReaderEntered = gate();
  const lateReader = track(inWorkspace(req(), res(), async context => { lateReaderEntered.resolve(); assert.equal(context.role, "Finance", "the late reader sees the change it queued behind"); }, "read"));
  await staysBlocked(lateReaderEntered.promise, "a reader arriving while a persona change waits queues behind it");
  releaseRoleReader.resolve(); await roleReader; await within(personaReady.promise, "persona after readers complete");
  await staysBlocked(lateReaderEntered.promise, "the late reader waits for the change to commit");
  const newRoleEntered = gate();
  const newRole = track(inWorkspace(req(), res(), async context => { newRoleEntered.resolve(); assert.equal(context.role, "Finance"); }, "read"));
  await staysBlocked(newRoleEntered.promise, "new request cannot observe uncommitted persona");
  releasePersona.resolve(); await persona; await within(newRole, "new persona reader"); await within(lateReader, "late reader after the persona change");

  // A change that cannot start within the lock limit gives up with a 503 and
  // changes nothing; the requests queued behind it then go ahead.
  {
    const holderIn = gate(), releaseHolder = gate(); cleanup.push(releaseHolder.resolve);
    const holder = track(inWorkspace(req(), res(), async context => { holderIn.resolve(); await releaseHolder.promise; assert.equal(context.role, "Finance"); }, "read"));
    await within(holderIn.promise, "held reader");
    let change!: Promise<unknown>;
    const restore = overrideDatabaseLimits({ request: { lockMs: 300 } });
    try { change = failure(inWorkspace(req(), res(), context => changeRole(context, "Operations"), "persona")); await sleep(50); } finally { restore(); }
    const queuedIn = gate();
    const queued = track(inWorkspace(req(), res(), async context => { queuedIn.resolve(); assert.equal(context.role, "Finance", "the change that gave up changed nothing"); }, "read"));
    await staysBlocked(queuedIn.promise, "a reader arriving while the change waits queues behind it");
    const refused = await within(change, "a change past the lock limit", 2_000);
    turnedAway(refused, ["workspace_busy"], "a change that cannot start in time");
    assert.match((refused as Error).message, /^Other requests in this workspace are still finishing\. Nothing was saved\. Try this change again in a moment\.$/);
    await within(queued, "the queued reader once the change gave up", 1_000);
    releaseHolder.resolve(); await within(holder, "held reader");
  }

  // ---- Database limits: one busy lender, one busy sandbox, a slow statement, an idle or lost connection and a full pool ----
  const uncaught: unknown[] = [];
  const heard = (error: unknown) => { uncaught.push(error); };
  process.on("uncaughtException", heard);
  try {
    const [otherLender] = (await inWorkspace(reqFor(undefined, otherToken), res(), listMerchants, "read")).map(row => row.id) as [string];
    assert.deepEqual([tenantConnections, lenderConnections], [Math.max(1, Math.floor(poolSize / 3)), Math.max(1, Math.ceil(Math.floor(poolSize / 3) / 2))], "a tenant's share is a third of the pool, a lender's half of that");
    // A connection of its own, so counting the backends never waits for the pool it watches.
    const monitor = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const lockWaiters = async () => Number((await monitor.query<{ count: string }>("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND wait_event_type='Lock'")).rows[0]!.count);
    /** Waits until this many backends wait for a lock, then checks that no more do. */
    const lockWaitersSettle = async (expected: number, label: string) => {
      const settle = Date.now() + 1_500;
      while (await lockWaiters() < expected && Date.now() < settle) await sleep(20);
      await sleep(100);
      assert.equal(await lockWaiters(), expected, label);
    };
    try {
      // The lock limit is longer than the other tenant's bound: had the busy lender taken the whole pool, the other read would wait for the first lock limit to free a connection.
      const restore = overrideDatabaseLimits({ request: { lockMs: 2_000, idleMs: 10_000 } });
      try {
        const writerIn = gate(), releaseBusy = gate(); cleanup.push(releaseBusy.resolve);
        const writer = track(inWorkspace(reqFor(first), res(), async context => {
          const state = await loadState(context, first);
          writerIn.resolve(); await releaseBusy.promise;
          state.settings.concurrencyFixture = "writer that outlasted the others";
          await saveState(context, state);
        }));
        await within(writerIn.promise, "busy writer");
        // Reads take no lender lock: they answer from their snapshots at once, the busy writer's change not yet in them.
        const reads = await within(Promise.all(Array.from({ length: 10 }, () => inWorkspace(reqFor(first), res(), context => loadState(context, first, "share"), "read"))), "reads of the busy lender", 2_000);
        assert.ok(reads.every(state => state.settings.concurrencyFixture !== "writer that outlasted the others"), "each read sees the state before the write");
        // Writes wait for the lender's lock, each on a connection, only within the lender's share; the rest wait in the gate without one.
        const writers = Array.from({ length: 10 }, () => failure(inWorkspace(reqFor(first), res(), context => loadState(context, first))));
        await within(inWorkspace(reqFor(otherLender, otherToken), res(), context => loadState(context, otherLender, "share"), "read"), "another workspace's read while one lender is busy", 1_000);
        assert.equal((await pingDatabase()).status, "ok", "readiness answers while one lender is busy");
        // The busy writer holds one of the lender's places; the writes that got the rest wait for its lock.
        await lockWaitersSettle(lenderConnections - 1, `the busy lender holds at most its share of the ${poolSize} connections`);
        const outcomes = await within(Promise.all(writers), "writes of the busy lender", 6_000);
        outcomes.forEach((error, index) => turnedAway(error, ["lock_timeout", "lender_busy"], `write ${index + 1}`));
        const seen = new Set(outcomes.map(databaseLimitOf));
        assert.ok(seen.has("lender_busy") && (lenderConnections < 2 || seen.has("lock_timeout")), `some writes waited for the lock and the rest for the gate (${[...seen].join(", ")})`);
        releaseBusy.resolve();
        await within(writer, "the busy writer commits");
      } finally { restore(); }
      {
        // One sandbox's own two lenders both busy with writes elsewhere (the audit's pool-starve case): its reads answer from their
        // snapshots, its writes hold at most the tenant's share of connections, and another tenant is served at once.
        const restoreLimits = overrideDatabaseLimits({ request: { lockMs: 2_000, idleMs: 10_000 } });
        const holder = await pool.connect();
        try {
          await holder.query("BEGIN");
          await holder.query("SELECT id FROM valopay_merchants WHERE id = ANY($1::text[]) FOR UPDATE", [[first, second]]);
          await within(Promise.all([first, second].flatMap(lender => Array.from({ length: 5 }, () => inWorkspace(reqFor(lender), res(), context => loadState(context, lender, "share"), "read")))), "the busy sandbox's reads", 2_000);
          const writes = [first, second].flatMap(lender => Array.from({ length: 5 }, () => failure(inWorkspace(reqFor(lender), res(), context => loadState(context, lender)))));
          await lockWaitersSettle(tenantConnections, `the busy sandbox holds at most a third of the ${poolSize} connections`);
          await within(inWorkspace(reqFor(otherLender, otherToken), res(), context => loadState(context, otherLender, "share"), "read"), "another tenant's read while the sandbox is busy", 1_000);
          await within(inWorkspace(reqFor(otherLender, otherToken), res(), async context => { const state = await loadState(context, otherLender); state.settings.concurrencyFixture = "written while another sandbox was busy"; await saveState(context, state); }), "and its write", 1_000);
          (await within(Promise.all(writes), "the busy sandbox's writes", 6_000)).forEach((error, index) => turnedAway(error, ["lock_timeout", "lender_busy"], `busy sandbox write ${index + 1}`));
        } finally { await holder.query("ROLLBACK"); holder.release(); restoreLimits(); }
      }
    } finally { await monitor.end(); }
    {
      // Another workspace that names this lender in its own requests fills only its own slots: the gate is per caller and lender.
      // Were it per lender, this workspace's requests would wait behind them for the 5 s lock limit and then be turned away.
      const releaseOthers = gate(); cleanup.push(releaseOthers.resolve);
      const inside: Promise<void>[] = [];
      const others = Array.from({ length: lenderConnections + 2 }, () => {
        const entered = gate(); inside.push(entered.promise);
        return track(failure(inWorkspace(reqFor(first, otherToken), res(), async () => { entered.resolve(); await releaseOthers.promise; }, "read")));
      });
      await within(Promise.all(inside.slice(0, lenderConnections)), "another workspace's requests naming this lender", 2_000);
      await within(inWorkspace(reqFor(first), res(), context => loadState(context, first, "share"), "read"), "this workspace's read of its own lender while another workspace names it", 1_000);
      await within(inWorkspace(reqFor(first), res(), async context => { const state = await loadState(context, first); state.settings.concurrencyFixture = "written while another workspace named this lender"; await saveState(context, state); }), "and its write", 1_000);
      releaseOthers.resolve();
      assert.deepEqual(await within(Promise.all(others), "the other workspace's requests", 3_000), others.map(() => undefined), "which finish in their own workspace");
    }
    {
      // A write waiting for a lender held elsewhere is stopped at the statement limit (a read no longer waits at all).
      const restore = overrideDatabaseLimits({ request: { lockMs: 5_000, statementMs: 300 } });
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM valopay_merchants WHERE id=$1 FOR UPDATE", [first]);
        turnedAway(await within(failure(inWorkspace(reqFor(first), res(), context => loadState(context, first))), "statement limit", 2_000), ["statement_timeout"], "a statement past its limit is stopped");
      } finally { await holder.query("ROLLBACK"); holder.release(); restore(); }
    }
    {
      const restore = overrideDatabaseLimits({ request: { idleMs: 300 } });
      try {
        const error = await failure(inWorkspace(reqFor(first), res(), async context => { await loadState(context, first); await sleep(800); await loadState(context, first); }));
        turnedAway(error, ["idle_timeout"], "a transaction idle past its limit is ended");
      } finally { restore(); }
      await within(inWorkspace(reqFor(first), res(), async context => { const state = await loadState(context, first); state.settings.concurrencyFixture = "after an idle kill"; await saveState(context, state); }), "a write after the idle kill", 1_000);
    }
    {
      // The idle limit ends the session after the last statement and before COMMIT: pg refuses the COMMIT without sending it, so nothing was saved.
      const restore = overrideDatabaseLimits({ request: { idleMs: 300 } });
      let error: unknown;
      try {
        error = await failure(inWorkspace(reqFor(first), res(), async context => { const state = await loadState(context, first); state.settings.concurrencyFixture = "idle before COMMIT"; await saveState(context, state); await sleep(800); }));
      } finally { restore(); }
      turnedAway(error, ["idle_timeout"], "an idle kill just before COMMIT is a 503 that says nothing was saved");
      const after = await inWorkspace(reqFor(first), res(), context => loadState(context, first, "share"), "read");
      assert.equal(after.settings.concurrencyFixture, "after an idle kill", "and nothing was saved");
    }
    {
      const error = await failure(inWorkspace(reqFor(first), res(), async context => {
        await loadState(context, first);
        const backend = (await pool.query<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND state='idle in transaction' ORDER BY xact_start DESC LIMIT 1")).rows[0];
        await pool.query("SELECT pg_terminate_backend($1)", [backend!.pid]);
        await sleep(200);
        await loadState(context, first);
      }));
      turnedAway(error, ["connection_lost"], "a lost connection");
    }
    {
      const held = await Promise.all(Array.from({ length: poolSize }, () => pool.connect()));
      try {
        const error = await within(failure(inWorkspace(reqFor(otherLender, otherToken), res(), listMerchants, "read")), "checkout limit", POOL_WAIT_MS + 2_000);
        turnedAway(error, ["pool_timeout"], "no free connection");
        assert.equal((await pingDatabase()).status, "ok", "readiness has its own connection");
        for (const client of held) {
          const settings = (await client.query<{ statement: string; lock: string; idle: string }>("SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock, current_setting('idle_in_transaction_session_timeout') AS idle")).rows[0];
          assert.deepEqual(settings, { statement: "0", lock: "0", idle: "0" }, "the limits end with each transaction: no pooled connection keeps them");
        }
      } finally { held.forEach(client => client.release()); }
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(uncaught, [], "a lost or killed connection never reaches the process as an uncaught error");
  } finally { process.off("uncaughtException", heard); }
  console.log("Workspace concurrency passed: concurrent readers, cross-lender reads/writes, reads from a snapshot that never wait for a write and see the state before it, bootstrap, read capability, persona, audit and idempotency; a persona change is not overtaken by later readers and gives up with a 503 when it cannot start in time; one busy lender holds at most its share of the pool and one busy sandbox at most a third, another workspace naming a lender never holds it up, and a busy lender, a slow statement, an idle or lost connection (also just before COMMIT) and a full pool are each turned away with a 503 without holding up another lender or readiness.");
} finally {
  cleanup.forEach(release => release());
  await Promise.allSettled(pending);
  for (const principal of [digest(`demo:${token}`), digest(`demo:${otherToken}`)]) {
    for (const table of ["valopay_idempotency", "valopay_records"]) await pool.query(`DELETE FROM ${table} WHERE merchant_id IN (SELECT m.id FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id WHERE w.principal_hash=$1)`, [principal]);
    await pool.query("DELETE FROM valopay_merchants WHERE workspace_id IN (SELECT id FROM valopay_workspaces WHERE principal_hash=$1)", [principal]);
    await pool.query("DELETE FROM valopay_workspaces WHERE principal_hash=$1", [principal]);
  }
  await closeDatabase();
}
