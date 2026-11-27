import { getSupabaseClient, type SupabaseRestClient } from "./supabase";

/** 對應 supabase/schema.sql 的 Seed 1 預設分店。 */
export const DEFAULT_STORE_ID = "00000000-0000-4000-8000-000000000001";

export type ConfigRow = Record<string, unknown>;

export interface StoreConfig {
  store: ConfigRow | null;
  employees: ConfigRow[];
  reserve_staff: ConfigRow[];
  roster_rules: ConfigRow[];
  roster_templates: ConfigRow[];
}

export interface EmployeeStats {
  totalCount: number;
  ftCount: number;
  hftCount: number;
  ptCount: number;
}

function requireClient(): SupabaseRestClient {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error("尚未設定 Supabase 環境變數，無法讀寫設定資料。");
  }
  return client;
}

async function restFetch<T>(
  client: SupabaseRestClient,
  path: string,
  init: { method: string; body?: string } = { method: "GET" },
): Promise<T> {
  const res = await fetch(`${client.url}/rest/v1/${path}`, {
    method: init.method,
    headers: {
      "Content-Type": "application/json",
      apikey: client.serviceRoleKey,
      Authorization: `Bearer ${client.serviceRoleKey}`,
      Prefer: "return=representation",
    },
    body: init.body,
    cache: "no-store",
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Supabase 操作失敗（HTTP ${res.status}）：${detail}`);
  }
  return (await res.json()) as T;
}

async function fetchRows(
  client: SupabaseRestClient,
  table: string,
  storeId: string,
  order: string,
): Promise<ConfigRow[]> {
  const query = `store_id=eq.${encodeURIComponent(storeId)}&order=${order}`;
  return restFetch<ConfigRow[]>(client, `${table}?${query}`);
}

export async function getStoreConfig(
  storeId: string = DEFAULT_STORE_ID,
): Promise<StoreConfig> {
  const client = requireClient();
  const [stores, employees, reserve_staff, roster_rules, roster_templates] =
    await Promise.all([
      restFetch<ConfigRow[]>(
        client,
        `stores?id=eq.${encodeURIComponent(storeId)}&limit=1`,
      ),
      fetchRows(client, "employees", storeId, "name.asc"),
      fetchRows(client, "reserve_staff", storeId, "priority.asc"),
      fetchRows(client, "roster_rules", storeId, "created_at.asc"),
      fetchRows(client, "roster_templates", storeId, "created_at.asc"),
    ]);

  return {
    store: stores[0] ?? null,
    employees,
    reserve_staff,
    roster_rules,
    roster_templates,
  };
}

/** 只統計在職員工；停用（is_active = false）不計入。 */
export function computeEmployeeStats(employees: ConfigRow[]): EmployeeStats {
  const active = employees.filter((row) => row.is_active !== false);
  const countBy = (type: string) =>
    active.filter((row) => row.employment_type === type).length;

  return {
    totalCount: active.length,
    ftCount: countBy("FT"),
    hftCount: countBy("HFT"),
    ptCount: countBy("PT"),
  };
}

/** 有 id 就 PATCH 該筆，否則 POST 新增。 */
async function writeRow(
  client: SupabaseRestClient,
  table: string,
  payload: ConfigRow,
): Promise<ConfigRow | null> {
  const { id, ...body } = payload;
  const rows =
    typeof id === "string" && id.length > 0
      ? await restFetch<ConfigRow[]>(
          client,
          `${table}?id=eq.${encodeURIComponent(id)}`,
          { method: "PATCH", body: JSON.stringify(body) },
        )
      : await restFetch<ConfigRow[]>(client, table, {
          method: "POST",
          body: JSON.stringify(body),
        });

  return rows[0] ?? null;
}

export async function updateStore(
  storeId: string,
  payload: ConfigRow,
): Promise<ConfigRow | null> {
  const client = requireClient();
  const { id, ...body } = payload;
  const rows = await restFetch<ConfigRow[]>(
    client,
    `stores?id=eq.${encodeURIComponent(storeId)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
  return rows[0] ?? null;
}

export async function upsertEmployee(
  storeId: string,
  payload: ConfigRow,
): Promise<ConfigRow | null> {
  return writeRow(requireClient(), "employees", {
    ...payload,
    store_id: storeId,
  });
}

export async function upsertReserve(
  storeId: string,
  payload: ConfigRow,
): Promise<ConfigRow | null> {
  return writeRow(requireClient(), "reserve_staff", {
    ...payload,
    store_id: storeId,
  });
}

/** rules 為每店／部門單筆設定，一律 PATCH。 */
export async function upsertRules(
  storeId: string,
  payload: ConfigRow,
): Promise<ConfigRow | null> {
  const client = requireClient();
  const { id, store_id, ...body } = payload;
  const filter =
    typeof id === "string" && id.length > 0
      ? `id=eq.${encodeURIComponent(id)}`
      : `store_id=eq.${encodeURIComponent(storeId)}` +
        (typeof body.department === "string"
          ? `&department=eq.${encodeURIComponent(body.department)}`
          : "");

  const rows = await restFetch<ConfigRow[]>(client, `roster_rules?${filter}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return rows[0] ?? null;
}

export async function upsertTemplate(
  storeId: string,
  payload: ConfigRow,
): Promise<ConfigRow | null> {
  return writeRow(requireClient(), "roster_templates", {
    ...payload,
    store_id: storeId,
  });
}
