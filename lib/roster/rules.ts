import type {
  Assignment,
  Employee,
  EmployeeAvailability,
  EmploymentType,
  LeaveEntry,
  RosterRules,
  ServicePeriodKey,
  ShiftTimeSlot,
  StaffCategory,
  WeekdayKey,
  WorkingShift,
} from "../types";
import {
  EMPLOYMENT_BY_STAFF_CATEGORY,
  SERVICE_PERIOD_IDS,
  STANDARD_DAILY_HOURS,
} from "../types";

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

export function hoursForEmployeeShift(employee: EmployeeAvailability): number {
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
  const hasPreference = Object.keys(employee.available).length > 0;
  if (!hasPreference) return true;
  if (!dayShifts || dayShifts.length === 0) return false;
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

export function leaveExcessWarning(
  iso: string,
  requestedOffCount: number,
  maxAllowedOffCount: number,
): string {
  const date = parseISODate(iso);
  return `${date.getMonth() + 1}/${date.getDate()} 放假超額：請假(SH) ${requestedOffCount} 人，上限 ${maxAllowedOffCount} 人，請管理員指示！`;
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

// ═════════════════════════════════════════════
// Stage 3 Step 2：DB 驅動的編班條件及限制檢核
// 業務數字／時間段全部讀 rules: RosterRules；只保留極簡防呆 fallback。
// 假期累計編號與年終結算留待下一步（不在此檔處理）。
// ═════════════════════════════════════════════

/** 極簡防呆：DB 未設定時的最低限度假設。 */
const FALLBACK_REST_RULE = { workDays: 6, restDays: 1, cycleDays: 7 };
const FALLBACK_OT_TRIGGER_HOURS = 6;
const FALLBACK_OT_CAP_HOURS = 8;
const FALLBACK_DEFICIT_TRIGGER_HOURS = 5;

const PERIOD_LABEL_FALLBACK: Record<ServicePeriodKey, string> = {
  opening: "開檔",
  breakfast: "早餐",
  lunch: "午市",
  tea: "下午茶",
  dinner: "晚市",
  closing: "收檔",
};

function slotDurationHours(slot: ShiftTimeSlot): number {
  const start = parseHhMmToMinutes(slot.start);
  const end = parseHhMmToMinutes(slot.end);
  if (start === null || end === null || end <= start) return 0;
  return Math.round(((end - start) / 60) * 100) / 100;
}

export function employmentTypeFromCategory(category: StaffCategory): EmploymentType {
  return EMPLOYMENT_BY_STAFF_CATEGORY[category];
}

/** 職級標準日工時：優先讀 DB 的 max_daily_hours，否則用型別常數。 */
export function standardDailyHoursFor(
  employmentType: EmploymentType,
  rules: RosterRules,
): number {
  const fromRules = rules?.max_daily_hours?.[employmentType];
  if (typeof fromRules === "number" && fromRules > 0) return fromRules;
  return STANDARD_DAILY_HOURS[employmentType];
}

/** 經理的 M / A.M 職位標記。 */
export function isManagementPosition(position: string | null | undefined): boolean {
  if (!position) return false;
  const normalized = position.trim().toUpperCase().replace(/[.\s]/g, "");
  return normalized === "M" || normalized === "AM";
}

// ── 1. 六大營業時段：時間窗、人數矩陣、缺人手檢核 ──

export interface DbPeriodSpec {
  id: ServicePeriodKey;
  label: string;
  shortLabel: string;
  startMinutes: number;
  endMinutes: number;
}

/** 時間段一律讀 rules.shift_time_slots，按 SERVICE_PERIOD_IDS 順序輸出。 */
export function servicePeriodsFromRules(rules: RosterRules): DbPeriodSpec[] {
  const slots = Array.isArray(rules?.shift_time_slots) ? rules.shift_time_slots : [];
  const specs: DbPeriodSpec[] = [];
  for (const slot of slots) {
    const start = parseHhMmToMinutes(slot.start);
    const end = parseHhMmToMinutes(slot.end);
    if (start === null || end === null || end <= start) continue;
    const shortLabel = PERIOD_LABEL_FALLBACK[slot.id] ?? slot.id;
    specs.push({
      id: slot.id,
      shortLabel,
      label: `${shortLabel}(${slot.start}-${slot.end})`,
      startMinutes: start,
      endMinutes: end,
    });
  }
  const order = new Map(SERVICE_PERIOD_IDS.map((id, index) => [id, index]));
  return specs.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
}

type HeadcountSpec = number | Record<string, unknown> | null | undefined;

/**
 * 讀時段所需人數。兼容兩種格式：
 * 1. 單一數字：{"lunch": 8}
 * 2. 每日獨立：{"lunch": {"sun": 9, "mon": 8}} 或 {"lunch": {"0": 9, "1": 8}}
 */
export function requiredHeadcountFor(
  rules: RosterRules,
  periodId: ServicePeriodKey,
  iso: string,
): number {
  const table = (rules?.period_headcount ?? {}) as unknown as Record<string, HeadcountSpec>;
  const spec = table[periodId];
  if (typeof spec === "number") return spec;
  if (!spec || typeof spec !== "object") return 0;
  const weekday = weekdayKeyFromDate(iso);
  const byKey = (spec as Record<string, unknown>)[weekday];
  if (typeof byKey === "number") return byKey;
  const byIndex = (spec as Record<string, unknown>)[String(parseISODate(iso).getDay())];
  return typeof byIndex === "number" ? byIndex : 0;
}

export interface PeriodCoverage {
  id: ServicePeriodKey;
  label: string;
  required: number;
  actual: number;
  shortage: number;
  ok: boolean;
}

/** 計當日各時段實際在崗人數，並標示缺人手。 */
export function auditPeriodCoverage(
  assignments: readonly Assignment[],
  rules: RosterRules,
  iso: string,
): PeriodCoverage[] {
  const dayAssignments = assignments.filter((item) => item.date === iso);
  return servicePeriodsFromRules(rules).map((period) => {
    const names = new Set<string>();
    for (const item of dayAssignments) {
      const win = getAssignmentWindowMinutes(item);
      if (win.start < period.endMinutes && win.end >= period.startMinutes) {
        names.add(item.employee);
      }
    }
    const required = requiredHeadcountFor(rules, period.id, iso);
    const actual = names.size;
    return {
      id: period.id,
      label: period.label,
      required,
      actual,
      shortage: Math.max(0, required - actual),
      ok: actual >= required,
    };
  });
}

// ── 2. 排除法前置檢核（先編假、後編更） ──

export type EmployeeLeaveEntry = LeaveEntry & { employee: string };

export interface LeaveFirstPlan {
  employeeId: string;
  employee: string;
  employmentType: EmploymentType;
  /** date → 可否排班（已扣例休、全日假；PT 只限報更列出日子）。 */
  canWorkByDate: Record<string, boolean>;
  fullDayLeaveDates: string[];
  halfDayLeaveEntries: LeaveEntry[];
  /** 半日假可用工時（HFT 不設拆半 → 等於整日）。 */
  halfDayHours: number;
  /** 半日假可揀的時間段（由 DB 時間段按半日時長篩選）。 */
  halfDaySlots: string[];
}

export function evaluateLeaveFirst(input: {
  employees: readonly Employee[];
  weekStart: string;
  rules: RosterRules;
  leaveEntries?: readonly EmployeeLeaveEntry[];
  /** PT 報更「返到邊日」：employee.id 或 name → YYYY-MM-DD[]。 */
  partTimeAvailableDates?: Record<string, string[]>;
}): LeaveFirstPlan[] {
  const days = weekDates(input.weekStart);
  const allLeave = input.leaveEntries ?? [];

  return input.employees
    .filter((emp) => emp.is_active !== false)
    .map((emp) => {
      const mine = allLeave.filter(
        (entry) => entry.employee === emp.id || entry.employee === emp.name,
      );
      const fullDayLeaveDates = mine.filter((entry) => entry.days === 1).map((entry) => entry.date);
      const standard = standardDailyHoursFor(emp.employment_type, input.rules);
      const canSplitHalfDay = emp.employment_type === "FT";
      const halfDayLeaveEntries = mine.filter((entry) => {
        if (entry.days !== 0.5) return false;
        // HFT 不設 2.5h 拆半，半日紀錄按整日處理。
        return canSplitHalfDay;
      });
      const halfDayHours = canSplitHalfDay ? standard / 2 : standard;
      const halfDaySlots = servicePeriodsFromRules(input.rules)
        .filter((period) => {
          const duration = (period.endMinutes - period.startMinutes) / 60;
          return Math.abs(duration - halfDayHours) < 0.01;
        })
        .map((period) => `${period.startMinutes}-${period.endMinutes}`);

      const canWorkByDate: Record<string, boolean> = {};
      const ptDates =
        input.partTimeAvailableDates?.[emp.id] ??
        input.partTimeAvailableDates?.[emp.name] ??
        [];

      for (const date of days) {
        const onLeave =
          fullDayLeaveDates.includes(date) ||
          mine.some((entry) => entry.date === date && entry.days === 0.5 && !canSplitHalfDay);
        const isRestDay = (emp.regular_days_off ?? []).includes(parseISODate(date).getDay());

        if (emp.employment_type === "PT") {
          // PT 預設全週唔返；只限報更列出日子，請假優先。
          canWorkByDate[date] = ptDates.includes(date) && !onLeave;
        } else {
          // FT / HFT 預設全週可上班，先扣例休及全日假。
          canWorkByDate[date] = !onLeave && !isRestDay;
        }
      }

      return {
        employeeId: emp.id,
        employee: emp.name,
        employmentType: emp.employment_type,
        canWorkByDate,
        fullDayLeaveDates,
        halfDayLeaveEntries,
        halfDayHours,
        halfDaySlots,
      };
    });
}

// ── 3. 管理層與職級時間段資格 ──

/** 依職級由 DB 時間段篩出合法時間段（按標準日工時長度配對）。 */
export function shiftOptionsForEmployment(
  rules: RosterRules,
  employmentType: EmploymentType,
): string[] {
  const slots = Array.isArray(rules?.shift_time_slots) ? rules.shift_time_slots : [];
  const standard = standardDailyHoursFor(employmentType, rules);
  const matched = slots
    .filter((slot) => Math.abs(slotDurationHours(slot) - standard) < 0.01)
    .map((slot) => `${slot.start}-${slot.end}`);
  // 防呆：DB 未提供對應長度時段時，退回全部時間段，避免完全排唔到班。
  return matched.length > 0 ? matched : slots.map((slot) => `${slot.start}-${slot.end}`);
}

/** 員工可揀時間段：管理層 = 彈性；其他 = 職級時間段 + 固定時間 + 彈性選項。 */
export function eligibleShiftOptions(employee: Employee, rules: RosterRules): string[] {
  const fixed = employee.fixed_shift_time ? [employee.fixed_shift_time] : [];
  const flexible = Array.isArray(employee.flexible_shift_options)
    ? employee.flexible_shift_options
    : [];
  if (isManagementPosition(employee.position)) {
    const all = (rules?.shift_time_slots ?? []).map((slot) => `${slot.start}-${slot.end}`);
    return Array.from(new Set([...all, ...fixed, ...flexible]));
  }
  return Array.from(
    new Set([...shiftOptionsForEmployment(rules, employee.employment_type), ...fixed, ...flexible]),
  );
}

export interface EligibilityCheck {
  allowed: boolean;
  reason?: string;
}

export function checkTimeSlotEligibility(
  employee: Employee,
  rules: RosterRules,
  timeSlot: string,
): EligibilityCheck {
  if (isManagementPosition(employee.position)) {
    return { allowed: true, reason: "管理層可彈性上班時間" };
  }
  const options = eligibleShiftOptions(employee, rules);
  if (options.includes(timeSlot)) return { allowed: true };
  return {
    allowed: false,
    reason: `${employee.name}（${employee.employment_type}）不合資格時間段 ${timeSlot}`,
  };
}

/** 早更／晚市管理層最少人數檢核（門檻預設 2）。 */
export function auditManagementCoverage(input: {
  assignments: readonly Assignment[];
  employees: readonly Employee[];
  rules: RosterRules;
  iso: string;
  minimum?: number;
}): { morning: number; dinner: number; ok: boolean; message?: string } {
  const minimum = input.minimum ?? 2;
  const managers = new Set(
    input.employees
      .filter((emp) => isManagementPosition(emp.position))
      .map((emp) => emp.name),
  );
  const dayAssignments = input.assignments.filter((item) => item.date === input.iso);
  const periods = servicePeriodsFromRules(input.rules);
  const morningPeriod = periods.find((period) => period.id === "breakfast");
  const dinnerPeriod = periods.find((period) => period.id === "dinner");
  const countIn = (window?: { startMinutes: number; endMinutes: number }) => {
    if (!window) return 0;
    const names = new Set<string>();
    for (const item of dayAssignments) {
      if (!managers.has(item.employee)) continue;
      const win = getAssignmentWindowMinutes(item);
      if (win.start < window.endMinutes && win.end >= window.startMinutes) {
        names.add(item.employee);
      }
    }
    return names.size;
  };
  const morning = countIn(morningPeriod);
  const dinner = countIn(dinnerPeriod);
  const ok = morning >= minimum && dinner >= minimum;
  return {
    morning,
    dinner,
    ok,
    message: ok
      ? undefined
      : `管理層不足：早更 ${morning}/${minimum}、晚市 ${dinner}/${minimum}，請調整。`,
  };
}

// ── 4. 每月最少上班時數保底 ＋ 每日／每週上限 ──

export interface MonthlyHoursTarget {
  employmentType: EmploymentType;
  daysInMonth: number;
  restDays: number;
  workDays: number;
  dailyHours: number;
  minHours: number;
}

function daysInMonthOf(yearMonth: string): number {
  const [year, month] = yearMonth.split("-").map(Number);
  if (!year || !month) return 30;
  return new Date(year, month, 0).getDate();
}

/**
 * 每月最少工時目標：由當月實際天數 + DB weekly_rest_rule 推算應上班日，
 * 再乘職級標準日工時（FT 10h / HFT 5h，5h 為 FT 的 0.5 日）。
 */
export function monthlyMinimumHoursTarget(
  employmentType: EmploymentType,
  yearMonth: string,
  rules: RosterRules,
): MonthlyHoursTarget {
  const daysInMonth = daysInMonthOf(yearMonth);
  const restRule = rules?.weekly_rest_rule ?? FALLBACK_REST_RULE;
  const cycleDays = restRule.cycleDays > 0 ? restRule.cycleDays : FALLBACK_REST_RULE.cycleDays;
  const restPerCycle = restRule.restDays >= 0 ? restRule.restDays : FALLBACK_REST_RULE.restDays;
  const restDays = Math.floor(daysInMonth / cycleDays) * restPerCycle;
  const workDays = Math.max(0, daysInMonth - restDays);
  const dailyHours = standardDailyHoursFor(employmentType, rules);
  return {
    employmentType,
    daysInMonth,
    restDays,
    workDays,
    dailyHours,
    minHours: workDays * dailyHours,
  };
}

export interface MonthlyHoursAudit extends MonthlyHoursTarget {
  employee: string;
  scheduledDays: number;
  halfDayCount: number;
  reachableHours: number;
  shortfallHours: number;
  ok: boolean;
  /** 工時不足會計入欠鐘風險。 */
  deficitRisk: boolean;
  message?: string;
}

/** 先編假後的工時保底預警。 */
export function auditMonthlyHoursFloor(input: {
  employee: string;
  employmentType: EmploymentType;
  yearMonth: string;
  rules: RosterRules;
  scheduledDays: number;
  halfDayCount?: number;
}): MonthlyHoursAudit {
  const target = monthlyMinimumHoursTarget(input.employmentType, input.yearMonth, input.rules);
  const halfDayCount = input.halfDayCount ?? 0;
  const fullDayCount = Math.max(0, input.scheduledDays - halfDayCount);
  const reachableHours =
    fullDayCount * target.dailyHours + halfDayCount * (target.dailyHours / 2);
  const shortfallHours = Math.max(0, Math.round((target.minHours - reachableHours) * 10) / 10);
  const ok = shortfallHours === 0;
  return {
    ...target,
    employee: input.employee,
    scheduledDays: input.scheduledDays,
    halfDayCount,
    reachableHours,
    shortfallHours,
    ok,
    deficitRisk: !ok,
    message: ok
      ? undefined
      : `${input.employee} 本月可排 ${reachableHours}h，低於最少 ${target.minHours}h，尚欠 ${shortfallHours}h（欠鐘風險）。`,
  };
}

export interface HourCapCheck {
  dailyLimit: number;
  weeklyLimit: number;
  dailyOk: boolean;
  weeklyOk: boolean;
  dailyOver: number;
  weeklyOver: number;
}

export function checkHourCaps(
  employmentType: EmploymentType,
  dailyHours: number,
  weeklyHours: number,
  rules: RosterRules,
): HourCapCheck {
  const dailyLimit =
    rules?.max_daily_hours?.[employmentType] ?? standardDailyHoursFor(employmentType, rules);
  const weeklyLimit =
    rules?.max_weekly_hours?.[employmentType] ??
    dailyLimit * (rules?.weekly_rest_rule?.workDays ?? FALLBACK_REST_RULE.workDays);
  return {
    dailyLimit,
    weeklyLimit,
    dailyOk: dailyHours <= dailyLimit,
    weeklyOk: weeklyHours <= weeklyLimit,
    dailyOver: Math.max(0, Math.round((dailyHours - dailyLimit) * 10) / 10),
    weeklyOver: Math.max(0, Math.round((weeklyHours - weeklyLimit) * 10) / 10),
  };
}

// ── 5. OT 與欠鐘自動平衡建議 ──

export interface OtBalanceOptions {
  otTriggerHours: number;
  otCapHours: number;
  deficitTriggerHours: number;
}

export interface OtBalanceAdvice {
  action: "half_day_comp" | "full_day_deficit_repay" | "none";
  exempted: boolean;
  message: string;
}

export function suggestOtBalance(input: {
  otHours: number;
  timeBalanceHours: number;
  /** 下個編更日是否缺人手（缺人 → 觸發豁免，照常排更）。 */
  shortageOnNextDay: boolean;
  options?: Partial<OtBalanceOptions>;
}): OtBalanceAdvice {
  const opts: OtBalanceOptions = {
    otTriggerHours: input.options?.otTriggerHours ?? FALLBACK_OT_TRIGGER_HOURS,
    otCapHours: input.options?.otCapHours ?? FALLBACK_OT_CAP_HOURS,
    deficitTriggerHours: input.options?.deficitTriggerHours ?? FALLBACK_DEFICIT_TRIGGER_HOURS,
  };

  if (input.otHours > opts.otTriggerHours && input.otHours < opts.otCapHours) {
    if (input.shortageOnNextDay) {
      return {
        action: "none",
        exempted: true,
        message: `OT ${input.otHours}h 已達補鐘門檻，但下個編更日缺人手，豁免照常排更。`,
      };
    }
    return {
      action: "half_day_comp",
      exempted: false,
      message: `OT ${input.otHours}h > ${opts.otTriggerHours}h，下個編更日優先排半日補鐘，控制 OT < ${opts.otCapHours}h。`,
    };
  }

  if (input.timeBalanceHours <= -opts.deficitTriggerHours) {
    return {
      action: "full_day_deficit_repay",
      exempted: false,
      message: `欠鐘 ${Math.abs(input.timeBalanceHours)}h ≥ ${opts.deficitTriggerHours}h，下個編更日優先排補返半天清零。`,
    };
  }

  return { action: "none", exempted: false, message: "OT 與欠鐘在容許範圍內，無需調整。" };
}

// ── 6. 動態職級人數統計 ──

export interface EmploymentStats {
  total: number;
  FT: number;
  HFT: number;
  PT: number;
  /** FT 之中具 M / A.M 管理層資格的人數。 */
  management: number;
}

export function countEmployeesByEmployment(employees: readonly Employee[]): EmploymentStats {
  const active = employees.filter((emp) => emp.is_active !== false);
  const countBy = (type: EmploymentType) =>
    active.filter((emp) => emp.employment_type === type).length;
  return {
    total: active.length,
    FT: countBy("FT"),
    HFT: countBy("HFT"),
    PT: countBy("PT"),
    management: active.filter((emp) => isManagementPosition(emp.position)).length,
  };
}