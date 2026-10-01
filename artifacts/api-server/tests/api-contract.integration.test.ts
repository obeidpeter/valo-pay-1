// Database-backed checks of the API contract (audit item 24). Every answer in
// this suite, success or refusal, is checked against lib/api-spec/openapi.json:
// its status must be one the contract lists for the operation, and its body
// must match the schema the contract gives that status. The journey below
// answers every console-facing operation at least once, in the sandbox and on
// a staff host, so each described shape is tested against a real answer.
// It also pins what the item fixed: the sandbox team directory's lenders, one
// 400 for a missing merchantId, date-times with an offset, the writes that
// take an optional Idempotency-Key, and an invalid answer that saves nothing;
// and what its review found: a keyed write repeated after a retention run and
// an export whose file retention deleted answer 410, the export queue and the
// new-sandbox limit say when to retry, a replayed receipt never claims nothing
// was saved, and a stored retention run's timestamp is not blamed on the request.
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { answerErrors, contractOperations, loadContract, operationFor } from "./contract-schema";

if (process.env.VALOPAY_RUN_INTEGRATION !== "1") {
  console.log("Set VALOPAY_RUN_INTEGRATION=1 to check the API contract against a disposable PostgreSQL database.");
  process.exit(0);
}
// Placeholder identity and storage settings: nothing here reaches Clerk or object storage.
process.env.CLERK_SECRET_KEY = "sk_test_placeholder";
process.env.PRIVATE_OBJECT_DIR ||= "/contract-test-bucket/private";
const { pool } = await import("@workspace/db");
const { default: router } = await import("../src/routes/index");
const { errorHandler } = await import("../src/lib/error-handler");
const { withState } = await import("../src/routes/valopay");
const { CreateRecordResponse } = await import("@workspace/api-zod");
const store = await import("../src/lib/valopay-store");
const { makeRecord } = await import("../src/domain/records");
const { recoverableRequest } = await import("../src/lib/operation-recovery");
const { clerkClient } = await import("@clerk/express");

const spec = loadContract();
const identities = new Map<string, any>();
/** What the routes logged: an answer that does not match its contract is logged, never answered, in detail. */
const logged: Array<{ level: string; fields: Record<string, any> }> = [];
const events = (event: string) => logged.filter((line) => line.fields?.event === event);
const app = express();
let requests = 0;
// The service gives every request an id (pino-http) that every error body quotes.
app.use((req, _res, next) => { (req as any).id = `contract-${++requests}`; next(); });
app.use(express.json({ limit: "2mb" }));
app.use((req, _res, next) => {
  const auth = identities.get(String(req.header("X-Test-Identity"))) || { userId: null };
  (req as any).auth = Object.assign(() => auth, { [Symbol.for("@clerk/express.auth")]: true });
  const log = (level: string) => (fields: Record<string, any>) => { logged.push({ level, fields }); };
  (req as any).log = { info: log("info"), warn: log("warn"), error: log("error") };
  next();
});
app.use("/api", router);
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const cookie = `valopay_sandbox=${randomBytes(32).toString("hex")}`;

/** Operation → statuses it answered in this run. */
const answered = new Map<string, Set<number>>();
/** The sandbox persona the journey is acting as, and every keyed write it saved: a retention run removes their stored results. */
let persona = "Admin";
const keyedWrites: Array<{ path: string; method: string; body: unknown; key: string; persona: string }> = [];
async function call(path: string, method = "GET", body?: unknown, options: { key?: string; identity?: string; cookie?: string } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", Cookie: options.cookie ?? cookie, ...(options.key ? { "Idempotency-Key": options.key } : {}), ...(options.identity ? { "X-Test-Identity": options.identity } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data: any = await response.json();
  assert.deepEqual(answerErrors(spec, method, path, response.status, data), [], `${method} ${path} answered ${response.status} as the contract documents: ${JSON.stringify(data).slice(0, 600)}`);
  const entry = operationFor(spec, method, path)!;
  const name = `${entry.method} ${entry.path}`;
  answered.set(name, (answered.get(name) ?? new Set()).add(response.status));
  if (response.status === 200 && options.key && !options.identity && !options.cookie) keyedWrites.push({ path, method, body, key: options.key, persona });
  if (response.status === 200 && name === "POST /v1/actions" && (body as any)?.action === "set_role") persona = (body as any).data.role;
  return { status: response.status, data, headers: response.headers };
}
const ok = (result: { status: number; data: any }) => { assert.equal(result.status, 200, JSON.stringify(result.data).slice(0, 800)); return result.data; };
const refusedFor = (result: { status: number; data: any }, status: number, field: string) => {
  assert.equal(result.status, status, JSON.stringify(result.data));
  assert.ok((result.data.details ?? []).some((detail: { field: string }) => detail.field === field), `the refusal names ${field}: ${JSON.stringify(result.data)}`);
};
/** The same instant written with a +01:00 offset, as another client may send it. */
const withOffset = (iso: string) => new Date(Date.parse(iso) + 3_600_000).toISOString().replace("Z", "+01:00");
const key = () => randomUUID();
const cleanupWorkspaces = new Set<string>();
const workspaceOf = async (merchantId: string) => (await pool.query("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [merchantId])).rows[0].workspace_id as string;
const savedEnv = { mode: process.env.VALOPAY_STAFF_ACCESS, issuer: process.env.VALOPAY_STAFF_ISSUER, origins: process.env.VALOPAY_STAFF_ORIGINS };
const oldGetUser = clerkClient.users.getUser;

try {
  const workspace = ok(await call("/v1/workspace"));
  const lender = workspace.merchants[0].id as string, other = workspace.merchants[1].id as string;
  cleanupWorkspaces.add(await workspaceOf(lender));
  const q = (path: string, merchantId = lender) => `${path}${path.includes("?") ? "&" : "?"}merchantId=${merchantId}`;
  const act = async (data: Record<string, unknown>, merchantId = lender) => ok(await call(q("/v1/actions", merchantId), "POST", { reason: "Contract check of a synthetic action", ...data }, { key: key() }));

  // ---- BIL-02: design-partner dates through real transport and persistence: the cause of a refusal, the proposal and the one visitor ----
  // Separate synthetic workspace: these requests must not alter the contract journey's retained-request fixtures below.
  // All answers still pass the OpenAPI assertions in call(). A second person confirms, and invoices are priced, on the staff host below.
  {
    const billingCookie = `valopay_sandbox=${randomBytes(32).toString("hex")}`;
    const billingWorkspace = ok(await call("/v1/workspace", "GET", undefined, { cookie: billingCookie }));
    const billingLender = billingWorkspace.merchants[0].id as string;
    cleanupWorkspaces.add(await workspaceOf(billingLender));
    const bq = (path: string) => q(path, billingLender);
    const billingCall = (path: string, method = "GET", body?: unknown) =>
      call(bq(path), method, body, { cookie: billingCookie, ...(method === "GET" ? {} : { key: key() }) });
    const billingAct = (action: string, data: Record<string, unknown> = {}, recordId?: string) =>
      billingCall("/v1/actions", "POST", { action, data, recordId, reason: "Verify reviewed synthetic billing terms and their preserved invoice history." });
    const { previousMonth, monthOf } = await import("../src/domain/billing");
    const currentPeriod = monthOf(new Date().toISOString());
    const secondPeriod = previousMonth(`${currentPeriod}-15T12:00:00.000Z`);
    const firstPeriod = previousMonth(`${secondPeriod}-15T12:00:00.000Z`);
    const licenceKobo = 1_500_000;
    let terms = ok(await billingCall("/v1/records/commercial", "POST", {
      name: "Reviewed contract fixture", status: "signed", reference: "SYN-BILLING-TERMS",
      data: { signed: true, signedFullPriceTerms: true, designPartner: true, licenceKobo, effectiveDate: `${firstPeriod}-01` },
    }));
    assert.equal(terms.data.discountReview, undefined, "legacy terms receive no invented dates or review");
    const counts = async () => (await pool.query("SELECT kind,count(*)::int AS count FROM valopay_records WHERE merchant_id=$1 GROUP BY kind ORDER BY kind", [billingLender])).rows;
    const beforeRefusal = await counts();
    const blocked = await billingAct("issue_invoice", { period: firstPeriod });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.data));
    assert.match(blocked.data.error, /The discount start date, the full-price start date and the signed agreement reference are missing/, "the refusal names what is missing");
    assert.deepEqual(await counts(), beforeRefusal, "a refused invoice changes neither financial records nor audit evidence (its refusal journal is separate)");

    const dates = { discountStartDate: `${firstPeriod}-01`, fullPriceStartDate: `${currentPeriod}-01`, discountTermsReference: "SYN-REVIEWED-AGREEMENT" };
    ok(await billingAct("set_role", { role: "Read-only" }));
    assert.equal((await billingCall(`/v1/records/commercial/${terms.id}`, "PATCH", { expectedUpdatedAt: terms.updatedAt, data: dates })).status, 403,
      "read-only access cannot propose commercial dates");
    ok(await billingAct("set_role", { role: "Finance" }));
    /** A proposal of these dates as the service records one, with who and when. */
    const reviewOf = (who: Record<string, string>) => ({ discountStartDate: dates.discountStartDate, fullPriceStartDate: dates.fullPriceStartDate, termsReference: dates.discountTermsReference, ...who });
    for (const discountReview of [
      reviewOf({ reviewedBy: "Someone else", reviewedAt: new Date().toISOString() }),
      reviewOf({ reviewedBy: "Sandbox Finance", reviewedAt: new Date().toISOString(), confirmedBy: "Someone else", confirmedPrincipal: "someone-else", confirmedAt: new Date().toISOString() }),
    ]) {
      const forged = await billingCall(`/v1/records/commercial/${terms.id}`, "PATCH", { expectedUpdatedAt: terms.updatedAt, data: { ...dates, discountReview } });
      assert.equal(forged.status, 400, JSON.stringify(forged.data));
      assert.match(forged.data.error, /Who proposed and who confirmed the discount dates is recorded by the service and cannot be supplied or edited/);
    }
    // Dates saved without ticking the full-price terms: saved, not proposed, and the refusal and the report name the flag.
    terms = ok(await billingCall(`/v1/records/commercial/${terms.id}`, "PATCH", { expectedUpdatedAt: terms.updatedAt, data: { ...dates, signedFullPriceTerms: false } }));
    assert.equal(terms.data.discountReview, undefined, "nothing is proposed while the full-price terms are not signed");
    const flag = await billingAct("issue_invoice", { period: firstPeriod });
    assert.equal(flag.status, 409, JSON.stringify(flag.data));
    assert.match(flag.data.error, /The full-price terms are not recorded as signed: tick “Full-price terms are signed”/);
    assert.equal(ok(await billingCall("/v1/reports")).billing.nextInvoicePricingExplanation, flag.data.error, "the report gives the refusal's words");
    // Ticked, the dates are a proposal by the Finance persona, at the database's time, bound to the sandbox's visitor.
    terms = ok(await billingCall(`/v1/records/commercial/${terms.id}`, "PATCH", { expectedUpdatedAt: terms.updatedAt, data: { signedFullPriceTerms: true } }));
    assert.equal(terms.data.discountReview.reviewedBy, "Sandbox Finance");
    assert.equal(terms.data.discountReview.reviewedAt, terms.updatedAt, "the database transaction supplies the proposal time");
    assert.match(terms.data.discountReview.proposedPrincipal, /\S/, "the proposal names the person behind the persona");
    assert.equal(terms.data.discountReview.confirmedBy, undefined);
    const proposed = structuredClone(terms.data.discountReview);
    const awaiting = await billingAct("issue_invoice", { period: firstPeriod });
    assert.equal(awaiting.status, 409, JSON.stringify(awaiting.data));
    assert.match(awaiting.data.error, /The discount dates await confirmation: a different Admin or Finance user from the person who proposed them must confirm them/);
    // A confirmation is keyed, so the operations journal records it: without a key it is refused, naming the header.
    refusedFor(await call(bq("/v1/actions"), "POST", { action: "confirm_discount_terms", recordId: terms.id, reason: "Confirm without a key", data: dates }, { cookie: billingCookie }), 400, "Idempotency-Key");
    // Switching demo roles is not a second person.
    ok(await billingAct("set_role", { role: "Admin" }));
    const self = await billingAct("confirm_discount_terms", dates, terms.id);
    assert.equal(self.status, 403, JSON.stringify(self.data));
    assert.match(self.data.error, /switching demo roles does not provide independent confirmation/);
    terms = ok(await billingCall(`/v1/records/commercial/${terms.id}`, "PATCH", { expectedUpdatedAt: terms.updatedAt, name: "Reviewed contract fixture, renamed" }));
    assert.deepEqual(terms.data.discountReview, proposed, "PATCH without data keeps the recorded proposal");
    assert.deepEqual(ok(await billingCall("/v1/records/commercial")).items.find((row: any) => row.id === terms.id).data.discountReview, proposed,
      "the proposal is durable and survives a fresh API read");
    // A single-person review an earlier build stamped (no principal, no confirmation) is a proposal awaiting confirmation.
    const fixtureRequest = { headers: { cookie: billingCookie }, secure: false, auth: Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true }) } as any;
    await store.inWorkspace(fixtureRequest, { cookie() {} } as any, async (ctx) => {
      const state = await store.loadState(ctx, billingLender);
      const stored = state.records.find((record) => record.id === terms.id)!;
      stored.data.discountReview = reviewOf({ reviewedBy: "Sandbox Finance", reviewedAt: stored.updatedAt });
      store.appendAudit(state, ctx, "test.billing.fixture", stored.id, "Stored a synthetic single-person review as an earlier build recorded it.");
      await store.saveState(ctx, state);
    });
    const legacy = ok(await billingCall("/v1/reports")).billing;
    assert.deepEqual([legacy.nextInvoicePricingReady, legacy.nextInvoicePricingExplanation], [false, awaiting.data.error], "an earlier build's single-person review awaits confirmation");
    const legacySelf = await billingAct("confirm_discount_terms", dates, terms.id);
    assert.equal(legacySelf.status, 403, "in a sandbox, its reviewer is the visitor who would confirm it");
    console.log("Billing HTTP/PostgreSQL sandbox checks passed: the refusal names its cause, proposals recorded by the service, forged proposals and confirmations refused, keyed confirmation, and one visitor in every demo role.");
  }

  // ---- The sandbox team directory has the lenders its contract requires ----
  const team = ok(await call("/v1/team"));
  assert.equal(team.mode, "sandbox");
  assert.deepEqual(team.lenders, [], "the sandbox directory lists no lenders, as its message says");
  assert.deepEqual([team.members, team.invitations, team.events], [[], [], []]);

  // ---- A missing merchantId is the same 400, naming the field, on every lender-scoped read ----
  for (const entry of contractOperations(spec).filter((item) => item.method === "GET" && (item.operation.parameters ?? []).some((p: any) => p.name === "merchantId" && p.required))) {
    const path = entry.path.replace(/\{(\w+)\}/g, (_m, name: string) => {
      const schema = (entry.operation.parameters as any[]).find((p) => p.name === name)?.schema ?? {};
      return schema.enum ? schema.enum[0] : name === "kind" ? "customers" : randomUUID();
    });
    const others = (entry.operation.parameters as any[]).filter((p) => p.in === "query" && p.required && p.name !== "merchantId").map((p) => `${p.name}=a`);
    refusedFor(await call(others.length ? `${path}?${others.join("&")}` : path), 400, "merchantId");
  }

  // ---- Reads the item named, each answered with its described shape ----
  for (const path of ["/v1/pilot/journey", "/v1/pilot/progress", "/v1/pilot/close-reviews", "/v1/pilot/batches", "/v1/operations", "/v1/operations/pending", "/v1/connected", "/v1/sources", "/v1/work", "/v1/lifecycle", "/v1/overview", "/v1/reports", "/v1/reports?includeCloses=false", "/v1/gates", "/v1/settings", "/v1/records/customers?limit=2", "/v1/queues/exceptions", "/v1/queues/mandates", "/v1/queues/collections", "/v1/reconciliation/proposals", "/v1/reconciliation/audit", "/v1/close-history"]) ok(await call(q(path)));
  ok(await call("/v1/team/readiness"));
  ok(await call("/healthz"));
  ok(await call("/readyz"));
  const webhook = await call("/v1/webhooks/test", "POST", {});
  assert.equal(webhook.status, 403);

  // ---- Writes whose key is optional run without one, and accept date-times with an offset ----
  const batchInput = { name: "Contract customers", kind: "customers", source: `contract-${randomUUID().slice(0, 8)}`, sourceBatchId: "batch-1", csv: "row_id,name,reference,consentProvenance\nr1,Contract customer,CONTRACT-C001,Synthetic consent", mapping: {}, amountUnit: "naira", identityColumn: "row_id", syntheticOnly: true };
  let batch = ok(await call(q("/v1/pilot/batches"), "POST", batchInput));
  batch = ok(await call(q(`/v1/pilot/batches/${batch.id}/save`), "POST", { ...batchInput, name: "Contract customers, revised", expectedUpdatedAt: withOffset(batch.updatedAt) }));
  const detail = ok(await call(q(`/v1/pilot/batches/${batch.id}`)));
  assert.equal(detail.batch.id, batch.id);
  batch = ok(await call(q(`/v1/pilot/batches/${batch.id}/commit`), "POST", { expectedUpdatedAt: withOffset(batch.updatedAt) }));
  assert.equal(batch.status, "committed", "a version sent with an offset matches the stored instant");
  assert.equal(ok(await call(q("/v1/pilot/batches"))).items[0].id, batch.id);

  const exception = ok(await call(q("/v1/records/exceptions"))).items.find((item: any) => !["resolved", "closed"].includes(item.status));
  ok(await call(q(`/v1/pilot/cases/${exception.id}`)));
  const nextActionAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
  let claimed = ok(await call(q(`/v1/pilot/cases/${exception.id}`), "POST", { action: "claim", expectedUpdatedAt: withOffset(exception.updatedAt), note: "Checking the receipt evidence.", nextAction: "Ask Finance to check the match", nextActionAt: withOffset(nextActionAt), evidenceIds: [] }));
  assert.equal(claimed.data.case.nextActionAt, nextActionAt, "the next action time is stored as the UTC instant");

  const firstExpectedAt = new Date(Date.now() - 86_400_000).toISOString();
  let profile = ok(await call(q("/v1/sources/profiles"), "POST", { name: "Contract source", source: batchInput.source, kind: "customers", mapping: {}, identityColumn: "row_id", amountUnit: "naira", firstExpectedAt: withOffset(firstExpectedAt), cadenceHours: 24, graceMinutes: 60, syntheticOnly: true }));
  assert.equal(profile.data.firstExpectedAt, firstExpectedAt);
  profile = ok(await call(q(`/v1/sources/profiles/${profile.id}/save`), "POST", { name: "Contract source, revised", source: batchInput.source, kind: "customers", mapping: {}, identityColumn: "row_id", amountUnit: "naira", firstExpectedAt, cadenceHours: 24, graceMinutes: 60, syntheticOnly: true, expectedUpdatedAt: withOffset(profile.updatedAt) }));
  const fixture = ok(await call(q("/v1/sources/paystack/fixtures"), "POST", { scenario: "payment", syntheticOnly: true }));
  ok(await call(q(`/v1/sources/events/${fixture.event.id}/replay`), "POST", { expectedUpdatedAt: withOffset(fixture.event.updatedAt), reason: "Contract replay" }));

  // ---- Writes whose key is required refuse a request without one, naming the header ----
  const businessDate = new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
  const manifest = { businessDate, files: [], noFilesExpected: true, reason: "No files are expected for this contract check.", evidence: "Synthetic contract fixture", syntheticOnly: true };
  refusedFor(await call(q("/v1/sources/manifests"), "POST", manifest), 400, "Idempotency-Key");
  ok(await call(q("/v1/sources/manifests"), "POST", manifest, { key: key() }));
  refusedFor(await call("/v1/pilot/lenders", "POST", { name: "Contract lender", segment: "Cooperative" }), 400, "Idempotency-Key");
  const created = ok(await call("/v1/pilot/lenders", "POST", { name: "Contract lender", segment: "Cooperative" }, { key: key() }));
  assert.equal(created.status, "onboarding");

  // ---- Import corrections on the committed batch ----
  const corrections = ok(await call(q(`/v1/pilot/import-corrections?batchId=${batch.id}`)));
  const target = corrections.targets[0];
  const previewInput = { batchId: batch.id, targetId: target.id, expectedUpdatedAt: withOffset(target.updatedAt), changes: { name: "Contract customer, corrected" }, syntheticOnly: true };
  const preview = ok(await call(q("/v1/pilot/import-corrections/preview"), "POST", previewInput));
  const proposal = { ...previewInput, previewDigest: preview.previewDigest, reviewer: "Sandbox Finance", reason: "Correct the synthetic customer's name.", evidence: "Contract check" };
  refusedFor(await call(q("/v1/pilot/import-corrections"), "POST", proposal), 400, "Idempotency-Key");
  const proposed = ok(await call(q("/v1/pilot/import-corrections"), "POST", proposal, { key: key() }));
  const recovery = { proposalDigest: proposed.proposalDigest, expectedAssignmentEventId: null, reviewer: 'Sandbox Finance', reason: 'Inspect the recovery request contract before reassignment.' };
  refusedFor(await call(q(`/v1/pilot/import-corrections/${proposed.id}/recovery`), 'POST', recovery), 400, 'Idempotency-Key');
  assert.equal((await call(q(`/v1/pilot/import-corrections/${proposed.id}/recovery`), 'POST', recovery, { key: key() })).status, 409, 'Reassignment must name a different Finance reviewer; this sandbox has only one.');
  ok(await call(q(`/v1/pilot/import-corrections/${proposed.id}/decision`), "POST", { proposalDigest: proposed.proposalDigest, action: "withdraw", reason: "Withdrawn at the end of the contract check." }, { key: key() }));

  // ---- Connected workspace: a read, an action with its required key, and a cash outcome ----
  let connected = ok(await call(q("/v1/connected")));
  const grant = { action: "consent.grant", reason: "Grant a synthetic permission for the contract check", data: { purpose: "merchant_account_read", subjectId: "sme", days: 30 }, expectedRevision: connected.revision };
  refusedFor(await call(q("/v1/connected/actions"), "POST", grant), 400, "Idempotency-Key");
  ok(await call(q("/v1/connected/actions"), "POST", grant, { key: key() }));
  connected = ok(await call(q("/v1/connected")));
  const initialised = ok(await call(q("/v1/connected/actions"), "POST", { action: "cash.initialize", reason: "Set up the sample Cash Desk", data: {}, expectedRevision: connected.revision }, { key: key() }));
  assert.equal(initialised.record.record.kind, "connected-cash-workspace", "a cash action answers its outcome inside record");
  connected = ok(await call(q("/v1/connected")));
  ok(await call(q("/v1/connected/actions"), "POST", { action: "cash.forecast", reason: "Save a sample forecast", data: {}, expectedRevision: connected.revision }, { key: key() }));
  connected = ok(await call(q("/v1/connected")));
  assert.equal(connected.cash.initialised, true);
  const customer = connected.customers[0].id;
  for (const purpose of ["account_read", "credit_assessment"]) {
    connected = ok(await call(q("/v1/connected")));
    ok(await call(q("/v1/connected/actions"), "POST", { action: "consent.grant", reason: "Grant an applicant permission", data: { purpose, subjectId: customer, days: 30 }, expectedRevision: connected.revision }, { key: key() }));
  }
  connected = ok(await call(q("/v1/connected")));
  ok(await call(q("/v1/connected/actions"), "POST", { action: "credit.assess", reason: "Run a sample assessment", data: { customerId: customer, scenario: "ready" }, expectedRevision: connected.revision }, { key: key() }));
  assert.equal(ok(await call(q("/v1/connected"))).credit.assessments.length, 1);
  // A pay-by-bank step that closes an exception whose condition cleared names it in its audit entry (the review of the audit fixes).
  {
    const allocated = ok(await call(q("/v1/records/payments?limit=100"))).items.find((item: any) => item.reference === "SBX-PAY-1001");
    const stale = ok(await call(q("/v1/records/exceptions"), "POST", { name: "Unallocated payment", customerId: allocated.customerId, amountKobo: allocated.amountKobo, data: { type: "unallocated_payment", notes: "Raised before the payment was allocated.", linkedRecordId: allocated.id } }, { key: key() }));
    const step = async (action: string, recordId?: string, data: Record<string, unknown> = {}) => ok(await call(q("/v1/connected/actions"), "POST", { action, recordId, reason: `Contract check: ${action}`, data, expectedRevision: ok(await call(q("/v1/connected"))).revision }, { key: key() }));
    const open = ok(await call(q("/v1/connected"))).payments.dues.find((item: any) => !item.blocked);
    const intent = (await step("payment.create", undefined, { dueItemId: open.id, amountKobo: open.outstandingKobo })).record;
    await step("payment.authorise", intent.id);
    await step("payment.outcome", intent.id, { outcome: "failed" });
    const cleared = (await pool.query("SELECT status,data FROM valopay_records WHERE id=$1", [stale.id])).rows[0];
    assert.deepEqual([cleared.status, cleared.data.resolutionCode], ["closed", "condition_cleared"], "the outcome step closed the exception whose condition cleared");
    const entry = (await pool.query("SELECT data FROM valopay_records WHERE merchant_id=$1 AND kind='audit' AND name='payment.outcome' ORDER BY (data->>'sequence')::int DESC LIMIT 1", [lender])).rows[0];
    assert.equal(entry.data.summary, "Contract check: payment.outcome. Closed 1 exception whose condition cleared (unallocated payment: payment SBX-PAY-1001 is allocated in full).", "and its audit entry names it after the reason");
  }

  // ---- The legacy writes take an optional key: with one they are journaled, without one they still run ----
  const customerBody = { name: "Contract customer", reference: `CONTRACT-${randomUUID()}`, data: { consentProvenance: "Synthetic fixture" } };
  const keyed = key();
  const record = ok(await call(q("/v1/records/customers"), "POST", customerBody, { key: keyed }));
  ok(await call(q("/v1/records/customers"), "POST", { ...customerBody, reference: `CONTRACT-${randomUUID()}` }));
  // An audit entry is named in words when an answer shows it, while its stored row keeps the route's code as its name and action.
  const listed = ok(await call(q(`/v1/records/audit?search=${encodeURIComponent(record.id)}&limit=50`))).items.find((item: any) => item.data?.action === "post.records.customers");
  assert.equal(listed?.name, "Customer added", "the audit list names the entry in words");
  const stored = (await pool.query("SELECT name, data->>'action' AS action FROM valopay_records WHERE merchant_id=$1 AND kind='audit' AND data->>'objectId'=$2 AND data->>'action'='post.records.customers'", [lender, record.id])).rows;
  assert.deepEqual(stored, [{ name: "post.records.customers", action: "post.records.customers" }], "and its stored row keeps the route's code");
  const renamed = ok(await call(q(`/v1/records/customers/${record.id}`), "PATCH", { name: "Contract customer, renamed", data: { phoneMasked: "+234 ••• ••31" }, expectedUpdatedAt: record.updatedAt }, { key: key() }));
  assert.equal(renamed.data.phoneMasked, "+234 ••• ••31");
  // An edit clears an optional data field by sending it as null (a merge patch); the fields it leaves out keep their values.
  const cleared = ok(await call(q(`/v1/records/customers/${record.id}`), "PATCH", { data: { phoneMasked: null }, expectedUpdatedAt: renamed.updatedAt }, { key: key() }));
  assert.equal("phoneMasked" in cleared.data, false, "a field sent as null is removed");
  assert.equal(cleared.data.consentProvenance, "Synthetic fixture", "a field left out keeps its value");
  assert.equal(cleared.name, "Contract customer, renamed");
  ok(await call(q(`/v1/customers/${record.id}/timeline`)));
  ok(await call(q(`/v1/customers/${record.id}/history`)));
  ok(await call(q("/v1/imports"), "POST", { kind: "customers", csv: "name,reference,consentProvenance\nImported contract customer,CONTRACT-I001,Synthetic consent", identityColumn: "reference", syntheticOnly: true, commit: false, amountUnit: "kobo" }));
  const settings = ok(await call(q("/v1/settings")));
  // Whether a lender is a public anonymous sandbox is set where its sandbox is seeded or creates it, never by a settings change.
  ok(await call(q("/v1/settings"), "PATCH", { closeTime: "07:00", anonymousWorkspace: false, expectedRevision: settings.revision }, { key: key() }));
  assert.equal((await pool.query("SELECT settings->>'anonymousWorkspace' AS flag FROM valopay_merchants WHERE id=$1", [lender])).rows[0].flag, "true", "a settings change cannot make a visitor's sandbox a lender");
  const job = ok(await call(q("/v1/exports"), "POST", { kind: "customers", format: "json" }, { key: key() }));
  ok(await call(q(`/v1/exports/${job.id}`)));
  ok(await call(q(`/v1/exports/${job.id}/retry`), "POST"));
  await act({ action: "run_reconciliation" });

  // ---- Finance identifies the payer of a payment whose evidence named none, in one action, and the audit entry says so ----
  const unidentified = ok(await call(q("/v1/records/payments?search=SBX-UNIDENTIFIED-001"))).items[0];
  const instalment = ok(await call(q("/v1/records/due-items?status=scheduled"))).items.find((item: any) => Number(item.data.outstandingKobo) >= 1_000_000);
  const identified = await act({ action: "manual_allocate", recordId: unidentified.id, reason: "Payer confirmed by phone", data: { dueItemId: instalment.id, amountKobo: 1_000_000 } });
  assert.equal(identified.data.payerCustomerId, instalment.customerId);
  const trail = (await pool.query("SELECT customer_id,data FROM valopay_records WHERE merchant_id=$1 AND kind='audit' ORDER BY (data->>'sequence')::int DESC LIMIT 1", [lender])).rows[0];
  assert.deepEqual([trail.data.action, trail.data.summary, trail.customer_id], ["manual_allocate", `Payer confirmed by phone. ${identified.data.auditNote}`, instalment.customerId], "the audit entry names the payer Finance identified");

  // ---- Operations: the journal, a recovered request and a cancelled one ----
  const journal = ok(await call(q("/v1/operations")));
  const completed = journal.items.find((item: any) => item.status === "completed" && item.recordId === record.id);
  assert.ok(completed, "the keyed record save is in the journal");
  assert.equal(ok(await call(q(`/v1/operations/${completed.id}/retry`), "POST")).id, record.id);
  const reloadIdentity = { key: keyed, method: 'POST', path: '/v1/records/customers' };
  assert.equal(ok(await call(q('/v1/operations/lookup'), 'POST', reloadIdentity)).operation.recordId, record.id);
  const notReceivedIdentity = { ...reloadIdentity, key: randomUUID() };
  assert.equal(ok(await call(q('/v1/operations/lookup'), 'POST', notReceivedIdentity)).operation, null);
  assert.match(ok(await call(q('/v1/operations/cancel-unreceived'), 'POST', notReceivedIdentity)).message, /it will not run/);
  assert.equal(ok(await call(q('/v1/operations/lookup'), 'POST', notReceivedIdentity)).operation.status, 'cancelled');
  const sandboxRequest = () => ({ headers: { cookie }, secure: false, auth: Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true }) }) as any;
  const response = { cookie() {} } as any;
  const { id: pendingId } = await store.inWorkspace(sandboxRequest(), response, (ctx) => store.prepareOperation(ctx, lender, key(), { method: "POST", path: "/v1/records/customers", body: { name: "Never sent" } }));
  assert.match(ok(await call(q(`/v1/operations/${pendingId}/cancel`), "POST")).message, /cancelled it/);

  // ---- Handover, personal work and receipts ----
  claimed = ok(await call(q(`/v1/pilot/cases/${exception.id}`), "POST", { action: "handover", assignee: "Sandbox Finance", expectedUpdatedAt: claimed.updatedAt, note: "Finance to check the match.", nextAction: "Check the match", nextActionAt, evidenceIds: [] }));
  await act({ action: "set_role", data: { role: "Finance" } });
  const work = ok(await call(q("/v1/work")));
  const handover = work.items.find((item: any) => item.sourceId === exception.id);
  assert.ok(handover?.canAcknowledge, JSON.stringify(work.items));
  const receipt = { sourceId: handover.sourceId, eventId: handover.eventId, expectedUpdatedAt: withOffset(handover.sourceVersion), expectedDigest: handover.sourceDigest };
  refusedFor(await call(q("/v1/work/notifications/read"), "POST", receipt), 400, "Idempotency-Key");
  ok(await call(q("/v1/work/notifications/read"), "POST", receipt, { key: key() }));
  ok(await call(q("/v1/work/handovers/acknowledge"), "POST", receipt, { key: key() }));
  await act({ action: "set_role", data: { role: "Admin" } });

  // ---- A daily close, its review and a returned decision ----
  await act({ action: "daily_close" });
  const closes = ok(await call(q("/v1/close-history")));
  ok(await call(q(`/v1/close-history/${closes.items[0].id}`)));
  const reviews = ok(await call(q("/v1/pilot/close-reviews")));
  const entry = ok(await call(q(`/v1/pilot/close-reviews/${reviews.closes[0].id}`))).entry;
  if (!entry.problem) {
    const prepare = { closeId: entry.close.id, expectedUpdatedAt: withOffset(entry.close.updatedAt), reviewer: "Sandbox Finance", preparationNote: "Prepared for the contract check.", discrepancyResponses: entry.issues.map((issue: any) => ({ issueId: issue.id, explanation: "Explained for the contract check." })), unresolvedAcceptance: "Owners and next steps recorded for the contract check." };
    refusedFor(await call(q("/v1/pilot/close-reviews/prepare"), "POST", prepare), 400, "Idempotency-Key");
    const review = ok(await call(q("/v1/pilot/close-reviews/prepare"), "POST", prepare, { key: key() }));
    // One browser switching demo roles is still one person, so the decision is refused here; a staff host decides (source-close-controls).
    await act({ action: "set_role", data: { role: "Finance" } });
    const decision = await call(q(`/v1/pilot/close-reviews/${review.id}/decision`), "POST", { expectedUpdatedAt: withOffset(review.updatedAt), action: "return", note: "Returned at the end of the contract check." }, { key: key() });
    assert.equal(decision.status, 403, JSON.stringify(decision.data));
    await act({ action: "set_role", data: { role: "Admin" } });
  } else assert.fail(`The contract check's close cannot be reviewed: ${entry.problem}`);

  // ---- Retention: policy and a hold on the committed batch's source rows ----
  let lifecycle = ok(await call(q("/v1/lifecycle")));
  lifecycle = ok(await call(q("/v1/lifecycle/policy"), "POST", { policy: { rawCsvDays: 30, journalPayloadDays: null, exportFileDays: null, auditTrail: "retain" }, expectedRevision: lifecycle.policyRevision, reason: "Keep source rows for thirty days." }, { key: key() }));
  const source = lifecycle.targets.find((item: any) => item.sourceId === batch.id);
  lifecycle = ok(await call(q("/v1/lifecycle/holds"), "POST", { kind: "raw_csv", sourceId: source.sourceId, held: true, expectedHoldRevision: lifecycle.holdRevision, reason: "Held for the contract check." }, { key: key() }));
  const nothingDue = await call(q("/v1/lifecycle/runs"), "POST", { expectedPolicyRevision: lifecycle.policyRevision }, { key: key() });
  assert.equal(nothingDue.status, 400, "no source is old enough to delete yet");

  // ---- The views again, now that they hold batches, profiles, events, cases, closes, reviews, receipts and holds ----
  for (const path of ["/v1/sources", "/v1/pilot/journey", "/v1/pilot/progress", "/v1/pilot/close-reviews", "/v1/pilot/batches", `/v1/pilot/batches/${batch.id}`, `/v1/pilot/cases/${exception.id}`, "/v1/operations", "/v1/work", "/v1/connected", "/v1/lifecycle"]) ok(await call(q(path)));

  // ---- A retention run removes the stored results of completed requests: a repeat with the same key is gone (410) ----
  // Every keyed write of the journey the journal records, made as the persona acting now, is repeated after the run.
  const repeatable = keyedWrites.filter((write) => write.persona === persona && recoverableRequest(write.method, write.path.split("?")[0]!, write.body));
  assert.ok(repeatable.length >= 10, `the journey saved keyed writes to repeat: ${repeatable.map((write) => `${write.method} ${write.path}`).join(", ")}`);
  // As far as the policy can tell, those requests finished a month ago: the sandbox keeps every category at least 30 days.
  await pool.query("UPDATE valopay_operations SET updated_at=updated_at - interval '31 days' WHERE merchant_id=$1 AND status='completed' AND request_key=ANY($2::text[])", [lender, repeatable.map((write) => write.key)]);
  lifecycle = ok(await call(q("/v1/lifecycle")));
  lifecycle = ok(await call(q("/v1/lifecycle/policy"), "POST", { policy: { rawCsvDays: 30, journalPayloadDays: 30, exportFileDays: null, auditTrail: "retain" }, expectedRevision: lifecycle.policyRevision, reason: "Remove request payloads thirty days after they finish." }, { key: key() }));
  let run = ok(await call(q("/v1/lifecycle/runs"), "POST", { expectedPolicyRevision: lifecycle.policyRevision }, { key: key() }));
  assert.equal(run.candidates.filter((candidate: any) => candidate.kind === "journal_payload").length, repeatable.length, "the run removes each repeatable request's stored payload and result");
  ok(await call(q(`/v1/lifecycle/runs/${run.id}`)));
  run = ok(await call(q(`/v1/lifecycle/runs/${run.id}/approve`), "POST", { expectedUpdatedAt: withOffset(run.updatedAt), previewDigest: run.previewDigest, reason: "Reviewed the request payloads for the contract check." }, { key: key() }));
  for (let step = 0; run.status !== "completed" && step <= run.candidateCount; step++) run = ok(await call(q(`/v1/lifecycle/runs/${run.id}/execute`), "POST", { previewDigest: run.previewDigest }, { key: key() }));
  assert.equal(run.status, "completed", JSON.stringify(run.receipts));
  for (const write of repeatable) {
    const repeat = await call(write.path, write.method, write.body, { key: write.key });
    assert.equal(repeat.status, 410, `${write.method} ${write.path} repeated after the retention run: ${JSON.stringify(repeat.data)}`);
  }
  // Recovering one from Operations is gone too; its entry keeps the request's identity and completion.
  const purgedEntry = (await pool.query("SELECT id,status FROM valopay_operations WHERE merchant_id=$1 AND request_key=$2", [lender, repeatable[0]!.key])).rows[0];
  assert.equal(purgedEntry.status, "completed");
  assert.equal((await call(q(`/v1/operations/${purgedEntry.id}/retry`), "POST")).status, 410);

  // ---- An export whose file retention deleted can be neither downloaded nor retried (410) ----
  // (The retention executor deletes the file in private storage, which this suite does not have; this is what it records.)
  await pool.query(`UPDATE valopay_records SET status='ready', data=data || jsonb_build_object('fileDeletedAt', $3::text, 'fileRetentionRunId', $4::text, 'checksum', repeat('a', 64)) WHERE merchant_id=$1 AND id=$2`, [lender, job.id, new Date().toISOString(), run.id]);
  assert.equal((await call(q(`/v1/exports/${job.id}/download`))).status, 410, "the file retention deleted is not downloaded");
  assert.equal((await call(q(`/v1/exports/${job.id}/retry`), "POST")).status, 410, "nor generated again under the same identity");
  // Its status answer says when, and names the run that holds the deletion receipt, which an administrator opens by that name.
  const expired = ok(await call(q(`/v1/exports/${job.id}`)));
  assert.deepEqual([typeof expired.expiredAt, expired.retentionRunId], ["string", run.id], "the status answer names the run that removed the file");
  assert.equal(ok(await call(q(`/v1/lifecycle/runs/${expired.retentionRunId}`))).id, run.id);

  // ---- A full export queue says when to retry: an eleventh waiting export is refused (429, Retry-After 30) ----
  for (let index = 0; index < 10; index++) ok(await call(q("/v1/exports"), "POST", { kind: "customers", format: "json" }));
  const queueFull = await call(q("/v1/exports"), "POST", { kind: "customers", format: "json" });
  assert.equal(queueFull.status, 429, JSON.stringify(queueFull.data));
  assert.equal(queueFull.headers.get("Retry-After"), "30", "the export queue's 429 says when to retry");

  // ---- A replayed receipt was saved with its request: it is never answered as "nothing was saved" ----
  // A receipt an earlier build stored with a field the contract no longer lists is answered without it, with a warning.
  connected = ok(await call(q("/v1/connected")));
  const replayKey = key(), replayGrant = { action: "consent.grant", reason: "Grant a synthetic permission for the replay check", data: { purpose: "erp_draft", subjectId: "sme", days: 30 }, expectedRevision: connected.revision };
  const grantAnswer = ok(await call(q("/v1/connected/actions"), "POST", replayGrant, { key: replayKey }));
  // A journaled request's answer is kept under its journal entry.
  const receiptId = (await pool.query("SELECT id FROM valopay_operations WHERE merchant_id=$1 AND request_key=$2", [lender, replayKey])).rows[0].id as string;
  const consents = async () => Number((await pool.query("SELECT count(*)::int AS n FROM valopay_records WHERE merchant_id=$1 AND kind='connected-consents'", [lender])).rows[0].n);
  const consentCount = await consents();
  assert.equal((await pool.query(`UPDATE valopay_idempotency SET response=jsonb_set(response,'{record,effectiveStatus}','"active"') WHERE merchant_id=$1 AND id=$2`, [lender, receiptId])).rowCount, 1);
  logged.length = 0;
  const replayed = await call(q("/v1/connected/actions"), "POST", replayGrant, { key: replayKey });
  assert.deepEqual([replayed.status, replayed.data], [200, grantAnswer], "the replay answers the saved receipt without the field the contract no longer lists");
  assert.deepEqual(events("response.invalid").map((line) => [line.level, line.fields.replayed]), [["warn", true]], "and logs it as a warning");
  // A receipt that fails in any other way cannot be answered within the contract: the unconfirmed 500, never "nothing was saved".
  await pool.query(`UPDATE valopay_idempotency SET response=response #- '{record,kind}' WHERE merchant_id=$1 AND id=$2`, [lender, receiptId]);
  logged.length = 0;
  const unanswerable = await call(q("/v1/connected/actions"), "POST", replayGrant, { key: replayKey });
  assert.deepEqual([unanswerable.status, unanswerable.data.error, unanswerable.data.committed, unanswerable.data.operation], [500, "Valo Pay saved this request but could not send its answer. Check the original request in Request history to see the saved result.", undefined, "completed"], "a saved request is never answered as saving nothing: the answer says it was saved");
  assert.deepEqual(events("response.invalid").map((line) => [line.level, line.fields.replayed]), [["error", true]]);
  assert.equal(await consents(), consentCount, "the consent was saved once");
  assert.equal((await pool.query("SELECT status FROM valopay_operations WHERE merchant_id=$1 AND request_key=$2", [lender, replayKey])).rows[0].status, "completed", "and its journal entry stays completed");
  // The same for a write whose route answers from withState, and for a repeated lender set-up.
  const manifestKey = key(), laterManifest = { ...manifest, businessDate: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10) };
  const declared = ok(await call(q("/v1/sources/manifests"), "POST", laterManifest, { key: manifestKey }));
  await pool.query(`UPDATE valopay_idempotency SET response=response || '{"legacyField": true}'::jsonb WHERE merchant_id=$1 AND id=(SELECT id FROM valopay_operations WHERE merchant_id=$1 AND request_key=$2)`, [lender, manifestKey]);
  assert.deepEqual(ok(await call(q("/v1/sources/manifests"), "POST", laterManifest, { key: manifestKey })), declared, "a replayed record answers without the field the contract no longer lists");
  const setUp = keyedWrites.find((write) => write.path === "/v1/pilot/lenders")!;
  await pool.query(`UPDATE valopay_merchants SET info=info || '{"legacyField": true}'::jsonb WHERE id=$1`, [created.id]);
  assert.deepEqual(ok(await call("/v1/pilot/lenders", "POST", setUp.body, { key: setUp.key })), created, "a repeated set-up answers the lender it created, without the field the contract no longer lists");
  await pool.query(`UPDATE valopay_merchants SET info=info - 'legacyField' WHERE id=$1`, [created.id]);

  // ---- A stored retention run's timestamp is the service's to answer, never blamed on the request ----
  // An expiry an earlier build stored with an offset is the same instant: the view answers it in UTC.
  const storedRun = randomUUID();
  await pool.query(`INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data) VALUES($1,$2,'retention-runs','Retention deletion preview','preview','',0,'',$3)`, [storedRun, lender, { candidates: [], previewDigest: "a".repeat(64), policyRevision: "b".repeat(64), moreEligible: 0, expiresAt: "2026-09-23T12:00:00+01:00", preparedBy: "Sandbox Admin", synthetic: true }]);
  assert.equal(ok(await call(q("/v1/lifecycle"))).runs.find((item: any) => item.id === storedRun).expiresAt, "2026-09-23T11:00:00.000Z", "a stored offset is answered as its UTC instant");
  // One that is no instant at all cannot be described: the service's 500, in a read's words, logged as response.invalid.
  await pool.query(`UPDATE valopay_records SET data=jsonb_set(data,'{expiresAt}','"next Tuesday"') WHERE merchant_id=$1 AND id=$2`, [lender, storedRun]);
  logged.length = 0;
  const unreadable = await call(q("/v1/lifecycle"));
  assert.deepEqual([unreadable.status, unreadable.data], [500, { error: "Valo Pay could not load this. Try again, and quote this reference if it happens again.", requestId: unreadable.data.requestId }], "a read's failure, without committed");
  assert.deepEqual([events("response.invalid").map((line) => line.level), events("request.rejected").length], [["error"], 0], "logged as an invalid answer, never as a rejected request");
  await pool.query("DELETE FROM valopay_records WHERE merchant_id=$1 AND id=$2", [lender, storedRun]);

  // ---- An answer that does not match its schema is a failure of the service, and saves nothing ----
  const before = Number((await pool.query("SELECT count(*)::int AS n FROM valopay_records WHERE merchant_id=$1 AND kind='customers'", [lender])).rows[0].n);
  const invalid = await withState({ ...sandboxRequest(), header: () => undefined, path: "/v1/records/customers", method: "POST", body: { name: "Invalid answer" }, params: {}, query: { merchantId: lender }, ip: "127.0.0.1" } as any, response, (state, ctx) => {
    makeRecord(state, "customers", { name: "Never saved", createdAt: ctx.now, data: { consentProvenance: "Synthetic fixture" } });
    return { name: "Not a record" };
  }, true, CreateRecordResponse).then(() => undefined, (error: unknown) => error);
  const answer = await new Promise<{ status: number; body: any }>((resolve) => {
    let status = 0;
    const res = { headersSent: false, setHeader() { return this; }, status(code: number) { status = code; return this; }, json(body: unknown) { resolve({ status, body }); return this; } };
    errorHandler(invalid, { id: "contract-invalid", log: { error() {}, warn() {}, info() {} } } as any, res as any, () => undefined);
  });
  assert.equal(answer.status, 500, `an invalid answer is the service's failure, not the request's: ${JSON.stringify(answer.body)}`);
  assert.equal(answer.body.committed, false, "and it says nothing was saved");
  assert.equal(Number((await pool.query("SELECT count(*)::int AS n FROM valopay_records WHERE merchant_id=$1 AND kind='customers'", [lender])).rows[0].n), before, "the record written before the invalid answer was rolled back");

  // A stored record the connected view cannot describe fails the read instead of reaching the console.
  const otherState = await store.inWorkspace(sandboxRequest(), response, async (ctx) => { const state = await store.loadState(ctx, other); makeRecord(state, "connected-credit-assessments", { name: "Malformed assessment", status: "blocked", createdAt: ctx.now, data: { result: { evidence: { grantVersions: [], issues: [] }, policy: {}, score: "not a score" }, scenario: "ready", createdBy: "Sandbox Operations" } }); store.appendAudit(state, ctx, "test.contract.malformed", other, "Stored a malformed synthetic forecast."); await store.saveState(ctx, state); return state.merchant.id; });
  const malformed = await call(q("/v1/connected", otherState));
  assert.equal(malformed.status, 500, "a malformed stored assessment fails the read");
  assert.deepEqual([malformed.data.error, malformed.data.committed], ["Valo Pay could not load this. Try again, and quote this reference if it happens again.", undefined], "in a read's words: a read saves nothing either way");

  // ---- New sandboxes from one address are limited, and the refusal says when to retry (429, Retry-After an hour) ----
  // Last of this suite's sandboxes: the limit is per process and address, and the staff host below needs none.
  let crowded: Awaited<ReturnType<typeof call>> | undefined;
  for (let visit = 0; visit < 25 && !crowded; visit++) {
    const answer = await call("/v1/workspace", "GET", undefined, { cookie: `valopay_sandbox=${randomBytes(32).toString("hex")}` });
    if (answer.status === 429) crowded = answer;
    else cleanupWorkspaces.add(await workspaceOf(ok(answer).merchants[0].id));
  }
  assert.ok(crowded, "the new-sandbox limit refused a visitor");
  assert.equal(crowded!.headers.get("Retry-After"), "3600", "and said to try again in an hour");

  // ---- A staff host: the team directory, invitations, memberships, lender access and readiness ----
  process.env.VALOPAY_STAFF_ACCESS = "staging";
  process.env.VALOPAY_STAFF_ISSUER = "https://identity.example";
  process.env.VALOPAY_STAFF_ORIGINS = "https://pilot.example";
  const organisation = `org_${randomUUID().replaceAll("-", "")}`, admin = `user_${randomUUID().replaceAll("-", "")}`, finance = `user_${randomUUID().replaceAll("-", "")}`;
  const staffAuth = (userId: string) => {
    const now = Math.floor(Date.now() / 1000);
    return { userId, sessionId: `sess_${userId}`, orgId: organisation, tokenType: "session_token", sessionStatus: "active", factorVerificationAge: [0, 0], has: () => true, sessionClaims: { sub: userId, sid: `sess_${userId}`, iss: "https://identity.example", azp: "https://pilot.example", iat: now - 1, exp: now + 3600 } };
  };
  identities.set("admin", staffAuth(admin));
  identities.set("finance", staffAuth(finance));
  const provisioned = await store.provisionStaffWorkspace(organisation, admin, "Contract staff organisation");
  cleanupWorkspaces.add(provisioned.workspaceId);
  const staffLender = ok(await call("/v1/pilot/lenders", "POST", { name: "Staff contract lender", segment: "Consumer lending" }, { key: key(), identity: "admin" }));
  ok(await call("/v1/team/verify", "POST", undefined, { identity: "admin" }));
  const invitation = ok(await call("/v1/team/invitations", "POST", { email: "finance@example.test", role: "Finance" }, { identity: "admin" }));
  const spare = ok(await call("/v1/team/invitations", "POST", { email: "spare@example.test", role: "Operations" }, { identity: "admin" }));
  ok(await call(`/v1/team/invitations/${spare.id}/revoke`, "POST", undefined, { identity: "admin" }));
  // A Finance grant waits for a second administrator, whom the operator adds.
  const second = `user_${randomUUID().replaceAll("-", "")}`;
  identities.set("second", staffAuth(second));
  await store.addStaffAdministrator(organisation, second, "Second contract administrator");
  ok(await call(`/v1/team/invitations/${invitation.id}/approve`, "POST", undefined, { identity: "second" }));
  (clerkClient.users as any).getUser = async () => ({ emailAddresses: [{ emailAddress: "finance@example.test", verification: { status: "verified" } }] });
  const accepted = ok(await call("/v1/team/accept", "POST", { token: invitation.token }, { identity: "finance" }));
  assert.equal(accepted.role, "Finance");
  const directory = ok(await call("/v1/team", "GET", undefined, { identity: "admin" }));
  assert.deepEqual(directory.lenders.map((item: any) => item.id), [staffLender.id]);
  assert.ok(directory.invitations.length >= 2 && directory.events.length >= 3, "an administrator sees invitations and access history");
  const member = directory.members.find((row: any) => row.actor === `Clerk:${finance}`);
  const granted = ok(await call(`/v1/team/members/${member.id}/lenders`, "PATCH", { expectedUpdatedAt: withOffset(member.updatedAt), lenderIds: [staffLender.id], reason: "Assign Finance to the contract lender." }, { identity: "admin" }));
  const suspended = ok(await call(`/v1/team/members/${member.id}`, "PATCH", { role: "Finance", status: "suspended", expectedUpdatedAt: withOffset(granted.updatedAt), reason: "Suspended at the end of the contract check." }, { identity: "admin" }));
  // Reactivating Finance is a grant again: a request the second administrator declines, and then one it approves.
  const reactivate = { role: "Finance", status: "active", expectedUpdatedAt: withOffset(suspended.updatedAt), reason: "Back for the contract check." };
  const declined = ok(await call(`/v1/team/members/${member.id}`, "PATCH", reactivate, { identity: "admin" }));
  ok(await call(`/v1/team/changes/${declined.pendingChange.id}/decline`, "POST", undefined, { identity: "second" }));
  const requested = ok(await call(`/v1/team/members/${member.id}`, "PATCH", reactivate, { identity: "admin" }));
  assert.equal(ok(await call(`/v1/team/changes/${requested.pendingChange.id}/approve`, "POST", undefined, { identity: "second" })).status, "active");
  const financeTeam = ok(await call("/v1/team", "GET", undefined, { identity: "admin" }));
  assert.ok(financeTeam.members.every((row: any) => Array.isArray(row.lenderIds) && typeof row.allLenders === "boolean"));
  // ---- BIL-02 on the staff host: one person proposes design-partner dates, a different person confirms them ----
  // The Finance member is active with access to the staff lender again. Invoices run through HTTP; the
  // receipt and an earlier build's single-person review are stored through the scoped repository.
  {
    const { previousMonth, monthOf } = await import("../src/domain/billing");
    const current = monthOf(new Date().toISOString());
    const third = previousMonth(`${current}-15T12:00:00.000Z`), second = previousMonth(`${third}-15T12:00:00.000Z`), first = previousMonth(`${second}-15T12:00:00.000Z`);
    const staffCall = (who: string, path: string, method = "GET", body?: unknown) => call(q(path, staffLender.id), method, body, { identity: who, ...(method === "GET" ? {} : { key: key() }) });
    const staffAct = (who: string, action: string, data: Record<string, unknown> = {}, recordId?: string) =>
      staffCall(who, "/v1/actions", "POST", { action, data, recordId, reason: "Verify two-person design-partner pricing on synthetic terms." });
    const billing = async () => ok(await staffCall("admin", "/v1/reports")).billing;
    const readTerms = async (id: string) => ok(await staffCall("admin", "/v1/records/commercial")).items.find((row: any) => row.id === id);
    const agreement = { discountStartDate: `${first}-01`, fullPriceStartDate: `${current}-01`, discountTermsReference: "SYN-STAFF-AGREEMENT" };
    const staffRequest = { headers: {}, secure: false, auth: Object.assign(() => staffAuth(admin), { [Symbol.for("@clerk/express.auth")]: true }) } as any;
    // The terms an earlier build reviewed: its administrator saved the dates alone, so nobody confirmed them. One receipt in the first month.
    const fixture = await store.inWorkspace(staffRequest, { cookie() {} } as any, async (ctx) => {
      const state = await store.loadState(ctx, staffLender.id);
      const customer = makeRecord(state, "customers", { name: "Synthetic staff customer", status: "active", reference: "SYN-STAFF-CUSTOMER", createdAt: ctx.now, data: { phoneMasked: "+234 •••• 32" } });
      const terms = makeRecord(state, "commercial", { name: "Staff contract lender", status: "signed", reference: "SYN-STAFF-TERMS", createdAt: ctx.now, data: { signed: true, signedFullPriceTerms: true, designPartner: true, licenceKobo: 1_500_000, effectiveDate: `${first}-01`, ...agreement,
        discountReview: { reviewedBy: `Clerk:${admin}`, reviewedAt: ctx.now, discountStartDate: agreement.discountStartDate, fullPriceStartDate: agreement.fullPriceStartDate, termsReference: agreement.discountTermsReference } } });
      const due = makeRecord(state, "due-items", { name: "Synthetic billed instalment", status: "paid", reference: "SYN-STAFF-DUE", customerId: customer.id, amountKobo: 2_500_000, createdAt: ctx.now, data: { dueDate: `${first}-10`, owner: "lms", outstandingKobo: 0 } });
      const payment = makeRecord(state, "payments", { name: "Synthetic historical direct debit", status: "allocated", reference: "SYN-STAFF-RECEIPT", customerId: customer.id, amountKobo: due.amountKobo,
        createdAt: ctx.now, data: { channel: "direct_debit", collectionStatus: "succeeded", settlementStatus: "settled", observedAt: `${first}-10T08:00:00.000Z`, settledAt: `${first}-10T08:00:00.000Z`, reversalStatus: "none", refundStatus: "none", allocatedKobo: due.amountKobo, dueItemId: due.id } });
      const allocation = makeRecord(state, "allocations", { name: "R1", status: "confirmed", customerId: customer.id, amountKobo: due.amountKobo, createdAt: ctx.now, data: { paymentId: payment.id, dueItemId: due.id, rule: "R1", confidence: "certain", automatic: true } });
      store.appendAudit(state, ctx, "test.billing.fixture", terms.id, "Created labelled synthetic terms, reviewed by one person as an earlier build recorded them, and a canonical receipt.");
      await store.saveState(ctx, state);
      return { termsId: terms.id, allocationId: allocation.id };
    });
    const awaiting = /The discount dates await confirmation: a different Admin or Finance user from the person who proposed them must confirm them/;
    assert.deepEqual([(await billing()).nextInvoicePricingReady, (await billing()).nextInvoicePeriod], [false, first]);
    assert.match((await billing()).nextInvoicePricingExplanation, awaiting, "a single-person review awaits confirmation");
    const refused = await staffAct("finance", "issue_invoice", { period: first });
    assert.equal(refused.status, 409, JSON.stringify(refused.data));
    assert.match(refused.data.error, awaiting, "the refusal names the missing confirmation");
    const byReviewer = await staffAct("admin", "confirm_discount_terms", agreement, fixture.termsId);
    assert.equal(byReviewer.status, 403, "its reviewer cannot confirm it");
    const confirmed = ok(await staffAct("finance", "confirm_discount_terms", agreement, fixture.termsId));
    assert.match(confirmed.message, /^Discount dates confirmed: 50% discount from /);
    assert.deepEqual([confirmed.record.data.discountReview.confirmedBy, confirmed.record.data.discountReview.confirmedAt], [`Clerk:${finance}`, confirmed.record.updatedAt], "the second person and the database time are recorded");
    assert.match(confirmed.record.data.discountReview.confirmedPrincipal, /\S/);
    const again = await staffAct("finance", "confirm_discount_terms", agreement, fixture.termsId);
    assert.equal(again.status, 409, "confirmed dates are not confirmed twice");
    assert.equal((await billing()).nextInvoicePricingReady, true);
    const firstInvoice = ok(await staffAct("finance", "issue_invoice", { period: first })).record;
    assert.deepEqual([firstInvoice.data.designPartnerDiscount.rate, firstInvoice.data.usageLines.length, firstInvoice.data.usageLines[0].chargedKobo], [0.5, 1, 3_750]);
    assert.deepEqual(firstInvoice.data.terms.discountReview, confirmed.record.data.discountReview, "the invoice keeps the proposal and its confirmation");
    const originalInvoice = structuredClone(firstInvoice);

    // One person changes the dates: a new proposal, bound to that person, that prices nothing until someone else confirms it.
    let terms = await readTerms(fixture.termsId);
    const previousTermsVersion = terms.updatedAt;
    const amended = { ...agreement, fullPriceStartDate: `${second}-01` };
    terms = ok(await staffCall("admin", `/v1/records/commercial/${terms.id}`, "PATCH", { expectedUpdatedAt: previousTermsVersion, data: { fullPriceStartDate: amended.fullPriceStartDate } }));
    assert.deepEqual([terms.data.discountReview.reviewedBy, terms.data.discountReview.reviewedAt, terms.data.discountReview.confirmedBy], [`Clerk:${admin}`, terms.updatedAt, undefined], "a date change resets the confirmation");
    assert.match(terms.data.discountReview.proposedPrincipal, /\S/);
    assert.notEqual(terms.data.discountReview.proposedPrincipal, confirmed.record.data.discountReview.confirmedPrincipal, "two different people are recorded");
    assert.equal((await staffCall("admin", `/v1/records/commercial/${terms.id}`, "PATCH", { expectedUpdatedAt: previousTermsVersion, name: "Stale change" })).status, 409);
    const unconfirmed = await staffAct("finance", "issue_invoice", { period: second });
    assert.equal(unconfirmed.status, 409);
    assert.match(unconfirmed.data.error, awaiting);
    const samePerson = await staffAct("admin", "confirm_discount_terms", amended, terms.id);
    assert.equal(samePerson.status, 403, "the same principal cannot confirm its own proposal");
    assert.match(samePerson.data.error, /A different person must confirm these discount dates/);
    const staleView = await staffAct("finance", "confirm_discount_terms", agreement, terms.id);
    assert.equal(staleView.status, 409, "a confirmation of the dates as they were read before the change is refused");
    ok(await staffAct("finance", "confirm_discount_terms", amended, terms.id));
    ok(await staffAct("finance", "review_allocation", { correct: false }, fixture.allocationId));
    const secondInvoice = ok(await staffAct("finance", "issue_invoice", { period: second })).record;
    assert.equal(secondInvoice.data.designPartnerDiscount.rate, 0, "the newly confirmed dates apply to the next invoice");
    assert.deepEqual(secondInvoice.data.adjustments.map((line: any) => [line.originalInvoiceId, line.discountRate, line.kobo]),
      [[firstInvoice.id, 0.5, -3_750]], "the correction refunds the original discounted charge, never the new public price");

    // The agreement is corrected again and confirmed: both issued months now differ from it. They are reported, never rewritten, and invoicing goes on.
    const corrected = { ...agreement, discountStartDate: `${second}-01` };
    terms = ok(await staffCall("admin", `/v1/records/commercial/${terms.id}`, "PATCH", { expectedUpdatedAt: (await readTerms(terms.id)).updatedAt, data: { discountStartDate: corrected.discountStartDate, fullPriceStartDate: corrected.fullPriceStartDate } }));
    ok(await staffAct("finance", "confirm_discount_terms", corrected, terms.id));
    const differences = (await billing()).rateDiscrepancies.map((line: any) => [line.invoiceId, line.period, line.chargedRate, line.agreedRate]);
    assert.deepEqual(differences, [[firstInvoice.id, first, 0.5, 0], [secondInvoice.id, second, 0, 0.5]], "each issued month the confirmed agreement prices differently is reported");
    assert.match((await billing()).rateDiscrepancyGuidance, /Valo Pay has no way to correct an issued invoice's discount/);
    const thirdInvoice = ok(await staffAct("finance", "issue_invoice", { period: third })).record;
    assert.equal(thirdInvoice.data.designPartnerDiscount.rate, 0.5, "new invoices are priced from the confirmed dates");
    assert.equal((await billing()).rateDiscrepancies.length, 2, "the new invoice agrees with the agreement");
    const savedInvoices = ok(await staffCall("admin", "/v1/records/invoices")).items;
    assert.deepEqual(savedInvoices.find((row: any) => row.id === firstInvoice.id), originalInvoice, "changed terms, a correction and a reported difference never rewrite an issued invoice");
    console.log("Billing HTTP/PostgreSQL staff checks passed: an earlier single-person review awaiting confirmation, the reviewer and the same principal refused, a different principal confirming, pricing ready, a date change resetting the confirmation, historical-rate corrections and rate differences reported, never rewritten.");
  }
  const readiness = ok(await call("/v1/team/readiness", "GET", undefined, { identity: "admin" }));
  assert.equal(readiness.canCommission, true);
  for (const path of ["/v1/team/readiness/encryption", "/v1/team/readiness/protect"]) assert.equal((await call(path, "POST", undefined, { identity: "admin" })).status, 503, `${path} needs a managed key, which this host does not have`);

  // ---- Every operation the console or the item names answered with a success at least once ----
  const expected = contractOperations(spec).map((item) => `${item.method} ${item.path}`).filter((name) => ![
    "GET /v1/openapi.json", // served from the build output, not the source tree this suite runs
    "POST /v1/webhooks/{provider}", // always refused
    "POST /v1/providers/paystack/{connectionId}/events", // needs a configured Paystack test connection: tests/paystack.test.ts and tests/source-ingress.test.ts
    "GET /v1/exports/{id}/download", // needs private object storage: tests/export-streams.integration.test.ts
    "POST /v1/team/readiness/encryption", "POST /v1/team/readiness/protect", // need a managed key
    "POST /v1/pilot/close-reviews/{id}/decision", // needs a second person: tests/source-close-controls.integration.test.ts
    "POST /v1/pilot/close-reviews/{id}/reassign", // needs independent active staff: tests/source-close-controls.integration.test.ts
    "POST /v1/pilot/import-corrections/{id}/recovery", // needs a second Finance reviewer: success, immutable history and replay checked in tests/source-close-controls.integration.test.ts
  ].includes(name));
  const missing = expected.filter((name) => !answered.get(name)?.has(200));
  assert.deepEqual(missing, [], "every console-facing operation answered with its described shape");
  console.log(`API contract checks passed against PostgreSQL: ${answered.size} operations answered as documented, the sandbox directory's lenders, one 400 for a missing merchantId, offset date-times, optional and required keys, an invalid answer that saves nothing, ${repeatable.length} keyed writes gone (410) after a retention run, an export whose file expired, the export queue's and the new-sandbox limit's Retry-After, replayed receipts that never claim nothing was saved and a stored retention run's timestamps.`);
} finally {
  (clerkClient.users as any).getUser = oldGetUser;
  for (const [name, value] of Object.entries({ VALOPAY_STAFF_ACCESS: savedEnv.mode, VALOPAY_STAFF_ISSUER: savedEnv.issuer, VALOPAY_STAFF_ORIGINS: savedEnv.origins })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  server.close();
  await once(server, "close");
  for (const id of cleanupWorkspaces) {
    for (const table of ["valopay_staff_events", "valopay_staff_invitations", "valopay_staff_memberships", "valopay_teams"]) await pool.query(`DELETE FROM ${table} WHERE workspace_id=$1`, [id]);
    for (const table of ["valopay_idempotency", "valopay_operations", "valopay_records"]) await pool.query(`DELETE FROM ${table} WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)`, [id]);
    await pool.query("DELETE FROM valopay_merchants WHERE workspace_id=$1", [id]);
    await pool.query("DELETE FROM valopay_workspaces WHERE id=$1", [id]);
  }
  await pool.end();
}
