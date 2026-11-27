import { NextRequest, NextResponse } from "next/server";
import {
  computeEmployeeStats,
  DEFAULT_STORE_ID,
  getStoreConfig,
  type ConfigRow,
} from "@/lib/db/config";
import { listRosters, saveDraftRoster, updateRosterById } from "@/lib/db/rosters";
import { getIsoWeekLabel, isValidWeekStart } from "@/lib/roster/intake";
import {
  buildWeekSchedule,
  summarizeSchedule,
  type SchedulePipelineResult,
} from "@/lib/roster/schedule";
import { buildHoursLedger, isAlSettlementDate, settleAnnualLeave } from "@/lib/roster/ledger";
import type { LedgerLeaveEntry } from "@/lib/roster/ledger";
import { resolveCategory } from "@/lib/roster/rules";
import type {
  Employee,
  EmployeeMonthlyHours,
  HoursByEmployment,
  ParsedAvailability,
  PeriodHeadcount,
  ReserveStaff,
  RosterRules,
  RosterWarning,
  Schedule,
  ShiftTimeSlot,
} from "@/lib/types";
import { EMPLOYMENT_BY_STAFF_CATEGORY, EMPLOYMENT_TYPES } from "@/lib/types";

// ── ConfigRow 讀取小工具（不確定型別一律先檢核，不虛構欄位） ──

function asText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asTextArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asNumberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : [];
}

function asEmploymentType(value: unknown): Employee["employment_type"] {
  const text = asText(value, "PT");
  return (EMPLOYMENT_TYPES as readonly string[]).includes(text)
    ? (text as Employee["employment_type"])
    : "PT";
}

function mapEmployee(row: ConfigRow, storeId: string): Employee {
  // role_title（M / A.M / S）優先，否則沿用舊 position；管理層檢核靠 position。
  const position = asText(row.role_title) || asText(row.position) || null;
  return {
    id: asText(row.id),
    store_id: asText(row.store_id, storeId),
    name: asText(row.name),
    nickname: typeof row.nickname === "string" ? row.nickname : null,
    position,
    employment_type: asEmploymentType(row.employment_type),
    fixed_shift_time: typeof row.fixed_shift_time === "string" ? row.fixed_shift_time : null,
    flexible_shift_options: asTextArray(row.flexible_shift_options),
    regular_days_off: asNumberArray(row.regular_days_off),
    annual_leave_total: asNumber(row.annual_leave_total),
    al_current_count: asNumber(row.al_current_count),
    sh_current_count: asNumber(row.sh_current_count),
    w_current_count: asNumber(row.w_current_count),
    ot_compensation_mode: row.ot_compensation_mode === "cash" ? "cash" : "time_off",
    department: typeof row.department === "string" ? row.department : null,
    phone: typeof row.phone === "string" ? row.phone : null,
    is_active: row.is_active !== false,
  };
}

function mapReserve(row: ConfigRow, storeId: string): ReserveStaff {
  return {
    id: asText(row.id),
    store_id: asText(row.store_id, storeId),
    name: asText(row.name),
    nickname: typeof row.nickname === "string" ? row.nickname : null,
    position: typeof row.position === "string" ? row.position : null,
    employment_type: asEmploymentType(row.employment_type),
    department: typeof row.department === "string" ? row.department : null,
    phone: typeof row.phone === "string" ? row.phone : null,
    priority: asNumber(row.priority, 100),
    is_active: row.is_active !== false,
  };
}

function mapRules(row: ConfigRow | undefined, storeId: string): RosterRules {
  const source = row ?? {};
  const rest = asObject(source.weekly_rest_rule);
  const settlement = asObject(source.al_settlement_rule);
  return {
    id: asText(source.id),
    store_id: asText(source.store_id, storeId),
    department: typeof source.department === "string" ? source.department : null,
    period_headcount: asObject(source.period_headcount) as unknown as PeriodHeadcount,
    max_daily_hours: asObject(source.max_daily_hours) as HoursByEmployment,
    max_weekly_hours: asObject(source.max_weekly_hours) as HoursByEmployment,
    statutory_holidays_yearly: asNumber(source.statutory_holidays_yearly, 15),
    weekly_rest_rule: {
      workDays: asNumber(rest.workDays, 6),
      restDays: asNumber(rest.restDays, 1),
      cycleDays: asNumber(rest.cycleDays, 7),
    },
    al_settlement_rule: {
      settleMonth: asNumber(settlement.settleMonth, 12),
      settleDay: asNumber(settlement.settleDay, 31),
      convertRemainingToSalary: settlement.convertRemainingToSalary === true,
      resetCurrentCount: settlement.resetCurrentCount !== false,
    },
    // v2 為物件（servicePeriods + byEmployment），rules.ts 內部自行 adapter。
    shift_time_slots: (source.shift_time_slots ?? []) as unknown as ShiftTimeSlot[],
  };
}

function parseAvailability(raw: unknown): ParsedAvailability | null {
  const body = asObject(raw);
  return Array.isArray(body.employees) ? (body as unknown as ParsedAvailability) : null;
}

/** DB 未設定員工時，用報更紀錄臨時組裝（不寫 DB）。 */
function fallbackEmployees(parsed: ParsedAvailability | null): Employee[] {
  return (parsed?.employees ?? []).map((avail, index) => ({
    id: `parsed-${index}`,
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
    ot_compensation_mode: "time_off",
    department: avail.department ?? null,
    phone: null,
    is_active: true,
  }));
}

function resolveStoreId(raw: unknown): string {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : DEFAULT_STORE_ID;
}

/** 手改時間後重算：只按時間段重計工時／OT／補鐘，不動排更內容。 */
function recomputeSchedule(input: {
  schedule: Schedule;
  employees: readonly Employee[];
  rules: RosterRules;
  warnings: RosterWarning[];
}): Schedule {
  const assignments = Array.isArray(input.schedule.assignments) ? input.schedule.assignments : [];
  const leaveEntries: LedgerLeaveEntry[] = assignments.flatMap((item) =>
    item.halfDayLeave ? [{ ...item.halfDayLeave, employee: item.employee }] : [],
  );

  const ledger = buildHoursLedger({
    assignments,
    employees: input.employees,
    rules: input.rules,
    leaveEntries,
  });
  const { dailyHours, employeeHours } = summarizeSchedule(
    input.schedule.days ?? [],
    assignments,
    input.employees.map((emp) => emp.name),
  );
  const monthlyHours: EmployeeMonthlyHours[] = ledger.monthly.map((row) => ({
    yearMonth: row.yearMonth,
    employee: row.employee,
    totalHours: row.totalHours,
    daysWorked: row.daysWorked,
    timeBalanceHours: row.timeBalanceHours,
  }));

  const settlementDate = (input.schedule.days ?? []).find((date) => isAlSettlementDate(date, input.rules));
  const alSettlement = settlementDate
    ? settleAnnualLeave({
        employees: input.employees,
        rules: input.rules,
        year: Number(settlementDate.slice(0, 4)),
      }).summaries
    : input.schedule.alSettlement;

  const anchor = settlementDate ?? input.schedule.days?.[0] ?? "";
  for (const message of ledger.warnings) {
    input.warnings.push({ date: anchor, shift: "AM", message });
  }

  return {
    ...input.schedule,
    assignments,
    dailyHours,
    employeeHours,
    monthlyHours,
    compTimeHours: ledger.compTime,
    payableOtHours: ledger.payableOt,
    alSettlement,
  };
}

export async function GET(req: NextRequest) {
  const weekStart = req.nextUrl.searchParams.get("weekStart")?.trim() || undefined;

  try {
    const rosters = await listRosters(weekStart);
    return NextResponse.json({ rosters }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "讀取更表列表失敗。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "請求主體必須為合法 JSON。" }, { status: 400 });
  }

  const weekStart = asText(body.weekStart).trim();
  if (!isValidWeekStart(weekStart)) {
    return NextResponse.json(
      { error: "weekStart 必須為有效的 YYYY-MM-DD 格式且為星期日或星期一。" },
      { status: 400 },
    );
  }

  const storeId = resolveStoreId(body.storeId);
  const department = asText(body.department).trim();
  const warnings: RosterWarning[] = [];

  try {
    const config = await getStoreConfig(storeId);
    const dbEmployees = config.employees.map((row) => mapEmployee(row, storeId));

    let parsed = parseAvailability(body.parsed);
    if (!parsed) {
      const existing = await listRosters(weekStart);
      parsed = existing[0]?.parsed ?? null;
    }
    if (!parsed || parsed.employees.length === 0) {
      return NextResponse.json(
        { error: "必須提供 parsed（員工報更紀錄），或該週已有更表草稿可沿用。" },
        { status: 400 },
      );
    }

    const employees = dbEmployees.length > 0 ? dbEmployees : fallbackEmployees(parsed);
    const reserveStaff = config.reserve_staff.map((row) => mapReserve(row, storeId));
    // roster_rules 每店／部門一條；store config 以 created_at.asc 排序，取最新一筆。
    const rules = mapRules(config.roster_rules[config.roster_rules.length - 1], storeId);
    const stats = computeEmployeeStats(config.employees);

    if (body.action === "recalculate") {
      const inputSchedule = asObject(body.schedule) as unknown as Schedule;
      if (!Array.isArray(inputSchedule.assignments)) {
        return NextResponse.json({ error: "必須提供含 assignments 的 schedule。" }, { status: 400 });
      }
      const schedule = recomputeSchedule({ schedule: inputSchedule, employees, rules, warnings });
      const rosterId = asText(body.id);
      if (rosterId) {
        const updated = await updateRosterById(rosterId, { parsed, schedule, warnings });
        return NextResponse.json({ roster: updated, schedule, warnings, stats }, { status: 200 });
      }
      return NextResponse.json({ schedule, warnings, stats, persisted: false }, { status: 200 });
    }

    const result = buildWeekSchedule({
      weekStart,
      employees: parsed.employees,
      rules,
      staff: employees,
      reserveStaff,
    }) as SchedulePipelineResult;

    const schedule = result.schedule;
    const year = Number(weekStart.slice(0, 4));
    const alSettlement =
      schedule.alSettlement ?? settleAnnualLeave({ employees, rules, year }).summaries;
    const allWarnings: RosterWarning[] = [...result.warnings, ...warnings];

    // 預設只回傳預覽；persist=true 才寫入 week_rosters。
    let persisted = false;
    if (body.persist === true) {
      const saved = await saveDraftRoster({
        weekStart,
        isoWeek: getIsoWeekLabel(weekStart),
        department: department || null,
        source: "mock",
        mode: "live",
        parsed,
        schedule,
        warnings: allWarnings,
      });
      persisted = saved.persisted;
      if (saved.error) {
        allWarnings.push({ date: weekStart, shift: "AM", message: saved.error });
      }
    }

    return NextResponse.json(
      {
        mode: "db",
        preview: body.persist !== true,
        persisted,
        schedule,
        stats,
        ledger: result.ledger ?? null,
        weeklyHours: result.ledger?.weekly ?? [],
        shortages: result.shortages ?? [],
        leaveEntries: result.leaveEntries ?? [],
        alSettlement,
        templates: config.roster_templates,
        warnings: allWarnings,
      },
      { status: 200 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "自動排更失敗。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
