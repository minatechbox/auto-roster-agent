import { NextRequest, NextResponse } from "next/server";
import { approveRosterById } from "@/lib/db/rosters";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  if (!UUID_REGEX.test(id)) {
    return NextResponse.json({ error: "無效的更表 ID 格式。" }, { status: 400 });
  }

  try {
    const updated = await approveRosterById(id);
    if (!updated) {
      return NextResponse.json({ error: "找不到對應的更表紀錄。" }, { status: 404 });
    }
    return NextResponse.json({ roster: updated, status: updated.status }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "批准更表失敗。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}