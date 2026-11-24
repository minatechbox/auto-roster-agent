import type {
    ParsedAvailability,
    RosterMode,
    RosterSource,
    RosterStatus,
    RosterWarning,
    Schedule,
    WeekRoster,
  } from "@/lib/types";
  import { getSupabaseClient } from "./supabase";
  
  interface WeekRosterRow {
    id: string;
    week_start: string;
    iso_week: string;
    status: RosterStatus;
    department: string | null;
    source: RosterSource;
    mode: RosterMode;
    parsed: ParsedAvailability;
    schedule: Schedule;
    warnings: RosterWarning[];
    created_at: string;
    approved_at: string | null;
  }
  
  function mapRowToWeekRoster(row: WeekRosterRow): WeekRoster {
    return {
      id: row.id,
      weekStart: row.week_start,
      isoWeek: row.iso_week,
      status: row.status,
      department: row.department,
      source: row.source,
      mode: row.mode,
      parsed: row.parsed,
      schedule: row.schedule,
      warnings: Array.isArray(row.warnings) ? row.warnings : [],
      createdAt: row.created_at,
      approvedAt: row.approved_at,
    };
  }
  
  export async function saveDraftRoster(
    roster: Omit<WeekRoster, "id" | "status" | "createdAt" | "approvedAt">
  ): Promise<{ persisted: boolean; roster: WeekRoster; error?: string }> {
    const client = getSupabaseClient();
    if (!client) {
      return {
        persisted: false,
        roster: {
          ...roster,
          id: null,
          status: "draft",
          createdAt: null,
          approvedAt: null,
        },
      };
    }
  
    const weekFilter = `week_start=eq.${encodeURIComponent(roster.weekStart)}`;
    const deptFilter = roster.department
      ? `&department=eq.${encodeURIComponent(roster.department)}`
      : "";
    await fetch(
      `${client.url}/rest/v1/week_rosters?${weekFilter}${deptFilter}&status=eq.draft`,
      {
        method: "DELETE",
        headers: {
          apikey: client.serviceRoleKey,
          Authorization: `Bearer ${client.serviceRoleKey}`,
        },
      },
    );

    const res = await fetch(`${client.url}/rest/v1/week_rosters`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: client.serviceRoleKey,
        Authorization: `Bearer ${client.serviceRoleKey}`,
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        week_start: roster.weekStart,
        iso_week: roster.isoWeek,
        status: "draft",
        department: roster.department,
        source: roster.source,
        mode: roster.mode,
        parsed: roster.parsed,
        schedule: roster.schedule,
        warnings: roster.warnings,
      }),
    });
  
    if (!res.ok) {
      const detail = await res.text();
      return {
        persisted: false,
        roster: {
          ...roster,
          id: null,
          status: "draft",
          createdAt: null,
          approvedAt: null,
        },
        error: `寫入 Supabase 失敗（HTTP ${res.status}）：${detail}`,
      };
    }
  
    const rows = (await res.json()) as WeekRosterRow[];
    if (!rows[0]) {
      return {
        persisted: false,
        roster: {
          ...roster,
          id: null,
          status: "draft",
          createdAt: null,
          approvedAt: null,
        },
        error: "Supabase 未回傳已建立的更表紀錄。",
      };
    }
  
    return {
      persisted: true,
      roster: mapRowToWeekRoster(rows[0]),
    };
  }
  
  export async function listRosters(weekStart?: string): Promise<WeekRoster[]> {
    const client = getSupabaseClient();
    if (!client) {
      return [];
    }
  
    const query = weekStart
      ? `?week_start=eq.${encodeURIComponent(weekStart)}&order=created_at.desc`
      : `?order=created_at.desc&limit=20`;
  
    const res = await fetch(`${client.url}/rest/v1/week_rosters${query}`, {
      method: "GET",
      headers: {
        apikey: client.serviceRoleKey,
        Authorization: `Bearer ${client.serviceRoleKey}`,
      },
      cache: "no-store",
    });
  
    if (!res.ok) {
      throw new Error(`讀取 Supabase 更表失敗（HTTP ${res.status}）。`);
    }
  
    const rows = (await res.json()) as WeekRosterRow[];
    const seen = new Set<string>();
    return rows.map(mapRowToWeekRoster).filter((item) => {
      const key = `${item.weekStart}|${item.department ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  
  export async function approveRosterById(id: string): Promise<WeekRoster | null> {
    const client = getSupabaseClient();
    if (!client) {
      throw new Error("尚未設定 Supabase 環境變數，無法批准更表。");
    }
  
    const approvedAt = new Date().toISOString();
    const res = await fetch(
      `${client.url}/rest/v1/week_rosters?id=eq.${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: client.serviceRoleKey,
          Authorization: `Bearer ${client.serviceRoleKey}`,
          Prefer: "return=representation",
        },
        body: JSON.stringify({
          status: "approved",
          approved_at: approvedAt,
        }),
      }
    );
  
    if (!res.ok) {
      throw new Error(`更新批准狀態失敗（HTTP ${res.status}）。`);
    }
  
    const rows = (await res.json()) as WeekRosterRow[];
    return rows[0] ? mapRowToWeekRoster(rows[0]) : null;
  }

  export async function updateRosterById(
    id: string,
    patch: { parsed: ParsedAvailability; schedule: Schedule },
  ): Promise<WeekRoster | null> {
    const client = getSupabaseClient();
    if (!client) {
      throw new Error("尚未設定 Supabase 環境變數，無法更新更表。");
    }

    const res = await fetch(
      `${client.url}/rest/v1/week_rosters?id=eq.${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: client.serviceRoleKey,
          Authorization: `Bearer ${client.serviceRoleKey}`,
          Prefer: "return=representation",
        },
        body: JSON.stringify({
          parsed: patch.parsed,
          schedule: patch.schedule,
        }),
      },
    );

    if (!res.ok) {
      throw new Error(`更新更表失敗（HTTP ${res.status}）。`);
    }

    const rows = (await res.json()) as WeekRosterRow[];
    return rows[0] ? mapRowToWeekRoster(rows[0]) : null;
  }