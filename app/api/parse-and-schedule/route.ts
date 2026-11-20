import { saveDraftRoster } from "@/lib/db/rosters";
import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import type {
  EmployeeAvailability,
  ImageIntake,
  MockIntake,
  ParsedAvailability,
  RosterMode,
  RosterWarning,
  StaffCategory,
  TextIntake,
  WorkingShift,
} from "@/lib/types";
import { parseRosterFromText } from "@/lib/ai/parse-text";
import { parseRosterFromImage } from "@/lib/ai/parse-image";
import { sampleWeekParsed, SAMPLE_WEEK_START } from "@/lib/mock/sample-week";
import { buildWeekSchedule } from "@/lib/roster/schedule";

const SUPPORTED_IMAGE_MIMES = new Set<ImageIntake["mimeType"]>([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** 接受星期日 (0) 或星期一 (1) 作為每週起點，配合週日開週與舊測試。 */
function isValidWeekStart(dateStr: string): boolean {
  if (!DATE_REGEX.test(dateStr)) {
    return false;
  }
  const parsed = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dateStr) {
    return false;
  }
  const day = parsed.getUTCDay();
  return day === 0 || day === 1;
}

function getIsoWeekLabel(weekStart: string): string {
  const date = new Date(`${weekStart}T00:00:00Z`);
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

interface DbEmployeeRow {
  id: number;
  nickname: string | null;
  name: string;
  rank: string | null;
  employment_type: string | null;
  department: string | null;
  week_hours: number | string | null;
  work_days: number | null;
  schedule: Record<
    string,
    {
      type?: string;
      code?: string;
      slot?: string;
      slots?: string[];
      hours?: number;
    }
  > | null;
}

function mapCategoryFromDb(empType: string | null, weekHours: number): StaffCategory {
  const upper = (empType ?? "").trim().toUpperCase();
  if (upper.includes("P.T") || upper === "PT") {
    return "part_time";
  }
  if (weekHours > 0 && weekHours <= 35) {
    return "half_full_time";
  }
  return "full_time";
}

function slotToShifts(slot?: string, slots?: string[]): WorkingShift[] {
  const candidates: string[] = [];
  if (slot) candidates.push(slot);
  if (Array.isArray(slots)) candidates.push(...slots);

  const result = new Set<WorkingShift>();
  for (const s of candidates) {
    const startHour = Number(s.split(":")[0]);
    if (!Number.isNaN(startHour)) {
      if (startHour < 12) result.add("AM");
      if (startHour >= 11) result.add("PM");
    }
  }
  if (result.size === 0) {
    result.add("AM");
    result.add("PM");
  }
  return Array.from(result);
}

async function loadEmployeesFromSupabase(
  departmentFilter?: string,
): Promise<{ parsed: ParsedAvailability; warnings: string[] }> {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("缺少 Supabase 環境變數（NEXT_PUBLIC_SUPABASE_URL 或 Key）");
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  let query = supabase.from("employees").select("*").order("id", { ascending: true });

  if (departmentFilter && departmentFilter.trim().length > 0) {
    query = query.eq("department", departmentFilter.trim());
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`讀取 employees 資料表失敗：${error.message}`);
  }

  const rows = (Array.isArray(data) ? data : []) as DbEmployeeRow[];
  const warnings: string[] = [];

  const employees: EmployeeAvailability[] = rows.map((row) => {
    const hoursNum = Number(row.week_hours ?? 0);
    const category = mapCategoryFromDb(row.employment_type, hoursNum);
    const displayName = row.nickname ? `${row.name} (${row.nickname})` : row.name;
    const dept = row.department || departmentFilter || "粉嶺上初 - 樓面";

    const leave: string[] = [];
    const availableDates: string[] = [];
    const sched = row.schedule ?? {};

    for (const [dateStr, entry] of Object.entries(sched)) {
      if (!entry) continue;
      if (entry.type === "leave" || entry.type === "off") {
        leave.push(dateStr);
      } else if (entry.type === "shift" || entry.type === "split_shift") {
        if (category === "part_time") {
          availableDates.push(dateStr);
        }
      }
    }

    if (category === "full_time" && hoursNum > 60) {
      warnings.push(`${displayName} 本週工時 ${hoursNum} 小時超出 60 小時上限`);
    }

    return {
      name: displayName,
      department: dept,
      category,
      leave,
      availableDates: category === "part_time" ? availableDates : undefined,
      available: {},
    };
  });

  return {
    parsed: { employees },
    warnings,
  };
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "請求主體必須為合法 JSON。" }, { status: 400 });
  }

  const kind = body.kind;
  if (kind !== "text" && kind !== "image" && kind !== "mock" && kind !== "db") {
    return NextResponse.json(
      { error: "kind 必須為 'text'、'image'、'mock' 或 'db'。" },
      { status: 400 },
    );
  }

  const rawWeekStart =
    typeof body.weekStart === "string" && body.weekStart.trim().length > 0
      ? body.weekStart.trim()
      : kind === "mock"
      ? SAMPLE_WEEK_START
      : "2026-11-22";

  if (!isValidWeekStart(rawWeekStart)) {
    return NextResponse.json(
      { error: "weekStart 必須為有效的 YYYY-MM-DD 格式且為星期日或星期一。" },
      { status: 400 },
    );
  }

  const department =
    typeof body.department === "string" && body.department.trim().length > 0
      ? body.department.trim()
      : undefined;

  let parsedResult: {
    parsed: ParsedAvailability;
    mode: RosterMode;
    warnings: string[];
  };

  if (kind === "db") {
    try {
      const dbResult = await loadEmployeesFromSupabase(department);
      parsedResult = {
        parsed: dbResult.parsed,
        mode: "live",
        warnings: dbResult.warnings,
      };
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "讀取資料庫員工資料失敗。" },
        { status: 500 },
      );
    }
  } else if (kind === "mock") {
    const mockReq: MockIntake = {
      kind: "mock",
      weekStart: rawWeekStart,
      department,
    };
    const cloned: ParsedAvailability = JSON.parse(JSON.stringify(sampleWeekParsed));
    if (mockReq.department) {
      for (const emp of cloned.employees) {
        emp.department = mockReq.department;
      }
    }
    parsedResult = {
      parsed: cloned,
      mode: "mock",
      warnings: [],
    };
  } else if (kind === "text") {
    if (typeof body.text !== "string" || body.text.trim().length === 0) {
      return NextResponse.json(
        { error: "kind 為 'text' 時必須提供非空 text。" },
        { status: 400 },
      );
    }

    const textReq: TextIntake = {
      kind: "text",
      text: body.text.trim(),
      weekStart: rawWeekStart,
      department,
    };

    try {
      parsedResult = await parseRosterFromText({
        text: textReq.text,
        weekStart: rawWeekStart,
        department: textReq.department,
      });
    } catch (err) {
      const errorWithCode = err as Error & { code?: string };
      if (errorWithCode.code === "SCHEMA_VALIDATION_FAILED") {
        return NextResponse.json(
          { error: `AI 回傳資料不符合排班結構：${errorWithCode.message}` },
          { status: 422 },
        );
      }
      return NextResponse.json(
        { error: "文字報更解析服務暫時無法使用，請稍後再試。" },
        { status: 502 },
      );
    }
  } else {
    const rawMime = typeof body.mimeType === "string" ? body.mimeType.trim().toLowerCase() : "";
    const imageBase64 = typeof body.imageBase64 === "string" ? body.imageBase64.trim() : "";

    if (!imageBase64 || !SUPPORTED_IMAGE_MIMES.has(rawMime as ImageIntake["mimeType"])) {
      return NextResponse.json(
        { error: "圖片格式不支援或缺少圖片資料（僅支援 image/jpeg、image/png、image/webp）。" },
        { status: 400 },
      );
    }

    const base64Payload = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;
    const estimatedBytes = Math.floor((base64Payload.length * 3) / 4);
    if (estimatedBytes > MAX_IMAGE_BYTES) {
      return NextResponse.json(
        { error: "圖片大小超過 4 MB 上限，請壓縮後再上傳。" },
        { status: 413 },
      );
    }

    const imageReq: ImageIntake = {
      kind: "image",
      imageBase64: base64Payload,
      mimeType: rawMime as ImageIntake["mimeType"],
      weekStart: rawWeekStart,
      department,
    };

    try {
      parsedResult = await parseRosterFromImage({
        imageBase64: imageReq.imageBase64,
        mimeType: imageReq.mimeType,
        weekStart: rawWeekStart,
        department: imageReq.department,
      });
    } catch (err) {
      const errorWithCode = err as Error & { code?: string };
      if (errorWithCode.code === "SCHEMA_VALIDATION_FAILED") {
        return NextResponse.json(
          { error: `AI 圖片辨識結果不符合排班結構：${errorWithCode.message}` },
          { status: 422 },
        );
      }
      return NextResponse.json(
        { error: "月曆圖片辨識服務暫時無法使用，請稍後再試。" },
        { status: 502 },
      );
    }
  }

  const scheduleResult = buildWeekSchedule({
    weekStart: rawWeekStart,
    employees: parsedResult.parsed.employees,
  });

  const combinedWarnings: RosterWarning[] = [
    ...scheduleResult.warnings,
    ...parsedResult.warnings.map((msg) => ({
      date: rawWeekStart,
      shift: "AM" as const,
      message: msg,
    })),
  ];

  const saveResult = await saveDraftRoster({
    weekStart: rawWeekStart,
    isoWeek: getIsoWeekLabel(rawWeekStart),
    department: department ?? parsedResult.parsed.employees[0]?.department ?? null,
    source: kind === "db" ? "webhook" : kind,
    mode: parsedResult.mode,
    parsed: parsedResult.parsed,
    schedule: scheduleResult.schedule,
    warnings: combinedWarnings,
  });

  const finalWarnings: RosterWarning[] = [
    ...combinedWarnings,
    ...(saveResult.error
      ? [
          {
            date: rawWeekStart,
            shift: "AM" as const,
            message: saveResult.error,
          },
        ]
      : []),
  ];

  return NextResponse.json(
    {
      roster: {
        ...saveResult.roster,
        warnings: finalWarnings,
      },
      mode: parsedResult.mode,
      persisted: saveResult.persisted,
      warnings: finalWarnings,
    },
    { status: 200 },
  );
}
