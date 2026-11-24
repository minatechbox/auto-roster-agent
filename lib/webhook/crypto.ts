import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function sha1Hex(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function wechatOfficialSignature(
  token: string,
  timestamp: string,
  nonce: string,
): string {
  return sha1Hex([token, timestamp, nonce].sort().join(""));
}

export function wechatMsgSignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypted: string,
): string {
  return sha1Hex([token, timestamp, nonce, encrypted].sort().join(""));
}
