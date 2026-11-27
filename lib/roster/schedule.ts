import type {
  Assignment,
  DailyHourSummary,
  Employee,
  EmployeeAvailability,
  EmployeeHourSummary,
  EmployeeMonthlyHours,
  RosterRules,
  RosterWarning,
  ScheduleResult,
  ServicePeriodKey,
  StaffCategory,
  WorkingShift,
  ReserveStaff,
} from "../types";
import { EMPLOYMENT_BY_STAFF_CATEGORY, WORKING_SHIFTS } from "../types";
import {
  SERVICE_PERIODS,
  STAFF_CONFIG,
  auditManagementCoverage,
  auditMonthlyHoursFloor,
  auditPeriodCoverage,
  canWork,
  checkHourCaps,
  checkTimeSlotEligibility,
  countStaffInPeriod,
  eligibleShiftOptions,
  evaluateLeaveFirst,
  hoursForEmployeeShift,
  hoursWorked,
  isManagementPosition,
  isOnLeave,
  leaveExcessWarning,
  maxAllowedSalariedOff,
  monthlyMinimumHoursTarget,
  parseISODate,
  periodCoverageWarningMessage,
  requiredPeriodHeadcount,
  resolveCategory,
  servicePeriodsFromRules,
  shiftOptionsForEmployment,
  shiftsWorked,

  standardDailyHoursFor,
  sundayOnOrBefore,
  suggestOtBalance,
  weekDates,
} from "./rules";
import type { DbPeriodSpec, EmployeeLeaveEntry, ServicePeriodId } from "./rules";
import {
  buildHoursLedger,
  isAlSettlementDate,
  numberLeaveEntries,
  settleAnnualLeave,
} from "./ledger";
import type { HoursLedger, LedgerLeaveEntry } from "./ledger";

export interface BuildWeekScheduleInput {
  weekStart: string;
  employees: EmployeeAvailability[];
  /** DB roster_rules；有值才啟用多關卡漏斗，否則沿用舊演算法（向後兼容）。 */
  rules?: RosterRules | null;
  /** DB employees；提供時以 DB 的職級、固定更、例休為準。 */
  staff?: readonly Employee[];
  /** 已帶假期代號的假期紀錄（AL / SH / W）。 */
  leaveEntries?: readonly EmployeeLeaveEntry[];
  /** PT 報更「返到邊日」：employee.id 或 name → YYYY-MM-DD[]。 */
  partTimeAvailableDates?: Record<string, string[]>;
  /** DB reserve_staff 後備名單。 */
  reserveStaff?: readonly ReserveStaff[];
}

export interface DayShortagePeriod {
  id: ServicePeriodKey;
  label: string;
  required: number;
  actual: number;
  shortage: number;
}

export interface DayShortage {
  date: string;
  periods: DayShortagePeriod[];
  backups: string[];
}

export interface SchedulePipelineResult extends ScheduleResult {
  leaveEntries: LedgerLeaveEntry[];
  ledger: HoursLedger;
  shortages: DayShortage[];
}

const CATEGORY_PRIORITY: Record<StaffCategory, number> = {
  full_time: 1,
  half_full_time: 2,
  part_time: 3,
};

const DAY_END_MINUTES = 24 * 60;
const SLOT_PATTERN = /^(\d{1,2}):(\d{2})$/;

export function buildWeekSchedule(input: BuildWeekScheduleInput): ScheduleResult {
  if (!input.rules) {
    return buildLegacyWeekSchedule(input);
  }
  return buildPipelineWeekSchedule(input, input.rules);
}

/** 舊演算法（DB 未提供 rules 時原封不動沿用）。 */
function buildLegacyWeekSchedule(input: BuildWeekScheduleInput): ScheduleResult {
  const days = weekDates(input.weekStart);
  const assignments: Assignment[] = [];

  for (const date of days) {
    const assignedToday = new Set<string>();
    const sortedEmployees = [...input.employees].sort((a, b) => {
      const catDiff =
        CATEGORY_PRIORITY[resolveCategory(a)] -
        CATEGORY_PRIORITY[resolveCategory(b)];
      if (catDiff !== 0) return catDiff;
      return hoursWorked(assignments, a.name) - hoursWorked(assignments, b.name);
    });

    for (const shift of WORKING_SHIFTS) {
      for (const emp of sortedEmployees) {
        if (emp.reserve) continue;
        if (assignedToday.has(emp.name)) continue;
        if (!canWork(emp, date, shift)) continue;

        const cat = resolveCategory(emp);
        const cfg = STAFF_CONFIG[cat];
        const currentDays = shiftsWorked(assignments, emp.name);
        const currentHours = hoursWorked(assignments, emp.name);
        const addHours = hoursForEmployeeShift(emp);

        if (currentDays >= cfg.weeklyDays) continue;
        if (currentHours + addHours > cfg.weeklyHours) continue;

        assignments.push({
          date,
          shift,
          employee: emp.name,
          department: emp.department,
          hours: addHours,
          timeSlot: cfg.slots[0],
        });
        assignedToday.add(emp.name);
      }
    }
  }

  assignments.sort(
    (left, right) =>
      left.date.localeCompare(right.date) || left.shift.localeCompare(right.shift),
  );

  const dailyHours: DailyHourSummary[] = days.map((date) => {
    const dayAssignments = assignments.filter((a) => a.date === date);
    const totalHours = dayAssignments.reduce((sum, a) => sum + (a.hours ?? 0), 0);
    return {
      date,
      totalHours,
      headcount: dayAssignments.length,
    };
  });

  const employeeHours: EmployeeHourSummary[] = input.employees.map((emp) => {
    const empAssignments = assignments.filter((a) => a.employee === emp.name);
    const totalHours = empAssignments.reduce((sum, a) => sum + (a.hours ?? 0), 0);
    return {
      employee: emp.name,
      totalHours,
      shiftsCount: empAssignments.length,
    };
  });

  return {
    schedule: {
      days,
      shifts: [...WORKING_SHIFTS],
      assignments,
      dailyHours,
      employeeHours,
    },
    warnings: evaluateRosterWarnings(days, input.employees, assignments),
  };
}

export function isIntakeNote(warning: RosterWarning): boolean {
  const message = warning.message;
  return (
    message.startsWith("來源：") ||
    message.includes("未設定 AI_API_KEY") ||
    message.includes("寫入 Supabase") ||
    message.includes("未送出外部模型")
  );
}

export interface PeriodCount {
  id: ServicePeriodId;
  label: string;
  shortLabel: string;
  actual: number;
  required: number;
  ok: boolean;
}

export interface LeaveCount {
  wh: number;
  sh: number;
  salariedLeave: number;
  maxAllowedOff: number;
  excess: boolean;
}

export interface DayCoverage {
  date: string;
  periods: PeriodCount[];
  leave: LeaveCount;
}

function isWorkingOnDate(
  employeeName: string,
  date: string,
  assignments: readonly Assignment[],
): boolean {
  return assignments.some((item) => item.employee === employeeName && item.date === date);
}

export function countLeaveOnDate(
  date: string,
  employees: readonly EmployeeAvailability[],
  assignments: readonly Assignment[],
): LeaveCount {
  const rostered = employees.filter((emp) => !emp.reserve);
  const salaried = rostered.filter((emp) => {
    const cat = resolveCategory(emp);
    return cat === "full_time" || cat === "half_full_time";
  });
  const maxAllowedOff = maxAllowedSalariedOff(salaried.length);
  const salariedLeave = salaried.filter((emp) => isOnLeave(emp, date)).length;

  let wh = 0;
  let sh = 0;
  for (const emp of rostered) {
    if (isOnLeave(emp, date)) {
      sh += 1;
      continue;
    }
    if (!isWorkingOnDate(emp.name, date, assignments)) {
      wh += 1;
    }
  }

  return {
    wh,
    sh,
    salariedLeave,
    maxAllowedOff,
    excess: salariedLeave > maxAllowedOff,
  };
}

export function auditWeekCoverage(
  days: string[],
  employees: readonly EmployeeAvailability[],
  assignments: readonly Assignment[],
): DayCoverage[] {
  return days.map((date) => {
    const dayAssignments = assignments.filter((item) => item.date === date);
    const periods: PeriodCount[] = SERVICE_PERIODS.map((period) => {
      const required = requiredPeriodHeadcount(date, period);
      const actual = countStaffInPeriod(dayAssignments, period);
      return {
        id: period.id,
        label: period.label,
        shortLabel: period.shortLabel,
        actual,
        required,
        ok: actual >= required,
      };
    });
    return {
      date,
      periods,
      leave: countLeaveOnDate(date, employees, assignments),
    };
  });
}

/** 按現有更表重計六大時段在崗同放假超額，唔會重新排更。 */
export function evaluateRosterWarnings(
  days: string[],
  employees: readonly EmployeeAvailability[],
  assignments: readonly Assignment[],
): RosterWarning[] {
  const warnings: RosterWarning[] = [];

  for (const day of auditWeekCoverage(days, employees, assignments)) {
    if (day.leave.excess) {
      warnings.push({
        date: day.date,
        shift: "AM",
        needsManagerAction: true,
        message: leaveExcessWarning(
          day.date,
          day.leave.salariedLeave,
          day.leave.maxAllowedOff,
        ),
      });
    }

    for (const period of day.periods) {
      if (period.ok) continue;
      warnings.push({
        date: day.date,
        shift:
          period.id === "opening" || period.id === "breakfast" ? "AM" : "PM",
        message: periodCoverageWarningMessage(
          day.date,
          period.shortLabel,
          period.actual,
          period.required,
        ),
      });
    }
  }

  return warnings;
}

export function summarizeSchedule(
  days: string[],
  assignments: readonly Assignment[],
  employeeNames: string[],
): {
  dailyHours: DailyHourSummary[];
  employeeHours: EmployeeHourSummary[];
} {
  const dailyHours: DailyHourSummary[] = days.map((date) => {
    const dayAssignments = assignments.filter((item) => item.date === date);
    return {
      date,
      totalHours: dayAssignments.reduce((sum, item) => sum + (item.hours ?? 0), 0),
      headcount: dayAssignments.length,
    };
  });

  const employeeHours: EmployeeHourSummary[] = employeeNames.map((employee) => {
    const empAssignments = assignments.filter((item) => item.employee === employee);
    return {
      employee,
      totalHours: empAssignments.reduce((sum, item) => sum + (item.hours ?? 0), 0),
      shiftsCount: empAssignments.length,
    };
  });

  return { dailyHours, employeeHours };
}

// ═════════════════════════════════════════════
// Stage 3 最後一步：多關卡排更漏斗（全部門檻讀 DB rules / employees）
// ═════════════════════════════════════════════

interface Planner {
  employee: Employee;
  availability: EmployeeAvailability;
  canWorkByDate: Record<string, boolean>;
  halfDayLeaveDates: Set<string>;
  halfDaySlots: string[];
  leaveEntries: LedgerLeaveEntry[];
  isManagement: boolean;
}

interface PlanContext {
  rules: RosterRules;
  weekStart: string;
  days: string[];
  periods: DbPeriodSpec[];
  planners: Planner[];
  assignments: Assignment[];
  warnings: RosterWarning[];
  shortages: DayShortage[];
  backups: string[];
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function parseMinutes(raw: string): number | null {
  const match = SLOT_PATTERN.exec(raw.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes >= 60) return null;
  return hours * 60 + minutes;
}

function formatMinutes(total: number): string {
  const safe = Math.max(0, Math.min(DAY_END_MINUTES, Math.round(total)));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

/** 兼容 "09:00-18:00" 及 rules.ts 輸出的 "540-1080"。 */
function normalizeSlotText(raw: string): string {
  if (raw.includes(":")) return raw;
  const parts = raw.split("-").map((part) => Number(part));
  if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
    return raw;
  }
  return `${formatMinutes(parts[0])}-${formatMinutes(parts[1])}`;
}

function splitSlot(raw: string): { start: number; end: number } | null {
  const parts = normalizeSlotText(raw).split("-");
  if (parts.length !== 2) return null;
  const start = parseMinutes(parts[0]);
  const end = parseMinutes(parts[1]);
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

function slotHours(raw: string): number {
  const win = splitSlot(raw);
  if (!win) return 0;
  return round1((win.end - win.start) / 60);
}

/**
 * 員工委託的固定更／彈性選項原封不動使用；只有 DB 的「營業時段」短時間段
 * （例如開檔 06:00-07:00）才按職級標準工時延伸，否則排不到一日工時。
 * 延伸後超出當日 24:00 者回 null（唔會產生 24:00 這種非法時間）。
 */
function normalizeWorkSlot(
  employee: Employee,
  rules: RosterRules,
  raw: string,
  fromRulesPeriod: boolean,
): string | null {
  const text = normalizeSlotText(raw);
  const win = splitSlot(text);
  if (!win) return null;
  if (!fromRulesPeriod) return text;

  const standard = standardDailyHoursFor(employee.employment_type, rules);
  const minutes = Math.round(standard * 60);
  if (win.end - win.start >= minutes) return text;
  // 以該營業時段為中心補足標準工時；撞到 24:00 就向前推，確保一定覆蓋原時段。
  let start = win.start;
  if (start + minutes > DAY_END_MINUTES) start = Math.max(0, win.end - minutes);
  if (start < 0 || start + minutes > DAY_END_MINUTES) return null;
  return `${formatMinutes(start)}-${formatMinutes(start + minutes)}`;
}

/** 該時間段係唔係來自 rules.shift_time_slots（而非員工自訂）。 */
function isRulesPeriodSlot(ctx: PlanContext, raw: string): boolean {
  const text = normalizeSlotText(raw);
  return ctx.periods.some((period) => `${formatMinutes(period.startMinutes)}-${formatMinutes(period.endMinutes)}` === text);
}

/** 員工自己填的固定更／彈性頂更選項（明示意願，優先於星期偏好）。 */
function isDeclaredSlot(planner: Planner, slot: string): boolean {
  const text = normalizeSlotText(slot);
  const declared = [
    ...(planner.employee.fixed_shift_time ? [planner.employee.fixed_shift_time] : []),
    ...(planner.employee.flexible_shift_options ?? []),
  ];
  return declared.some((item) => normalizeSlotText(item) === text);
}

function halfDaySlot(raw: string, halfHours: number): string {
  const win = splitSlot(raw);
  if (!win) return raw;
  const end = Math.min(win.end, win.start + Math.round(halfHours * 60));
  return `${formatMinutes(win.start)}-${formatMinutes(end)}`;
}

/** 更別按與標準更（AM 07-17 / PM 12-22 / EVE 17-22）的重疊時數判定。 */
function shiftForSlot(_ctx: PlanContext, raw: string): WorkingShift {
  const win = splitSlot(raw);
  if (!win) return "AM";
  const anchors: { shift: WorkingShift; start: number; end: number }[] = [
    { shift: "AM", start: 7 * 60, end: 17 * 60 },
    { shift: "PM", start: 12 * 60, end: 22 * 60 },
    { shift: "EVE", start: 17 * 60, end: 22 * 60 },
  ];
  let best: { shift: WorkingShift; overlap: number; span: number } = {
    shift: "AM",
    overlap: -1,
    span: Number.MAX_SAFE_INTEGER,
  };
  for (const anchor of anchors) {
    const overlap = Math.max(
      0,
      Math.min(win.end, anchor.end) - Math.max(win.start, anchor.start),
    );
    const span = anchor.end - anchor.start;
    // 重疊最多者勝；同分則取較短更（17:00-22:00 → EVE，而非 PM）。
    if (overlap > best.overlap || (overlap === best.overlap && span < best.span)) {
      best = { shift: anchor.shift, overlap, span };
    }
  }
  return best.overlap > 0 ? best.shift : win.start < 12 * 60 ? "AM" : "PM";
}

/** 員工自己的固定更／彈性選項優先，職級預設時間段排最後。 */
function workSlotCandidates(planner: Planner, ctx: PlanContext): string[] {
  const fixed = planner.employee.fixed_shift_time;
  const flexible = planner.employee.flexible_shift_options ?? [];
  const byEmployment = shiftOptionsForEmployment(ctx.rules, planner.employee.employment_type);
  // PT 只可返報更列出／彈性選項的時間段，唔可以自動派職級預設更。
  const pool =
    planner.employee.employment_type === "PT"
      ? [...(fixed ? [fixed] : []), ...flexible, ...(fixed || flexible.length > 0 ? [] : byEmployment)]
      : [...(fixed ? [fixed] : []), ...flexible, ...byEmployment];
  return Array.from(new Set(pool.map((slot) => normalizeSlotText(slot))));
}

function employeeKey(name: string): string {
  return name.trim().toLowerCase();
}

function toEmployeeRecord(avail: EmployeeAvailability, index: number): Employee {
  return {
    id: `availability-${index}`,
    store_id: "",
    name: avail.name,
    nickname: null,
    position: null,
    employment_type: EMPLOYMENT_BY_STAFF_CATEGORY[resolveCategory(avail)],
    fixed_shift_time: null,
    flexible_shift_options: [],
    regular_days_off: [],
    annual_leave_total: 0,
    al_current_count: 0,
    sh_current_count: 0,
    w_current_count: 0,
    department: avail.department ?? null,
    phone: null,
    is_active: true,
  };
}

function collectBackups(input: BuildWeekScheduleInput): string[] {
  const names: string[] = [];
  for (const staff of input.reserveStaff ?? []) {
    if (staff.is_active === false) continue;
    if (!names.includes(staff.name)) names.push(staff.name);
  }
  for (const avail of input.employees) {
    if (avail.reserve && !names.includes(avail.name)) names.push(avail.name);
  }
  return names;
}

function buildPlanners(input: BuildWeekScheduleInput): Planner[] {
  const availByName = new Map<string, EmployeeAvailability>();
  for (const avail of input.employees) {
    if (!availByName.has(employeeKey(avail.name))) {
      availByName.set(employeeKey(avail.name), avail);
    }
  }

  const planners: Planner[] = [];
  const used = new Set<string>();

  for (const emp of input.staff ?? []) {
    if (emp.is_active === false) continue;
    const avail = availByName.get(employeeKey(emp.name));
    if (avail?.reserve) continue;
    used.add(employeeKey(emp.name));
    planners.push({
      employee: emp,
      availability:
        avail ?? { name: emp.name, department: emp.department ?? "", leave: [], available: {} },
      canWorkByDate: {},
      halfDayLeaveDates: new Set<string>(),
      halfDaySlots: [],
      leaveEntries: [],
      isManagement: isManagementPosition(emp.position),
    });
  }

  input.employees.forEach((avail, index) => {
    if (avail.reserve) return;
    if (used.has(employeeKey(avail.name))) return;
    used.add(employeeKey(avail.name));
    planners.push({
      employee: toEmployeeRecord(avail, index),
      availability: avail,
      canWorkByDate: {},
      halfDayLeaveDates: new Set<string>(),
      halfDaySlots: [],
      leaveEntries: [],
      isManagement: false,
    });
  });

  return planners;
}

// ── Step 1：先編假（例休 + 申請假 + 遞增編號 + 月工時保底） ──

function applyLeaveFirst(ctx: PlanContext, input: BuildWeekScheduleInput): void {
  const provided = input.leaveEntries ?? [];
  const ptDates: Record<string, string[]> = { ...(input.partTimeAvailableDates ?? {}) };
  for (const avail of input.employees) {
    const dates = avail.availableDates ?? [];
    if (dates.length === 0) continue;
    if (!ptDates[avail.name]) ptDates[avail.name] = [...dates];
  }
  for (const planner of ctx.planners) {
    if (planner.employee.employment_type !== "PT") continue;
    const dates = ptDates[planner.employee.name];
    if (dates && !ptDates[planner.employee.id]) ptDates[planner.employee.id] = dates;
  }

  const plans = evaluateLeaveFirst({
    employees: ctx.planners.map((planner) => planner.employee),
    weekStart: ctx.weekStart,
    rules: ctx.rules,
    leaveEntries: provided,
    partTimeAvailableDates: ptDates,
  });

  const defaultShNames: string[] = [];

  for (const planner of ctx.planners) {
    const plan = plans.find((item) => item.employeeId === planner.employee.id);
    planner.canWorkByDate = plan?.canWorkByDate ?? {};
    planner.halfDaySlots = plan?.halfDaySlots ?? [];

    const name = planner.employee.name;
    const isPartTime = planner.employee.employment_type === "PT";
    const mine = provided.filter(
      (entry) => entry.employee === planner.employee.id || entry.employee === name,
    );

    const raw: LedgerLeaveEntry[] = [];
    if (!isPartTime) {
      for (const date of ctx.days) {
        const isRest = (planner.employee.regular_days_off ?? []).includes(
          parseISODate(date).getDay(),
        );
        if (!isRest) continue;
        if (mine.some((entry) => entry.date === date)) continue;
        raw.push({ date, code: "W", days: 1, employee: name });
      }
    }

    if (mine.length > 0) {
      raw.push(...mine.map((entry) => ({ ...entry, employee: name })));
    } else if (!isPartTime) {
      for (const date of planner.availability.leave ?? []) {
        if (!ctx.days.includes(date)) continue;
        if (raw.some((entry) => entry.date === date)) continue;
        raw.push({ date, code: "SH", days: 1, employee: name });
        if (!defaultShNames.includes(name)) defaultShNames.push(name);
      }
    }

    const numbered = numberLeaveEntries({
      entries: raw,
      employee: planner.employee,
      rules: ctx.rules,
    });
    planner.leaveEntries = numbered.entries.map((entry) => ({ ...entry, employee: name }));
    planner.halfDayLeaveDates = new Set(
      numbered.entries.filter((entry) => entry.days === 0.5).map((entry) => entry.date),
    );
    for (const message of numbered.warnings) {
      ctx.warnings.push({ date: ctx.weekStart, shift: "AM", message, needsManagerAction: true });
    }

    auditMonthlyFloor(ctx, planner);
  }

  if (defaultShNames.length > 0) {
    ctx.warnings.push({
      date: ctx.weekStart,
      shift: "AM",
      message: `${defaultShNames.join("、")} 的假期未提供代號，已按預設 SH 遞增編號，請管理員核對。`,
    });
  }

  const silentPartTimers = ctx.planners
    .filter(
      (planner) =>
        planner.employee.employment_type === "PT" &&
        ctx.days.every((date) => !planner.canWorkByDate[date]),
    )
    .map((planner) => planner.employee.name);
  if (silentPartTimers.length > 0) {
    ctx.warnings.push({
      date: ctx.weekStart,
      shift: "AM",
      message: `兼職 ${silentPartTimers.join("、")} 本週未報更（無可返日子），未編排任何班次。`,
    });
  }
}

function auditMonthlyFloor(ctx: PlanContext, planner: Planner): void {
  if (planner.employee.employment_type === "PT") return;
  const yearMonth = ctx.weekStart.slice(0, 7);
  const target = monthlyMinimumHoursTarget(planner.employee.employment_type, yearMonth, ctx.rules);
  const leaveInMonth = planner.leaveEntries.filter(
    (entry) => entry.code !== "W" && entry.date.slice(0, 7) === yearMonth,
  );
  const fullDay = leaveInMonth.filter((entry) => entry.days === 1).length;
  const halfDay = leaveInMonth.filter((entry) => entry.days === 0.5).length;
  const audit = auditMonthlyHoursFloor({
    employee: planner.employee.name,
    employmentType: planner.employee.employment_type,
    yearMonth,
    rules: ctx.rules,
    scheduledDays: Math.max(0, target.workDays - fullDay),
    halfDayCount: halfDay,
  });
  // 一日假期屬正常浮動；欠鐘超過一個標準日先當「放假過多」出預警。
  if (!audit.ok && audit.shortfallHours > audit.dailyHours && audit.message) {
    ctx.warnings.push({
      date: ctx.weekStart,
      shift: "AM",
      message: audit.message,
      needsManagerAction: true,
    });
  }
}

// ── 排班小工具（工時上限、時間段選擇） ──

function hasAssignmentOn(ctx: PlanContext, employee: string, date: string): boolean {
  return ctx.assignments.some((item) => item.employee === employee && item.date === date);
}

function hoursOnDate(ctx: PlanContext, employee: string, date: string): number {
  return ctx.assignments
    .filter((item) => item.employee === employee && item.date === date)
    .reduce((sum, item) => sum + (item.hours ?? 0), 0);
}

function hoursInWeek(ctx: PlanContext, employee: string, date: string): number {
  const weekStart = sundayOnOrBefore(date);
  return ctx.assignments
    .filter(
      (item) => item.employee === employee && sundayOnOrBefore(item.date) === weekStart,
    )
    .reduce((sum, item) => sum + (item.hours ?? 0), 0);
}

interface AddOptions {
  /** 第一關補缺口用：允許單日超出職級上限（超出部分計 OT），只守每週上限。 */
  allowDailyOverflow?: boolean;
  /** 缺人手時連每週上限都可超出（會出警告並由 Step 4 補鐘平衡）。 */
  allowWeeklyOverflow?: boolean;
  /** 允許同日再加一段更（例如 HFT 已做骨幹 5h，再頂晚市缺口）。 */
  allowAdditional?: boolean;
}

function withinCaps(
  ctx: PlanContext,
  planner: Planner,
  date: string,
  dayHoursAfter: number,
  options: AddOptions,
): boolean {
  const delta = round1(dayHoursAfter - hoursOnDate(ctx, planner.employee.name, date));
  const check = checkHourCaps(
    planner.employee.employment_type,
    dayHoursAfter,
    round1(hoursInWeek(ctx, planner.employee.name, date) + delta),
    ctx.rules,
  );
  const weeklyOk = check.weeklyOk || options.allowWeeklyOverflow === true;
  // PT 的報更時段本身就係其工時（例：17:00-22:00 5h），只守每週上限。
  if (planner.employee.employment_type === "PT") return weeklyOk;
  if (options.allowDailyOverflow) return weeklyOk;
  return check.dailyOk && weeklyOk;
}

function sameDayAssignments(
  ctx: PlanContext,
  employee: string,
  date: string,
): Assignment[] {
  return ctx.assignments.filter(
    (item) => item.employee === employee && item.date === date,
  );
}

/** 已排的更是否已覆蓋該營業時段（覆蓋了就無需再加時，避免白送 OT）。 */
function coversPeriod(
  ctx: PlanContext,
  employee: string,
  date: string,
  period: DbPeriodSpec,
): boolean {
  return sameDayAssignments(ctx, employee, date).some((item) => {
    const win = splitSlot(item.timeSlot ?? "");
    if (!win) return false;
    return win.start < period.endMinutes && win.end >= period.startMinutes;
  });
}

function addAssignment(
  ctx: PlanContext,
  planner: Planner,
  date: string,
  rawSlot: string,
  options: AddOptions = {},
): Assignment | null {
  const name = planner.employee.name;
  if (!planner.canWorkByDate[date]) return null;

  const existing = sameDayAssignments(ctx, name, date);
  if (existing.length > 0 && !options.allowAdditional) return null;

  const eligible = checkTimeSlotEligibility(planner.employee, ctx.rules, normalizeSlotText(rawSlot));
  if (!eligible.allowed) return null;

  // 員工自己申報的固定更／彈性時段原封不動；只有「職級預設營業時段」才補足標準工時。
  const slot = normalizeWorkSlot(
    planner.employee,
    ctx.rules,
    rawSlot,
    !isDeclaredSlot(planner, rawSlot) && isRulesPeriodSlot(ctx, rawSlot),
  );
  if (!slot) return null;
  const win = splitSlot(slot);
  if (!win) return null;
  const hours = slotHours(slot);
  if (hours <= 0) return null;

  const shift = shiftForSlot(ctx, slot);
  // PT 的可返日子已由 Step 1 的 canWorkByDate 決定；FT/HFT 仍要尊重星期偏好，
  // 但員工自己填的固定更／彈性頂更選項屬明示意願，不受星期偏好表限制。
  const isPartTime = planner.employee.employment_type === "PT";
  const declared = isDeclaredSlot(planner, slot);
  if (!isPartTime && !declared && !canWork(planner.availability, date, shift)) return null;

  // 同日已有更：能接駁就併成一段（08:00-12:00 + 12:00-17:00 → 08:00-17:00），
  // 否則加第二段（HFT 07:00-12:00 + 17:00-22:00），兩者帳本都會計足。
  const mergeable = existing.find((item) => {
    const other = splitSlot(item.timeSlot ?? "");
    if (!other) return false;
    return win.start <= other.end && other.start <= win.end;
  });

  const currentDayHours = round1(
    existing.reduce((sum, item) => sum + (item.hours ?? 0), 0),
  );
  const dayHoursAfter = mergeable
    ? (() => {
        const other = splitSlot(mergeable.timeSlot ?? "");
        if (!other) return round1(currentDayHours + hours);
        const mergedHours = round1(
          (Math.max(other.end, win.end) - Math.min(other.start, win.start)) / 60,
        );
        return round1(currentDayHours - (mergeable.hours ?? 0) + mergedHours);
      })()
    : round1(currentDayHours + hours);

  if (!withinCaps(ctx, planner, date, dayHoursAfter, options)) return null;

  if (mergeable) {
    const other = splitSlot(mergeable.timeSlot ?? "");
    if (!other) return null;
    const start = Math.min(other.start, win.start);
    const end = Math.max(other.end, win.end);
    const mergedSlot = `${formatMinutes(start)}-${formatMinutes(end)}`;
    mergeable.timeSlot = mergedSlot;
    mergeable.hours = slotHours(mergedSlot);
    mergeable.shift = shiftForSlot(ctx, mergedSlot);
    return mergeable;
  }

  const assignment: Assignment = {
    date,
    shift,
    employee: name,
    department: planner.employee.department ?? planner.availability.department,
    hours,
    timeSlot: slot,
  };
  ctx.assignments.push(assignment);
  return assignment;
}

/** 可覆蓋該時段的可揀時間段，按重疊時數再按長度排序。 */
function candidateSlots(
  ctx: PlanContext,
  planner: Planner,
  period: DbPeriodSpec,
): string[] {
  const options = workSlotCandidates(planner, ctx);
  const scored = options
    .map((slot) => ({ slot, win: splitSlot(slot) }))
    .filter((item) => item.win !== null)
    .map((item) => {
      const win = item.win as { start: number; end: number };
      const overlap = Math.max(
        0,
        Math.min(win.end, period.endMinutes) - Math.max(win.start, period.startMinutes),
      );
      return { slot: item.slot, overlap, duration: win.end - win.start };
    })
    .filter((item) => item.overlap > 0);
  scored.sort((left, right) => right.overlap - left.overlap || right.duration - left.duration);
  return scored.map((item) => item.slot);
}

function candidatePriority(planner: Planner): number {
  const flexible = (planner.employee.flexible_shift_options ?? []).length > 0 ? 0 : 2;
  if (planner.isManagement) return Math.min(flexible, 2) === 0 ? 0 : 1;
  return flexible;
}

function candidatesFor(ctx: PlanContext, date: string): Planner[] {
  return ctx.planners
    .filter(
      (planner) =>
        planner.canWorkByDate[date] && !hasAssignmentOn(ctx, planner.employee.name, date),
    )
    .sort((left, right) => {
      const byPriority = candidatePriority(left) - candidatePriority(right);
      if (byPriority !== 0) return byPriority;
      const byCategory =
        CATEGORY_PRIORITY[resolveCategory(left.availability)] -
        CATEGORY_PRIORITY[resolveCategory(right.availability)];
      if (byCategory !== 0) return byCategory;
      return hoursInWeek(ctx, left.employee.name, date) - hoursInWeek(ctx, right.employee.name, date);
    });
}

// ── Step 2：骨幹排班 + 管理層坐鎮 ──

function assignBackbone(ctx: PlanContext): void {
  const ordered = [...ctx.planners].sort((left, right) => {
    const fixedDiff =
      (left.employee.fixed_shift_time ? 0 : 1) - (right.employee.fixed_shift_time ? 0 : 1);
    if (fixedDiff !== 0) return fixedDiff;
    const byCategory =
      CATEGORY_PRIORITY[resolveCategory(left.availability)] -
      CATEGORY_PRIORITY[resolveCategory(right.availability)];
    if (byCategory !== 0) return byCategory;
    return left.employee.name.localeCompare(right.employee.name);
  });

  for (const date of ctx.days) {
    for (const planner of ordered) {
      if (!planner.canWorkByDate[date]) continue;
      const isPartTime = planner.employee.employment_type === "PT";
      const base = planner.employee.fixed_shift_time;
      if (isPartTime && !base) continue;

      const candidates = workSlotCandidates(planner, ctx);
      for (const slot of candidates) {
        const plan = planner.halfDayLeaveDates.has(date)
          ? [halfDaySlotFor(ctx, planner, slot)]
          : [slot];
        if (plan.some((item) => addAssignment(ctx, planner, date, item) !== null)) break;
      }
    }
  }
}

function halfDaySlotFor(ctx: PlanContext, planner: Planner, raw: string): string {
  const halfHours = standardDailyHoursFor(planner.employee.employment_type, ctx.rules) / 2;
  const fromRules = planner.halfDaySlots.length > 0 ? planner.halfDaySlots[0] : null;
  if (fromRules && Math.abs(slotHours(fromRules) - halfHours) < 0.01) {
    return normalizeSlotText(fromRules);
  }
  return halfDaySlot(normalizeSlotText(raw), halfHours);
}

function ensureManagement(ctx: PlanContext, date: string): void {
  const managerRecords = ctx.planners
    .filter((planner) => planner.isManagement)
    .map((planner) => planner.employee);
  const audit = (minimum: number) =>
    auditManagementCoverage({
      assignments: ctx.assignments,
      employees: managerRecords,
      rules: ctx.rules,
      iso: date,
      minimum,
    });

  for (let guard = 0; guard < 6; guard += 1) {
    const result = audit(2);
    if (result.ok) return;
    const needMorning = result.morning < 2;
    const target = ctx.periods.find(
      (period) => period.id === (needMorning ? "breakfast" : "dinner"),
    );
    if (!target) break;

    let added = false;
    for (const planner of ctx.planners) {
      if (!planner.isManagement) continue;
      if (!planner.canWorkByDate[date]) continue;
      if (hasAssignmentOn(ctx, planner.employee.name, date)) continue;
      for (const slot of candidateSlots(ctx, planner, target)) {
        if (addAssignment(ctx, planner, date, slot)) {
          added = true;
          break;
        }
      }
      if (added) break;
    }
    if (!added) break;
  }

  const finalAudit = audit(2);
  if (!finalAudit.ok && finalAudit.message) {
    ctx.warnings.push({
      date,
      shift: "AM",
      message: finalAudit.message,
      needsManagerAction: true,
    });
  }
}

// ── Step 3：第一關彈性補缺口 ──

/** 已排骨幹班但仍可彈性頂更的人（彈性選項或管理層）。 */
function flexCandidatesFor(ctx: PlanContext, date: string): Planner[] {
  return ctx.planners
    .filter((planner) => {
      if (!planner.canWorkByDate[date]) return false;
      if (!hasAssignmentOn(ctx, planner.employee.name, date)) return false;
      if (planner.isManagement) return true;
      return (planner.employee.flexible_shift_options ?? []).length > 0;
    })
    .sort(
      (left, right) =>
        hoursInWeek(ctx, left.employee.name, date) -
        hoursInWeek(ctx, right.employee.name, date),
    );
}

function fillShortages(ctx: PlanContext, date: string): void {
  for (const period of ctx.periods) {
    for (let guard = 0; guard < 8; guard += 1) {
      const coverage = auditPeriodCoverage(ctx.assignments, ctx.rules, date).find(
        (item) => item.id === period.id,
      );
      if (!coverage || coverage.shortage <= 0) break;

      let added = false;

      // 第一輪：當日未有更的人（受單日上限約束）。
      for (const planner of candidatesFor(ctx, date)) {
        for (const slot of candidateSlots(ctx, planner, period)) {
          if (addAssignment(ctx, planner, date, slot)) {
            added = true;
            break;
          }
        }
        if (added) break;
      }

      // 第二輪：已排骨幹但具彈性選項／管理層 → 可頂多一段，超出標準日工時計 OT。
      if (!added) {
        for (const planner of flexCandidatesFor(ctx, date)) {
          if (coversPeriod(ctx, planner.employee.name, date, period)) continue;
          const standard = standardDailyHoursFor(planner.employee.employment_type, ctx.rules);
          const dayCap = round1(standard * 2);
          const beforeHours = hoursOnDate(ctx, planner.employee.name, date);
          const weekLimit = checkHourCaps(
            planner.employee.employment_type,
            beforeHours,
            hoursInWeek(ctx, planner.employee.name, date),
            ctx.rules,
          ).weeklyLimit;

          for (const slot of candidateSlots(ctx, planner, period)) {
            // 只放行「員工已申報的彈性更」或管理層；避免任意時段無限加時。
            if (!planner.isManagement && !isDeclaredSlot(planner, slot)) continue;
            const prospective = round1(beforeHours + slotHours(normalizeSlotText(slot)));
            if (prospective > dayCap) continue;

            const created = addAssignment(ctx, planner, date, slot, {
              allowAdditional: true,
              allowDailyOverflow: true,
              allowWeeklyOverflow: true,
            });
            if (!created) continue;
            added = true;
            const afterHours = hoursOnDate(ctx, planner.employee.name, date);
            const afterWeek = hoursInWeek(ctx, planner.employee.name, date);
            const otHours = round1(Math.max(0, afterHours - Math.max(standard, beforeHours)));
            ctx.warnings.push({
              date,
              shift: created.shift,
              message: `${planner.employee.name}（${planner.employee.employment_type}）彈性頂更 ${created.timeSlot}，當日合計 ${afterHours}h（標準 ${standard}h）${
                otHours > 0 ? `，其中 ${otHours}h 按 OT 計算` : ""
              }。`,
            });
            if (afterWeek > weekLimit) {
              ctx.warnings.push({
                date,
                shift: created.shift,
                needsManagerAction: true,
                message: `${planner.employee.name} 本週累計 ${afterWeek}h 已超每週上限 ${weekLimit}h，因缺人手照排，請管理員安排補鐘。`,
              });
            }
            break;
          }
          if (added) break;
        }
      }

      if (!added) break;
    }
  }
}

function auditDay(ctx: PlanContext, date: string): void {
  const coverages = auditPeriodCoverage(ctx.assignments, ctx.rules, date);
  const shortages = coverages.filter((item) => item.shortage > 0);

  if (shortages.length > 0) {
    ctx.shortages.push({
      date,
      periods: shortages.map((item) => ({
        id: item.id,
        label: item.label,
        required: item.required,
        actual: item.actual,
        shortage: item.shortage,
      })),
      backups: [...ctx.backups],
    });
    const day = parseISODate(date);
    for (const item of shortages) {
      ctx.warnings.push({
        date,
        shift:
          item.id === "opening" || item.id === "breakfast"
            ? "AM"
            : item.id === "lunch" || item.id === "tea"
              ? "PM"
              : "EVE",
        needsManagerAction: true,
        message: `${day.getMonth() + 1}/${day.getDate()} ${item.label} 缺人手 ${item.actual}/${item.required}；可呼叫後備：${
          ctx.backups.length > 0 ? ctx.backups.join("、") : "（未設定後備名單）"
        }`,
      });
    }
  }

  const salaried = ctx.planners.filter(
    (planner) => planner.employee.employment_type !== "PT",
  );
  const maxAllowedOff = maxAllowedSalariedOff(salaried.length);
  // 只計申請假期（AL / SH）；固定例休（W）唔算放假超額。
  const salariedLeave = salaried.filter((planner) =>
    planner.leaveEntries.some(
      (entry) => entry.date === date && entry.days === 1 && entry.code !== "W",
    ),
  ).length;
  if (salariedLeave > maxAllowedOff) {
    ctx.warnings.push({
      date,
      shift: "AM",
      needsManagerAction: true,
      message: leaveExcessWarning(date, salariedLeave, maxAllowedOff),
    });
  }
}

// ── Step 4：第二關工時上下限與 OT / 欠鐘自動調整 ──

function applyOtBalance(ctx: PlanContext): void {
  for (const planner of ctx.planners) {
    const employmentType = planner.employee.employment_type;
    if (employmentType === "PT") continue;
    const standard = standardDailyHoursFor(employmentType, ctx.rules);
    const halfHours = round1(standard / 2);
    const name = planner.employee.name;

    let balance = 0;
    let overtime = 0;

    for (let index = 0; index < ctx.days.length; index += 1) {
      const date = ctx.days[index];
      const dayAssignments = ctx.assignments.filter(
        (item) => item.employee === name && item.date === date,
      );
      const leaveDays = Math.min(
        1,
        planner.leaveEntries
          .filter((entry) => entry.date === date)
          .reduce((sum, entry) => sum + entry.days, 0),
      );
      const expected = round1(standard * (1 - leaveDays));
      if (dayAssignments.length === 0 && expected <= 0) continue;

      const actual = round1(
        dayAssignments.reduce((sum, item) => sum + (item.hours ?? 0), 0),
      );
      const delta = round1(actual - expected);
      overtime = round1(overtime + Math.max(0, delta));
      balance = round1(balance + delta);

      const nextDate = ctx.days[index + 1];
      if (!nextDate) continue;

      const advice = suggestOtBalance({
        otHours: overtime,
        timeBalanceHours: balance,
        shortageOnNextDay: ctx.shortages.some((item) => item.date === nextDate),
      });
      if (advice.action === "none" && !advice.exempted) continue;

      if (advice.exempted) {
        ctx.warnings.push({
          date: nextDate,
          shift: "AM",
          message: `${name}：${advice.message}`,
          needsManagerAction: true,
        });
        continue;
      }

      if (advice.action === "half_day_comp") {
        const target = ctx.assignments.find(
          (item) => item.employee === name && item.date === nextDate,
        );
        if (!target) continue;
        const currentSlot = target.timeSlot ?? "";
        const reduced = halfDaySlot(currentSlot, halfHours);
        const reducedHours = slotHours(reduced);
        if (reducedHours <= 0 || reducedHours >= (target.hours ?? 0)) continue;
        balance = round1(balance - (round1(target.hours ?? 0) - reducedHours));
        target.timeSlot = reduced;
        target.hours = reducedHours;
        target.shift = shiftForSlot(ctx, reduced);
        ctx.warnings.push({
          date: nextDate,
          shift: target.shift,
          message: `${name} ${advice.message}（改為 ${reduced} 半日 ${reducedHours}h）`,
        });
        continue;
      }

      if (advice.action === "full_day_deficit_repay") {
        if (hasAssignmentOn(ctx, name, nextDate)) continue;
        for (const slot of eligibleShiftOptions(planner.employee, ctx.rules)) {
          const added = addAssignment(ctx, planner, nextDate, slot);
          if (added) {
            balance = round1(balance + standard);
            ctx.warnings.push({
              date: nextDate,
              shift: added.shift,
              message: `${name} ${advice.message}`,
            });
            break;
          }
        }
      }
    }
  }
}

// ── Step 5：輸出工時與帳本結算 ──

function dedupeWarnings(warnings: RosterWarning[]): RosterWarning[] {
  const seen = new Set<string>();
  const result: RosterWarning[] = [];
  for (const warning of warnings) {
    const key = `${warning.date}|${warning.shift}|${warning.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(warning);
  }
  return result;
}

function buildPipelineWeekSchedule(
  input: BuildWeekScheduleInput,
  rules: RosterRules,
): SchedulePipelineResult {
  const ctx: PlanContext = {
    rules,
    weekStart: input.weekStart,
    days: weekDates(input.weekStart),
    periods: servicePeriodsFromRules(rules),
    planners: buildPlanners(input),
    assignments: [],
    warnings: [],
    shortages: [],
    backups: collectBackups(input),
  };

  applyLeaveFirst(ctx, input);
  assignBackbone(ctx);
  for (const date of ctx.days) {
    ensureManagement(ctx, date);
    fillShortages(ctx, date);
    auditDay(ctx, date);
  }
  applyOtBalance(ctx);

  ctx.assignments.sort(
    (left, right) =>
      left.date.localeCompare(right.date) || left.shift.localeCompare(right.shift),
  );

  const leaveEntries = ctx.planners.flatMap((planner) => planner.leaveEntries);
  const employeeRecords = ctx.planners.map((planner) => planner.employee);
  const ledger = buildHoursLedger({
    assignments: ctx.assignments,
    employees: employeeRecords,
    rules,
    leaveEntries,
  });

  const settlementDate = ctx.days.find((date) => isAlSettlementDate(date, rules));
  const settlement = settlementDate
    ? settleAnnualLeave({
        employees: employeeRecords,
        rules,
        year: parseISODate(settlementDate).getFullYear(),
      })
    : null;

  const names = ctx.planners.map((planner) => planner.employee.name);
  const { dailyHours, employeeHours } = summarizeSchedule(ctx.days, ctx.assignments, names);

  const monthlyHours: EmployeeMonthlyHours[] = ledger.monthly.map((row) => ({
    yearMonth: row.yearMonth,
    employee: row.employee,
    totalHours: row.totalHours,
    daysWorked: row.daysWorked,
    timeBalanceHours: row.timeBalanceHours,
  }));

  const warnings = dedupeWarnings([
    ...ctx.warnings,
    ...ledger.warnings.map((message) => ({
      date: ctx.weekStart,
      shift: "AM" as const,
      message,
    })),
  ]);

  return {
    schedule: {
      days: ctx.days,
      shifts: [...WORKING_SHIFTS],
      assignments: ctx.assignments,
      dailyHours,
      employeeHours,
      monthlyHours,
      compTimeHours: ledger.compTime,
      payableOtHours: ledger.payableOt,
      alSettlement: settlement?.summaries,
    },
    warnings,
    leaveEntries,
    ledger,
    shortages: ctx.shortages,
  };
}
