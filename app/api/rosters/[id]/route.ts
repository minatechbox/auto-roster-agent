import { NextRequest, NextResponse } from "next/server";
import { updateRosterById } from "@/lib/db/rosters";
import type { ParsedAvailability, RosterWarning, Schedule } from "@/lib/types";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!UUID_REGEX.test(id)) {
    return NextResponse.json({ error: "無效的更表 ID 格式。" }, { status: 400 });
  }

  let body: {
    parsed?: ParsedAvailability;
    schedule?: Schedule;
    warnings?: RosterWarning[];
  };
  try {
    body = (await req.json()) as {
      parsed?: ParsedAvailability;
      schedule?: Schedule;
      warnings?: RosterWarning[];
    };
  } catch {
    return NextResponse.json({ error: "請求主體必須為合法 JSON。" }, { status: 400 });
  }

  if (!body.parsed || !body.schedule) {
    return NextResponse.json({ error: "必須提供 parsed 與 schedule。" }, { status: 400 });
  }

  try {
    const updated = await updateRosterById(id, {
      parsed: body.parsed,
      schedule: body.schedule,
      warnings: body.warnings,
    });
    if (!updated) {
      return NextResponse.json({ error: "找不到對應的更表紀錄。" }, { status: 404 });
    }
    return NextResponse.json({ roster: updated }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "更新更表失敗。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
