// Disposable PostgreSQL only. Private storage is a fake this suite installs: no object-storage credentials or external calls.
// Saved exports whose file an approved retention run removed are listed as expired, never as completed or needing a retry;
// and an idle anonymous sandbox the sweep deletes loses its export files too, once the deletion has committed.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { ValopayRecord } from "../src/domain/types.js";

if (process.env.VALOPAY_RUN_INTEGRATION !== "1") {
  console.log("Set VALOPAY_RUN_INTEGRATION=1 to run the export expiry integration tests.");
  process.exit(0);
}
const { pool } = await import("@workspace/db");
const { inWorkspace, listMerchants, listRecords, closeDatabase, overrideSweptExportRemoval, runExportCleanupPass, exportCleanupStatus } = await import("../src/lib/valopay-store.js");
const { pageRecords } = await import("../src/lib/valopay-list.js");
const { startExportCleanupWorker } = await import("../src/lib/export-cleanup-worker.js");
const { createBackgroundHealth } = await import("../src/lib/background-health.js");
const { default: express } = await import("express");
const { default: router } = await import("../src/routes/valopay.js");
type SweptExportFile = Parameters<Parameters<typeof overrideSweptExportRemoval>[0]>[0];

const auth = () => Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true });
const token = () => randomBytes(32).toString("hex");
const request = (value: string, log?: object) => ({ headers: { cookie: `valopay_sandbox=${value}` }, secure: false, auth: auth(), ...(log ? { log } : {}) }) as any;
const response = () => ({ cookie() {} }) as any;
const bucket = "synthetic-private-bucket";
/** Saves synthetic export jobs straight to the lender's records, as the worker and a retention run would have left them. */
async function saveJobs(merchantId: string, jobs: Array<{ label: string; status: string; removed?: boolean; checksum?: boolean; stored?: boolean }>) {
  const saved: Record<string, string> = {};
  for (const [index, job] of jobs.entries()) {
    const id = randomUUID();
    const data = {
      kind: "customers", format: "json", synthetic: true, attempts: 1,
      ...(job.stored === false ? {} : { bucket, objectName: `synthetic/exports/${merchantId}/${id}.json` }),
      ...(job.checksum ? { checksum: "c".repeat(64), generatedAt: "2026-06-01T09:00:00.000Z", byteLength: 12 } : {}),
      ...(job.status === "failed" ? { lastError: "Synthetic generation failure." } : {}),
      ...(job.removed ? { fileDeletedAt: "2026-09-01T09:00:00.000Z", fileRetentionRunId: randomUUID() } : {}),
    };
    await pool.query(`INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,customer_id,data,created_at,updated_at)
      VALUES($1,$2,'exports',$3,$4,'','',$5,$6,$6)`, [id, merchantId, `Synthetic export ${job.label}`, job.status, data, new Date(Date.UTC(2026, 5, 1, 9, index)).toISOString()]);
    saved[job.label] = id;
  }
  return saved;
}
/** Makes a sandbox old and idle enough to sweep, older than any other a reused database may hold, so the next sweep reaches it first. */
async function age(merchantId: string) {
  const workspace = (await pool.query<{ workspace_id: string }>("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [merchantId])).rows[0]!.workspace_id;
  await pool.query("UPDATE valopay_workspaces SET created_at = now() - interval '900 days' WHERE id=$1", [workspace]);
  await pool.query("UPDATE valopay_records SET created_at = created_at - interval '900 days', updated_at = updated_at - interval '900 days' WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)", [workspace]);
  return workspace;
}
const exists = async (table: string, id: string) => ((await pool.query(`SELECT 1 FROM ${table} WHERE id=$1`, [id])).rowCount || 0) > 0;

let server: Server | undefined;
try {
  // ---- The list's status filter: expired is derived from the file's removal ----
  const listToken = token();
  const merchantId = (await inWorkspace(request(listToken), response(), listMerchants))[0]!.id;
  const jobs = await saveJobs(merchantId, [
    { label: "ready", status: "ready", checksum: true }, { label: "ready removed", status: "ready", checksum: true, removed: true },
    { label: "failed", status: "failed" }, { label: "failed removed", status: "failed", removed: true },
    { label: "queued", status: "queued" }, { label: "running", status: "running" },
  ]);
  const listed = (query: Record<string, unknown>) => inWorkspace(request(listToken), response(), (context) => listRecords(context, merchantId, "exports", query), "read");
  const ids = (page: { items: ValopayRecord[] }) => page.items.map((item) => item.id);
  const everything = await listed({});
  assert.equal(everything.total, 6);
  const expected: Record<string, string[]> = {
    ready: [jobs.ready!], failed: [jobs.failed!], expired: [jobs["failed removed"]!, jobs["ready removed"]!],
    queued: [jobs.queued!], running: [jobs.running!],
  };
  for (const [status, wanted] of Object.entries(expected)) {
    for (const query of [{ status }, { status, search: "Synthetic export" }, { status, limit: 1 }]) {
      const page = await listed(query);
      assert.deepEqual(page, pageRecords(everything.items, query, "exports"), `the database lists as the shared rule does: ${JSON.stringify(query)}`);
      assert.deepEqual(ids(page), query.limit ? wanted.slice(0, 1) : wanted, `${JSON.stringify(query)} lists ${wanted.length} exports`);
      assert.equal(page.total, wanted.length);
    }
  }
  // Through the route, as the console asks for it: the private storage fields stay out of the answer.
  const app = express();
  app.use((req, _res, next) => { (req as any).auth = auth(); (req as any).log = { info() {}, warn() {} }; next(); });
  app.use("/api", router);
  server = await new Promise<Server>((resolve) => { const running = app.listen(0, "127.0.0.1", () => resolve(running)); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const answer = await fetch(`http://127.0.0.1:${address.port}/api/v1/records/exports?merchantId=${merchantId}&status=expired`, { headers: { cookie: `valopay_sandbox=${listToken}` } });
  assert.equal(answer.status, 200);
  const page = await answer.json() as { items: ValopayRecord[]; total: number };
  assert.deepEqual([ids(page), page.total], [expected.expired, 2], "the route lists the expired exports");
  assert.ok(page.items.every((item) => item.data.fileDeletedAt && !("bucket" in item.data) && !("objectName" in item.data)), "with their removal time and without their storage location");

  // ---- The sweep removes a swept sandbox's export files from private storage, after its deletion commits ----
  process.env.VALOPAY_EXPIRED_WORKSPACE_CLEANUP = "on";
  const removals: Array<SweptExportFile & { committed: boolean }> = [];
  let outage = "";
  const restore = overrideSweptExportRemoval(async (file) => {
    // Another connection sees the export's row only while the sweeping transaction is uncommitted.
    removals.push({ ...file, committed: !(await exists("valopay_records", file.exportId)) });
    if (file.exportId === outage) throw new Error("Synthetic private storage outage");
    return "deleted";
  });
  try {
    // Rendering/uploading does not hold a lender lock. A running export must
    // therefore keep the whole workspace, even after its recovery lease expires.
    const activeToken = token(), activeLenders = (await inWorkspace(request(activeToken), response(), listMerchants)).map(merchant => merchant.id).sort();
    const active = await saveJobs(activeLenders[0]!, [{ label: 'uploading', status: 'running', checksum: true }]);
    const neighbouring = await saveJobs(activeLenders[1]!, [{ label: 'ready', status: 'ready', checksum: true }]);
    const activeWorkspace = await age(activeLenders[0]!);
    await pool.query("UPDATE valopay_records SET data=data||jsonb_build_object('leaseExpiresAt','2000-01-01T00:00:00.000Z','stage','uploading') WHERE id=$1", [active.uploading!]);
    await inWorkspace(request(token()), response(), listMerchants);
    assert.equal(await exists('valopay_workspaces', activeWorkspace), true, 'an in-flight upload keeps the expired workspace while no lender lock is held');
    assert.equal(await exists('valopay_records', active.uploading!), true, 'its running job remains available for completion or recovery');
    assert.equal(await exists('valopay_records', neighbouring.ready!), true, 'other lenders in the workspace stay intact too');
    assert.equal(await exists('valopay_export_cleanup', active.uploading!), false, 'no absent-file cleanup can race the unfinished upload');
    assert.equal(removals.some(file => activeLenders.includes(file.merchantId)), false);
    // The worker has now settled the upload and recorded readiness; a later
    // sweep is safe and queues both lenders' acknowledged private artifacts.
    await pool.query("UPDATE valopay_records SET status='ready',data=data||jsonb_build_object('stage','ready'),updated_at=now() WHERE id=$1", [active.uploading!]);
    await inWorkspace(request(token()), response(), listMerchants);
    assert.equal(await exists('valopay_workspaces', activeWorkspace), false);
    assert.equal(removals.filter(file => activeLenders.includes(file.merchantId)).length, 2);

    const staleToken = token();
    const [first, second] = (await inWorkspace(request(staleToken), response(), listMerchants)).map((merchant) => merchant.id).sort();
    const stale = { ...(await saveJobs(first!, [{ label: "ready", status: "ready", checksum: true }, { label: "failed", status: "failed" }, { label: "removed", status: "ready", checksum: true, removed: true }, { label: "never stored", status: "failed", stored: false }])),
      ...Object.fromEntries(Object.entries(await saveJobs(second!, [{ label: "queued", status: "queued" }])).map(([label, id]) => [`second ${label}`, id])) };
    outage = stale.failed!;
    const staleWorkspace = await age(first!);

    // A bootstrap whose own transaction rolls back keeps the sandbox, so none of its files is touched.
    await assert.rejects(inWorkspace(request(token()), response(), async (context) => { await listMerchants(context); throw new Error("Synthetic failure after the sweep"); }), /Synthetic failure after the sweep/);
    assert.equal(await exists("valopay_workspaces", staleWorkspace), true, "a rolled-back bootstrap undoes its sweep");
    assert.equal(await exists('valopay_export_cleanup', stale.failed!), false, 'rollback also removes the deletion tombstone');
    assert.deepEqual(removals.filter((file) => [first, second].includes(file.merchantId)), [], "and removes none of the sandbox's files");

    const warnings: Array<Record<string, any>> = [];
    const seeded = await inWorkspace(request(token(), { warn: (fields: object) => warnings.push(fields as Record<string, any>) }), response(), listMerchants);
    assert.equal(seeded.length, 2, "the new visitor is seeded");
    assert.equal(await exists("valopay_workspaces", staleWorkspace), false, "the idle sandbox is swept");
    assert.deepEqual(removals.filter(file => [first, second].includes(file.merchantId)).map(file => file.exportId), [stale.ready!], 'only an acknowledged ready artifact is removed immediately');
    const interrupted = [stale.failed!, stale['second queued']!];
    const delayed = (await pool.query('SELECT id,created_at,next_attempt_at,attempts FROM valopay_export_cleanup WHERE id=ANY($1::text[]) ORDER BY id', [interrupted])).rows;
    assert.equal(delayed.length, 2, 'interrupted failed and requeued uploads retain durable deletion identities');
    for (const row of delayed) { assert.equal(row.attempts, 0); assert.equal(row.next_attempt_at.getTime() - row.created_at.getTime(), 5 * 60_000, 'first storage check waits five minutes for interrupted writes to settle'); }
    assert.equal((await runExportCleanupPass({ ids: interrupted })).attempted, 0, 'the grace period cannot acknowledge a temporarily absent object');
    // Advance the queue's due time rather than sleeping through the bounded allowance.
    await pool.query('UPDATE valopay_export_cleanup SET next_attempt_at=now() WHERE id=ANY($1::text[])', [interrupted]);
    assert.deepEqual(await runExportCleanupPass({ ids: interrupted, limit: 2, log: { warn: fields => warnings.push(fields as Record<string, any>) } }), { attempted: 2, removed: 1, deferred: 1 });
    const swept = removals.filter((file) => [first, second].includes(file.merchantId));
    const objectName = (merchant: string, id: string) => `synthetic/exports/${merchant}/${id}.json`;
    assert.deepEqual(swept.sort((a, b) => a.exportId.localeCompare(b.exportId)), [
      { merchantId: first!, exportId: stale.ready!, bucket, objectName: objectName(first!, stale.ready!), checksum: "c".repeat(64), committed: true },
      { merchantId: first!, exportId: stale.failed!, bucket, objectName: objectName(first!, stale.failed!), committed: true },
      { merchantId: second!, exportId: stale["second queued"]!, bucket, objectName: objectName(second!, stale["second queued"]!), committed: true },
    ].sort((a, b) => a.exportId.localeCompare(b.exportId)), "each of its lenders' stored files is removed once, after the deletion committed; a file retention already removed, or never stored, is not");
    const left = warnings.filter((fields) => fields.event === "workspace.sweep_file_left");
    assert.equal(left.length, 1, JSON.stringify(warnings));
    assert.deepEqual(left[0], { event: 'workspace.sweep_file_left', reason: 'failed', merchantId: first!, exportId: stale.failed!, retrySeconds: 30 },
      'a bounded retry notice identifies the queued job without private storage paths or raw errors');
    assert.deepEqual(warnings.filter((fields) => fields.event === "workspace.sweep_failed"), [], "and the sweep itself stands");
    const queued = (await pool.query('SELECT * FROM valopay_export_cleanup WHERE id=$1', [stale.failed!])).rows[0];
    assert.equal(queued.attempts, 1); assert.equal(queued.object_name, objectName(first!, stale.failed!));
    assert.equal(queued.lease_token, null); assert.equal(queued.last_failure, 'storage_or_queue_unavailable');
    assert.ok(queued.next_attempt_at > queued.updated_at, 'failures back off');
    assert.equal(await exists('valopay_export_cleanup', stale.ready!), false, 'successful deletion removes its queue entry');
    assert.equal((await runExportCleanupPass({ ids: [stale.failed!] })).attempted, 0, 'retry respects its due time');
    assert.ok((await exportCleanupStatus()).pending >= 1, 'operator status shows the durable backlog');
    const failuresBeforeRecovery = (await exportCleanupStatus()).failed;
    assert.ok(failuresBeforeRecovery >= 1, 'aggregate status includes persisted failures even before their next due time');
    const cleanupHealth = createBackgroundHealth();
    cleanupHealth.configure({ closes: false, backlog: false, exports: true, cleanup: true }); cleanupHealth.starting();
    const observeCleanup = async () => {
      const worker = startExportCleanupWorker({ observed: result => cleanupHealth.observe({ type: 'cleanup', result }) },
        options => runExportCleanupPass({ ...options, ids: [stale.failed!] }));
      await worker.settle(); worker.stop();
      return cleanupHealth.status().cleanup;
    };
    const duringBackoff = await observeCleanup();
    assert.equal(duringBackoff.state, 'failed', 'a restarted observer still sees the persisted failure during backoff');
    assert.deepEqual(duringBackoff.lastResult, { attempted: 0, removed: 0, deferred: 0, pendingFailures: failuresBeforeRecovery });
    assert.equal(duringBackoff.lastSuccessAt, null, 'an empty due poll cannot invent a recovery timestamp');

    // Process restart is represented by a separate pass with no original sweep state. The queue alone identifies the file.
    outage = '';
    await pool.query('UPDATE valopay_export_cleanup SET next_attempt_at=now() WHERE id=$1', [stale.failed!]);
    assert.equal((await runExportCleanupPass({ ids: [stale.failed!], budgetMs: 0 })).attempted, 0, 'an exhausted budget leaves its durable work for a later pass');
    assert.equal(await exists('valopay_export_cleanup', stale.failed!), true);
    assert.deepEqual(await runExportCleanupPass({ ids: [stale.failed!] }), { attempted: 1, removed: 1, deferred: 0 });
    assert.equal(await exists('valopay_export_cleanup', stale.failed!), false);
    const afterRecovery = await observeCleanup();
    assert.equal(afterRecovery.lastResult!.pendingFailures, failuresBeforeRecovery - 1, 'only actually clearing the failed tombstone reduces durable failure evidence');
    if (failuresBeforeRecovery === 1) {
      assert.equal(afterRecovery.state, 'ok'); assert.ok(afterRecovery.lastSuccessAt, 'positive aggregate clearance can establish recovery');
    } else assert.equal(afterRecovery.state, 'failed', 'another remaining failed tombstone would still prevent recovery');

    // A lost worker's leased job is reclaimed only after its lease expires; two workers never claim it together.
    const abandoned = randomUUID();
    await pool.query(`INSERT INTO valopay_export_cleanup(id,merchant_id,bucket,object_name,checksum,lease_token,lease_until)
      VALUES($1,$2,$3,$4,$5,'lost-worker',now()+interval '1 minute')`, [abandoned, first, bucket, objectName(first!, abandoned), 'd'.repeat(64)]);
    assert.equal((await runExportCleanupPass({ ids: [abandoned] })).attempted, 0);
    await pool.query("UPDATE valopay_export_cleanup SET lease_until=now()-interval '1 second' WHERE id=$1", [abandoned]);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const restoreBlocking = overrideSweptExportRemoval(async file => {
      assert.equal(file.exportId, abandoned); assert.equal(file.checksum, 'd'.repeat(64), 'claim retains expected checksum');
      entered(); await gate; return 'already_absent';
    });
    try {
      const firstPass = runExportCleanupPass({ ids: [abandoned], limit: 1 });
      await started;
      assert.equal((await exportCleanupStatus()).failed, failuresBeforeRecovery - 1, 'an ordinary first-attempt lease is not a persisted failure');
      assert.equal((await runExportCleanupPass({ ids: [abandoned] })).attempted, 0, 'another instance cannot claim the live lease');
      release(); await firstPass;
      assert.equal(await exists('valopay_export_cleanup', abandoned), false, 'an absent file is safely acknowledged');
    } finally { release(); restoreBlocking(); }

    // Safety failures are retained, not bypassed or mistaken for successful cleanup.
    const mismatch = randomUUID();
    await pool.query('INSERT INTO valopay_export_cleanup(id,merchant_id,bucket,object_name,checksum) VALUES($1,$2,$3,$4,$5)', [mismatch, first, bucket, objectName(first!, mismatch), 'e'.repeat(64)]);
    const restoreMismatch = overrideSweptExportRemoval(async () => { throw new Error('Ownership or checksum mismatch'); });
    try {
      assert.deepEqual(await runExportCleanupPass({ ids: [mismatch] }), { attempted: 1, removed: 0, deferred: 1 });
      assert.equal(await exists('valopay_export_cleanup', mismatch), true);
    } finally { restoreMismatch(); await pool.query('DELETE FROM valopay_export_cleanup WHERE id=$1', [mismatch]); }
  } finally { restore(); }
  console.log('Export expiry integration checks passed: expiry filtering, running-upload sweep exclusion, interrupted-upload grace period, transactional tombstones, outage retry, crash recovery, concurrent claims, absent files and retained identity failures.');
} finally {
  delete process.env.VALOPAY_EXPIRED_WORKSPACE_CLEANUP;
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  await closeDatabase();
}
