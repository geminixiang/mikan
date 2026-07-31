/**
 * The one clock. Every "today", "is it a send day", and "which date does this
 * message belong to" question in agent-pm is answered here, in Asia/Taipei.
 *
 * One module, because the alternative is not hypothetical: a system that
 * answers it per call site ends up with a UTC setting, a hardcoded offset in
 * one feature, the runner's local date in another, and a UTC-derived calendar
 * date in a third. The last one is the expensive kind of wrong — a message
 * posted before 08:00 local is filed under the previous day, so the person is
 * silently counted as having said nothing.
 *
 * Dates are `YYYY-MM-DD` strings in Taipei local time. Instants are ISO 8601
 * strings with an explicit offset. Neither is ever a naive local datetime.
 */
import type { DatabaseSync } from "node:sqlite";
import type { HolidayRow } from "./db.js";

export const TIMEZONE = "Asia/Taipei";

/** A `YYYY-MM-DD` calendar date in Asia/Taipei. */
export type TaipeiDate = string;

const DATE_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The Taipei calendar date containing `instant` (default: now). */
export function taipeiDate(instant: Date = new Date()): TaipeiDate {
  // en-CA formats as YYYY-MM-DD, which is the wire format we store.
  return DATE_PARTS.format(instant);
}

/** The current instant as ISO 8601 with offset — the storage format. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** The Taipei date a Slack `ts` ("1753948800.001200") belongs to. */
export function taipeiDateOfSlackTs(ts: string): TaipeiDate {
  return taipeiDate(new Date(Number(ts.split(".")[0]) * 1000));
}

/** Day of week for a Taipei date: 0 = Sunday … 6 = Saturday. */
export function weekdayOf(date: TaipeiDate): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** Saturday or Sunday, before any compensatory-workday override. */
export function isWeekend(date: TaipeiDate): boolean {
  const day = weekdayOf(date);
  return day === 0 || day === 6;
}

/** `date` shifted by whole days, staying on the Taipei calendar. */
export function addDays(date: TaipeiDate, days: number): TaipeiDate {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** Inclusive list of dates from `from` to `to`. */
export function datesBetween(from: TaipeiDate, to: TaipeiDate): TaipeiDate[] {
  const dates: TaipeiDate[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date);
  return dates;
}

function holidayRow(db: DatabaseSync, date: TaipeiDate): HolidayRow | undefined {
  return db.prepare("SELECT * FROM holidays WHERE date = ?").get(date) as HolidayRow | undefined;
}

/** A Taiwan public holiday (a `workday` row is explicitly not one). */
export function isHoliday(db: DatabaseSync, date: TaipeiDate): boolean {
  return holidayRow(db, date)?.kind === "holiday";
}

/** The name of the holiday on `date`, for the "skipping today" log line. */
export function holidayName(db: DatabaseSync, date: TaipeiDate): string | undefined {
  const row = holidayRow(db, date);
  return row?.kind === "holiday" ? row.name : undefined;
}

/** A compensatory working Saturday — a weekend that must still fire. */
export function isCompensatoryWorkday(db: DatabaseSync, date: TaipeiDate): boolean {
  return holidayRow(db, date)?.kind === "workday";
}

/**
 * Whether a daily job should run: not a holiday, and not a weekend unless the
 * calendar marks it a compensatory workday (which several regions have, and
 * which a plain weekday check gets wrong twice a year). Every scheduled job
 * addressed to people has to agree on this, so it stays one function with one
 * meaning rather than a weekday check copied into each of them.
 */
export function isSendDay(db: DatabaseSync, date: TaipeiDate): boolean {
  if (isHoliday(db, date)) return false;
  if (isWeekend(date) && !isCompensatoryWorkday(db, date)) return false;
  return true;
}

/** The next day that `isSendDay` accepts, searching forward from `date`. */
export function nextBusinessDay(db: DatabaseSync, date: TaipeiDate): TaipeiDate {
  // Bounded so a mis-seeded holiday table cannot spin forever; a fortnight of
  // consecutive non-working days does not occur on the Taiwan calendar.
  for (let offset = 1; offset <= 14; offset++) {
    const candidate = addDays(date, offset);
    if (isSendDay(db, candidate)) return candidate;
  }
  return addDays(date, 1);
}
