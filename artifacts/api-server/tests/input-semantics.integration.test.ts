// What the API takes from a request and what it makes of it (audit 23
// September, security item 3 and API items 3, 6, 8 and 11), against a real
// database. An audit entry names the record the request is about and the
// reason the route's own schema carries, never text a client added beside
// them.
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";

if (process.env.VALOPAY_RUN_INTEGRATION !== "1") {
  console.log("Set VALOPAY_RUN_INTEGRATION=1 to check input semantics against a disposable PostgreSQL database.");
  process.exit(0);
}
// Placeholder identity and storage settings: nothing here reaches the identity provider or object storage.
process.env.CLERK_SECRET_KEY ??= "sk_test_placeholder";
process.env.PRIVATE_OBJECT_DIR ||= "/input-semantics-bucket/private";
const { pool } = await import("@workspace/db");
const { default: router } = await import("../src/routes/index");
const { errorHandler } = await import("../src/lib/error-handler");

const quiet = { info() {}, warn() {}, error() {} };
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((req, _res, next) => {
  (req as any).auth = Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true });
  (req as any).log = quiet;
  next();
});
app.use("/api", router);
app.use("/api", (_req, res) => { res.status(404).json({ error: "Unknown resource.", requestId: "input-semantics" }); });
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const cookie = `valopay_sandbox=${randomBytes(32).toString("hex")}`;
async function call(path: string, method = "GET", body?: unknown, key: string | null = randomUUID()) {
  const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie, ...(key && method !== "GET" ? { "Idempotency-Key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: (await response.json()) as any };
}
const ok = (result: { status: number; data: any }) => { assert.equal(result.status, 200, JSON.stringify(result.data).slice(0, 800)); return result.data; };
let workspaceId: string | undefined;
let checks = 0;
try {
  const workspace = ok(await call("/v1/workspace"));
  const lender = workspace.merchants[0].id as string;
  workspaceId = (await pool.query("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [lender])).rows[0].workspace_id;
  const q = (path: string) => `${path}${path.includes("?") ? "&" : "?"}merchantId=${lender}`;
  const lastAudit = async () => (await pool.query("SELECT data FROM valopay_records WHERE merchant_id=$1 AND kind='audit' ORDER BY (data->>'sequence')::int DESC LIMIT 1", [lender])).rows[0].data as { action: string; objectId: string; summary: string };
  const customers = ok(await call(q("/v1/records/customers?limit=500"))).items as any[];
  const victim = customers[0];

  // ---- 1. An audit entry names what the request changed and the reason its route takes ----
  {
    // A settings change cannot name a customer or carry a reassuring story: neither field is in its schema.
    const settings = ok(await call(q("/v1/settings")));
    ok(await call(q("/v1/settings"), "PATCH", { minimumTicketKobo: 500000, expectedRevision: settings.revision, recordId: victim.id, reason: "Routine review of customer contact preferences; no financial settings changed." }));
    assert.deepEqual(await lastAudit().then(({ action, objectId, summary }) => ({ action, objectId, summary })), { action: "patch.settings", objectId: "workspace", summary: "Synthetic workspace operation" }, "a settings change is recorded against the lender, in the route's words");
    // A new record is the entry's object, whatever the body names; its data cannot add a note to the summary either.
    const created = ok(await call(q("/v1/records/customers"), "POST", { name: "Audit integrity customer", data: { consentProvenance: "Synthetic fixture", auditNote: "Approved by the board." }, recordId: victim.id, reason: "Corrected the victim's name at their request." }));
    assert.deepEqual(await lastAudit().then(({ objectId, summary }) => ({ objectId, summary })), { objectId: created.id, summary: "Synthetic workspace operation" }, "a created record is the object, and neither the body's reason nor its data's note reaches the summary");
    // An action keeps its own reason, and names the record it applies to only when it acted on it.
    ok(await call(q("/v1/actions"), "POST", { action: "run_reconciliation", recordId: victim.id, reason: "Reconcile the morning's payment evidence." }));
    assert.deepEqual(await lastAudit().then(({ action, objectId, summary }) => ({ action, objectId, summary })), { action: "run_reconciliation", objectId: "workspace", summary: "Reconcile the morning's payment evidence." }, "an action that ignores recordId does not name the record");
    const mandate = (ok(await call(q("/v1/records/mandates?status=active&limit=1"))).items as any[])[0];
    ok(await call(q("/v1/actions"), "POST", { action: "mandate_suspend", recordId: mandate.id, reason: "The customer asked to pause collections." }));
    assert.deepEqual(await lastAudit().then(({ action, objectId, summary }) => ({ action, objectId, summary })), { action: "mandate_suspend", objectId: mandate.id, summary: "The customer asked to pause collections." }, "an action names the record it changed, with its reason");
    // A route whose strict schema carries a reason keeps it; the path names the object.
    const fixture = ok(await call(q("/v1/sources/paystack/fixtures"), "POST", { scenario: "payment", syntheticOnly: true }));
    ok(await call(q(`/v1/sources/events/${fixture.event.id}/replay`), "POST", { expectedUpdatedAt: fixture.event.updatedAt, reason: "  Recheck the stored delivery.  " }));
    assert.deepEqual(await lastAudit().then(({ objectId, summary }) => ({ objectId, summary })), { objectId: fixture.event.id, summary: "Recheck the stored delivery." }, "a schema's reason is taken as the schema parsed it");
    assert.equal(ok(await call(q("/v1/actions"), "POST", { action: "verify_audit" })).data.valid, true, "the chain still verifies");
    checks += 6;
  }

  // ---- 2. A date is a real calendar date, and an incremental sync names an instant (API item 6) ----
  {
    const named = (result: { status: number; data: any }, field: string) => { assert.equal(result.status, 400, JSON.stringify(result.data)); assert.ok((result.data.details ?? []).some((detail: { field: string }) => detail.field === field), `the refusal names ${field}: ${JSON.stringify(result.data)}`); };
    // Date.parse read "1" as 2001, a day as UTC midnight and an offset-less time in the server's zone; PostgreSQL refused two others with a 500.
    for (const value of ["1", "2026-09-23", "2026-09-23T10:00:00", "+275760-09-13T00:00:00.000Z", "0000-01-01T00:00:00Z", "2026-02-30T10:00:00Z"]) named(await call(q(`/v1/records/customers?updatedSince=${encodeURIComponent(value)}`)), "updatedSince");
    const all = ok(await call(q("/v1/records/customers"))), latest = [...all.items].sort((a: any, b: any) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const withOffset = new Date(Date.parse(latest.updatedAt) + 3_600_000).toISOString().replace("Z", "+01:00");
    assert.equal(ok(await call(q(`/v1/records/customers?updatedSince=${encodeURIComponent(withOffset)}`))).items.some((item: any) => item.id === latest.id), true, "an offset names the same instant");
    const before = ok(await call(q("/v1/records/exceptions"))).total;
    const impossible = await call(q("/v1/records/exceptions"), "POST", { name: "Due on 30 February", data: { type: "unallocated_payment", severity: "low", dueBy: "2026-02-30" } });
    assert.deepEqual([impossible.status, /^Due by: Enter a real date\.$/.test(impossible.data.error), ok(await call(q("/v1/records/exceptions"))).total], [400, true, before], `an impossible deadline is refused, not rolled over to 2 March, and nothing is saved: ${JSON.stringify(impossible.data)}`);
    checks += 9;
  }

  // ---- 3. Indexed text is bounded, and a refusal names its field (API item 3) ----
  {
    // Random text, which PostgreSQL cannot compress below its index row limit.
    const long = randomBytes(3000).toString("base64url"), saved = async (kind: string) => ok(await call(q(`/v1/records/${kind}`))).total;
    const field = (result: { status: number; data: any }, name: string) => { assert.equal(result.status, 400, JSON.stringify(result.data).slice(0, 300)); assert.ok((result.data.details ?? []).some((detail: { field: string }) => detail.field === name), `the refusal names ${name}: ${JSON.stringify(result.data).slice(0, 300)}`); };
    // Each was a 500 at the index ("index row size 4112 exceeds btree version 4 maximum 2704").
    const costs = await saved("costs");
    field(await call(q("/v1/records/costs"), "POST", { name: "Long status", status: long, data: { category: "hosting" } }), "status");
    field(await call(q("/v1/records/customers"), "POST", { name: "Long reference", reference: long, data: { consentProvenance: "Synthetic fixture" } }), "reference");
    field(await call(q("/v1/records/exceptions"), "POST", { name: "Long customer", customerId: long, data: { type: "unallocated_payment", severity: "low" } }), "customerId");
    field(await call(q(`/v1/records/customers/${victim.id}`), "PATCH", { reference: long, expectedUpdatedAt: victim.updatedAt }), "reference");
    const evidence = await call(q("/v1/records/observations"), "POST", { name: "Long event", reference: "OBS-LONG-EVENT", customerId: victim.id, amountKobo: 150000, data: { source: "webhook", eventId: long } });
    assert.deepEqual([evidence.status, /eventId/.test(evidence.data.error)], [400, true], `an over-long event ID is refused, naming eventId: ${JSON.stringify(evidence.data).slice(0, 300)}`);
    // An imported row is checked the same way: invalid in a preview, and a commit saves nothing.
    const csv = `row_id,name,reference,consentProvenance\nrow-1,Long row,${long},Synthetic fixture\n`;
    const preview = ok(await call(q("/v1/imports"), "POST", { kind: "customers", csv, identityColumn: "row_id", syntheticOnly: true, commit: false }));
    assert.deepEqual([preview.invalid, preview.rows[0].message, /reference is at most 200 characters/.test(preview.rows[0].detail)], [1, "Loan software reference (column reference): Use at most 200 characters.", true], "an imported row with an over-long reference is invalid, naming its column");
    const customerCount = await saved("customers");
    const commit = await call(q("/v1/imports"), "POST", { kind: "customers", csv, identityColumn: "row_id", syntheticOnly: true, commit: true });
    assert.deepEqual([commit.status, await saved("customers"), await saved("costs")], [200, customerCount, costs], "nothing over-long is saved");
    checks += 8;
  }

  // ---- 4. A record that does not exist is 404, and a path parameter is named (API item 8) ----
  {
    const missing = randomUUID();
    const action = await call(q("/v1/actions"), "POST", { action: "resolve_exception", recordId: missing, reason: "Resolve a case that does not exist.", data: { resolutionCode: "payment_confirmed" } });
    assert.equal(action.status, 404, `an unknown recordId in an action is 404: ${JSON.stringify(action.data)}`);
    const created = await call(q("/v1/records/mandates"), "POST", { name: "Mandate of nobody", customerId: missing, amountKobo: 5_000_000, data: { workflow: "hosted_consent", consentEvidence: "Synthetic consent" } });
    assert.equal(created.status, 404, `an unknown customerId on create is 404: ${JSON.stringify(created.data)}`);
    const exported = await call(q("/v1/exports"), "POST", { kind: "customer-pack", customerId: missing, format: "json" });
    assert.equal(exported.status, 404, "an unknown customerId on an export is 404");
    const review = await call(q("/v1/exports"), "POST", { kind: "reviewed-close", closeReviewId: missing, format: "json" });
    assert.equal(review.status, 404, `an unknown close review on an export is 404: ${JSON.stringify(review.data)}`);
    const linked = await call(q("/v1/records/exceptions"), "POST", { name: "Linked to nothing", data: { type: "unallocated_payment", severity: "low", linkedRecordId: missing } });
    assert.equal(linked.status, 404, `an exception linked to an unknown record is 404: ${JSON.stringify(linked.data)}`);
    const approve = await call(q(`/v1/lifecycle/runs/${missing}/approve`), "POST", { expectedUpdatedAt: new Date().toISOString(), previewDigest: "a".repeat(64), reason: "Approve a run that does not exist." });
    const execute = await call(q(`/v1/lifecycle/runs/${missing}/execute`), "POST", { previewDigest: "a".repeat(64) });
    assert.deepEqual([approve.status, execute.status], [404, 404], "an unknown retention run is 404 to approve and to execute");
    // An over-long id is refused the same way on every route, naming the parameter.
    const overLong = "i".repeat(101);
    for (const [method, path, body] of [["PATCH", `/v1/records/customers/${overLong}`, { name: "x", expectedUpdatedAt: new Date().toISOString() }], ["POST", `/v1/pilot/cases/${overLong}`, {}], ["GET", `/v1/customers/${overLong}/history`, undefined], ["GET", `/v1/exports/${overLong}`, undefined], ["POST", `/v1/exports/${overLong}/retry`, {}], ["GET", `/v1/close-history/${overLong}`, undefined], ["POST", `/v1/lifecycle/runs/${overLong}/execute`, { previewDigest: "a".repeat(64) }], ["POST", `/v1/sources/events/${overLong}/replay`, { expectedUpdatedAt: new Date().toISOString(), reason: "Replay an unknown event." }], ["POST", `/v1/operations/${overLong}/retry`, {}], ["POST", `/v1/operations/${overLong}/cancel`, {}]] as const) {
      const answer = await call(q(path), method, body);
      assert.deepEqual([answer.status, (answer.data.details ?? []).map((detail: { field: string }) => detail.field)], [400, ["id"]], `${method} ${path.slice(0, 40)} refuses an over-long id naming id: ${JSON.stringify(answer.data).slice(0, 300)}`);
    }
    // A retry reads its id as a cancel does: one no journal entry has is not found, whatever its form.
    for (const id of [randomBytes(32).toString("hex"), "not-an-entry"]) {
      const [retried, cancelled] = [await call(q(`/v1/operations/${id}/retry`), "POST", {}), await call(q(`/v1/operations/${id}/cancel`), "POST", {})];
      assert.deepEqual([retried.status, cancelled.status, retried.data.error], [404, 404, cancelled.data.error], `an unknown journal entry ${id.slice(0, 12)} is 404 to retry and to cancel, in the same words`);
    }
    checks += 17;
  }

  // ---- 5. A search reads names, references and data values; a name is never empty (API item 11) ----
  {
    const named = ok(await call(q("/v1/records/customers"), "POST", { name: "Ọkọnkwọ Quoted", reference: `FOLD-${randomUUID()}`, data: { consentProvenance: "Signed form", note: 'He said "hi"' } }));
    const found = async (search: string) => ok(await call(q(`/v1/records/customers?limit=500&search=${encodeURIComponent(search)}`)));
    const all = (await found("")).total;
    assert.deepEqual((await found('said "hi"')).items.map((item: any) => item.id), [named.id], "a value holding a double quote is found as written");
    assert.ok((await found("OKONKWO QUOTED")).items.some((item: any) => item.id === named.id), "a name is found ignoring case and accents");
    for (const search of ["true", "consentProvenance", "synthetic"]) assert.ok((await found(search)).total < all && !(await found(search)).items.some((item: any) => item.id === named.id), `${search} no longer matches every record`);
    // A name is never empty: "" used to be saved as "customers".
    const empty = await call(q("/v1/records/customers"), "POST", { name: "", data: { consentProvenance: "Synthetic fixture" } });
    assert.deepEqual([empty.status, (empty.data.details ?? []).map((detail: { field: string }) => detail.field)], [400, ["name"]], "an empty name is refused, naming name");
    const blank = await call(q("/v1/records/customers"), "POST", { name: "   ", data: { consentProvenance: "Synthetic fixture" } });
    assert.deepEqual([blank.status, /Enter a name for this record\./.test(blank.data.error)], [400, true], "a blank name is refused");
    const renamed = await call(q(`/v1/records/customers/${named.id}`), "PATCH", { name: "", expectedUpdatedAt: named.updatedAt });
    assert.deepEqual([renamed.status, (renamed.data.details ?? []).map((detail: { field: string }) => detail.field)], [400, ["name"]], "an edit cannot empty a name");
    checks += 7;
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
console.log(`Input semantics checks passed (${checks} checks): audit entries name the record a request changed and the reason its route takes; dates are real and an incremental sync names an instant; indexed text is bounded, naming its field; a record a request names that does not exist is 404 and a path id is named; a search reads values only and a name is never empty.`);
