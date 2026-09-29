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
/** How long one process can give a startup warning when a probe does not say (startupWindowsMs): two minutes, above the 80 seconds of a first read at a minute. */
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
 * Additive worker evidence: old builds are explicitly not reported; malformed new answers are never healthy. A startup
 * warning comes with its window (startupWindowsMs), how long one process can give it.
 */
function backgroundObservation(health, now, codes, warnings, timeoutMs) {
  const worker = health?.background;
  if (worker === undefined) return { background: 'not_reported' };
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const positive = value => Number.isSafeInteger(value) && value > 0;
  const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
  const nullableInstant = value => value === null || instant(value);
  const states = ['not_started', 'starting', 'running', 'restarting', 'stale', 'stopping', 'stopped'];
  const cleanup = worker?.cleanup, result = cleanup?.lastResult;
  if (!states.includes(worker?.state) || !['closes', 'backlog', 'exports', 'cleanup'].every(key => typeof worker?.jobs?.[key] === 'boolean')
      || !positive(worker.heartbeatIntervalMs) || !positive(worker.staleAfterMs) || worker.staleAfterMs < worker.heartbeatIntervalMs
      || !count(worker.crashCount) || !count(worker.restartCount) || ![worker.startedAt, worker.lastHeartbeatAt, worker.lastCrashAt].every(nullableInstant)
      || !['disabled', 'pending', 'ok', 'failed', 'stale'].includes(cleanup?.state)
      || ![cleanup.lastCheckedAt, cleanup.lastSuccessAt, cleanup.lastErrorAt].every(nullableInstant)
      || !(result === null || count(result?.attempted) && count(result?.removed) && count(result?.deferred) && count(result?.pendingFailures) && (result.parked === undefined || count(result.parked)) && result.removed + result.deferred === result.attempted)
      || (worker.jobs.cleanup ? !positive(cleanup.intervalMs) || !positive(cleanup.staleAfterMs) || cleanup.state === 'disabled' : cleanup.state !== 'disabled' || cleanup.intervalMs !== null || cleanup.staleAfterMs !== null)) {
    codes.push('background_unverified'); return { background: 'unverified' };
  }
  // The worker's clock may run a heartbeat interval ahead, and its answer comes up to the request's time limit after now was read.
  const fresh = (at, within) => instant(at) && now - Date.parse(at) <= within && Date.parse(at) <= now + worker.heartbeatIntervalMs + timeoutMs;
  const pending = {};
  if (worker.state === 'starting' && fresh(worker.startedAt, worker.staleAfterMs)) { warnings.push('background_starting'); pending.background_starting = worker.staleAfterMs; }
  else if (worker.state === 'stale' || worker.state === 'running' && !fresh(worker.lastHeartbeatAt, worker.staleAfterMs)) codes.push('background_stale');
  else if (worker.state !== 'running') codes.push('background_not_running');
  if (worker.jobs.cleanup) {
    if (cleanup.state === 'pending' && fresh(worker.startedAt, cleanup.staleAfterMs)) { warnings.push('background_cleanup_pending'); pending.background_cleanup_pending = cleanup.staleAfterMs; }
    else if (cleanup.state === 'stale' || !fresh(cleanup.lastCheckedAt, cleanup.staleAfterMs)) codes.push('background_cleanup_stale');
    else if (cleanup.state === 'failed') {
      // A file parked for an operator's review, whose identity did not match, is no failed check: no retry changes it,
      // and only a release or re-queue after review ends it. The pass that parks it counts it as deferred, while a
      // failure awaiting a retry is counted in pendingFailures. Any such failure, or a failed check from a build that
      // does not count parked files, is a failed check.
      if (!(result?.parked > 0) || result.pendingFailures > 0) codes.push('background_cleanup_failed');
      if (result?.parked > 0) codes.push('background_cleanup_needs_review');
    }
    else if (cleanup.state !== 'ok' || !result || result.deferred > 0 || result.pendingFailures > 0 || result.parked > 0 || cleanup.lastSuccessAt !== cleanup.lastCheckedAt) codes.push('background_unverified');
  }
  // Any text Date.parse reads is a time, so each time is copied in ISO form.
  const iso = value => value === null ? null : new Date(Date.parse(value)).toISOString();
  return {
    // Rebuild the allowlisted observation instead of reflecting a health body into alert delivery.
    background: { state: worker.state, jobs: Object.fromEntries(['closes', 'backlog', 'exports', 'cleanup'].map(key => [key, worker.jobs[key]])),
      lastHeartbeatAt: iso(worker.lastHeartbeatAt), crashCount: worker.crashCount, restartCount: worker.restartCount, lastCrashAt: iso(worker.lastCrashAt),
      cleanup: { state: cleanup.state, lastCheckedAt: iso(cleanup.lastCheckedAt), lastSuccessAt: iso(cleanup.lastSuccessAt), lastErrorAt: iso(cleanup.lastErrorAt),
        lastResult: result && { attempted: result.attempted, removed: result.removed, deferred: result.deferred, pendingFailures: result.pendingFailures, ...(result.parked === undefined ? {} : { parked: result.parked }) } } },
    ...(Object.keys(pending).length ? { startupWindowsMs: pending, backgroundReadWithinMs: Math.max(...Object.values(pending)) } : {}),
  };
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
  const background = health.status === 'fulfilled' ? backgroundObservation(health.value, now, codes, warnings, timeoutMs) : { background: 'unverified' };
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
  // Each startup warning's window, which the incident rule needs: for a first read, how long a process can be young at
  // the interval it reads at. firstReadWithinMs and backgroundReadWithinMs (the longest worker window) are kept for
  // receivers that read them.
  const startupWindowsMs = { ...background.startupWindowsMs, ...(pending ? { scheduler_backlog_pending: firstReadWithin(Number(health.value.scheduler.intervalMs)) } : {}) };
  return { service: base, observedAt: new Date(now).toISOString(), codes: [...new Set(codes)].sort(), warnings: [...new Set(warnings)],
    ...(pending ? { firstReadWithinMs: startupWindowsMs.scheduler_backlog_pending } : {}),
    ...(background.backgroundReadWithinMs ? { backgroundReadWithinMs: background.backgroundReadWithinMs } : {}),
    ...(Object.keys(startupWindowsMs).length ? { startupWindowsMs } : {}),
    observations: {
      liveness: health.status === 'fulfilled' && health.value?.status === 'ok' ? 'ok' : 'unavailable',
      database: ready.status === 'fulfilled' && ready.value?.checks?.database?.status === 'ok' ? 'ok' : 'unavailable',
      schema: ready.status === 'fulfilled' && ['ok', 'indexes_missing', 'incomplete'].includes(ready.value?.checks?.schema?.status) ? ready.value.checks.schema.status : 'unverified',
      background: background.background,
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

/** The startup warnings, which say a process is too young to have given its evidence, and the code each counts as once no process can be that young. */
const STARTUP_STALE = { scheduler_backlog_pending: 'scheduler_stale', background_starting: 'background_stale', background_cleanup_pending: 'background_cleanup_stale' };
const positiveMs = value => Number.isSafeInteger(value) && value > 0;
/** How long one process can give a startup warning: the probe's window for it, or for a probe that does not say, such as an earlier monitor's, its older limit or two minutes. */
const startupWindow = (probe, warning) => [probe.startupWindowsMs?.[warning], warning === 'scheduler_backlog_pending' ? probe.firstReadWithinMs : probe.backgroundReadWithinMs].find(positiveMs) ?? YOUNG_AT_MOST_MS;

/**
 * Stable incidents suppress repeated delivery; failed delivery never advances state. A probe that found nothing but
 * startup warnings, a process too young to have given its evidence (a first read, heartbeat or cleanup check), is no
 * evidence either way: it neither ends an open incident nor counts towards one, so a restart neither ends nor repeats
 * an incident. But one process can give each warning only so long (its window: startupWindowsMs, or the older limits,
 * or two minutes when the probe does not say), so the state keeps when a run of such probes began (pendingSince) and
 * every startup warning the run has shown, with the window it first came with (pendingWarnings); any other probe ends
 * the run. Once the run has lasted longer than a warning's window, the monitor is meeting a new process at each probe,
 * one restarting before it gave that evidence or an instance the probe itself starts, and the warning counts as its
 * stale code: each such probe is judged by all of them, whichever warnings it caught, so the judged codes only grow
 * within a run. The probe as judged is returned with the state.
 */
export async function deliverTransition(probe, previous, deliver, { owner, failureThreshold = 2 } = {}) {
  if (!owner?.trim() || !Number.isInteger(failureThreshold) || failureThreshold < 1) throw new Error('An alert owner and positive failure threshold are required.');
  const previousForService = previous?.service === probe.service ? previous : {};
  const waiting = Object.keys(STARTUP_STALE).filter(warning => probe.warnings?.includes(warning));
  let judged = probe, run;
  if (!probe.codes.length && waiting.length) {
    const at = Date.parse(probe.observedAt), since = Date.parse(previousForService.pendingSince ?? '');
    const going = Number.isFinite(since) && since <= at;
    const seen = Object.fromEntries(Object.entries(going && previousForService.pendingWarnings || {}).filter(([warning, within]) => Object.hasOwn(STARTUP_STALE, warning) && positiveMs(within)));
    for (const warning of waiting) seen[warning] ??= startupWindow(probe, warning);
    run = { pendingSince: going ? previousForService.pendingSince : probe.observedAt, pendingWarnings: seen };
  }
  const unchanged = { service: probe.service, pending: previousForService.pending ?? '', streak: Number(previousForService.streak || 0), delivered: previousForService.delivered || '', observedAt: probe.observedAt, ...run };
  // A rollback to an older build cannot prove a worker incident has recovered: its probe changes only the run.
  if (!probe.codes.length && probe.observations?.background === 'not_reported' && unchanged.delivered.split('|').some(code => code.startsWith('background_'))) {
    return { state: unchanged, delivered: false, probe };
  }
  if (run) {
    const lasted = Date.parse(probe.observedAt) - Date.parse(run.pendingSince);
    const stale = Object.entries(run.pendingWarnings).filter(([, within]) => lasted > within).map(([warning]) => STARTUP_STALE[warning]).sort();
    if (!stale.length) return { state: unchanged, delivered: false, probe };
    judged = { ...probe, codes: stale, observations: { ...probe.observations, ...(stale.includes('scheduler_stale') ? { schedulerEvidence: 'failed' } : {}) } };
  }
  const signature = judged.codes.join('|');
  const streak = previousForService.pending === signature ? Number(previousForService.streak || 0) + 1 : 1;
  const state = { service: probe.service, pending: signature, streak, delivered: previousForService.delivered || '', observedAt: probe.observedAt, ...run };
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
