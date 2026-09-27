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
  const fake = (scheduler, schema = 'ok') => async url => new Response(JSON.stringify(url.endsWith('readyz') ? readiness('ok', schema) : { status: 'ok', scheduler }), { status: url.endsWith('readyz') && schema === 'incomplete' ? 503 : 200 });
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
  assert.deepEqual([unread.codes, unread.observations.closeBacklog], [['scheduler_stale'], 'unverified'], 'nor is a process that has not read it yet');
  // A build from before this reports no backlog in external mode, null or absent: the mode alone, as before, with a warning.
  for (const older of [{ state: 'external', intervalMs: null, ticks: 0, lastTickAt: null, lastRun: null, backlog: null }, { state: 'external', intervalMs: null, ticks: 0, lastTickAt: null, lastRun: null }]) {
    const before = await probeExternal(older);
    assert.deepEqual([before.codes, before.warnings, before.observations.schedulerEvidence, before.observations.closeBacklog], [[], ['scheduler_backlog_not_reported'], 'mode_only', 'not_reported'], 'an older build is the mode alone');
  }
  // Two identical probes open the incident; a restart's first probe, before its first pass, neither ends nor repeats
  // it; the pass after the restart reads the lender again, and only that lender's close sends the recovery.
  const sent = [];
  let incident;
  const watch = async (scheduler) => {
    const result = await deliverTransition(await probeService({ origin: 'https://example.com', expectScheduler: 'on', now, fetchImpl: fake(scheduler) }), incident, async event => { sent.push(event); }, { owner: 'Synthetic rehearsal operator' });
    incident = result.state;
    return result.delivered;
  };
  assert.deepEqual([await watch(current), await watch({ ...current, lastRun: { failed: 0, closed: 1 } })], [false, true], 'two probes open the incident while other lenders close');
  const restarted = { state: 'running', intervalMs: 1000, ticks: 0, lastTickAt: null, lastSuccessAt: null, lastErrorAt: null, lastRun: null, backlog: null };
  assert.deepEqual([await watch(restarted), await watch({ ...restarted, lastSuccessAt: new Date(now).toISOString(), backlog: backlog(1) })], [false, false], 'a restart neither ends nor repeats the incident');
  assert.deepEqual([await watch({ ...current, backlog: backlog(0) }), sent.map(event => [event.kind, event.codes.join()])], [true, [['incident', 'scheduler_close_failed'], ['recovery', '']]], 'the failing lender closing ends it');
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
  console.log('Operational monitor passed: real local HTTP probe/delivery, incident threshold, no repeat, recovery, failed-delivery retry, close failures that stay raised until the failing lender closes (across other lenders\' passes and a restart), overdue closes, public sandboxes\' counted apart as warnings, schema readiness, scheduler mode versus execution evidence, the backlog an external host\'s web instances read, explicit labelled delivery tests without incident-state changes, redacted failures.');
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
