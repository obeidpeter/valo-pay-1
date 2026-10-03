import { SANDBOX_COOKIE } from "../src/lib/sandbox-cookie";
// What a keyed request is told when it cannot be answered at once (audit 23
// September, items 1, 2 and 7), against a real database: an answer is decided
// for the request's Idempotency-Key, not for one attempt. A repeat of a saved
// request never says nothing was saved, whether the lender is busy or its
// stored answer cannot be opened; a repeat of a request still running is
// turned away as running and leaves the journal entry to the attempt running
// it; only the attempt that created an entry closes it on a failure that saved
// nothing; a keyed write reaches a journaled route only journaled, with its
// answer kept under its own entry, so a key used on another route never
// refuses it or strands it; and a money refusal (422) closes its entry as
// refused, so nothing waits in Operations.
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";

if (process.env.VALO_PAY_1_RUN_INTEGRATION !== "1") {
  console.log("Set VALO_PAY_1_RUN_INTEGRATION=1 to check the operations journal's answers against a disposable PostgreSQL database.");
  process.exit(0);
}
// A placeholder identity key: nothing here reaches the identity provider.
process.env.CLERK_SECRET_KEY ??= "sk_test_placeholder";
const { pool } = await import("@workspace/valo-pay-1-db");
const { default: router } = await import("../src/routes/index");
const { errorHandler } = await import("../src/lib/error-handler");
const store = await import("../src/lib/valo-pay-1-store");
const { overrideDatabaseLimits } = await import("../src/lib/database-limits");
const { requestFingerprint } = await import("../src/lib/digests");
const { makeRecord } = await import("../src/domain/records");

const quiet = { info() {}, warn() {}, error() {} };
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((req, _res, next) => {
  (req as any).auth = Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true });
  (req as any).log = quiet;
  next();
});
app.use("/api", router);
app.use("/api", (_req, res) => { res.status(404).json({ error: "Unknown resource.", requestId: "journal-outcomes" }); });
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const cookie = `${SANDBOX_COOKIE}=${randomBytes(32).toString("hex")}`;
async function call(path: string, method = "GET", body?: unknown, key?: string) {
  const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie, ...(key ? { "Idempotency-Key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: (await response.json()) as any, headers: response.headers };
}
const ok = (result: { status: number; data: any }) => { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
/** A request as a route makes it, for work the test runs in the store directly. */
const sandboxRequest = (merchantId?: string) => ({ headers: { cookie }, query: merchantId ? { merchantId } : {}, secure: false, log: quiet, auth: Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true }) }) as any;
const response = { cookie() {} } as any;
function gate() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
const customer = (name: string) => ({ name, reference: `JOURNAL-${randomUUID()}`, data: { consentProvenance: "Synthetic fixture" } });
/** A well-formed sealed payload under a key this host does not allow: what an unavailable or rotated key looks like. */
const unopenable = { protectedPayload: 1, key: "projects/p/locations/l/keyRings/r/cryptoKeys/k", wrappedKey: Buffer.alloc(32).toString("base64"), iv: Buffer.alloc(12).toString("base64"), tag: Buffer.alloc(16).toString("base64"), ciphertext: Buffer.from("{}").toString("base64") };
let workspaceId: string | undefined;
let restoreLimits: (() => void) | undefined;
let checks = 0;
try {
  const lender = ok(await call("/v1/workspace")).merchants[0].id as string;
  workspaceId = (await pool.query("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [lender])).rows[0].workspace_id;
  const q = (path: string) => `${path}${path.includes("?") ? "&" : "?"}merchantId=${lender}`;
  const entryOf = async (key: string) => (await pool.query<{ id: string; status: string }>("SELECT id,status FROM valopay_operations WHERE merchant_id=$1 AND request_key=$2", [lender, key])).rows;
  const saved = async (reference: string) => Number((await pool.query("SELECT count(*)::int AS n FROM valopay_records WHERE merchant_id=$1 AND reference=$2", [lender, reference])).rows[0].n);
  /** Holds the lender's row as a long write would, until the returned release. `NO KEY UPDATE` holds it without
   * holding up a new journal entry's reference to the lender, so the request's own transaction is the one that waits. */
  const holdLender = async (lock: "UPDATE" | "NO KEY UPDATE" = "UPDATE") => {
    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query(`SELECT id FROM valopay_merchants WHERE id=$1 FOR ${lock}`, [lender]);
    return async () => { await client.query("ROLLBACK"); client.release(); };
  };
  // A short lock limit keeps the waits below brief; the answers are those of the default limit.
  restoreLimits = overrideDatabaseLimits({ request: { lockMs: 400 } });

  // ---- 1. A repeat of a saved request while the lender is busy: its saved result, never "nothing was saved" ----
  {
    const key = randomUUID(), body = customer("Saved before the lender was busy");
    const first = ok(await call(q("/v1/records/customers"), "POST", body, key));
    let release = await holdLender();
    // The lender stays held until the answer arrives: a repeat that waited for it would be turned away at the lock limit.
    const repeat = await call(q("/v1/records/customers"), "POST", body, key).finally(release);
    assert.deepEqual([repeat.status, repeat.data], [200, first], "the repeat is answered from its stored result, without loading or waiting for the busy lender");
    assert.deepEqual((await entryOf(key)).map((entry) => entry.status), ["completed"]);
    assert.deepEqual(ok(await call(q("/v1/records/customers"), "POST", body, key)), first, "once the lender is free the same key answers the saved result");
    assert.equal(await saved(body.reference), 1, "and it was saved once");
    // The answer is kept under the request's own journal entry, which names its route: never under the key alone.
    const [entry] = await entryOf(key);
    assert.deepEqual([(await pool.query("SELECT 1 FROM valopay_idempotency WHERE merchant_id=$1 AND id=$2", [lender, entry!.id])).rowCount, (await pool.query("SELECT 1 FROM valopay_idempotency WHERE merchant_id=$1 AND id=$2", [lender, store.digest(`${lender}:${key}`)])).rowCount], [1, 0], "the stored answer belongs to the entry");
    // A completed request whose stored answer is not found waits for the lender like a first attempt; turned away, it is still saved.
    await pool.query("DELETE FROM valopay_idempotency WHERE merchant_id=$1 AND id=$2", [lender, entry!.id]);
    release = await holdLender();
    const unanswered = await call(q("/v1/records/customers"), "POST", body, key).finally(release);
    assert.equal(unanswered.status, 503, JSON.stringify(unanswered.data));
    assert.equal(unanswered.headers.get("retry-after"), "2", "it says when to try again");
    assert.equal(unanswered.data.committed, undefined, "a repeat of a saved request never says nothing was saved");
    assert.deepEqual([unanswered.data.operation, unanswered.data.error], ["completed", "This lender is busy with another change. This request was saved. Try again in a moment."], "it names the entry's state: the request was saved");
    assert.deepEqual([(await entryOf(key))[0]!.status, await saved(body.reference)], ["completed", 1]);
    checks += 12;
  }

  // ---- 2. A repeat of a saved request whose stored answer the key service cannot open ----
  {
    const key = randomUUID(), body = customer("Sealed stored answer");
    ok(await call(q("/v1/records/customers"), "POST", body, key));
    const [entry] = await entryOf(key);
    await pool.query("UPDATE valopay_idempotency SET response=$3 WHERE merchant_id=$1 AND id=ANY($2::text[])", [lender, [entry!.id, store.digest(`${lender}:${key}`)], unopenable]);
    const repeat = await call(q("/v1/records/customers"), "POST", body, key);
    assert.equal(repeat.status, 503, JSON.stringify(repeat.data));
    assert.deepEqual([repeat.data.committed, repeat.data.operation, repeat.data.error], [undefined, "completed", "Protected data cannot be opened. Contact the Valo Pay 1 team. This request was saved."], "a saved request whose answer cannot be opened says it was saved");
    assert.deepEqual([(await entryOf(key))[0]!.status, await saved(body.reference)], ["completed", 1]);
    // A retry from Operations whose stored request cannot be opened says the same.
    await pool.query("UPDATE valopay_operations SET request=$3 WHERE merchant_id=$1 AND id=$2", [lender, entry!.id, unopenable]);
    const retried = await call(q(`/v1/operations/${entry!.id}/retry`), "POST", {});
    assert.equal(retried.status, 503, JSON.stringify(retried.data));
    assert.deepEqual([retried.data.committed, retried.data.operation], [undefined, "completed"], "a retry of a saved request never says nothing was saved");
    // The same for a connected action, whose answer the connected route keeps.
    const view = ok(await call(q("/v1/connected")));
    const connectedKey = randomUUID(), grant = { action: "consent.grant", reason: "Grant a synthetic permission for the sealed answer check", data: { purpose: "erp_draft", subjectId: "sme", days: 30 }, expectedRevision: view.revision };
    ok(await call(q("/v1/connected/actions"), "POST", grant, connectedKey));
    const [connectedEntry] = await entryOf(connectedKey);
    await pool.query("UPDATE valopay_idempotency SET response=$3 WHERE merchant_id=$1 AND id=ANY($2::text[])", [lender, [connectedEntry!.id, store.digest(`connected:${lender}:${connectedKey}`)], unopenable]);
    const connected = await call(q("/v1/connected/actions"), "POST", grant, connectedKey);
    assert.deepEqual([connected.status, connected.data.committed, connected.data.operation], [503, undefined, "completed"], JSON.stringify(connected.data));
    checks += 6;
  }

  // ---- 3. A first attempt that saved nothing says so: before its entry was made, or closing the entry it made ----
  {
    const key = randomUUID(), body = customer("First attempt while the lender is busy");
    let release = await holdLender();
    const unmade = await call(q("/v1/records/customers"), "POST", body, key).finally(release);
    assert.deepEqual([unmade.status, unmade.data.committed, unmade.data.operation], [503, false, undefined], `the key held nothing, and still holds nothing: ${JSON.stringify(unmade.data)}`);
    assert.deepEqual(await entryOf(key), [], "no entry was made");
    ok(await call(q("/v1/records/customers"), "POST", body, key));
    assert.equal(await saved(body.reference), 1, "so the same key runs once the lender is free");
    const closedKey = randomUUID(), closedBody = customer("First attempt whose own transaction waited");
    release = await holdLender("NO KEY UPDATE");
    const first = await call(q("/v1/records/customers"), "POST", closedBody, closedKey).finally(release);
    assert.deepEqual([first.status, first.data.committed, first.data.operation], [503, false, "cancelled"], `the attempt that made the entry closed it: nothing sent with the key was saved or can be: ${JSON.stringify(first.data)}`);
    assert.deepEqual((await entryOf(closedKey)).map((entry) => entry.status), ["cancelled"]);
    const again = await call(q("/v1/records/customers"), "POST", closedBody, closedKey);
    assert.deepEqual([again.status, again.data.operation], [409, "cancelled"], "the key cannot run again");
    assert.equal(await saved(closedBody.reference), 0);
    checks += 7;
  }

  // ---- 4. A repeat while the original attempt is still running: turned away as running, the entry left to the original ----
  {
    const key = randomUUID(), body = customer("Original still running");
    const original = sandboxRequest(lender);
    const { id, created } = await store.inWorkspace(original, response, (ctx) => store.prepareOperation(ctx, lender, key, { method: "POST", path: "/v1/records/customers", body }));
    assert.equal(created, true, "the original created the entry");
    store.bindOperation(original, id, lender, true);
    const ready = gate(), finish = gate();
    const running = store.inWorkspace(original, response, async (ctx) => {
      const state = await store.loadState(ctx, lender, "update");
      ready.resolve();
      await finish.promise;
      const record = makeRecord(state, "customers", { ...body, status: "active", data: { ...body.data, synthetic: true }, createdAt: ctx.now, updatedAt: ctx.now });
      store.appendAudit(state, ctx, "post.records.customers", "workspace", "Synthetic workspace operation");
      await store.saveState(ctx, state);
      await store.saveIdempotency(ctx, store.receiptOf(original, lender, key, "workspace").id, requestFingerprint({ path: "/v1/records/customers", method: "POST", body, actor: ctx.actor }), record);
      return record;
    });
    try {
      await ready.promise;
      const started = Date.now();
      const duplicate = await call(q("/v1/records/customers"), "POST", body, key);
      assert.equal(duplicate.status, 503, JSON.stringify(duplicate.data));
      assert.ok(Date.now() - started < 2_000, "turned away at once, not after a lock wait");
      assert.equal(duplicate.headers.get("retry-after"), "2");
      assert.deepEqual([duplicate.data.committed, duplicate.data.operation, duplicate.data.error], [undefined, "running", "This request is still running. Wait a moment, then check the original request to see its result."], "a non-definitive 'still running' answer");
      assert.deepEqual((await entryOf(key)).map((entry) => entry.status), ["pending"], "the duplicate left the entry to the original");
    } finally { finish.resolve(); }
    const record = await running;
    assert.deepEqual((await entryOf(key)).map((entry) => entry.status), ["completed"], "the original completed it");
    assert.equal(ok(await call(q("/v1/records/customers"), "POST", body, key)).id, record.id, "a later repeat answers the original's result");
    assert.equal(await saved(body.reference), 1);
    checks += 9;
  }

  // ---- 5. A repeat that fails having saved nothing never closes an entry another attempt created ----
  {
    const key = randomUUID(), body = customer("Entry another attempt created");
    const { id } = await store.inWorkspace(sandboxRequest(), response, (ctx) => store.prepareOperation(ctx, lender, key, { method: "POST", path: "/v1/records/customers", body }));
    const release = await holdLender();
    const repeat = await call(q("/v1/records/customers"), "POST", body, key).finally(release);
    assert.equal(repeat.status, 503, JSON.stringify(repeat.data));
    assert.deepEqual([repeat.data.committed, repeat.data.operation, repeat.data.error], [undefined, "pending", "This lender is busy with another change. We do not know yet whether it was saved. Try again in a moment."], "the entry is still waiting for confirmation, and the answer says so");
    assert.deepEqual((await entryOf(key)).map((entry) => [entry.id, entry.status]), [[id, "pending"]], "the repeat did not cancel it");
    ok(await call(q("/v1/records/customers"), "POST", body, key));
    assert.deepEqual([(await entryOf(key))[0]!.status, await saved(body.reference)], ["completed", 1], "so a later repeat can still save it");
    checks += 5;
  }

  // ---- 6. Paths are matched as the router matches them: another spelling is no route, and never an unjournaled write ----
  {
    const key = randomUUID();
    for (const path of [`/v1/Records/customers?merchantId=${lender}`, `/v1/records/customers/?merchantId=${lender}`]) {
      const variant = await call(path, "POST", customer("Another spelling"), key);
      assert.deepEqual([variant.status, variant.data.error], [404, "Unknown resource."], `${path} is not the route`);
    }
    assert.deepEqual(await entryOf(key), [], "and journals nothing");
    const body = customer("Percent-encoded kind");
    const encoded = await call(`/v1/records/%63ustomers?merchantId=${lender}`, "POST", body, key);
    const [entry] = await entryOf(key);
    assert.deepEqual([encoded.status, encoded.headers.get("x-valopay-operation"), entry?.status], [200, entry?.id, "completed"], "a spelling the route answers is journaled");
    assert.equal(ok(await call(`/v1/records/%63ustomers?merchantId=${lender}`, "POST", body, key)).id, encoded.data.id, "and repeatable");
    // The mount is matched as before, so the path the router and the journal read is the same however /api is spelled.
    const prefix = await fetch(`${base.replace(/\/api$/, "/API")}/v1/records/%63ustomers?merchantId=${lender}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, "Idempotency-Key": key }, body: JSON.stringify(body) });
    assert.deepEqual([prefix.status, ((await prefix.json()) as { id?: string }).id, (await entryOf(key)).length], [200, encoded.data.id, 1], "the prefix's spelling reaches the same route and the same journal entry");
    checks += 6;
  }

  // ---- 7. A key a demo role switch used neither refuses nor strands a journaled write ----
  {
    const key = randomUUID(), roleSwitch = { action: "set_role", data: { role: "Admin" }, reason: "Stay the administrator" };
    ok(await call(q("/v1/actions"), "POST", roleSwitch, key));
    const body = customer("Key a role switch used");
    ok(await call(q("/v1/records/customers"), "POST", body, key));
    const [entry] = await entryOf(key);
    assert.equal(entry?.status, "completed", "the write ran and its entry completed, never left pending");
    const cancel = await call(q(`/v1/operations/${entry!.id}/cancel`), "POST", {});
    assert.deepEqual([cancel.status, cancel.data.error], [409, "This request has already completed. Reload Request history to see its saved result."]);
    assert.deepEqual(ok(await call(q("/v1/actions"), "POST", roleSwitch, key)).data, { role: "Admin" }, "the role switch still answers its own result");
    assert.equal(await saved(body.reference), 1);
    checks += 4;
  }

  // ---- 8. A money refusal is final for its key: its entry is closed as refused, and nothing waits in Operations ----
  {
    const other = ok(await call("/v1/workspace")).merchants[1].id as string;
    const inOther = (path: string) => `${path}${path.includes("?") ? "&" : "?"}merchantId=${other}`;
    // Two synthetic instalments at the top of the supported range: a close's totals cannot hold their sum.
    await store.inWorkspace(sandboxRequest(other), response, async (ctx) => {
      const state = await store.loadState(ctx, other, "update");
      const payer = makeRecord(state, "customers", { name: "Synthetic overflow payer", reference: `JOURNAL-${randomUUID()}`, createdAt: ctx.now, data: { consentProvenance: "Synthetic fixture" } });
      for (let index = 0; index < 2; index++)
        makeRecord(state, "due-items", { name: "Synthetic high instalment", reference: `JOURNAL-HIGH-${randomUUID()}`, status: "scheduled", customerId: payer.id, amountKobo: Number.MAX_SAFE_INTEGER, createdAt: ctx.now, data: { owner: "lms", dueDate: ctx.now.slice(0, 10), outstandingKobo: Number.MAX_SAFE_INTEGER } });
      store.appendAudit(state, ctx, "test.journal.money", payer.id, "Arrange synthetic totals beyond the supported range.");
      await store.saveState(ctx, state);
    });
    const closes = async () => Number((await pool.query("SELECT count(*)::int AS n FROM valopay_records WHERE merchant_id=$1 AND kind='closes'", [other])).rows[0].n);
    const before = await closes(), key = randomUUID(), body = { action: "daily_close", reason: "Close the synthetic day" };
    const refused = await call(inOther("/v1/actions"), "POST", body, key);
    assert.equal(refused.status, 422, JSON.stringify(refused.data));
    assert.deepEqual([refused.data.code, refused.data.operation], ["MONEY_OUT_OF_RANGE", "cancelled"], "the refusal names its code and says the entry is closed");
    const id = refused.headers.get("x-valopay-operation");
    assert.equal((await pool.query("SELECT status FROM valopay_operations WHERE id=$1", [id])).rows[0]?.status, "cancelled");
    assert.equal(ok(await call(inOther("/v1/operations/pending"))).pending, 0, "nothing waits for confirmation or counts towards the pending limit");
    const listed = ok(await call(inOther("/v1/operations"))).items.find((item: { id: string }) => item.id === id);
    assert.equal(listed?.status, "cancelled");
    assert.match(listed.message, /^Valo Pay 1 refused this request: Valo Pay 1 cannot complete this calculation because an amount or rate is outside the supported limits\./);
    const again = await call(inOther("/v1/actions"), "POST", body, key);
    assert.deepEqual([again.status, again.data.operation], [409, "cancelled"], "the same key cannot run again");
    assert.match(again.data.error, /^Valo Pay 1 refused this request and saved nothing: Valo Pay 1 cannot complete this calculation/);
    assert.equal(await closes(), before, "and nothing was saved");
    checks += 9;
  }
} finally {
  restoreLimits?.();
  server.close();
  await once(server, "close");
  if (workspaceId) {
    for (const table of ["valopay_idempotency", "valopay_operations", "valopay_records"]) await pool.query(`DELETE FROM ${table} WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)`, [workspaceId]);
    await pool.query("DELETE FROM valopay_merchants WHERE workspace_id=$1", [workspaceId]);
    await pool.query("DELETE FROM valopay_workspaces WHERE id=$1", [workspaceId]);
  }
  await pool.end();
}
console.log(`Journal outcome checks passed (${checks} checks): a repeat of a saved request never says nothing was saved, a repeat of a running request is turned away and leaves its entry, only the creating attempt closes an entry on a failure, and keyed writes reach journaled routes only journaled, their answers kept under their own entries; a money refusal closes its entry.`);
