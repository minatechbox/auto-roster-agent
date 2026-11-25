import type {
  Assignment,
  EmployeeAvailability,
  Shift,
  StaffCategory,
  WeekdayKey,
  WorkingShift,
} from "../types";
import { WORKING_SHIFTS } from "../types";

export const STAFF_CONFIG: Record<
  StaffCategory,
  {
    label: string;
    headcount: number;
    dailyHours: number;
    weeklyDays: number;
    weeklyHours: number;
    monthlyRestDays: number;
    slots: string[];
  }
> = {
  full_time: {
    label: "長工(F.T)",
    headcount: 11,
    dailyHours: 10,
    weeklyDays: 6,
    weeklyHours: 60,
    monthlyRestDays: 6,
    slots: ["06:30-16:30", "07:00-17:00", "08:00-18:00", "11:00-21:00", "12:00-22:00"],
  },
  half_full_time: {
    label: "半長工(F.T)",
    headcount: 5,
    dailyHours: 5,
    weeklyDays: 6,
    weeklyHours: 30,
    monthlyRestDays: 6,
    slots: ["07:00-12:00", "17:00-22:00"],
  },
  part_time: {
    label: "兼職(P.T)",
    headcount: 2,
    dailyHours: 4,
    weeklyDays: 7,
    weeklyHours: 28,
    monthlyRestDays: 0,
    slots: ["17:00-22:00"],
  },
};

export const SHIFT_LABEL: Record<Shift, string> = {
  AM: "早更",
  PM: "下午更",
  EVE: "晚更",
  OFF: "休息",
};

export const SHIFT_HOURS: Record<WorkingShift, { start: string; end: string }> = {
  AM: { start: "07:00", end: "17:00" },
  PM: { start: "12:00", end: "22:00" },
  EVE: { start: "17:00", end: "22:00" },
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

/** Week starts on Sunday (JS getDay() === 0). */
export function isWeekStartSunday(iso: string): boolean {
  return parseISODate(iso).getDay() === 0;
}

/** Snap any ISO date back to that week's Sunday. */
export function sundayOnOrBefore(iso: string): string {
  const date = parseISODate(iso);
  date.setDate(date.getDate() - date.getDay());
  return formatISODate(date);
}

/** Seven ISO dates starting from Sunday. */
export function weekDates(weekStart: string): string[] {
  const start = parseISODate(weekStart);
  return Array.from({ length: 7 }, (_, offset) => {
    const next = new Date(start);
    next.setDate(start.getDate() + offset);
    return formatISODate(next);
  });
}

export function weekEndDate(weekStart: string): string {
  return weekDates(weekStart)[6];
}

export function formatWeekRange(weekStart: string): string {
  const start = parseISODate(weekStart);
  const end = parseISODate(weekEndDate(weekStart));
  return `${start.getMonth() + 1}/${start.getDate()}–${end.getMonth() + 1}/${end.getDate()}`;
}

export function weekdayKeyFromDate(iso: string): WeekdayKey {
  return WEEKDAY_BY_JS_DAY[parseISODate(iso).getDay()];
}

export function resolveCategory(employee: EmployeeAvailability): StaffCategory {
  if (employee.category) {
    return employee.category;
  }
  if (Array.isArray(employee.availableDates) && employee.availableDates.length > 0) {
    return "part_time";
  }
  return "full_time";
}

export function hoursForEmployeeShift(
  employee: EmployeeAvailability,
  _shift: WorkingShift,
): number {
  const category = resolveCategory(employee);
  if (category === "full_time") {
    return STAFF_CONFIG.full_time.dailyHours;
  }
  if (category === "half_full_time") {
    return STAFF_CONFIG.half_full_time.dailyHours;
  }
  return STAFF_CONFIG.part_time.dailyHours;
}

export function isOnLeave(employee: EmployeeAvailability, iso: string): boolean {
  return (employee.leave ?? []).includes(iso);
}

export function canWork(
  employee: EmployeeAvailability,
  iso: string,
  shift: WorkingShift,
): boolean {
  const category = resolveCategory(employee);
  if (category === "part_time") {
    const allowedByDate =
      Array.isArray(employee.availableDates) && employee.availableDates.includes(iso);
    const dayShifts = employee.available[weekdayKeyFromDate(iso)] ?? [];
    const allowedByWeekday =
      dayShifts.includes(shift) || (shift === "EVE" && dayShifts.includes("PM"));
    return allowedByDate || allowedByWeekday;
  }

  if (isOnLeave(employee, iso)) {
    return false;
  }
  const dayShifts = employee.available[weekdayKeyFromDate(iso)];
  if (!dayShifts || dayShifts.length === 0) {
    return true;
  }
  return dayShifts.includes(shift) || (shift === "EVE" && dayShifts.includes("PM"));
}

export function shiftsWorked(
  assignments: readonly Assignment[],
  employeeName: string,
): number {
  return assignments.filter((item) => item.employee === employeeName).length;
}

export function hoursWorked(
  assignments: readonly Assignment[],
  employeeName: string,
): number {
  return assignments
    .filter((item) => item.employee === employeeName)
    .reduce((sum, item) => sum + (item.hours ?? 0), 0);
}

export function maxAllowedSalariedOff(salariedCount: number): number {
  return Math.max(1, Math.floor(salariedCount / 6));
}

export function managerActionWarning(
  iso: string,
  shift: WorkingShift,
  requestedOffCount: number,
  maxAllowedOffCount: number,
): string {
  const date = parseISODate(iso);
  return `${date.getMonth() + 1}/${date.getDate()} ${shift} 申請放假人數（${requestedOffCount} 人）超出限定放假人數（${maxAllowedOffCount} 人），請管理員指示！`;
}

export function leaveExcessWarning(
  iso: string,
  requestedOffCount: number,
  maxAllowedOffCount: number,
): string {
  const date = parseISODate(iso);
  return `${date.getMonth() + 1}/${date.getDate()} 放假超額：請假(SH) ${requestedOffCount} 人，上限 ${maxAllowedOffCount} 人，請管理員指示！`;
}

export function requiredShifts(): readonly WorkingShift[] {
  return WORKING_SHIFTS;
}

export type ServicePeriodId =
  | "opening"
  | "breakfast"
  | "lunch"
  | "tea"
  | "dinner"
  | "closing";

export interface ServicePeriodSpec {
  id: ServicePeriodId;
  label: string;
  shortLabel: string;
  startMinutes: number;
  endMinutes: number;
  requiredByDayOfWeek: Record<number, number>; // 0=Sun ... 6=Sat
}

/** 六大營業時段。放假(WH/SH) 喺更表核數另外一欄。 */
export const SERVICE_PERIODS: readonly ServicePeriodSpec[] = [
  {
    id: "opening",
    label: "開檔(0600-0700)",
    shortLabel: "開檔",
    startMinutes: 6 * 60,
    endMinutes: 7 * 60,
    requiredByDayOfWeek: { 0: 2, 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2 },
  },
  {
    id: "breakfast",
    label: "早餐(0700-1130)",
    shortLabel: "早餐",
    startMinutes: 7 * 60,
    endMinutes: 11 * 60 + 30,
    requiredByDayOfWeek: { 0: 6, 1: 6, 2: 6, 3: 6, 4: 6, 5: 6, 6: 6 },
  },
  {
    id: "lunch",
    label: "午市(1130-1400)",
    shortLabel: "午市",
    startMinutes: 11 * 60 + 30,
    endMinutes: 14 * 60,
    requiredByDayOfWeek: { 0: 9, 1: 8, 2: 8, 3: 8, 4: 8, 5: 8, 6: 9 },
  },
  {
    id: "tea",
    label: "下午茶(1400-1700)",
    shortLabel: "下午茶",
    startMinutes: 14 * 60,
    endMinutes: 17 * 60,
    requiredByDayOfWeek: { 0: 7, 1: 6, 2: 6, 3: 6, 4: 6, 5: 6, 6: 7 },
  },
  {
    id: "dinner",
    label: "晚市(1700-2200)",
    shortLabel: "晚市",
    startMinutes: 17 * 60,
    endMinutes: 22 * 60,
    requiredByDayOfWeek: { 0: 7, 1: 7, 2: 7, 3: 7, 4: 7, 5: 8, 6: 9 },
  },
  {
    id: "closing",
    label: "收檔(2200-2300)",
    shortLabel: "收檔",
    startMinutes: 22 * 60,
    endMinutes: 23 * 60,
    requiredByDayOfWeek: { 0: 7, 1: 6, 2: 6, 3: 7, 4: 7, 5: 8, 6: 7 },
  },
];

export const LEAVE_AUDIT_LABEL = "放假(WH/SH)";

function parseHhMmToMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 24 || min < 0 || min >= 60) return null;
  return h * 60 + min;
}

export function getAssignmentWindowMinutes(assignment: Assignment): {
  start: number;
  end: number;
} {
  if (assignment.timeSlot) {
    const parts = assignment.timeSlot.split("-");
    if (parts.length === 2) {
      const s = parseHhMmToMinutes(parts[0]);
      const e = parseHhMmToMinutes(parts[1]);
      if (s !== null && e !== null && e > s) {
        return { start: s, end: e };
      }
    }
  }
  const fallback = SHIFT_HOURS[assignment.shift];
  const s = parseHhMmToMinutes(fallback.start) ?? 7 * 60;
  const e = parseHhMmToMinutes(fallback.end) ?? 17 * 60;
  return { start: s, end: e };
}

export function requiredPeriodHeadcount(
  iso: string,
  period: ServicePeriodSpec,
): number {
  const dow = parseISODate(iso).getDay();
  return period.requiredByDayOfWeek[dow] ?? 0;
}

export function assignmentCoversPeriod(
  assignment: Assignment,
  period: ServicePeriodSpec,
): boolean {
  const win = getAssignmentWindowMinutes(assignment);
  return win.start < period.endMinutes && win.end >= period.startMinutes;
}

export function countStaffInPeriod(
  dateAssignments: readonly Assignment[],
  period: ServicePeriodSpec,
): number {
  const names = new Set<string>();
  for (const item of dateAssignments) {
    if (assignmentCoversPeriod(item, period)) {
      names.add(item.employee);
    }
  }
  return names.size;
}

function formatMinutesAsHhMm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function formatAssignmentTimeLabel(
  assignments: readonly Assignment[],
): string {
  const windows = assignments
    .map((item) => getAssignmentWindowMinutes(item))
    .sort((left, right) => left.start - right.start);
  const merged: { start: number; end: number }[] = [];
  for (const win of windows) {
    const last = merged[merged.length - 1];
    if (last && win.start <= last.end) {
      last.end = Math.max(last.end, win.end);
    } else {
      merged.push({ start: win.start, end: win.end });
    }
  }
  return merged
    .map((win) => `${formatMinutesAsHhMm(win.start)}-${formatMinutesAsHhMm(win.end)}`)
    .join(" / ");
}

export function periodTimeSlot(period: ServicePeriodSpec): string {
  return `${formatMinutesAsHhMm(period.startMinutes)}-${formatMinutesAsHhMm(period.endMinutes)}`;
}

export function periodDurationHours(period: ServicePeriodSpec): number {
  return Math.round(((period.endMinutes - period.startMinutes) / 60) * 10) / 10;
}

export function shiftForPeriod(period: ServicePeriodSpec): WorkingShift {
  if (period.id === "opening" || period.id === "breakfast") return "AM";
  if (period.id === "lunch" || period.id === "tea") return "PM";
  return "EVE";
}

export function assignmentSelectedForPeriod(
  assignment: Assignment,
  period: ServicePeriodSpec,
): boolean {
  if (assignment.timeSlot === periodTimeSlot(period)) return true;
  const win = getAssignmentWindowMinutes(assignment);
  // Midpoint only: 08:00-18:00 must light 下午茶, not also 晚市 (17:00-22:00).
  const mid = (period.startMinutes + period.endMinutes) / 2;
  return win.start <= mid && mid < win.end;
}

export function coveredPeriodIds(
  assignments: readonly Assignment[],
): ServicePeriodId[] {
  return SERVICE_PERIODS.filter((period) =>
    assignments.some((item) => assignmentSelectedForPeriod(item, period)),
  ).map((period) => period.id);
}

export function periodCoverageWarningMessage(
  iso: string,
  periodLabel: string,
  actual: number,
  required: number,
): string {
  const date = parseISODate(iso);
  return `${date.getMonth() + 1}/${date.getDate()} ${periodLabel} 唔夠人返工 ${actual}/${required}`;
}