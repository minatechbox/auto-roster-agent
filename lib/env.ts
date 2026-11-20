export interface ServerEnv {
    aiApiKey?: string;
    aiApiBaseUrl: string;
    aiTextModel: string;
    aiVisionModel: string;
    supabaseUrl?: string;
    supabaseServiceRoleKey?: string;
    webhookSecret?: string;
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
  
    return {
      aiApiKey,
      aiApiBaseUrl,
      aiTextModel,
      aiVisionModel,
      supabaseUrl,
      supabaseServiceRoleKey,
      webhookSecret,
    };
  }
  
  export function hasAiConfig(env: ServerEnv = getServerEnv()): boolean {
    return Boolean(env.aiApiKey);
  }
  
  export function hasSupabaseConfig(env: ServerEnv = getServerEnv()): boolean {
    return Boolean(env.supabaseUrl && env.supabaseServiceRoleKey);
  }
