import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkedOrigin, probeService, deliverTransition, deliverTest, deliveryConfiguration, monitorArguments, sendWebhook, sendEmail, schedulerExpectation, MissingSetting } from './monitor-valopay.mjs';

const received = [];
let healthy = true, rejectDelivery = false, schemaStatus = 'ok';
const readiness = (database = 'ok', schema = 'ok') => ({ status: database === 'ok' && ['ok', 'indexes_missing'].includes(schema) ? 'ok' : 'degraded', build: 'synthetic-test', checks: { database: { status: database, latencyMs: 1 }, schema: { status: schema } } });
const server = createServer(async (req, res) => {
  if (req.url === '/alerts') {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    if (rejectDelivery) { res.writeHead(503).end(); return; }
    received.push(JSON.parse(Buffer.concat(chunks).toString())); res.writeHead(204).end(); return;
  }
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/readyz') {
    const body = readiness(healthy ? 'ok' : 'failed', healthy ? schemaStatus : 'unchecked');
    res.writeHead(body.status === 'ok' ? 200 : 503).end(JSON.stringify(body));
  }
  else res.end(JSON.stringify({ status: 'ok', scheduler: { state: 'off' } }));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  assert.throws(() => checkedOrigin(origin));
  const credentialUrl = new URL('https://example.com/'); credentialUrl.username = 'synthetic'; credentialUrl.password = 'synthetic';
  assert.throws(() => checkedOrigin(credentialUrl.toString()));
  assert.throws(() => checkedOrigin('https://example.com/?key=secret'));
  const probe = () => probeService({ origin, allowLocal: true });
  const deliver = event => sendWebhook(`${origin}/alerts`, event, { allowLocal: true });
  let state;
  const tick = async () => { const result = await deliverTransition(await probe(), state, deliver, { owner: 'Synthetic rehearsal operator' }); state = result.state; return result; };
  assert.deepEqual((await probe()).codes, [], 'an intentionally disabled scheduler does not alert');
  assert.equal((await tick()).delivered, false);
  healthy = false;
  assert.equal((await tick()).delivered, false, 'one failed probe is below the threshold');
  rejectDelivery = true;
  await assert.rejects(tick, /Alert delivery failed/);
  assert.equal(state.delivered, '', 'failed delivery must be retried');
  rejectDelivery = false;
  assert.equal((await tick()).delivered, true);
  assert.equal((await tick()).delivered, false, 'an unchanged incident stays quiet');
  healthy = true;
  assert.equal((await tick()).delivered, true);
  assert.equal((await tick()).delivered, false);
  assert.deepEqual(received.map(event => event.kind), ['incident', 'recovery']);
  assert.deepEqual(received[0].codes, ['database_unready']);
  schemaStatus = 'incomplete';
  const incomplete = await probe();
  assert.deepEqual(incomplete.codes, ['schema_unready'], 'the actual readiness HTTP 503 response distinguishes an incomplete schema from a database outage');
  assert.equal(incomplete.observations.database, 'ok');
  assert.equal(incomplete.observations.schema, 'incomplete');
  assert.equal((await tick()).delivered, false);
  assert.equal((await tick()).delivered, true);
  assert.deepEqual(received.at(-1).codes, ['schema_unready']);
  schemaStatus = 'ok';
  assert.equal((await tick()).delivered, true);
  assert.equal(received.at(-1).kind, 'recovery');
  assert.deepEqual((await probeService({ origin, expectScheduler: true, allowLocal: true })).codes, ['scheduler_not_running']);
  const now = Date.now();
  // Worker liveness and cleanup are monitored even when the close scheduler is intentionally off.
  const worker = {
    state: 'running', jobs: { closes: false, backlog: false, exports: true, cleanup: true }, heartbeatIntervalMs: 10_000, staleAfterMs: 45_000,
    startedAt: new Date(now - 600_000).toISOString(), lastHeartbeatAt: new Date(now).toISOString(), crashCount: 2, restartCount: 2, lastCrashAt: new Date(now - 600_000).toISOString(),
    cleanup: { state: 'ok', intervalMs: 60_000, staleAfterMs: 195_000, lastCheckedAt: new Date(now).toISOString(), lastSuccessAt: new Date(now).toISOString(), lastErrorAt: null, lastResult: { attempted: 0, removed: 0, deferred: 0, pendingFailures: 0 } },
  };
  const workerProbe = (background, at = now) => probeService({ origin: 'https://example.com', now: at, fetchImpl: async url => new Response(JSON.stringify(url.endsWith('readyz') ? readiness() : { status: 'ok', scheduler: { state: 'off' }, background })) });
  const workerOk = await workerProbe(worker);
  assert.deepEqual(workerOk.codes, [], 'historical restarts and a successful empty cleanup poll are not current incidents');
  assert.deepEqual(workerOk.observations.background.cleanup.lastResult, { attempted: 0, removed: 0, deferred: 0, pendingFailures: 0 });
  assert.deepEqual((await workerProbe({ ...worker, state: 'restarting' })).codes, ['background_not_running'], 'a worker crash remains visible with the scheduler off');
  assert.deepEqual((await workerProbe({ ...worker, lastHeartbeatAt: new Date(now - 45_001).toISOString() })).codes, ['background_stale'], 'the monitor checks freshness itself');
  assert.deepEqual((await workerProbe({ ...worker, lastHeartbeatAt: new Date(now + 60_000).toISOString() })).codes, ['background_stale'], 'a heartbeat from the future is not fresh evidence');
  assert.deepEqual((await workerProbe({ ...worker, cleanup: { ...worker.cleanup, state: 'failed', lastErrorAt: new Date(now).toISOString(), lastResult: { attempted: 1, removed: 0, deferred: 1, pendingFailures: 1 } } })).codes, ['background_cleanup_failed'], 'a live event loop does not hide a failed cleanup check');
  assert.deepEqual((await workerProbe({ ...worker, cleanup: { ...worker.cleanup, state: 'failed', lastResult: { attempted: 0, removed: 0, deferred: 0, pendingFailures: 1 } } })).codes, ['background_cleanup_failed'], 'an empty poll does not hide a failed tombstone waiting in backoff');
  assert.deepEqual((await workerProbe({ ...worker, cleanup: { ...worker.cleanup, lastCheckedAt: new Date(now - 195_001).toISOString() } })).codes, ['background_cleanup_stale'], 'cleanup freshness is independent of the worker heartbeat');
  const disabledCleanup = { state: 'disabled', intervalMs: null, staleAfterMs: null, lastCheckedAt: null, lastSuccessAt: null, lastErrorAt: null, lastResult: null };
  assert.deepEqual((await workerProbe({ ...worker, jobs: { ...worker.jobs, cleanup: false }, cleanup: disabledCleanup })).codes, [], 'restricted runtimes may intentionally disable service cleanup');
  assert.deepEqual((await workerProbe({ ...worker, crashCount: '2' })).codes, ['background_unverified']);
  for (const cleanup of [null, undefined, [], 'bad', {}, { ...worker.cleanup, lastResult: {} }]) {
    assert.deepEqual((await workerProbe({ ...worker, cleanup })).codes, ['background_unverified'], 'malformed nested cleanup is unverified without crashing the probe');
  }
  assert.deepEqual((await workerProbe({ ...worker, cleanup: { ...worker.cleanup, lastResult: { attempted: 0, removed: 1, deferred: 0 } } })).codes, ['background_unverified']);
  const privateMarker = 'synthetic-private-marker';
  assert.ok(!JSON.stringify(await workerProbe({ ...worker, privatePath: privateMarker, jobs: { ...worker.jobs, secret: privateMarker }, cleanup: { ...worker.cleanup, lastResult: { ...worker.cleanup.lastResult, tenant: privateMarker } } })).includes(privateMarker), 'only allowlisted operational observations can enter alert delivery');
  // Any string Date.parse reads passes as a time, so every time copied into the observation is rebuilt in ISO form.
  const marked = 'Tue Sep 29 2026 10:00:00 GMT+0000 (synthetic-private-marker)', plain = new Date(now).toUTCString(), second = new Date(Date.parse(plain)).toISOString();
  const rebuilt = await workerProbe({ ...worker, lastHeartbeatAt: plain, lastCrashAt: marked, cleanup: { ...worker.cleanup, lastCheckedAt: plain, lastSuccessAt: plain, lastErrorAt: marked } });
  assert.deepEqual([rebuilt.codes, JSON.stringify(rebuilt).includes(privateMarker)], [[], false], 'text a timestamp carries never reaches alert delivery');
  assert.deepEqual([rebuilt.observations.background.lastHeartbeatAt, rebuilt.observations.background.lastCrashAt, rebuilt.observations.background.cleanup], [second, '2026-09-29T10:00:00.000Z', { state: 'ok', lastCheckedAt: second, lastSuccessAt: second, lastErrorAt: '2026-09-29T10:00:00.000Z', lastResult: worker.cleanup.lastResult }], 'each copied time is in ISO form');
  // A worker's clock may run a heartbeat interval ahead of the monitor's, and its answer comes up to the probe's time
  // limit (8 s by default) after the monitor read its own: a time up to both ahead is fresh, one further ahead is not.
  const ahead = (by, timeoutMs) => probeService({ origin: 'https://example.com', now, timeoutMs, fetchImpl: async url => new Response(JSON.stringify(url.endsWith('readyz') ? readiness() : { status: 'ok', scheduler: { state: 'off' },
    background: { ...worker, lastHeartbeatAt: new Date(now + by).toISOString(), cleanup: { ...worker.cleanup, lastCheckedAt: new Date(now + by).toISOString(), lastSuccessAt: new Date(now + by).toISOString() } } })) });
  assert.deepEqual([(await ahead(11_000)).codes, (await ahead(18_000)).codes, (await ahead(18_001)).codes, (await ahead(13_000, 2_000)).codes], [[], [], ['background_cleanup_stale', 'background_stale'], ['background_cleanup_stale', 'background_stale']], 'a worker clock ahead by up to the heartbeat interval and the probe\'s time limit is fresh');
  let workerState; const workerEvents = [];
  const workerTransition = async probe => { const result = await deliverTransition(probe, workerState, async event => workerEvents.push(event), { owner: 'Synthetic operator' }); workerState = result.state; return result; };
  await workerTransition(await workerProbe({ ...worker, state: 'restarting' }));
  await workerTransition(await workerProbe({ ...worker, state: 'restarting' }));
  const starting = at => ({ ...worker, state: 'starting', jobs: { ...worker.jobs, cleanup: false }, cleanup: disabledCleanup, startedAt: new Date(at).toISOString(), lastHeartbeatAt: null });
  await workerTransition(await workerProbe(starting(now)));
  assert.deepEqual(workerEvents.map(event => event.kind), ['incident'], 'a restarting worker without its first heartbeat cannot clear an incident');
  assert.equal(workerState.pendingSince, new Date(now).toISOString(), 'the starting worker began a run of startup-only probes');
  await workerTransition(await workerProbe(undefined));
  assert.equal(workerEvents.length, 1, 'a rollback to a build that does not report worker health cannot clear its incident');
  assert.deepEqual([workerState.delivered, workerState.pendingSince, workerState.pendingWarnings], ['background_not_running', undefined, undefined], 'but, like any probe that is not startup-only, it ends the run');
  const anHourLater = await workerTransition(await workerProbe(starting(now + 3_600_000), now + 3_600_000));
  assert.deepEqual([anHourLater.probe.codes, anHourLater.delivered, workerState.pendingSince], [[], false, new Date(now + 3_600_000).toISOString()], 'so a worker starting an hour later begins a new run, and is no evidence yet');
  // An older build's young process is startup-only: it goes on with the run, and changes nothing else while a worker incident is open.
  const olderYoung = { service: 'https://example.com', observedAt: new Date(now + 3_660_000).toISOString(), codes: [], warnings: ['scheduler_backlog_pending'], firstReadWithinMs: 80_000, observations: { background: 'not_reported' } };
  const goesOn = await workerTransition(olderYoung);
  assert.deepEqual([goesOn.delivered, workerState.delivered, workerState.pendingSince, workerState.pendingWarnings], [false, 'background_not_running', new Date(now + 3_600_000).toISOString(), { background_starting: 45_000, scheduler_backlog_pending: 80_000 }], 'an older build\'s young process joins the run');
  await workerTransition(workerOk);
  assert.deepEqual(workerEvents.map(event => event.kind), ['incident', 'recovery']);
  workerState = undefined; workerEvents.length = 0;
  for (const offset of [0, 60_000, 120_000]) await workerTransition(await workerProbe(starting(now + offset), now + offset));
  assert.deepEqual(workerEvents.map(event => event.codes), [['background_stale']], 'a process or worker restarted before each first heartbeat eventually alerts');
  workerState = undefined; workerEvents.length = 0;
  for (const offset of [0, 200_000, 400_000]) {
    const at = now + offset;
    await workerTransition(await workerProbe({ ...worker, startedAt: new Date(at).toISOString(), lastHeartbeatAt: new Date(at).toISOString(), cleanup: { ...worker.cleanup, state: 'pending', lastCheckedAt: null, lastSuccessAt: null, lastResult: null } }, at));
  }
  assert.deepEqual(workerEvents.map(event => event.codes), [['background_cleanup_stale']], 'repeated first-cleanup grace periods cannot hide a worker that never checks');
  workerState = undefined; workerEvents.length = 0;
  const failedCleanup = { ...worker, cleanup: { ...worker.cleanup, state: 'failed', lastResult: { attempted: 1, removed: 0, deferred: 1, pendingFailures: 1 } } };
  await workerTransition(await workerProbe(failedCleanup)); await workerTransition(await workerProbe(failedCleanup));
  await workerTransition(await workerProbe({ ...worker, cleanup: { ...worker.cleanup, state: 'failed', lastResult: { attempted: 0, removed: 0, deferred: 0, pendingFailures: 1 } } }));
  await workerTransition(await workerProbe({ ...worker, cleanup: { ...worker.cleanup, state: 'failed', lastResult: { attempted: 1, removed: 1, deferred: 0, pendingFailures: 1 } } }));
  assert.deepEqual(workerEvents.map(event => event.kind), ['incident'], 'backoff and another successful file do not send false recovery');
  await workerTransition(workerOk);
  assert.deepEqual(workerEvents.map(event => event.kind), ['incident', 'recovery'], 'positive durable clearance permits recovery');
  // A file parked for an operator's review (its identity did not match, which no retry changes) is its own incident,
  // background_cleanup_needs_review, not a failed check; a failure awaiting retry beside it is still
  // background_cleanup_failed, and a build that does not count parked files is read as before.
  const parkedCheck = (lastResult, state = 'failed') => workerProbe({ ...worker, cleanup: { ...worker.cleanup, state, lastErrorAt: new Date(now).toISOString(), lastResult } });
  const quietParked = { attempted: 0, removed: 0, deferred: 0, pendingFailures: 0, parked: 1 };
  assert.deepEqual((await parkedCheck({ attempted: 1, removed: 0, deferred: 1, pendingFailures: 0, parked: 1 })).codes, ['background_cleanup_needs_review'], 'the pass that parks a file raises a review, not a failure');
  const reviewed = await parkedCheck(quietParked);
  assert.deepEqual([reviewed.codes, reviewed.observations.background.cleanup.lastResult], [['background_cleanup_needs_review'], quietParked], 'later checks keep it, with the count');
  assert.deepEqual((await parkedCheck({ ...quietParked, pendingFailures: 1 })).codes, ['background_cleanup_failed', 'background_cleanup_needs_review'], 'a failure awaiting retry beside it is still a failed check');
  assert.deepEqual((await parkedCheck({ attempted: 0, removed: 0, deferred: 0, pendingFailures: 1 })).codes, ['background_cleanup_failed'], 'a build without the count is read as before');
  for (const count of ['1', -1, 1.5, null]) assert.deepEqual((await parkedCheck({ ...quietParked, parked: count })).codes, ['background_unverified'], `a parked count of ${JSON.stringify(count)} is unverified`);
  assert.deepEqual((await parkedCheck(quietParked, 'ok')).codes, ['background_unverified'], 'a clean check with a parked file is contradictory');
  workerState = undefined; workerEvents.length = 0;
  await workerTransition(reviewed); await workerTransition(await parkedCheck(quietParked));
  await workerTransition(workerOk);
  assert.deepEqual(workerEvents.map(event => [event.kind, event.codes.join()]), [['incident', 'background_cleanup_needs_review'], ['recovery', '']], 'a parked file opens a review incident, which ends once no file is parked');
  const fake = (scheduler, schema = 'ok', uptimeSeconds) => async url => new Response(JSON.stringify(url.endsWith('readyz') ? readiness('ok', schema) : { status: 'ok', ...(uptimeSeconds === undefined ? {} : { uptimeSeconds }), scheduler }), { status: url.endsWith('readyz') && schema === 'incomplete' ? 503 : 200 });
  assert.deepEqual((await probeService({ origin: 'https://example.com', expectScheduler: true, now, fetchImpl: fake({ state: 'running', intervalMs: 1000, lastSuccessAt: new Date(now - 4000).toISOString() }) })).codes, ['scheduler_stale']);
  // A host whose closes run from a scheduled job (VALOPAY_CLOSE_SCHEDULER=external) must say so: reporting off would
  // hide missed closes again, and running would run them in the web instances too.
  assert.deepEqual((await probeService({ origin, expectScheduler: 'external', allowLocal: true })).codes, ['scheduler_not_external'], 'a host reporting off is named');
  assert.deepEqual((await probeService({ origin: 'https://example.com', expectScheduler: 'external', now, fetchImpl: fake({ state: 'external', intervalMs: null, ticks: 0, lastTickAt: null, lastRun: null }) })).codes, []);
  assert.deepEqual((await probeService({ origin: 'https://example.com', expectScheduler: 'on', now, fetchImpl: fake({ state: 'external', intervalMs: null }) })).codes, ['scheduler_not_running']);
  // A build without the backlog reports only its last pass with work, which a later pass replaces: the monitor reads
  // that, and says the durable facts are missing.
  const running = { state: 'running', intervalMs: 1000, lastSuccessAt: new Date(now).toISOString(), lastRun: { failed: 1 } };
  const olderBuild = await probeService({ origin: 'https://example.com', expectScheduler: 'on', now, fetchImpl: fake(running) });
  assert.deepEqual([olderBuild.codes, olderBuild.warnings, olderBuild.observations.closeBacklog], [['scheduler_close_failed'], ['scheduler_backlog_not_reported'], 'not_reported'], 'a successful pass does not hide failed lender closes');
  // A lender whose close failed stays counted until its close succeeds, read from the database at every pass: a later
  // pass that closed another lender, a quiet pass or a restarted process's first pass does not hide it.
  const backlog = (failing, overdue = 0) => ({ checkedAt: new Date(now).toISOString(), overdue, failing, lateAfterMinutes: 30 });
  const current = { ...running, lastRun: { failed: 0 }, backlog: backlog(1) };
  const failing = await probeService({ origin: 'https://example.com', expectScheduler: 'on', now, fetchImpl: fake(current) });
  assert.deepEqual([failing.codes, failing.warnings, failing.observations.closeBacklog], [['scheduler_close_failed'], [], { overdue: 0, failing: 1 }], 'a later pass with work that closed another lender does not hide the failing one');
  assert.deepEqual((await probeService({ origin: 'https://example.com', expectScheduler: 'on', now, fetchImpl: fake({ ...current, lastRun: null, backlog: backlog(0, 2) }) })).codes, ['scheduler_closes_overdue'], 'a close more than its grace past its time is named, whoever failed');
  assert.deepEqual((await probeService({ origin: 'https://example.com', expectScheduler: 'on', now, fetchImpl: fake({ ...current, backlog: backlog(0) }) })).codes, [], 'the failing lender closed: nothing is owed');
  assert.deepEqual((await probeService({ origin: 'https://example.com', expectScheduler: 'on', now, fetchImpl: fake({ ...current, backlog: { failing: '1' } }) })).codes, ['scheduler_stale'], 'a backlog the monitor cannot read is no evidence');
  assert.deepEqual((await probeService({ origin: 'https://example.com', expectScheduler: 'on', now, fetchImpl: fake({ ...current, state: 'stopped' }) })).codes, ['scheduler_close_failed', 'scheduler_not_running'], 'a stopped scheduler keeps the failure it last read');
  assert.equal((await probeService({ origin: 'https://example.com', now, fetchImpl: fake(current) })).observations.closeBacklog, 'not_requested');
  // Public anonymous sandboxes are counted apart from the lenders: a close a visitor's own data makes fail, or one
  // overdue, is a warning with the sandboxes' own counts, never an incident; the lenders' counts alone raise the codes.
  const withSandboxes = (lenders, failing, overdue) => ({ ...lenders, publicSandboxes: { overdue, failing } });
  const visitors = await probeService({ origin: 'https://example.com', expectScheduler: 'on', now, fetchImpl: fake({ ...current, backlog: withSandboxes(backlog(0), 1, 2) }) });
  assert.deepEqual([visitors.codes, visitors.warnings, visitors.observations.closeBacklog, visitors.observations.schedulerEvidence], [[], ['scheduler_public_sandbox_close_failed', 'scheduler_public_sandbox_closes_overdue'], { overdue: 0, failing: 0, publicSandboxes: { overdue: 2, failing: 1 } }, 'fresh_process_heartbeat'], 'a public sandbox whose own data makes its close fail is a warning, not an incident');
  const lenderAndVisitor = await probeService({ origin: 'https://example.com', expectScheduler: 'on', now, fetchImpl: fake({ ...current, backlog: withSandboxes(backlog(1), 1, 0) }) });
  assert.deepEqual([lenderAndVisitor.codes, lenderAndVisitor.warnings], [['scheduler_close_failed'], ['scheduler_public_sandbox_close_failed']], 'a lender failing beside a sandbox is still the incident');
  assert.deepEqual((await probeService({ origin: 'https://example.com', expectScheduler: 'on', now, fetchImpl: fake({ ...current, backlog: withSandboxes(backlog(0), -1, 0) }) })).codes, ['scheduler_stale'], 'sandbox counts the monitor cannot read are no evidence either');
  // A host whose closes run from a scheduled job (VALOPAY_CLOSE_SCHEDULER=external): each web instance reads what is
  // still owed at the scheduler's interval and reports it, so the same codes apply, a job that has stopped running shows
  // as overdue closes, and a read missing or older than three intervals is no evidence.
  const external = (owed, at = now) => ({ state: 'external', intervalMs: 1000, ticks: 0, lastTickAt: null, lastSuccessAt: null, lastErrorAt: null, lastRun: null, backlog: owed && { ...owed, checkedAt: new Date(at).toISOString() } });
  const probeExternal = scheduler => probeService({ origin: 'https://example.com', expectScheduler: 'external', now, fetchImpl: fake(scheduler) });
  const jobStopped = await probeExternal(external(backlog(0, 1)));
  assert.deepEqual([jobStopped.codes, jobStopped.warnings, jobStopped.observations.schedulerEvidence, jobStopped.observations.closeBacklog], [['scheduler_closes_overdue'], [], 'failed', { overdue: 1, failing: 0 }], 'a scheduled job that stopped running shows as overdue closes');
  assert.deepEqual((await probeExternal(external(backlog(2)))).codes, ['scheduler_close_failed'], 'a failing close is raised as on a host that runs its own');
  const quiet = await probeExternal(external(withSandboxes(backlog(0), 0, 1)));
  assert.deepEqual([quiet.codes, quiet.warnings, quiet.observations.schedulerEvidence, quiet.observations.closeBacklog], [[], ['scheduler_public_sandbox_closes_overdue'], 'mode_and_fresh_backlog', { overdue: 0, failing: 0, publicSandboxes: { overdue: 1, failing: 0 } }], 'the monitor saw the backlog, not only the mode');
  assert.deepEqual((await probeExternal(external(backlog(0), now - 4000))).codes, ['scheduler_stale'], 'a read older than three intervals is no evidence');
  const unread = await probeExternal(external(null));
  assert.deepEqual([unread.codes, unread.observations.closeBacklog], [['scheduler_stale'], 'unverified'], 'nor is a missing one from a process that does not say it is too young to have read');
  // A build from before this reports no backlog in external mode, null or absent: the mode alone, as before, with a warning.
  for (const older of [{ state: 'external', intervalMs: null, ticks: 0, lastTickAt: null, lastRun: null, backlog: null }, { state: 'external', intervalMs: null, ticks: 0, lastTickAt: null, lastRun: null }]) {
    const before = await probeExternal(older);
    assert.deepEqual([before.codes, before.warnings, before.observations.schedulerEvidence, before.observations.closeBacklog], [[], ['scheduler_backlog_not_reported'], 'mode_only', 'not_reported'], 'an older build is the mode alone');
  }
  // A process younger than its first read could be (its first-read delay, one interval and a margin: 17 s at a
  // one-second interval) has no evidence yet, whether it runs its own closes or reads the backlog for a scheduled job: a
  // warning, not an incident. A missing read from an older process, and an old read or heartbeat at any age, are stale.
  const young = 10, old = 600;
  const aged = (scheduler, uptimeSeconds, expectScheduler) => probeService({ origin: 'https://example.com', expectScheduler, now, fetchImpl: fake(scheduler, 'ok', uptimeSeconds) });
  const beforeFirstPass = { state: 'running', intervalMs: 1000, ticks: 1, lastTickAt: new Date(now).toISOString(), lastSuccessAt: null, lastErrorAt: null, lastRun: null, backlog: null };
  const oldPass = { ...current, lastSuccessAt: new Date(now - 4000).toISOString(), backlog: { ...backlog(0), checkedAt: new Date(now - 4000).toISOString() } };
  for (const [expectScheduler, unreadAnswer, oldRead] of [['on', beforeFirstPass, oldPass], ['external', external(null), external(backlog(0), now - 4000)]]) {
    const pending = await aged(unreadAnswer, young, expectScheduler);
    assert.deepEqual([pending.codes, pending.warnings, pending.observations.schedulerEvidence, pending.observations.closeBacklog], [[], ['scheduler_backlog_pending'], 'first_read_pending', 'pending'], `${expectScheduler}: a young process with no read yet is a warning, not an incident`);
    assert.deepEqual((await aged(unreadAnswer, old, expectScheduler)).codes, ['scheduler_stale'], `${expectScheduler}: one up long enough to have read, with no read, is stale`);
    assert.deepEqual((await aged(oldRead, young, expectScheduler)).codes, ['scheduler_stale'], `${expectScheduler}: an old read is stale whatever the uptime`);
  }
  const deployedInterval = { ...external(null), intervalMs: 60_000 };
  assert.deepEqual([(await aged(deployedInterval, 75, 'external')).codes, (await aged(deployedInterval, 85, 'external')).codes], [[], ['scheduler_stale']], 'at the deployed minute a process is young for 80 s: five seconds, one interval and the margin');
  // Two identical probes open the incident; a restart's first probe, before its first pass, neither ends nor repeats
  // it; the pass after the restart reads the lender again, and only that lender's close sends the recovery.
  const sent = [];
  let incident;
  const watch = async (scheduler, uptimeSeconds) => {
    const result = await deliverTransition(await probeService({ origin: 'https://example.com', expectScheduler: 'on', now, fetchImpl: fake(scheduler, 'ok', uptimeSeconds) }), incident, async event => { sent.push(event); }, { owner: 'Synthetic rehearsal operator' });
    incident = result.state;
    return result.delivered;
  };
  assert.deepEqual([await watch(current), await watch({ ...current, lastRun: { failed: 0, closed: 1 } })], [false, true], 'two probes open the incident while other lenders close');
  const restarted = { state: 'running', intervalMs: 1000, ticks: 0, lastTickAt: null, lastSuccessAt: null, lastErrorAt: null, lastRun: null, backlog: null };
  assert.deepEqual([await watch(restarted, young), await watch({ ...restarted, lastSuccessAt: new Date(now).toISOString(), backlog: backlog(1) }, young)], [false, false], 'a young restarted process\'s warning is no evidence either way: it neither ends nor repeats the incident');
  assert.deepEqual([await watch(restarted), await watch({ ...restarted, lastSuccessAt: new Date(now).toISOString(), backlog: backlog(1) })], [false, false], 'nor does an older one\'s stale probe');
  assert.deepEqual([await watch({ ...current, backlog: backlog(0) }), sent.map(event => [event.kind, event.codes.join()])], [true, [['incident', 'scheduler_close_failed'], ['recovery', '']]], 'the failing lender closing ends it');
  // No process stays young: probes that find nothing but a process too young to have read, for longer than one process
  // can be young (80 s at the deployed minute), mean the monitor keeps meeting new processes, a crash loop or an instance
  // each probe starts. From then on each counts as scheduler_stale, and two in a row open the incident; one restart does not.
  let events = [];
  const timeline = async (expectScheduler, answers, minutesApart = 5) => {
    const delivered = [];
    let state;
    events = [];
    for (const [index, answer] of answers.entries()) {
      const at = now + index * minutesApart * 60_000;
      const probe = await probeService({ origin: 'https://example.com', expectScheduler, now: at, fetchImpl: async url => new Response(JSON.stringify(url.endsWith('readyz') ? readiness() : answer(at))) });
      state = (await deliverTransition(probe, state, async event => { events.push(event); delivered.push(`${event.kind}:${event.codes.join('|') || '-'}@${index}`); }, { owner: 'Synthetic rehearsal operator' })).state;
    }
    return delivered;
  };
  const minute = { intervalMs: 60_000, ticks: 0, lastTickAt: null, lastSuccessAt: null, lastErrorAt: null, lastRun: null, backlog: null };
  const notRead = { on: { ...minute, state: 'running' }, external: { ...minute, state: 'external' } };
  for (const expectScheduler of ['on', 'external']) {
    const crashLoop = await timeline(expectScheduler, [23, 61, 9, 40, 15].map(uptimeSeconds => () => ({ status: 'ok', uptimeSeconds, scheduler: notRead[expectScheduler] })));
    assert.deepEqual(crashLoop, ['incident:scheduler_stale@2'], `${expectScheduler}: a process that keeps restarting before its first read does not keep the monitor quiet`);
  }
  assert.deepEqual(await timeline('external', [2, 3, 2].map(uptimeSeconds => () => ({ status: 'ok', uptimeSeconds, scheduler: notRead.external })), 15), ['incident:scheduler_stale@2'], 'a monitor whose every probe starts an Autoscale instance is blind, and says so');
  assert.deepEqual([events[0].warnings, events[0].firstReadWithinMs, events[0].observations.schedulerEvidence], [['scheduler_backlog_pending'], 80_000, 'failed'], 'its incident keeps the warning beside the code, so it can be told from an old read');
  const heartbeat = failing => at => ({ status: 'ok', uptimeSeconds: 600, scheduler: { ...notRead.on, lastSuccessAt: new Date(at).toISOString(), backlog: { checkedAt: new Date(at).toISOString(), overdue: 0, failing, lateAfterMinutes: 30 } } });
  assert.deepEqual(await timeline('on', [heartbeat(1), heartbeat(1), () => ({ status: 'ok', uptimeSeconds: 20, scheduler: notRead.on }), heartbeat(1), heartbeat(0)]), ['incident:scheduler_close_failed@1', 'recovery:-@4'], 'one young restart neither ends nor repeats the incident');
  assert.equal((await aged(deployedInterval, 75, 'external')).firstReadWithinMs, 80_000, 'the probe says how long its process can be young');
  // A pending probe that does not say, such as one an earlier monitor wrote, is given two minutes.
  const pendingOnly = minutes => ({ service: 'https://example.com', observedAt: new Date(now + minutes * 60_000).toISOString(), codes: [], warnings: ['scheduler_backlog_pending'], observations: {} });
  let unsaid;
  for (const minutes of [0, 1.5]) unsaid = (await deliverTransition(pendingOnly(minutes), unsaid, async () => {}, { owner: 'Synthetic rehearsal operator' })).state;
  assert.equal(unsaid.pending, '', 'ninety seconds of pending probes is still no evidence');
  unsaid = (await deliverTransition(pendingOnly(2.5), unsaid, async () => {}, { owner: 'Synthetic rehearsal operator' })).state;
  assert.deepEqual([unsaid.pending, unsaid.pendingSince], ['scheduler_stale', pendingOnly(0).observedAt], 'but after two minutes each counts as stale');
  const earlierState = { service: 'https://example.com', pending: '', streak: 0, delivered: '', observedAt: pendingOnly(0).observedAt, pendingSince: pendingOnly(0).observedAt };
  assert.equal((await deliverTransition(pendingOnly(2.5), earlierState, async () => {}, { owner: 'Synthetic rehearsal operator' })).state.pending, 'scheduler_stale', 'a run an earlier monitor saved, without its warnings, goes on from when it began');
  // Each startup warning has its own window, which the probe gives (startupWindowsMs): a first heartbeat 45 s, a first
  // cleanup check 195 s at its default interval, a first read 80 s at the deployed minute. The monitor's state keeps
  // every startup warning a run of such probes has shown (pendingWarnings), and each counts as its stale code once the
  // run has lasted longer than its own window, whatever each probe happened to catch: the judged codes only grow, so a
  // crash loop, or instances each probe starts, open one incident.
  const isoAt = at => new Date(at).toISOString();
  const readAt = (expectScheduler, at) => ({ ...notRead[expectScheduler], ...(expectScheduler === 'on' ? { lastSuccessAt: isoAt(at) } : {}), backlog: { checkedAt: isoAt(at), overdue: 0, failing: 0, lateAfterMinutes: 30 } });
  /** A process as a probe meets it, young: its worker starting or running, its first cleanup check pending or made and, with closes expected, its first read pending or made. */
  const processAt = ({ starting = false, cleanupPending = false, readPending = false }, expectScheduler) => at => ({
    status: 'ok', uptimeSeconds: 1, startedAt: isoAt(at - 1_000), scheduler: !expectScheduler ? { state: 'off' } : readPending ? notRead[expectScheduler] : readAt(expectScheduler, at),
    background: { ...worker, state: starting ? 'starting' : 'running', startedAt: isoAt(at - 500), lastHeartbeatAt: starting ? null : isoAt(at - 100),
      cleanup: cleanupPending ? { ...worker.cleanup, state: 'pending', lastCheckedAt: null, lastSuccessAt: null, lastResult: null } : { ...worker.cleanup, lastCheckedAt: isoAt(at - 100), lastSuccessAt: isoAt(at - 100) } },
  });
  const windows = await probeService({ origin: 'https://example.com', expectScheduler: 'on', now, fetchImpl: async url => new Response(JSON.stringify(url.endsWith('readyz') ? readiness() : processAt({ starting: true, cleanupPending: true, readPending: true }, 'on')(now))) });
  assert.deepEqual([windows.warnings, windows.startupWindowsMs, windows.firstReadWithinMs, windows.backgroundReadWithinMs], [['background_starting', 'background_cleanup_pending', 'scheduler_backlog_pending'], { background_starting: 45_000, background_cleanup_pending: 195_000, scheduler_backlog_pending: 80_000 }, 80_000, 195_000], 'the probe gives each startup warning its own window, and keeps the older limits for receivers that read them');
  assert.deepEqual([windows.answeredBy, workerOk.answeredBy], [{ startedAt: isoAt(now - 1_000), workerStartedAt: isoAt(now - 500), restartCount: 2, lastCrashAt: isoAt(now - 600_000) }, undefined], 'with a startup warning the probe names the process and worker that answered, as the service reports them');
  for (const expectScheduler of [false, 'on', 'external']) {
    const caught = [{ starting: true, cleanupPending: true, readPending: true }, { cleanupPending: true, readPending: true }];
    const codes = [...(expectScheduler ? ['scheduler_stale'] : []), 'background_cleanup_stale', 'background_stale'].sort().join('|');
    assert.deepEqual(await timeline(expectScheduler, Array.from({ length: 6 }, (_, index) => processAt(caught[index % 2], expectScheduler))), [`incident:${codes}@2`], `${expectScheduler || 'closes off'}: a worker caught starting at every other probe opens one incident`);
  }
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  /** A process each probe meets young, showing a random subset of the startup warnings, at least one. */
  const randomProcess = expectScheduler => { const starting = random() < 0.5, readPending = Boolean(expectScheduler) && random() < 0.5; return processAt({ starting, cleanupPending: starting || !readPending || random() < 0.5, readPending }, expectScheduler); };
  assert.deepEqual([await timeline(false, Array.from({ length: 12 }, () => randomProcess(false))), await timeline('on', Array.from({ length: 12 }, () => randomProcess('on')))], [['incident:background_cleanup_stale|background_stale@2'], ['incident:background_cleanup_stale|background_stale|scheduler_stale@2']], 'random subsets open one incident');
  // A minute apart, each warning counts from its own window: a first cleanup check still pending (195 s) no longer holds
  // back scheduler_stale (80 s). The incident opens at the shortest window passed, and a later delivery only adds a code
  // whose own window has passed since, however the probes alternate: none drops out.
  assert.deepEqual(await timeline('on', Array.from({ length: 6 }, () => processAt({ cleanupPending: true, readPending: true }, 'on')), 1), ['incident:scheduler_stale@3', 'incident:background_cleanup_stale|scheduler_stale@5'], 'a pending first cleanup check does not delay scheduler_stale');
  assert.deepEqual(await timeline(false, Array.from({ length: 10 }, (_, index) => processAt(index % 2 ? { cleanupPending: true } : { starting: true, cleanupPending: true }, false)), 1), ['incident:background_stale@2', 'incident:background_cleanup_stale|background_stale@5'], 'a worker caught starting every other minute opens the incident at 45 s, and cleanup joins it at 195 s');
  seed = 7;
  const hour = (await timeline('on', Array.from({ length: 60 }, () => randomProcess('on')), 1)).map(line => line.split(/[:@]/));
  assert.ok(hour.length && hour.length <= 3 && hour.every(([kind, codes], index) => kind === 'incident' && (!index || hour[index - 1][1].split('|').every(code => codes.split('|').includes(code)) && codes !== hour[index - 1][1])), `an hour of random subsets a minute apart delivers only a growing incident: ${hour.map(line => line.join(' ')).join(', ')}`);
  // A warning keeps the window it first came with: a later probe giving it a longer one does not hold its judgement back.
  const windowed = minutes => windowMs => ({ ...pendingOnly(minutes), startupWindowsMs: { scheduler_backlog_pending: windowMs } });
  const firstWindow = (await deliverTransition(windowed(0)(80_000), undefined, async () => {}, { owner: 'Synthetic rehearsal operator' })).state;
  const longerLater = (await deliverTransition(windowed(1.5)(600_000), firstWindow, async () => {}, { owner: 'Synthetic rehearsal operator' })).state;
  assert.deepEqual([longerLater.pending, longerLater.pendingWarnings], ['scheduler_stale', { scheduler_backlog_pending: 80_000 }], 'the window a warning first came with holds for the run');
  // The incident a run is judged by carries the run (startupRun): when it began, every startup warning it has shown with
  // its window, and whether it has met more than one worker. A scheduler_stale beside this probe's own fresh read, judged
  // from a first read an earlier process never made, can so be told from an old read.
  await timeline('external', Array.from({ length: 6 }, (_, index) => processAt(index % 2 ? { cleanupPending: true } : { readPending: true }, 'external')), 1);
  const judgedByRun = events.find(event => event.codes.includes('scheduler_stale'));
  assert.deepEqual([judgedByRun.codes, judgedByRun.warnings, judgedByRun.observations.closeBacklog, judgedByRun.startupRun], [['scheduler_stale'], ['background_cleanup_pending'], { overdue: 0, failing: 0 }, { since: isoAt(now), warnings: [{ warning: 'background_cleanup_pending', windowMs: 195_000 }, { warning: 'scheduler_backlog_pending', windowMs: 80_000 }], restarted: true }], 'an incident judged from the run carries the run');
  // A warning a probe no longer shows counts only once the run has met another worker, named by the service's own
  // process and worker start, restart count and last crash, which are compared with each other and never with the
  // monitor's clock. One slow start is not a crash loop: the same worker, caught starting and then with its first
  // cleanup check still pending at the next two probes, gives no background_stale and leaves the open incident alone.
  /** A process started at processStart, its worker at workerStart, as a probe meets it at `at`. */
  const answeredAt = ({ processStart, workerStart, restarts = 0, crashAt = null, starting = false, cleanup = 'ok' }) => at => ({
    status: 'ok', uptimeSeconds: Math.round((at - processStart) / 1000), startedAt: isoAt(processStart), scheduler: { state: 'off' },
    background: { ...worker, state: starting ? 'starting' : 'running', startedAt: isoAt(workerStart), lastHeartbeatAt: starting ? null : isoAt(at - 100), crashCount: restarts, restartCount: restarts, lastCrashAt: crashAt === null ? null : isoAt(crashAt),
      cleanup: cleanup === 'pending' ? { ...worker.cleanup, state: 'pending', lastCheckedAt: null, lastSuccessAt: null, lastResult: null }
        : cleanup === 'failed' ? { ...worker.cleanup, state: 'failed', lastCheckedAt: isoAt(at - 100), lastSuccessAt: null, lastErrorAt: isoAt(at - 100), lastResult: { attempted: 0, removed: 0, deferred: 0, pendingFailures: 1 } }
        : { ...worker.cleanup, lastCheckedAt: isoAt(at - 100), lastSuccessAt: isoAt(at - 100) } },
  });
  const oldProcess = { processStart: now - 3_600_000, workerStart: now - 3_599_000 }, slowStart = { processStart: now + 118_000, workerStart: now + 118_500 };
  assert.deepEqual(await timeline(false, [answeredAt({ ...oldProcess, cleanup: 'failed' }), answeredAt({ ...oldProcess, cleanup: 'failed' }), answeredAt({ ...slowStart, starting: true, cleanup: 'pending' }),
    answeredAt({ ...slowStart, cleanup: 'pending' }), answeredAt({ ...slowStart, cleanup: 'pending' }), answeredAt({ ...slowStart, cleanup: 'failed' }), answeredAt(slowStart)], 1),
  ['incident:background_cleanup_failed@1', 'recovery:-@6'], 'one slow restart neither raises background_stale nor replaces the open incident');
  const loopInOneProcess = Array.from({ length: 6 }, (_, index) => at => answeredAt({ processStart: now - 3_600_000, workerStart: at - 500, restarts: index + 1, crashAt: at - 1_000, starting: index % 2 === 0, cleanup: 'pending' })(at));
  assert.deepEqual(await timeline(false, loopInOneProcess), ['incident:background_cleanup_stale|background_stale@2'], 'a worker thread restarting before each probe inside one process still opens one incident');
  // A probe that names no worker, an older build's, is judged as before: an earlier warning it does not show counts once its window has passed.
  const namedWorker = { startedAt: isoAt(now - 1_000), workerStartedAt: isoAt(now - 500), restartCount: 0, lastCrashAt: null };
  const workerCaughtStarting = { service: 'https://example.com', observedAt: isoAt(now), codes: [], warnings: ['background_starting'], startupWindowsMs: { background_starting: 45_000 }, answeredBy: namedWorker, observations: {} };
  const runBegun = (await deliverTransition(workerCaughtStarting, undefined, async () => {}, { owner: 'Synthetic rehearsal operator' })).state;
  const sameWorkerLater = { ...workerCaughtStarting, observedAt: isoAt(now + 60_000), warnings: ['background_cleanup_pending'], startupWindowsMs: { background_cleanup_pending: 195_000 } };
  const olderBuildLater = { service: 'https://example.com', observedAt: isoAt(now + 60_000), codes: [], warnings: ['scheduler_backlog_pending'], firstReadWithinMs: 80_000, observations: { background: 'not_reported' } };
  assert.deepEqual([(await deliverTransition(sameWorkerLater, runBegun, async () => {}, { owner: 'Synthetic rehearsal operator' })).probe.codes, (await deliverTransition(olderBuildLater, runBegun, async () => {}, { owner: 'Synthetic rehearsal operator' })).probe.codes],
    [[], ['background_stale']], 'the same worker without a restart is no evidence yet, while a probe that names no worker is judged as before');
  // Instances answering in turn: once the run has met another worker, the first answering again is still judged by the run.
  const otherInstance = { ...workerCaughtStarting, observedAt: isoAt(now + 60_000), warnings: ['background_cleanup_pending'], startupWindowsMs: { background_cleanup_pending: 195_000 }, answeredBy: { ...namedWorker, startedAt: isoAt(now + 59_000), workerStartedAt: isoAt(now + 59_500) } };
  const metAnother = await deliverTransition(otherInstance, runBegun, async () => {}, { owner: 'Synthetic rehearsal operator' });
  const firstAgain = await deliverTransition({ ...sameWorkerLater, observedAt: isoAt(now + 120_000) }, metAnother.state, async () => {}, { owner: 'Synthetic rehearsal operator' });
  assert.deepEqual([metAnother.probe.codes, firstAgain.probe.codes, firstAgain.state.pendingRestarted], [['background_stale'], ['background_stale'], true], 'a run that met another worker stays judged by the run when the first answers again');
  assert.deepEqual((await probeService({ origin: 'https://example.com', now, fetchImpl: fake({ state: 'off' }, 'incomplete') })).codes, ['schema_unready']);
  for (const [label, status, body] of [
    ['malformed JSON', 503, '{"private":"synthetic-private-diagnostic",'],
    ['gateway HTML', 503, '<h1>Unavailable</h1>'],
    ['oversized response', 503, JSON.stringify({ ...readiness('ok', 'incomplete'), extra: 'x'.repeat(256 * 1024) })],
    ['missing checks', 503, JSON.stringify({ status: 'degraded' })],
    ['invalid database state', 503, JSON.stringify(readiness('unknown', 'incomplete'))],
    ['contradictory success', 503, JSON.stringify(readiness())],
    ['unverified schema', 503, JSON.stringify(readiness('ok', 'unchecked'))],
    ['mislabelled failure', 200, JSON.stringify(readiness('ok', 'incomplete'))],
    ['rate limited', 429, JSON.stringify(readiness())],
    ['upstream failure', 502, JSON.stringify(readiness('ok', 'incomplete'))],
  ]) {
    const result = await probeService({ origin: 'https://example.com', now, fetchImpl: async url => url.endsWith('readyz') ? new Response(body, { status }) : new Response(JSON.stringify({ status: 'ok', scheduler: { state: 'off' } })) });
    assert.deepEqual(result.codes, ['database_unready'], label);
    assert.equal(result.observations.database, 'unavailable', label);
    assert.equal(result.observations.schema, 'unverified', label);
    assert.ok(!JSON.stringify(result).includes(body), 'response bodies are never copied into reports');
  }
  const livenessFailure = await probeService({ origin: 'https://example.com', now, fetchImpl: async url => url.endsWith('readyz') ? new Response(JSON.stringify(readiness())) : new Response(JSON.stringify({ status: 'ok' }), { status: 503 }) });
  assert.deepEqual(livenessFailure.codes, ['service_unavailable'], 'only readiness accepts a verified degraded 503 envelope');
  const indexes = await probeService({ origin: 'https://example.com', now, fetchImpl: fake({ state: 'off' }, 'indexes_missing') });
  assert.deepEqual(indexes.codes, []);
  assert.deepEqual(indexes.warnings, ['schema_indexes_missing'], 'a missing performance index is visible without turning readiness into an outage');
  assert.equal((await probeService({ origin: 'https://example.com', expectScheduler: 'external', now, fetchImpl: fake({ state: 'external' }) })).observations.schedulerEvidence, 'mode_only');
  assert.deepEqual([undefined, '', 'on', 'ON', 'external', 'External'].map(schedulerExpectation), [false, false, 'on', 'on', 'external', 'external']);
  assert.throws(() => schedulerExpectation('synthetic-typo'), error => error instanceof MissingSetting && !error.message.includes('synthetic-typo'), 'an expectation the monitor does not know stops it, and is not repeated');
  await assert.rejects(() => sendWebhook(`${origin}/alerts`, {}), /HTTPS/);
  let email;
  await assert.rejects(() => sendEmail(received[0], { apiKey: 'synthetic-secret', from: 'alerts@example.com' }), /recipient/);
  await sendEmail(received[0], { apiKey: 'synthetic-secret', from: 'alerts@example.com', to: 'operations@example.test', fetchImpl: async (url, request) => {
    assert.equal(url, 'https://api.resend.com/emails'); email = JSON.parse(request.body); return new Response('{}');
  } });
  assert.deepEqual(email.to, ['operations@example.test']);
  assert.ok(!JSON.stringify(email).includes('synthetic-secret'));
  const incidentBeforeTest = structuredClone(state);
  const testReceipt = await deliverTest(await probe(), deliver, { owner: 'Synthetic rehearsal operator' });
  assert.equal(received.at(-1).kind, 'test');
  assert.deepEqual(received.at(-1).codes, ['commissioning_test']);
  assert.equal(testReceipt.delivery, 'accepted_by_receiver');
  assert.equal(testReceipt.recipientReceipt, 'unverified');
  assert.equal(testReceipt.incidentState, 'unchanged');
  assert.deepEqual(state, incidentBeforeTest, 'a delivery test cannot clear or create an incident');
  rejectDelivery = true;
  const testProbe = await probe();
  await assert.rejects(() => deliverTest(testProbe, deliver, { owner: 'Synthetic rehearsal operator' }), /Alert delivery failed/);
  rejectDelivery = false;
  await sendEmail(received.at(-1), { apiKey: 'synthetic-secret', from: 'alerts@example.com', to: 'operations@example.test', fetchImpl: async (_url, request) => {
    email = JSON.parse(request.body); return new Response('{}');
  } });
  assert.equal(email.subject, 'Valo Pay: operational alert test');
  assert.match(email.text, /not an incident/);
  assert.match(email.text, /does not prove inbox delivery/);
  assert.throws(() => monitorArguments(['--test-alert']), /requires both/);
  assert.throws(() => monitorArguments(['--deliver', '--deliver']), /repeated/);
  assert.throws(() => monitorArguments(['--test-alert=synthetic-secret']), error => !error.message.includes('synthetic-secret'));
  assert.deepEqual(monitorArguments(['--', '--deliver', '--test-alert']), { deliver: true, testAlert: true });
  assert.equal(deliveryConfiguration({ VALOPAY_MONITOR_OWNER: 'Operator', VALOPAY_MONITOR_ALERT_URL: 'https://alerts.example/receiver' }).status, 'configured');
  assert.equal(deliveryConfiguration({ VALOPAY_MONITOR_OWNER: 'Operator', VALOPAY_MONITOR_ALERT_URL: 'http://alerts.example/receiver' }).status, 'incomplete');
  assert.equal(deliveryConfiguration({ VALOPAY_MONITOR_OWNER: 'Operator', VALOPAY_ALERT_RESEND_KEY: 'synthetic-secret', VALOPAY_ALERT_FROM: 'alerts@example.com', VALOPAY_ALERT_TO: 'operations@example.test' }).status, 'configured');
  await assert.rejects(() => sendEmail(received[0], { apiKey: 'synthetic-secret', from: 'alerts@example.com', to: 'operations@example.test', fetchImpl: async () => { throw new Error('provider secret'); } }), error => !error.message.includes('provider secret'));
  // Started through a symlinked path the monitor still runs: Node gives the module its real path, whatever path started
  // it, and a scheduled monitor that exited silently would never alert.
  const linkDirectory = await mkdtemp(join(tmpdir(), 'valopay-monitor-link-')), linked = join(linkDirectory, 'scripts');
  await symlink(import.meta.dirname, linked, 'junction');
  try {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:VALOPAY_|PAYSTACK_|DATABASE_URL$)/.test(name)));
    const run = spawnSync(process.execPath, [join(linked, 'monitor-valopay.mjs')], { encoding: 'utf8', env: { ...clean, VALOPAY_MONITOR_ORIGIN: 'https://127.0.0.1:1' }, timeout: 30_000 });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^\{"service":"https:\/\/127\.0\.0\.1:1"/, 'started through a symlinked path, the monitor probes rather than exiting silently');
    assert.deepEqual([JSON.parse(run.stdout).mode, JSON.parse(run.stdout).codes], ['dry-run', ['database_unready', 'service_unavailable']]);
  } finally { await unlink(linked); await rm(linkDirectory, { recursive: true, force: true }); }
  console.log('Operational monitor passed: real local HTTP probe/delivery, incident threshold, no repeat, recovery, failed-delivery retry, close failures that stay raised until the failing lender closes (across other lenders\' passes and a restart), overdue closes, public sandboxes\' counted apart as warnings, a process too young to have read giving a warning that neither ends nor repeats an incident, until such warnings have lasted longer than one process can be young (a crash loop, or an instance each probe starts), when they count as stale, each startup warning at its own window and kept for the whole run, so alternating and random subsets open one incident whose codes only grow, a warning judged from the run only once another worker answered, for the rest of the run, the run carried in its incident, a rollback that ends the run, a worker clock ahead by up to a heartbeat and the probe\'s time limit, times copied in ISO form, a file parked for review as its own incident beside failures awaiting a retry, schema readiness, scheduler mode versus execution evidence, the backlog an external host\'s web instances read, explicit labelled delivery tests without incident-state changes, redacted failures, and a run started through a symlinked path.');
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
