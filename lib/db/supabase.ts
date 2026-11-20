import { getServerEnv, hasSupabaseConfig } from "../env";

export interface SupabaseRestClient {
  url: string;
  serviceRoleKey: string;
}

export function getSupabaseClient(): SupabaseRestClient | null {
  const env = getServerEnv();
  if (!hasSupabaseConfig(env)) {
    return null;
  }

  return {
    url: env.supabaseUrl!.replace(/\/+$/, ""),
    serviceRoleKey: env.supabaseServiceRoleKey!,
  };
}