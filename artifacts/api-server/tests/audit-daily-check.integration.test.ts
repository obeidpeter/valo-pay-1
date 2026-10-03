import { SANDBOX_COOKIE } from "../src/lib/sandbox-cookie";
// Database-backed test for the daily check of each lender's whole audit chain
// and the audit alert in every daily close (backlog item SWEEP-18, decisions 1
// and 2 of the backlog round). A daily close lists a broken chain the lender
// knows of, naming the entry the overview names. Once a lender's first close
// of the WAT day has committed, the background worker walks its whole chain,
// as verify_audit does, and stores what it found in the same way: the last
// verified entry and the break, or none, which clears a repaired break. A
// catch-up pass that closes several missed business dates walks it once, and a
// pass runs its checks after all its closes, while its budget lasts. The walk
// holds no lock, so a write to the lender never waits for it; a break a write
// recorded after the walk read the chain stays, and so does what verify_audit
// recorded from a walk that began after it. A person's first close of the day
// asks the background worker thread for the check. The overview's alert says
// whether the lender has recorded the break or only this check has found it.
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

if (process.env.VALO_PAY_1_RUN_INTEGRATION !== "1") {
  console.log("Set VALO_PAY_1_RUN_INTEGRATION=1 to check the daily audit check against a disposable PostgreSQL database.");
  process.exit(0);
}
// A placeholder identity key: nothing here reaches the identity provider. The log goes to a file this test reads back.
process.env.CLERK_SECRET_KEY ??= "sk_test_placeholder";
const logFile = join(tmpdir(), `valo-pay-1-audit-check-${process.pid}.log`);
process.env["LOG_FILE"] = logFile;
process.env["LOG_LEVEL"] = "info";
const { pool } = await import("@workspace/valo-pay-1-db");
const { nextCloseInstant } = await import("@workspace/valo-pay-1-schema");
const { default: router } = await import("../src/routes/index");
const { errorHandler } = await import("../src/lib/error-handler");
const { runClosePassOnce, runDueCloses } = await import("../src/lib/close-scheduler");
const { checkAuditChainDaily } = await import("../src/lib/valo-pay-1-store");
const { startBackgroundWorker } = await import("../src/lib/background-worker");
const { logger } = await import("../src/lib/logger");
const { watDate } = await import("../src/domain/calendar");

const quiet = { info() {}, warn() {}, error() {} };
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((req, _res, next) => {
  (req as any).auth = Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true });
  (req as any).log = quiet;
  next();
});
app.use("/api", router);
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const ok = (result: { status: number; data: any }) => { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
type Entry = { id: string; data: Record<string, any>; created_at: Date };
const entriesOf = async (lender: string) => (await pool.query<Entry>("SELECT id,data,created_at FROM valopay_records WHERE merchant_id=$1 AND kind='audit' ORDER BY (data->>'sequence')::int,created_at,id", [lender])).rows;
const settingsOf = async (lender: string) => (await pool.query<{ settings: Record<string, any> }>("SELECT settings FROM valopay_merchants WHERE id=$1", [lender])).rows[0]!.settings;
const chainOf = async (lender: string) => (await settingsOf(lender)).auditChain as Record<string, any>;
const closesOf = async (lender: string) => (await pool.query<{ data: Record<string, any> }>("SELECT data FROM valopay_records WHERE merchant_id=$1 AND kind='closes' ORDER BY created_at,id", [lender])).rows;
const chainAlert = (alerts: Array<{ key: string; severity: string; detail: string }>) => alerts.find((alert) => alert.key === "audit_chain_broken");
const namedEntry = (alert?: { detail: string }) => Number(/Entry (\d+) of the audit log/.exec(alert?.detail ?? "")?.[1]);
const kept = (alert?: { detail: string }) => /This alert stays until a full check finds every entry intact: select Check audit log/.test(alert?.detail ?? "");
const customer = (name: string) => ({ name, reference: `AUDIT-CHECK-${randomUUID()}`, data: { consentProvenance: "Synthetic fixture" } });
const databaseNow = async () => Date.parse((await pool.query<{ now: Date }>("SELECT now() AS now")).rows[0]!.now.toISOString());
const setCursor = (lender: string, at: string) => pool.query("UPDATE valopay_merchants SET settings = settings || jsonb_build_object('nextCloseAt', $2::text) WHERE id=$1", [lender, at]);
const changeSummary = (id: string, summary: string) => pool.query("UPDATE valopay_records SET data=jsonb_set(data,'{summary}',to_jsonb($2::text)) WHERE id=$1", [id, summary]);
/** A caller of its own sandbox, with the lender it opens on. */
const sandbox = async () => {
  const cookie = `${SANDBOX_COOKIE}=${randomBytes(32).toString("hex")}`;
  const call = async (path: string, method = "GET", body?: unknown, key?: string) => {
    const answer = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie, ...(key ? { "Idempotency-Key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: answer.status, data: (await answer.json()) as any };
  };
  const [lender] = ok(await call("/v1/workspace")).merchants.map((merchant: { id: string }) => merchant.id) as [string];
  lenders.push(lender);
  const at = (path: string) => `${path}${path.includes("?") ? "&" : "?"}merchantId=${lender}`;
  return {
    lender,
    overview: async () => ok(await call(at("/v1/overview"))),
    write: async (name: string) => ok(await call(at("/v1/records/customers"), "POST", customer(name), randomUUID())),
    close: async () => ok(await call(at("/v1/actions"), "POST", { action: "daily_close", reason: "Close the synthetic day" }, randomUUID())),
    verify: async () => ok(await call(at("/v1/actions"), "POST", { action: "verify_audit", reason: "Check the synthetic audit log" }, randomUUID())).data,
  };
};
const lenders: string[] = [];

// The walk of a whole chain is the audit read from the chain's start ($5 = 0). `walks` counts them; `pause`, when set, holds
// the next walk after it has read its entries until it resolves (a walk after that one runs on), and `reached` says it got there.
let walks = 0, pause: Promise<void> | undefined, reached: (() => void) | undefined;
const probe = await pool.connect();
probe.release();
const clients = Object.getPrototypeOf(probe) as { query: (this: unknown, ...args: any[]) => any };
const query = clients.query;
clients.query = function (this: unknown, ...args: any[]) {
  const result = query.apply(this, args);
  if (typeof args[0] !== "string" || !/r\.kind='audit'/.test(args[0]) || !/make_interval\(mins =>/.test(args[0]) || args[1]?.[4] !== 0 || typeof result?.then !== "function") return result;
  walks += 1;
  const held = pause;
  pause = undefined;
  return held ? result.then(async (answer: unknown) => { reached?.(); await held; return answer; }) : result;
};

// The lenders a person's close asked the background worker thread to check (requestDailyAuditCheck).
const asked: string[] = [];
const post = Worker.prototype.postMessage;
Worker.prototype.postMessage = function (this: Worker, message: any, ...rest: any[]) {
  if (message?.type === "audit_check") asked.push(message.merchantId);
  return (post as (...args: any[]) => void).call(this, message, ...rest);
};

let checks = 0;
try {
  // ---- 1. A daily close lists the break the lender knows of, naming the entry the overview names ----
  {
    const { lender, overview, write, close } = await sandbox();
    for (let index = 0; index < 4; index++) await write(`Close alert customer ${index}`);
    const head = (await entriesOf(lender)).at(-1)!;
    await changeSummary(head.id, "Rewritten after the fact");
    const found = chainAlert((await overview()).alerts);
    assert.deepEqual([namedEntry(found), kept(found)], [head.data.sequence, false], "the overview names the changed head, a break no completed change has recorded yet");
    await close();
    const [closed] = (await closesOf(lender)).slice(-1);
    const frozen = chainAlert(closed!.data.report.alerts);
    assert.deepEqual([frozen?.severity, namedEntry(frozen), kept(frozen)], ["critical", head.data.sequence, true], "the daily close lists the broken chain, naming the same entry, which its own write records");
    assert.equal((await chainOf(lender)).broken?.sequence, head.data.sequence, "the close recorded the break");
    const after = chainAlert((await overview()).alerts);
    assert.deepEqual([namedEntry(after), kept(after)], [head.data.sequence, true], "and the overview now says the lender keeps it");
    checks += 5;
  }

  // ---- 2. The scheduled close's check of the whole chain, after the pass's closes, stores what verify_audit would ----
  const catchUp = await sandbox();
  let changed: Entry | undefined;
  {
    const { lender, overview, write, close, verify } = catchUp;
    for (let index = 0; index < 4; index++) await write(`Daily check customer ${index}`);
    changed = (await entriesOf(lender))[1]!;
    assert.equal(changed.data.sequence, 2);
    await changeSummary(changed.id, "Rewritten long ago");
    assert.equal(chainAlert((await overview()).alerts), undefined, "a change before the last verified entry is not read by the overview");
    // Four scheduled times have passed: four missed business dates, one catch-up close a pass (or a person's close).
    await setCursor(lender, nextCloseInstant((await databaseNow()) - 96 * 60 * 60 * 1000, "07:00"));
    walks = 0;
    const pass = await runDueCloses({ batchSize: 5, onlyMerchantIds: [lender] });
    assert.deepEqual(pass.closed.map((item) => item.merchantId), [lender], "the pass closes the oldest missed date");
    assert.equal(walks, 1, "and walks the whole chain once");
    const [first] = await closesOf(lender);
    assert.equal(chainAlert(first!.data.report.alerts), undefined, "the close could not know of the break: its check reads only the entries since the last verified one");
    const stored = await chainOf(lender), settings = await settingsOf(lender);
    assert.deepEqual([stored.broken, stored.verified.sequence, stored.verified.hash], [{ sequence: 2 }, 1, (await entriesOf(lender))[0]!.data.hash], "the check after it recorded the break and the entry before it");
    assert.equal(watDate(Date.parse(settings.dailyAuditCheckAt)), watDate(await databaseNow()), "and the day it ran");
    const reported = chainAlert((await overview()).alerts);
    assert.deepEqual([namedEntry(reported), kept(reported)], [2, true], "from then on the overview names the changed entry");
    // verify_audit, the check a person runs, records the same point and break.
    assert.equal((await verify()).valid, false);
    assert.deepEqual([(await chainOf(lender)).verified, (await chainOf(lender)).broken], [stored.verified, stored.broken], "verify_audit records what the daily check recorded");
    await close();
    const [manual] = (await closesOf(lender)).slice(-1);
    assert.deepEqual([manual!.data.schedule.scheduledFor !== null, namedEntry(chainAlert(manual!.data.report.alerts)), kept(chainAlert(manual!.data.report.alerts))], [true, 2, true], "and the next close, a person's catch-up of the next missed date, lists it");
    checks += 11;
  }

  // ---- 3. Once a day: the catch-up closes of the other missed dates, and a person's close, do not walk it again ----
  {
    const { lender, close } = catchUp;
    const checkedAt = (await settingsOf(lender)).dailyAuditCheckAt;
    walks = 0;
    for (let pass = 2; pass <= 3; pass += 1) assert.deepEqual((await runDueCloses({ batchSize: 5, onlyMerchantIds: [lender] })).closed.map((item) => item.merchantId), [lender], `pass ${pass} closes the next missed date`);
    assert.equal((await runDueCloses({ batchSize: 5, onlyMerchantIds: [lender] })).examined, 0, "caught up");
    await close();
    assert.equal(walks, 0, "none of them walks the chain again the same day");
    assert.equal((await settingsOf(lender)).dailyAuditCheckAt, checkedAt, "the day's check stands");
    // The check itself, asked again the same day (the thread may be asked twice before the first check records), walks nothing.
    assert.equal(await checkAuditChainDaily(lender), undefined);
    assert.equal(walks, 0, "a check asked again the same day walks nothing");
    checks += 6;
  }

  // ---- 4. The next day's check clears a repaired break, as verify_audit does (here from the one-shot close pass) ----
  {
    const { lender, overview } = catchUp;
    await pool.query("UPDATE valopay_records SET data=$2 WHERE id=$1", [changed!.id, changed!.data]);
    assert.equal(namedEntry(chainAlert((await overview()).alerts)), 2, "a repair leaves the recorded break until a check of the whole chain");
    const yesterday = new Date((await databaseNow()) - 24 * 60 * 60 * 1000).toISOString();
    await pool.query("UPDATE valopay_merchants SET settings = settings || jsonb_build_object('dailyAuditCheckAt', $2::text) WHERE id=$1", [lender, yesterday]);
    await setCursor(lender, new Date((await databaseNow()) - 60 * 60 * 1000).toISOString());
    walks = 0;
    const oneShot = await runClosePassOnce({ onlyMerchantIds: [lender] });
    assert.deepEqual([oneShot.exitCode, oneShot.run?.closed.length, walks], [0, 1, 1], "the one-shot pass closes and walks the chain once");
    const entries = await entriesOf(lender), stored = await chainOf(lender);
    assert.deepEqual([stored.broken, stored.verified.sequence], [undefined, entries.at(-1)!.data.sequence], "the repaired chain holds, and every entry is verified");
    assert.equal(chainAlert((await overview()).alerts), undefined, "so the alert clears");
    checks += 5;
  }

  // ---- 5. The walk holds no lock; a break a write recorded after the walk read the chain stays ----
  {
    const { lender, overview, write } = await sandbox();
    for (let index = 0; index < 3; index++) await write(`Lock-free customer ${index}`);
    await setCursor(lender, new Date((await databaseNow()) - 60 * 60 * 1000).toISOString());
    let release!: () => void;
    const atWalk = new Promise<void>((resolve) => { reached = resolve; });
    pause = new Promise<void>((resolve) => { release = resolve; });
    const passing = runDueCloses({ batchSize: 5, onlyMerchantIds: [lender] });
    try {
      await Promise.race([atWalk, new Promise((_, reject) => setTimeout(() => reject(new Error("the pass never walked the chain")), 20_000))]);
      // The close's own entry, which the walk has read intact, is changed, and a write while the walk runs finds it.
      const closeEntry = (await entriesOf(lender)).at(-1)!;
      assert.equal(closeEntry.data.action, "daily_close");
      await changeSummary(closeEntry.id, "Rewritten while the check ran");
      const started = Date.now();
      await Promise.race([write("Written while the check walks the chain"), new Promise((_, reject) => setTimeout(() => reject(new Error("the write waited for the walk")), 5_000))]);
      assert.ok(Date.now() - started < 5_000, "a write does not wait for the walk");
      assert.equal((await chainOf(lender)).broken?.sequence, closeEntry.data.sequence, "the write recorded the break it found");
      release();
      assert.equal((await passing).closed.length, 1);
      const stored = await chainOf(lender);
      assert.deepEqual([stored.broken?.sequence, typeof (await settingsOf(lender)).dailyAuditCheckAt], [closeEntry.data.sequence, "string"], "the walk, which read that entry before it changed, does not clear the newer break");
      assert.equal(namedEntry(chainAlert((await overview()).alerts)), closeEntry.data.sequence, "and the overview still names it");
      checks += 6;
    } finally { pause = undefined; reached = undefined; release?.(); await passing.catch(() => undefined); }
  }

  // ---- 6. What verify_audit records after the walk began reading stands, whichever way it went ----
  for (const recorded of [false, true]) {
    const { lender, overview, write, verify } = await sandbox();
    for (let index = 0; index < 3; index++) await write(`Later walk customer ${index}`);
    const second = (await entriesOf(lender))[1]!;
    const repair = () => pool.query("UPDATE valopay_records SET data=$2 WHERE id=$1", [second.id, second.data]);
    await changeSummary(second.id, "Rewritten before the walk");
    // Recorded: the lender keeps the break verify_audit found, and the entry is repaired before the walk reads it.
    if (recorded) { assert.equal((await verify()).valid, false); await repair(); }
    await setCursor(lender, new Date((await databaseNow()) - 60 * 60 * 1000).toISOString());
    let release!: () => void;
    const atWalk = new Promise<void>((resolve) => { reached = resolve; });
    pause = new Promise<void>((resolve) => { release = resolve; });
    const passing = runDueCloses({ batchSize: 5, onlyMerchantIds: [lender] });
    try {
      await Promise.race([atWalk, new Promise((_, reject) => setTimeout(() => reject(new Error("the pass never walked the chain")), 20_000))]);
      // While the walk that read entry 2 (changed, or repaired) runs, the entry is repaired (or changed again) and a person checks the whole chain.
      if (recorded) await changeSummary(second.id, "Rewritten again while the check ran"); else await repair();
      assert.equal((await verify()).valid, !recorded);
      const later = await chainOf(lender);
      assert.deepEqual(later.broken, recorded ? { sequence: 2 } : undefined, "verify_audit records what it found");
      release();
      assert.equal((await passing).closed.length, 1);
      const stored = await chainOf(lender);
      assert.deepEqual([stored.broken, stored.verified], [later.broken, later.verified],
        recorded ? "the check, which read entry 2 before it changed again, leaves the break verify_audit recorded since" : "the check, which read entry 2 before its repair, leaves the break verify_audit cleared since");
      assert.deepEqual([typeof stored.walkedAt, stored.walkedAt, typeof (await settingsOf(lender)).dailyAuditCheckAt], ["string", later.walkedAt, "string"], "the lender keeps when verify_audit walked the chain, and that the day's check ran");
      if (recorded) await write("Written after the check");
      const alert = chainAlert((await overview()).alerts);
      assert.deepEqual([namedEntry(alert), kept(alert)], recorded ? [2, true] : [Number.NaN, false], recorded ? "so the overview still names the entry, after a later write too" : "so the overview shows no alert");
      checks += 6;
    } finally { pause = undefined; reached = undefined; release?.(); await passing.catch(() => undefined); }
  }

  // ---- 7. A person's first close of the day asks the background worker thread for the day's check ----
  for (const closes of [null, { intervalMs: 3_600_000, firstDelayMs: 3_600_000, onlyMerchantIds: [] as string[] }]) {
    const { lender, write, close } = await sandbox();
    for (let index = 0; index < 3; index++) await write(`Background check customer ${index}`);
    const second = (await entriesOf(lender))[1]!;
    await changeSummary(second.id, "Rewritten before the close");
    const worker = startBackgroundWorker({ log: logger, closes, exports: null });
    try {
      await close();
      let settings = await settingsOf(lender);
      for (const until = Date.now() + 30_000; !settings.dailyAuditCheckAt && Date.now() < until;) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        settings = await settingsOf(lender);
      }
      assert.deepEqual([settings.auditChain.broken, settings.auditChain.verified.sequence], [{ sequence: 2 }, 1], `the thread${closes ? "'s scheduler" : ""} walked the chain after the close and recorded the break`);
      // Another close by a person the same day does not ask the thread again.
      await close();
      assert.equal(asked.filter((id) => id === lender).length, 1, "the day's first close by a person asks for the check, and a later one that day does not");
    } finally {
      worker.stop();
      await worker.settle();
    }
    const line = readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((text) => JSON.parse(text)).find((entry) => entry.event === "audit.daily_check" && entry.merchantId === lender);
    assert.deepEqual([line?.valid, line?.brokenAt, line?.thread, line?.level], [false, 2, "background", 50], "and logged it as a broken chain");
    checks += 3;
  }

  // ---- 8. A pass checks after all its closes, while its budget lasts; the checks it leaves wait for its next pass ----
  {
    const pair = [await sandbox(), await sandbox()], ids = pair.map(({ lender }) => lender);
    for (const { write } of pair) await write("Budget customer");
    const closedBefore = await Promise.all(ids.map(async (lender) => (await closesOf(lender)).length));
    const due = new Date((await databaseNow()) - 60 * 60 * 1000).toISOString();
    for (const lender of ids) await setCursor(lender, due);
    const queued = new Set<string>(), budgetMs = 6_000;
    let release!: () => void;
    const atWalk = new Promise<void>((resolve) => { reached = resolve; });
    pause = new Promise<void>((resolve) => { release = resolve; });
    const passing = runDueCloses({ batchSize: 5, budgetMs, onlyMerchantIds: ids, auditChecks: queued, log: logger });
    const started = Date.now();
    try {
      await Promise.race([atWalk, new Promise((_, reject) => setTimeout(() => reject(new Error("the pass never walked a chain")), 20_000))]);
      const closed = await Promise.all(ids.map(async (lender) => (await closesOf(lender)).length));
      assert.deepEqual(closed, closedBefore.map((count) => count + 1), "both lenders' closes committed before the first check walked a chain");
      // The first check outlasts the pass's budget, so the pass starts no other.
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, budgetMs + 200 - (Date.now() - started))));
      release();
      const run = await passing;
      assert.equal(run.closed.length, 2);
      const checkedAt = await Promise.all(ids.map(async (lender) => (await settingsOf(lender)).dailyAuditCheckAt));
      const left = ids.filter((_, index) => checkedAt[index] === undefined);
      assert.deepEqual([checkedAt.filter(Boolean).length, [...queued]], [1, left], "the pass ran one check and left the other in the set");
      const summary = readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((text) => JSON.parse(text)).find((entry) => entry.event === "close.run" && entry.runId === run.runId);
      assert.deepEqual([summary?.closed, summary?.auditChecksLeft], [2, 1], "and its close.run line says so");
      const next = await runDueCloses({ batchSize: 5, onlyMerchantIds: ids, auditChecks: queued });
      assert.deepEqual([next.examined, queued.size, typeof (await settingsOf(left[0]!)).dailyAuditCheckAt], [0, 0, "string"], "the next pass, with nothing to close, runs it");
      checks += 5;
    } finally { pause = undefined; reached = undefined; release?.(); await passing.catch(() => undefined); }
  }
} finally {
  clients.query = query;
  Worker.prototype.postMessage = post;
  server.close();
  await once(server, "close");
  for (const lender of lenders) {
    const row = (await pool.query<{ workspace_id: string }>("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [lender])).rows[0];
    if (!row) continue;
    for (const table of ["valopay_idempotency", "valopay_operations", "valopay_records"]) await pool.query(`DELETE FROM ${table} WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)`, [row.workspace_id]);
    await pool.query("DELETE FROM valopay_merchants WHERE workspace_id=$1", [row.workspace_id]);
    await pool.query("DELETE FROM valopay_workspaces WHERE id=$1", [row.workspace_id]);
  }
  await pool.end();
  rmSync(logFile, { force: true });
}
console.log(`Daily audit check tests passed (${checks} checks): a daily close lists the break the lender knows of, naming the overview's entry; the check of the whole chain after a lender's first close of the day records what verify_audit would, once a day however many missed dates a catch-up closes, and clears a repaired break the next day; its walk holds no lock and leaves a break recorded since, and what verify_audit recorded since; a person's first close of the day asks the background worker thread for it; and a pass checks after all its closes, while its budget lasts.`);
