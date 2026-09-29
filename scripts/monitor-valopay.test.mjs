import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
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
  let workerState; const workerEvents = [];
  const workerTransition = async probe => { const result = await deliverTransition(probe, workerState, async event => workerEvents.push(event), { owner: 'Synthetic operator' }); workerState = result.state; return result; };
  await workerTransition(await workerProbe({ ...worker, state: 'restarting' }));
  await workerTransition(await workerProbe({ ...worker, state: 'restarting' }));
  const starting = at => ({ ...worker, state: 'starting', jobs: { ...worker.jobs, cleanup: false }, cleanup: disabledCleanup, startedAt: new Date(at).toISOString(), lastHeartbeatAt: null });
  await workerTransition(await workerProbe(starting(now)));
  assert.deepEqual(workerEvents.map(event => event.kind), ['incident'], 'a restarting worker without its first heartbeat cannot clear an incident');
  await workerTransition(await workerProbe(undefined));
  assert.equal(workerEvents.length, 1, 'a rollback to a build that does not report worker health cannot clear its incident');
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
  console.log('Operational monitor passed: real local HTTP probe/delivery, incident threshold, no repeat, recovery, failed-delivery retry, close failures that stay raised until the failing lender closes (across other lenders\' passes and a restart), overdue closes, public sandboxes\' counted apart as warnings, a process too young to have read giving a warning that neither ends nor repeats an incident, until such warnings have lasted longer than one process can be young (a crash loop, or an instance each probe starts), when they count as stale, schema readiness, scheduler mode versus execution evidence, the backlog an external host\'s web instances read, explicit labelled delivery tests without incident-state changes, redacted failures.');
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
