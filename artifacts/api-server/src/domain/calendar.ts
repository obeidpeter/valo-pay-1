import { WAT_OFFSET_MS } from "@workspace/valo-pay-1-schema";
import type { DomainState } from "./types";
import { recordsOfKind } from "./record-index";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Calendar date (YYYY-MM-DD) of an instant in West Africa Time. */
export function watDate(epochMs: number): string {
  return new Date(epochMs + WAT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Calendar month (YYYY-MM) of an instant in West Africa Time; a value that is not a date keeps its first seven characters. */
export function watMonth(value: string | number): string {
  const time = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(time) ? new Date(time + WAT_OFFSET_MS).toISOString().slice(0, 7) : String(value).slice(0, 7);
}

/** The instant a YYYY-MM month starts: midnight West Africa Time on the 1st, 23:00 UTC the day before. */
export function watMonthStart(period: string): number {
  const [year, month] = period.split("-").map(Number);
  return Date.UTC(year!, month! - 1, 1) - WAT_OFFSET_MS;
}

/** Nigerian public holidays and non-banking days are data (SCH-04), one calendar record per date. */
export function holidaySet(state: DomainState): Set<string> {
  return new Set(recordsOfKind(state, "calendar").map((record) => String(record.data.date)));
}

/** Monday to Friday in WAT, excluding the holiday table. */
export function isBusinessDay(epochMs: number, holidays: Set<string>): boolean {
  const wat = new Date(epochMs + WAT_OFFSET_MS);
  const weekday = wat.getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays.has(wat.toISOString().slice(0, 10));
}

/** The same time of day, `days` business days after `fromIso`; used for exception deadlines (EXC-02). */
export function addBusinessDays(state: DomainState, fromIso: string, days: number): string {
  const holidays = holidaySet(state);
  let time = Date.parse(fromIso);
  let remaining = Math.max(0, Math.floor(days));
  while (remaining > 0) {
    time += DAY_MS;
    if (isBusinessDay(time, holidays)) remaining -= 1;
  }
  return new Date(time).toISOString();
}

/** The weekend days and holidays a plan skipped between two instants, recorded on the decision (RET-03). */
export function nonBusinessDaysBetween(state: DomainState, fromMs: number, toMs: number): { weekendDaysSkipped: string[]; holidaysApplied: string[] } {
  const holidays = holidaySet(state);
  const weekendDaysSkipped: string[] = [], holidaysApplied: string[] = [];
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return { weekendDaysSkipped, holidaysApplied };
  for (let time = fromMs; time < toMs && weekendDaysSkipped.length + holidaysApplied.length < 60; time += DAY_MS) {
    const date = watDate(time);
    if (holidays.has(date)) holidaysApplied.push(date);
    else if ([0, 6].includes(new Date(time + WAT_OFFSET_MS).getUTCDay())) weekendDaysSkipped.push(date);
  }
  return { weekendDaysSkipped, holidaysApplied };
}
