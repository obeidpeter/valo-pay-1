import { SANDBOX_COOKIE } from "../src/lib/sandbox-cookie";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

if (process.env.VALO_PAY_1_RUN_INTEGRATION !== "1") {
  console.log(
    "Opt in on a disposable database to run the pilot workflow integration suite.",
  );
  process.exit(0);
}
// Cache one SDK client so its test-only verified-email adapter is stable.
// This deliberately unusable placeholder is never sent to an external service.
process.env.CLERK_SECRET_KEY = "sk_test_placeholder";
const { pool } = await import("@workspace/valo-pay-1-db");
const { default: router } = await import("../src/routes/index");
const { errorHandler } = await import("../src/lib/error-handler");
const store = await import("../src/lib/valo-pay-1-store");
const { clerkClient } = await import("@clerk/express");

// Actual routes/repository/database, with a test-only verified identity adapter.
// No unverified identity header exists in the application server.
const identities = new Map<string, any>();
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((req, _res, next) => {
  const auth = identities.get(String(req.header("X-Test-Identity"))) || {
    userId: null,
  };
  (req as any).auth = Object.assign(() => auth, {
    [Symbol.for("@clerk/express.auth")]: true,
  });
  (req as any).log = { info() {}, warn() {}, error() {} };
  next();
});
app.use("/api", router);
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const cookie = `${SANDBOX_COOKIE}=${randomBytes(32).toString("hex")}`;
async function call(
  path: string,
  method = "GET",
  body?: any,
  key?: string,
  identity?: string,
  sandboxCookie = cookie,
) {
  const result = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: sandboxCookie,
      ...(key ? { "Idempotency-Key": key } : {}),
      ...(identity ? { "X-Test-Identity": identity } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data: any = await result.json();
  return { status: result.status, data };
}
const ok = (result: { status: number; data: any }) => {
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
};
const reqFor = (id: string) =>
  ({
    headers: {},
    auth: Object.assign(() => identities.get(id), {
      [Symbol.for("@clerk/express.auth")]: true,
    }),
  }) as any;
const response = { cookie() {} } as any;
const savedEnv = {
  mode: process.env.VALO_PAY_1_STAFF_ACCESS,
  issuer: process.env.VALO_PAY_1_STAFF_ISSUER,
  origins: process.env.VALO_PAY_1_STAFF_ORIGINS,
};
const oldGetUser = clerkClient.users.getUser;
const cleanupWorkspaces = new Set<string>();
try {
  // Apply the additive migration twice: fresh schema and repeat-run safety.
  const migration = await readFile(
    new URL(
      "../../../lib/db/migrations/003_pilot_workflow.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await pool.query(migration);
  await pool.query(migration);
  await pool.query(await readFile(new URL("../../../lib/db/migrations/004_staff_lender_access.sql", import.meta.url), "utf8"));
  const workspace = ok(await call("/v1/workspace"));
  const lender = workspace.merchants[0].id,
    other = workspace.merchants[1].id;
  const owned = await pool.query(
    "SELECT workspace_id FROM valopay_merchants WHERE id=$1",
    [lender],
  );
  cleanupWorkspaces.add(owned.rows[0].workspace_id);
  const path = `/v1/records/customers?merchantId=${lender}`;
  const body = {
    name: "Recovery fixture",
    reference: `RECOVERY-${randomUUID()}`,
    data: { consentProvenance: "Synthetic fixture" },
  };
  const key = randomUUID();
  const first = ok(await call(path, "POST", body, key));
  const history = ok(await call(`/v1/operations?merchantId=${lender}`));
  assert.equal(history.total, 1);
  assert.equal(history.items[0].status, "completed");
  // The entry keeps only a reference to the saved record, which Operations links to; the answer itself is kept once, under the key.
  assert.deepEqual([history.items[0].recordId, history.items[0].recordKind], [first.id, "customers"]);
  assert.deepEqual(
    (await pool.query("SELECT receipt FROM valopay_operations WHERE id=$1", [history.items[0].id])).rows[0].receipt,
    { id: first.id, kind: "customers" },
  );
  assert.equal(
    "request" in history.items[0],
    false,
    "List must not expose original request bodies.",
  );
  // A new HTTP request, with no browser payload/key, recovers the original ID.
  const recovered = ok(
    await call(
      `/v1/operations/${history.items[0].id}/retry?merchantId=${lender}`,
      "POST",
      {},
    ),
  );
  assert.equal(recovered.id, first.id);
  assert.equal(ok(await call(`${path}&search=${body.reference}`)).total, 1);
  assert.equal(
    (await call(path, "POST", { ...body, name: "Changed input" }, key)).status,
    409,
  );
  assert.equal(
    (
      await call(
        `/v1/operations/${history.items[0].id}/retry?merchantId=${other}`,
        "POST",
        {},
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await call(
        `/v1/operations?merchantId=${lender}`,
        "GET",
        undefined,
        undefined,
        undefined,
        `${SANDBOX_COOKIE}=${randomBytes(32).toString("hex")}`,
      )
    ).status,
    404,
  );
  const raceKey = randomUUID(),
    raceBody = { ...body, reference: `RACE-${randomUUID()}` };
  const parallel = await Promise.all(
    Array.from({ length: 3 }, () => call(path, "POST", raceBody, raceKey)),
  );
  // One attempt runs the request; one arriving while it runs is turned away as still running and leaves it alone.
  for (const answer of parallel.filter((item) => item.status !== 200)) {
    assert.deepEqual(
      [answer.status, answer.data.operation, answer.data.committed],
      [503, "running", undefined],
      JSON.stringify(answer.data),
    );
  }
  const raced = ok(await call(path, "POST", raceBody, raceKey));
  assert.deepEqual(
    [...new Set(parallel.filter((item) => item.status === 200).map((item) => item.data.id)), raced.id].filter((id, index, all) => all.indexOf(id) === index),
    [raced.id],
    "every answer names the one record saved",
  );
  assert.equal(ok(await call(`${path}&search=${raceBody.reference}`)).total, 1);

  const rejectedKey = randomUUID();
  const refused = await call(
    path,
    "POST",
    { name: "Missing required consent" },
    rejectedKey,
  );
  assert.equal(refused.status, 400);
  assert.equal(
    refused.data.operation,
    "cancelled",
    "A definitive refusal says its journal entry is cancelled, so the console may release the request.",
  );
  // A definitive refusal closes the journal entry with its reason; it never
  // lingers as pending, so refused requests cannot exhaust the pending limit.
  const listed = ok(await call(`/v1/operations?merchantId=${lender}`)).items;
  const pending = listed.find(
    (row: any) =>
      row.status === "cancelled" && /refused this request/.test(row.message),
  );
  assert.ok(pending, "A refused request is closed with its reason.");
  assert.match(pending.message, /consent/i);
  assert.equal(
    listed.some((row: any) => row.status === "pending"),
    false,
    "A refused request does not wait for confirmation.",
  );
  ok(
    await call(
      `/v1/operations/${pending.id}/cancel?merchantId=${lender}`,
      "POST",
      {},
    ),
  );
  const resubmitted = await call(
    path,
    "POST",
    { name: "Missing required consent" },
    rejectedKey,
  );
  assert.equal(resubmitted.status, 409);
  assert.equal(resubmitted.data.operation, "cancelled", "A cancelled key says so again.");
  assert.match(
    resubmitted.data.error,
    /refused this request and saved nothing: .*consent/i,
    "The same person hears the original reason.",
  );
  const replayed = await call(
    `/v1/operations/${pending.id}/retry?merchantId=${lender}`,
    "POST",
    {},
  );
  assert.equal(replayed.status, 409);
  assert.equal(replayed.data.operation, "cancelled");

  // A connected action lost before it arrived, retried after someone else changed
  // the workspace: the stale-revision refusal cancels its key and says so.
  const connectedView = ok(
    await call(`/v1/connected?merchantId=${lender}`),
  );
  const grant = {
    action: "consent.grant",
    reason: "Grant a synthetic permission for the retry check",
    data: {
      purpose: "account_read",
      subjectId: connectedView.customers[0].id,
      days: 30,
    },
    expectedRevision: connectedView.revision,
  };
  ok(
    await call(
      `/v1/connected/actions?merchantId=${lender}`,
      "POST",
      { ...grant, reason: "Another person grants a permission first" },
      randomUUID(),
    ),
  );
  const connectedKey = randomUUID();
  for (const attempt of [1, 2]) {
    const retried = await call(
      `/v1/connected/actions?merchantId=${lender}`,
      "POST",
      grant,
      connectedKey,
    );
    assert.equal(retried.status, 409, JSON.stringify(retried.data));
    assert.equal(
      retried.data.operation,
      "cancelled",
      `Connected retry ${attempt} says its key is cancelled.`,
    );
  }

  // An outcome that is still unknown is never marked: a refusal before the
  // journal entry exists, or a pending entry checked under another role.
  const unfinishedBody = {
    name: "Unfinished request",
    reference: `UNFINISHED-${randomUUID()}`,
    data: { consentProvenance: "Synthetic fixture" },
  };
  const unfinishedKey = randomUUID();
  const sandboxRequest = () =>
    ({
      headers: { cookie },
      secure: false,
      auth: Object.assign(() => ({ userId: null }), {
        [Symbol.for("@clerk/express.auth")]: true,
      }),
    }) as any;
  await store.inWorkspace(sandboxRequest(), response, (ctx) =>
    store.prepareOperation(ctx, lender, unfinishedKey, {
      method: "POST",
      path: "/v1/records/customers",
      body: unfinishedBody,
    }),
  );
  const switchRole = async (role: string) =>
    ok(
      await call(
        `/v1/actions?merchantId=${lender}`,
        "POST",
        { action: "set_role", data: { role } },
        randomUUID(),
      ),
    );
  await switchRole("Read-only");
  const readOnly = await call(path, "POST", unfinishedBody, randomUUID());
  assert.equal(readOnly.status, 403);
  assert.equal(readOnly.data.operation, undefined, "No entry was written, so nothing is marked.");
  const otherRole = await call(path, "POST", unfinishedBody, unfinishedKey);
  assert.equal(otherRole.status, 403);
  assert.match(otherRole.data.error, /^This request was sent with a different demo role\. Change your demo role in Settings, then check it\.$/);
  assert.equal(otherRole.data.operation, undefined, "A pending entry checked under another role is not marked.");
  await switchRole("Admin");

  // A cancelled entry is final: an attempt already past its checks when a
  // retry's refusal cancelled the entry is refused at completion and saves nothing.
  const racedKey = randomUUID();
  const original = sandboxRequest();
  const { id: racedId } = await store.inWorkspace(original, response, (ctx) =>
    store.prepareOperation(ctx, lender, racedKey, {
      method: "POST",
      path: "/v1/records/customers",
      body: { name: "Race sample" },
    }),
  );
  store.bindOperation(original, racedId, lender);
  let cancelledMeanwhile: string | undefined;
  await assert.rejects(
    store.inWorkspace(original, response, async (ctx) => {
      const state = await store.loadState(ctx, lender, "update");
      cancelledMeanwhile = await store.rejectOperation(
        sandboxRequest(),
        { id: racedId, merchantId: lender },
        {
          status: 409,
          message: "The workspace changed. Refresh and review before trying again.",
        },
        "refused",
      );
      await store.saveState(ctx, state);
      await store.saveIdempotency(
        ctx,
        store.digest(`${lender}:${racedKey}`),
        "fingerprint",
        { id: "receipt" },
      );
    }),
    /cancelled before it completed/,
  );
  assert.equal(cancelledMeanwhile, "cancelled", "The refusal reports the entry it cancelled.");
  assert.equal(
    (
      await pool.query("SELECT status FROM valopay_operations WHERE id=$1", [
        racedId,
      ])
    ).rows[0].status,
    "cancelled",
  );
  assert.equal(
    (
      await pool.query("SELECT 1 FROM valopay_idempotency WHERE id=$1", [
        store.digest(`${lender}:${racedKey}`),
      ])
    ).rows.length,
    0,
    "Nothing the cancelled attempt did was saved.",
  );
  assert.equal(
    await store.rejectOperation(
      sandboxRequest(),
      { id: history.items[0].id, merchantId: lender },
      { status: 409, message: "Late refusal" },
      "refused",
    ),
    "completed",
    "A refusal after completion leaves the completed entry alone and says it was saved.",
  );
  assert.equal(
    (
      await call(
        `/v1/operations/${history.items[0].id}/cancel?merchantId=${lender}`,
        "POST",
        {},
      )
    ).status,
    409,
  );

  // An entry cancelled while its own request is past its checks (a concurrent
  // retry's refusal, or Cancel if unfinished) is refused at completion; that
  // refusal finds the entry already cancelled and still says so.
  const midwayBody = {
    name: "Cancelled midway",
    reference: `MIDWAY-${randomUUID()}`,
    data: { consentProvenance: "Synthetic fixture" },
  };
  const midwayKey = randomUUID();
  const { id: midwayId } = await store.inWorkspace(sandboxRequest(), response, (ctx) =>
    store.prepareOperation(ctx, lender, midwayKey, {
      method: "POST",
      path: "/v1/records/customers",
      body: midwayBody,
    }),
  );
  const canceller = await pool.connect();
  let midway: { status: number; data: any };
  try {
    await canceller.query("BEGIN");
    const cancellerPid = (await canceller.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await canceller.query(
      "UPDATE valopay_operations SET status='cancelled',updated_at=now() WHERE id=$1 AND status='pending'",
      [midwayId],
    );
    const answer = call(path, "POST", midwayBody, midwayKey);
    // The request reaches completeOperation and waits for the cancellation to commit.
    for (let waited = 0; ; waited += 20) {
      const blocked = await pool.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
        [cancellerPid],
      );
      if (blocked.rows[0].n > 0) break;
      assert.ok(waited < 4000, "The request should wait for the cancellation.");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await canceller.query("COMMIT");
    midway = await answer;
  } finally {
    canceller.release();
  }
  assert.equal(midway.status, 409, JSON.stringify(midway.data));
  assert.match(midway.data.error, /cancelled before it completed/);
  assert.equal(
    midway.data.operation,
    "cancelled",
    "A refusal of an entry already cancelled says so: nothing sent with the key was saved.",
  );
  assert.equal(
    (
      await pool.query("SELECT 1 FROM valopay_records WHERE reference=$1", [
        midwayBody.reference,
      ])
    ).rows.length,
    0,
  );

  // A write that committed before the journal existed has a receipt and no
  // entry; its retry creates a pending entry. A refusal before the receipt is
  // read must not cancel that entry or say the request was not saved.
  for (const prefix of ["", "connected:"]) {
    const legacyKey = randomUUID();
    await store.inWorkspace(sandboxRequest(), response, async (ctx) => {
      await store.loadState(ctx, lender, "update");
      await store.saveIdempotency(
        ctx,
        store.digest(`${prefix}${lender}:${legacyKey}`),
        "legacy fingerprint",
        { id: "legacy receipt" },
      );
    });
    const { id: legacyId } = await store.inWorkspace(sandboxRequest(), response, (ctx) =>
      store.prepareOperation(ctx, lender, legacyKey, {
        method: "POST",
        path: prefix ? "/v1/connected/actions" : "/v1/records/customers",
        body: { name: "Saved before the journal" },
      }),
    );
    assert.equal(
      await store.rejectOperation(
        sandboxRequest(),
        { id: legacyId, merchantId: lender },
        { status: 404, message: "You do not have access to this lender. Choose another lender, or ask an Admin for access." },
        "refused",
      ),
      "completed",
      `A refused retry of a ${prefix || "record "}key with an earlier receipt is never marked cancelled: the answer says it was saved.`,
    );
    assert.equal(
      (
        await pool.query("SELECT status FROM valopay_operations WHERE id=$1", [
          legacyId,
        ])
      ).rows[0].status,
      "pending",
      "Its entry is not cancelled: the original request was saved.",
    );
    await pool.query("DELETE FROM valopay_operations WHERE id=$1", [legacyId]);
  }

  const setupKey = randomUUID();
  const empty = ok(
    await call(
      "/v1/pilot/lenders",
      "POST",
      { name: "Empty pilot lender", segment: "Cooperative" },
      setupKey,
    ),
  );
  assert.equal(
    ok(
      await call(
        "/v1/pilot/lenders",
        "POST",
        { name: "Empty pilot lender", segment: "Cooperative" },
        setupKey,
      ),
    ).id,
    empty.id,
  );
  assert.equal(
    ok(await call(`/v1/records/customers?merchantId=${empty.id}`)).total,
    0,
  );
  // A creation whose answer was lost, sent again after a reload with a new key, finds the lender it made: a name that
  // matches one already in the workspace, whatever its case and spaces, is refused naming that lender.
  for (const name of ["Empty pilot lender", "  empty   PILOT lender "]) {
    const again = await call(
      "/v1/pilot/lenders",
      "POST",
      { name, segment: "Cooperative" },
      randomUUID(),
    );
    assert.equal(again.status, 409, JSON.stringify(again.data));
    assert.equal(
      again.data.error,
      'A lender named “Empty pilot lender” already exists in this workspace. Choose it from the lender list, or use another name.',
    );
  }
  assert.equal(
    ok(await call("/v1/workspace")).merchants.filter((lender: any) => /empty\s+pilot\s+lender/i.test(lender.name)).length,
    1,
    "no second lender was made",
  );
  // A sandbox holds at most five lenders, the two samples included. Creation
  // takes the workspace lock exclusively, so creations at once are counted one
  // after another and never pass the limit together.
  const concurrent = await Promise.all(
    [1, 2, 3, 4].map((n) =>
      call(
        "/v1/pilot/lenders",
        "POST",
        { name: `Extra pilot lender ${n}`, segment: "Cooperative" },
        randomUUID(),
      ),
    ),
  );
  assert.deepEqual(
    concurrent.map((result) => result.status).sort(),
    [200, 200, 409, 409],
  );
  for (const refused of concurrent.filter((result) => result.status === 409))
    assert.match(String((refused.data as { error?: unknown }).error), /the most it can hold/);
  assert.equal(
    ok(
      await call(
        "/v1/pilot/lenders",
        "POST",
        { name: "Empty pilot lender", segment: "Cooperative" },
        setupKey,
      ),
    ).id,
    empty.id,
    "a repeated setup request still returns its lender at the limit",
  );
  assert.equal(ok(await call("/v1/workspace")).merchants.length, 5);
  const batchInput = {
    name: "Pilot customers",
    kind: "customers",
    source: "source-a",
    sourceBatchId: "batch-1",
    csv: "row_id,name,reference,consentProvenance\nr1,Pilot customer,PILOT-C001,Synthetic consent",
    mapping: {},
    amountUnit: "naira",
    identityColumn: "row_id",
    syntheticOnly: true,
  };
  let batch = ok(
    await call(
      `/v1/pilot/batches?merchantId=${empty.id}`,
      "POST",
      batchInput,
      randomUUID(),
    ),
  );
  assert.equal(batch.status, "ready");
  const commits = await Promise.all(
    Array.from({ length: 2 }, () =>
      call(
        `/v1/pilot/batches/${batch.id}/commit?merchantId=${empty.id}`,
        "POST",
        { expectedUpdatedAt: batch.updatedAt },
        randomUUID(),
      ),
    ),
  );
  assert.deepEqual(
    commits.map((r) => r.status).sort(),
    [200, 409],
    "Concurrent distinct commits cannot double import.",
  );
  batch = ok(
    await call(`/v1/pilot/batches/${batch.id}?merchantId=${empty.id}`),
  ).batch;
  assert.equal(batch.status, "committed");
  assert.equal(batch.data.check.imported, 1);
  const repeated = ok(
    await call(
      `/v1/pilot/batches?merchantId=${empty.id}`,
      "POST",
      { ...batchInput, sourceBatchId: "batch-2" },
      randomUUID(),
    ),
  );
  assert.equal(repeated.data.check.skipped, 1);
  assert.equal(
    ok(await call(`/v1/records/customers?merchantId=${empty.id}`)).total,
    1,
  );

  const exception = ok(
    await call(`/v1/records/exceptions?merchantId=${lender}`),
  ).items[0];
  const caseBody = {
    action: "claim",
    expectedUpdatedAt: exception.updatedAt,
    note: "Reviewing the receipt evidence.",
    nextAction: "Ask Finance to check the match",
    nextActionAt: new Date(Date.now() + 86400000).toISOString(),
    evidenceIds: [],
  };
  const claims = await Promise.all(
    Array.from({ length: 2 }, () =>
      call(
        `/v1/pilot/cases/${exception.id}?merchantId=${lender}`,
        "POST",
        caseBody,
        randomUUID(),
      ),
    ),
  );
  assert.deepEqual(claims.map((r) => r.status).sort(), [200, 409]);
  const caseDetail = ok(
    await call(`/v1/pilot/cases/${exception.id}?merchantId=${lender}`),
  );
  assert.equal(caseDetail.events.length, 1);
  assert.equal(caseDetail.record.data.case.assignee, "Sandbox Admin");
  // A demo persona has one name: the actor its changes are recorded under, in the case roster and on the case alike.
  assert.equal(caseDetail.record.data.case.assigneeName, "Sandbox Admin");
  assert.ok(caseDetail.assignees.length > 0 && caseDetail.assignees.every((person: { actor: string; name: string }) => person.name === person.actor), JSON.stringify(caseDetail.assignees));

  // Complete the empty lender journey using actual routes and persisted state.
  const ingest = async (kind: string, csv: string) => {
    const saved = ok(
      await call(
        `/v1/pilot/batches?merchantId=${empty.id}`,
        "POST",
        {
          ...batchInput,
          kind,
          name: `Pilot ${kind}`,
          sourceBatchId: kind,
          csv,
        },
        randomUUID(),
      ),
    );
    assert.equal(saved.data.check.invalid, 0, JSON.stringify(saved.data.check));
    return ok(
      await call(
        `/v1/pilot/batches/${saved.id}/commit?merchantId=${empty.id}`,
        "POST",
        { expectedUpdatedAt: saved.updatedAt },
        randomUUID(),
      ),
    );
  };
  await ingest(
    "due-items",
    "row_id,name,reference,customerId,amount,dueDate,owner\ndue-1,Pilot instalment,PILOT-D001,PILOT-C001,25000,2028-12-01,lms",
  );
  await ingest(
    "observations",
    "row_id,name,reference,customerId,amount,source,dueItemId,narration\npay-1,Pilot payment,PILOT-O001,PILOT-C001,25000,statement,PILOT-D001,Synthetic payment",
  );
  const act = async (data: any) =>
    ok(
      await call(
        `/v1/actions?merchantId=${empty.id}`,
        "POST",
        data,
        randomUUID(),
      ),
    );
  await act({ action: "run_reconciliation" });
  const customers = ok(
    await call(`/v1/records/customers?merchantId=${empty.id}`),
  ).items;
  const payments = ok(
    await call(`/v1/records/payments?merchantId=${empty.id}`),
  ).items;
  assert.equal(payments.length, 1);
  let pilotCase = ok(
    await call(
      `/v1/records/exceptions?merchantId=${empty.id}`,
      "POST",
      {
        name: "Classify synthetic provider code",
        customerId: customers[0].id,
        data: {
          type: "mapping_needed",
          notes: "Synthetic classification task",
        },
      },
      randomUUID(),
    ),
  );
  const coordinate = async (data: any) =>
    ok(
      await call(
        `/v1/pilot/cases/${pilotCase.id}?merchantId=${empty.id}`,
        "POST",
        { ...caseBody, expectedUpdatedAt: pilotCase.updatedAt, ...data },
        randomUUID(),
      ),
    );
  pilotCase = await coordinate({ action: "claim" });
  pilotCase = await coordinate({
    action: "handover",
    assignee: "Sandbox Finance",
    note: "Finance to complete the synthetic classification.",
  });
  await act({ action: "set_role", data: { role: "Finance" } });
  await act({
    action: "resolve_exception",
    recordId: pilotCase.id,
    expectedUpdatedAt: pilotCase.updatedAt,
    reason:
      "Classified the synthetic provider code after checking its evidence.",
    data: { resolutionCode: "mapped_to_code" },
  });
  await act({ action: "daily_close" });
  const closes = ok(await call(`/v1/close-history?merchantId=${empty.id}`));
  assert.equal(closes.total, 1);
  const { buildExportBytes } = await import("../src/lib/valo-pay-1-exports");
  const evidence = await store.inWorkspace(
    {
      headers: { cookie },
      auth: Object.assign(() => ({ userId: null }), {
        [Symbol.for("@clerk/express.auth")]: true,
      }),
    } as any,
    response,
    async (ctx) => {
      const state = await store.loadState(ctx, empty.id, "share");
      return {
        close: await buildExportBytes(state, ctx, {
          kind: "closes",
          format: "json",
        }),
        pack: await buildExportBytes(state, ctx, {
          kind: "dispute-pack",
          customerId: customers[0].id,
          format: "json",
        }),
      };
    },
    "read",
  );
  assert.equal(JSON.parse(evidence.close.bytes.toString()).data.length, 1);
  assert.ok(
    evidence.pack.bytes
      .toString()
      .includes("Finance to complete the synthetic classification."),
  );
  await act({ action: "set_role", data: { role: "Admin" } });

  process.env.VALO_PAY_1_STAFF_ACCESS = "staging";
  process.env.VALO_PAY_1_STAFF_ISSUER = "https://identity.example";
  process.env.VALO_PAY_1_STAFF_ORIGINS = "https://pilot.example";
  const organisation = `org_${randomUUID().replaceAll("-", "")}`,
    admin = `user_${randomUUID().replaceAll("-", "")}`,
    finance = `user_${randomUUID().replaceAll("-", "")}`;
  const staffAuth = (userId: string, orgId = organisation) => {
    const now = Math.floor(Date.now() / 1000);
    return {
      userId,
      sessionId: `sess_${userId}`,
      orgId,
      tokenType: "session_token",
      sessionStatus: "active",
      factorVerificationAge: [0, 0],
      sessionClaims: {
        sub: userId,
        sid: `sess_${userId}`,
        iss: "https://identity.example",
        azp: "https://pilot.example",
        iat: now - 1,
        exp: now + 3600,
      },
    };
  };
  identities.set("admin", staffAuth(admin));
  identities.set("finance", staffAuth(finance));
  const provisioned = await store.provisionStaffWorkspace(
    organisation,
    admin,
    "Synthetic staff organisation",
  );
  cleanupWorkspaces.add(provisioned.workspaceId);
  assert.equal(
    (await call("/v1/workspace")).status,
    401,
    "Staff mode never falls back to an anonymous administrator.",
  );
  const staffWorkspace = ok(
    await call("/v1/workspace", "GET", undefined, undefined, "admin"),
  );
  assert.equal(staffWorkspace.accessMode, "staff");
  assert.equal(staffWorkspace.actor, `Clerk:${admin}`);
  assert.equal(staffWorkspace.merchants.length, 0);
  const pilot = ok(
    await call(
      "/v1/pilot/lenders",
      "POST",
      { name: "Staff pilot", segment: "Consumer lending" },
      randomUUID(),
      "admin",
    ),
  );
  // The five-lender limit is the sandbox's: a staff workspace takes a sixth.
  for (const n of [2, 3, 4, 5, 6])
    ok(
      await call(
        "/v1/pilot/lenders",
        "POST",
        { name: `Staff pilot ${n}`, segment: "Consumer lending" },
        randomUUID(),
        "admin",
      ),
    );
  assert.equal(
    ok(await call("/v1/workspace", "GET", undefined, undefined, "admin"))
      .merchants.length,
    6,
  );
  // Staff mode has no lender limit, so the name alone stops a lost creation sent again with a new key from making a second.
  const repeatedStaff = await call(
    "/v1/pilot/lenders",
    "POST",
    { name: "STAFF  pilot 6", segment: "Cooperative" },
    randomUUID(),
    "admin",
  );
  assert.deepEqual(
    [repeatedStaff.status, repeatedStaff.data.error],
    [409, 'A lender named “Staff pilot 6” already exists in this workspace. Choose it from the lender list, or use another name.'],
  );
  assert.equal(
    ok(await call("/v1/workspace", "GET", undefined, undefined, "admin"))
      .merchants.length,
    6,
  );
  assert.equal(
    (
      await call(
        `/v1/actions?merchantId=${pilot.id}`,
        "POST",
        { action: "set_role", data: { role: "Finance" } },
        randomUUID(),
        "admin",
      )
    ).status,
    403,
  );
  const invitation = ok(
    await call(
      "/v1/team/invitations",
      "POST",
      { email: "finance@example.test", role: "Finance" },
      undefined,
      "admin",
    ),
  );
  // A Finance grant waits for a second administrator: the operator adds one, and that administrator approves it.
  assert.equal(invitation.approval, "awaiting");
  const secondAdmin = `user_${randomUUID().replaceAll("-", "")}`;
  identities.set("second-admin", staffAuth(secondAdmin));
  await store.addStaffAdministrator(organisation, secondAdmin, "Second administrator");
  ok(await call(`/v1/team/invitations/${invitation.id}/approve`, "POST", undefined, undefined, "second-admin"));
  (clerkClient.users as any).getUser = async () => ({
    emailAddresses: [
      {
        emailAddress: "wrong@example.test",
        verification: { status: "verified" },
      },
    ],
  });
  assert.equal(
    (
      await call(
        "/v1/team/accept",
        "POST",
        { token: invitation.token },
        undefined,
        "finance",
      )
    ).status,
    403,
  );
  (clerkClient.users as any).getUser = async () => ({
    emailAddresses: [
      {
        emailAddress: "finance@example.test",
        verification: { status: "verified" },
      },
    ],
  });
  ok(
    await call(
      "/v1/team/accept",
      "POST",
      { token: invitation.token },
      undefined,
      "finance",
    ),
  );
  assert.equal(
    (
      await call(
        "/v1/team/accept",
        "POST",
        { token: invitation.token },
        undefined,
        "finance",
      )
    ).status,
    403,
    "Invitation tokens are single-use.",
  );
  const unassignedStaff = ok(await call("/v1/workspace", "GET", undefined, undefined, "finance"));
  assert.equal(unassignedStaff.merchants.length, 0, "Accepted non-administrator staff start without lender access.");
  const invitedMember = ok(await call("/v1/team", "GET", undefined, undefined, "admin")).members.find((row: any) => row.actor === `Clerk:${finance}`);
  ok(await call(`/v1/team/members/${invitedMember.id}/lenders`, "PATCH", { expectedUpdatedAt: invitedMember.updatedAt, lenderIds: [pilot.id], reason: "Assign Finance to the synthetic lender rehearsal." }, undefined, "admin"));
  const staff = ok(
    await call("/v1/workspace", "GET", undefined, undefined, "finance"),
  );
  assert.equal(staff.role, "Finance");
  assert.notEqual(staff.viewerScope, staffWorkspace.viewerScope);
  assert.equal(staff.merchants[0].id, pilot.id);
  assert.equal(
    (
      await call(
        `/v1/records/customers?merchantId=${lender}`,
        "GET",
        undefined,
        undefined,
        "finance",
      )
    ).status,
    404,
  );
  identities.set("no-mfa", {
    ...staffAuth(finance),
    factorVerificationAge: [0, -1],
  });
  assert.equal(
    (await call("/v1/workspace", "GET", undefined, undefined, "no-mfa")).status,
    403,
  );
  identities.set("old-mfa", {
    ...staffAuth(finance),
    factorVerificationAge: [11, 11],
  });
  assert.equal(
    (
      await call(
        `/v1/records/customers?merchantId=${pilot.id}`,
        "POST",
        body,
        randomUUID(),
        "old-mfa",
      )
    ).status,
    403,
  );

  // Invitations sent while the person is still active: one to the address the
  // membership was accepted with, one to another of their verified addresses.
  const sameAddress = ok(await call("/v1/team/invitations", "POST", { email: "finance@example.test", role: "Operations" }, undefined, "admin"));
  const otherAddress = ok(await call("/v1/team/invitations", "POST", { email: "finance.alt@example.test", role: "Admin" }, undefined, "admin"));

  // Hold a staff transaction. Revocation must wait for it, then immediately
  // refuse all subsequent reads/writes under the already-issued session.
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>((resolve) => {
      release = resolve;
    }),
    entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const work = store.inWorkspace(reqFor("finance"), response, async (ctx) => {
    await store.loadState(ctx, pilot.id);
    entered();
    await hold;
    return true;
  });
  await entry;
  const member = ok(
    await call("/v1/team", "GET", undefined, undefined, "admin"),
  ).members.find((row: any) => row.actor === `Clerk:${finance}`);
  let revoked = false;
  const revocation = call(
    `/v1/team/members/${member.id}`,
    "PATCH",
    {
      role: "Finance",
      status: "revoked",
      expectedUpdatedAt: member.updatedAt,
      reason: "Synthetic revocation rehearsal",
    },
    undefined,
    "admin",
  ).then((result) => {
    revoked = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(revoked, false);
  release();
  await work;
  ok(await revocation);
  assert.equal(
    (await call("/v1/workspace", "GET", undefined, undefined, "finance"))
      .status,
    403,
  );
  assert.equal(
    (
      await call(
        `/v1/records/customers?merchantId=${pilot.id}`,
        "POST",
        body,
        randomUUID(),
        "finance",
      )
    ).status,
    403,
  );
  // A revoked person cannot restore their own access with an invitation sent
  // before the revocation, whichever verified address it went to.
  assert.equal((await pool.query("SELECT status FROM valopay_staff_invitations WHERE id=$1", [sameAddress.id])).rows[0].status, "revoked", "Revocation withdraws the person's pending invitation.");
  (clerkClient.users as any).getUser = async () => ({
    emailAddresses: ["finance@example.test", "finance.alt@example.test"].map((emailAddress) => ({ emailAddress, verification: { status: "verified" } })),
  });
  assert.equal((await call("/v1/team/accept", "POST", { token: sameAddress.token }, undefined, "finance")).status, 403);
  const stale = await call("/v1/team/accept", "POST", { token: otherAddress.token }, undefined, "finance");
  assert.equal(stale.status, 403, "An invitation sent before the revocation cannot restore access, or raise it to Admin.");
  assert.match(String((stale.data as { error?: unknown }).error), /sent before your access was suspended or revoked/);
  assert.equal((await pool.query("SELECT status,role FROM valopay_staff_memberships WHERE workspace_id=$1 AND user_id=$2", [provisioned.workspaceId, finance])).rows[0].status, "revoked");
  const fresh = ok(await call("/v1/team/invitations", "POST", { email: "finance@example.test", role: "Read-only" }, undefined, "admin"));
  ok(await call("/v1/team/accept", "POST", { token: fresh.token }, undefined, "finance"));
  const restored = ok(await call("/v1/workspace", "GET", undefined, undefined, "finance"));
  assert.equal(restored.role, "Read-only", "An invitation sent after the revocation restores access at its own role.");
  assert.equal(restored.merchants.length, 0, "and without the lender access removed at revocation.");
  console.log(
    "Pilot API/PostgreSQL checks passed: durable recovery, cancellation, concurrent imports/cases, empty onboarding, staff invitation, MFA, isolation, synchronised revocation and invitations that cannot outlive a revocation.",
  );
} finally {
  (clerkClient.users as any).getUser = oldGetUser;
  for (const [key, value] of Object.entries({
    VALO_PAY_1_STAFF_ACCESS: savedEnv.mode,
    VALO_PAY_1_STAFF_ISSUER: savedEnv.issuer,
    VALO_PAY_1_STAFF_ORIGINS: savedEnv.origins,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  server.close();
  await once(server, "close");
  // Only the generated workspace IDs from this test are removed.
  for (const id of cleanupWorkspaces) {
    await pool.query("DELETE FROM valopay_staff_events WHERE workspace_id=$1", [
      id,
    ]);
    await pool.query(
      "DELETE FROM valopay_staff_invitations WHERE workspace_id=$1",
      [id],
    );
    await pool.query(
      "DELETE FROM valopay_staff_memberships WHERE workspace_id=$1",
      [id],
    );
    await pool.query("DELETE FROM valopay_teams WHERE workspace_id=$1", [id]);
    await pool.query(
      "DELETE FROM valopay_idempotency WHERE merchant_id IN(SELECT id FROM valopay_merchants WHERE workspace_id=$1)",
      [id],
    );
    await pool.query(
      "DELETE FROM valopay_records WHERE merchant_id IN(SELECT id FROM valopay_merchants WHERE workspace_id=$1)",
      [id],
    );
    await pool.query("DELETE FROM valopay_merchants WHERE workspace_id=$1", [
      id,
    ]);
    await pool.query("DELETE FROM valopay_workspaces WHERE id=$1", [id]);
  }
  await pool.end();
}
