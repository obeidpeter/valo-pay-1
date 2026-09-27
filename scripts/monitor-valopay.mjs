import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 256 * 1024;
export function checkedOrigin(value, allowLocal = false) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Error('Use an HTTPS service origin without credentials, path, query or fragment.');
  }
  return url.origin;
}

/** A degraded readiness answer is diagnostic evidence, never a healthy HTTP response. */
function checkReadiness(value, httpStatus) {
  const database = value?.checks?.database, schema = value?.checks?.schema?.status;
  const ready = database?.status === 'ok' && ['ok', 'indexes_missing'].includes(schema);
  const degraded = (database?.status === 'ok' && schema === 'incomplete') || (database?.status === 'failed' && schema === 'unchecked');
  if (typeof value?.build !== 'string' || !Number.isSafeInteger(database?.latencyMs) || database.latencyMs < 0 ||
      !((httpStatus === 200 && value.status === 'ok' && ready) || (httpStatus === 503 && value.status === 'degraded' && degraded))) throw new Error('Unverified readiness');
  return value;
}

async function readJson(response, readiness = false) {
  if ((!response.ok && !(readiness && response.status === 503)) || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Unavailable');
  }
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) throw new Error('Oversized response');
      chunks.push(value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return readiness ? checkReadiness(value, response.status) : value;
  } finally { await reader.cancel().catch(() => {}); }
}

/**
 * The backlog a health answer's scheduler reports, as counts; undefined when it reports none the monitor can read. A
 * build that counts public anonymous sandboxes apart reports theirs as publicSandboxes; one before it counts them among
 * the lenders.
 */
function backlogCounts(scheduler) {
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const backlog = scheduler?.backlog, sandboxes = backlog?.publicSandboxes;
  if (!count(backlog?.overdue) || !count(backlog?.failing)) return undefined;
  if (sandboxes === undefined) return { overdue: backlog.overdue, failing: backlog.failing };
  return count(sandboxes?.overdue) && count(sandboxes?.failing) ? { overdue: backlog.overdue, failing: backlog.failing, publicSandboxes: { overdue: sandboxes.overdue, failing: sandboxes.failing } } : undefined;
}
/**
 * Whether a health answer's scheduler carries the backlog at all: builds before it report only their last pass with
 * work. In external mode a build reads it itself only since it says how often (intervalMs): one from before reports
 * it null for good.
 */
const reportsBacklog = scheduler => scheduler !== null && typeof scheduler === 'object' && Object.hasOwn(scheduler, 'backlog')
  && (scheduler.state !== 'external' || scheduler.backlog !== null || Number(scheduler.intervalMs) > 0);
/**
 * How long a process may still be waiting for its first read of what is still owed, beyond its first read's delay
 * and one interval: the scheduler's first look, or the read a process makes where a scheduled job runs the closes,
 * comes at most five seconds after its background thread starts, then one each interval (close-scheduler.ts). The
 * margin covers the process and its thread starting.
 */
const FIRST_READ_MARGIN_MS = 15_000;
/** How long a process reading at this interval can be too young to have made its first read: 80 seconds at a minute. */
const firstReadWithin = interval => Math.min(interval, 5_000) + interval + FIRST_READ_MARGIN_MS;
/**
 * Whether the answering process is too young to have made its first read, so that a read it has not made is no
 * evidence yet: its uptime is below its first read's delay, one interval and the margin. False when it does not say.
 */
function awaitingFirstRead(health, interval) {
  const uptime = health?.uptimeSeconds;
  return Number.isSafeInteger(uptime) && uptime >= 0 && Number.isFinite(interval) && interval > 0 && uptime * 1000 < firstReadWithin(interval);
}
/** How long one process can be young when a probe does not say (firstReadWithinMs): two minutes, above the 80 seconds at a minute. */
const YOUNG_AT_MOST_MS = 120_000;
/**
 * The lenders' failing and overdue closes are incidents; public anonymous sandboxes', which a visitor's own synthetic
 * data can cause, are warnings, never incidents.
 */
function raiseBacklog(backlog, codes, warnings) {
  if (backlog?.failing > 0) codes.push('scheduler_close_failed');
  if (backlog?.overdue > 0) codes.push('scheduler_closes_overdue');
  if (backlog?.publicSandboxes?.failing > 0) warnings.push('scheduler_public_sandbox_close_failed');
  if (backlog?.publicSandboxes?.overdue > 0) warnings.push('scheduler_public_sandbox_closes_overdue');
}

/**
 * One probe, no customer records, no log bodies, no provider requests. `expectScheduler`: true or 'on' expects the
 * API process to run the scheduled closes with a fresh successful check; 'external' expects it to leave them to a
 * separate scheduled job and say so (VALOPAY_CLOSE_SCHEDULER=external), since off would hide missed closes, and to
 * report a fresh read of what is still owed. Either way no lender's close may be failing or overdue.
 */
export async function probeService({ origin, expectScheduler = false, fetchImpl = fetch, now = Date.now(), allowLocal = false, timeoutMs = 8000 }) {
  const base = checkedOrigin(origin, allowLocal);
  const get = async path => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try { return await readJson(await fetchImpl(`${base}${path}`, { signal: abort.signal, redirect: 'error', headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } }), path === '/api/readyz'); }
    finally { clearTimeout(timer); }
  };
  const [health, ready] = await Promise.allSettled([get('/api/healthz'), get('/api/readyz')]);
  const codes = [];
  const warnings = [];
  if (health.status !== 'fulfilled' || health.value?.status !== 'ok') codes.push('service_unavailable');
  if (ready.status !== 'fulfilled' || ready.value?.checks?.database?.status !== 'ok') codes.push('database_unready');
  if (ready.status === 'fulfilled' && ready.value?.checks?.database?.status === 'ok') {
    if (ready.value?.checks?.schema?.status === 'indexes_missing') warnings.push('schema_indexes_missing');
    else if (ready.value?.checks?.schema?.status !== 'ok') codes.push('schema_unready');
  }
  if (expectScheduler === 'external' && health.status === 'fulfilled') {
    // The job's own runs are not visible here: they show in its run history and its close.one_shot lines. Each web
    // instance reads what is still owed at the scheduler's interval instead, so a job that has stopped running shows
    // as overdue closes; a read older than three intervals is no evidence, like a stale heartbeat, and nor is a missing
    // one, unless the process is too young to have made it yet, which is a warning.
    const scheduler = health.value?.scheduler;
    if (scheduler?.state !== 'external') codes.push('scheduler_not_external');
    else if (reportsBacklog(scheduler)) {
      const interval = Number(scheduler.intervalMs), checkedAt = Date.parse(scheduler.backlog?.checkedAt || ''), backlog = backlogCounts(scheduler);
      if (scheduler.backlog === null && awaitingFirstRead(health.value, interval)) warnings.push('scheduler_backlog_pending');
      else if (!backlog || !Number.isFinite(interval) || interval <= 0 || !Number.isFinite(checkedAt) || now - checkedAt > 3 * interval || checkedAt > now + interval) codes.push('scheduler_stale');
      raiseBacklog(backlog, codes, warnings);
    } else warnings.push('scheduler_backlog_not_reported');
  } else if (expectScheduler && health.status === 'fulfilled') {
    const scheduler = health.value?.scheduler;
    const interval = Number(scheduler?.intervalMs);
    const successAt = Date.parse(scheduler?.lastSuccessAt || '');
    const failedAt = Date.parse(scheduler?.lastErrorAt || '');
    // Before its first pass has returned, a process too young for that to have happened has no heartbeat yet, as a web
    // instance of an external host has no read: a warning. An older one without a pass, or an old heartbeat, is stale.
    const young = awaitingFirstRead(health.value, interval);
    if (scheduler?.state !== 'running') codes.push('scheduler_not_running');
    else if (!Number.isFinite(successAt) && young) warnings.push('scheduler_backlog_pending');
    else if (!Number.isFinite(interval) || interval <= 0 || !Number.isFinite(successAt) || now - successAt > 3 * interval || successAt > now + interval) codes.push('scheduler_stale');
    else if (Number.isFinite(failedAt) && failedAt >= successAt) codes.push('scheduler_failed');
    // A pass can finish successfully while individual lenders failed. Each pass reads what is still owed from the
    // database, so a lender whose close failed stays counted until its own close succeeds, whatever other lenders'
    // passes do and across a restart; a close more than its grace past its time is overdue, whoever holds it.
    const backlog = backlogCounts(scheduler);
    if (reportsBacklog(scheduler)) {
      // Null until a restarted process's first pass, which the heartbeat checks above name; otherwise no evidence.
      if (!backlog && !codes.some(code => code.startsWith('scheduler_'))) {
        if (scheduler.backlog === null && young) warnings.push('scheduler_backlog_pending'); else codes.push('scheduler_stale');
      }
      raiseBacklog(backlog, codes, warnings);
    } else if (scheduler !== null && typeof scheduler === 'object') {
      // A build from before the backlog: its last pass with work is kept across quiet ticks, but a later pass with work replaces it.
      warnings.push('scheduler_backlog_not_reported');
      if (Number.isSafeInteger(scheduler.lastRun?.failed) && scheduler.lastRun.failed > 0) codes.push('scheduler_close_failed');
    }
  }
  const schedulerStates = ['not_started', 'running', 'off', 'external', 'stopped'];
  // In external mode the monitor saw the backlog only from a build that reads it; from one before, the mode alone.
  const sawBacklog = health.status === 'fulfilled' && health.value?.scheduler?.state === 'external' && reportsBacklog(health.value.scheduler);
  const pending = warnings.includes('scheduler_backlog_pending');
  return { service: base, observedAt: new Date(now).toISOString(), codes: [...new Set(codes)].sort(), warnings: [...new Set(warnings)],
    // With that warning, how long a process can be young at the interval it reads at, which the incident rule needs.
    ...(pending ? { firstReadWithinMs: firstReadWithin(Number(health.value.scheduler.intervalMs)) } : {}),
    observations: {
      liveness: health.status === 'fulfilled' && health.value?.status === 'ok' ? 'ok' : 'unavailable',
      database: ready.status === 'fulfilled' && ready.value?.checks?.database?.status === 'ok' ? 'ok' : 'unavailable',
      schema: ready.status === 'fulfilled' && ['ok', 'indexes_missing', 'incomplete'].includes(ready.value?.checks?.schema?.status) ? ready.value.checks.schema.status : 'unverified',
      scheduler: schedulerStates.includes(health.value?.scheduler?.state) ? health.value.scheduler.state : 'unverified',
      schedulerEvidence: !expectScheduler ? 'not_requested' : expectScheduler === 'external' && !sawBacklog ? 'mode_only'
        : codes.some(code => code.startsWith('scheduler_')) || health.status !== 'fulfilled' ? 'failed' : pending ? 'first_read_pending'
        : expectScheduler === 'external' ? 'mode_and_fresh_backlog' : 'fresh_process_heartbeat',
      // Counts only, never a lender: what the process last read as still owed, public sandboxes apart.
      closeBacklog: !expectScheduler ? 'not_requested' : backlogCounts(health.value?.scheduler)
        ?? (health.status === 'fulfilled' && health.value?.scheduler !== null && typeof health.value?.scheduler === 'object' && !reportsBacklog(health.value.scheduler) ? 'not_reported' : pending ? 'pending' : 'unverified'),
    },
  };
}

/**
 * Stable incidents suppress repeated delivery; failed delivery never advances state. A probe that found nothing but a
 * process too young to have read what is still owed (scheduler_backlog_pending) is no evidence either way: it neither
 * ends an open incident nor counts towards one, so a restart neither ends nor repeats an incident. But one process is
 * young only so long (firstReadWithinMs, or two minutes when the probe does not say), so the state keeps when a run of
 * such probes began (pendingSince), and any other probe ends the run: once it has lasted longer than that, the monitor
 * is meeting a new process at each probe, one restarting before its first read or an instance the probe itself starts,
 * and each such probe counts as scheduler_stale. The probe as judged is returned with the state.
 */
export async function deliverTransition(probe, previous, deliver, { owner, failureThreshold = 2 } = {}) {
  if (!owner?.trim() || !Number.isInteger(failureThreshold) || failureThreshold < 1) throw new Error('An alert owner and positive failure threshold are required.');
  const previousForService = previous?.service === probe.service ? previous : {};
  let judged = probe, pendingSince;
  if (!probe.codes.length && probe.warnings?.includes('scheduler_backlog_pending')) {
    const at = Date.parse(probe.observedAt), since = Date.parse(previousForService.pendingSince ?? '');
    pendingSince = Number.isFinite(since) && since <= at ? previousForService.pendingSince : probe.observedAt;
    const youngAtMost = Number.isSafeInteger(probe.firstReadWithinMs) && probe.firstReadWithinMs > 0 ? probe.firstReadWithinMs : YOUNG_AT_MOST_MS;
    if (!(at - Date.parse(pendingSince) > youngAtMost)) {
      return { state: { service: probe.service, pending: previousForService.pending ?? '', streak: Number(previousForService.streak || 0), delivered: previousForService.delivered || '', observedAt: probe.observedAt, pendingSince }, delivered: false, probe };
    }
    judged = { ...probe, codes: ['scheduler_stale'], observations: { ...probe.observations, schedulerEvidence: 'failed' } };
  }
  const signature = judged.codes.join('|');
  const streak = previousForService.pending === signature ? Number(previousForService.streak || 0) + 1 : 1;
  const state = { service: probe.service, pending: signature, streak, delivered: previousForService.delivered || '', observedAt: probe.observedAt, ...(pendingSince ? { pendingSince } : {}) };
  if (signature === state.delivered || (signature && streak < failureThreshold)) return { state, delivered: false, probe: judged };
  const event = { version: 1, kind: signature ? 'incident' : 'recovery', owner, ...judged };
  await deliver(event);
  state.delivered = signature;
  return { state, delivered: true, probe: judged };
}

export async function sendWebhook(urlText, event, { fetchImpl = fetch, allowLocal = false, timeoutMs = 8000 } = {}) {
  const url = new URL(urlText);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('The alert receiver must use HTTPS.');
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const result = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: abort.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) });
    await result.body?.cancel();
    if (!result.ok) throw new Error('Delivery failed');
  } catch { throw new Error('Alert delivery failed; the incident will be retried.'); }
  finally { clearTimeout(timer); }
}

export async function sendEmail(event, { apiKey, from, to, fetchImpl = fetch, timeoutMs = 8000 }) {
  const address = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
  if (!apiKey || !address.test(from || '') || !address.test(to || '')) throw new Error('Email delivery needs a configured provider, verified sender and recipient.');
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetchImpl('https://api.resend.com/emails', { method: 'POST', redirect: 'error', signal: abort.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject: `Valo Pay: ${event.kind === 'test' ? 'operational alert test' : event.kind === 'recovery' ? 'service recovered' : 'operational alert'}`,
        text: `${event.kind === 'test' ? 'This is an authorised delivery test, not an incident. Confirm receipt with the operator; provider acceptance alone does not prove inbox delivery.\n\n' : ''}Service: ${event.service}\nChecked: ${event.observedAt}\nState: ${event.kind}\nChecks: ${event.codes.join(', ') || 'healthy'}\nOwner: ${event.owner}\n\nNo customer records or credentials are included. Check the operating runbook before changing service settings.` }) });
    await response.body?.cancel();
    if (!response.ok) throw new Error('Email not accepted');
  } catch { throw new Error('Email delivery was not accepted; the incident will be retried.'); }
  finally { clearTimeout(timer); }
}

const USAGE = 'Use: pnpm run check:operations [--deliver] [--test-alert], with the origin and receiver in the environment (docs/operational-rehearsals.md).';
/** A mistake on the command line, described in its own words. */
export class UsageError extends Error {}
/** A setting the monitor cannot run without, or cannot read, named but never shown with a value. */
export class MissingSetting extends Error {}
/**
 * What VALOPAY_MONITOR_EXPECT_SCHEDULER asks of the probed host's scheduler, in any case: 'on', 'external', or
 * nothing when unset. Any other value stops the monitor rather than checking nothing, since a mistyped expectation
 * would otherwise go unnoticed.
 */
export function schedulerExpectation(value) {
  if (value === undefined || value === '') return false;
  const expected = value.toLowerCase();
  if (expected === 'on' || expected === 'external') return expected;
  throw new MissingSetting('VALOPAY_MONITOR_EXPECT_SCHEDULER must be on or external when it is set (docs/operational-rehearsals.md).');
}
/** Delivery is opt-in. A test needs both flags, is labelled as a test and never changes incident history. */
export function monitorArguments(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  for (const [index, arg] of args.entries()) {
    // An option is named, but not a value given with it (--name=value), which could be a credential.
    const option = /^(--?[A-Za-z][\w-]{0,40})(=?)/.exec(arg), named = option && (option[2] || option[0] === arg) ? option[1] : undefined;
    if (!['--deliver', '--test-alert'].includes(arg)) throw new UsageError(named ? `${['--deliver', '--test-alert'].includes(named) ? `The option ${named} takes no value` : `Unknown option ${named}`}${option[2] ? ' (its value is not repeated here)' : ''}.` : `Argument ${index + 1} is not an option (not repeated here, in case it is a credential).`);
    if (args.indexOf(arg) !== index) throw new UsageError(`The option ${arg} was repeated.`);
  }
  if (args.includes('--test-alert') && !args.includes('--deliver')) throw new UsageError('A test alert requires both --deliver and --test-alert.');
  return { deliver: args.includes('--deliver'), testAlert: args.includes('--test-alert') };
}

/** Inspect setting presence and syntax without exposing credentials or contacting the delivery service. */
export function deliveryConfiguration(env) {
  const missing = [];
  const address = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
  const adapter = env.VALOPAY_MONITOR_ALERT_URL ? 'webhook' : 'email';
  if (!env.VALOPAY_MONITOR_OWNER?.trim()) missing.push('VALOPAY_MONITOR_OWNER');
  if (adapter === 'webhook') {
    try {
      const url = new URL(env.VALOPAY_MONITOR_ALERT_URL);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) missing.push('VALOPAY_MONITOR_ALERT_URL');
    } catch { missing.push('VALOPAY_MONITOR_ALERT_URL'); }
  } else {
    if (!env.VALOPAY_ALERT_RESEND_KEY?.trim()) missing.push('VALOPAY_ALERT_RESEND_KEY');
    if (!address.test(env.VALOPAY_ALERT_FROM || '')) missing.push('VALOPAY_ALERT_FROM');
    if (!address.test(env.VALOPAY_ALERT_TO || '')) missing.push('VALOPAY_ALERT_TO');
  }
  return { adapter, status: missing.length ? 'incomplete' : 'configured', missingOrInvalid: missing };
}

/** A single labelled test, with no incident threshold, incident state read or incident state write. */
export async function deliverTest(probe, deliver, { owner } = {}) {
  if (!owner?.trim()) throw new Error('An alert owner is required.');
  await deliver({ version: 1, kind: 'test', owner, service: probe.service, observedAt: probe.observedAt, codes: ['commissioning_test'] });
  return { service: probe.service, observedAt: probe.observedAt, mode: 'test-alert', delivery: 'accepted_by_receiver', recipientReceipt: 'unverified', incidentState: 'unchanged' };
}

async function main() {
  const { deliver, testAlert } = monitorArguments(process.argv.slice(2));
  const origin = process.env.VALOPAY_MONITOR_ORIGIN;
  if (!origin) throw new MissingSetting('VALOPAY_MONITOR_ORIGIN is not set: set it to the HTTPS origin of the service to probe (docs/operational-rehearsals.md).');
  const probe = await probeService({ origin, expectScheduler: schedulerExpectation(process.env.VALOPAY_MONITOR_EXPECT_SCHEDULER) });
  if (!deliver) { console.log(JSON.stringify({ ...probe, mode: 'dry-run', delivery: 'not attempted' })); return; }
  const receiver = process.env.VALOPAY_MONITOR_ALERT_URL;
  const owner = process.env.VALOPAY_MONITOR_OWNER;
  const statePath = process.env.VALOPAY_MONITOR_STATE_FILE;
  const emailKey = process.env.VALOPAY_ALERT_RESEND_KEY;
  const sender = process.env.VALOPAY_ALERT_FROM;
  const recipient = process.env.VALOPAY_ALERT_TO;
  if (deliveryConfiguration(process.env).status !== 'configured' || (!testAlert && !statePath)) throw new Error('Configure a receiver or email provider with sender and recipient, alert owner and monitor state file.');
  const send = event => receiver ? sendWebhook(receiver, event) : sendEmail(event, { apiKey: emailKey, from: sender, to: recipient });
  if (testAlert) { console.log(JSON.stringify(await deliverTest(probe, send, { owner }))); return; }
  const target = resolve(statePath);
  let previous;
  try { previous = JSON.parse(await readFile(target, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('The monitor state could not be read; refusing to reset incident history.'); }
  const result = await deliverTransition(probe, previous, send, { owner });
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.next`;
  await writeFile(temporary, JSON.stringify(result.state), { mode: 0o600 });
  await rename(temporary, target);
  console.log(JSON.stringify({ ...result.probe, delivered: result.delivered }));
}
// Only a usage mistake or a missing origin is described: any other failure could carry a receiver address, a key or a response body.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error instanceof UsageError ? `${error.message} ${USAGE}` : error instanceof MissingSetting ? error.message : 'Operational monitoring failed. Check configuration, probe connectivity and the alert receiver. Credentials and response bodies are not logged.'); process.exitCode = 1; });
