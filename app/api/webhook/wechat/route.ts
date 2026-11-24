import { NextRequest, NextResponse } from "next/server";
import { getServerEnv } from "@/lib/env";
import { SAMPLE_DEPARTMENT } from "@/lib/mock/sample-week";
import {
  intakeErrorPayload,
  parseTextAndSave,
  resolveWeekStart,
} from "@/lib/roster/intake";
import {
  decryptWeChatPayload,
  departmentFromWeChatPayload,
  parseWeChatJson,
  parseWeChatXml,
  verifyWeChatMsgSignature,
  verifyWeChatUrl,
  weekStartFromWeChatPayload,
} from "@/lib/webhook/wechat";

function wechatSuccessXml(): NextResponse {
  return new NextResponse("success", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function GET(req: NextRequest) {
  const env = getServerEnv();
  const signature = req.nextUrl.searchParams.get("signature") ?? undefined;
  const timestamp = req.nextUrl.searchParams.get("timestamp") ?? undefined;
  const nonce = req.nextUrl.searchParams.get("nonce") ?? undefined;
  const echostr = req.nextUrl.searchParams.get("echostr") ?? undefined;
  const msgSignature = req.nextUrl.searchParams.get("msg_signature") ?? undefined;

  if (!echostr) {
    return NextResponse.json(
      { error: "WeChat URL 驗證需要 echostr。" },
      { status: 400 },
    );
  }

  if (msgSignature) {
    if (
      !verifyWeChatMsgSignature(
        env.wechatToken,
        msgSignature,
        timestamp,
        nonce,
        echostr,
      )
    ) {
      return NextResponse.json({ error: "msg_signature 驗證失敗。" }, { status: 403 });
    }
    if (env.wechatEncodingAesKey) {
      const decrypted = decryptWeChatPayload(env.wechatEncodingAesKey, echostr);
      if (!decrypted) {
        return NextResponse.json({ error: "無法解密 echostr。" }, { status: 400 });
      }
      return new NextResponse(decrypted, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return new NextResponse(echostr, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (!verifyWeChatUrl(env.wechatToken, signature, timestamp, nonce)) {
    return NextResponse.json({ error: "signature 驗證失敗。" }, { status: 403 });
  }

  return new NextResponse(echostr, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function POST(req: NextRequest) {
  const env = getServerEnv();
  const rawBody = await req.text();
  const contentType = req.headers.get("content-type") ?? "";
  const wantsJson = contentType.includes("application/json");

  let parsed = contentType.includes("xml") || rawBody.trim().startsWith("<")
    ? parseWeChatXml(rawBody)
    : (() => {
        try {
          return parseWeChatJson(JSON.parse(rawBody) as unknown);
        } catch {
          return parseWeChatXml(rawBody);
        }
      })();

  const jsonPayload = !rawBody.trim().startsWith("<")
    ? (() => {
        try {
          return JSON.parse(rawBody) as unknown;
        } catch {
          return undefined;
        }
      })()
    : undefined;

  if (parsed.encrypt) {
    const msgSignature =
      req.nextUrl.searchParams.get("msg_signature") ?? undefined;
    const timestamp = req.nextUrl.searchParams.get("timestamp") ?? undefined;
    const nonce = req.nextUrl.searchParams.get("nonce") ?? undefined;
    if (
      !verifyWeChatMsgSignature(
        env.wechatToken,
        msgSignature,
        timestamp,
        nonce,
        parsed.encrypt,
      )
    ) {
      return NextResponse.json({ error: "msg_signature 驗證失敗。" }, { status: 401 });
    }
    if (env.wechatEncodingAesKey) {
      const decrypted = decryptWeChatPayload(env.wechatEncodingAesKey, parsed.encrypt);
      if (!decrypted) {
        return NextResponse.json({ error: "無法解密 WeChat 訊息。" }, { status: 400 });
      }
      if (decrypted.trim().startsWith("<")) {
        parsed = parseWeChatXml(decrypted);
      } else {
        try {
          parsed = parseWeChatJson(JSON.parse(decrypted) as unknown);
        } catch {
          parsed = { content: decrypted.trim() };
        }
      }
    }
  }

  if (!parsed.content) {
    if (wantsJson) {
      return NextResponse.json(
        { ok: true, ignored: true, reason: "沒有文字訊息可解析。" },
        { status: 200 },
      );
    }
    return wechatSuccessXml();
  }

  let weekStart: string;
  try {
    weekStart = resolveWeekStart(
      req.nextUrl.searchParams.get("weekStart") ??
        weekStartFromWeChatPayload(jsonPayload),
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "weekStart 無效。" },
      { status: 400 },
    );
  }

  const department =
    req.nextUrl.searchParams.get("department")?.trim() ||
    departmentFromWeChatPayload(jsonPayload)?.trim() ||
    SAMPLE_DEPARTMENT;

  try {
    const result = await parseTextAndSave({
      text: parsed.content,
      weekStart,
      department,
      source: "webhook",
      extraWarnings: [
        `來源：WeChat Webhook${parsed.fromUser ? `（${parsed.fromUser}）` : ""}`,
      ],
    });
    if (wantsJson) {
      return NextResponse.json(
        {
          ok: true,
          channel: "wechat",
          roster: result.roster,
          persisted: result.persisted,
          mode: result.mode,
          warnings: result.warnings,
        },
        { status: 200 },
      );
    }
    return wechatSuccessXml();
  } catch (err) {
    const mapped = intakeErrorPayload(err, "WeChat 文字解析服務暫時無法使用，請稍後再試。");
    if (wantsJson) {
      return NextResponse.json({ error: mapped.error }, { status: mapped.status });
    }
    return wechatSuccessXml();
  }
}
