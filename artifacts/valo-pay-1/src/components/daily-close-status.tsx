import { closeRules } from '@workspace/valo-pay-1-schema';
import { formatCount, formatDate } from '@/lib/formatters';

/** Reports carry free-form operational data; missing status must never imply a running service. */
export function DailyCloseStatus({ value, showHistory = false }: { value: unknown; showHistory?: boolean }) {
  const schedule = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  let message = 'Automatic daily close status is not available. Refresh this page, or run a daily close on Reports.';
  let warning = false;
  if (schedule) {
    if (schedule.enabled === false) {
      message = typeof schedule.pausedForInactivityAt === 'string'
        ? `Automatic daily closes were paused on ${formatDate(schedule.pausedForInactivityAt)} because nothing changed in this sandbox for ${formatCount(closeRules.idleSandboxDays, 'day')}. Switch them on again in Settings, or run a daily close on Reports.`
        : 'Automatic daily closes are off for this lender. Run a daily close on Reports when you need one.';
    } else if (schedule.runtimeState === 'off') message = 'Automatic daily closes are switched off in Valo Pay 1. Run a daily close on Reports when you need one.';
    // A separate scheduled job runs the closes: this service cannot see when it runs next, but a close it missed is still missed.
    else if (schedule.runtimeState === 'external') {
      if (schedule.missed === true) {
        message = `The ${schedule.time} WAT daily close did not run for this lender. It is ${formatCount(Number(schedule.overdueMinutes), 'minute')} late. Run a daily close on Reports. If this keeps happening, contact the Valo Pay 1 team.`;
        warning = true;
      } else message = 'Daily closes run automatically on a schedule.';
    } else if (schedule.runtimeState === 'stopped' || schedule.runtimeState === 'not_started') {
      message = 'Automatic daily closes are not running. Run a daily close on Reports until they start again.';
      warning = true;
    } else if (schedule.serviceIssue === 'failed' || schedule.serviceIssue === 'delayed') {
      message = schedule.serviceIssue === 'failed'
        ? 'Automatic daily closes could not finish their latest check. Run a daily close on Reports. If this keeps happening, contact the Valo Pay 1 team.'
        : 'Automatic daily closes have stopped checking on time. Run a daily close on Reports. If this keeps happening, contact the Valo Pay 1 team.';
      warning = true;
    } else if (schedule.serviceIssue === 'starting') message = 'Automatic daily closes are starting. The next run is not confirmed yet.';
    else if (schedule.automatic === true && Number(schedule.failedAttempts) > 0 && typeof schedule.retryAt === 'string') {
      message = `The automatic daily close for this lender failed ${formatCount(Number(schedule.failedAttempts), 'time')}. Next attempt: ${formatDate(schedule.retryAt)}. Run a daily close on Reports. If it fails again, contact the Valo Pay 1 team.`;
      warning = true;
    } else if (schedule.automatic === true && schedule.missed === true) {
      message = `The ${schedule.time} WAT daily close did not run. It is ${formatCount(Number(schedule.overdueMinutes), 'minute')} late. Run a daily close on Reports. If this keeps happening, contact the Valo Pay 1 team.`;
      warning = true;
    } else if (schedule.automatic === true && Number(schedule.overdueMinutes) > 0 && typeof schedule.nextAt === 'string') {
      message = `The daily close was due ${formatDate(schedule.nextAt)}. Valo Pay 1 is waiting for the automatic close. You can also run a daily close on Reports.`;
    } else if (schedule.automatic === true && typeof schedule.nextAt === 'string') {
      message = `Next daily close: ${formatDate(schedule.nextAt)}, then every day at this time.`;
    }
  }
  return <div className="space-y-1 text-xs">
    <p className={warning ? 'font-medium text-destructive' : 'text-muted-foreground'}>{message}</p>
    {showHistory && <p className="text-muted-foreground">Last daily close: {typeof schedule?.lastAt === 'string' ? `${formatDate(schedule.lastAt)} (${schedule.lastTrigger === 'scheduled' ? 'started automatically' : 'run by hand'})` : 'Not closed yet'}.</p>}
    {typeof schedule?.lastCheckedAt === 'string' && <p className="text-muted-foreground">Automatic closes last checked: {formatDate(schedule.lastCheckedAt)}.</p>}
    {schedule?.serviceIssue === 'failed' && typeof schedule.lastErrorAt === 'string' && <p className="text-muted-foreground">Last failed check: {formatDate(schedule.lastErrorAt)}.</p>}
  </div>;
}
