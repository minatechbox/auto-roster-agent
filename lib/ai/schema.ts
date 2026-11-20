import type {
  EmployeeAvailability,
  ParsedAvailability,
  WeekdayKey,
  WorkingShift,
} from "@/lib/types";
import { WEEKDAY_KEYS, WORKING_SHIFTS } from "@/lib/types";

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_DEPARTMENT = "旺角門市";

function isValidIsoDateString(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_REGEX.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isWorkingShift(value: unknown): value is WorkingShift {
  return (
    typeof value === "string" &&
    (WORKING_SHIFTS as readonly string[]).includes(value)
  );
}

export function parseAndValidateRosterJson(
  rawText: string,
  fallbackDepartment?: string
): { ok: true; data: ParsedAvailability } | { ok: false; reason: string } {
  let candidate: unknown;

  try {
    const cleaned = rawText
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    candidate = JSON.parse(cleaned);
  } catch {
    return { ok: false, reason: "模型回傳內容不是合法的 JSON 格式。" };
  }

  if (!candidate || typeof candidate !== "object") {
    return { ok: false, reason: "模型回傳 JSON 頂層必須為物件。" };
  }

  const root = candidate as Record<string, unknown>;
  if (!Array.isArray(root.employees) || root.employees.length === 0) {
    return { ok: false, reason: "模型回傳必須包含非空的 employees 陣列。" };
  }

  const resolvedDept =
    typeof fallbackDepartment === "string" && fallbackDepartment.trim().length > 0
      ? fallbackDepartment.trim()
      : DEFAULT_DEPARTMENT;

  const employees: EmployeeAvailability[] = [];

  for (let i = 0; i < root.employees.length; i += 1) {
    const item = root.employees[i];
    if (!item || typeof item !== "object") {
      return { ok: false, reason: `第 ${i + 1} 位員工資料格式不正確。` };
    }

    const emp = item as Record<string, unknown>;
    if (typeof emp.name !== "string" || emp.name.trim().length === 0) {
      return { ok: false, reason: `第 ${i + 1} 位員工缺少有效的 name。` };
    }

    let leaveList: string[] = [];
    if (emp.leave !== undefined) {
      if (!Array.isArray(emp.leave) || !emp.leave.every((d) => isValidIsoDateString(d))) {
        return {
          ok: false,
          reason: `員工 ${emp.name.trim()} 的 leave 必須為 YYYY-MM-DD 日期陣列。`,
        };
      }
      leaveList = Array.from(new Set(emp.leave));
    }

    const availableMap: Partial<Record<WeekdayKey, WorkingShift[]>> = {};
    if (emp.available !== undefined) {
      if (!emp.available || typeof emp.available !== "object" || Array.isArray(emp.available)) {
        return {
          ok: false,
          reason: `員工 ${emp.name.trim()} 的 available 必須為物件。`,
        };
      }

      const availObj = emp.available as Record<string, unknown>;
      for (const key of Object.keys(availObj)) {
        if (!(WEEKDAY_KEYS as readonly string[]).includes(key)) {
          return {
            ok: false,
            reason: `員工 ${emp.name.trim()} 包含無效星期鍵 ${key}。`,
          };
        }
        const shiftsVal = availObj[key];
        if (!Array.isArray(shiftsVal) || !shiftsVal.every((s) => isWorkingShift(s))) {
          return {
            ok: false,
            reason: `員工 ${emp.name.trim()} 在 ${key} 的可用更別只可為 AM 或 PM。`,
          };
        }
        availableMap[key as WeekdayKey] = Array.from(new Set(shiftsVal));
      }
    }

    const dept =
      typeof emp.department === "string" && emp.department.trim().length > 0
        ? emp.department.trim()
        : resolvedDept;

    employees.push({
      name: emp.name.trim(),
      department: dept,
      leave: leaveList,
      available: availableMap,
    });
  }

  return { ok: true, data: { employees } };
}