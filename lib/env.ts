export interface ServerEnv {
  aiApiKey?: string;
  aiApiBaseUrl: string;
  aiTextModel: string;
  aiVisionModel: string;
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
  webhookSecret?: string;
  whatsappVerifyToken?: string;
  wechatToken?: string;
  wechatEncodingAesKey?: string;
}

export function getServerEnv(): ServerEnv {
  const aiApiKey = process.env.AI_API_KEY?.trim() || undefined;
  const rawBaseUrl = process.env.AI_API_BASE_URL?.trim() || "https://api.openai.com/v1";
  const aiApiBaseUrl = rawBaseUrl.replace(/\/+$/, "");
  const aiTextModel = process.env.AI_TEXT_MODEL?.trim() || "gpt-4o-mini";
  const aiVisionModel = process.env.AI_VISION_MODEL?.trim() || "gpt-4o-mini";
  const supabaseUrl = process.env.SUPABASE_URL?.trim() || undefined;
  const supabaseServiceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || undefined;
  const webhookSecret = process.env.WEBHOOK_SECRET?.trim() || undefined;
  const whatsappVerifyToken =
    process.env.WHATSAPP_VERIFY_TOKEN?.trim() || webhookSecret;
  const wechatToken = process.env.WECHAT_TOKEN?.trim() || webhookSecret;
  const wechatEncodingAesKey =
    process.env.WECHAT_ENCODING_AES_KEY?.trim() || undefined;

  return {
    aiApiKey,
    aiApiBaseUrl,
    aiTextModel,
    aiVisionModel,
    supabaseUrl,
    supabaseServiceRoleKey,
    webhookSecret,
    whatsappVerifyToken,
    wechatToken,
    wechatEncodingAesKey,
  };
}

export function hasAiConfig(env: ServerEnv = getServerEnv()): boolean {
  return Boolean(env.aiApiKey);
}

export function hasSupabaseConfig(env: ServerEnv = getServerEnv()): boolean {
  return Boolean(env.supabaseUrl && env.supabaseServiceRoleKey);
}
