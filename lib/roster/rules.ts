import type {
  Assignment,
  EmployeeAvailability,
  Shift,
  WeekdayKey,
  WorkingShift,
} from "../types";
import { WORKING_SHIFTS } from "../types";

/** Every open shift on every day of the week needs this many people. */
export const MIN_HEADCOUNT_PER_SHIFT = 1;

export const SHIFT_LABEL: Record<Shift, string> = {
  AM: "早更",
  PM: "下午更",
  OFF: "休息",
};

export const SHIFT_HOURS: Record<WorkingShift, { start: string; end: string }> = {
  AM: { start: "08:00", end: "16:00" },
  PM: { start: "16:00", end: "00:00" },
};

const WEEKDAY_BY_JS_DAY: WeekdayKey[] = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
];

export function parseISODate(iso: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) {
    throw new Error(`Invalid date: ${iso}`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    throw new Error(`Invalid date: ${iso}`);
  }
  return date;
}

export function formatISODate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isMonday(iso: string): boolean {
  return parseISODate(iso).getDay() === 1;
}

/** Seven ISO dates starting from a Monday. */
export function weekDates(weekStart: string): string[] {
  const start = parseISODate(weekStart);
  if (start.getDay() !== 1) {
    throw new Error(`weekStart must be a Monday: ${weekStart}`);
  }

  return Array.from({ length: 7 }, (_, offset) => {
    const next = new Date(start);
    next.setDate(start.getDate() + offset);
    return formatISODate(next);
  });
}

export function weekdayKeyFromDate(iso: string): WeekdayKey {
  return WEEKDAY_BY_JS_DAY[parseISODate(iso).getDay()];
}

export function isOnLeave(employee: EmployeeAvailability, iso: string): boolean {
  return employee.leave.includes(iso);
}

export function canWork(
  employee: EmployeeAvailability,
  iso: string,
  shift: WorkingShift,
): boolean {
  if (isOnLeave(employee, iso)) {
    return false;
  }
  const shifts = employee.available[weekdayKeyFromDate(iso)] ?? [];
  return shifts.includes(shift);
}

export function shiftsWorked(
  assignments: readonly Assignment[],
  employeeName: string,
): number {
  return assignments.filter((item) => item.employee === employeeName).length;
}

export function warningMessage(iso: string, shift: WorkingShift): string {
  const date = parseISODate(iso);
  return `${date.getMonth() + 1}/${date.getDate()} ${shift} 人手不足`;
}

export function requiredShifts(): readonly WorkingShift[] {
  return WORKING_SHIFTS;
}
