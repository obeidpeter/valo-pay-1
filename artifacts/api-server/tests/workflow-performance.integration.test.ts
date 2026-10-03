import { SANDBOX_COOKIE } from "../src/lib/sandbox-cookie";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Server } from "node:http";
import { workflowFixture, WORKFLOW_NOW } from "./workflow-fixture";

if (process.env.VALO_PAY_1_RUN_INTEGRATION !== "1") {
  console.log("Set VALO_PAY_1_RUN_INTEGRATION=1 for complete-workflow database measurements.");
  process.exit(0);
}
const { pool } = await import("@workspace/valo-pay-1-db");
const { inWorkspace, listMerchants, loadState, assertFinalState, digest } = await import("../src/lib/valo-pay-1-store");
const { verifyAuditChain } = await import("../src/lib/digests");
const { buildExportBytes } = await import("../src/lib/valo-pay-1-exports");
const { default: express } = await import("express");
const { default: router } = await import("../src/routes/valo-pay-1");
const token = randomBytes(32).toString("hex");
const req = () => ({ headers: { cookie: `${SANDBOX_COOKIE}=${token}` }, secure: false, auth: Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true }) }) as any;
const res = () => ({ cookie() {} }) as any;
let server: Server | undefined;
try {
  const merchants = await inWorkspace(req(), res(), listMerchants);
  // Independent lenders get the same complete history so close and reconcile
  // both process fresh observations, rather than benchmarking a warmed empty queue.
  for (const merchant of merchants) {
    const fixture = workflowFixture(1_000);
    const baseline = await inWorkspace(req(), res(), context => loadState(context, merchant.id, "share"), "read");
    const now = (await pool.query<{ now: Date }>("SELECT now() AS now")).rows[0]!.now.toISOString();
    const delta = Date.parse(now) - Date.parse(WORKFLOW_NOW);
    const shift = (at: string) => new Date(Date.parse(at) + delta).toISOString();
    const ids = new Map(fixture.records.map(record => [record.id, randomUUID()]));
    for (const record of fixture.records) {
      record.id = ids.get(record.id)!; record.merchantId = merchant.id;
      if (record.customerId) record.customerId = ids.get(record.customerId)!;
      record.createdAt = shift(record.createdAt); record.updatedAt = shift(record.updatedAt);
      for (const key of ["dueItemId", "paymentId"]) if (record.data[key]) record.data[key] = ids.get(record.data[key]);
      for (const key of ["dueDate", "observedAt", "settledAt", "occurredAt"]) if (record.data[key]) record.data[key] = shift(record.data[key]);
    }
    assertFinalState(baseline, { ...baseline, records: [...baseline.records, ...fixture.records] }, merchant.id);
    for (let offset = 0; offset < fixture.records.length; offset += 500) {
      await pool.query(`INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data,created_at,updated_at)
        SELECT x.id,x."merchantId",x.kind,x.name,x.status,x.reference,x."amountKobo",x."customerId",x.data,x."createdAt",x."updatedAt"
        FROM jsonb_to_recordset($1::jsonb) AS x(id text,"merchantId" text,kind text,name text,status text,reference text,"amountKobo" bigint,"customerId" text,data jsonb,"createdAt" timestamptz,"updatedAt" timestamptz)`, [JSON.stringify(fixture.records.slice(offset, offset + 500))]);
    }
  }
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { (request as any).auth = req().auth; (request as any).log = { info() {} }; next(); });
  app.use("/api", router);
  app.use((error: any, _request: any, response: any, _next: any) => response.status(error.status || 500).json({ error: error.message }));
  server = await new Promise<Server>(resolve => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/api/v1/actions`;
  const results: Record<string, unknown>[] = [];
  for (const [index, merchant] of merchants.entries()) {
    const invoke = () => fetch(`${endpoint}?merchantId=${merchant.id}`, { method: "POST", headers: { Cookie: `${SANDBOX_COOKIE}=${token}`, "Content-Type": "application/json", "Idempotency-Key": `workflow-${merchant.id}` }, body: JSON.stringify({ action: index === 0 ? "daily_close" : "run_reconciliation" }) });
    const started = performance.now();
    const response = await invoke(), result = await response.json() as any;
    assert.equal(response.status, 200, JSON.stringify(result));
    const httpWorkflowMs = performance.now() - started;
    assert.ok(result.data.observationsResolved >= 200);
    const readStarted = performance.now();
    const output = await inWorkspace(req(), res(), async context => ({ state: await loadState(context, merchant.id, "share"), context: { now: context.now, role: context.role, actor: context.actor } }), "read");
    const fullStateReadMs = performance.now() - readStarted;
    // The audit chain is not part of a loaded state: the whole stored chain is verified from its first entry.
    assert.equal(verifyAuditChain((await pool.query("SELECT data FROM valopay_records WHERE merchant_id=$1 AND kind='audit'", [merchant.id])).rows).valid, true);
    if (index === 0) assert.ok(output.state.records.some(record => record.kind === "closes" && record.id === result.data.closeId));
    const replayStarted = performance.now(), replay = await invoke();
    assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), result);
    const replayMs = performance.now() - replayStarted;
    const exportStarted = performance.now();
    const exported = await buildExportBytes(output.state, output.context, { kind: "payments", format: "json" });
    const exportGenerationMs = performance.now() - exportStarted;
    assert.equal(JSON.parse(exported.bytes.toString()).data.length, output.state.records.filter(record => record.kind === "payments").length);
    results.push({ workflow: index === 0 ? "daily-close" : "reconciliation", fixtureCustomers: 1_000, records: output.state.records.length, httpWorkflowMs: Math.round(httpWorkflowMs), fullStateReadMs: Math.round(fullStateReadMs), replayMs: Math.round(replayMs), exportGenerationMs: Math.round(exportGenerationMs), exportBytes: exported.bytes.length });
  }
  console.log(JSON.stringify({ benchmark: "persisted-synthetic-workflows", results, scope: "local HTTP action, PostgreSQL load, response validation, state hashes, audit, idempotency, persistence, commit and complete local JSON generation; excludes remote object storage" }));
} finally {
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  const principal = digest(`demo:${token}`);
  for (const table of ["valopay_idempotency", "valopay_records"]) await pool.query(`DELETE FROM ${table} WHERE merchant_id IN (SELECT m.id FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id WHERE w.principal_hash=$1)`, [principal]);
  await pool.query("DELETE FROM valopay_merchants WHERE workspace_id IN (SELECT id FROM valopay_workspaces WHERE principal_hash=$1)", [principal]);
  await pool.query("DELETE FROM valopay_workspaces WHERE principal_hash=$1", [principal]);
  await pool.end();
}
