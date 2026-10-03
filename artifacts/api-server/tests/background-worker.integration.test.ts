import { SANDBOX_COOKIE } from "../src/lib/sandbox-cookie";
// Database-backed test for the background worker thread (decision 1 of the 23
// September 2026 audit): the first scheduled close of a pilot-sized lender runs
// on the thread, so /api/healthz, answered on the main thread, stays prompt all
// through it, and the thread's scheduler state and log lines reach the main
// thread; an export queued meanwhile is claimed and settled by the thread with
// the lender's audit chain intact; and a stop that arrives while a close runs
// lets that close finish before the thread ends. Every pass is narrowed to this
// test's own lender.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

if (process.env.VALO_PAY_1_RUN_INTEGRATION !== "1") {
  console.log("Set VALO_PAY_1_RUN_INTEGRATION=1 to run the background worker integration test.");
  process.exit(0);
}
// The log goes to a file this test reads back; exports are queued to a synthetic private location.
const logFile = join(tmpdir(), `valo-pay-1-background-${process.pid}.log`);
process.env["LOG_FILE"] = logFile;
process.env["LOG_LEVEL"] = "info";
const oldDirectory = process.env["PRIVATE_OBJECT_DIR"];
process.env["PRIVATE_OBJECT_DIR"] = "/private/synthetic-export-tests";

const { pool } = await import("@workspace/valo-pay-1-db");
const { inWorkspace, listMerchants } = await import("../src/lib/valo-pay-1-store");
const { verifyAuditChain } = await import("../src/lib/digests");
const { startBackgroundWorker } = await import("../src/lib/background-worker");
const { logger } = await import("../src/lib/logger");
const { workflowFixture, WORKFLOW_NOW } = await import("./workflow-fixture");
const { default: express } = await import("express");
const { default: health } = await import("../src/routes/health");
const { default: valoPay1 } = await import("../src/routes/valo-pay-1");

/** Customers in the lender whose first close the probes run beside: about 40,000 records, so a close lasts long enough for probes a tenth of a second apart. */
const CUSTOMERS = 1600;
const token = randomBytes(32).toString("hex");
const auth = () => Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true });
const request = () => ({ headers: { cookie: `${SANDBOX_COOKIE}=${token}` }, secure: false, auth: auth() }) as any;
const response = () => ({ cookie() { /* a valid test cookie is already supplied */ } }) as any;
const lines = (): Array<Record<string, any>> => readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const closesOf = async (merchantId: string) => (await pool.query<{ data: Record<string, any> }>("SELECT data FROM valopay_records WHERE merchant_id=$1 AND kind='closes' ORDER BY created_at", [merchantId])).rows;
const makeDue = (merchantId: string) => pool.query("UPDATE valopay_merchants SET settings = settings || jsonb_build_object('nextCloseAt', to_char((now() - interval '5 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')) WHERE id=$1", [merchantId]);
/** Whether a transaction still running holds the lender's row, as a close does from its start to its commit; read without taking the row. */
const lenderHeld = async (merchantId: string) => (await pool.query<{ held: boolean }>(
  "SELECT EXISTS (SELECT 1 FROM valopay_merchants m JOIN pg_locks l ON l.locktype='transactionid' AND l.transactionid=m.xmax AND l.granted WHERE m.id=$1) AS held", [merchantId])).rows[0]!.held;

/**
 * Probes /api/healthz from another process, as a host's health check does, until an answer reports a pass that found
 * work, and returns each probe answered and how many were skipped: a probe from this process could not tell, since it
 * would wait on the same event loop it measures. A probe waits 100 ms after the last answer, and an answer other than
 * 200, such as the health limit's 429 once a network has made its 120 checks in a minute, is a skipped probe.
 */
type Probe = { ms: number; ticks: number; lastRun: { closed: number; durationMs: number } | null };
async function probeHealth(url: string): Promise<{ probes: Probe[]; skipped: number }> {
  const script = `const { performance } = require("node:perf_hooks"); const until = Date.now() + 180000;
    (async () => { for (;;) {
      const sent = performance.now(), answer = await fetch(process.argv[1]);
      if (answer.status === 200) {
        const body = await answer.json();
        console.log(JSON.stringify({ ms: performance.now() - sent, ticks: body.scheduler.ticks, lastRun: body.scheduler.lastRun }));
        if (body.scheduler.lastRun) break;
      } else {
        await answer.arrayBuffer();
        console.log(JSON.stringify({ skipped: answer.status }));
      }
      if (Date.now() > until) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } })();`;
  const child = spawn(process.execPath, ["-e", script, url], { stdio: ["ignore", "pipe", "inherit"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(status, 0, "the health probe ran to the end");
  const answers = output.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Probe | { skipped: number });
  const probes = answers.filter((answer): answer is Probe => !("skipped" in answer));
  return { probes, skipped: answers.length - probes.length };
}

/** Loads the performance suite's synthetic workflow fixture into a lender, its dates moved to now, as a pilot lender that has not closed yet. */
async function seedLender(merchantId: string, customers: number): Promise<number> {
  const fixture = workflowFixture(customers);
  const now = (await pool.query<{ now: Date }>("SELECT now() AS now")).rows[0]!.now.getTime();
  const shift = (at: string) => new Date(Date.parse(at) + now - Date.parse(WORKFLOW_NOW)).toISOString();
  const ids = new Map(fixture.records.map((record) => [record.id, randomUUID()]));
  const rows = fixture.records.map((record) => {
    const data = { ...record.data };
    for (const key of ["dueItemId", "paymentId"]) if (data[key]) data[key] = ids.get(data[key]);
    for (const key of ["dueDate", "observedAt", "settledAt", "occurredAt"]) if (data[key]) data[key] = shift(data[key]);
    return { ...record, id: ids.get(record.id)!, merchantId, customerId: record.customerId ? ids.get(record.customerId)! : "", data, createdAt: shift(record.createdAt), updatedAt: shift(record.updatedAt) };
  });
  for (let offset = 0; offset < rows.length; offset += 1000) {
    await pool.query(`INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data,created_at,updated_at)
      SELECT x.id,x."merchantId",x.kind,x.name,x.status,x.reference,x."amountKobo",x."customerId",x.data,x."createdAt",x."updatedAt"
      FROM jsonb_to_recordset($1::jsonb) AS x(id text,"merchantId" text,kind text,name text,status text,reference text,"amountKobo" bigint,"customerId" text,data jsonb,"createdAt" timestamptz,"updatedAt" timestamptz)`,
    [JSON.stringify(rows.slice(offset, offset + 1000))]);
  }
  await pool.query("ANALYZE valopay_records");
  return rows.length;
}

let server: Server | undefined;
let background: ReturnType<typeof startBackgroundWorker> | undefined;
try {
  const [lender, other] = (await inWorkspace(request(), response(), listMerchants)).map((merchant) => merchant.id).sort() as [string, string];
  const seeded = await seedLender(lender, CUSTOMERS);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).auth = auth(); (req as any).log = { info() {}, warn() {}, error() {} }; next(); });
  app.use("/api", health);
  app.use("/api", valoPay1);
  server = await new Promise<Server>((resolve) => { const running = app.listen(0, "127.0.0.1", () => resolve(running)); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api`;
  const api = async (path: string, init: { method?: string; body?: unknown; key?: string } = {}) => {
    const answer = await fetch(`${base}/v1${path}?merchantId=${other}`, { method: init.method ?? "GET", headers: { Cookie: `${SANDBOX_COOKIE}=${token}`, "Content-Type": "application/json", ...(init.key ? { "Idempotency-Key": init.key } : {}) }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    return { status: answer.status, body: await answer.json() as any };
  };

  // ---- A long close on the thread, and /api/healthz answering throughout ----
  await makeDue(lender);
  background = startBackgroundWorker({ log: logger, closes: { intervalMs: 60_000, firstDelayMs: 50, onlyMerchantIds: [lender] }, exports: { intervalMs: 250 } });
  // Queued while the close runs, on the sandbox's other lender, so the thread's export worker has it to claim.
  const queued = await api("/exports", { method: "POST", body: { kind: "customers", format: "json" }, key: `background-export-${randomUUID()}` });
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const { probes, skipped } = await probeHealth(`${base}/healthz`);
  loop.disable();
  const pass = probes.at(-1)?.lastRun;
  assert.ok(pass, "the scheduled close finished within three minutes");
  assert.equal(pass.closed, 1, "the thread's pass closed the lender, and the main thread's health answer says so");
  const during = probes.filter((probe) => probe.ticks >= 1 && !probe.lastRun);
  const slowest = Math.max(...during.map((probe) => probe.ms)), stalled = Math.round(loop.max / 1e6);
  // On the main thread's event loop, the close's own work (seconds of it at this size) held up every probe sent
  // meanwhile. A probe here may take a quarter of the pass at most, and never 250 ms; a faster close keeps 100 ms.
  const bound = Math.min(250, Math.max(100, pass.durationMs / 4));
  assert.ok(pass.durationMs >= 300, `the close of ${seeded} records took ${pass.durationMs} ms; the fixture is too small to show a blocked event loop`);
  assert.ok(during.length >= 5, `${during.length} probes were answered while the close ran`);
  assert.ok(slowest < bound, `a health probe during a ${pass.durationMs} ms close took ${Math.round(slowest)} ms`);
  // The loop's delay also counts time the operating system gave the process no CPU, so it gets a wider margin; a
  // close on this loop stalls it for seconds.
  assert.ok(stalled < 1000, `the main thread's event loop stalled for ${stalled} ms during a ${pass.durationMs} ms close`);
  const [close] = await closesOf(lender);
  assert.equal(close?.data.schedule.trigger, "scheduled");
  const threadLines = lines().filter((line) => line.thread === "background");
  assert.ok(threadLines.some((line) => line.event === "scheduler.started"), "the thread's lines are written through the main thread's log");
  assert.deepEqual(threadLines.filter((line) => line.event === "close.run").map((line) => [line.examined, line.closed]), [[1, 1]]);
  assert.ok(lines().some((line) => line.event === "background.started" && line.thread === undefined && line.poolSize === 3), "the main thread logs the thread's start and its pool");

  // ---- The export: claimed and settled by the thread, one audit chain ----
  // The job's row is read without the lender's lock, so this look never holds up the thread's writes to the job. Each
  // storage call is bounded to a minute; without App Storage the first fails at once.
  const statusOf = async (id: string) => (await pool.query<{ status: string }>("SELECT status FROM valopay_records WHERE id=$1", [id])).rows[0]!.status;
  for (let status = String(queued.body.status), give = Date.now() + 150_000; status === "queued" || status === "running"; await delay(250), status = await statusOf(queued.body.id)) {
    assert.ok(Date.now() < give, `the export stayed ${status}`);
  }
  const job = (await api(`/exports/${queued.body.id}`)).body;
  assert.ok(["ready", "failed"].includes(job.status), job.status);
  // A loaded lender does not carry its audit chain (the 23 September audit, item 32): the stored entries are read beside it.
  const chain = (await pool.query<{ data: Record<string, any> }>("SELECT data FROM valopay_records WHERE merchant_id=$1 AND kind='audit'", [other])).rows;
  const actions = chain.filter((entry) => entry.data.objectId === queued.body.id).sort((a, b) => a.data.sequence - b.data.sequence).map((entry) => [entry.data.actor, entry.data.action]);
  assert.deepEqual(actions.slice(-2), [["System · export worker", "export.started"], ["System · export worker", job.status === "ready" ? "export.ready" : "export.failed"]]);
  assert.equal(verifyAuditChain(chain).valid, true, "the thread's export entries keep the lender's audit chain valid");
  assert.ok(lines().some((line) => line.thread === "background" && line.event === "export.job" && line.exportId === queued.body.id));

  // ---- A stop while a close runs: the close finishes, then the thread ends ----
  background.stop();
  await background.settle();
  assert.ok(lines().some((line) => line.event === "background.stopped"));
  await makeDue(lender);
  const cursor = async () => (await pool.query<{ at: string }>("SELECT settings->>'nextCloseAt' AS at FROM valopay_merchants WHERE id=$1", [lender])).rows[0]!.at;
  const dueAt = await cursor();
  background = startBackgroundWorker({ log: logger, closes: { intervalMs: 60_000, firstDelayMs: 50, onlyMerchantIds: [lender] }, exports: null });
  for (const give = Date.now() + 60_000; !await lenderHeld(lender); await delay(10)) assert.ok(Date.now() < give, "the second close never started");
  background.stop();
  await background.settle();
  assert.equal((await closesOf(lender)).length, 2, "the close in progress finished and committed before the thread ended");
  assert.notEqual(await cursor(), dueAt, "and moved the lender's next close on");
  const order = lines().map((line) => line.event).filter((event) => event === "close.run" || event === "background.stopped");
  assert.deepEqual(order.slice(-2), ["close.run", "background.stopped"]);
  background = undefined;
  console.log(`Background worker integration test passed: a ${pass.durationMs} ms scheduled close of ${seeded} records on the thread while ${during.length} health probes from another process answered in at most ${Math.round(slowest)} ms (${skipped} more answered other than 200, and were skipped) and the main event loop stalled at most ${stalled} ms; an export claimed and settled by the thread; and a stop during a close that let it finish.`);
} finally {
  if (background) { background.stop(); await background.settle(); }
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  if (oldDirectory === undefined) delete process.env["PRIVATE_OBJECT_DIR"]; else process.env["PRIVATE_OBJECT_DIR"] = oldDirectory;
  await pool.end();
  rmSync(logFile, { force: true });
}
