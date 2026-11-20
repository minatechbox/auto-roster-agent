import { NextRequest, NextResponse } from "next/server";
import type {
  ImageIntake,
  MockIntake,
  ParsedAvailability,
  RosterMode,
  RosterWarning,
  TextIntake,
  WeekRoster,
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

function isMondayDateString(dateStr: string): boolean {
  if (!DATE_REGEX.test(dateStr)) {
    return false;
  }
  const parsed = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dateStr) {
    return false;
  }
  return parsed.getUTCDay() === 1; // 1 = Monday
}

function getIsoWeekLabel(weekStart: string): string {
  const date = new Date(`${weekStart}T00:00:00Z`);
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "請求主體必須為合法 JSON。" }, { status: 400 });
  }

  const kind = body.kind;
  if (kind !== "text" && kind !== "image" && kind !== "mock") {
    return NextResponse.json(
      { error: "kind 必須為 'text'、'image' 或 'mock'。" },
      { status: 400 }
    );
  }

  const rawWeekStart =
    typeof body.weekStart === "string" && body.weekStart.trim().length > 0
      ? body.weekStart.trim()
      : kind === "mock"
      ? SAMPLE_WEEK_START
      : "2026-11-16";

  if (!isMondayDateString(rawWeekStart)) {
    return NextResponse.json(
      { error: "weekStart 必須為有效的 YYYY-MM-DD 格式且為星期一。" },
      { status: 400 }
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

  if (kind === "mock") {
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
        { status: 400 }
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
          { status: 422 }
        );
      }
      return NextResponse.json(
        { error: "文字報更解析服務暫時無法使用，請稍後再試。" },
        { status: 502 }
      );
    }
  } else {
    const rawMime = typeof body.mimeType === "string" ? body.mimeType.trim().toLowerCase() : "";
    const imageBase64 = typeof body.imageBase64 === "string" ? body.imageBase64.trim() : "";

    if (!imageBase64 || !SUPPORTED_IMAGE_MIMES.has(rawMime as ImageIntake["mimeType"])) {
      return NextResponse.json(
        { error: "圖片格式不支援或缺少圖片資料（僅支援 image/jpeg、image/png、image/webp）。" },
        { status: 400 }
      );
    }

    const base64Payload = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;
    const estimatedBytes = Math.floor((base64Payload.length * 3) / 4);
    if (estimatedBytes > MAX_IMAGE_BYTES) {
      return NextResponse.json(
        { error: "圖片大小超過 4 MB 上限，請壓縮後再上傳。" },
        { status: 413 }
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
          { status: 422 }
        );
      }
      return NextResponse.json(
        { error: "月曆圖片辨識服務暫時無法使用，請稍後再試。" },
        { status: 502 }
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

  const roster: WeekRoster = {
    id: null,
    weekStart: rawWeekStart,
    isoWeek: getIsoWeekLabel(rawWeekStart),
    status: "draft",
    department: department ?? parsedResult.parsed.employees[0]?.department ?? null,
    source: kind,
    mode: parsedResult.mode,
    parsed: parsedResult.parsed,
    schedule: scheduleResult.schedule,
    warnings: combinedWarnings,
    createdAt: null,
    approvedAt: null,
  };

  return NextResponse.json(
    {
      roster,
      mode: parsedResult.mode,
      persisted: false,
      warnings: combinedWarnings,
    },
    { status: 200 }
  );
}