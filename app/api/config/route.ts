import { NextRequest, NextResponse } from "next/server";
import {
  computeEmployeeStats,
  DEFAULT_STORE_ID,
  getStoreConfig,
  updateStore,
  upsertEmployee,
  upsertReserve,
  upsertRules,
  upsertTemplate,
  type ConfigRow,
} from "@/lib/db/config";

const TARGETS = ["store", "employee", "reserve", "rules", "template"] as const;
type Target = (typeof TARGETS)[number];

const WRITERS: Record<
  Target,
  (storeId: string, payload: ConfigRow) => Promise<ConfigRow | null>
> = {
  store: updateStore,
  employee: upsertEmployee,
  reserve: upsertReserve,
  rules: upsertRules,
  template: upsertTemplate,
};

function resolveStoreId(raw: unknown): string {
  return typeof raw === "string" && raw.trim().length > 0
    ? raw.trim()
    : DEFAULT_STORE_ID;
}

export async function GET(req: NextRequest) {
  const storeId = resolveStoreId(req.nextUrl.searchParams.get("storeId"));

  try {
    const config = await getStoreConfig(storeId);
    const stats = computeEmployeeStats(config.employees);
    return NextResponse.json({ ...config, stats }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "讀取設定資料失敗。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "請求主體必須為合法 JSON。" }, { status: 400 });
  }

  const target = body.target;
  if (typeof target !== "string" || !TARGETS.includes(target as Target)) {
    return NextResponse.json(
      { error: "target 必須為 'store'、'employee'、'reserve'、'rules' 或 'template'。" },
      { status: 400 },
    );
  }

  const payload = body.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return NextResponse.json({ error: "必須提供物件形式的 payload。" }, { status: 400 });
  }

  const storeId = resolveStoreId(body.storeId);

  try {
    const saved = await WRITERS[target as Target](storeId, payload as ConfigRow);
    if (!saved) {
      return NextResponse.json({ error: "找不到對應的設定紀錄。" }, { status: 404 });
    }

    const config = await getStoreConfig(storeId);
    const stats = computeEmployeeStats(config.employees);
    return NextResponse.json({ saved, ...config, stats }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "更新設定資料失敗。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
