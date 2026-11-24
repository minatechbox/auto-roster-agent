import { createDecipheriv } from "node:crypto";
import { safeEqual, wechatMsgSignature, wechatOfficialSignature } from "./crypto";

export interface WeChatParsedMessage {
  msgType?: string;
  content?: string;
  fromUser?: string;
  encrypt?: string;
}

function xmlTag(xml: string, tag: string): string | undefined {
  const cdata = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, "i").exec(xml);
  if (cdata?.[1] !== undefined) {
    return cdata[1];
  }
  const plain = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  return plain?.[1]?.trim();
}

export function parseWeChatXml(xml: string): WeChatParsedMessage {
  return {
    msgType: xmlTag(xml, "MsgType"),
    content: xmlTag(xml, "Content"),
    fromUser: xmlTag(xml, "FromUserName"),
    encrypt: xmlTag(xml, "Encrypt"),
  };
}

export function parseWeChatJson(payload: unknown): WeChatParsedMessage {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  const body = payload as Record<string, unknown>;
  const text =
    (typeof body.text === "string" && body.text) ||
    (typeof body.Content === "string" && body.Content) ||
    (typeof body.content === "string" && body.content) ||
    (typeof body.message === "string" && body.message) ||
    "";
  return {
    msgType: typeof body.MsgType === "string" ? body.MsgType : typeof body.msgType === "string" ? body.msgType : "text",
    content: text.trim() || undefined,
    fromUser:
      typeof body.FromUserName === "string"
        ? body.FromUserName
        : typeof body.fromUser === "string"
          ? body.fromUser
          : undefined,
    encrypt: typeof body.Encrypt === "string" ? body.Encrypt : undefined,
  };
}

export function verifyWeChatUrl(
  token: string | undefined,
  signature: string | undefined,
  timestamp: string | undefined,
  nonce: string | undefined,
): boolean {
  if (!signature || !timestamp || !nonce) {
    return false;
  }
  if (!token) {
    return true;
  }
  return safeEqual(wechatOfficialSignature(token, timestamp, nonce), signature);
}

export function verifyWeChatMsgSignature(
  token: string | undefined,
  msgSignature: string | undefined,
  timestamp: string | undefined,
  nonce: string | undefined,
  encrypted: string,
): boolean {
  if (!msgSignature || !timestamp || !nonce) {
    return false;
  }
  if (!token) {
    return true;
  }
  return safeEqual(wechatMsgSignature(token, timestamp, nonce, encrypted), msgSignature);
}

export function decryptWeChatPayload(
  encodingAesKey: string,
  encrypted: string,
): string | null {
  try {
    const key = Buffer.from(`${encodingAesKey}=`, "base64");
    if (key.length !== 32) {
      return null;
    }
    const iv = key.subarray(0, 16);
    const decipher = createDecipheriv("aes-256-cbc", key, iv);
    const buf = Buffer.concat([
      decipher.update(encrypted, "base64"),
      decipher.final(),
    ]);
    if (buf.length < 20) {
      return null;
    }
    const msgLen = buf.readUInt32BE(16);
    return buf.subarray(20, 20 + msgLen).toString("utf8");
  } catch {
    return null;
  }
}

export function weekStartFromWeChatPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const body = payload as Record<string, unknown>;
  return typeof body.weekStart === "string" ? body.weekStart : undefined;
}

export function departmentFromWeChatPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const body = payload as Record<string, unknown>;
  return typeof body.department === "string" ? body.department : undefined;
}
