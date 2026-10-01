/** Retry policy guardrails (TRD 6.2), execution windows (DEB-01), quiet hours (NOT-04) and the Test 2 design (6.6). */

/** West Africa Time is UTC+1 all year. */
export const WAT_OFFSET_MS = 60 * 60 * 1000;

/** The floors and defaults every retry policy must respect (TRD 6.2). */
export const policyGuardrails = {
  /** Ceiling no policy may exceed, counting external attempts (RET-02). */
  maxAttemptsCeiling: 4,
  defaultMaxAttempts: 3,
  /** Floor for the minimum time between any two attempts, whatever the code. */
  minSpacingHours: 24,
  defaultSpacingHours: 48,
  minFirstNoticeHours: 24,
  defaultFirstNoticeHours: 48,
  /** The failed-debit notice carries the next attempt date; fixed floor, may be lengthened. */
  minRetryNoticeHours: 24,
  defaultRetryNoticeHours: 24,
} as const;

/** Debit execution window in WAT hours: default 06:00–10:00, configurable within 06:00–20:00. */
export const executionWindow = { earliestHour: 6, latestHour: 20, defaultStartHour: 6, defaultEndHour: 10 } as const;

/** Quiet hours for all customer messages, 21:00–08:00 WAT; the adapter refuses sends inside them. */
export const quietHours = { startHour: 21, endHour: 8 } as const;

/** The hour of the day in West Africa Time for an instant. */
export function watHourOf(epochMs: number): number {
  return new Date(epochMs + WAT_OFFSET_MS).getUTCHours();
}
/** True inside the quiet hours, when no customer message may be sent. */
export function withinQuietHours(epochMs: number): boolean {
  const hour = watHourOf(epochMs);
  return hour >= quietHours.startHour || hour < quietHours.endHour;
}
/** An execution-window hour from input, kept within the allowed window; the fallback when the input is not a whole number. */
export function clampExecutionHour(value: unknown, fallback: number): number {
  const hour = Number(value);
  if (!Number.isInteger(hour)) return fallback;
  return Math.min(executionWindow.latestHour, Math.max(executionWindow.earliestHour, hour));
}

/** MAN-05 activation reminder caps by workflow type. */
export const activationReminderCaps = { transfer_to_activate: 4, hosted_consent: 2 } as const;
/** Days a new mandate has to activate before it expires. */
export const DEFAULT_ACTIVATION_WINDOW_DAYS = 7;

/** Section 6.6 experiment design and the pre-registered pass rule (RET-11). */
export const experimentRules = {
  minimumHoldoutShare: 0.1,
  maximumHoldoutShare: 0.5,
  /** Engine minus holdout recovery by value must exceed this. */
  effectPoints: 0.08,
  /** Two-sided 90% interval of the difference must exclude zero (one-sided 5%). */
  confidence: 0.9,
  /** Standard normal quantile for the two-sided 90% interval (one-sided 5%). */
  zScore: 1.6448536269514722,
  power: 0.8,
  outcomeWindowDays: 30,
  enrolmentCloseBeforeAnalysisDays: 30,
} as const;

/** The pre-registered pass rule for the recovery experiment, as written (RET-11). */
export const passRuleText = "For each lender, the automated retry group must recover at least 8 percentage points more by value than the comparison group. The 90% confidence interval for that difference must be above zero. Each group must reach its planned minimum size. Any other result is ‘not proven’.";

/** REC-09 and MEA-05 measurement rules: the monthly precision sample, its interval, the fortnightly review cadence and the Test 5 live-day floor. */
export const measurementRules = {
  precisionSampleSize: 200,
  precisionConfidence: 0.95,
  precisionZScore: 1.959963984540054,
  fortnightDays: 14,
  liveDaysRequired: 60,
  realCasesRequired: 5,
  jobsToConfirm: 4,
} as const;

/** NFR-OBS-02 and NOT-06 alert thresholds; the per-merchant ones are overridable in settings. */
export const alertRules = {
  /** settings.unallocatedAlertThreshold: unallocated Payments older than 24 hours before the alert fires. */
  unallocatedThreshold: 10,
  /** settings.notificationCostAlertKobo: NGN 8 of notification cost per successful collection in a month. */
  notificationCostPerCollectionKobo: 800,
  /** Hours since the last daily close before the books count as not known complete. */
  closeOverdueHours: 36,
} as const;

/**
 * REC-01 and 7.5: the daily close runs at a configurable WAT time, default
 * 07:00.  A close that starts more than `lateAfterMinutes` after its time is
 * late, and a scheduled instant that old with no close is a missed close
 * (NFR-OBS-02).  The in-process scheduler looks for due closes every tick.
 */
export const closeRules = {
  defaultTime: "07:00",
  lateAfterMinutes: 30,
  tickSeconds: 60,
  /** Lenders read per batch; a pass keeps reading batches while the last one was full and its budget remains. */
  batchSize: 25,
  /** A pass starts no new lender's close after this long, so its heartbeat stays well inside the two-minute staleness limit. */
  passBudgetSeconds: 45,
  /**
   * After the n-th failed scheduled attempt at one close time, the next waits
   * min(retryMaxMinutes, retryBaseMinutes × 2^(n−1)) minutes: 2, 4, 8, 16, 32,
   * then hourly.  The close stays pending, and missed after
   * `lateAfterMinutes`, until an attempt succeeds or a person closes.
   */
  retryBaseMinutes: 2,
  retryMaxMinutes: 60,
  /** An anonymous sandbox older than this, with no change by a person within it, has its automatic close paused. */
  idleSandboxDays: 7,
} as const;

const closeTimePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A WAT wall-clock time as HH:MM. */
export function isCloseTime(value: unknown): value is string {
  return typeof value === "string" && closeTimePattern.test(value);
}
/** The merchant's configured close time, or the default when unset or malformed. */
export function closeTimeOf(settings: Record<string, unknown> | undefined): string {
  const value = settings?.closeTime;
  return isCloseTime(value) ? value : closeRules.defaultTime;
}
/** The next instant strictly after `now` whose WAT wall-clock time is `closeTime`, as a UTC ISO timestamp. */
export function nextCloseInstant(now: string | number, closeTime: string = closeRules.defaultTime): string {
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("nextCloseInstant needs a valid instant.");
  const [hour, minute] = (isCloseTime(closeTime) ? closeTime : closeRules.defaultTime).split(":").map(Number) as [number, number];
  const wat = new Date(nowMs + WAT_OFFSET_MS);
  let candidate = Date.UTC(wat.getUTCFullYear(), wat.getUTCMonth(), wat.getUTCDate(), hour, minute) - WAT_OFFSET_MS;
  if (candidate <= nowMs) candidate += DAY_MS;
  return new Date(candidate).toISOString();
}
