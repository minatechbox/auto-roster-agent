import { NextRequest, NextResponse } from "next/server";
import type { ImageIntake } from "@/lib/types";
import {
  estimatedBase64Bytes,
  intakeErrorPayload,
  MAX_IMAGE_BYTES,
  normalizeImageBase64,
  parseImageAndSave,
  resolveWeekStart,
  SUPPORTED_IMAGE_MIMES,
} from "@/lib/roster/intake";

function mimeFromName(name: string): ImageIntake["mimeType"] | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return null;
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = Buffer.from(await file.arrayBuffer());
  return buffer.toString("base64");
}

export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";

  let imageBase64 = "";
  let mimeType: ImageIntake["mimeType"] | null = null;
  let weekStartRaw: string | undefined;
  let department: string | undefined;

  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const fileValue = form.get("image") ?? form.get("file");
      weekStartRaw =
        typeof form.get("weekStart") === "string" ? String(form.get("weekStart")) : undefined;
      const deptValue = form.get("department");
      department = typeof deptValue === "string" && deptValue.trim() ? deptValue.trim() : undefined;

      if (!(fileValue instanceof File) || fileValue.size === 0) {
        return NextResponse.json(
          { error: "請上傳日曆／更期相片（欄位名稱 image 或 file）。" },
          { status: 400 },
        );
      }
      if (fileValue.size > MAX_IMAGE_BYTES) {
        return NextResponse.json(
          { error: "圖片大小超過 4 MB 上限，請壓縮後再上傳。" },
          { status: 413 },
        );
      }
      const rawMime = fileValue.type.trim().toLowerCase();
      mimeType = SUPPORTED_IMAGE_MIMES.has(rawMime as ImageIntake["mimeType"])
        ? (rawMime as ImageIntake["mimeType"])
        : mimeFromName(fileValue.name);
      imageBase64 = await fileToBase64(fileValue);
    } else {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return NextResponse.json({ error: "請求主體必須為合法 JSON。" }, { status: 400 });
      }
      weekStartRaw = typeof body.weekStart === "string" ? body.weekStart : undefined;
      department =
        typeof body.department === "string" && body.department.trim()
          ? body.department.trim()
          : undefined;
      const rawMime =
        typeof body.mimeType === "string" ? body.mimeType.trim().toLowerCase() : "";
      mimeType = SUPPORTED_IMAGE_MIMES.has(rawMime as ImageIntake["mimeType"])
        ? (rawMime as ImageIntake["mimeType"])
        : null;
      imageBase64 =
        typeof body.imageBase64 === "string" ? normalizeImageBase64(body.imageBase64.trim()) : "";
    }
  } catch {
    return NextResponse.json({ error: "無法讀取上傳圖片。" }, { status: 400 });
  }

  if (!imageBase64 || !mimeType) {
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

  let weekStart: string;
  try {
    weekStart = resolveWeekStart(weekStartRaw);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "weekStart 無效。" },
      { status: 400 },
    );
  }

  try {
    const result = await parseImageAndSave({
      imageBase64,
      mimeType,
      weekStart,
      department,
    });
    return NextResponse.json(
      {
        roster: result.roster,
        persisted: result.persisted,
        mode: result.mode,
        warnings: result.warnings,
      },
      { status: 200 },
    );
  } catch (err) {
    const mapped = intakeErrorPayload(err, "月曆圖片辨識服務暫時無法使用，請稍後再試。");
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }
}
