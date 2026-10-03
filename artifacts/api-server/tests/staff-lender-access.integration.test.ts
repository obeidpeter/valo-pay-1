import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

if (process.env.VALO_PAY_1_RUN_INTEGRATION !== "1") { console.log("Opt in on a disposable PostgreSQL database to test staff lender access."); process.exit(0); }
// Only Clerk's verified-email lookup is replaced below; no external call is made.
const savedClerkKey = process.env.CLERK_SECRET_KEY; process.env.CLERK_SECRET_KEY = "sk_test_placeholder";
const { pool } = await import("@workspace/valo-pay-1-db"), store = await import("../src/lib/valo-pay-1-store"), { default: router } = await import("../src/routes/index"), { errorHandler } = await import("../src/lib/error-handler");
const { clerkClient } = await import("@clerk/express"), savedGetUser = clerkClient.users.getUser;
const saved = { VALO_PAY_1_STAFF_ACCESS: process.env.VALO_PAY_1_STAFF_ACCESS, VALO_PAY_1_STAFF_ISSUER: process.env.VALO_PAY_1_STAFF_ISSUER, VALO_PAY_1_STAFF_ORIGINS: process.env.VALO_PAY_1_STAFF_ORIGINS };
Object.assign(process.env, { VALO_PAY_1_STAFF_ACCESS: "staging", VALO_PAY_1_STAFF_ISSUER: "https://identity.example", VALO_PAY_1_STAFF_ORIGINS: "https://pilot.example" });
const identities = new Map<string, any>(), app = express();
app.use(express.json());
app.use((req, _res, next) => { (req as any).auth = Object.assign(() => identities.get(String(req.header("X-Test-Identity"))) || { userId: null }, { [Symbol.for("@clerk/express.auth")]: true }); (req as any).log = { info() {}, error() {}, warn() {} }; next(); });
app.use("/api", router); app.use(errorHandler);
const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as any).port}/api`, owned: string[] = [];
async function call(path: string, who = "admin", method = "GET", body?: any, key = randomUUID()) { const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-Test-Identity": who, "Idempotency-Key": key }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json() }; }
function ok(result: { status: number; data: any }) { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; }
const requestFor = (id: string) => ({ headers: {}, auth: Object.assign(() => identities.get(id), { [Symbol.for("@clerk/express.auth")]: true }) }) as any;
const responseStub = { cookie() {} } as any;
try {
  for (const name of ["003_pilot_workflow.sql", "004_staff_lender_access.sql"]) { const sql = await readFile(new URL(`../../../lib/db/migrations/${name}`, import.meta.url), "utf8"); await pool.query(sql); await pool.query(sql); }
  const org = `org_${randomUUID().replaceAll("-", "")}`, admin = `user_${randomUUID().replaceAll("-", "")}`, finance = `user_${randomUUID().replaceAll("-", "")}`;
  const auth = (userId: string) => ({ userId, orgId: org, sessionId: `sess_${userId}`, tokenType: "session_token", sessionStatus: "active", factorVerificationAge: [0, 0], sessionClaims: { sub: userId, sid: `sess_${userId}`, iss: "https://identity.example", azp: "https://pilot.example", iat: Math.floor(Date.now() / 1000) - 1, exp: Math.floor(Date.now() / 1000) + 3600 } });
  identities.set("admin", auth(admin)); identities.set("finance", auth(finance)); identities.set("old-mfa", { ...auth(admin), factorVerificationAge: [11, 11] });
  const workspace = await store.provisionStaffWorkspace(org, admin, "Lender access rehearsal"); owned.push(workspace.workspaceId);
  const a = ok(await call("/v1/pilot/lenders", "admin", "POST", { name: "Assigned lender", segment: "Consumer lending" })), b = ok(await call("/v1/pilot/lenders", "admin", "POST", { name: "Other lender", segment: "Consumer lending" }));
  const memberId = randomUUID(); await pool.query("INSERT INTO valopay_staff_memberships(id,workspace_id,user_id,display_name,role,expires_at) VALUES($1,$2,$3,'Synthetic Finance','Finance',now()+interval '30 days')", [memberId, workspace.workspaceId, finance]);
  assert.equal(ok(await call("/v1/workspace", "finance")).merchants.length, 0);
  assert.equal((await call(`/v1/records/customers?merchantId=${a.id}`, "finance")).status, 404);
  const team = ok(await call("/v1/team")), member = team.members.find((row: any) => row.id === memberId), adminMember = team.members.find((row: any) => row.actor === `Clerk:${admin}`);
  const grant = { expectedUpdatedAt: member.updatedAt, lenderIds: [a.id], reason: "Finance is assigned to the first pilot lender." };
  assert.equal((await call(`/v1/team/members/${memberId}/lenders`, "old-mfa", "PATCH", grant)).status, 403);
  assert.equal((await call(`/v1/team/members/${memberId}/lenders`, "finance", "PATCH", grant)).status, 403);
  assert.equal((await call(`/v1/team/members/${adminMember.id}/lenders`, "admin", "PATCH", { ...grant, expectedUpdatedAt: adminMember.updatedAt })).status, 403);
  const allowed = ok(await call(`/v1/team/members/${memberId}/lenders`, "admin", "PATCH", grant));
  assert.deepEqual(ok(await call("/v1/workspace", "finance")).merchants.map((m: any) => m.id), [a.id]);
  ok(await call(`/v1/records/customers?merchantId=${a.id}`, "finance"));
  assert.equal((await call(`/v1/records/customers?merchantId=${b.id}`, "finance")).status, 404);
  // A saved request replayed with stale MFA is refused, not answered from its receipt; with fresh MFA the receipt answers.
  const customerKey = randomUUID(), customer = { name: "Other lender customer", reference: `OTHER-${randomUUID()}`, data: { consentProvenance: "Synthetic consent" } };
  const foreign = ok(await call(`/v1/records/customers?merchantId=${b.id}`, "admin", "POST", customer, customerKey));
  assert.equal((await call(`/v1/records/customers?merchantId=${b.id}`, "old-mfa", "POST", customer, customerKey)).status, 403);
  assert.equal(ok(await call(`/v1/records/customers?merchantId=${b.id}`, "admin", "POST", customer, customerKey)).id, foreign.id);
  // One lender's record is not found through another lender's address, even by an administrator of both.
  for (const who of ["finance", "admin"]) assert.equal((await call(`/v1/records/customers/${foreign.id}?merchantId=${a.id}`, who, "PATCH", { name: "Reached across lenders", expectedUpdatedAt: foreign.updatedAt })).status, 404, who);
  assert.equal((await call(`/v1/team/members/${memberId}/lenders`, "admin", "PATCH", grant)).status, 409);
  assert.equal((await call(`/v1/team/members/${memberId}/lenders`, "admin", "PATCH", { ...grant, expectedUpdatedAt: allowed.updatedAt, lenderIds: ["outside-this-workspace"] })).status, 404);
  ok(await call(`/v1/actions?merchantId=${a.id}`, "admin", "POST", { action: "daily_close" }));
  ok(await call(`/v1/actions?merchantId=${b.id}`, "admin", "POST", { action: "daily_close" }));
  const savedId = ok(await call(`/v1/pilot/close-reviews?merchantId=${a.id}`)).closes[0].id, otherCloseId = ok(await call(`/v1/pilot/close-reviews?merchantId=${b.id}`)).closes[0].id;
  const savedDetail = ok(await call(`/v1/pilot/close-reviews/${savedId}?merchantId=${a.id}`));
  assert.equal(savedDetail.reviewers.length, 1);
  assert.equal(ok(await call(`/v1/pilot/close-reviews/${otherCloseId}?merchantId=${b.id}`)).reviewers.length, 0, "Finance cannot be assigned to a close for an unpermitted lender.");
  assert.equal((await call(`/v1/pilot/close-reviews/${savedId}?merchantId=${b.id}`)).status, 404);
  const savedItem = savedDetail.entry, savedClose = savedItem.close;
  const review = ok(await call(`/v1/pilot/close-reviews/prepare?merchantId=${a.id}`, "admin", "POST", { closeId: savedClose.id, expectedUpdatedAt: savedClose.updatedAt, reviewer: `Clerk:${finance}`, preparationNote: "Verified the synthetic zero-activity close and its source scope.", discrepancyResponses: savedItem.issues.map((issue:any)=>({issueId:issue.id,explanation:"This synthetic access rehearsal has no external source deliveries."})), unresolvedAcceptance: "Finance will record the limited scope of this synthetic access rehearsal." }));
  const sourceExceptions = savedClose.data.reviewBasis.sourceCompleteness.issues.map((issue:any)=>({issueId:issue.id,reason:"The synthetic zero-activity access rehearsal has no external source deliveries.",evidence:"Access rehearsal scope TEST-1."}));
  const decisions = await Promise.all(["First independent check.", "Second concurrent check."].map(note => call(`/v1/pilot/close-reviews/${review.id}/decision?merchantId=${a.id}`, "finance", "POST", { action: "approve", expectedUpdatedAt: review.updatedAt, note, sourceExceptions })));
  assert.deepEqual(decisions.map(r => r.status).sort(), [200, 409], "The lender lock permits exactly one independent decision.");
  assert.equal(ok(await call(`/v1/pilot/progress?merchantId=${a.id}`, "finance")).steps.find((step: any) => step.id === "close").state, "completed");
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), entry = new Promise<void>(resolve => { entered = resolve; });
  const work = store.inWorkspace(requestFor("finance"), responseStub, async ctx => { await store.loadState(ctx, a.id); entered(); await hold; });
  await entry;
  let finished = false;
  const revoke = call(`/v1/team/members/${memberId}/lenders`, "admin", "PATCH", { expectedUpdatedAt: allowed.updatedAt, lenderIds: [], reason: "The pilot work is reassigned to another team." }).then(result => { finished = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(finished, false, "Grant revocation must wait for in-flight authorised work.");
  let lateFinished = false;
  const late = call(`/v1/records/customers?merchantId=${a.id}`, "finance").then(result => { lateFinished = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(lateFinished, false, "A request arriving while the revocation waits queues behind it.");
  release(); await work; ok(await revoke);
  assert.equal((await late).status, 404, "The queued request runs after the revocation, without the removed grant.");
  assert.equal((await call(`/v1/records/customers?merchantId=${a.id}`, "finance")).status, 404, "An existing session cannot read after its lender grant is removed.");
  assert.equal((await call(`/v1/pilot/close-reviews?merchantId=${a.id}`, "finance")).status, 404);
  // Accepting an invitation changes the memberships, like a revocation: it waits for the work already running, and a request arriving meanwhile waits behind it.
  const invitee = `user_${randomUUID().replaceAll("-", "")}`; identities.set("invitee", auth(invitee));
  const invitation = ok(await call("/v1/team/invitations", "admin", "POST", { email: "invitee@example.test", role: "Operations" }));
  (clerkClient.users as any).getUser = async () => ({ emailAddresses: [{ emailAddress: "invitee@example.test", verification: { status: "verified" } }] });
  const lockWaits = async (count: number) => { for (let attempt = 0; attempt < 250; attempt++) { if (Number((await pool.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0].n) >= count) return true; await new Promise(resolve => setTimeout(resolve, 20)); } return false; };
  let releaseReader!: () => void, readerIn!: () => void;
  const readerHold = new Promise<void>(resolve => { releaseReader = resolve; }), readerEntry = new Promise<void>(resolve => { readerIn = resolve; });
  const reader = store.inWorkspace(requestFor("admin"), responseStub, async ctx => { await store.loadState(ctx, a.id, "share"); readerIn(); await readerHold; }, "read");
  await readerEntry;
  let accepted = false, lateEntered = false, lateSawMember: unknown;
  const accepting = call("/v1/team/accept", "invitee", "POST", { token: invitation.token }).then(result => { accepted = true; return result; });
  try {
    assert.ok(await lockWaits(1), "The invitation acceptance waits for the read already running."); assert.equal(accepted, false);
    const late = store.inWorkspace(requestFor("admin"), responseStub, async () => { lateEntered = true; lateSawMember = (await pool.query("SELECT status FROM valopay_staff_memberships WHERE workspace_id=$1 AND user_id=$2", [workspace.workspaceId, invitee])).rows[0]?.status; }, "read");
    const queued = await lockWaits(2);
    assert.equal(lateEntered, false, "A request arriving while the acceptance waits queues behind it."); assert.ok(queued);
    releaseReader(); await reader;
    assert.equal(ok(await accepting).role, "Operations"); await late;
    assert.equal(lateSawMember, "active", "The queued request runs after the acceptance committed.");
  } finally { releaseReader(); await reader.catch(() => undefined); await accepting.catch(() => undefined); }
  // Another organisation that names this organisation's lender in its own requests fills only its own gate slots, never this organisation's.
  const otherOrg = `org_${randomUUID().replaceAll("-", "")}`, outsider = `user_${randomUUID().replaceAll("-", "")}`;
  identities.set("outsider", { ...auth(outsider), orgId: otherOrg });
  owned.push((await store.provisionStaffWorkspace(otherOrg, outsider, "Another organisation")).workspaceId);
  let releaseOutsiders!: () => void;
  const outsidersHeld = new Promise<void>(resolve => { releaseOutsiders = resolve; }), outsidersIn: Promise<void>[] = [];
  const outsiders = Array.from({ length: store.lenderConnections }, () => {
    let inside!: () => void; outsidersIn.push(new Promise<void>(resolve => { inside = resolve; }));
    return store.inWorkspace({ ...requestFor("outsider"), query: { merchantId: a.id } }, responseStub, async () => { inside(); await outsidersHeld; }, "read").finally(() => inside());
  });
  try {
    await Promise.all(outsidersIn);
    const started = Date.now();
    await store.inWorkspace({ ...requestFor("admin"), query: { merchantId: a.id } }, responseStub, ctx => store.loadState(ctx, a.id, "share"), "read");
    assert.ok(Date.now() - started < 1_000, `An organisation's read of its own lender is not held up by another organisation naming it (${Date.now() - started} ms).`);
  } finally { releaseOutsiders(); }
  await Promise.all(outsiders);
  console.log("Staff lender API/PostgreSQL checks passed: default denial, explicit grants, MFA (a replay included), no record reached through another lender's address, lender-filtered reviewers, independent concurrent close approval, synchronised access removal and invitation acceptance that later requests cannot overtake, and another organisation naming a lender never holds it up.");
} finally {
  server.close(); await once(server, "close");
  for (const id of owned) { await pool.query("DELETE FROM valopay_staff_events WHERE workspace_id=$1", [id]); await pool.query("DELETE FROM valopay_staff_invitations WHERE workspace_id=$1", [id]); await pool.query("DELETE FROM valopay_staff_memberships WHERE workspace_id=$1", [id]); await pool.query("DELETE FROM valopay_teams WHERE workspace_id=$1", [id]); await pool.query("DELETE FROM valopay_idempotency WHERE merchant_id IN(SELECT id FROM valopay_merchants WHERE workspace_id=$1)", [id]); await pool.query("DELETE FROM valopay_records WHERE merchant_id IN(SELECT id FROM valopay_merchants WHERE workspace_id=$1)", [id]); await pool.query("DELETE FROM valopay_merchants WHERE workspace_id=$1", [id]); await pool.query("DELETE FROM valopay_workspaces WHERE id=$1", [id]); }
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  (clerkClient.users as any).getUser = savedGetUser;
  if (savedClerkKey === undefined) delete process.env.CLERK_SECRET_KEY; else process.env.CLERK_SECRET_KEY = savedClerkKey;
  await pool.end();
}
