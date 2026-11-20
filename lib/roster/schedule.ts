import type {
  Assignment,
  DailyHourSummary,
  EmployeeAvailability,
  EmployeeHourSummary,
  ScheduleResult,
  Shift,
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
  managerActionWarning,
  periodCoverageWarningMessage,
  requiredPeriodHeadcount,
  resolveCategory,
  shiftsWorked,
  weekDates,
} from "./rules";

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
  const warnings: ScheduleResult["warnings"] = [];

  for (const date of days) {
    // 1. 先統計當日申請放假人數（長工＋半長工），檢查是否超出限定放假人數
    const salariedStaff = input.employees.filter((emp) => {
      const cat = resolveCategory(emp);
      return cat === "full_time" || cat === "half_full_time";
    });
    const requestedOff = salariedStaff.filter((emp) => isOnLeave(emp, date));
    const maxAllowedOff = Math.max(1, Math.floor(salariedStaff.length / 6));

    if (requestedOff.length > maxAllowedOff) {
      warnings.push({
        date,
        shift: "AM",
        needsManagerAction: true,
        message: managerActionWarning(
          date,
          "AM",
          requestedOff.length,
          maxAllowedOff,
        ),
      });
    }

    // 2. 再按類別（長工 -> 半長工 -> 兼職）排更，遵守每週日數及工時上限
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
        if (assignedToday.has(emp.name)) continue;
        if (!canWork(emp, date, shift)) continue;

        const cat = resolveCategory(emp);
        const cfg = STAFF_CONFIG[cat];
        const currentDays = shiftsWorked(assignments, emp.name);
        const currentHours = hoursWorked(assignments, emp.name);
        const addHours = hoursForEmployeeShift(emp, shift);

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

    // 3. 按「初遇」更表底部六大時段核對在崗人數，唔夠就出警告
    const dayAssignments = assignments.filter((a) => a.date === date);
    for (const period of SERVICE_PERIODS) {
      const required = requiredPeriodHeadcount(date, period);
      const actual = countStaffInPeriod(dayAssignments, period);
      if (actual < required) {
        warnings.push({
          date,
          shift: period.id === "opening" || period.id === "breakfast" ? "AM" : "PM",
          message: periodCoverageWarningMessage(date, period.label, actual, required),
        });
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
    warnings,
  };
}

export function shiftOnDate(
  employeeName: string,
  date: string,
  assignments: readonly Assignment[],
): Shift {
  const found = assignments.find(
    (item) => item.employee === employeeName && item.date === date,
  );
  return found?.shift ?? "OFF";
}