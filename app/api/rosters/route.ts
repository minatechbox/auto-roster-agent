import { NextRequest, NextResponse } from "next/server";
import { listRosters } from "@/lib/db/rosters";

export async function GET(req: NextRequest) {
  const weekStart = req.nextUrl.searchParams.get("weekStart")?.trim() || undefined;

  try {
    const rosters = await listRosters(weekStart);
    return NextResponse.json({ rosters }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "讀取更表列表失敗。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}