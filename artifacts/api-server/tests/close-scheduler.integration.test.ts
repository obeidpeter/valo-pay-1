// Database-backed test for the scheduled daily close runner (REC-01): it closes
// only due lenders, each in its own system transaction through the scoped
// repository; skips a lender locked by a request in flight; isolates one
// lender's failure from the others and backs off before retrying it, never
// waiting for a lender held elsewhere to record the failure; drains batches
// until nothing is due, sharing each batch across workspaces and putting
// lenders being retried after the rest; catches up a lender's missed business
// dates one close per pass, oldest first; pauses an idle anonymous sandbox
// instead of closing it; stops between lenders when told to; gives legacy
// lenders a cursor without a close; runs once, as the one-shot close pass,
// with an exit status; counts public anonymous sandboxes, and only those,
// apart from the lenders; reads what is still owed on a web instance whose
// closes a scheduled job runs; and its audit entries never keep an abandoned
// sandbox alive. Every pass is scoped to this test's own lenders, so other due
// lenders in a reused database never crowd them out.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

if (process.env.VALOPAY_RUN_INTEGRATION !== "1") {
  console.log("Set VALOPAY_RUN_INTEGRATION=1 to run the scheduler integration test.");
  process.exit(0);
}

const { pool } = await import("@workspace/db");
const { nextCloseInstant } = await import("@workspace/valopay-schema");
const { SYSTEM_ACTOR_PREFIX, appendAudit, createPilotLender, dueScheduledCloses, inWorkspace, listMerchants, loadState, provisionStaffWorkspace, recordScheduledCloseFailure, saveState, scheduledCloseBacklog } = await import("../src/lib/valopay-store.js");
const { SCHEDULED_CLOSE_ACTOR, markSchedulerOff, runClosePassOnce, runDueCloses, startCloseScheduler, schedulerStatus } = await import("../src/lib/close-scheduler.js");
const { followingCloseInstant, scheduledCloseBusinessDate } = await import("../src/domain/close.js");
const { makeRecord } = await import("../src/domain/records.js");

const requestFor = (token: string) => ({ headers: { cookie: `valopay_sandbox=${token}` }, secure: false, auth: Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true }) }) as any;
const response = () => ({ cookie() { /* a valid test cookie is already supplied */ } }) as any;
const token = () => randomBytes(32).toString("hex");
const setCursor = (merchantId: string, at: string) => pool.query("UPDATE valopay_merchants SET settings = settings || jsonb_build_object('nextCloseAt', $2::text) WHERE id=$1", [merchantId, at]);
const cursorOf = async (merchantId: string): Promise<string | null> => (await pool.query<{ cursor: string | null }>("SELECT settings->>'nextCloseAt' AS cursor FROM valopay_merchants WHERE id=$1", [merchantId])).rows[0]!.cursor;
const closesOf = async (merchantId: string) => (await pool.query<{ id: string; data: Record<string, any> }>("SELECT id,data FROM valopay_records WHERE merchant_id=$1 AND kind='closes' ORDER BY created_at", [merchantId])).rows;
const closedIds = (run: Awaited<ReturnType<typeof runDueCloses>>) => run.closed.map((item) => item.merchantId);
const dueIds = async (...args: Parameters<typeof dueScheduledCloses>) => (await dueScheduledCloses(...args)).map((row) => row.id);
const settingsOf = async (merchantId: string): Promise<Record<string, any>> => (await pool.query<{ settings: Record<string, any> }>("SELECT settings FROM valopay_merchants WHERE id=$1", [merchantId])).rows[0]!.settings;
const databaseNow = async () => Date.parse((await pool.query<{ now: Date }>("SELECT now() AS now")).rows[0]!.now.toISOString());
const hoursAgo = (now: number, hours: number) => new Date(now - hours * 60 * 60 * 1000).toISOString();
/** A new sandbox's two lenders, sorted by id.  Each comes from its own address, so the per-address creation limit is left for the expiry check below. */
let addresses = 0;
const sandboxLenders = async (sandboxToken = token()): Promise<[string, string]> => {
  let ids: string[] = [];
  await inWorkspace(Object.assign(requestFor(sandboxToken), { ip: `10.14.0.${(addresses += 1)}` }), response(), async (context) => { ids = (await listMerchants(context)).map((merchant) => merchant.id).sort(); });
  return ids as [string, string];
};
/** A signed-in person's request: outside staff mode they get a workspace of their own, seeded as a sandbox is but not public. */
const signedInRequest = (userId: string) => ({ headers: {}, secure: false, auth: Object.assign(() => ({ userId, tokenType: "session_token" }), { [Symbol.for("@clerk/express.auth")]: true }) }) as any;
/** A new signed-in person's two lenders, sorted by id: lenders, not public anonymous sandboxes. */
const signedInLenders = async (userId = `user_synthetic_${randomBytes(8).toString("hex")}`): Promise<[string, string]> => {
  let ids: string[] = [];
  await inWorkspace(signedInRequest(userId), response(), async (context) => { ids = (await listMerchants(context)).map((merchant) => merchant.id).sort(); });
  return ids as [string, string];
};
/** Makes the lender's first instalment unsaveable, so its close fails until the stored value is put back. */
const breakLender = async (merchantId: string) => {
  const due = (await pool.query<{ id: string; data: Record<string, any> }>("SELECT id,data FROM valopay_records WHERE merchant_id=$1 AND kind='due-items' ORDER BY created_at LIMIT 1", [merchantId])).rows[0]!;
  await pool.query(`UPDATE valopay_records SET data = data || '{"outstandingKobo": 9007199254740000}' WHERE id=$1`, [due.id]);
  return due;
};
/** Moves a recorded retry's next attempt into the past, as if its wait had passed. */
const retryNow = async (merchantId: string) => pool.query("UPDATE valopay_merchants SET settings = jsonb_set(settings, '{closeRetry,retryAt}', to_jsonb($2::text)) WHERE id=$1", [merchantId, new Date((await databaseNow()) - 1000).toISOString()]);
/**
 * Runs `pass` while another connection, as a request would, takes the lender's
 * row at the moment the failure recorder is about to read it, after the failed
 * close rolled back.  The recorder's read is recognised by its text; the row
 * is released when the pass ends.
 */
const takenBeforeRecording = async <T>(merchantId: string, pass: () => Promise<T>): Promise<T> => {
  const holder = await pool.connect();
  const clients = Object.getPrototypeOf(holder) as { query: (this: unknown, ...args: unknown[]) => Promise<unknown> };
  const query = clients.query;
  let taken = false;
  clients.query = async function (this: unknown, ...args: unknown[]) {
    if (!taken && typeof args[0] === "string" && args[0].startsWith("SELECT settings, now() AS now FROM valopay_merchants")) {
      taken = true;
      await query.call(holder, "BEGIN");
      await query.call(holder, "SELECT 1 FROM valopay_merchants WHERE id=$1 FOR UPDATE", [merchantId]);
    }
    return query.apply(this, args);
  };
  try {
    const result = await pass();
    assert.ok(taken, "the failure recorder read the lender");
    return result;
  } finally {
    clients.query = query;
    if (taken) await holder.query("ROLLBACK");
    holder.release();
  }
};

try {
  const sandbox = token();
  let merchants: string[] = [];
  await inWorkspace(requestFor(sandbox), response(), async (context) => { merchants = (await listMerchants(context)).map((merchant) => merchant.id).sort(); });
  const [a, b] = merchants as [string, string];
  const dbNow = (await pool.query<{ now: Date }>("SELECT now() AS now")).rows[0]!.now.toISOString();

  // A fresh sandbox: both lenders carry a cursor at the next 07:00 WAT after the database clock.
  const seeded = (await cursorOf(a))!;
  assert.ok(seeded > dbNow, "the seeded cursor is in the future");
  assert.equal(new Date(seeded).getUTCHours(), 6, "07:00 WAT is 06:00 UTC");
  assert.equal(new Date(seeded).getUTCMinutes(), 0);
  assert.ok(Date.parse(seeded) - Date.parse(dbNow) <= 24 * 60 * 60 * 1000, "within a day");
  const only = merchants;
  const idle = await runDueCloses({ batchSize: 100, onlyMerchantIds: only });
  assert.equal(closedIds(idle).some((id) => merchants.includes(id)), false, "nothing is due yet");
  assert.equal(idle.examined, 0); assert.deepEqual(idle.paused, [], "a new sandbox is never paused");

  // Lender A became due an hour ago (the platform was down): it is closed late; B is left alone.
  const dueAt = new Date(Date.parse(dbNow) - 60 * 60 * 1000).toISOString();
  await setCursor(a, dueAt);
  // An exception left open on a payment already allocated in full: the close clears it, and its audit entry says so (the review of the audit fixes).
  let settledException = "";
  await inWorkspace(requestFor(sandbox), response(), async (context) => {
    const state = await loadState(context, a, "update");
    const allocated = state.records.find((record) => record.kind === "payments" && record.reference === "SBX-PAY-1001")!;
    settledException = makeRecord(state, "exceptions", { name: "Unallocated payment", status: "open", customerId: allocated.customerId, amountKobo: allocated.amountKobo, createdAt: context.now, data: { type: "unallocated_payment", severity: "medium", owner: "Finance", notes: "Raised before the payment was allocated.", linkedRecordId: allocated.id } }).id;
    appendAudit(state, context, "post.records.exceptions", settledException, "Synthetic workspace operation");
    await saveState(context, state);
  });
  const run = await runDueCloses({ batchSize: 100, onlyMerchantIds: only });
  const closedA = run.closed.find((item) => item.merchantId === a);
  assert.ok(closedA, "the due lender is closed");
  assert.equal(closedIds(run).includes(b), false, "the lender whose time has not come is not");
  assert.equal(closedA.late, true);
  assert.ok((closedA.delayMinutes ?? 0) >= 60);
  await inWorkspace(requestFor(sandbox), response(), async (context) => {
    const state = await loadState(context, a, "share");
    const closes = state.records.filter((record) => record.kind === "closes");
    assert.equal(closes.length, 1);
    assert.equal(closes[0]!.id, closedA.closeId);
    assert.equal(closes[0]!.data.schedule.trigger, "scheduled");
    assert.equal(closes[0]!.data.schedule.scheduledFor, dueAt);
    assert.equal(closes[0]!.data.schedule.late, true);
    // The audit chain is not part of a loaded state: its head is read from the lender's records.
    const audit = (await pool.query<{ name: string; data: Record<string, any> }>("SELECT name,data FROM valopay_records WHERE merchant_id=$1 AND kind='audit' ORDER BY (data->>'sequence')::int DESC LIMIT 1", [a])).rows[0]!;
    assert.equal(audit.data.actor, SCHEDULED_CLOSE_ACTOR);
    assert.equal(audit.name, "daily_close");
    assert.equal(audit.data.objectId, closedA.closeId);
    const cleared = state.records.find((record) => record.id === settledException)!;
    assert.deepEqual([cleared.status, cleared.data.resolutionCode], ["closed", "condition_cleared"], "the scheduled close closed the exception whose condition cleared");
    assert.match(String(audit.data.summary), /^Scheduled daily close of \d{4}-\d{2}-\d{2} completed.* Closed 1 exception whose condition cleared \(unallocated payment: payment SBX-PAY-1001 is allocated in full\)\.$/, `the scheduled close's audit entry names it: ${audit.data.summary}`);
    assert.equal(state.settings.nextCloseAt, followingCloseInstant(dueAt, "07:00"), "the cursor moved one business date on, to 07:00 WAT the day after the time it covered");
    assert.ok(String(state.settings.nextCloseAt) > dbNow);
  });
  const again = await runDueCloses({ batchSize: 100, onlyMerchantIds: only });
  assert.equal(closedIds(again).includes(a), false, "a second pass finds nothing due for the closed lender");

  // A lender locked by a request in flight is skipped, never queued behind.
  await setCursor(b, dueAt);
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM valopay_merchants WHERE id=$1 FOR UPDATE", [b]);
    const skipped = await runDueCloses({ batchSize: 100, onlyMerchantIds: only });
    assert.ok(skipped.skipped.includes(b), "the locked lender is skipped");
    assert.equal(closedIds(skipped).includes(b), false);
    await holder.query("ROLLBACK");
  } finally {
    holder.release();
  }
  assert.equal((await closesOf(b)).length, 0, "no close was written for the locked lender");

  // The automatic close switched off: the lender is not even examined.
  await pool.query(`UPDATE valopay_merchants SET settings = settings || '{"scheduledCloseEnabled": false}' WHERE id=$1`, [b]);
  const off = await runDueCloses({ batchSize: 100, onlyMerchantIds: only });
  assert.equal(closedIds(off).includes(b), false);
  assert.equal(off.skipped.includes(b), false);
  await pool.query(`UPDATE valopay_merchants SET settings = settings || '{"scheduledCloseEnabled": true}' WHERE id=$1`, [b]);

  // One lender's failure does not stop the others: B's state is made unsaveable, both are due.
  await setCursor(a, dueAt);
  const brokenDue = await breakLender(b);
  const mixed = await runDueCloses({ batchSize: 100, onlyMerchantIds: only });
  assert.ok(closedIds(mixed).includes(a), "the healthy lender is closed");
  const failure = mixed.failed.find((item) => item.merchantId === b);
  assert.ok(failure, "the broken lender is reported");
  assert.match(failure.error, /exceeds the supported safe-integer minor-unit range/);
  assert.equal((await closesOf(b)).length, 0, "nothing of the failed close was committed");
  // The failure is recorded on the lender for this close time, with a two-minute wait before the next attempt.
  assert.equal(failure.failures, 1);
  const failedAt = await databaseNow();
  assert.ok(Math.abs(Date.parse(failure.retryAt!) - (failedAt + 2 * 60 * 1000)) <= 5000, "the next attempt is two minutes after the failure");
  const recorded = (await settingsOf(b)).closeRetry;
  assert.equal(recorded.cursor, dueAt); assert.equal(recorded.failures, 1); assert.equal(recorded.retryAt, failure.retryAt);
  assert.equal(JSON.stringify(recorded).includes("Outstanding"), false, "the error text stays in the log, not in the lender's settings");
  assert.equal(await cursorOf(b), dueAt, "the close stays pending at its time");
  const waiting = await runDueCloses({ batchSize: 100, onlyMerchantIds: only });
  assert.equal([...closedIds(waiting), ...waiting.failed.map((item) => item.merchantId), ...waiting.skipped].includes(b), false, "a pass inside the wait does not try the lender again");
  // The failure recorder never waits for a request or another instance holding the lender: it records nothing and
  // answers at once, well inside the five-second lock limit it would otherwise wait out.
  const recorderHolder = await pool.connect();
  try {
    await recorderHolder.query("BEGIN");
    await recorderHolder.query("SELECT 1 FROM valopay_merchants WHERE id=$1 FOR UPDATE", [b]);
    const asked = Date.now();
    assert.equal(await recordScheduledCloseFailure(b), undefined, "nothing is recorded for a locked lender");
    assert.ok(Date.now() - asked < 2500, "the recorder does not wait for the lock");
    await recorderHolder.query("ROLLBACK");
  } finally {
    recorderHolder.release();
  }
  assert.deepEqual((await settingsOf(b)).closeRetry, recorded, "the retry is unchanged");
  // Taken by a request just after its close failed, the lender gets no backoff and is left out of the rest of the pass.
  await retryNow(b);
  const beforeLocked = (await settingsOf(b)).closeRetry;
  const locked = await takenBeforeRecording(b, () => runDueCloses({ batchSize: 1, onlyMerchantIds: [b] }));
  assert.deepEqual(locked.failed.map((item) => [item.merchantId, item.failures, item.retryAt]), [[b, undefined, undefined]], "the failure is reported but not recorded");
  assert.deepEqual(locked.skipped, [], "the pass does not try the lender again");
  assert.equal(locked.batches, 2, "a full batch of one, then nothing left");
  assert.deepEqual((await settingsOf(b)).closeRetry, beforeLocked, "no backoff was recorded");
  await pool.query("UPDATE valopay_records SET data = $2 WHERE id=$1", [brokenDue.id, brokenDue.data]);
  await retryNow(b);
  const repaired = await runDueCloses({ batchSize: 100, onlyMerchantIds: only });
  assert.ok(closedIds(repaired).includes(b), "once repaired the lender closes when its wait is over");
  assert.equal((await closesOf(b)).length, 1);
  assert.equal((await settingsOf(b)).closeRetry, undefined, "the close clears the retry");

  // A lender from before the scheduler carries no cursor: it gets the next configured time, without a close.
  await pool.query("UPDATE valopay_merchants SET settings = settings - 'nextCloseAt' WHERE id=$1", [b]);
  assert.equal(await cursorOf(b), null);
  const initialised = await runDueCloses({ batchSize: 100, onlyMerchantIds: only });
  assert.ok(initialised.initialised >= 1);
  const cursorB = (await cursorOf(b))!;
  assert.ok(cursorB > dbNow, "the new cursor is the next 07:00 WAT");
  assert.equal(new Date(cursorB).getUTCHours(), 6);
  assert.equal(closedIds(initialised).includes(b), false, "initialisation never closes");
  assert.equal((await closesOf(b)).length, 1);

  // The tick loop: two ticks at once share one pass.
  const scheduler = startCloseScheduler({ intervalMs: 60_000, firstDelayMs: 60_000, batchSize: 100, onlyMerchantIds: only });
  try {
    assert.equal(schedulerStatus().state, "running");
    assert.equal(schedulerStatus().lastSuccessAt, null, "starting the timer is not a successful service check");
    const [first, second] = await Promise.all([scheduler.tick(), scheduler.tick()]);
    assert.ok(first);
    assert.equal(first, second, "a tick while a pass runs joins that pass");
    const healthy = schedulerStatus();
    assert.ok(healthy.lastTickAt && healthy.lastSuccessAt, "a returning pass records its check start and success");
    assert.equal(healthy.lastErrorAt, null);
    assert.ok(Date.parse(healthy.observedAt) >= Date.parse(healthy.lastSuccessAt));

    // Fail the scan before any lender transaction (the scan checks out a connection
    // for its bounded transaction). The last success stays historical, and a later
    // healthy pass must clear the error rather than keep a false outage.
    const originalConnect = pool.connect;
    try {
      pool.connect = (() => Promise.reject(new Error("Injected scheduler scan failure"))) as typeof pool.connect;
      assert.equal(await scheduler.tick(), null);
      const failed = schedulerStatus();
      assert.equal(failed.lastSuccessAt, healthy.lastSuccessAt);
      assert.ok(failed.lastErrorAt, "a failed scan has a failure timestamp");
      assert.ok(Date.parse(failed.lastErrorAt) >= Date.parse(healthy.lastSuccessAt));
    } finally {
      pool.connect = originalConnect;
    }
    assert.ok(await scheduler.tick());
    assert.equal(schedulerStatus().lastErrorAt, null, "a returning pass clears the service-level error");
    assert.ok(schedulerStatus().lastSuccessAt);
  } finally {
    scheduler.stop();
  }
  assert.equal(schedulerStatus().state, "stopped", "stop cannot retain a running status");

  // Failing lenders never hold back a healthy one: the pass reads batch after batch until nothing is due,
  // and each failure waits longer before its next attempt: 2, 4, 8, 16 minutes.
  const [p1, p2] = await sandboxLenders(), [q1, q2] = await sandboxLenders();
  const broken = [p1, p2, q1], drainOnly = [p1, p2, q1, q2];
  let clock = await databaseNow();
  for (const id of broken) { await setCursor(id, hoursAgo(clock, 3)); await breakLender(id); }
  await setCursor(q2, hoursAgo(clock, 1));
  const drained = await runDueCloses({ batchSize: 2, onlyMerchantIds: drainOnly });
  assert.deepEqual(closedIds(drained), [q2], "the healthy lender is closed in the same pass");
  assert.ok(drained.batches >= 2, "the pass read more than one batch");
  assert.deepEqual(drained.failed.map((item) => item.merchantId).sort(), [...broken].sort());
  assert.ok(drained.failed.every((item) => item.failures === 1));
  assert.equal((await runDueCloses({ batchSize: 2, onlyMerchantIds: drainOnly })).examined, 0, "failed lenders wait for their retry time");
  for (const expected of [2, 3, 4]) {
    for (const id of broken) await retryNow(id);
    const retried = await runDueCloses({ batchSize: 2, onlyMerchantIds: broken });
    assert.equal(retried.failed.length, 3);
    for (const id of broken) {
      const retry = (await settingsOf(id)).closeRetry;
      assert.equal(retry.failures, expected);
      assert.equal((Date.parse(retry.retryAt) - Date.parse(retry.lastFailedAt)) / 60_000, 2 ** expected, `failure ${expected} waits ${2 ** expected} minutes`);
    }
  }
  for (const id of broken) await pool.query(`UPDATE valopay_merchants SET settings = settings || '{"scheduledCloseEnabled": false}' WHERE id=$1`, [id]);

  // Batches are shared across workspaces: one lender per workspace per turn, then the earliest time,
  // and a staff or signed-in lender before any anonymous sandbox.
  const [x1, x2] = await sandboxLenders(), [y1] = await sandboxLenders(), [s1] = await sandboxLenders();
  clock = await databaseNow();
  await setCursor(x1, hoursAgo(clock, 5)); await setCursor(x2, hoursAgo(clock, 5)); await setCursor(y1, hoursAgo(clock, 1));
  const shared = await dueIds(2, { only: [x1, x2, y1] });
  assert.equal(shared.length, 2);
  assert.ok(shared.includes(y1), "the other workspace's lender is in the batch");
  assert.equal(shared.filter((id) => id === x1 || id === x2).length, 1, "one lender from the workspace with two earlier ones");
  assert.deepEqual((await dueScheduledCloses(2, { only: [x1, x2, y1], exclude: [y1] })).map((row) => [row.id, row.publicSandbox]).sort(), [[x1, true], [x2, true]].sort(), "an excluded lender is left out, and each read says it is a public sandbox's");
  await pool.query(`UPDATE valopay_merchants SET settings = settings || '{"anonymousWorkspace": false}' WHERE id=$1`, [s1]);
  await setCursor(s1, new Date(clock - 30 * 60 * 1000).toISOString());
  assert.deepEqual(await dueScheduledCloses(1, { only: [x1, x2, y1, s1] }), [{ id: s1, publicSandbox: false }], "a signed-in lender comes first, and is not a public sandbox");
  const fair = await runDueCloses({ batchSize: 1, onlyMerchantIds: [x1, x2, y1, s1] });
  assert.deepEqual(closedIds(fair).sort(), [x1, x2, y1, s1].sort(), "a pass drains every due lender");
  assert.equal(closedIds(fair)[0], s1); assert.equal(fair.batches, 5, "four full batches of one and a last empty one");

  // A lender owed several missed business dates gets one catch-up close per pass, the oldest date first, even when
  // full batches would read it again: the others due are not held back behind its backlog.
  const [k1, k2] = await sandboxLenders();
  clock = await databaseNow();
  const owedFrom = nextCloseInstant(clock - 96 * 60 * 60 * 1000, "07:00"); // four scheduled times have passed since
  await setCursor(k1, owedFrom); await setCursor(k2, hoursAgo(clock, 1));
  assert.deepEqual(closedIds(await runDueCloses({ batchSize: 1, onlyMerchantIds: [k1, k2] })), [k1, k2], "each due lender is closed once in the pass");
  assert.equal(await cursorOf(k1), followingCloseInstant(owedFrom, "07:00"), "one business date on");
  for (let pass = 2; pass <= 4; pass += 1) assert.deepEqual(closedIds(await runDueCloses({ batchSize: 1, onlyMerchantIds: [k1, k2] })), [k1], `pass ${pass} closes the next owed date`);
  assert.equal((await runDueCloses({ batchSize: 1, onlyMerchantIds: [k1, k2] })).examined, 0, "caught up");
  assert.deepEqual((await closesOf(k1)).map((close) => close.data.sourceBusinessDate), [0, 1, 2, 3].map((day) => scheduledCloseBusinessDate(new Date(Date.parse(owedFrom) + day * 24 * 60 * 60 * 1000).toISOString())), "one close per missed business date, oldest first");

  // Within staff and signed-in lenders, and within anonymous sandboxes, lenders being retried come after the rest,
  // and a workspace's lender being retried takes its last turn, not its first.
  const [r1, r2] = await sandboxLenders(), [h1] = await sandboxLenders(), [g1] = await sandboxLenders();
  clock = await databaseNow();
  /** A retry for the lender's pending time whose wait is over: it is due again, but still being retried. */
  const retrying = async (merchantId: string, at: string) => {
    await setCursor(merchantId, at);
    await pool.query(
      "UPDATE valopay_merchants SET settings = settings || jsonb_build_object('closeRetry', jsonb_build_object('cursor', $2::text, 'failures', 1, 'retryAt', $3::text, 'lastFailedAt', $4::text)) WHERE id=$1",
      [merchantId, at, new Date(clock - 60 * 1000).toISOString(), new Date(clock - 3 * 60 * 1000).toISOString()],
    );
  };
  await retrying(r1, hoursAgo(clock, 5)); await setCursor(r2, hoursAgo(clock, 4)); await setCursor(h1, hoursAgo(clock, 1));
  assert.deepEqual(await dueIds(1, { only: [r1, h1] }), [h1], "a healthy lender comes before an earlier one being retried");
  assert.deepEqual(await dueIds(3, { only: [r1, r2, h1] }), [r2, h1, r1], "the lender being retried does not take its workspace's first turn");
  await pool.query(`UPDATE valopay_merchants SET settings = settings || '{"anonymousWorkspace": false}' WHERE id=$1`, [g1]);
  await retrying(g1, hoursAgo(clock, 1));
  assert.deepEqual(await dueIds(1, { only: [g1, r2, h1] }), [g1], "a signed-in lender being retried still comes before a healthy anonymous sandbox");
  const retriedLast = await runDueCloses({ batchSize: 1, onlyMerchantIds: [r1, r2, h1, g1] });
  assert.deepEqual(closedIds(retriedLast), [g1, r2, h1, r1], "a pass closes them in that order");

  // An anonymous sandbox nobody has changed for a week is paused, not closed; one a person changed is closed.
  const [z1, z2] = await sandboxLenders(), wToken = token(), [w1, w2] = await sandboxLenders(wToken);
  const workspaceOf = async (merchantId: string) => (await pool.query<{ workspace_id: string }>("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [merchantId])).rows[0]!.workspace_id;
  for (const id of [z1, w1]) await pool.query("UPDATE valopay_workspaces SET created_at = now() - interval '10 days' WHERE id=$1", [await workspaceOf(id)]);
  await inWorkspace(requestFor(wToken), response(), async (context) => {
    const state = await loadState(context, w2, "update");
    appendAudit(state, context, "test.change", "workspace", "A change by a person");
    await saveState(context, state);
  });
  clock = await databaseNow();
  for (const id of [z1, z2, w1, w2]) await setCursor(id, hoursAgo(clock, 1));
  const idleRun = await runDueCloses({ onlyMerchantIds: [z1, z2, w1, w2] });
  assert.deepEqual([...idleRun.paused].sort(), [z1, z2].sort(), "both lenders of the idle sandbox are paused");
  assert.deepEqual(closedIds(idleRun).sort(), [w1, w2].sort(), "the sandbox a person changed is closed");
  for (const id of [z1, z2]) {
    assert.equal((await closesOf(id)).length, 0, "an idle sandbox is not closed");
    const settings = await settingsOf(id);
    assert.equal(settings.scheduledCloseEnabled, false);
    assert.ok(Date.parse(settings.closePausedForInactivityAt) >= clock, "the pause is recorded");
    const audit = (await pool.query<{ name: string; data: Record<string, any> }>("SELECT name,data FROM valopay_records WHERE merchant_id=$1 AND kind='audit' ORDER BY (data->>'sequence')::int DESC LIMIT 1", [id])).rows[0]!;
    assert.equal(audit.name, "daily_close.paused"); assert.equal(audit.data.actor, SCHEDULED_CLOSE_ACTOR);
  }
  assert.equal((await runDueCloses({ onlyMerchantIds: [z1, z2] })).examined, 0, "a paused close is not due");

  // A stop ends the pass between lenders; the rest stay due for the next start.
  const [t1, t2] = await sandboxLenders();
  clock = await databaseNow();
  const stopAt = hoursAgo(clock, 1);
  await setCursor(t1, stopAt); await setCursor(t2, stopAt);
  const outOfTime = await runDueCloses({ onlyMerchantIds: [t1, t2], budgetMs: 0 });
  assert.equal(outOfTime.examined, 0, "a pass whose budget is spent starts no close");
  assert.deepEqual([outOfTime.budgetSpent, outOfTime.budgetSpentOnSandboxes], [false, true], "and records that its budget ended it with public sandboxes, which it takes up last, still due");
  const aborted = new AbortController();
  aborted.abort();
  const none = await runDueCloses({ onlyMerchantIds: [t1, t2], signal: aborted.signal });
  assert.equal(none.closed.length, 0, "a pass told to stop before it starts closes nothing");
  assert.equal(none.budgetSpent, false, "a stop is not the budget");
  assert.equal(await cursorOf(t1), stopAt); assert.equal(await cursorOf(t2), stopAt);
  const halfway = new AbortController();
  const stopAfterFirst = { child: () => ({ info: (_fields: unknown, message: string) => { if (message === "scheduled daily close completed") halfway.abort(); }, error() {}, debug() {} }) } as any;
  const partial = await runDueCloses({ onlyMerchantIds: [t1, t2], signal: halfway.signal, log: stopAfterFirst });
  assert.equal(partial.closed.length, 1, "the lender in progress finishes and the next is not started");
  const [finished, left] = partial.closed[0]!.merchantId === t1 ? [t1, t2] : [t2, t1];
  assert.notEqual(await cursorOf(finished), stopAt);
  assert.equal(await cursorOf(left), stopAt, "the other lender is still due");
  const stopping = startCloseScheduler({ intervalMs: 60_000, firstDelayMs: 60_000, onlyMerchantIds: [left] });
  const pass = stopping.tick();
  stopping.stop();
  await stopping.settle();
  assert.equal((await pass)!.closed.length, 0, "stop ends a pass that has not reached a lender");
  assert.equal(await cursorOf(left), stopAt);
  assert.deepEqual(closedIds(await runDueCloses({ onlyMerchantIds: [left] })), [left], "the next pass closes it");

  // The one-shot pass (close-pass.ts), which a host without an in-process scheduler runs on a schedule: the same
  // pass and the same scheduled closes, exit 2 when its budget ran out with lenders still due and while a close
  // failed and is waiting for its retry, then 0. A signed-in person's lenders: public sandboxes' are counted apart (below).
  const [o1, o2] = await signedInLenders();
  clock = await databaseNow();
  const oneShotDue = hoursAgo(clock, 1);
  await setCursor(o1, oneShotDue); await setCursor(o2, oneShotDue);
  const oneShotLines: Array<Record<string, any>> = [];
  const oneShotLog: any = { info: (fields: object) => oneShotLines.push(fields), error: (fields: object) => oneShotLines.push(fields), debug() {}, child: () => oneShotLog };
  const spentFirst = await runClosePassOnce({ onlyMerchantIds: [o1, o2], log: oneShotLog, budgetMs: 0 });
  assert.deepEqual([spentFirst.exitCode, spentFirst.run!.budgetSpent, spentFirst.run!.examined], [2, true, 0], "a pass its budget ended before two due lenders is not a success");
  assert.deepEqual([await cursorOf(o1), await cursorOf(o2)], [oneShotDue, oneShotDue], "both are still due for the next run");
  const brokenOnce = await breakLender(o2);
  const withFailure = await runClosePassOnce({ onlyMerchantIds: [o1, o2], log: oneShotLog });
  assert.equal(withFailure.run!.budgetSpent, false, "a pass that took up every due lender did not run out of time");
  assert.equal(withFailure.exitCode, 2, "a failed close makes the scheduled run fail");
  assert.deepEqual(closedIds(withFailure.run!), [o1], "the healthy lender is closed");
  assert.deepEqual(withFailure.run!.failed.map((item) => [item.merchantId, item.failures]), [[o2, 1]], "the failure is recorded for its retry");
  const oneShotClose = (await closesOf(o1))[0]!;
  assert.equal(oneShotClose.data.schedule.trigger, "scheduled", "a one-shot close is a scheduled close");
  assert.equal(oneShotClose.data.schedule.late, true);
  // The next run, inside the failed lender's wait, tries nothing, but the close is still failing: that run fails too.
  const waitingRun = await runClosePassOnce({ onlyMerchantIds: [o1, o2], log: oneShotLog });
  assert.deepEqual([waitingRun.exitCode, waitingRun.run!.examined, waitingRun.run!.failed.length], [2, 0, 0], "a run that tried nothing still fails while a lender's close is failing");
  await pool.query("UPDATE valopay_records SET data = $2 WHERE id=$1", [brokenOnce.id, brokenOnce.data]);
  await retryNow(o2);
  const afterRetry = await runClosePassOnce({ onlyMerchantIds: [o1, o2], log: oneShotLog });
  assert.equal(afterRetry.exitCode, 0);
  assert.deepEqual(closedIds(afterRetry.run!), [o2]);
  assert.deepEqual(oneShotLines.filter((line) => line.event === "close.one_shot").map((line) => [line.exitCode, line.budgetSpent, line.failing]), [[2, true, 0], [2, false, 1], [2, false, 1], [0, false, 0]], "one close.one_shot line a run, with its exit status, whether the budget ended it and the lenders still failing");

  // A lender whose close fails stays visible until its own close succeeds, whatever other lenders' passes do and
  // across a restart (K): each pass reads what is still owed from the database, the health answer carries it without
  // naming a lender, and the monitor raises it. A close more than 30 minutes past its time is overdue, whoever holds it.
  const { probeService } = await import(new URL("../../../scripts/monitor-valopay.mjs", import.meta.url).href);
  const { HealthCheckResponse } = await import("@workspace/api-zod");
  const { contractAnswer } = await import("../src/lib/contract.js");
  /** The health answer /api/healthz gives with this scheduler status, from a process up for ten minutes unless said, and the monitor's probe of it, or its codes alone. */
  const healthAnswer = (scheduler: unknown, uptimeSeconds = 600) => contractAnswer(HealthCheckResponse, { status: "ok", build: "test", startedAt: new Date().toISOString(), uptimeSeconds, scheduler });
  const readyAnswer = { status: "ok", build: "test", checks: { database: { status: "ok", latencyMs: 1 }, schema: { status: "ok" } } };
  const monitorProbe = async (scheduler: unknown, uptimeSeconds?: number) => probeService({ origin: "https://example.test", expectScheduler: "on", fetchImpl: async (url: string) => new Response(JSON.stringify(url.endsWith("readyz") ? readyAnswer : healthAnswer(scheduler, uptimeSeconds))) });
  const monitorCodes = async (scheduler: unknown): Promise<string[]> => (await monitorProbe(scheduler)).codes;
  const [e1, e2] = await signedInLenders(), [e3] = await signedInLenders();
  const owedOnly = [e1, e2, e3];
  clock = await databaseNow();
  await setCursor(e1, new Date(clock - 5 * 60 * 1000).toISOString());
  const brokenE1 = await breakLender(e1);
  const watched = startCloseScheduler({ intervalMs: 60_000, firstDelayMs: 60_000, onlyMerchantIds: owedOnly });
  try {
    await watched.tick();
    assert.equal(schedulerStatus().lastRun?.failed, 1);
    assert.deepEqual(await monitorCodes(schedulerStatus()), ["scheduler_close_failed"], "the failed close is raised");
    await setCursor(e2, new Date(clock - 60 * 1000).toISOString());
    await watched.tick();
    assert.deepEqual([schedulerStatus().lastRun?.closed, schedulerStatus().lastRun?.failed], [1, 0], "the next pass with work closed another lender while E1 waits for its retry");
    assert.deepEqual(await monitorCodes(schedulerStatus()), ["scheduler_close_failed"], "another lender's close does not hide the failing one");
    assert.equal((await watched.tick())!.examined, 0);
    assert.deepEqual(await monitorCodes(schedulerStatus()), ["scheduler_close_failed"], "nor does a quiet pass");
    const answer = JSON.stringify(healthAnswer(schedulerStatus()));
    assert.ok(owedOnly.every((id) => !answer.includes(id)), "the health answer names no lender");
  } finally {
    watched.stop();
    await watched.settle();
  }
  // A restarted process: nothing is known until its first pass, which does not try E1, still waiting, but reads it.
  // Just started, it is too young for that pass to have returned: a warning, not an incident. Up long enough, it is stale.
  const restarted: typeof import("../src/lib/close-scheduler.js") = await import(`${new URL("../src/lib/close-scheduler.ts", import.meta.url).href}?restarted`);
  const afterRestart = restarted.startCloseScheduler({ intervalMs: 60_000, firstDelayMs: 60_000, onlyMerchantIds: owedOnly });
  try {
    const justStarted = await monitorProbe(restarted.schedulerStatus(), 1);
    assert.deepEqual([justStarted.codes, justStarted.warnings, justStarted.observations.closeBacklog], [[], ["scheduler_backlog_pending"], "pending"], "before its first pass a process just started has no evidence yet");
    assert.deepEqual(await monitorCodes(restarted.schedulerStatus()), ["scheduler_stale"], "nor has one up long enough to have made that pass, which is stale");
    assert.equal((await afterRestart.tick())!.examined, 0);
    assert.deepEqual(await monitorCodes(restarted.schedulerStatus()), ["scheduler_close_failed"], "its first pass reads the failing lender from the database");
    await setCursor(e3, hoursAgo(clock, 1));
    const holdsE3 = await pool.connect();
    try {
      await holdsE3.query("BEGIN");
      await holdsE3.query("SELECT 1 FROM valopay_merchants WHERE id=$1 FOR UPDATE", [e3]);
      assert.deepEqual((await afterRestart.tick())!.skipped, [e3]);
      assert.deepEqual(await monitorCodes(restarted.schedulerStatus()), ["scheduler_close_failed", "scheduler_closes_overdue"], "a close an hour past its time is overdue, whoever holds the lender");
    } finally {
      await holdsE3.query("ROLLBACK");
      holdsE3.release();
    }
    await pool.query("UPDATE valopay_records SET data = $2 WHERE id=$1", [brokenE1.id, brokenE1.data]);
    await retryNow(e1);
    assert.deepEqual(closedIds((await afterRestart.tick())!).sort(), [e1, e3].sort());
    assert.deepEqual(await monitorCodes(restarted.schedulerStatus()), [], "the failing lender's own close ends it");
  } finally {
    afterRestart.stop();
    await afterRestart.settle();
  }

  // A public anonymous sandbox, a lender a visitor's sandbox is seeded with or creates, is counted apart from the
  // lenders: a close its visitor's own synthetic data makes fail, and one overdue, are the sandboxes' own counts, a
  // warning in the monitor, never an incident, and never fail the one-shot job. A lender beside them still does.
  const visitor = token();
  const [v1, v2] = await sandboxLenders(visitor), [n1] = await signedInLenders();
  const visitorOnly = [v1, v2, n1];
  clock = await databaseNow();
  await setCursor(v1, new Date(clock - 5 * 60 * 1000).toISOString());
  await setCursor(v2, hoursAgo(clock, 1));
  const brokenV1 = await breakLender(v1);
  const visitorLines: Array<Record<string, any>> = [];
  const visitorLog: any = { info: (fields: object) => visitorLines.push(fields), error: (fields: object) => visitorLines.push(fields), debug() {}, child: () => visitorLog };
  const visitorLine = (event: string) => visitorLines.find((line) => line.event === event)!;
  const visitorsWatched = startCloseScheduler({ intervalMs: 60_000, firstDelayMs: 60_000, onlyMerchantIds: visitorOnly });
  const holdsVisitors = await pool.connect();
  try {
    await holdsVisitors.query("BEGIN");
    await holdsVisitors.query("SELECT 1 FROM valopay_merchants WHERE id=$1 FOR UPDATE", [v2]);
    const visitorRun = await runClosePassOnce({ onlyMerchantIds: visitorOnly, log: visitorLog });
    assert.deepEqual([visitorRun.exitCode, visitorRun.run!.failed.map((item) => [item.merchantId, item.publicSandbox]), visitorRun.run!.skipped], [0, [[v1, true]], [v2]], "a public sandbox's failed close, and one held past its time, do not fail the job");
    assert.deepEqual(["close.one_shot", "close.run"].map((event) => [visitorLine(event).failed, visitorLine(event).failing, visitorLine(event).overdue, visitorLine(event).publicSandboxes]), [[0, 0, 0, { failed: 1, failing: 1, overdue: 1, budgetSpent: false }], [0, 0, 0, { failed: 1, failing: 1, overdue: 1 }]], "its lines count them apart from the lenders");
    assert.equal(visitorLines.find((line) => line.merchantId === v1 && line.err)?.publicSandbox, true, "the failure's own line says it is a public sandbox's");
    await visitorsWatched.tick();
    const visitorsOwed = await monitorProbe(schedulerStatus());
    assert.deepEqual([visitorsOwed.codes, visitorsOwed.warnings, visitorsOwed.observations.closeBacklog], [[], ["scheduler_public_sandbox_close_failed", "scheduler_public_sandbox_closes_overdue"], { overdue: 0, failing: 0, publicSandboxes: { overdue: 1, failing: 1 } }], "the monitor warns of them, and raises no incident");
    await setCursor(n1, hoursAgo(clock, 1));
    await holdsVisitors.query("SELECT 1 FROM valopay_merchants WHERE id=$1 FOR UPDATE", [n1]);
    await visitorsWatched.tick();
    const lenderOwed = await monitorProbe(schedulerStatus());
    assert.deepEqual([lenderOwed.codes, lenderOwed.observations.closeBacklog], [["scheduler_closes_overdue"], { overdue: 1, failing: 0, publicSandboxes: { overdue: 1, failing: 1 } }], "a lender held past its time beside them is the incident");
    assert.equal((await runClosePassOnce({ onlyMerchantIds: visitorOnly })).exitCode, 2, "and fails the job");
  } finally {
    await holdsVisitors.query("ROLLBACK");
    holdsVisitors.release();
  }
  await pool.query("UPDATE valopay_records SET data = $2 WHERE id=$1", [brokenV1.id, brokenV1.data]);
  await retryNow(v1);
  try {
    assert.deepEqual(closedIds((await visitorsWatched.tick())!).sort(), [...visitorOnly].sort(), "free and repaired, each closes");
    const nothingOwed = await monitorProbe(schedulerStatus());
    assert.deepEqual([nothingOwed.codes, nothingOwed.warnings], [[], []]);
  } finally {
    visitorsWatched.stop();
    await visitorsWatched.settle();
  }

  // A spent budget fails the one-shot job only while a lender other than a public sandbox is still due: sandboxes are
  // taken up last, so one read of the next due lender says which. Leftover sandboxes are counted on the line, and are
  // overdue warnings once late.
  const [u1, u2] = await sandboxLenders(), [u3, u4] = await sandboxLenders(), [ul] = await signedInLenders();
  const budgetOnly = [u1, u2, u3, u4, ul];
  clock = await databaseNow();
  for (const id of [u1, u2, u3, u4]) await setCursor(id, hoursAgo(clock, 1));
  const budgetLines: Array<Record<string, any>> = [];
  const budgetLog: any = { info: (fields: object) => budgetLines.push(fields), error: (fields: object) => budgetLines.push(fields), debug() {}, child: () => budgetLog };
  const lastOneShot = () => budgetLines.filter((line) => line.event === "close.one_shot").at(-1)!;
  const sandboxesLeft = await runClosePassOnce({ onlyMerchantIds: budgetOnly, log: budgetLog, budgetMs: 0 });
  assert.deepEqual([sandboxesLeft.exitCode, sandboxesLeft.run!.budgetSpent, lastOneShot().budgetSpent, lastOneShot().publicSandboxes], [0, false, false, { failed: 0, overdue: 4, failing: 0, budgetSpent: true }], "a budget spent with only public sandboxes still due does not fail the job, and the line counts them");
  await setCursor(ul, hoursAgo(clock, 1));
  const lenderLeft = await runClosePassOnce({ onlyMerchantIds: budgetOnly, log: budgetLog, budgetMs: 0 });
  assert.deepEqual([lenderLeft.exitCode, lastOneShot().budgetSpent, lastOneShot().overdue], [2, true, 1], "with a lender still due beside them it does");
  const drainedAll = await runClosePassOnce({ onlyMerchantIds: budgetOnly, log: budgetLog });
  assert.deepEqual([drainedAll.exitCode, closedIds(drainedAll.run!).sort(), lastOneShot().publicSandboxes.budgetSpent], [0, [...budgetOnly].sort(), false], "a run with its budget closes them all");

  // Only a visitor's lenders are public sandboxes: those its sandbox is seeded with and those it creates. A signed-in
  // person's, seeded or created, and a staff pilot's, which its administrator creates, are lenders whatever their data.
  const createLender = async (request: any, name: string) => (await inWorkspace(request, response(), (context) => createPilotLender(context, { name, segment: "Consumer lending" }, randomUUID()), "team")).lender.id;
  const visitorCreated = await createLender(requestFor(visitor), "Visitor's own lender");
  const signedInCreated = await createLender(signedInRequest(`user_synthetic_${randomBytes(8).toString("hex")}`), "Signed-in person's lender");
  const staffSettings = { VALOPAY_STAFF_ACCESS: process.env.VALOPAY_STAFF_ACCESS, VALOPAY_STAFF_ISSUER: process.env.VALOPAY_STAFF_ISSUER, VALOPAY_STAFF_ORIGINS: process.env.VALOPAY_STAFF_ORIGINS };
  let staffCreated = "";
  try {
    Object.assign(process.env, { VALOPAY_STAFF_ACCESS: "staging", VALOPAY_STAFF_ISSUER: "https://identity.example", VALOPAY_STAFF_ORIGINS: "https://pilot.example" });
    const organisation = `org_${randomBytes(8).toString("hex")}`, administrator = `user_${randomBytes(8).toString("hex")}`, issued = Math.floor(Date.now() / 1000);
    await provisionStaffWorkspace(organisation, administrator, "Scheduled close rehearsal");
    const session = { userId: administrator, orgId: organisation, sessionId: `sess_${administrator}`, tokenType: "session_token", sessionStatus: "active", factorVerificationAge: [0, 0], sessionClaims: { sub: administrator, sid: `sess_${administrator}`, iss: "https://identity.example", azp: "https://pilot.example", iat: issued - 1, exp: issued + 3600 } };
    staffCreated = await createLender({ headers: {}, auth: Object.assign(() => session, { [Symbol.for("@clerk/express.auth")]: true }) }, "Staff pilot lender");
  } finally {
    for (const [name, value] of Object.entries(staffSettings)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  const created = [visitorCreated, signedInCreated, staffCreated];
  assert.deepEqual(await Promise.all([v1, n1, ...created].map(async (id) => (await settingsOf(id)).anonymousWorkspace)), [true, false, true, false, false], "a visitor's lenders are public sandboxes, seeded or created; a signed-in person's and a staff pilot's are not");
  clock = await databaseNow();
  for (const id of created) await pool.query("UPDATE valopay_merchants SET settings = settings || jsonb_build_object('scheduledCloseEnabled', true, 'nextCloseAt', $2::text) WHERE id=$1", [id, hoursAgo(clock, 1)]);
  assert.deepEqual(await scheduledCloseBacklog(30, { only: created }), { overdue: 2, failing: 0, publicSandboxes: { overdue: 1, failing: 0 } }, "an hour past their times, the visitor's is counted as a public sandbox, the others as lenders");
  for (const id of created) await pool.query(`UPDATE valopay_merchants SET settings = settings || '{"scheduledCloseEnabled": false}' WHERE id=$1`, [id]);

  // With VALOPAY_CLOSE_SCHEDULER=external a scheduled job runs the closes and the web instances run no pass, so each
  // reads what is still owed itself, on its background worker thread at the scheduler's interval, as index.ts starts it,
  // and its health answer carries the read: the monitor raises the same codes, so a job that has stopped running shows
  // as overdue closes, and a read that stops ages past three intervals into scheduler_stale. The reads take the close's
  // connection in turn with the day's audit checks, one thing at a time, as a pass would.
  const { requestDailyAuditCheck, startBackgroundWorker } = await import("../src/lib/background-worker.js");
  const [j1] = await signedInLenders(), [jv] = await sandboxLenders();
  const jobOnly = [j1, jv];
  clock = await databaseNow();
  await setCursor(j1, hoursAgo(clock, 1)); await setCursor(jv, hoursAgo(clock, 1));
  const externalProbe = async () => probeService({ origin: "https://example.test", expectScheduler: "external", fetchImpl: async (url: string) => new Response(JSON.stringify(url.endsWith("readyz") ? readyAnswer : healthAnswer(schedulerStatus()))) });
  /** Waits, for a while, until `done` holds. */
  const until = async (done: () => boolean | Promise<boolean>) => { for (const give = Date.now() + 15_000; !(await done()) && Date.now() < give;) await new Promise((resolve) => setTimeout(resolve, 20)); };
  /** Waits, for a while, for a read the instance made at or after `since`. */
  const readSince = (since: number) => until(() => Date.parse(schedulerStatus().backlog?.checkedAt ?? "") >= since);
  /** Waits, for a while, for a read that shows nothing owed, rather than the first read after a moment, which may have begun before the last close committed. */
  const readClear = () => until(() => { const owed = schedulerStatus().backlog; return Boolean(owed) && owed!.overdue + owed!.failing + owed!.publicSandboxes.overdue + owed!.publicSandboxes.failing === 0; });
  markSchedulerOff("external");
  let since = Date.now();
  const webInstance = startBackgroundWorker({ log: { info() {}, warn() {}, error() {} } as any, closes: null, backlog: { intervalMs: 1_000, firstDelayMs: 10, onlyMerchantIds: jobOnly }, exports: null });
  try {
    await readSince(since);
    const missed = await externalProbe();
    assert.deepEqual([missed.codes, missed.warnings, missed.observations.schedulerEvidence, missed.observations.closeBacklog], [["scheduler_closes_overdue"], ["scheduler_public_sandbox_closes_overdue"], "failed", { overdue: 1, failing: 0, publicSandboxes: { overdue: 1, failing: 0 } }], "a close the scheduled job has not run shows on the web instance's health answer, as on a host that runs its own");
    assert.deepEqual([schedulerStatus().state, schedulerStatus().intervalMs], ["external", 1_000], "the instance runs no pass, and says how often it reads");
    const job = await runClosePassOnce({ onlyMerchantIds: jobOnly });
    assert.deepEqual([job.exitCode, closedIds(job.run!).sort()], [0, [...jobOnly].sort()], "the job's next run closes both");
    await readClear();
    const caughtUp = await externalProbe();
    assert.deepEqual([caughtUp.codes, caughtUp.warnings, caughtUp.observations.schedulerEvidence, caughtUp.observations.closeBacklog], [[], [], "mode_and_fresh_backlog", { overdue: 0, failing: 0, publicSandboxes: { overdue: 0, failing: 0 } }], "and the instance's next read ends it");
    // While a daily audit check a person's close asked for waits for its lender, held here, the instance makes no read:
    // the check has the close's connection. A read then goes ahead of the checks still waiting, here one whose lender
    // is held too, so it waits for the check in progress at most; the waiting check runs after it, and the reads resume.
    const [checked, queued] = await signedInLenders();
    const holdsChecked = await pool.connect(), holdsQueued = await pool.connect();
    const lockWaits = async () => (await pool.query<{ waiting: number }>("SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'")).rows[0]!.waiting;
    /** Waits no longer than `ms` for `done`, well inside a check's 5 s wait for its lender, and says whether it holds. */
    const within = async (ms: number, done: () => boolean | Promise<boolean>) => { for (const give = Date.now() + ms; !(await done()) && Date.now() < give;) await new Promise((resolve) => setTimeout(resolve, 20)); return done(); };
    try {
      for (const [holder, id] of [[holdsChecked, checked], [holdsQueued, queued]] as const) {
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM valopay_merchants WHERE id=$1 FOR UPDATE", [id]);
      }
      assert.ok(requestDailyAuditCheck(checked) && requestDailyAuditCheck(queued), "the thread takes both checks");
      await until(async () => (await lockWaits()) > 0);
      const heldAt = schedulerStatus().backlog!.checkedAt;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      assert.equal(schedulerStatus().backlog!.checkedAt, heldAt, "no read is made while a check has the close's connection");
      since = Date.now();
      await holdsChecked.query("ROLLBACK");
      assert.ok(await within(2_000, () => Date.parse(schedulerStatus().backlog!.checkedAt) >= since), "once that check ends, a read goes ahead of the check still waiting");
      assert.ok(await within(2_000, async () => (await lockWaits()) > 0), "and the waiting check runs after it");
    } finally {
      for (const holder of [holdsChecked, holdsQueued]) {
        await holder.query("ROLLBACK");
        holder.release();
      }
    }
    since = Date.now();
    await readSince(since);
    assert.ok(Date.parse(schedulerStatus().backlog!.checkedAt) >= since, "then the reads resume");
  } finally {
    webInstance.stop();
    await webInstance.settle();
  }
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  assert.deepEqual((await externalProbe()).codes, ["scheduler_stale"], "a read that stops ages: past three intervals it is no evidence");

  // Expiry: scheduled-close audit entries never keep an abandoned sandbox alive.
  const workspace = (await pool.query<{ workspace_id: string }>("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [a])).rows[0]!.workspace_id;
  await pool.query("UPDATE valopay_workspaces SET created_at = now() - interval '40 days' WHERE id=$1", [workspace]);
  await pool.query(
    `UPDATE valopay_records SET created_at = created_at - interval '40 days', updated_at = updated_at - interval '40 days'
     WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1) AND NOT (kind='audit' AND data->>'actor' LIKE $2)`,
    [workspace, `${SYSTEM_ACTOR_PREFIX}%`],
  );
  assert.ok((await pool.query("SELECT 1 FROM valopay_records r JOIN valopay_merchants m ON m.id=r.merchant_id WHERE m.workspace_id=$1 AND r.kind='audit' AND r.created_at >= now() - interval '1 day'", [workspace])).rowCount! >= 2, "recent system audit entries exist");
  for (let attempt = 0; attempt < 10; attempt += 1) {
    // The sweep is opt-in; the scheduled close's own entries must not count as activity once it runs.
    process.env.VALOPAY_EXPIRED_WORKSPACE_CLEANUP = "on";
    await inWorkspace(requestFor(token()), response(), async (context) => { await listMerchants(context); });
    if ((await pool.query("SELECT 1 FROM valopay_workspaces WHERE id=$1", [workspace])).rowCount === 0) break;
  }
  assert.equal((await pool.query("SELECT 1 FROM valopay_workspaces WHERE id=$1", [workspace])).rowCount, 0, "a sandbox touched only by the seed and the scheduled close expires");
  console.log("scheduled close integration tests passed");
} finally {
  delete process.env.VALOPAY_EXPIRED_WORKSPACE_CLEANUP;
  await pool.end();
}
