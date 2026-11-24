import { saveDraftRoster } from "@/lib/db/rosters";
import { parseRosterFromImage } from "@/lib/ai/parse-image";
import { parseRosterFromText } from "@/lib/ai/parse-text";
import { SAMPLE_WEEK_START } from "@/lib/mock/sample-week";
import { buildWeekSchedule } from "@/lib/roster/schedule";
import type {
  ImageIntake,
  ParsedAvailability,
  RosterMode,
  RosterSource,
  RosterWarning,
  WeekRoster,
} from "@/lib/types";

export const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const SUPPORTED_IMAGE_MIMES = new Set<ImageIntake["mimeType"]>([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export interface IntakeSaveResult {
  roster: WeekRoster;
  persisted: boolean;
  mode: RosterMode;
  warnings: RosterWarning[];
}

export function isValidWeekStart(dateStr: string): boolean {
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

export function getIsoWeekLabel(weekStart: string): string {
  const date = new Date(`${weekStart}T00:00:00Z`);
  if (date.getUTCDay() === 0) {
    date.setUTCDate(date.getUTCDate() + 4);
  } else {
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  }
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

export function resolveWeekStart(raw?: string | null): string {
  const value = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : SAMPLE_WEEK_START;
  if (!isValidWeekStart(value)) {
    throw new Error("weekStart 必須為有效的 YYYY-MM-DD 格式且為星期日或星期一。");
  }
  return value;
}

export function intakeErrorPayload(err: unknown, fallback: string): {
  error: string;
  status: number;
} {
  const errorWithCode = err as Error & { code?: string };
  if (errorWithCode.code === "SCHEMA_VALIDATION_FAILED") {
    return {
      error: `AI 回傳資料不符合排班結構：${errorWithCode.message}`,
      status: 422,
    };
  }
  if (err instanceof Error && err.message.includes("weekStart")) {
    return { error: err.message, status: 400 };
  }
  return { error: fallback, status: 502 };
}

export async function saveParsedDraft(options: {
  weekStart: string;
  department?: string;
  parsed: ParsedAvailability;
  mode: RosterMode;
  source: RosterSource;
  parseWarnings?: string[];
}): Promise<IntakeSaveResult> {
  const scheduleResult = buildWeekSchedule({
    weekStart: options.weekStart,
    employees: options.parsed.employees,
  });

  const combinedWarnings: RosterWarning[] = [
    ...scheduleResult.warnings,
    ...(options.parseWarnings ?? []).map((msg) => ({
      date: options.weekStart,
      shift: "AM" as const,
      message: msg,
    })),
  ];

  const saveResult = await saveDraftRoster({
    weekStart: options.weekStart,
    isoWeek: getIsoWeekLabel(options.weekStart),
    department: options.department ?? options.parsed.employees[0]?.department ?? null,
    source: options.source,
    mode: options.mode,
    parsed: options.parsed,
    schedule: scheduleResult.schedule,
    warnings: combinedWarnings,
  });

  const warnings: RosterWarning[] = [
    ...combinedWarnings,
    ...(saveResult.error
      ? [
          {
            date: options.weekStart,
            shift: "AM" as const,
            message: saveResult.error,
          },
        ]
      : []),
  ];

  return {
    roster: {
      ...saveResult.roster,
      warnings,
    },
    persisted: saveResult.persisted,
    mode: options.mode,
    warnings,
  };
}

export async function parseTextAndSave(options: {
  text: string;
  weekStart: string;
  department?: string;
  source?: RosterSource;
  extraWarnings?: string[];
}): Promise<IntakeSaveResult> {
  const parsedResult = await parseRosterFromText({
    text: options.text,
    weekStart: options.weekStart,
    department: options.department,
  });
  return saveParsedDraft({
    weekStart: options.weekStart,
    department: options.department,
    parsed: parsedResult.parsed,
    mode: parsedResult.mode,
    source: options.source ?? "text",
    parseWarnings: [...parsedResult.warnings, ...(options.extraWarnings ?? [])],
  });
}

export async function parseImageAndSave(options: {
  imageBase64: string;
  mimeType: ImageIntake["mimeType"];
  weekStart: string;
  department?: string;
}): Promise<IntakeSaveResult> {
  const parsedResult = await parseRosterFromImage({
    imageBase64: options.imageBase64,
    mimeType: options.mimeType,
    weekStart: options.weekStart,
    department: options.department,
  });
  return saveParsedDraft({
    weekStart: options.weekStart,
    department: options.department,
    parsed: parsedResult.parsed,
    mode: parsedResult.mode,
    source: "image",
    parseWarnings: parsedResult.warnings,
  });
}

export function normalizeImageBase64(raw: string): string {
  return raw.includes(",") ? (raw.split(",")[1] ?? raw) : raw;
}

export function estimatedBase64Bytes(base64: string): number {
  return Math.floor((base64.length * 3) / 4);
}
