import type {
  Assignment,
  EmployeeAvailability,
  ScheduleResult,
  Shift,
  WorkingShift,
} from "../types";
import { WORKING_SHIFTS } from "../types";
import {
  MIN_HEADCOUNT_PER_SHIFT,
  canWork,
  shiftsWorked,
  warningMessage,
  weekDates,
} from "./rules";

export interface BuildWeekScheduleInput {
  weekStart: string;
  employees: EmployeeAvailability[];
}

/**
 * Build one Monday–Sunday draft.
 * Within a day, the shift with fewer eligible people is filled first so
 * coverage is attempted before a flexible person is spent on an easier shift.
 * The person chosen is the one with fewer shifts already assigned this week.
 * Ties keep the earlier position in `employees`.
 * A shift that cannot reach the minimum is left empty and recorded as a warning.
 */
export function buildWeekSchedule(
  input: BuildWeekScheduleInput,
): ScheduleResult {
  const days = weekDates(input.weekStart);
  const assignments: Assignment[] = [];
  const warnings: ScheduleResult["warnings"] = [];
  const orderIndex = new Map(
    input.employees.map((employee, index) => [employee.name, index]),
  );

  for (const date of days) {
    const shiftOrder = shiftsByScarcity(date, input.employees);
    const assignedToday = new Set<string>();

    for (const shift of shiftOrder) {
      const candidates = input.employees.filter(
        (employee) =>
          !assignedToday.has(employee.name) && canWork(employee, date, shift),
      );

      if (candidates.length < MIN_HEADCOUNT_PER_SHIFT) {
        warnings.push({
          date,
          shift,
          message: warningMessage(date, shift),
        });
        continue;
      }

      candidates.sort(
        (left, right) =>
          shiftsWorked(assignments, left.name) -
            shiftsWorked(assignments, right.name) ||
          (orderIndex.get(left.name) ?? 0) - (orderIndex.get(right.name) ?? 0),
      );

      const chosen = candidates.slice(0, MIN_HEADCOUNT_PER_SHIFT);
      for (const employee of chosen) {
        assignments.push({
          date,
          shift,
          employee: employee.name,
          department: employee.department,
        });
        assignedToday.add(employee.name);
      }
    }
  }

  assignments.sort(
    (left, right) =>
      left.date.localeCompare(right.date) || left.shift.localeCompare(right.shift),
  );

  return {
    schedule: {
      days,
      shifts: [...WORKING_SHIFTS],
      assignments,
    },
    warnings,
  };
}

/** AM / PM if this person is on the roster that date, otherwise OFF. */
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

function shiftsByScarcity(
  date: string,
  employees: readonly EmployeeAvailability[],
): WorkingShift[] {
  return [...WORKING_SHIFTS].sort((left, right) => {
    const leftCount = employees.filter((employee) =>
      canWork(employee, date, left),
    ).length;
    const rightCount = employees.filter((employee) =>
      canWork(employee, date, right),
    ).length;
    if (leftCount !== rightCount) {
      return leftCount - rightCount;
    }
    return left === "AM" ? -1 : 1;
  });
}
