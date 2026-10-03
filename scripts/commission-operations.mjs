import { realpathSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { deliveryConfiguration, MissingSetting, probeService, schedulerExpectation } from './monitor-valo-pay-1.mjs';

/** Read-only commissioning evidence. Presence, HTTP observations and operational acceptance stay separate. */
export function commissioningReport(probe, env) {
  const expected = schedulerExpectation(env.VALO_PAY_1_MONITOR_EXPECT_SCHEDULER);
  const hostMode = env.VALO_PAY_1_OPERATIONS_HOST_MODE || 'unverified';
  if (!['unverified', 'reserved-vm', 'autoscale', 'other'].includes(hostMode)) throw new MissingSetting('VALO_PAY_1_OPERATIONS_HOST_MODE must be reserved-vm, autoscale or other when set.');
  const delivery = deliveryConfiguration(env);
  const blockers = [...probe.codes];
  if (!expected) blockers.push('scheduler_expectation_not_configured');
  if (expected === 'on' && hostMode === 'autoscale') blockers.push('scheduler_stops_when_host_scales_down');
  // A build that does not report what is still owed shows a failed close only until a later pass with work replaces it,
  // and on a host whose closes a scheduled job runs, it shows only the mode: a job that stopped running goes unseen.
  if (expected && probe.observations?.closeBacklog === 'not_reported') blockers.push('scheduler_backlog_not_reported');
  // A process too young to have read what is still owed has given no scheduler evidence yet, such as an instance the
  // check itself started on Autoscale: the check is run again once it has read.
  if (expected && probe.observations?.closeBacklog === 'pending') blockers.push('scheduler_backlog_pending');
  // Worker evidence is independent of close scheduling. An old build or a first check still pending cannot prove it.
  const background = probe.observations?.background;
  if (!background || background === 'not_reported') blockers.push('background_not_reported');
  if (background === 'unverified') blockers.push('background_unverified');
  for (const warning of ['background_starting', 'background_cleanup_pending']) if (probe.warnings?.includes(warning)) blockers.push(warning);
  if (hostMode === 'unverified') blockers.push('host_operating_mode_unverified');
  if (delivery.status !== 'configured') blockers.push('alert_configuration_incomplete');
  if (!env.VALO_PAY_1_MONITOR_STATE_FILE?.trim()) blockers.push('monitor_state_not_configured');
  const pendingAcceptance = [
    'independent_monitor_schedule_and_state_durability',
    'test_alert_received_and_acknowledged',
    'isolated_host_database_objects_and_key_recovery',
    'close_failure_and_recovery_rehearsal',
  ];
  if (expected === 'external') pendingAcceptance.unshift('external_close_job_completion_and_missed_run_detection');
  return {
    version: 1, kind: 'operational_commissioning', service: probe.service, observedAt: probe.observedAt,
    status: blockers.length ? 'needs_configuration_or_repair' : 'observations_passed_acceptance_required',
    configuration: {
      hostMode: { value: hostMode, evidence: 'operator_setting_not_host_verification' },
      expectedScheduler: expected || 'not_configured',
      notification: delivery,
      incidentState: env.VALO_PAY_1_MONITOR_STATE_FILE?.trim() ? 'path_configured_durability_unverified' : 'not_configured',
    },
    observations: probe.observations,
    blockers: [...new Set(blockers)].sort(), warnings: probe.warnings || [],
    acceptance: { status: 'not_established', pending: pendingAcceptance },
    effects: { alertsSent: false, closeRunStarted: false, databaseModified: false, liveOperationsEnabled: false },
  };
}

/** A private report, replaced atomically. This is evidence of observations, never an activation instruction. */
export async function writeCommissioningReport(path, report) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.next`;
  try {
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function main() {
  const args = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === '--'));
  if (args.length) throw new Error('This command takes no arguments.');
  if (!process.env.VALO_PAY_1_MONITOR_ORIGIN) throw new MissingSetting('VALO_PAY_1_MONITOR_ORIGIN is required for the read-only commissioning check.');
  const expected = schedulerExpectation(process.env.VALO_PAY_1_MONITOR_EXPECT_SCHEDULER);
  const probe = await probeService({ origin: process.env.VALO_PAY_1_MONITOR_ORIGIN, expectScheduler: expected });
  const report = commissioningReport(probe, process.env);
  if (process.env.VALO_PAY_1_OPERATIONS_REPORT) await writeCommissioningReport(process.env.VALO_PAY_1_OPERATIONS_REPORT, report);
  console.log(JSON.stringify(report));
  // 2 is a completed check that found work to do; 1 means no usable report could be produced.
  process.exitCode = report.blockers.length ? 2 : 0;
}

// Real paths: started through a symlinked path, argv names the link while this module's URL names the file, and the
// check would exit without a report.
const startedDirectly = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (startedDirectly()) main().catch(error => {
  console.error(error instanceof MissingSetting ? error.message : 'Operational commissioning check failed. Check settings, connectivity and the private report path. Values and response bodies are not logged.');
  process.exitCode = 1;
});
