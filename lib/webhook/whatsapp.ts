import { hmacSha256Hex, safeEqual } from "./crypto";

export interface WhatsAppExtractResult {
  texts: string[];
  from?: string;
}

interface WhatsAppMessage {
  from?: string;
  type?: string;
  text?: { body?: string };
  image?: { caption?: string };
}

interface WhatsAppChangeValue {
  messages?: WhatsAppMessage[];
}

interface WhatsAppEntry {
  changes?: Array<{ value?: WhatsAppChangeValue }>;
}

interface WhatsAppWebhookBody {
  object?: string;
  entry?: WhatsAppEntry[];
  text?: string;
  body?: string;
  message?: string;
  weekStart?: string;
  department?: string;
}

export function verifyWhatsAppSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret?: string,
): boolean {
  if (!appSecret) {
    return true;
  }
  if (!signatureHeader) {
    return false;
  }
  const expected = `sha256=${hmacSha256Hex(appSecret, rawBody)}`;
  return safeEqual(expected, signatureHeader);
}

export function extractWhatsAppTexts(payload: unknown): WhatsAppExtractResult {
  if (!payload || typeof payload !== "object") {
    return { texts: [] };
  }
  const body = payload as WhatsAppWebhookBody;

  if (typeof body.text === "string" && body.text.trim()) {
    return { texts: [body.text.trim()] };
  }
  if (typeof body.body === "string" && body.body.trim()) {
    return { texts: [body.body.trim()] };
  }
  if (typeof body.message === "string" && body.message.trim()) {
    return { texts: [body.message.trim()] };
  }

  const texts: string[] = [];
  let from: string | undefined;
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) {
        if (message.from && !from) {
          from = message.from;
        }
        if (message.type === "text" && message.text?.body?.trim()) {
          texts.push(message.text.body.trim());
        } else if (message.image?.caption?.trim()) {
          texts.push(message.image.caption.trim());
        }
      }
    }
  }
  return { texts, from };
}

export function weekStartFromWhatsAppPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const body = payload as WhatsAppWebhookBody;
  return typeof body.weekStart === "string" ? body.weekStart : undefined;
}

export function departmentFromWhatsAppPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const body = payload as WhatsAppWebhookBody;
  return typeof body.department === "string" ? body.department : undefined;
}
