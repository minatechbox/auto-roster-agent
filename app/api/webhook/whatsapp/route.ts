import { NextRequest, NextResponse } from "next/server";
import { getServerEnv } from "@/lib/env";
import {
  intakeErrorPayload,
  parseTextAndSave,
  resolveWeekStart,
} from "@/lib/roster/intake";
import { SAMPLE_DEPARTMENT } from "@/lib/mock/sample-week";
import {
  departmentFromWhatsAppPayload,
  extractWhatsAppTexts,
  verifyWhatsAppSignature,
  weekStartFromWhatsAppPayload,
} from "@/lib/webhook/whatsapp";
import { safeEqual } from "@/lib/webhook/crypto";

export async function GET(req: NextRequest) {
  const env = getServerEnv();
  const mode = req.nextUrl.searchParams.get("hub.mode");
  const token = req.nextUrl.searchParams.get("hub.verify_token");
  const challenge = req.nextUrl.searchParams.get("hub.challenge");

  if (mode !== "subscribe" || !challenge) {
    return NextResponse.json(
      { error: "WhatsApp Webhook 驗證需要 hub.mode=subscribe 與 hub.challenge。" },
      { status: 400 },
    );
  }

  if (env.whatsappVerifyToken && (!token || !safeEqual(env.whatsappVerifyToken, token))) {
    return NextResponse.json({ error: "verify_token 不正確。" }, { status: 403 });
  }

  return new NextResponse(challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function POST(req: NextRequest) {
  const env = getServerEnv();
  const rawBody = await req.text();

  let payload: unknown = {};
  if (rawBody.trim()) {
    try {
      payload = JSON.parse(rawBody) as unknown;
    } catch {
      return NextResponse.json({ error: "請求主體必須為合法 JSON。" }, { status: 400 });
    }
  }

  const signature = req.headers.get("x-hub-signature-256");
  const isMetaPayload =
    Boolean(payload) &&
    typeof payload === "object" &&
    (payload as { object?: string }).object === "whatsapp_business_account";
  if (
    (signature || isMetaPayload) &&
    !verifyWhatsAppSignature(rawBody, signature, env.webhookSecret)
  ) {
    return NextResponse.json({ error: "Webhook 簽名驗證失敗。" }, { status: 401 });
  }

  const extracted = extractWhatsAppTexts(payload);
  if (extracted.texts.length === 0) {
    return NextResponse.json(
      { ok: true, ignored: true, reason: "沒有文字訊息可解析。" },
      { status: 200 },
    );
  }

  let weekStart: string;
  try {
    weekStart = resolveWeekStart(
      req.nextUrl.searchParams.get("weekStart") ?? weekStartFromWhatsAppPayload(payload),
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "weekStart 無效。" },
      { status: 400 },
    );
  }

  const department =
    req.nextUrl.searchParams.get("department")?.trim() ||
    departmentFromWhatsAppPayload(payload)?.trim() ||
    SAMPLE_DEPARTMENT;

  try {
    const result = await parseTextAndSave({
      text: extracted.texts.join("\n"),
      weekStart,
      department,
      source: "webhook",
      extraWarnings: [
        `來源：WhatsApp Webhook${extracted.from ? `（from ${extracted.from}）` : ""}`,
      ],
    });
    return NextResponse.json(
      {
        ok: true,
        channel: "whatsapp",
        roster: result.roster,
        persisted: result.persisted,
        mode: result.mode,
        warnings: result.warnings,
      },
      { status: 200 },
    );
  } catch (err) {
    const mapped = intakeErrorPayload(err, "WhatsApp 文字解析服務暫時無法使用，請稍後再試。");
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }
}
