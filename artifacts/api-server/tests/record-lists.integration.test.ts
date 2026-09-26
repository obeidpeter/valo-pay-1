// Synthetic fixtures only, in the disposable PostgreSQL used by CI. Never
// point VALOPAY_RUN_INTEGRATION at the deployed database.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Server } from "node:http";
import type { DomainState } from "../src/domain/types.js";
import { allocationChoices, pageRecords, type ListQuery } from "../src/lib/valopay-list.js";
import { allocationPayer } from "../src/domain/reconciliation.js";
import { canTakeAllocation } from "@workspace/valopay-schema";

if (process.env.VALOPAY_RUN_INTEGRATION !== "1") {
  console.log("Set VALOPAY_RUN_INTEGRATION=1 to run record list and stale-edit integration tests.");
  process.exit(0);
}
const { pool } = await import("@workspace/db");
const { inWorkspace, listMerchants, loadState, saveState, listRecords, loadCustomerView, loadSettingsView } = await import("../src/lib/valopay-store.js");
const { customerTimeline } = await import("../src/domain/timeline.js");
const { buildConsoleSettings } = await import("../src/lib/valopay-close-views.js");
const { default: express } = await import("express");
const { default: router } = await import("../src/routes/valopay.js");
const { errorHandler } = await import("../src/lib/error-handler.js");
const auth = () => Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true });
const token = randomBytes(32).toString("hex"), otherToken = randomBytes(32).toString("hex"), editingToken = randomBytes(32).toString("hex");
const request = (value = token) => ({ headers: { cookie: `valopay_sandbox=${value}` }, secure: false, auth: auth() }) as any;
const response = () => ({ cookie() {} }) as any;
let server: Server | undefined;
try {
  const merchants = await inWorkspace(request(), response(), listMerchants);
  const merchantId = merchants[0]!.id, siblingId = merchants[1]!.id;
  const prefix = randomUUID();
  // 10,000 customer records and 20,000 unrelated records are intentionally in
  // the same lender, so a full-state read cannot look fast by missing the load.
  await pool.query(`INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,customer_id,data,created_at,updated_at)
    SELECT $1 || '-' || lpad(i::text,5,'0'), $2, 'customers',
      CASE WHEN i%997=0 THEN 'Dami Adéyẹmí ' ELSE 'Sample customer ' END || i,
      CASE WHEN i%3=0 THEN 'inactive' ELSE 'active' END, 'PAGE-' || i, '',
      jsonb_build_object('synthetic',true,'phone','+234 800 ' || i,'note','literal % _ : spaces  stay','sequence',i,'tiny',1e-8::numeric),
      '2027-01-01'::timestamptz + (i/3)*interval '1 millisecond', '2027-02-01'::timestamptz + i*interval '1 millisecond'
    FROM generate_series(1,10000) i`, [prefix, merchantId]);
  await pool.query(`INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,data)
    SELECT $1 || '-event-' || i, $2, 'observations', 'Unrelated evidence ' || i, 'received', '',
      jsonb_build_object('synthetic',true,'detail',repeat('x',400)) FROM generate_series(1,20000) i`, [prefix, merchantId]);
  await pool.query("ANALYZE valopay_records");
  let baseline!: DomainState;
  const baselineStart = performance.now();
  await inWorkspace(request(), response(), async context => { baseline = await loadState(context, merchantId, "share"); });
  const baselineMs = performance.now() - baselineStart;
  const customers = baseline.records.filter(row => row.kind === "customers");
  assert.equal(customers.length, 10008);
  const queries: ListQuery[] = [
    { limit: 25 }, { limit: 25, offset: 25 }, { limit: 100, offset: 9900 }, { limit: 25, offset: 10007 }, { limit: 25, offset: 20000 },
    { status: "inactive", limit: 25, offset: 50 }, { updatedSince: "2027-02-01T00:00:09.990Z", limit: 4 },
    { search: "ADEYEMI", limit: 3, offset: 2 }, { search: "adéyẹmí", limit: 25 },
    { search: '"sequence":997', limit: 25 }, { search: "spaces  stay", limit: 25 },
    { search: "literal % _", limit: 25 }, { search: "1e-8", limit: 25 }, { search: "no such customer", limit: 25 },
    { search: "active", status: "inactive", limit: 25, offset: 40 },
    { id: customers[9000]!.id, limit: 25 }, { id: "missing", limit: 25 },
  ];
  for (const query of queries) {
    const actual = await inWorkspace(request(), response(), context => listRecords(context, merchantId, "customers", query));
    assert.deepEqual(actual, pageRecords(customers, query), `DB page preserves search/filter/total contract: ${JSON.stringify(query)}`);
  }
  // The allocation picker's list: PostgreSQL keeps just the instalments a manual allocation accepts, as pageRecords
  // does, whatever their status, balance, a balance that is not a whole number, is not a number or is missing.
  await pool.query(`INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data,created_at,updated_at)
    SELECT $1 || '-due-' || i, $2, 'due-items', 'Picker instalment ' || i,
      (ARRAY['scheduled','in_collection','partially_paid','paid','unpaid_final','in_dispute','cancelled','closed'])[1 + i % 8], 'PICK-' || i, 1000000, '',
      CASE WHEN i % 5 = 0 THEN jsonb_build_object('synthetic',true) WHEN i % 7 = 0 THEN jsonb_build_object('synthetic',true,'outstandingKobo',1.5)
        WHEN i % 11 = 0 THEN jsonb_build_object('synthetic',true,'outstandingKobo','not a number')
        ELSE jsonb_build_object('synthetic',true,'outstandingKobo',CASE WHEN i % 3 = 0 THEN 0 ELSE 600000 END) END,
      '2027-03-01'::timestamptz + i*interval '1 second', '2027-03-01'::timestamptz + i*interval '1 second'
    FROM generate_series(1,60) i`, [prefix, merchantId]);
  // A renewed reversal review's hold may leave an instalment's status as it was, and the service refuses to allocate to a
  // held instalment, so the picker leaves every held one out, whatever its status; an empty or malformed list holds nothing.
  await pool.query(`INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data,created_at,updated_at) VALUES
    ($1 || '-held-final',$2,'due-items','Held instalment unpaid after its final attempt','unpaid_final','PICK-HELD-1',1000000,'','{"synthetic":true,"outstandingKobo":600000,"legacyReversalReviewIds":["review-1"]}','2027-03-01','2027-03-01'),
    ($1 || '-held-collecting',$2,'due-items','Held instalment in collection','in_collection','PICK-HELD-2',1000000,'','{"synthetic":true,"outstandingKobo":600000,"legacyReversalReviewIds":["review-1","review-2"]}','2027-03-01','2027-03-01'),
    ($1 || '-held-none',$2,'due-items','Instalment with no review','unpaid_final','PICK-HELD-3',1000000,'','{"synthetic":true,"outstandingKobo":600000,"legacyReversalReviewIds":[]}','2027-03-01','2027-03-01'),
    ($1 || '-held-text',$2,'due-items','Instalment with a malformed review list','scheduled','PICK-HELD-4',1000000,'','{"synthetic":true,"outstandingKobo":600000,"legacyReversalReviewIds":"review-1"}','2027-03-01','2027-03-01')`, [prefix, merchantId]);
  const offered = new Set((await inWorkspace(request(), response(), context => listRecords(context, merchantId, "due-items", { allocatable: "true" }))).items.map(row => row.id));
  assert.deepEqual(["final", "collecting", "none", "text"].map(suffix => offered.has(`${prefix}-held-${suffix}`)), [false, false, true, true], "a held instalment is not a choice, whatever its status");
  const dues = (await inWorkspace(request(), response(), context => loadState(context, merchantId, "share"))).records.filter(row => row.kind === "due-items");
  const choices = dues.filter(canTakeAllocation);
  assert.ok(choices.length > 10 && choices.length < dues.length, "the fixture has instalments on both sides");
  for (const query of [{ allocatable: "true", limit: 25 }, { allocatable: "true", limit: 25, offset: 25 }, { allocatable: "true", search: "picker instalment 1", limit: 5 }, { allocatable: "true", customerId: dues[0]!.customerId }, { allocatable: "false", limit: 25 }] as ListQuery[]) {
    const actual = await inWorkspace(request(), response(), context => listRecords(context, merchantId, "due-items", query));
    assert.deepEqual(actual, pageRecords(dues, query), `DB page keeps the allocation rule: ${JSON.stringify(query)}`);
  }
  assert.equal((await inWorkspace(request(), response(), context => listRecords(context, merchantId, "due-items", { allocatable: "true", limit: 1 }))).total, choices.length, "total counts the choices");
  await assert.rejects(() => inWorkspace(request(), response(), context => listRecords(context, merchantId, "payments", { allocatable: "true" })), (error: any) => error.status === 400 && /instalments only/.test(error.message), "allocatable is refused for another kind");
  // One payment's choices (paymentId): PostgreSQL applies the payer rule of its manual allocation, as the in-memory list does.
  const seededDues = dues.filter(row => row.customerId);
  const [payer, other] = [...new Set(seededDues.map(row => row.customerId))];
  const namedDue = seededDues.find(row => row.customerId === other)!;
  await pool.query(`INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data,created_at,updated_at) VALUES
    ($1 || '-pay-payer',$2,'payments','Payer named','unallocated','PICK-PAY-1',1000000,$3,'{"synthetic":true,"allocatedKobo":0}','2027-03-02','2027-03-02'),
    ($1 || '-pay-named',$2,'payments','Instalment named','unallocated','PICK-PAY-2',1000000,'',jsonb_build_object('synthetic',true,'allocatedKobo',0,'dueItemId',$4::text),'2027-03-02','2027-03-02'),
    ($1 || '-pay-none',$2,'payments','Nothing named','unallocated','PICK-PAY-3',1000000,'','{"synthetic":true,"allocatedKobo":0}','2027-03-02','2027-03-02'),
    ($1 || '-pay-usd',$2,'payments','Dollars','unallocated','PICK-PAY-4',100000,$3,'{"synthetic":true,"allocatedKobo":0,"currency":"USD"}','2027-03-02','2027-03-02'),
    ($1 || '-pay-back',$2,'payments','Reversed','returned','PICK-PAY-5',1000000,$3,'{"synthetic":true,"allocatedKobo":0,"reversalStatus":"reversed"}','2027-03-02','2027-03-02')`, [prefix, merchantId, payer, namedDue.id]);
  const everyChoice = await inWorkspace(request(), response(), context => listRecords(context, merchantId, "due-items", { allocatable: "true" }));
  for (const [suffix, customer] of [["payer", payer], ["named", other], ["none", undefined], ["usd", null], ["back", null]] as const) {
    const paymentId = `${prefix}-pay-${suffix}`;
    for (const query of [{ allocatable: "true", paymentId, limit: 25 }, { allocatable: "true", paymentId, limit: 2, offset: 1 }, { allocatable: "true", paymentId, search: "loan", limit: 5 }, { allocatable: "true", paymentId, customerId: payer }] as ListQuery[]) {
      const actual = await inWorkspace(request(), response(), context => listRecords(context, merchantId, "due-items", query));
      const payment = (await inWorkspace(request(), response(), context => loadState(context, merchantId, "share"))).records.find(row => row.id === paymentId)!;
      const choices = allocationChoices(query, allocationPayer(payment, suffix === "named" ? other : undefined));
      assert.deepEqual(actual, choices ? pageRecords(dues, choices) : { items: [], total: 0 }, `DB page keeps the payment's payer rule: ${suffix} ${JSON.stringify(query)}`);
      if (customer === null) assert.equal(actual.total, 0, `a payment no allocation accepts has no choices: ${suffix}`);
      else if (customer !== undefined) assert.ok(actual.items.every(row => row.customerId === customer) && (!query.customerId || query.customerId === customer || actual.total === 0), `only the payer's instalments: ${suffix}`);
      else if (!query.search && !query.customerId) assert.equal(actual.total, everyChoice.total, "a payment that names no payer or instalment takes every choice");
    }
  }
  await assert.rejects(() => inWorkspace(request(), response(), context => listRecords(context, merchantId, "due-items", { allocatable: "true", paymentId: "missing" })), (error: any) => error.status === 404 && /Payment not found/.test(error.message), "a payment the lender does not have is a 404");
  await assert.rejects(() => inWorkspace(request(), response(), context => listRecords(context, merchantId, "due-items", { paymentId: `${prefix}-pay-payer` })), (error: any) => error.status === 400 && /allocatable=true/.test(error.message), "paymentId without allocatable=true is refused");
  // The payer may be the customer the scoped reads below compare with the baseline, which has none of these payments.
  await pool.query("DELETE FROM valopay_records WHERE merchant_id = $1 AND id = ANY($2)", [merchantId, ["payer", "named", "none", "usd", "back"].map(suffix => `${prefix}-pay-${suffix}`)]);
  const timing: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    const page = await inWorkspace(request(), response(), context => listRecords(context, merchantId, "customers", { limit: 50, offset: i * 50 }));
    timing.push(performance.now() - start);
    assert.equal(page.items.length, 50);
    assert.equal(page.total, 10008);
  }
  // Inspect the actual parameterized query plan in this disposable schema.
  const plan = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM valopay_records
    WHERE merchant_id=$1 AND kind='customers' ORDER BY created_at DESC,id DESC LIMIT 50`, [merchantId]);
  assert.match(JSON.stringify(plan.rows), /Index (?:Only )?Scan/, "the schema's paging index supports the limited kind read");
  const sortedTimings = [...timing].sort((a,b) => a-b);
  console.log(JSON.stringify({ benchmark: "synthetic-record-pages", customerRows: 10008, unrelatedRows: 20000,
    fullStateMs: Math.round(baselineMs), databasePage50MedianMs: Math.round(sortedTimings[2]!), databasePage50MaxMs: Math.round(sortedTimings[4]!),
    explanation: "Local CI measurements, not a production latency guarantee; exact JSON/accent search uses bounded candidate scans." }));

  await assert.rejects(() => inWorkspace(request(otherToken), response(), context => listRecords(context, merchantId, "customers", { limit: 25 })), (error: any) => error.status === 404);
  const foreignExact = await inWorkspace(request(), response(), context => listRecords(context, siblingId, "customers", { id: customers[0]!.id }));
  assert.equal(foreignExact.total, 0, "ID filters never cross the lender boundary");
  await assert.rejects(() => inWorkspace(request(), response(), context => listRecords(context, merchantId, "customers", { updatedSince: "invalid" })), (error: any) => error.status === 400);
  await assert.rejects(() => inWorkspace(request(), response(), async context => {
    await listRecords(context, merchantId, "customers", { limit: 1 });
    await listRecords(context, siblingId, "customers", { limit: 1 });
  }), (error: any) => error.status === 409);
  const realCustomer = customers.find(row => row.reference.startsWith("DEMO-"))!;
  await inWorkspace(request(), response(), async context => {
    const view = await loadCustomerView(context, merchantId, realCustomer.id);
    assert.deepEqual(customerTimeline(view, realCustomer.id), customerTimeline(baseline, realCustomer.id), "customer balances and complete events survive scoped reads");
    assert.ok(view.records.length < 100);
    await assert.rejects(() => saveState(context, view), (error: any) => error.status === 409, "a partial read cannot become a mutation snapshot");
  });
  await inWorkspace(request(), response(), async context => {
    const view = await loadSettingsView(context, merchantId);
    const runtime = { state: "off" as const, intervalMs: null, lastTickAt: null };
    assert.deepEqual(buildConsoleSettings(view, context.role, context.now, runtime), buildConsoleSettings(baseline, context.role, context.now, runtime));
    assert.ok(view.records.every(row => ["integrations", "calendar", "closes"].includes(row.kind)));
  });

  // HTTP behavior on a separate small synthetic workspace: two editors cannot
  // silently overwrite one another; a committed retry still replays first.
  const editMerchants = await inWorkspace(request(editingToken), response(), listMerchants);
  const editingMerchant = editMerchants[0]!.id;
  const editState = await inWorkspace(request(editingToken), response(), context => loadState(context, editingMerchant, "share"));
  const customer = editState.records.find(row => row.kind === "customers")!;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).auth = auth(); (req as any).log = { info() {}, warn() {}, error() {} }; next(); });
  app.use("/api", router);
  app.use(errorHandler);
  server = await new Promise<Server>(resolve => { const running = app.listen(0, "127.0.0.1", () => resolve(running)); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  const api = async (path: string, method = "GET", body?: unknown, key?: string) => {
    const result = await fetch(`${base}${path}?merchantId=${editingMerchant}`, { method,
      headers: { Cookie: `valopay_sandbox=${editingToken}`, "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: result.status, body: await result.json() as any };
  };
  const edit = { name: "Reviewed customer name", expectedUpdatedAt: customer.updatedAt };
  const first = await api(`/records/customers/${customer.id}`, "PATCH", edit, "edit-customer-once");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.notEqual(first.body.updatedAt, customer.updatedAt);
  const stale = await api(`/records/customers/${customer.id}`, "PATCH", { ...edit, name: "Outdated second edit" }, "another-edit");
  assert.equal(stale.status, 409); assert.match(stale.body.error, /changed after you opened/);
  assert.deepEqual(await api(`/records/customers/${customer.id}`, "PATCH", edit, "edit-customer-once"), first, "a lost successful response replays before its now-stale timestamp check");
  assert.equal((await api(`/records/customers/${customer.id}`, "PATCH", { ...edit, name: "Different payload" }, "edit-customer-once")).status, 409);
  const settings = await api("/settings"); assert.match(settings.body.revision, /^[a-f0-9]{64}$/);
  const settingsEdit = { contactRoute: "Sample support route", expectedRevision: settings.body.revision };
  const savedSettings = await api("/settings", "PATCH", settingsEdit, "settings-once");
  assert.equal(savedSettings.status, 200, JSON.stringify(savedSettings.body));
  assert.notEqual(savedSettings.body.revision, settings.body.revision);
  assert.equal((await api("/settings", "PATCH", { contactRoute: "Outdated contact", expectedRevision: settings.body.revision })).status, 409);
  assert.deepEqual(await api("/settings", "PATCH", settingsEdit, "settings-once"), savedSettings);
  const mandate = editState.records.find(row => row.kind === "mandates" && row.status === "active")!;
  const suspend = { action: "mandate_suspend", recordId: mandate.id, reason: "Synthetic stale editor test", expectedUpdatedAt: mandate.updatedAt };
  const suspended = await api("/actions", "POST", suspend, "suspend-once");
  assert.equal(suspended.status, 200, JSON.stringify(suspended.body));
  assert.equal((await api("/actions", "POST", { ...suspend, action: "mandate_cancel" }, "cancel-stale")).status, 409);
  assert.deepEqual(await api("/actions", "POST", suspend, "suspend-once"), suspended);
  // Audit item 13: an instalment's status follows an amount edit, and the API alone numbers policy versions.
  const paidDue = editState.records.find(row => row.kind === "due-items" && row.reference === "DEMO-LOAN-1001")!;
  assert.equal(paidDue.status, "paid");
  const raised = await api(`/records/due-items/${paidDue.id}`, "PATCH", { amountKobo: 3_000_000, expectedUpdatedAt: paidDue.updatedAt }, "raise-paid-due");
  assert.equal(raised.status, 200, JSON.stringify(raised.body));
  assert.deepEqual([raised.body.status, raised.body.data.outstandingKobo], ["partially_paid", 500_000], "a paid instalment raised above what was paid is part-paid again");
  const reduced = await api(`/records/due-items/${paidDue.id}`, "PATCH", { amountKobo: 2_500_000, expectedUpdatedAt: raised.body.updatedAt }, "reduce-paid-due");
  assert.deepEqual([reduced.status, reduced.body.status, reduced.body.data.outstandingKobo], [200, "paid", 0], "reduced to what was paid, it is paid");
  const draftPolicy = editState.records.find(row => row.kind === "policies")!;
  const renumbered = await api(`/records/policies/${draftPolicy.id}`, "PATCH", { data: { version: 2 }, expectedUpdatedAt: draftPolicy.updatedAt });
  assert.equal(renumbered.status, 400, JSON.stringify(renumbered.body)); assert.match(renumbered.body.error, /version numbers are assigned/);
  const roleChange = { action: "set_role", data: { role: "Operations" } };
  const roleChanged = await api("/actions", "POST", roleChange, "role-switch-once");
  assert.equal(roleChanged.status, 200);
  assert.deepEqual(await api("/actions", "POST", roleChange, "role-switch-once"), roleChanged, "a role switch can replay after changing its own actor");
  assert.equal((await api("/actions", "POST", { action: "set_role", data: { role: "Admin" } }, "role-switch-once")).status, 409);
  const { queueExport } = await import("../src/lib/export-jobs");
  const jobs = await inWorkspace(request(editingToken), response(), async context => {
    const state = await loadState(context, editingMerchant);
    const result = ["failed", "running"].map(status => {
      // The persona is Operations now: it exports mandates, since the customer register is for Admin, Finance and Compliance reviewer (export_sensitive).
      const job = queueExport(state, context, { kind: "mandates", format: "csv" }, "/private/synthetic-tests");
      const record = state.records.find(row => row.id === job.id)!;
      record.status = status; Object.assign(record.data, { lastError: "Synthetic failure", leaseToken: "expired-claim", leaseExpiresAt: new Date(Date.parse(context.now) - 1).toISOString() });
      return { id: job.id, objectName: record.data.objectName, updatedAt: record.updatedAt };
    });
    await saveState(context, state); return result;
  });
  for (const job of jobs) {
    const retry = await api(`/exports/${job.id}/retry`, "POST", {}, `retry-${job.id}`);
    assert.equal(retry.status, 200, JSON.stringify(retry.body)); assert.equal(retry.body.status, "queued");
    assert.deepEqual(await api(`/exports/${job.id}/retry`, "POST", {}, `retry-${job.id}`), retry);
    await inWorkspace(request(editingToken), response(), async context => {
      const state = await loadState(context, editingMerchant, "share"); const record = state.records.find(row => row.id === job.id)!;
      assert.equal(record.status, "queued"); assert.equal(record.data.objectName, job.objectName);
      assert.equal(record.data.leaseToken, undefined); assert.equal(record.data.lastError, undefined);
      assert.ok(Date.parse(record.updatedAt) > Date.parse(job.updatedAt));
    }, "read");
  }
  console.log("Record list integration passed: 10k rows, scoped paging/counts, exact search, history totals, tenant isolation, stale edits, successful replay, instalment statuses that follow an edit and API-assigned policy versions.");
} finally {
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  // Leave other suites' fixtures untouched, and do not make scheduler tests
  // pay for this volume fixture after the benchmark has finished.
  const principals = [token, otherToken, editingToken].map(value => createHash("sha256").update(`demo:${value}`).digest("hex"));
  const ownMerchants = "SELECT id FROM valopay_merchants WHERE workspace_id IN (SELECT id FROM valopay_workspaces WHERE principal_hash=ANY($1::text[]))";
  await pool.query(`DELETE FROM valopay_idempotency WHERE merchant_id IN (${ownMerchants})`, [principals]);
  await pool.query(`DELETE FROM valopay_records WHERE merchant_id IN (${ownMerchants})`, [principals]);
  await pool.query("DELETE FROM valopay_merchants WHERE workspace_id IN (SELECT id FROM valopay_workspaces WHERE principal_hash=ANY($1::text[]))", [principals]);
  await pool.query("DELETE FROM valopay_workspaces WHERE principal_hash=ANY($1::text[])", [principals]);
  await pool.end();
}
