// Security regression checks use only fresh synthetic sandbox workspaces.
// This script must never be pointed at a production host.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { probeSandboxCookieName } from "./sandbox-cookie-name.mjs";

const domain = process.env.REPLIT_DEV_DOMAIN;
if (!domain || !/^[a-z0-9.-]+\.replit\.dev(?::\d+)?$/i.test(domain)) {
  throw new Error("Refusing to run: REPLIT_DEV_DOMAIN must be a *.replit.dev host.");
}
const base = `https://${domain}`;
const sandboxCookie = probeSandboxCookieName();
const checks = { responses: 0 };

function withMerchant(path, merchantId) {
  if (!merchantId) return path;
  return `${path}${path.includes("?") ? "&" : "?"}merchantId=${encodeURIComponent(merchantId)}`;
}

function cookieValue(setCookie) {
  return setCookie ? setCookie.split(";")[0] : "";
}

async function request(context, path, {
  method = "GET",
  body,
  key,
  merchantId = context.merchantId,
  binary = false,
  includeMerchant = true,
} = {}) {
  const target = path.startsWith("/") ? path : `/api/v1/${path}`;
  const url = `${base}${includeMerchant ? withMerchant(target, merchantId) : target}`;
  const headers = {
    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    ...(context.cookie ? { Cookie: context.cookie } : {}),
    ...(key ? { "Idempotency-Key": key } : {}),
  };
  const response = await fetch(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  checks.responses += 1;
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) context.cookie = cookieValue(setCookie);
  if (binary) {
    return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
  }
  const text = await response.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Keep non-JSON error bodies useful in the assertion below.
  }
  return { status: response.status, headers: response.headers, data };
}

function detail(result) {
  if (typeof result.data === "string") return result.data.slice(0, 300);
  return (JSON.stringify(result.data) ?? "<binary or empty response>").slice(0, 500);
}

async function expectStatus(context, path, options = {}, expected = 200) {
  const result = await request(context, path, options);
  assert.equal(result.status, expected, `${options.method || "GET"} ${path}: ${detail(result)}`);
  return result.data;
}

async function expectFailure(context, path, options = {}) {
  const result = await request(context, path, options);
  assert.ok([400, 401, 403, 404, 405, 409, 422].includes(result.status), `Expected controlled denial for ${options.method || "GET"} ${path}, got ${result.status}: ${detail(result)}`);
  return result;
}

async function workspace(context) {
  const data = await expectStatus(context, "workspace", { includeMerchant: false, merchantId: undefined });
  assert.equal(data.environment, "sandbox");
  assert.equal(data.productionEnabled, false);
  assert.equal(data.merchants.length, 2, "Every fresh synthetic workspace has exactly two lenders.");
  assert.equal(new Set(data.merchants.map((merchant) => merchant.id)).size, 2);
  return data;
}

async function list(context, kind, merchantId = context.merchantId) {
  const data = await expectStatus(context, `records/${kind}`, { merchantId });
  return data.items;
}

async function action(context, name, recordId, data, expected = 200) {
  return expectStatus(context, "actions", {
    method: "POST",
    body: { action: name, ...(recordId === undefined ? {} : { recordId }), reason: `Synthetic security regression: ${name}`, ...(data === undefined ? {} : { data }) },
  }, expected);
}

/** A record as its lender holds it now: an edit probe names its current version, so only the rule under test refuses it. */
async function current(context, kind, id) {
  const [record] = (await expectStatus(context, `records/${kind}?id=${encodeURIComponent(id)}`)).items;
  assert(record, `${kind} ${id} is listed`);
  return record;
}

/** The settings revision a lender's own settings page reads. */
async function revision(context) {
  return (await expectStatus(context, "settings")).revision;
}

async function createRecord(context, kind, body, { key, merchantId = context.merchantId, expected = 200 } = {}) {
  return expectStatus(context, `records/${kind}`, { method: "POST", body, key, merchantId }, expected);
}

function countBusiness(items) {
  return items.filter((item) => item.kind !== "audit").length;
}

function ids(items) {
  return new Set(items.map((item) => item.id));
}

const contextA = { cookie: `${sandboxCookie}=${randomBytes(32).toString("hex")}` };
const contextB = { cookie: `${sandboxCookie}=${randomBytes(32).toString("hex")}` };
const anonymous = { cookie: "" };
const malformed = { cookie: `${sandboxCookie}=not-a-token` };

const workspaceA = await workspace(contextA);
const workspaceB = await workspace(contextB);
const workspaceAnonymous = await workspace(anonymous);
const workspaceMalformed = await workspace(malformed);
contextA.merchantId = workspaceA.merchants[0].id;
contextA.otherMerchantId = workspaceA.merchants[1].id;
contextB.merchantId = workspaceB.merchants[0].id;
contextB.otherMerchantId = workspaceB.merchants[1].id;
anonymous.merchantId = workspaceAnonymous.merchants[0].id;
malformed.merchantId = workspaceMalformed.merchants[0].id;

const ownAIds = ids(workspaceA.merchants);
const ownBIds = ids(workspaceB.merchants);
assert.equal([...ownAIds].filter((id) => ownBIds.has(id)).length, 0, "Fresh principals must not share lenders.");
assert.equal([...ownAIds].filter((id) => workspaceAnonymous.merchants.some((merchant) => merchant.id === id)).length, 0);
assert.equal([...ownAIds].filter((id) => workspaceMalformed.merchants.some((merchant) => merchant.id === id)).length, 0);
assert.notEqual(malformed.cookie, `${sandboxCookie}=not-a-token`, "Malformed tokens must be replaced, not authenticated.");

// Every scoped read must fail closed when a principal presents another workspace's lender.
const readPaths = [
  "overview", "reports", "gates", "settings",
  "records/customers", "records/mandates", "records/due-items", "records/attempts",
  "records/observations", "records/payments", "records/allocations",
  "records/settlement-batches", "records/exceptions", "records/policies", "records/templates",
  "records/notifications", "records/cutovers", "records/audit", "records/closes",
  "records/exports", "records/commercial", "records/reviews", "records/evidence",
  "records/experiments", "records/costs", "records/calendar", "records/integrations",
  "records/members", "records/retry-decisions",
];
for (const path of readPaths) {
  await expectFailure(contextB, path, { merchantId: contextA.merchantId });
  await expectFailure(anonymous, path, { merchantId: contextA.merchantId });
  await expectFailure(malformed, path, { merchantId: contextA.merchantId });
}
await expectFailure(contextB, "customers/invalid-foreign-customer/timeline", { merchantId: contextA.merchantId });

// The same fail-closed boundary applies to every scoped write family.
const safeCustomer = {
  name: "Synthetic foreign-write probe",
  reference: `SEC-FOREIGN-${randomBytes(6).toString("hex")}`,
  data: { consentProvenance: "Synthetic security regression", phoneMasked: "•••• 77" },
};
await expectFailure(contextB, "records/customers", { method: "POST", body: safeCustomer, merchantId: contextA.merchantId });
await expectFailure(contextB, "actions", { method: "POST", body: { action: "run_reconciliation" }, merchantId: contextA.merchantId });
// With a well-formed revision (its own lender's), so only the lender boundary refuses it.
await expectFailure(contextB, "settings", { method: "PATCH", body: { executionStart: 7, expectedRevision: await revision(contextB) }, merchantId: contextA.merchantId });
await expectFailure(contextB, "imports", {
  method: "POST",
  body: { kind: "customers", csv: "row_id,name,consentProvenance\nr1,Foreign,Synthetic", identityColumn: "row_id", syntheticOnly: true, commit: false },
  merchantId: contextA.merchantId,
});
await expectFailure(contextB, "exports", {
  method: "POST",
  body: { kind: "gate-pack", format: "pdf" },
  merchantId: contextA.merchantId,
});
await expectFailure(contextB, "exports/not-an-export/download", { merchantId: contextA.merchantId });

const customersA = await list(contextA, "customers");
const customersB = await list(contextB, "customers");
const duesA = await list(contextA, "due-items");
const duesB = await list(contextB, "due-items");
const mandatesA = await list(contextA, "mandates");
const mandatesB = await list(contextB, "mandates");
const policiesA = await list(contextA, "policies");
const policiesB = await list(contextB, "policies");
const evidenceA = await list(contextA, "evidence");
const customerA = customersA[0];
const customerB = customersB[0];
const dueA = duesA[0];
const dueB = duesB[0];
const mandateA = mandatesA[0];
const mandateB = mandatesB[0];
const policyA = policiesA[0];
const policyB = policiesB[0];
assert(customerA && customerB && dueA && dueB && mandateA && mandateB && policyA && policyB);
await expectFailure(contextB, `customers/${customerA.id}/timeline`, { merchantId: contextA.merchantId });

// IDs from the sibling lender in this workspace must not be dereferenceable.
const ownMerchantBefore = await list(contextA, "customers");
const foreignMerchantAuditBefore = (await list(contextA, "audit")).length;
const siblingCountsBefore = {
  customers: (await list(contextA, "customers", contextA.otherMerchantId)).length,
  audit: (await list(contextA, "audit", contextA.otherMerchantId)).length,
};
await expectFailure(contextA, `customers/${customerB.id}/timeline`, { merchantId: contextA.merchantId });
await expectFailure(contextA, "exports", {
  method: "POST",
  body: { kind: "customer-pack", customerId: customerB.id, format: "pdf" },
  merchantId: contextA.merchantId,
});
await expectFailure(contextA, "actions", {
  method: "POST",
  body: { action: "simulate_failure", recordId: dueB.id, reason: "Foreign ID must fail" },
  merchantId: contextA.merchantId,
});
await expectFailure(contextA, "actions", {
  method: "POST",
  body: { action: "record_refund", recordId: policyB.id, reason: "Foreign ID must fail", data: { reference: "SYN-REFUND-FOREIGN" } },
  merchantId: contextA.merchantId,
});
await expectFailure(contextA, "records/due-items", {
  method: "POST",
  body: { name: "Foreign due", reference: "SEC-FOREIGN-DUE", customerId: customerB.id, amountKobo: 1200000, data: { owner: "lms", dueDate: new Date().toISOString().slice(0, 10), mandateId: mandateB.id } },
  merchantId: contextA.merchantId,
});
await expectFailure(contextA, "records/mandates", {
  method: "POST",
  body: { name: "Foreign mandate", reference: "SEC-FOREIGN-MANDATE", customerId: customerB.id, amountKobo: 1200000, data: { workflow: "hosted_consent", consentEvidence: "Synthetic", policyId: policyB.id } },
  merchantId: contextA.merchantId,
});
await expectFailure(contextA, "records/observations", {
  method: "POST",
  body: { name: "Foreign observation", reference: "SEC-FOREIGN-OBS", customerId: customerA.id, amountKobo: dueA.amountKobo, data: { source: "webhook", dueItemId: dueB.id } },
  merchantId: contextA.merchantId,
});
await expectFailure(contextA, "records/exceptions", {
  method: "POST",
  body: { name: "Foreign exception", data: { linkedRecordId: dueB.id } },
  merchantId: contextA.merchantId,
});
await expectFailure(contextA, "records/experiments", {
  method: "POST",
  body: { name: "Foreign experiment", data: { baselineRate: 0.4, holdoutShare: 0.5, minPerArm: 10, seed: "foreign", analysisDate: "2099-01-01", enrolmentClose: "2098-01-01", policyId: policyB.id } },
  merchantId: contextA.merchantId,
});
const foreignImportPreview = await expectStatus(contextA, "imports", {
  method: "POST",
  body: { kind: "due-items", csv: `name,reference,customerId,amountKobo,owner,dueDate\nForeign,SEC-FOREIGN-IMPORT,${customerB.id},1200000,lms,2099-01-01`, identityColumn: "reference", syntheticOnly: true, commit: false },
  merchantId: contextA.merchantId,
});
assert.equal(foreignImportPreview.invalid, 1);
assert.equal(foreignImportPreview.imported, 0);
assert.equal((await list(contextA, "customers")).length, ownMerchantBefore.length, "Cross-merchant probes must not create records.");
assert.equal((await list(contextA, "audit")).length, foreignMerchantAuditBefore, "Rejected cross-merchant requests must not append audit entries.");
assert.equal((await list(contextA, "customers", contextA.otherMerchantId)).length, siblingCountsBefore.customers);
assert.equal((await list(contextA, "audit", contextA.otherMerchantId)).length, siblingCountsBefore.audit);

// Optional link fields reject both an invalid identifier and a valid sibling-lender identifier.
const invalidLinkBefore = (await list(contextA, "audit")).length;
await expectFailure(contextA, "records/due-items", {
  method: "POST",
  body: { name: "Invalid link due", reference: "SEC-INVALID-LINK-DUE", customerId: customerA.id, amountKobo: 1200000, data: { owner: "lms", dueDate: "2099-01-01", mandateId: "00000000-0000-0000-0000-000000000000" } },
});
await expectFailure(contextA, "records/observations", {
  method: "POST",
  body: { name: "Invalid link observation", reference: "SEC-INVALID-LINK-OBS", customerId: customerA.id, amountKobo: dueA.amountKobo, data: { source: "webhook", dueItemId: "00000000-0000-0000-0000-000000000000" } },
});
await expectFailure(contextA, "records/exceptions", {
  method: "POST",
  body: { name: "Invalid link exception", data: { linkedRecordId: "not-a-record-id" } },
});
assert.equal((await list(contextA, "audit")).length, invalidLinkBefore, "Invalid link requests must not create audit entries.");

// Read-only personas can read but cannot change records, settings, or actions.
await action(contextA, "set_role", undefined, { role: "Read-only" });
const readOnlyCount = (await list(contextA, "customers")).length;
await expectFailure(contextA, "records/customers", { method: "POST", body: { ...safeCustomer, reference: "SEC-READONLY-CREATE" } });
await expectFailure(contextA, `records/customers/${customerA.id}`, { method: "PATCH", body: { name: "Read-only mutation", expectedUpdatedAt: (await current(contextA, "customers", customerA.id)).updatedAt } });
await expectFailure(contextA, "settings", { method: "PATCH", body: { executionStart: 7, expectedRevision: await revision(contextA) } });
await expectFailure(contextA, "actions", {
  method: "POST",
  body: { action: "manual_allocate", recordId: "00000000-0000-0000-0000-000000000000", reason: "Read-only mutation", data: { dueItemId: dueA.id, amountKobo: 500000 } },
});
const readOnlyImport = await expectStatus(contextA, "imports", {
  method: "POST",
  body: { kind: "customers", csv: "name,reference,consentProvenance\nRead Only,SEC-READONLY-IMPORT,Synthetic", identityColumn: "reference", syntheticOnly: true, commit: true },
});
assert.equal(readOnlyImport.imported, 0);
assert.equal((await list(contextA, "customers")).length, readOnlyCount);
await action(contextA, "set_role", undefined, { role: "Admin" });

// Idempotency remains merchant-scoped and serializes concurrent requests.
const idemCustomer = {
  name: "Synthetic idempotency customer",
  reference: `SEC-IDEM-${randomBytes(6).toString("hex")}`,
  data: { consentProvenance: "Synthetic security regression", phoneMasked: "•••• 81" },
};
const sameKeyResults = await Promise.all(
  Array.from({ length: 3 }, () => request(contextA, "records/customers", { method: "POST", body: idemCustomer, key: "security-identical-post" })),
);
sameKeyResults.forEach((result) => assert.equal(result.status, 200, detail(result)));
assert.equal(new Set(sameKeyResults.map((result) => result.data.id)).size, 1);
assert.equal((await list(contextA, "customers")).filter((item) => item.reference === idemCustomer.reference).length, 1);

const mismatchA = { ...idemCustomer, reference: `SEC-IDEM-MISMATCH-A-${randomBytes(4).toString("hex")}` };
const mismatchB = { ...idemCustomer, reference: `SEC-IDEM-MISMATCH-B-${randomBytes(4).toString("hex")}` };
const mismatchResults = await Promise.all([
  request(contextA, "records/customers", { method: "POST", body: mismatchA, key: "security-mismatched-post" }),
  request(contextA, "records/customers", { method: "POST", body: mismatchB, key: "security-mismatched-post" }),
]);
assert.deepEqual(mismatchResults.map((result) => result.status).sort((a, b) => a - b), [200, 409]);
const idemOnSibling = await request(contextA, "records/customers", {
  method: "POST",
  body: { ...idemCustomer, reference: `SEC-IDEM-SIBLING-${randomBytes(4).toString("hex")}` },
  key: "security-identical-post",
  merchantId: contextA.otherMerchantId,
});
assert.equal(idemOnSibling.status, 200, detail(idemOnSibling));

// Two manual allocations race for one payment cap; only one can consume the remaining amount.
const allocationCustomer = await createRecord(contextA, "customers", {
  name: "Synthetic allocation customer",
  reference: `SEC-ALLOC-C-${randomBytes(5).toString("hex")}`,
  data: { consentProvenance: "Synthetic security regression", phoneMasked: "•••• 82" },
});
const allocationDate = new Date().toISOString().slice(0, 10);
const allocationDueA = await createRecord(contextA, "due-items", {
  name: "Synthetic allocation due A",
  reference: `SEC-ALLOC-D-A-${randomBytes(5).toString("hex")}`,
  customerId: allocationCustomer.id,
  amountKobo: 1200000,
  data: { owner: "lms", dueDate: allocationDate },
});
const allocationDueB = await createRecord(contextA, "due-items", {
  name: "Synthetic allocation due B",
  reference: `SEC-ALLOC-D-B-${randomBytes(5).toString("hex")}`,
  customerId: allocationCustomer.id,
  amountKobo: 1200000,
  data: { owner: "lms", dueDate: allocationDate },
});
const allocationReference = `SEC-ALLOC-P-${randomBytes(5).toString("hex")}`;
await createRecord(contextA, "observations", {
  name: "Synthetic allocation payment evidence",
  reference: allocationReference,
  customerId: allocationCustomer.id,
  amountKobo: 1200000,
  data: { source: "webhook", provider: "Sandbox Rail", eventId: allocationReference },
});
await action(contextA, "run_reconciliation");
const allocationPayment = (await list(contextA, "payments")).find((payment) => payment.reference === allocationReference);
assert(allocationPayment, "Reconciliation must create the canonical payment.");
const allocationRace = await Promise.all([
  request(contextA, "actions", { method: "POST", body: { action: "manual_allocate", recordId: allocationPayment.id, reason: "Synthetic allocation race A", data: { dueItemId: allocationDueA.id, amountKobo: 800000 } } }),
  request(contextA, "actions", { method: "POST", body: { action: "manual_allocate", recordId: allocationPayment.id, reason: "Synthetic allocation race B", data: { dueItemId: allocationDueB.id, amountKobo: 800000 } } }),
]);
assert.equal(allocationRace.filter((result) => result.status >= 200 && result.status < 300).length, 1, "Only one concurrent allocation may consume the shared payment cap.");
assert.equal(allocationRace.filter((result) => result.status >= 400).length, 1);
const allocationsAfterRace = (await list(contextA, "allocations")).filter((allocation) => allocation.data.paymentId === allocationPayment.id && allocation.status === "confirmed");
assert(allocationsAfterRace.reduce((sum, allocation) => sum + allocation.amountKobo, 0) <= allocationPayment.amountKobo);
const dueAfterRace = await list(contextA, "due-items");
for (const dueId of [allocationDueA.id, allocationDueB.id]) {
  const due = dueAfterRace.find((item) => item.id === dueId);
  assert(due && Number(due.data.outstandingKobo) >= 0 && Number(due.data.outstandingKobo) <= due.amountKobo);
}
const auditAfterRaces = await action(contextA, "verify_audit");
assert.equal(auditAfterRaces.data.valid, true);
const auditAfterRacesAgain = await action(contextA, "verify_audit");
assert.equal(auditAfterRacesAgain.data.valid, true);

// Preview and failed imports are all-or-nothing; duplicate commits create one business record.
const businessBeforePreview = countBusiness((await list(contextA, "customers")).concat(await list(contextA, "due-items")));
const preview = await expectStatus(contextA, "imports", {
  method: "POST",
  body: { kind: "customers", csv: "name,reference,consentProvenance\nPreview,SEC-PREVIEW,Synthetic", identityColumn: "reference", syntheticOnly: true, commit: false },
});
assert.equal(preview.imported, 0);
assert.equal(countBusiness((await list(contextA, "customers")).concat(await list(contextA, "due-items"))), businessBeforePreview);
const failedImportBefore = countBusiness((await list(contextA, "customers")).concat(await list(contextA, "due-items")));
const failedImport = await expectStatus(contextA, "imports", {
  method: "POST",
  body: { kind: "customers", csv: "name,reference\nMissing consent,SEC-FAILED", identityColumn: "reference", syntheticOnly: true, commit: true },
});
assert.equal(failedImport.imported, 0);
assert.equal(failedImport.invalid, 1);
assert.equal(countBusiness((await list(contextA, "customers")).concat(await list(contextA, "due-items"))), failedImportBefore);
const duplicateImportReference = `SEC-IMPORT-DUP-${randomBytes(5).toString("hex")}`;
const duplicateCsv = `name,reference,consentProvenance,phoneMasked\nConcurrent import,${duplicateImportReference},Synthetic,•••• 83`;
const duplicateImports = await Promise.all([
  request(contextA, "imports", { method: "POST", body: { kind: "customers", csv: duplicateCsv, identityColumn: "reference", syntheticOnly: true, commit: true } }),
  request(contextA, "imports", { method: "POST", body: { kind: "customers", csv: duplicateCsv, identityColumn: "reference", syntheticOnly: true, commit: true } }),
]);
duplicateImports.forEach((result) => assert.equal(result.status, 200, detail(result)));
assert.equal((await list(contextA, "customers")).filter((item) => item.reference === duplicateImportReference).length, 1);

// Approved policy/template versions and preregistered experiments are immutable.
const policyDraft = await createRecord(contextA, "policies", {
  name: "Security regression frozen policy",
  data: { maxAttempts: 3, spacingHours: 48, firstNoticeHours: 48, retryNoticeHours: 24, partialAllowed: false },
});
await action(contextA, "submit_policy", policyDraft.id);
await action(contextA, "set_role", undefined, { role: "Compliance reviewer" });
await action(contextA, "approve_policy", policyDraft.id);
await action(contextA, "set_role", undefined, { role: "Admin" });
await expectFailure(contextA, `records/policies/${policyDraft.id}`, { method: "PATCH", body: { data: { spacingHours: 72 }, expectedUpdatedAt: (await current(contextA, "policies", policyDraft.id)).updatedAt } });
await expectFailure(contextA, "actions", { method: "POST", body: { action: "submit_policy", recordId: policyDraft.id, reason: "Approved policy is frozen" } });
await expectFailure(contextA, "actions", { method: "POST", body: { action: "reject_policy", recordId: policyDraft.id, reason: "Approved policy is frozen" } });

const templateDraft = await createRecord(contextA, "templates", {
  name: "Security regression frozen template",
  data: { text: "{{merchant}} {{amount}} {{date}} {{contact}}" },
});
await action(contextA, "submit_template", templateDraft.id);
await action(contextA, "set_role", undefined, { role: "Compliance reviewer" });
await action(contextA, "approve_template", templateDraft.id);
await action(contextA, "set_role", undefined, { role: "Admin" });
await expectFailure(contextA, `records/templates/${templateDraft.id}`, { method: "PATCH", body: { data: { text: "changed {{merchant}} {{amount}} {{date}} {{contact}}" }, expectedUpdatedAt: (await current(contextA, "templates", templateDraft.id)).updatedAt } });
await expectFailure(contextA, "actions", { method: "POST", body: { action: "submit_template", recordId: templateDraft.id, reason: "Approved template is frozen" } });

const frozenExperiment = await createRecord(contextA, "experiments", {
  name: "Security regression frozen experiment",
  data: {
    baselineRate: 0.4,
    holdoutShare: 0.5,
    minPerArm: 10,
    analysisDate: "2099-06-01",
    enrolmentClose: "2099-04-01",
    seed: `SEC-EXP-${randomBytes(4).toString("hex")}`,
    policyId: policyDraft.id,
  },
});
await action(contextA, "preregister_experiment", frozenExperiment.id);
await expectFailure(contextA, `records/experiments/${frozenExperiment.id}`, { method: "PATCH", body: { data: { minPerArm: 11 }, expectedUpdatedAt: (await current(contextA, "experiments", frozenExperiment.id)).updatedAt } });
await expectFailure(contextA, "actions", { method: "POST", body: { action: "preregister_experiment", recordId: frozenExperiment.id, reason: "Frozen experiment is immutable" } });
// Readiness evidence-register drafts are editable; audit/review/close/export
// snapshots, rather than every resource called evidence, are immutable.
const auditSnapshot = (await list(contextA, "audit"))[0];
await expectFailure(contextA, `records/audit/${auditSnapshot.id}`, { method: "PATCH", body: { name: "Rewritten audit", expectedUpdatedAt: auditSnapshot.updatedAt } });
await expectFailure(contextA, `records/audit/${auditSnapshot.id}`, { method: "DELETE" });
const reviewSnapshot = await createRecord(contextA, "reviews", { name: "Synthetic security review", data: { synthetic: true } });
await expectFailure(contextA, `records/reviews/${reviewSnapshot.id}`, { method: "PATCH", body: { name: "Rewritten review", expectedUpdatedAt: reviewSnapshot.updatedAt } });
await action(contextA, "daily_close");
const closeSnapshot = (await list(contextA, "closes"))[0];
await expectFailure(contextA, `records/closes/${closeSnapshot.id}`, { method: "PATCH", body: { name: "Rewritten close", expectedUpdatedAt: closeSnapshot.updatedAt } });

// A fresh export is downloadable only to its lender and its checksum is the stored checksum.
const exportResult = await expectStatus(contextA, "exports", {
  method: "POST",
  body: { kind: "customer-pack", customerId: customerA.id, format: "pdf" },
});
const download = await request(contextA, `exports/${exportResult.id}/download`, { binary: true });
assert.equal(download.status, 200);
assert.equal(download.bytes.subarray(0, 4).toString(), "%PDF");
assert.equal(createHash("sha256").update(download.bytes).digest("hex"), exportResult.checksum);
const exportRecord = (await list(contextA, "exports")).find((item) => item.id === exportResult.id);
assert(exportRecord);
await expectFailure(contextA, `records/exports/${exportResult.id}`, { method: "PATCH", body: { name: "Rewritten export", expectedUpdatedAt: exportRecord.updatedAt } });
assert.equal(exportRecord.data.objectName, undefined, "Collection APIs must not expose object storage paths.");
assert.equal(exportRecord.data.bucket, undefined, "Collection APIs must not expose object storage buckets.");
await expectFailure(contextB, `exports/${exportResult.id}/download`, { binary: true, merchantId: contextA.merchantId });
await expectFailure(contextA, `exports/${exportResult.id}/download`, { binary: true, merchantId: contextA.otherMerchantId });

console.log(`Passed ${checks.responses} HTTP security regression responses: workspace isolation, scoped reads/writes, link validation, read-only enforcement, immutable approvals, idempotency, allocation races, audit verification, import atomicity, and PDF export isolation.`);
console.warn("Note: an invalid committed import is checked for zero business records; current API behavior may append its import report to the audit chain.");
