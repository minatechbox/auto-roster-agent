import type {
  AlSettlementSummary,
  Assignment,
  Employee,
  EmployeeHoursAllocation,
  EmploymentType,
  LeaveCode,
  LeaveEntry,
  RosterRules,
} from "../types";
import {
  getAssignmentWindowMinutes,
  parseISODate,
  standardDailyHoursFor,
  sundayOnOrBefore,
} from "./rules";

// ═════════════════════════════════════════════
// Stage 3 Step 3：假期累計編號 + 工時／OT／欠鐘帳本
// 純運算，零 side effect。所有門檻讀 rules / employee，
// 唯一 fallback 係 DB 未設定時的極簡假設。
// ═════════════════════════════════════════════

const FALLBACK_REST_RULE = { workDays: 6, restDays: 1, cycleDays: 7 };
const FALLBACK_SETTLE_MONTH = 12;
const FALLBACK_SETTLE_DAY = 31;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

// ── 1. 三類假期單一累計編號（W / SH / AL） ──

const LEAVE_LABEL_PATTERN = /^(AL|SH|W)\s*(\d+(?:\.\d+)?)$/i;

/** "W49" / "SH14" / "AL5.5" → { code, count }；格式不合回 null。 */
export function parseLeaveLabel(raw: string): { code: LeaveCode; count: number } | null {
  if (typeof raw !== "string") return null;
  const match = LEAVE_LABEL_PATTERN.exec(raw.trim());
  if (!match) return null;
  const code = match[1].toUpperCase() as LeaveCode;
  const count = Number(match[2]);
  if (!Number.isFinite(count) || count < 0) return null;
  return { code, count: round1(count) };
}

/** 格式化標籤：整數不加小數位（49 → "W49"），半日保留一位（5.5 → "AL5.5"）。 */
export function formatLeaveLabel(code: LeaveCode, count: number): string {
  const normalized = round1(count);
  return `${code}${Number.isInteger(normalized) ? normalized : normalized.toFixed(1)}`;
}

export interface LeaveLimits {
  /** SH 年度法定假上限（rules.statutory_holidays_yearly，未設定回 null）。 */
  shYearlyCap: number | null;
  /** AL 年度總額（employee.annual_leave_total）。 */
  alTotal: number | null;
}

export function leaveLimitsFrom(employee: Employee, rules: RosterRules): LeaveLimits {
  const shCap = rules?.statutory_holidays_yearly;
  const alTotal = employee?.annual_leave_total;
  return {
    shYearlyCap: typeof shCap === "number" && shCap > 0 ? shCap : null,
    alTotal: typeof alTotal === "number" && alTotal > 0 ? alTotal : null,
  };
}

function limitForCode(code: LeaveCode, limits: LeaveLimits): number | null {
  if (code === "SH") return limits.shYearlyCap;
  if (code === "AL") return limits.alTotal;
  return null; // W（例假）無年度上限
}

export interface LeaveLabelStep {
  code: LeaveCode;
  previousCount: number;
  nextCount: number;
  label: string;
  /** W 無上限 → null。 */
  limit: number | null;
  remainingAfter: number | null;
  exceeded: boolean;
  warning?: string;
}

/** 由基準標籤遞增一天（或半日），同時檢核上限。 */
export function nextLeaveLabel(input: {
  base: string | { code: LeaveCode; count: number };
  days: number;
  employee: Employee;
  rules: RosterRules;
}): LeaveLabelStep | null {
  const parsed =
    typeof input.base === "string"
      ? parseLeaveLabel(input.base)
      : { code: input.base.code, count: round1(input.base.count) };
  if (!parsed) return null;
  if (!Number.isFinite(input.days) || input.days <= 0) return null;

  const limits = leaveLimitsFrom(input.employee, input.rules);
  const limit = limitForCode(parsed.code, limits);
  const previousCount = round1(parsed.count);
  const nextCount = round1(previousCount + input.days);
  const remainingAfter = limit === null ? null : round1(limit - nextCount);
  const exceeded = limit !== null && nextCount > limit;

  return {
    code: parsed.code,
    previousCount,
    nextCount,
    label: formatLeaveLabel(parsed.code, nextCount),
    limit,
    remainingAfter,
    exceeded,
    warning: exceeded
      ? `${input.employee.name} ${parsed.code} 累計 ${nextCount} 超出上限 ${limit}，請管理員確認。`
      : undefined,
  };
}

export type LedgerLeaveEntry = LeaveEntry & { employee: string };

export interface LeaveNumberingResult {
  /** 已補上 label 的假期紀錄（按日期排序）。 */
  entries: LeaveEntry[];
  counters: Record<LeaveCode, number>;
  labels: Record<LeaveCode, string>;
  warnings: string[];
}

/**
 * 逐條假期按實際天數（1 / 0.5）遞增編號。
 * 基準標籤只覆寫其所屬類別；其餘兩類由 employee 現有 count 起算。
 */
export function numberLeaveEntries(input: {
  baseLabel?: string;
  entries: readonly LedgerLeaveEntry[];
  employee: Employee;
  rules: RosterRules;
}): LeaveNumberingResult {
  const limits = leaveLimitsFrom(input.employee, input.rules);
  const counters: Record<LeaveCode, number> = {
    AL: round1(input.employee.al_current_count ?? 0),
    SH: round1(input.employee.sh_current_count ?? 0),
    W: round1(input.employee.w_current_count ?? 0),
  };
  const warnings: string[] = [];

  const base = input.baseLabel ? parseLeaveLabel(input.baseLabel) : null;
  if (input.baseLabel && !base) {
    warnings.push(`基準標籤「${input.baseLabel}」格式不合（應如 W49 / SH14 / AL5.5），已改用員工現有計數。`);
  }
  if (base) counters[base.code] = base.count;

  const ordered = [...input.entries].sort((a, b) => a.date.localeCompare(b.date));
  const entries: LeaveEntry[] = [];

  for (const entry of ordered) {
    const days = entry.days === 0.5 ? 0.5 : 1;
    counters[entry.code] = round1(counters[entry.code] + days);
    const limit = limitForCode(entry.code, limits);
    if (limit !== null && counters[entry.code] > limit) {
      warnings.push(
        `${input.employee.name} ${entry.date} ${entry.code} 累計 ${counters[entry.code]} 超出上限 ${limit}。`,
      );
    }
    entries.push({ ...entry, label: formatLeaveLabel(entry.code, counters[entry.code]) });
  }

  const labels: Record<LeaveCode, string> = {
    AL: formatLeaveLabel("AL", counters.AL),
    SH: formatLeaveLabel("SH", counters.SH),
    W: formatLeaveLabel("W", counters.W),
  };

  return { entries, counters, labels, warnings };
}

export interface MonthRestSummary {
  yearMonth: string;
  year: number;
  month: number;
  daysInMonth: number;
  /** 當月星期日數量。 */
  sundays: number;
  cycleDays: number;
  restDaysPerCycle: number;
  restDays: number;
  workDays: number;
}

/**
 * 依 rules.weekly_rest_rule 計當月應有例假日數（6 上 1 休 → 每個星期日 1 日例假）。
 * 每週例假 = restDays × 7 / cycleDays；當月例假 = 星期日數 × 每週例假（向下取整）。
 */
export function restDaysInMonth(yearMonth: string, rules: RosterRules): MonthRestSummary {
  const [year, month] = yearMonth.split("-").map(Number);
  const safeYear = year || new Date().getFullYear();
  const safeMonth = month >= 1 && month <= 12 ? month : 1;
  const daysInMonth = new Date(safeYear, safeMonth, 0).getDate();

  let sundays = 0;
  for (let day = 1; day <= daysInMonth; day += 1) {
    if (new Date(safeYear, safeMonth - 1, day).getDay() === 0) sundays += 1;
  }

  const rule = rules?.weekly_rest_rule ?? FALLBACK_REST_RULE;
  const cycleDays =
    typeof rule.cycleDays === "number" && rule.cycleDays > 0 ? rule.cycleDays : FALLBACK_REST_RULE.cycleDays;
  const restDaysPerCycle =
    typeof rule.restDays === "number" && rule.restDays >= 0 ? rule.restDays : FALLBACK_REST_RULE.restDays;
  const perWeek = (restDaysPerCycle * 7) / cycleDays;
  const restDays = Math.floor(sundays * perWeek + 1e-9);
  const workDays = Math.max(0, daysInMonth - restDays);

  return {
    yearMonth: `${safeYear}-${pad2(safeMonth)}`,
    year: safeYear,
    month: safeMonth,
    daysInMonth,
    sundays,
    cycleDays,
    restDaysPerCycle,
    restDays,
    workDays,
  };
}

// ── 2. 年終大假結算（12-31） ──

export interface AlSettlementNextYear {
  employeeId: string;
  employee: string;
  /** resetCurrentCount 為 true → 0；否則沿用結算前數值。 */
  al_current_count: number;
}

export interface AlSettlementResult {
  year: number;
  settleDate: string;
  convertRemainingToSalary: boolean;
  resetCurrentCount: boolean;
  summaries: AlSettlementSummary[];
  nextYearAlCounts: AlSettlementNextYear[];
  totalRemainingDays: number;
  totalConvertedDays: number;
}

/**
 * 依 rules.al_settlement_rule 於結算日計剩餘年假，輸出轉薪金日數摘要及新一年狀態。
 * salaryRatePerDay 未傳入時 salaryAmount 留空，避免虛構薪酬。
 */
export function settleAnnualLeave(input: {
  employees: readonly Employee[];
  rules: RosterRules;
  year: number;
  salaryRatePerDay?: number;
}): AlSettlementResult {
  const rule = input.rules?.al_settlement_rule;
  const settleMonth = rule?.settleMonth ?? FALLBACK_SETTLE_MONTH;
  const settleDay = rule?.settleDay ?? FALLBACK_SETTLE_DAY;
  const convertRemainingToSalary = rule?.convertRemainingToSalary === true;
  const resetCurrentCount = rule?.resetCurrentCount !== false;
  const settleDate = `${input.year}-${pad2(settleMonth)}-${pad2(settleDay)}`;
  const rate = input.salaryRatePerDay;

  const summaries: AlSettlementSummary[] = [];
  const nextYearAlCounts: AlSettlementNextYear[] = [];
  let totalRemainingDays = 0;
  let totalConvertedDays = 0;

  for (const emp of input.employees) {
    if (emp.is_active === false) continue;
    const total = typeof emp.annual_leave_total === "number" ? emp.annual_leave_total : 0;
    const used = typeof emp.al_current_count === "number" ? emp.al_current_count : 0;
    const remainingAl = round1(Math.max(0, total - used));
    const convertedDays = convertRemainingToSalary ? remainingAl : 0;

    totalRemainingDays = round1(totalRemainingDays + remainingAl);
    totalConvertedDays = round1(totalConvertedDays + convertedDays);

    summaries.push({
      year: input.year,
      employee: emp.name,
      remainingAl,
      convertedToSalary: convertRemainingToSalary,
      convertedDays: convertRemainingToSalary ? convertedDays : undefined,
      salaryAmount:
        convertRemainingToSalary && typeof rate === "number" && rate > 0
          ? round2(convertedDays * rate)
          : undefined,
      settledAt: settleDate,
    });

    nextYearAlCounts.push({
      employeeId: emp.id,
      employee: emp.name,
      al_current_count: resetCurrentCount ? 0 : used,
    });
  }

  return {
    year: input.year,
    settleDate,
    convertRemainingToSalary,
    resetCurrentCount,
    summaries,
    nextYearAlCounts,
    totalRemainingDays,
    totalConvertedDays,
  };
}

// ── 3. 每日／每週／每月工時與 OT / 欠鐘雙向帳本 ──

/** 同一天多段更（例如拆更）合併重疊時段後的實際工時。 */
function mergedAssignmentHours(items: readonly Assignment[]): number {
  const windows = items
    .map((item) => getAssignmentWindowMinutes(item))
    .sort((left, right) => left.start - right.start);

  let totalMinutes = 0;
  let curStart = -1;
  let curEnd = -1;

  for (const win of windows) {
    if (curEnd < 0) {
      curStart = win.start;
      curEnd = win.end;
      continue;
    }
    if (win.start <= curEnd) {
      curEnd = Math.max(curEnd, win.end);
    } else {
      totalMinutes += curEnd - curStart;
      curStart = win.start;
      curEnd = win.end;
    }
  }
  if (curEnd >= 0) totalMinutes += curEnd - curStart;

  return round2(totalMinutes / 60);
}

export interface LedgerDayRow {
  date: string;
  employee: string;
  employeeId: string;
  employmentType: EmploymentType;
  /** 扣除當日假期後的應有工時（全日假 → 0）。 */
  expectedHours: number;
  /** 更表實際時間段總和（例：07:00-15:00 → 8h）。 */
  actualHours: number;
  /** 正數 = OT；負數 = 補鐘早收／欠鐘。 */
  deltaHours: number;
  overtimeHours: number;
  deficitHours: number;
  /** 跨日累計：正 = 可補鐘餘額；負 = 欠公司鐘。 */
  timeBalanceHours: number;
  leave: LeaveEntry[];
}

export interface LedgerWeekRow {
  weekStart: string;
  employee: string;
  employeeId: string;
  totalHours: number;
  daysWorked: number;
  /** 等效上班天數 = 總工時 ÷ 職級標準日工時。 */
  equivalentDays: number;
  timeBalanceHours: number;
}

export interface LedgerMonthRow {
  yearMonth: string;
  employee: string;
  employeeId: string;
  totalHours: number;
  daysWorked: number;
  equivalentDays: number;
  timeBalanceHours: number;
}

export interface DeficitClearance {
  employee: string;
  employeeId: string;
  date: string;
  /** 半日單位數（欠鐘 ≥ 半天標準工時時觸發）。 */
  units: number;
  hoursPerUnit: number;
  hoursCleared: number;
  balanceBefore: number;
  balanceAfter: number;
}

export interface EmployeeLedgerBalance {
  employee: string;
  employeeId: string;
  employmentType: EmploymentType;
  standardDailyHours: number;
  /** 可補鐘半日門檻（標準日工時 ÷ 2，FT 由 DB 10h 推得 5h）。 */
  halfDayHours: number;
  overtimeHours: number;
  deficitHours: number;
  timeBalanceHours: number;
  otCompensationMode: "time_off" | "cash";
}

export interface HoursLedger {
  daily: LedgerDayRow[];
  weekly: LedgerWeekRow[];
  monthly: LedgerMonthRow[];
  compTime: EmployeeHoursAllocation[];
  payableOt: EmployeeHoursAllocation[];
  deficitClearances: DeficitClearance[];
  balances: EmployeeLedgerBalance[];
  warnings: string[];
}

/**
 * 每日差額 = 更表實際時間段工時 − 職級標準日工時（有假期則按天數扣減應有工時）。
 * 不使用 assignment.hours / hoursAdjustment 等任何手動數字。
 */
export function buildHoursLedger(input: {
  assignments: readonly Assignment[];
  employees: readonly Employee[];
  rules: RosterRules;
  leaveEntries?: readonly LedgerLeaveEntry[];
}): HoursLedger {
  const active = input.employees.filter((emp) => emp.is_active !== false);
  const leaveEntries = input.leaveEntries ?? [];
  const warnings: string[] = [];

  const daily: LedgerDayRow[] = [];
  const deficitClearances: DeficitClearance[] = [];
  const compTime: EmployeeHoursAllocation[] = [];
  const payableOt: EmployeeHoursAllocation[] = [];
  const balances: EmployeeLedgerBalance[] = [];

  const unknownNames = new Set<string>();
  for (const assignment of input.assignments) {
    const known = active.some(
      (emp) => emp.name === assignment.employee || emp.id === assignment.employee,
    );
    if (!known) unknownNames.add(assignment.employee);
  }
  for (const name of unknownNames) {
    warnings.push(`更表有未知員工「${name}」，已從工時帳本略過。`);
  }

  for (const emp of active) {
    const standardHours = standardDailyHoursFor(emp.employment_type, input.rules);
    const halfDayHours = round1(standardHours / 2);
    const mine = input.assignments.filter(
      (item) => item.employee === emp.name || item.employee === emp.id,
    );
    const myLeave = leaveEntries.filter(
      (entry) => entry.employee === emp.id || entry.employee === emp.name,
    );
    const dates = Array.from(
      new Set([...mine.map((item) => item.date), ...myLeave.map((entry) => entry.date)]),
    ).sort((a, b) => a.localeCompare(b));

    let balance = 0;
    let totalOvertime = 0;
    let totalDeficit = 0;

    for (const date of dates) {
      const dayAssignments = mine.filter((item) => item.date === date);
      const dayLeave = myLeave.filter((entry) => entry.date === date);
      const leaveDays = Math.min(1, dayLeave.reduce((sum, entry) => sum + entry.days, 0));
      const expectedHours = round1(standardHours * (1 - leaveDays));

      // 全日假又無返工 → 無帳可記。
      if (dayAssignments.length === 0 && expectedHours <= 0) continue;

      const actualHours = mergedAssignmentHours(dayAssignments);
      const deltaHours = round1(actualHours - expectedHours);
      const overtimeHours = Math.max(0, deltaHours);
      const deficitHours = Math.max(0, -deltaHours);

      if (overtimeHours > 0) totalOvertime = round1(totalOvertime + overtimeHours);
      if (deficitHours > 0) totalDeficit = round1(totalDeficit + deficitHours);

      balance = round1(balance + deltaHours);

      // 欠鐘 ≥ 半天標準工時 → 補半天（可多個單位）清零。
      if (halfDayHours > 0) {
        let guard = 0;
        while (balance <= -halfDayHours && guard < 100) {
          const units = Math.max(1, Math.floor(Math.abs(balance) / halfDayHours + 1e-9));
          const hoursCleared = round1(units * halfDayHours);
          const balanceBefore = balance;
          balance = round1(balance + hoursCleared);
          deficitClearances.push({
            employee: emp.name,
            employeeId: emp.id,
            date,
            units,
            hoursPerUnit: halfDayHours,
            hoursCleared,
            balanceBefore,
            balanceAfter: balance,
          });
          warnings.push(
            `${emp.name} ${date} 欠鐘 ${Math.abs(balanceBefore)}h，已補 ${units} 個半天（${hoursCleared}h）清零，餘額 ${balance}h。`,
          );
          guard += 1;
        }
      }

      daily.push({
        date,
        employee: emp.name,
        employeeId: emp.id,
        employmentType: emp.employment_type,
        expectedHours,
        actualHours,
        deltaHours,
        overtimeHours,
        deficitHours,
        timeBalanceHours: balance,
        leave: dayLeave.map((entry) => ({ ...entry })),
      });
    }

    if (balance < 0) {
      warnings.push(`${emp.name} 期末仍欠公司鐘 ${Math.abs(balance)}h。`);
    }

    const mode: "time_off" | "cash" = emp.ot_compensation_mode === "cash" ? "cash" : "time_off";
    if (totalOvertime > 0) {
      const allocation: EmployeeHoursAllocation = {
        employee: emp.name,
        overtimeHours: totalOvertime,
        mode,
      };
      if (mode === "cash") payableOt.push(allocation);
      else compTime.push(allocation);
    }

    balances.push({
      employee: emp.name,
      employeeId: emp.id,
      employmentType: emp.employment_type,
      standardDailyHours: standardHours,
      halfDayHours,
      overtimeHours: totalOvertime,
      deficitHours: totalDeficit,
      timeBalanceHours: balance,
      otCompensationMode: mode,
    });
  }

  daily.sort((a, b) => a.date.localeCompare(b.date) || a.employee.localeCompare(b.employee));

  const weekly: LedgerWeekRow[] = [];
  const monthly: LedgerMonthRow[] = [];

  for (const emp of active) {
    const rows = daily.filter((row) => row.employeeId === emp.id);
    if (rows.length === 0) continue;
    const standardHours = standardDailyHoursFor(emp.employment_type, input.rules);

    const weekGroups = new Map<string, LedgerDayRow[]>();
    const monthGroups = new Map<string, LedgerDayRow[]>();
    for (const row of rows) {
      const weekKey = sundayOnOrBefore(row.date);
      weekGroups.set(weekKey, [...(weekGroups.get(weekKey) ?? []), row]);
      const monthKey = row.date.slice(0, 7);
      monthGroups.set(monthKey, [...(monthGroups.get(monthKey) ?? []), row]);
    }

    for (const [weekStart, weekRows] of weekGroups) {
      const sorted = [...weekRows].sort((a, b) => a.date.localeCompare(b.date));
      const totalHours = round1(sorted.reduce((sum, row) => sum + row.actualHours, 0));
      weekly.push({
        weekStart,
        employee: emp.name,
        employeeId: emp.id,
        totalHours,
        daysWorked: sorted.filter((row) => row.actualHours > 0).length,
        equivalentDays: standardHours > 0 ? round1(totalHours / standardHours) : 0,
        timeBalanceHours: sorted[sorted.length - 1]?.timeBalanceHours ?? 0,
      });
    }

    for (const [yearMonth, monthRows] of monthGroups) {
      const sorted = [...monthRows].sort((a, b) => a.date.localeCompare(b.date));
      const totalHours = round1(sorted.reduce((sum, row) => sum + row.actualHours, 0));
      monthly.push({
        yearMonth,
        employee: emp.name,
        employeeId: emp.id,
        totalHours,
        daysWorked: sorted.filter((row) => row.actualHours > 0).length,
        equivalentDays: standardHours > 0 ? round1(totalHours / standardHours) : 0,
        timeBalanceHours: sorted[sorted.length - 1]?.timeBalanceHours ?? 0,
      });
    }
  }

  weekly.sort(
    (a, b) => a.weekStart.localeCompare(b.weekStart) || a.employee.localeCompare(b.employee),
  );
  monthly.sort(
    (a, b) => a.yearMonth.localeCompare(b.yearMonth) || a.employee.localeCompare(b.employee),
  );

  return {
    daily,
    weekly,
    monthly,
    compTime,
    payableOt,
    deficitClearances,
    balances,
    warnings,
  };
}

// ── 4. 小工具（供日曆／路由使用） ──

/** 單一更表時段的實際工時（小時）。 */
export function assignmentHours(assignment: Assignment): number {
  const win = getAssignmentWindowMinutes(assignment);
  return round2((win.end - win.start) / 60);
}

/** 指定日期是否年終結算日（由 rules.al_settlement_rule 決定）。 */
export function isAlSettlementDate(iso: string, rules: RosterRules): boolean {
  const rule = rules?.al_settlement_rule;
  const settleMonth = rule?.settleMonth ?? FALLBACK_SETTLE_MONTH;
  const settleDay = rule?.settleDay ?? FALLBACK_SETTLE_DAY;
  const date = parseISODate(iso);
  return date.getMonth() + 1 === settleMonth && date.getDate() === settleDay;
}
