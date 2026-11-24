import { NextRequest, NextResponse } from "next/server";
import type { ImageIntake, ParsedAvailability } from "@/lib/types";
import { cloneSampleWeekParsed, SAMPLE_WEEK_START } from "@/lib/mock/sample-week";
import {
  estimatedBase64Bytes,
  intakeErrorPayload,
  isValidWeekStart,
  MAX_IMAGE_BYTES,
  normalizeImageBase64,
  parseImageAndSave,
  parseTextAndSave,
  saveParsedDraft,
  SUPPORTED_IMAGE_MIMES,
} from "@/lib/roster/intake";

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

  try {
    if (kind === "db" || kind === "mock") {
      const parsed: ParsedAvailability = cloneSampleWeekParsed(department);
      const result = await saveParsedDraft({
        weekStart: rawWeekStart,
        department,
        parsed,
        mode: "mock",
        source: "mock",
      });
      return NextResponse.json(
        {
          roster: result.roster,
          mode: result.mode,
          persisted: result.persisted,
          warnings: result.warnings,
        },
        { status: 200 },
      );
    }

    if (kind === "text") {
      if (typeof body.text !== "string" || body.text.trim().length === 0) {
        return NextResponse.json(
          { error: "kind 為 'text' 時必須提供非空 text。" },
          { status: 400 },
        );
      }
      const channel =
        body.channel === "wechat" ? "WeChat" : body.channel === "whatsapp" ? "WhatsApp" : "文字";
      const result = await parseTextAndSave({
        text: body.text.trim(),
        weekStart: rawWeekStart,
        department,
        source: "text",
        extraWarnings: [`來源：${channel} 貼上`],
      });
      return NextResponse.json(
        {
          roster: result.roster,
          mode: result.mode,
          persisted: result.persisted,
          warnings: result.warnings,
        },
        { status: 200 },
      );
    }

    const rawMime = typeof body.mimeType === "string" ? body.mimeType.trim().toLowerCase() : "";
    const imageBase64 =
      typeof body.imageBase64 === "string" ? normalizeImageBase64(body.imageBase64.trim()) : "";

    if (!imageBase64 || !SUPPORTED_IMAGE_MIMES.has(rawMime as ImageIntake["mimeType"])) {
      return NextResponse.json(
        { error: "圖片格式不支援或缺少圖片資料（僅支援 image/jpeg、image/png、image/webp）。" },
        { status: 400 },
      );
    }

    if (estimatedBase64Bytes(imageBase64) > MAX_IMAGE_BYTES) {
      return NextResponse.json(
        { error: "圖片大小超過 4 MB 上限，請壓縮後再上傳。" },
        { status: 413 },
      );
    }

    const result = await parseImageAndSave({
      imageBase64,
      mimeType: rawMime as ImageIntake["mimeType"],
      weekStart: rawWeekStart,
      department,
    });
    return NextResponse.json(
      {
        roster: result.roster,
        mode: result.mode,
        persisted: result.persisted,
        warnings: result.warnings,
      },
      { status: 200 },
    );
  } catch (err) {
    const mapped = intakeErrorPayload(
      err,
      kind === "image"
        ? "月曆圖片辨識服務暫時無法使用，請稍後再試。"
        : "文字報更解析服務暫時無法使用，請稍後再試。",
    );
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }
}
