import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { commissioningReport, writeCommissioningReport } from './commission-operations.mjs';

const probe = {
  service: 'https://example.test', observedAt: '2026-09-26T10:00:00.000Z', codes: [], warnings: [],
  observations: { liveness: 'ok', database: 'ok', schema: 'ok', scheduler: 'running', schedulerEvidence: 'fresh_process_heartbeat', closeBacklog: { overdue: 0, failing: 0 } },
};
const configured = {
  VALOPAY_MONITOR_EXPECT_SCHEDULER: 'on', VALOPAY_OPERATIONS_HOST_MODE: 'reserved-vm',
  VALOPAY_MONITOR_OWNER: 'Synthetic operator', VALOPAY_MONITOR_ALERT_URL: 'https://alerts.example/synthetic-token',
  VALOPAY_MONITOR_STATE_FILE: '/private/monitor-state.json',
};
let report = commissioningReport(probe, configured);
assert.equal(report.status, 'observations_passed_acceptance_required');
assert.deepEqual(report.blockers, []);
assert.equal(report.acceptance.status, 'not_established');
assert.equal(report.configuration.hostMode.evidence, 'operator_setting_not_host_verification');
assert.ok(report.acceptance.pending.includes('test_alert_received_and_acknowledged'));
assert.ok(report.acceptance.pending.includes('isolated_host_database_objects_and_key_recovery'));
assert.ok(!JSON.stringify(report).includes('synthetic-token'), 'a receiver URL is never copied to the report');
assert.ok(!JSON.stringify(report).includes('/private'), 'a private state path is never copied to the report');
assert.deepEqual(report.observations.closeBacklog, { overdue: 0, failing: 0 }, 'the report reads what the scheduler still owes, as counts');

// A lender still owed a close blocks commissioning until it closes; a build that cannot say so blocks it too.
report = commissioningReport({ ...probe, codes: ['scheduler_close_failed', 'scheduler_closes_overdue'], observations: { ...probe.observations, schedulerEvidence: 'failed', closeBacklog: { overdue: 2, failing: 1 } } }, configured);
assert.equal(report.status, 'needs_configuration_or_repair');
assert.deepEqual([report.blockers, report.observations.closeBacklog], [['scheduler_close_failed', 'scheduler_closes_overdue'], { overdue: 2, failing: 1 }]);
report = commissioningReport({ ...probe, warnings: ['scheduler_backlog_not_reported'], observations: { ...probe.observations, closeBacklog: 'not_reported' } }, configured);
assert.deepEqual([report.blockers, report.warnings], [['scheduler_backlog_not_reported'], ['scheduler_backlog_not_reported']], 'a build reporting only its last pass with work cannot evidence close failures');
// Public anonymous sandboxes' own failing or overdue closes are warnings, never blockers.
const visitors = { overdue: 0, failing: 0, publicSandboxes: { overdue: 1, failing: 1 } };
report = commissioningReport({ ...probe, warnings: ['scheduler_public_sandbox_close_failed', 'scheduler_public_sandbox_closes_overdue'], observations: { ...probe.observations, closeBacklog: visitors } }, configured);
assert.deepEqual([report.status, report.blockers, report.warnings, report.observations.closeBacklog], ['observations_passed_acceptance_required', [], ['scheduler_public_sandbox_close_failed', 'scheduler_public_sandbox_closes_overdue'], visitors], 'a visitor\'s sandbox never blocks commissioning');

report = commissioningReport(probe, { ...configured, VALOPAY_OPERATIONS_HOST_MODE: 'autoscale' });
assert.ok(report.blockers.includes('scheduler_stops_when_host_scales_down'), 'a current tick cannot commission an in-process timer on an idle Autoscale host');
// External mode the same way: the counts the web instances read block it, and so does a build that cannot report them.
const external = { ...configured, VALOPAY_MONITOR_EXPECT_SCHEDULER: 'external', VALOPAY_OPERATIONS_HOST_MODE: 'autoscale' };
report = commissioningReport({ ...probe, observations: { ...probe.observations, scheduler: 'external', schedulerEvidence: 'mode_and_fresh_backlog' } }, external);
assert.equal(report.status, 'observations_passed_acceptance_required');
assert.ok(report.acceptance.pending.includes('external_close_job_completion_and_missed_run_detection'), 'external mode is not a heartbeat');
report = commissioningReport({ ...probe, codes: ['scheduler_closes_overdue'], observations: { ...probe.observations, scheduler: 'external', schedulerEvidence: 'failed', closeBacklog: { overdue: 1, failing: 0 } } }, external);
assert.deepEqual([report.blockers, report.observations.closeBacklog], [['scheduler_closes_overdue'], { overdue: 1, failing: 0 }], 'a close the scheduled job has not run blocks commissioning');
report = commissioningReport({ ...probe, warnings: ['scheduler_backlog_not_reported'], observations: { ...probe.observations, scheduler: 'external', schedulerEvidence: 'mode_only', closeBacklog: 'not_reported' } }, external);
assert.deepEqual([report.blockers, report.warnings], [['scheduler_backlog_not_reported'], ['scheduler_backlog_not_reported']], 'an external host whose build reports only its mode cannot evidence a missed run');
report = commissioningReport({ ...probe, codes: ['scheduler_close_failed', 'database_unready'] }, {});
assert.equal(report.status, 'needs_configuration_or_repair');
for (const code of ['scheduler_close_failed', 'database_unready', 'scheduler_expectation_not_configured', 'alert_configuration_incomplete', 'monitor_state_not_configured', 'host_operating_mode_unverified']) assert.ok(report.blockers.includes(code));
assert.deepEqual(report.configuration.notification.missingOrInvalid, ['VALOPAY_MONITOR_OWNER', 'VALOPAY_ALERT_RESEND_KEY', 'VALOPAY_ALERT_FROM', 'VALOPAY_ALERT_TO']);
assert.deepEqual(report.effects, { alertsSent: false, closeRunStarted: false, databaseModified: false, liveOperationsEnabled: false });
assert.throws(() => commissioningReport(probe, { ...configured, VALOPAY_OPERATIONS_HOST_MODE: 'synthetic-secret-typo' }), error => !error.message.includes('synthetic-secret-typo'));

const directory = await mkdtemp(join(tmpdir(), 'valopay-commission-test-'));
try {
  const file = join(directory, 'evidence.json');
  await writeCommissioningReport(file, report);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), report);
  const replacement = commissioningReport(probe, configured);
  await writeCommissioningReport(file, replacement);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), replacement, 'a report replaces the old evidence atomically');
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);

  // Exercise the actual CLI with a closed loopback port. Inherited service keys never reach this child.
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:VALOPAY_|PAYSTACK_|DATABASE_URL$)/.test(name)));
  const run = (args, env = {}) => spawnSync(process.execPath, ['scripts/commission-operations.mjs', ...args], { encoding: 'utf8', env: { ...clean, ...env }, timeout: 15_000 });
  let result = run([], { VALOPAY_MONITOR_ORIGIN: 'https://127.0.0.1:1', VALOPAY_OPERATIONS_REPORT: file });
  assert.equal(result.status, 2, result.stderr);
  const cliReport = JSON.parse(result.stdout);
  assert.ok(cliReport.blockers.includes('service_unavailable'));
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), cliReport);
  result = run([]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /VALOPAY_MONITOR_ORIGIN is required/);
  result = run(['--secret=synthetic-secret']);
  assert.equal(result.status, 1);
  assert.ok(!result.stderr.includes('synthetic-secret'));
  result = run(['--'], { VALOPAY_MONITOR_ORIGIN: 'https://127.0.0.1:1', ...configured });
  assert.equal(result.status, 2);
  assert.ok(!result.stdout.includes('synthetic-token'));
} finally {
  // Only the unique temporary directory this test created is removed.
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(directory.includes('valopay-commission-test-'));
  await rm(directory, { recursive: true, force: true });
}
console.log('Operational commissioning passed: scoped/redacted read-only evidence, configured versus observed versus accepted states, failing and overdue closes as counts, public sandboxes\' as warnings rather than blockers, a build without them, Autoscale scheduling mismatch, external mode\'s backlog and a build without it, unresolved external heartbeat, alert/recovery acceptance, private report replacement and actual CLI failure status.');
