import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { DomainState, ValopayRecord } from "../src/domain/types";

if (process.env.VALOPAY_RUN_INTEGRATION !== "1") {
  console.log(
    "Set VALOPAY_RUN_INTEGRATION=1 to run connected workflows against a disposable PostgreSQL database.",
  );
  process.exit(0);
}

const { pool } = await import("@workspace/db");
const {
  inWorkspace,
  listMerchants,
  loadState,
  saveState,
  changeRole,
  appendAudit,
  saveIdempotency,
  findIdempotency,
  digest,
  fail,
} = await import("../src/lib/valopay-store");
const { requestFingerprint, verifyAuditChain } = await import("../src/lib/digests");
const {
  connectedRevision,
  connectedActionSchema,
  runConnectedAction,
  connectedView,
} = await import("../src/domain/connected");
const { makeRecord, touch } = await import("../src/domain/records");
const principals = [
  randomBytes(32).toString("hex"),
  randomBytes(32).toString("hex"),
];
const request = (token: string) =>
  ({
    headers: { cookie: `valopay_sandbox=${token}` },
    secure: false,
    auth: Object.assign(() => ({ userId: null }), {
      [Symbol.for("@clerk/express.auth")]: true,
    }),
  }) as any;
const response = () => ({ cookie() {} }) as any;
const read = <T>(
  token: string,
  merchantId: string,
  fn: (state: DomainState) => T,
) =>
  inWorkspace(
    request(token),
    response(),
    async (ctx) => fn(await loadState(ctx, merchantId, "share")),
    "read",
  );
const revision = (token: string, merchantId: string) =>
  read(token, merchantId, connectedRevision);
/** The lender's whole stored audit chain, verified from its first entry: a loaded state does not carry it. */
const storedChainValid = async (merchantId: string) =>
  verifyAuditChain(
    (await pool.query("SELECT data FROM valopay_records WHERE merchant_id=$1 AND kind='audit'", [merchantId])).rows,
  ).valid;
type Input = Parameters<typeof runConnectedAction>[2];
const pendingCommands: Promise<unknown>[] = [];

/** Deliberately uses the real store, revision, domain, audit and replay path used by the HTTP route.
 * No fake SQL layer: both concurrent callers acquire the actual PostgreSQL merchant lock. */
async function dispatch(
  token: string,
  merchantId: string,
  input: Input,
  key = randomUUID(),
) {
  const operation = inWorkspace(request(token), response(), async (ctx) => {
    const state = await loadState(ctx, merchantId, "update");
    const command = connectedActionSchema.parse(input);
    const id = digest(`connected:${merchantId}:${key}`),
      fingerprint = requestFingerprint({ input: command, actor: ctx.actor });
    const prior = await findIdempotency(ctx, id);
    if (prior) {
      if (prior.request_hash !== fingerprint)
        fail("This request key was already used for different input.", 409);
      return prior.response as { recordId?: string; action: string };
    }
    const result = runConnectedAction(state, ctx, command);
    const record =
      result && "record" in result ? result.record : (result as ValopayRecord);
    appendAudit(
      state,
      ctx,
      input.action,
      input.recordId ?? "connected-workspace",
      input.reason,
    );
    await saveState(ctx, state);
    const answer = { recordId: record?.id, action: input.action };
    await saveIdempotency(ctx, id, fingerprint, answer);
    return answer;
  });
  pendingCommands.push(operation);
  void operation.catch(() => {});
  return operation;
}
async function fresh(
  token: string,
  merchantId: string,
  action: string,
  data: Record<string, unknown> = {},
  recordId?: string,
) {
  return dispatch(token, merchantId, {
    action,
    data,
    recordId,
    expectedRevision: await revision(token, merchantId),
    reason: "Verify the persisted synthetic connected workflow",
  });
}
function oneWinner(results: PromiseSettledResult<unknown>[], message: string) {
  assert.equal(
    results.filter((r) => r.status === "fulfilled").length,
    1,
    message,
  );
  const loser = results.find(
    (r) => r.status === "rejected",
  ) as PromiseRejectedResult;
  assert.equal(
    loser.reason.status,
    409,
    "the losing concurrent mutation returns a reviewable conflict",
  );
}

try {
  const [a, b] = principals as [string, string];
  const merchants = await inWorkspace(request(a), response(), listMerchants);
  const foreignMerchants = await inWorkspace(
    request(b),
    response(),
    listMerchants,
  );
  const first = merchants[0]!.id,
    second = merchants[1]!.id,
    foreign = foreignMerchants[0]!.id;
  let customerId = "";
  const dues: string[] = [];
  await inWorkspace(request(a), response(), async (ctx) => {
    const state = await loadState(ctx, first);
    customerId = state.records.find((r) => r.kind === "customers")!.id;
    for (let n = 0; n < 3; n++)
      dues.push(
        makeRecord(state, "due-items", {
          name: `Connected race fixture ${n}`,
          customerId,
          amountKobo: 1_000_000,
          reference: `SYN-CONNECTED-${randomUUID()}`,
          status: "scheduled",
          createdAt: ctx.now,
          data: {
            dueDate: ctx.now.slice(0, 10),
            owner: "valopay",
            outstandingKobo: 1_000_000,
          },
        }).id,
      );
    appendAudit(
      state,
      ctx,
      "test.connected.seed",
      first,
      "Created isolated connected integration fixtures.",
    );
    await saveState(ctx, state);
  });

  // New internal kinds survive a complete write/read transaction and remain a distinct SME entity.
  for (const purpose of [
    "merchant_account_read",
    "erp_draft",
    "payroll_prepare",
  ])
    await fresh(a, first, "consent.grant", { subjectId: "sme", purpose });
  await fresh(a, first, "cash.initialize");
  await fresh(a, first, "cash.forecast", {
    downsideInflowBps: 6000,
    downsideDelayDays: 10,
  });
  await fresh(a, first, "cash.erp.prepare");
  await fresh(a, first, "cash.payroll.prepare");
  await inWorkspace(
    request(a),
    response(),
    async (ctx) => {
      const state = await loadState(ctx, first, "share");
      const cash = connectedView(state, ctx).cash;
      assert.equal(cash.initialised, true);
      assert.equal(cash.scope.legalEntityId, `${first}:sme`);
      assert.equal(cash.forecast.version, "sample-1");
      assert.equal(cash.erpDrafts.length, 1);
      assert.equal(cash.payrollPlans.length, 1);
      assert.equal(
        state.records.filter((r) => r.kind === "connected-cash-workspace")
          .length,
        1,
      );
      assert.ok(
        state.records
          .filter((r) => r.kind.startsWith("connected-cash-"))
          .every(
            (r) => r.data.entityId === `${first}:sme` && r.customerId === "",
          ),
      );
      assert.equal(await storedChainValid(first), true);
    },
    "read",
  );

  // Twenty concurrent identical replays persist exactly one intent and one audit event.
  const sharedKey = randomUUID();
  const createInput: Input = {
    action: "payment.create",
    reason: "Verify a persisted idempotent checkout creation",
    data: { dueItemId: dues[0], amountKobo: 1_000_000 },
    expectedRevision: await revision(a, first),
  };
  const replays = await Promise.all(
    Array.from({ length: 20 }, () =>
      dispatch(a, first, createInput, sharedKey),
    ),
  );
  assert.ok(replays.every((value) => value.recordId === replays[0]!.recordId));
  const intentId = replays[0]!.recordId!;
  await read(a, first, (state) => {
    assert.equal(
      state.records.filter(
        (r) => r.kind === "connected-intents" && r.data.dueItemId === dues[0],
      ).length,
      1,
    );
  });
  assert.equal(
    Number(
      (await pool.query("SELECT count(*) FROM valopay_records WHERE merchant_id=$1 AND kind='audit' AND data->>'action'='payment.create' AND data->>'summary'=$2", [first, createInput.reason])).rows[0].count,
    ),
    1,
  );
  await assert.rejects(
    () =>
      dispatch(
        a,
        first,
        { ...createInput, data: { ...createInput.data, amountKobo: 900_000 } },
        sharedKey,
      ),
    (error: any) => error.status === 409,
  );

  // Different keys with the same captured revision do not create two checkouts.
  const raceRevision = await revision(a, first);
  const competingCreate: Input = {
    action: "payment.create",
    reason: "Two callers compete for one checkout",
    data: { dueItemId: dues[1], amountKobo: 1_000_000 },
    expectedRevision: raceRevision,
  };
  oneWinner(
    await Promise.allSettled([
      dispatch(a, first, competingCreate),
      dispatch(a, first, competingCreate),
    ]),
    "one concurrent checkout creation wins",
  );

  // Checkout authorisation and an external collection cannot both be in flight.
  const authoriseRevision = await revision(a, first);
  oneWinner(
    await Promise.allSettled([
      dispatch(a, first, {
        action: "payment.authorise",
        recordId: intentId,
        data: {},
        reason: "Authorise one sample checkout during a collection race",
        expectedRevision: authoriseRevision,
      }),
      inWorkspace(request(a), response(), async (ctx) => {
        const state = await loadState(ctx, first);
        const due = state.records.find((r) => r.id === dues[0])!;
        makeRecord(state, "attempts", {
          name: "Concurrent provider attempt",
          status: "sent",
          customerId,
          amountKobo: due.amountKobo,
          createdAt: ctx.now,
          data: { dueItemId: due.id, source: "external", owner: "lms" },
        });
        appendAudit(
          state,
          ctx,
          "test.concurrent.provider",
          due.id,
          "Simulated concurrent external attempt.",
        );
        await saveState(ctx, state);
      }),
    ]),
    "authorisation or provider instruction wins, never both",
  );
  await read(a, first, (state) =>
    assert.equal(
      state.records.filter(
        (r) =>
          r.data.dueItemId === dues[0] &&
          ((r.kind === "connected-intents" &&
            ["authorised", "pending", "unknown"].includes(r.status)) ||
            (r.kind === "attempts" &&
              ["scheduled", "sent", "unknown"].includes(r.status))),
      ).length,
      1,
    ),
  );

  // Due-item editing races a captured checkout request: the losing stale caller must refresh.
  const dueRevision = await revision(a, first);
  oneWinner(
    await Promise.allSettled([
      dispatch(a, first, {
        action: "payment.create",
        data: { dueItemId: dues[2], amountKobo: 1_000_000 },
        reason: "Create checkout while the obligation is being edited",
        expectedRevision: dueRevision,
      }),
      inWorkspace(request(a), response(), async (ctx) => {
        const state = await loadState(ctx, first);
        if (connectedRevision(state) !== dueRevision)
          fail(
            "The workspace changed. Refresh before editing this obligation.",
            409,
          );
        const due = state.records.find((r) => r.id === dues[2])!;
        due.amountKobo = 900_000;
        due.data.outstandingKobo = 900_000;
        touch(due, ctx.now);
        appendAudit(
          state,
          ctx,
          "test.concurrent.due",
          due.id,
          "Edited sample obligation after checking its revision.",
        );
        await saveState(ctx, state);
      }),
    ]),
    "one checkout creation or same-version due edit wins",
  );

  // Principal, lender and key scopes are rechecked through real database joins, not client IDs.
  await assert.rejects(
    () => read(b, first, (state) => state),
    (error: any) => error.status === 404,
  );
  await assert.rejects(
    () => read(a, foreign, (state) => state),
    (error: any) => error.status === 404,
  );
  await assert.rejects(
    () => fresh(a, second, "payment.cancel", {}, intentId),
    (error: any) => error.status === 404,
  );
  await assert.rejects(
    () =>
      fresh(a, second, "payment.create", {
        dueItemId: dues[0],
        amountKobo: 1_000_000,
      }),
    (error: any) => error.status === 404,
  );
  await inWorkspace(request(a), response(), async (ctx) => {
    await loadState(ctx, second);
    assert.equal(
      await findIdempotency(ctx, digest(`connected:${first}:${sharedKey}`)),
      undefined,
    );
  });
  await assert.rejects(
    () =>
      inWorkspace(request(a), response(), async (ctx) => {
        const state = await loadState(ctx, second);
        makeRecord(state, "connected-intents", {
          customerId,
          data: { dueItemId: dues[0] },
        });
        await saveState(ctx, state);
      }),
    (error: any) => error.status === 409,
  );

  // Complete a real stored assessment/review and prove both evidence rows are append-only.
  for (const purpose of ["account_read", "credit_assessment"])
    await fresh(a, first, "consent.grant", { subjectId: customerId, purpose });
  const assessmentId = (
    await fresh(a, first, "credit.assess", { customerId, scenario: "ready" })
  ).recordId!;
  const resultBefore = await read(a, first, (state) =>
    structuredClone(
      state.records.find((r) => r.id === assessmentId)!.data.result,
    ),
  );
  assert.equal(resultBefore.state, "review_pending");
  await assert.rejects(
    () =>
      inWorkspace(request(a), response(), async (ctx) => {
        const state = await loadState(ctx, first);
        state.records.find(
          (r) => r.id === assessmentId,
        )!.data.result.score.value = 0;
        await saveState(ctx, state);
      }),
    (error: any) => error.status === 409 && /Saved evidence cannot be changed/.test(error.message),
  );
  await inWorkspace(
    request(a),
    response(),
    (ctx) => changeRole(ctx, "Finance"),
    "persona",
  );
  const reviewId = (
    await fresh(
      a,
      first,
      "credit.review",
      {
        expectedAssessmentVersion: 1,
        outcome: "request_information",
        rationale:
          "Request independently verified supplementary income evidence.",
        applicantExplanation:
          "Please provide the missing independent income evidence for review.",
        reasonCodes: ["ADDITIONAL_INFORMATION"],
      },
      assessmentId,
    )
  ).recordId!;
  await assert.rejects(
    () =>
      inWorkspace(request(a), response(), async (ctx) => {
        const state = await loadState(ctx, first);
        state.records.find((r) => r.id === reviewId)!.data.review.rationale =
          "Changed old decision";
        await saveState(ctx, state);
      }),
    (error: any) => error.status === 409 && /Saved evidence cannot be changed/.test(error.message),
  );
  await assert.rejects(
    () =>
      inWorkspace(request(a), response(), async (ctx) => {
        const state = await loadState(ctx, first);
        state.records = state.records.filter((r) => r.id !== assessmentId);
        await saveState(ctx, state);
      }),
    (error: any) => error.status === 409,
  );
  await read(a, first, (state) => {
    assert.deepEqual(
      state.records.find((r) => r.id === assessmentId)!.data.result,
      resultBefore,
    );
    assert.ok(state.records.find((r) => r.id === reviewId));
  });
  assert.equal(await storedChainValid(first), true);
  // Every load has the closes more than a week older than the latest as
  // summaries, a view's as an action's: the revision a view gave is still the
  // one its action computes (the 23 September audit).
  await inWorkspace(request(a), response(), (ctx) => changeRole(ctx, "Admin"), "persona");
  await inWorkspace(request(a), response(), async (ctx) => {
    const state = await loadState(ctx, second);
    for (const days of [9, 0])
      makeRecord(state, "closes" as string, {
        name: `Connected revision close ${days}`,
        status: "completed",
        createdAt: new Date(Date.parse(ctx.now) - days * 86_400_000).toISOString(),
        data: {
          summary: "Synthetic close a week apart",
          report: { unallocated: { count: 0 }, exceptions: { opened: { count: 0 } } },
          operational: { note: "Left out of a write's summary" },
          metrics: [],
        },
      });
    appendAudit(state, ctx, "test.connected.closes", second, "Added closes a week apart.");
    await saveState(ctx, state);
  });
  assert.ok(
    (await fresh(a, second, "consent.grant", { subjectId: "sme", purpose: "merchant_account_read" })).recordId,
    "an action sent with its view's revision is applied although older closes load as summaries",
  );
  console.log(
    "Connected PostgreSQL workflows passed: persistence, 20-way replay, checkout/collection and due-edit races, principal/lender isolation, immutable credit evidence, audit and the revision across summarised closes.",
  );
} finally {
  // A failed replay assertion must not race fixture cleanup against another still-running command.
  await Promise.allSettled(pendingCommands);
  const hashes = principals.map((token) => digest(`demo:${token}`));
  for (const table of ["valopay_idempotency", "valopay_records"])
    await pool.query(
      `DELETE FROM ${table} WHERE merchant_id IN (SELECT m.id FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id WHERE w.principal_hash=ANY($1::text[]))`,
      [hashes],
    );
  await pool.query(
    "DELETE FROM valopay_merchants WHERE workspace_id IN (SELECT id FROM valopay_workspaces WHERE principal_hash=ANY($1::text[]))",
    [hashes],
  );
  await pool.query(
    "DELETE FROM valopay_workspaces WHERE principal_hash=ANY($1::text[])",
    [hashes],
  );
  await pool.end();
}
