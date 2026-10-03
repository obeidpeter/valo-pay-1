import { SANDBOX_COOKIE } from "../src/lib/sandbox-cookie";
// A lender's history stays out of what each request loads (audit of 23
// September 2026, item 32, decisions 6 and 8), against a real database. The
// audit chain is kept in valopay_records but is not part of a loaded state: a
// write continues it from the head in the lender's settings, verifying the
// entries since the last verified one, so an entry another writer appended
// without moving the head is followed, never forked, and the export worker's
// claim reads the head only once it holds the lender. The overview checks the
// chain from that point and shows the eight latest entries; verify_audit
// checks it whole and records how far it held. A break (a fork, a gap, a
// changed entry, an entry whose sequence is not a whole number, which is a
// break at its place and hides no fork) that a completed write or verify_audit
// records is kept for the lender, so it stays reported until a walk of the
// whole chain finds it valid again (verify_audit here; the daily check is in
// audit-daily-check), and each later check reads only the entries since the
// head.
// Every load has earlier closes as summaries, settings read only the latest
// close, the records list has every close as its summary, and a list of a kind
// that grows with history is capped when it names no limit.
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";

if (process.env.VALO_PAY_1_RUN_INTEGRATION !== "1") {
  console.log("Set VALO_PAY_1_RUN_INTEGRATION=1 to check a lender's history against a disposable PostgreSQL database.");
  process.exit(0);
}
// A placeholder identity key: nothing here reaches the identity provider.
process.env.CLERK_SECRET_KEY ??= "sk_test_placeholder";
const { pool } = await import("@workspace/valo-pay-1-db");
const { default: router } = await import("../src/routes/index");
const { errorHandler } = await import("../src/lib/error-handler");
const store = await import("../src/lib/valo-pay-1-store");
const { auditEntryData, verifyAuditChain } = await import("../src/lib/digests");
const { exportJobRepository } = await import("../src/lib/export-job-store");

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
const cookie = `${SANDBOX_COOKIE}=${randomBytes(32).toString("hex")}`;
async function call(path: string, method = "GET", body?: unknown, key?: string) {
  const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie, ...(key ? { "Idempotency-Key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: (await response.json()) as any };
}
const ok = (result: { status: number; data: any }) => { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
const sandboxRequest = () => ({ headers: { cookie }, query: {}, secure: false, log: quiet, auth: Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true }) }) as any;
const response = { cookie() {} } as any;
type Entry = { id: string; data: Record<string, any>; created_at: Date };
const entriesOf = async (lender: string) => (await pool.query<Entry>("SELECT id,data,created_at FROM valopay_records WHERE merchant_id=$1 AND kind='audit' ORDER BY (data->>'sequence')::int,created_at,id", [lender])).rows;
const chainOf = async (lender: string) => (await pool.query<{ chain: Record<string, any> | null }>("SELECT settings->'auditChain' AS chain FROM valopay_merchants WHERE id=$1", [lender])).rows[0]!.chain;
const customer = (name: string) => ({ name, reference: `HISTORY-${randomUUID()}`, data: { consentProvenance: "Synthetic fixture" } });
const brokenAlert = (overview: any) => overview.alerts.some((alert: { key: string }) => alert.key === "audit_chain_broken");
// The entry the audit_chain_broken alert says the check stopped at (NaN without the alert).
const brokenEntry = (overview: any) => Number(/Entry (\d+) of the audit log/.exec(overview.alerts.find((alert: { key: string }) => alert.key === "audit_chain_broken")?.detail ?? "")?.[1]);
/** A caller of another sandbox of this run, with a cookie of its own. */
const sandboxCaller = () => {
  const own = `${SANDBOX_COOKIE}=${randomBytes(32).toString("hex")}`;
  return async (path: string, method = "GET", body?: unknown, key?: string) => {
    const answer = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Cookie: own, ...(key ? { "Idempotency-Key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: answer.status, data: (await answer.json()) as any };
  };
};
/** Removes the workspace of a lender a section made, with everything in it. */
const removeWorkspaceOf = async (merchantId: string) => {
  const row = (await pool.query<{ workspace_id: string }>("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [merchantId])).rows[0];
  if (!row) return;
  for (const table of ["valopay_idempotency", "valopay_operations", "valopay_records"]) await pool.query(`DELETE FROM ${table} WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)`, [row.workspace_id]);
  await pool.query("DELETE FROM valopay_merchants WHERE workspace_id=$1", [row.workspace_id]);
  await pool.query("DELETE FROM valopay_workspaces WHERE id=$1", [row.workspace_id]);
};
/** Stores an audit entry directly, as another writer (or a tampering one) would have. */
const insertEntry = async (merchantId: string, data: Record<string, any>) => {
  const id = randomUUID();
  await pool.query("INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data) VALUES($1,$2,'audit',$3,'recorded','',0,'',$4)", [id, merchantId, data.action, data]);
  return id;
};
let workspaceId: string | undefined;
let checks = 0;
try {
  const [lender, other] = ok(await call("/v1/workspace")).merchants.map((merchant: { id: string }) => merchant.id) as [string, string];
  workspaceId = (await pool.query("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [lender])).rows[0].workspace_id;
  const q = (path: string, merchantId = lender) => `${path}${path.includes("?") ? "&" : "?"}merchantId=${merchantId}`;
  const verify = async (merchantId = lender) => ok(await call(q("/v1/actions", merchantId), "POST", { action: "verify_audit", reason: "Check the synthetic audit log" }, randomUUID())).data;

  // ---- 1. The chain is not loaded; a write continues it from the head kept on the lender ----
  {
    const seeded = await chainOf(lender);
    assert.equal(seeded?.sequence, 1, "a new lender's settings carry the head of its first entry");
    for (let index = 0; index < 10; index++) ok(await call(q("/v1/records/customers"), "POST", customer(`History customer ${index}`), randomUUID()));
    const entries = await entriesOf(lender), head = entries.at(-1)!;
    assert.deepEqual(verifyAuditChain(entries), { valid: true, count: 11, headHash: head.data.hash }, "eleven entries, one chain");
    const chain = await chainOf(lender);
    assert.deepEqual([chain?.sequence, chain?.hash, chain?.at], [11, head.data.hash, head.created_at.toISOString()], "the lender keeps the chain's head");
    assert.deepEqual([chain?.verified.sequence, chain?.verified.hash], [10, entries.at(-2)!.data.hash], "and the last entry a write read back and verified");
    const loaded = await store.inWorkspace(sandboxRequest(), response, (ctx) => store.loadState(ctx, lender, "share"), "read");
    assert.equal(loaded.records.some((record) => record.kind === "audit"), false, "a read loads none of the chain");
    const written = await store.inWorkspace({ ...sandboxRequest(), query: { merchantId: lender } }, response, async (ctx) => {
      const state = await store.loadState(ctx, lender);
      return state.records.some((record) => record.kind === "audit");
    });
    assert.equal(written, false, "nor does a write");
    checks += 6;
  }

  // ---- 2. The overview shows the eight latest entries, newest first, and checks the chain from the last verified entry ----
  {
    const overview = ok(await call(q("/v1/overview")));
    const latest = (await pool.query<{ id: string }>("SELECT id FROM valopay_records WHERE merchant_id=$1 AND kind='audit' ORDER BY created_at DESC,id LIMIT 8", [lender])).rows.map((row) => row.id);
    assert.deepEqual(overview.activity.map((entry: { id: string }) => entry.id), latest, "the activity is the eight latest entries, read with a bounded query");
    assert.equal(overview.activity[0].data.sequence, 11);
    assert.equal(brokenAlert(overview), false);
    checks += 3;
  }

  // ---- 3. An entry appended without moving the stored head (the export worker, an earlier build) is followed, never forked ----
  {
    const [head] = (await entriesOf(lender)).slice(-1);
    const data = auditEntryData({ sequence: 12, actor: "System · export worker", action: "export.started", objectId: "history-export", summary: "Appended without moving the stored head.", previousHash: head!.data.hash, timestamp: new Date().toISOString() });
    await pool.query("INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data) VALUES($1,$2,'audit',$3,'recorded','',0,'',$4)", [randomUUID(), lender, data.action, data]);
    assert.equal((await chainOf(lender))?.sequence, 11, "the stored head did not move");
    assert.equal(brokenAlert(ok(await call(q("/v1/overview")))), false, "the overview follows the entry");
    ok(await call(q("/v1/records/customers"), "POST", customer("After an entry from elsewhere"), randomUUID()));
    const entries = await entriesOf(lender);
    assert.deepEqual(entries.map((entry) => entry.data.sequence), Array.from({ length: 13 }, (_, index) => index + 1), "the write took the next sequence after it");
    assert.deepEqual(verifyAuditChain(entries), { valid: true, count: 13, headHash: entries.at(-1)!.data.hash });
    assert.deepEqual(await verify(), { valid: true, count: 13, headHash: entries.at(-1)!.data.hash }, "verify_audit checks the whole stored chain");
    checks += 5;
  }

  // ---- 4. A change to a recent entry shows at once; one before the last verified entry only once the whole chain is checked ----
  {
    for (let index = 0; index < 3; index++) ok(await call(q("/v1/records/customers", other), "POST", customer(`Other lender customer ${index}`), randomUUID()));
    assert.equal(brokenAlert(ok(await call(q("/v1/overview", other)))), false);
    const [second] = (await entriesOf(other)).filter((entry) => entry.data.sequence === 2);
    await pool.query("UPDATE valopay_records SET data=jsonb_set(data,'{summary}','\"Rewritten after the fact\"') WHERE id=$1", [second!.id]);
    assert.equal(brokenAlert(ok(await call(q("/v1/overview", other)))), false, "an entry before the last verified one is not re-read by the overview");
    const checked = await verify(other);
    assert.deepEqual([checked.valid, checked.count, checked.headHash], [false, 4, (await entriesOf(other))[0]!.data.hash], "verify_audit walks the whole chain and stops at the changed entry");
    const overview = ok(await call(q("/v1/overview", other)));
    assert.equal(brokenAlert(overview), true, "from then on the overview reports the break, from the point the chain held to");
    assert.equal(brokenEntry(overview), 2, "naming the changed entry, the one after the last verified entry, not the one after the last entry counted");
    assert.equal((await chainOf(other))?.verified.sequence, 1, "the lender records how far the chain held");
    ok(await call(q("/v1/records/customers", other), "POST", customer("Written on a broken chain"), randomUUID()));
    const later = ok(await call(q("/v1/overview", other)));
    assert.equal(brokenAlert(later), true, "and a later write does not hide it");
    assert.equal(brokenEntry(later), 2, "nor moves the entry the alert names");
    checks += 8;
  }

  // ---- 5. A missing latest entry is a break, and its sequence is not issued again ----
  {
    const before = await entriesOf(lender), last = before.at(-1)!;
    await pool.query("DELETE FROM valopay_records WHERE id=$1", [last.id]);
    const missing = ok(await call(q("/v1/overview")));
    assert.equal(brokenAlert(missing), true, "the stored head is further on than any entry");
    assert.equal(brokenEntry(missing), last.data.sequence, "the alert names the missing entry");
    ok(await call(q("/v1/records/customers"), "POST", customer("After a deleted entry"), randomUUID()));
    const after = await entriesOf(lender);
    assert.equal(after.at(-1)!.data.sequence, last.data.sequence + 1, "the next entry follows the stored head");
    assert.equal(verifyAuditChain(after).valid, false);
    assert.equal((await verify()).valid, false);
    checks += 5;
  }

  // ---- 6. A lender with no stored position (an earlier build's) is checked whole, and its first write records it ----
  {
    const token = randomBytes(32).toString("hex"), legacyCookie = `${SANDBOX_COOKIE}=${token}`;
    const legacyCall = async (path: string, method = "GET", body?: unknown, key?: string) => {
      const answer = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Cookie: legacyCookie, ...(key ? { "Idempotency-Key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: answer.status, data: (await answer.json()) as any };
    };
    const [legacy] = ok(await legacyCall("/v1/workspace")).merchants.map((merchant: { id: string }) => merchant.id) as [string];
    try {
      await pool.query("UPDATE valopay_merchants SET settings=settings-'auditChain' WHERE id=$1", [legacy]);
      assert.equal(brokenAlert(ok(await legacyCall(`/v1/overview?merchantId=${legacy}`))), false, "the overview checks a chain without a stored position from its first entry");
      ok(await legacyCall(`/v1/records/customers?merchantId=${legacy}`, "POST", customer("First write after the upgrade"), randomUUID()));
      const chain = await chainOf(legacy), entries = await entriesOf(legacy);
      assert.deepEqual([chain?.sequence, chain?.verified.sequence, verifyAuditChain(entries).valid], [2, 1, true], "the first write records where the chain stands");
    } finally {
      const legacyWorkspace = (await pool.query("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [legacy])).rows[0].workspace_id;
      for (const table of ["valopay_idempotency", "valopay_operations", "valopay_records"]) await pool.query(`DELETE FROM ${table} WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)`, [legacyWorkspace]);
      await pool.query("DELETE FROM valopay_merchants WHERE workspace_id=$1", [legacyWorkspace]);
      await pool.query("DELETE FROM valopay_workspaces WHERE id=$1", [legacyWorkspace]);
    }
    checks += 2;
  }

  // ---- 7. Every load has earlier closes as summaries; settings read only the latest close; the close history opens any close whole ----
  {
    const report = { unallocated: { count: 1, kobo: 5, olderThan24Hours: 0 }, exceptions: { openAtClose: 2, overdueAtClose: 1 }, customerPositionsChanged: Array.from({ length: 100 }, (_, index) => ({ customerId: `c${index}`, note: "x".repeat(100) })) };
    for (const [suffix, days] of [["old", 40], ["latest", 0]] as const) {
      await pool.query("INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data,created_at,updated_at) VALUES($1,$2,'closes',$1,'completed','',0,'',$3,now()-make_interval(days=>$4),now()-make_interval(days=>$4))",
        [`${lender}-history-${suffix}`, lender, { summary: suffix, closedAt: new Date(Date.now() - days * 86_400_000).toISOString(), report, operational: { rows: 1 }, synthetic: true }, days]);
    }
    const reports = ok(await call(q("/v1/reports")));
    const old = reports.closes.find((close: { id: string }) => close.id === `${lender}-history-old`);
    assert.deepEqual([old.data.report.customerPositionsChanged, old.data.operational, old.data.report.unallocated], [undefined, undefined, report.unallocated], "a read has an earlier close as its summary");
    assert.equal(reports.closes.find((close: { id: string }) => close.id === `${lender}-history-latest`).data.report.customerPositionsChanged.length, 100, "and the latest week's whole");
    assert.equal(ok(await call(q(`/v1/close-history/${lender}-history-old`))).data.report.customerPositionsChanged.length, 100, "the close history opens it whole");
    // The records list has every close as its summary, as the reports read closes: whole, a year of them was 34.8 MB.
    const listed = ok(await call(q("/v1/records/closes"))).items.filter((close: { id: string }) => close.id.startsWith(`${lender}-history-`));
    assert.deepEqual(listed.map((close: any) => [close.id, close.data.summary, close.data.report.customerPositionsChanged, close.data.operational, close.data.report.unallocated]),
      [[`${lender}-history-latest`, "latest", undefined, undefined, report.unallocated], [`${lender}-history-old`, "old", undefined, undefined, report.unallocated]], "the records list has each close as its summary, the latest included");
    assert.equal(ok(await call(q(`/v1/records/closes?id=${lender}-history-latest`))).items[0].data.report.customerPositionsChanged, undefined, "and so does a list of one close");
    assert.equal(ok(await call(q(`/v1/close-history/${lender}-history-latest`))).data.report.customerPositionsChanged.length, 100, "which the close history opens whole");
    const settings = await store.inWorkspace(sandboxRequest(), response, (ctx) => store.loadSettingsView(ctx, lender), "read");
    assert.deepEqual(settings.records.filter((record) => record.kind === "closes").map((record) => record.id), [`${lender}-history-latest`], "settings read only the latest close");
    assert.equal(ok(await call(q("/v1/settings"))).closeSchedule.lastAt, new Date(Date.parse(reports.closes.find((close: { id: string }) => close.id === `${lender}-history-latest`).data.closedAt)).toISOString(), "and still show when it ran");
    checks += 8;
  }

  // ---- 8. A list of a kind that grows with history is capped without a limit; other kinds are not ----
  {
    const at = Date.now();
    await pool.query(`INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data,created_at,updated_at)
      SELECT $1||'-notice-'||i,$2,'notifications','Synthetic notice '||i,'submitted','',0,'','{"synthetic":true}',to_timestamp(($3::bigint-i*1000)/1000.0),to_timestamp(($3::bigint-i*1000)/1000.0) FROM generate_series(1,520) i`, [lender, lender, at]);
    const capped = ok(await call(q("/v1/records/notifications")));
    assert.deepEqual([capped.items.length, capped.total, capped.nextOffset], [500, 520, 500], "the newest 500, the total and where to go on");
    const rest = ok(await call(q("/v1/records/notifications?offset=500")));
    assert.deepEqual([rest.items.length, rest.nextOffset], [20, undefined], "the next page holds the rest");
    const customers = ok(await call(q("/v1/records/customers")));
    assert.equal(customers.items.length, customers.total, "a kind that grows with the book returns its whole filtered set");
    checks += 3;
  }

  // ---- 9. The export worker's entries follow the stored head as a request's do: a missing entry's sequence is never issued again ----
  {
    const workerCookie = `${SANDBOX_COOKIE}=${randomBytes(32).toString("hex")}`, directory = process.env.PRIVATE_OBJECT_DIR;
    const workerCall = async (path: string, method = "GET", body?: unknown, key?: string) => {
      const answer = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Cookie: workerCookie, ...(key ? { "Idempotency-Key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: answer.status, data: (await answer.json()) as any };
    };
    const [target] = ok(await workerCall("/v1/workspace")).merchants.map((merchant: { id: string }) => merchant.id) as [string];
    process.env.PRIVATE_OBJECT_DIR = "/private/synthetic-history-tests";
    try {
      const job = ok(await workerCall(`/v1/exports?merchantId=${target}`, "POST", { kind: "gate-pack", format: "json" }, randomUUID()));
      const queued = (await entriesOf(target)).at(-1)!;
      assert.equal((await chainOf(target))?.sequence, queued.data.sequence, "the queued export's entry is the stored head");
      await pool.query("DELETE FROM valopay_records WHERE id=$1", [queued.id]);
      assert.ok(await exportJobRepository.claim(target, job.id), "the export worker claims the job");
      const started = (await entriesOf(target)).at(-1)!;
      assert.deepEqual([started.data.action, started.data.sequence, started.data.previousHash], ["export.started", queued.data.sequence + 1, queued.data.hash], "its entry follows the stored head, not the entry before the missing one");
      assert.equal(verifyAuditChain(await entriesOf(target)).valid, false, "so the gap stays in the chain");
      assert.equal(brokenAlert(ok(await workerCall(`/v1/overview?merchantId=${target}`))), true, "and the overview reports it");
    } finally {
      if (directory === undefined) delete process.env.PRIVATE_OBJECT_DIR; else process.env.PRIVATE_OBJECT_DIR = directory;
      const targetWorkspace = (await pool.query("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [target])).rows[0].workspace_id;
      for (const table of ["valopay_idempotency", "valopay_operations", "valopay_records"]) await pool.query(`DELETE FROM ${table} WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)`, [targetWorkspace]);
      await pool.query("DELETE FROM valopay_merchants WHERE workspace_id=$1", [targetWorkspace]);
      await pool.query("DELETE FROM valopay_workspaces WHERE id=$1", [targetWorkspace]);
    }
    checks += 5;
  }

  // ---- 10. An export claim reads the chain's head once it holds the lender, however early its transaction began ----
  {
    const claimCall = sandboxCaller(), directory = process.env.PRIVATE_OBJECT_DIR;
    const [target] = ok(await claimCall("/v1/workspace")).merchants.map((merchant: { id: string }) => merchant.id) as [string];
    process.env.PRIVATE_OBJECT_DIR = "/private/synthetic-history-tests";
    // The claim's transaction reads before it takes the lender, as the isolation self-check's catalogue reads do
    // under runtime isolation. Meanwhile another process's worker appends an entry and lets the lender go without
    // changing its row, as recording an export ready does.
    const patched: any[] = [];
    let reached!: () => void, release!: () => void;
    const atLock = new Promise<void>((resolve) => { reached = resolve; }), released = new Promise<void>((resolve) => { release = resolve; });
    let armed = true;
    const hold = (client: any) => {
      const query = client.query;
      patched.push(client);
      client.query = async (text: unknown, ...rest: unknown[]) => {
        if (armed && typeof text === "string" && text.includes("FOR UPDATE OF m SKIP LOCKED")) {
          armed = false;
          await query.call(client, "SELECT count(*) FROM pg_roles");
          reached(); await released;
        }
        return query.call(client, text, ...rest);
      };
    };
    try {
      const job = ok(await claimCall(`/v1/exports?merchantId=${target}`, "POST", { kind: "gate-pack", format: "json" }, randomUUID()));
      pool.on("acquire", hold);
      const claiming = exportJobRepository.claim(target, job.id);
      await Promise.race([atLock, new Promise((_, reject) => setTimeout(() => reject(new Error("the claim never reached the lender's lock")), 10_000))]);
      pool.off("acquire", hold);
      const [head] = (await entriesOf(target)).slice(-1);
      const elsewhere = auditEntryData({ sequence: head!.data.sequence + 1, actor: "System · export worker", action: "export.ready", objectId: "another-process-export", summary: "Another process recorded its export while this claim began.", previousHash: head!.data.hash, timestamp: new Date().toISOString() });
      const other = await pool.connect();
      try {
        await other.query("BEGIN");
        await other.query("SELECT id FROM valopay_merchants WHERE id=$1 FOR UPDATE", [target]);
        await other.query("INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data) VALUES($1,$2,'audit',$3,'recorded','',0,'',$4)", [randomUUID(), target, elsewhere.action, elsewhere]);
        await other.query("COMMIT");
      } finally { other.release(); }
      release();
      assert.ok(await claiming, "the export worker claims the job");
      const entries = await entriesOf(target), started = entries.at(-1)!;
      assert.deepEqual([started.data.action, started.data.sequence, started.data.previousHash], ["export.started", elsewhere.sequence + 1, elsewhere.hash], "its entry follows the entry committed before it held the lender, not the head its transaction first saw");
      assert.equal(verifyAuditChain(entries).valid, true, "one chain, no fork");
    } finally {
      pool.off("acquire", hold); release();
      // The prototype's query again, not an own copy of it that a later patch of the prototype would not reach.
      for (const client of patched) delete client.query;
      if (directory === undefined) delete process.env.PRIVATE_OBJECT_DIR; else process.env.PRIVATE_OBJECT_DIR = directory;
      await removeWorkspaceOf(target);
    }
    checks += 3;
  }

  // ---- 11. A fork (two entries with one sequence) stays in the overview until the chain is valid again ----
  {
    const forkCall = sandboxCaller();
    const [forked, earlier] = ok(await forkCall("/v1/workspace")).merchants.map((merchant: { id: string }) => merchant.id) as [string, string];
    const at = (path: string, merchantId: string) => `${path}${path.includes("?") ? "&" : "?"}merchantId=${merchantId}`;
    const overview = async (merchantId: string) => brokenAlert(ok(await forkCall(at("/v1/overview", merchantId))));
    const entryNamed = async (merchantId: string) => brokenEntry(ok(await forkCall(at("/v1/overview", merchantId))));
    const write = async (merchantId: string, name: string) => ok(await forkCall(at("/v1/records/customers", merchantId), "POST", customer(name), randomUUID()));
    const verifyChain = async (merchantId: string) => ok(await forkCall(at("/v1/actions", merchantId), "POST", { action: "verify_audit", reason: "Check the synthetic audit log" }, randomUUID())).data;
    try {
      // At the head: a second entry at the head's sequence after the same entry, the shape two writers that each took
      // the next sequence leave behind.
      for (let index = 0; index < 4; index++) await write(forked, `Fork customer ${index}`);
      const before = await entriesOf(forked), head = before.at(-1)!, prior = before.at(-2)!;
      const forkId = await insertEntry(forked, auditEntryData({ sequence: head.data.sequence, actor: "System · export worker", action: "export.started", objectId: "fork-export", summary: "A second writer took the same sequence.", previousHash: prior.data.hash, timestamp: new Date().toISOString() }));
      assert.equal(await overview(forked), true, "the overview reports the fork at once");
      await write(forked, "After the fork");
      assert.equal(await overview(forked), true, "and still after the next write");
      assert.equal(await entryNamed(forked), head.data.sequence, "naming the sequence two entries claim");
      assert.ok((await chainOf(forked))!.verified.sequence < head.data.sequence, "the lender's last verified entry stays before the forked sequence");
      const checked = await verifyChain(forked);
      assert.deepEqual([checked.valid, checked.headHash], [false, prior.data.hash], "verify_audit stops before the sequence two entries claim");
      await write(forked, "Written on a forked chain");
      assert.equal(await overview(forked), true, "and neither verify_audit nor a later write hides it");
      await pool.query("DELETE FROM valopay_records WHERE id=$1", [forkId]);
      assert.equal(await entryNamed(forked), head.data.sequence, "a repair leaves the break the lender knows of");
      await write(forked, "After the repair");
      assert.equal(await entryNamed(forked), head.data.sequence, "and so does a later write: only a walk of the whole chain reads it again");
      assert.equal((await verifyChain(forked)).valid, true, "verify_audit finds the chain valid again");
      assert.deepEqual([await overview(forked), (await chainOf(forked))!.broken], [false, undefined], "which clears the break and the overview's alert");
      await write(forked, "After the check");
      assert.equal((await chainOf(forked))!.verified.sequence, (await entriesOf(forked)).at(-2)!.data.sequence, "and the next write verifies on from there");
      // Before the last verified entry: the overview does not read it again, verify_audit finds it, and from then on
      // the overview shows it too.
      for (let index = 0; index < 4; index++) await write(earlier, `Earlier fork customer ${index}`);
      const [first] = await entriesOf(earlier);
      await insertEntry(earlier, auditEntryData({ sequence: 2, actor: "System · export worker", action: "export.started", objectId: "earlier-fork-export", summary: "A second writer took an earlier sequence.", previousHash: first!.data.hash, timestamp: new Date().toISOString() }));
      assert.equal(await overview(earlier), false, "a fork before the last verified entry is not read again by the overview");
      const found = await verifyChain(earlier);
      assert.deepEqual([found.valid, found.headHash], [false, first!.data.hash], "verify_audit walks the whole chain and stops before the fork");
      assert.equal((await chainOf(earlier))!.verified.sequence, 1, "the lender records how far the chain held");
      assert.equal(await overview(earlier), true, "from then on the overview reports it");
      await write(earlier, "Written after verify_audit");
      assert.equal(await overview(earlier), true, "and a later write does not hide it");
      assert.equal(await entryNamed(earlier), 2, "naming the forked entry after the last verified one");
    } finally { await removeWorkspaceOf(forked); }
    checks += 17;
  }

  // ---- 12. An entry whose sequence is not a whole number is a break at its place in the chain, and hides no fork ----
  {
    const shapeCall = sandboxCaller();
    const [damaged, forked] = ok(await shapeCall("/v1/workspace")).merchants.map((merchant: { id: string }) => merchant.id) as [string, string];
    const at = (path: string, merchantId: string) => `${path}${path.includes("?") ? "&" : "?"}merchantId=${merchantId}`;
    const entryNamed = async (merchantId: string) => brokenEntry(ok(await shapeCall(at("/v1/overview", merchantId))));
    const write = async (merchantId: string, name: string) => ok(await shapeCall(at("/v1/records/customers", merchantId), "POST", customer(name), randomUUID()));
    const verifyChain = async (merchantId: string) => ok(await shapeCall(at("/v1/actions", merchantId), "POST", { action: "verify_audit", reason: "Check the synthetic audit log" }, randomUUID())).data;
    try {
      // A null sequence, at the head and then at entry 3: verify_audit names that entry, and the lender records the
      // entry before it, not entry 1 and the chain's start.
      for (let index = 0; index < 6; index++) await write(damaged, `Damaged sequence customer ${index}`);
      const entries = await entriesOf(damaged);
      for (const target of [entries.at(-1)!, entries[2]!]) {
        await pool.query("UPDATE valopay_records SET data=jsonb_set(data,'{sequence}','null') WHERE id=$1", [target.id]);
        assert.equal((await verifyChain(damaged)).valid, false);
        assert.deepEqual([await entryNamed(damaged), (await chainOf(damaged))!.verified.sequence], [target.data.sequence, target.data.sequence - 1], `a null sequence at entry ${target.data.sequence} is the break verify_audit records`);
        await pool.query("UPDATE valopay_records SET data=$2 WHERE id=$1", [target.id, target.data]);
        assert.equal((await verifyChain(damaged)).valid, true, "and once it is repaired the chain is valid again");
      }
      // A damaged entry stored after the head and before a second entry at the head's sequence (a fork): the fork is
      // named at once, the lender's verified entry stays before it, and removing the damaged entry does not hide it.
      for (let index = 0; index < 5; index++) await write(forked, `Word fork customer ${index}`);
      const chain = await entriesOf(forked), head = chain.at(-1)!, prior = chain.at(-2)!;
      const word = await insertEntry(forked, { ...auditEntryData({ sequence: 0, actor: "Damaged", action: "damaged.entry", objectId: "damaged", summary: "Damaged", previousHash: head.data.hash, timestamp: new Date().toISOString() }), sequence: "abc" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await insertEntry(forked, auditEntryData({ sequence: head.data.sequence, actor: "System · export worker", action: "export.started", objectId: "word-fork-export", summary: "A second writer took the same sequence.", previousHash: prior.data.hash, timestamp: new Date().toISOString() }));
      assert.equal(await entryNamed(forked), head.data.sequence, "the overview names the sequence two entries claim, whatever lies between them");
      await write(forked, "After the damage and the fork");
      assert.deepEqual([await entryNamed(forked), (await chainOf(forked))!.verified.sequence], [head.data.sequence, prior.data.sequence], "a write keeps the lender's verified entry before the fork");
      await pool.query("DELETE FROM valopay_records WHERE id=$1", [word]);
      await write(forked, "After the damaged entry went");
      assert.equal(await entryNamed(forked), head.data.sequence, "removing the damaged entry does not hide the fork");
      const found = await verifyChain(forked);
      assert.deepEqual([found.valid, found.headHash, await entryNamed(forked)], [false, prior.data.hash, head.data.sequence], "and verify_audit finds the same fork");
    } finally { await removeWorkspaceOf(damaged); }
    checks += 10;
  }

  // ---- 13. A chain known to be broken is checked on from its head: each save and overview reads what came since ----
  {
    const costCall = sandboxCaller();
    const [target] = ok(await costCall("/v1/workspace")).merchants.map((merchant: { id: string }) => merchant.id) as [string];
    const at = (path: string) => `${path}${path.includes("?") ? "&" : "?"}merchantId=${target}`;
    const write = async (name: string) => ok(await costCall(at("/v1/records/customers"), "POST", customer(name), randomUUID()));
    // How many entries each check of the chain reads (readAuditChain's query), in order.
    const reads: number[] = [];
    const probe = await pool.connect();
    probe.release();
    const clients = Object.getPrototypeOf(probe) as { query: (this: unknown, ...args: any[]) => any };
    const query = clients.query;
    clients.query = function (this: unknown, ...args: any[]) {
      const result = query.apply(this, args);
      if (typeof args[0] !== "string" || !/r\.kind='audit'/.test(args[0]) || !/make_interval\(mins =>/.test(args[0]) || typeof result?.then !== "function") return result;
      return result.then((answer: { rows: unknown[] }) => { reads.push(answer.rows.length); return answer; });
    };
    try {
      for (let index = 0; index < 4; index++) await write(`Known break customer ${index}`);
      const [first] = await entriesOf(target);
      await insertEntry(target, auditEntryData({ sequence: 2, actor: "System · export worker", action: "export.started", objectId: "known-break-export", summary: "A second writer took an early sequence.", previousHash: first!.data.hash, timestamp: new Date().toISOString() }));
      assert.equal(ok(await costCall(at("/v1/actions"), "POST", { action: "verify_audit", reason: "Check the synthetic audit log" }, randomUUID())).data.valid, false);
      assert.deepEqual([(await chainOf(target))!.broken, (await chainOf(target))!.verified.sequence], [{ sequence: 2 }, 1], "the lender keeps the break verify_audit found beside its last verified entry");
      for (let index = 0; index < 40; index++) await write(`Written on a broken chain ${index}`);
      reads.length = 0;
      const overview = ok(await costCall(at("/v1/overview")));
      assert.deepEqual([brokenAlert(overview), brokenEntry(overview)], [true, 2], "the overview's alert stays on from the known break");
      await write("One more save");
      assert.deepEqual(reads, [0, 0], "the overview and the save each read only the entries since the head, not the 40 written since the break");
      // An entry appended without moving the stored head, as the export worker's are, is still read and followed.
      const [latest] = (await entriesOf(target)).slice(-1);
      const elsewhere = auditEntryData({ sequence: latest!.data.sequence + 1, actor: "System · export worker", action: "export.ready", objectId: "known-break-ready", summary: "Recorded without moving the stored head.", previousHash: latest!.data.hash, timestamp: new Date().toISOString() });
      await insertEntry(target, elsewhere);
      reads.length = 0;
      await write("After an entry from elsewhere");
      const [followed] = (await entriesOf(target)).slice(-1);
      assert.deepEqual([reads, followed!.data.sequence, followed!.data.previousHash], [[1], elsewhere.sequence + 1, elsewhere.hash], "a save on a broken chain reads the new entry and follows it");
      assert.deepEqual([(await chainOf(target))!.broken, (await chainOf(target))!.verified.sequence], [{ sequence: 2 }, 1], "and keeps the break and the verified entry before it");
    } finally {
      clients.query = query;
      await removeWorkspaceOf(target);
    }
    checks += 6;
  }
} finally {
  server.close();
  await once(server, "close");
  if (workspaceId) {
    for (const table of ["valopay_idempotency", "valopay_operations", "valopay_records"]) await pool.query(`DELETE FROM ${table} WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)`, [workspaceId]);
    await pool.query("DELETE FROM valopay_merchants WHERE workspace_id=$1", [workspaceId]);
    await pool.query("DELETE FROM valopay_workspaces WHERE id=$1", [workspaceId]);
  }
  await pool.end();
}
console.log(`Lender history checks passed (${checks} checks): the audit chain stays out of every load and continues from the head kept on the lender, entries written elsewhere are followed, the overview checks from the last verified entry and verify_audit the whole chain, earlier closes load as summaries, settings read only the latest close, the records list has closes as summaries, history lists are capped, the export worker's entries follow the stored head and its claim reads the head once it holds the lender, a break stays reported until verify_audit finds the chain valid again, a damaged sequence is a break at its place and hides no fork, and a known break costs a save or an overview only the entries since the head.`);
