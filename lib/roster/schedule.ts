import type {
  Assignment,
  DailyHourSummary,
  EmployeeAvailability,
  EmployeeHourSummary,
  RosterWarning,
  ScheduleResult,
  StaffCategory,
} from "../types";
import { WORKING_SHIFTS } from "../types";
import {
  SERVICE_PERIODS,
  STAFF_CONFIG,
  canWork,
  countStaffInPeriod,
  hoursForEmployeeShift,
  hoursWorked,
  isOnLeave,
  leaveExcessWarning,
  maxAllowedSalariedOff,
  periodCoverageWarningMessage,
  requiredPeriodHeadcount,
  resolveCategory,
  shiftsWorked,
  weekDates,
} from "./rules";
import type { ServicePeriodId } from "./rules";

export interface BuildWeekScheduleInput {
  weekStart: string;
  employees: EmployeeAvailability[];
}

const CATEGORY_PRIORITY: Record<StaffCategory, number> = {
  full_time: 1,
  half_full_time: 2,
  part_time: 3,
};

export function buildWeekSchedule(
  input: BuildWeekScheduleInput,
): ScheduleResult {
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