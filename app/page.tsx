"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  type EmployeeAvailability,
  type RosterWarning,
  type Schedule,
  type WeekRoster,
  type WorkingShift,
} from "@/lib/types";
import {
  SERVICE_PERIODS,
  STAFF_CONFIG,
  coveredPeriodIds,
  formatAssignmentTimeLabel,
  getAssignmentWindowMinutes,
  hoursForEmployeeShift,
  periodDurationHours,
  periodTimeSlot,
  resolveCategory,
  shiftForPeriod,
  sundayOnOrBefore,
  weekDates,
  weekEndDate,
} from "@/lib/roster/rules";
import type { ServicePeriodId } from "@/lib/roster/rules";
import {
  auditWeekCoverage,
  evaluateRosterWarnings,
  isIntakeNote,
  summarizeSchedule,
} from "@/lib/roster/schedule";
import ConfigDrawer from "@/components/ConfigDrawer";

interface RosterApiResponse {
  rosters?: WeekRoster[];
  error?: string;
}

interface ParseAndScheduleResponse {
  roster?: WeekRoster;
  persisted?: boolean;
  mode?: string;
  warnings?: RosterWarning[];
  error?: string;
}

interface ApproveResponse {
  roster?: WeekRoster;
  status?: string;
  error?: string;
}

interface SaveDayResponse {
  roster?: WeekRoster;
  error?: string;
}

/** /api/rosters（action: recalculate）回應。 */
interface RecalculateResponse {
  roster?: WeekRoster;
  schedule?: Schedule;
  warnings?: RosterWarning[];
  stats?: StaffStats;
  persisted?: boolean;
  error?: string;
}

interface StaffStats {
  totalCount: number;
  ftCount: number;
  hftCount: number;
  ptCount: number;
}

interface EmployeeMeta {
  rank: string;
  employment_type: string;
}

interface ConfigApiResponse {
  employees?: unknown;
  stats?: StaffStats;
  error?: string;
}

/** 手改時間面板：一日多段班次逐段編輯。 */
interface EditSegment {
  /** 前端臨時 key（方便 React list 與移除）。 */
  key: string;
  start: string;
  end: string;
}

interface EditCellState {
  employee: string;
  day: string;
  segments: EditSegment[];
  /** 打開彈窗時的上班／落班（分鐘）。早收以此為準，不會連撳累減。 */
  baselineStartMin: number;
  baselineEndMin: number;
}

type DayDuty = "AM" | "PM" | "EVE" | "leave" | "OFF";

const SAMPLE_TEXT = `Superme Cafe 報更
Jamie Cole 6000 1001：星期一至五 AM/PM 都可以，星期六 AM，星期日只可早更，11/25 請假
Noah Blake 6000 1002：星期二至六 AM，星期一、日放假
Casey Quinn 6000 1003：星期一、三、五 PM，星期六、日放假
Riley Shaw 6000 1004：只可上下午更，週末唔得，11/26 請假
Avery Kim 6000 1005：11/25 請假，其餘日子 AM/PM 都可以
Jordan Hale 6000 1006：全週只可上早更
Morgan Ellis 6000 1007：只可星期一、三、五、六下午更
Taylor Brooks 6000 1008：11/27 請假，其餘日子 AM/PM 都可以
Parker Nguyen 6000 1009：週一至週五只可上下午更
Quinn Adler 6000 1010：只可星期日、二、四早更
後補：Reese Dalton 6000 1011、Skyler Ortiz 6000 1012、Hayden Cho 6000 1013、Rowan Patel 6000 1014`;

const SAMPLE_WECHAT_TEXT = `[微信群] Superme Cafe 報更
Jamie Cole：星期一至五 AM/PM 都可以，星期六 AM，星期日只可早更，11/25 請假
Noah Blake：星期二至六 AM，星期一、日放假
Casey Quinn：星期一、三、五 PM，星期六、日放假
Riley Shaw：只可上下午更，週末唔得，11/26 請假
Avery Kim：11/25 請假，其餘日子 AM/PM 都可以
Jordan Hale：全週只可上早更
Morgan Ellis：只可星期一、三、五、六下午更
Taylor Brooks：11/27 請假，其餘日子 AM/PM 都可以
Parker Nguyen：週一至週五只可上下午更
Quinn Adler：只可星期日、二、四早更
後補：Reese Dalton、Skyler Ortiz、Hayden Cho、Rowan Patel`;

type IntakeTab = "whatsapp" | "wechat" | "image";
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];
const DAY_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatDayHeader(dateStr: string): { top: string; sub: string } {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    return { top: dateStr, sub: "" };
  }
  const weekday = WEEKDAY_LABELS[d.getUTCDay()] ?? "";
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return { top: `週${weekday}`, sub: `${mm}/${dd}` };
}

// ── 清新東南亞現代風（100% 對齊 ConfigDrawer.tsx） ──
const BTN_PRIMARY =
  "rounded-lg bg-[#1D8A74] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#167763] disabled:cursor-not-allowed disabled:opacity-50";
const BTN_OUTLINE =
  "rounded-lg border border-[#1D8A74] bg-white px-3.5 py-2 text-sm font-medium text-[#167763] transition hover:bg-[#E8F3F0] disabled:opacity-50";
const BTN_GHOST =
  "rounded-lg border border-[#E4DDD2] bg-white px-3.5 py-2 text-sm font-medium text-zinc-700 transition hover:bg-[#F5F1EB] disabled:opacity-50";
const FIELD =
  "mt-1 w-full rounded-lg border border-[#E4DDD2] bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none transition focus:border-[#1D8A74] focus:ring-2 focus:ring-[#1D8A74]/20";
const CARD = "rounded-2xl border border-[#E4DDD2] bg-white";
const PANEL = "bg-[#F5F1EB]";
const ROWLINE = "border-[#EFE9E0]";
const LBL = "block text-xs font-medium text-zinc-500";
const TH = "px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-zinc-600";
const CHK = "h-3.5 w-3.5 accent-[#1D8A74]";

const CHIP_SIZE =
  "inline-flex h-7 w-full items-center justify-center rounded px-0.5 text-[10px] font-medium leading-none";

function chipClass(on: boolean, tone: "work" | "leave" | "off" = "work"): string {
  if (on && tone === "leave") return `${CHIP_SIZE} bg-rose-600 text-white`;
  if (on && tone === "off") return `${CHIP_SIZE} bg-zinc-400 text-white`;
  if (on) return `${CHIP_SIZE} bg-[#1D8A74] text-white`;
  return `${CHIP_SIZE} bg-[#F5F1EB] text-zinc-600 hover:bg-[#E8F3F0]`;
}

/** 只作 DB 未設定職位時的最後防呆（不參與任何工時計算）。 */
const DEMO_RANK: Record<string, string> = {
  "Jamie Cole": "SM",
  "Noah Blake": "M",
  "Casey Quinn": "A.M",
  "Riley Shaw": "S",
  "Avery Kim": "S",
  "Jordan Hale": "W",
  "Morgan Ellis": "WH",
  "Taylor Brooks": "S",
  "Parker Nguyen": "W",
  "Quinn Adler": "WH",
  "Reese Dalton": "W",
  "Skyler Ortiz": "WH",
  "Hayden Cho": "W",
  "Rowan Patel": "WH",
};

function roleParts(
  emp: EmployeeAvailability | undefined,
  meta?: EmployeeMeta,
): { rank: string; kind: string } {
  const name = emp?.name ?? "";
  const category = emp ? resolveCategory(emp) : null;
  const fallbackKind =
    category === "part_time" ? "PT" : category === "half_full_time" ? "HFT" : "FT";
  return {
    rank: meta?.rank || DEMO_RANK[name] || "S",
    kind: meta?.employment_type || fallbackKind,
  };
}

function formatHours(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded}h`;
}

function PeriodRatio({
  periods,
}: {
  periods: { id: string; actual: number; required: number; ok: boolean }[] | undefined;
}) {
  return (
    <>
      {SERVICE_PERIODS.map((period, index) => {
        const cell = periods?.find((item) => item.id === period.id);
        const short = cell ? !cell.ok : false;
        return (
          <span key={period.id} className={short ? "font-bold text-rose-600" : undefined}>
            {index > 0 ? "／" : ""}
            {period.shortLabel}({cell ? `${cell.actual}/${cell.required}` : "—"})
          </span>
        );
      })}
    </>
  );
}

function slotStartMinutes(slot: string): number {
  const start = slot.split("-")[0] ?? "";
  const [hh, mm] = start.split(":").map((part) => Number(part));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return 0;
  return hh * 60 + mm;
}

function hhmmToMinutes(raw: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 24 || mm < 0 || mm > 59) return null;
  if (hh === 24 && mm !== 0) return null;
  return hh * 60 + mm;
}

function formatMinutes(minutes: number): string {
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** 相連或重疊的時段合併成一段；中間有空隙先拆開。 */
function mergeConsecutiveWindows(
  windows: { start: number; end: number }[],
): { start: number; end: number }[] {
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const win of sorted) {
    const last = merged[merged.length - 1];
    if (last && win.start <= last.end) {
      last.end = Math.max(last.end, win.end);
    } else {
      merged.push({ start: win.start, end: win.end });
    }
  }
  return merged;
}

function shiftFromStart(startMinutes: number): WorkingShift {
  if (startMinutes < 11 * 60) return "AM";
  if (startMinutes < 17 * 60) return "PM";
  return "EVE";
}

function slotForEmployee(emp: EmployeeAvailability, shift: WorkingShift): string {
  const slots = STAFF_CONFIG[resolveCategory(emp)].slots;
  if (slots.length === 0) return "";
  if (shift === "AM") {
    return slots.find((slot) => slotStartMinutes(slot) < 11 * 60) ?? slots[0] ?? "";
  }
  if (shift === "EVE") {
    return (
      [...slots].reverse().find((slot) => slotStartMinutes(slot) >= 17 * 60) ??
      slots[slots.length - 1] ??
      ""
    );
  }
  return (
    slots.find((slot) => {
      const start = slotStartMinutes(slot);
      return start >= 11 * 60 && start < 17 * 60;
    }) ??
    slots.find((slot) => slotStartMinutes(slot) >= 12 * 60) ??
    slots[slots.length - 1] ??
    ""
  );
}

export default function Home() {
  const [rosters, setRosters] = useState<WeekRoster[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState<boolean>(true);
  const [generatingDb, setGeneratingDb] = useState<boolean>(false);
  const [generatingMock, setGeneratingMock] = useState<boolean>(false);
  const [submittingText, setSubmittingText] = useState<boolean>(false);
  const [submittingWechat, setSubmittingWechat] = useState<boolean>(false);
  const [submittingImage, setSubmittingImage] = useState<boolean>(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  // 店舖與員工設定抽屜 + DB 動態人數
  const [configOpen, setConfigOpen] = useState<boolean>(false);
  const [menuOpen, setMenuOpen] = useState<boolean>(false);
  const [stats, setStats] = useState<StaffStats | null>(null);
  const [empMeta, setEmpMeta] = useState<Map<string, EmployeeMeta>>(new Map());

  // 列印積木：預設兩塊都印
  const [printWeekGrid, setPrintWeekGrid] = useState<boolean>(true);
  const [printPeriodGrid, setPrintPeriodGrid] = useState<boolean>(true);

  // 手改時間面板（按段修改，支援多段）
  const [editCell, setEditCell] = useState<EditCellState | null>(null);
  const [savingCell, setSavingCell] = useState<boolean>(false);

  const [weekStart, setWeekStart] = useState<string>("2026-11-22");
  const [department, setDepartment] = useState<string>("Superme Cafe");
  const [availabilityText, setAvailabilityText] = useState<string>(SAMPLE_TEXT);
  const [wechatText, setWechatText] = useState<string>(SAMPLE_WECHAT_TEXT);
  const [intakeTab, setIntakeTab] = useState<IntakeTab>("whatsapp");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const weekStartInputRef = useRef<HTMLInputElement | null>(null);

  const [feedback, setFeedback] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string>("2026-11-22");
  const [savingDay, setSavingDay] = useState<boolean>(false);
  const [excessOpen, setExcessOpen] = useState(false);
  const excessRef = useRef<HTMLDivElement>(null);
  const rosterRef = useRef<WeekRoster | null>(null);
  const saveQueue = useRef(Promise.resolve());

  /** 由 /api/config 讀取 DB 人數統計與職位標記（Supabase 未設定時靜默失敗）。 */
  const loadStats = useCallback(async () => {
    try {
      const res = await fetch("/api/config", { cache: "no-store" });
      const data = (await res.json()) as ConfigApiResponse;
      if (!res.ok) return;
      setStats(data.stats ?? null);
      const rows = Array.isArray(data.employees) ? data.employees : [];
      const next = new Map<string, EmployeeMeta>();
      for (const raw of rows) {
        const row = raw as Record<string, unknown>;
        if (row.is_active === false) continue;
        const name = typeof row.name === "string" ? row.name : "";
        if (!name) continue;
        const role = typeof row.role_title === "string" ? row.role_title : "";
        const legacy = typeof row.position === "string" ? row.position : "";
        const type = typeof row.employment_type === "string" ? row.employment_type : "FT";
        next.set(name, { rank: role || legacy, employment_type: type });
      }
      setEmpMeta(next);
    } catch {
      /* 未設定 Supabase 時不阻斷頁面 */
    }
  }, []);

  const loadRosters = useCallback(async (preferredId?: string | null) => {
    try {
      const res = await fetch("/api/rosters", { cache: "no-store" });
      const data = (await res.json()) as RosterApiResponse;
      if (!res.ok) {
        throw new Error(data.error || `讀取更表失敗（HTTP ${res.status}）`);
      }
      setErrorMsg(null);
      const list = Array.isArray(data.rosters) ? data.rosters : [];
      setRosters(list);

      if (preferredId) {
        setSelectedId(preferredId);
        const found = list.find((item) => item.id === preferredId);
        if (found?.weekStart) {
          setWeekStart(found.weekStart);
          setSelectedDay(found.weekStart);
        }
      } else if (list.length > 0) {
        setSelectedId((prev) =>
          prev && list.some((item) => item.id === prev) ? prev : list[0].id
        );
      } else {
        setSelectedId(null);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "讀取更表列表時發生錯誤");
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) {
        void loadRosters();
        void loadStats();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadRosters, loadStats]);

  useEffect(() => {
    return () => {
      if (imagePreview) URL.revokeObjectURL(imagePreview);
    };
  }, [imagePreview]);

  useEffect(() => {
    if (!excessOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (!excessRef.current?.contains(event.target as Node)) setExcessOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [excessOpen]);

  function handleWeekStartChange(raw: string) {
    if (!raw) return;
    let sunday = raw;
    try {
      sunday = sundayOnOrBefore(raw);
    } catch {
      return;
    }
    setWeekStart(sunday);
    try {
      setSelectedDay(weekDates(sunday)[0] ?? sunday);
    } catch {
      setSelectedDay(sunday);
    }
    const match = rosters.find((item) => item.weekStart === sunday);
    setSelectedId(match?.id ?? null);
    setFeedback(
      match
        ? `已轉去 ${sunday} 嗰週更表`
        : `已轉去 ${sunday} 嗰週（暫無草稿，可按「+ Mock 草稿」）`,
    );
  }

  function openWeekStartPicker() {
    const input = weekStartInputRef.current;
    if (!input) return;
    try {
      if (typeof input.showPicker === "function") {
        input.showPicker();
        return;
      }
    } catch {
      /* native picker may already be open */
    }
    input.focus();
    input.click();
  }

  async function handleGenerateFromDb() {
    setGeneratingDb(true);
    setFeedback(null);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/parse-and-schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "db",
          weekStart: weekStart.trim() || "2026-11-22",
          department: department.trim() || undefined,
        }),
      });
      const data = (await res.json()) as ParseAndScheduleResponse;
      if (!res.ok) {
        throw new Error(data.error || `由員工庫生成更表失敗（HTTP ${res.status}）`);
      }
      const createdId = data.roster?.id ?? null;
      await loadRosters(createdId);
      await loadStats();
      setFeedback(
        data.persisted
          ? `已按 DB 員工庫生成草稿（ID: ${createdId ?? "—"}）`
          : "已按 DB 員工庫生成草稿，但未持久化至 Supabase"
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "由員工庫生成草稿時發生錯誤");
    } finally {
      setGeneratingDb(false);
    }
  }

  async function handleGenerateMock() {
    setGeneratingMock(true);
    setFeedback(null);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/parse-and-schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "mock",
          weekStart: weekStart.trim() || undefined,
          department: department.trim() || undefined,
        }),
      });
      const data = (await res.json()) as ParseAndScheduleResponse;
      if (!res.ok) {
        throw new Error(data.error || `生成 Mock 更表失敗（HTTP ${res.status}）`);
      }
      const createdId = data.roster?.id ?? null;
      await loadRosters(createdId);
      setFeedback(
        data.persisted
          ? `已建立並寫入 Supabase 草稿（ID: ${createdId ?? "—"}）`
          : "已生成草稿，但未持久化至 Supabase（請檢查環境變數）"
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "生成草稿時發生錯誤");
    } finally {
      setGeneratingMock(false);
    }
  }

  async function ingestTextChannel(channel: "whatsapp" | "wechat", text: string) {
    const res = await fetch("/api/parse-and-schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "text",
        channel,
        text,
        weekStart: weekStart.trim() || "2026-11-22",
        department: department.trim() || undefined,
      }),
    });
    const data = (await res.json()) as ParseAndScheduleResponse;
    if (!res.ok) {
      throw new Error(data.error || `解析文字並生成更表失敗（HTTP ${res.status}）`);
    }
    const createdId = data.roster?.id ?? null;
    await loadRosters(createdId);
    const label = channel === "wechat" ? "WeChat" : "WhatsApp";
    const note = data.warnings?.find((item) => isIntakeNote(item))?.message;
    setFeedback(
      `已由 ${label} 文字（${data.mode ?? "text"}）建立更表草稿${
        data.persisted ? "並寫入 Supabase" : "（未寫入 Supabase）"
      }（ID: ${createdId ?? "—"}）${note ? ` ${note}` : ""}`
    );
  }

  async function handleTextSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!availabilityText.trim()) {
      setErrorMsg("請先貼上 WhatsApp 群組覆期文字。");
      return;
    }

    setSubmittingText(true);
    setFeedback(null);
    setErrorMsg(null);
    try {
      await ingestTextChannel("whatsapp", availabilityText.trim());
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "解析 WhatsApp 文字時發生錯誤");
    } finally {
      setSubmittingText(false);
    }
  }

  async function handleWechatSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!wechatText.trim()) {
      setErrorMsg("請先貼上 WeChat 群組／私訊對話紀錄。");
      return;
    }

    setSubmittingWechat(true);
    setFeedback(null);
    setErrorMsg(null);
    try {
      await ingestTextChannel("wechat", wechatText.trim());
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "解析 WeChat 文字時發生錯誤");
    } finally {
      setSubmittingWechat(false);
    }
  }

  function handlePickImage(file: File | null) {
    setImagePreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return file ? URL.createObjectURL(file) : null;
    });
    setImageFile(file);
  }

  function mimeFromFile(file: File): "image/jpeg" | "image/png" | "image/webp" | null {
    const type = file.type.toLowerCase();
    if (IMAGE_MIMES.has(type)) {
      return type as "image/jpeg" | "image/png" | "image/webp";
    }
    const name = file.name.toLowerCase();
    if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
    if (name.endsWith(".png")) return "image/png";
    if (name.endsWith(".webp")) return "image/webp";
    return null;
  }

  async function handleImageSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!imageFile) {
      setErrorMsg("請先拍攝或上傳日曆／更期相片。");
      return;
    }
    const mimeType = mimeFromFile(imageFile);
    if (!mimeType) {
      setErrorMsg("只支援 JPEG、PNG 或 WebP 相片。");
      return;
    }
    if (imageFile.size > 4 * 1024 * 1024) {
      setErrorMsg("相片超過 4 MB，請壓縮後再上傳。");
      return;
    }

    setSubmittingImage(true);
    setFeedback(null);
    setErrorMsg(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(new Error("讀取相片失敗。"));
        reader.readAsDataURL(imageFile);
      });
      const imageBase64 = dataUrl.includes(",") ? dataUrl.split(",")[1] ?? "" : dataUrl;
      const res = await fetch("/api/parse-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64,
          mimeType,
          weekStart: weekStart.trim() || "2026-11-22",
          department: department.trim() || undefined,
        }),
      });
      const data = (await res.json()) as ParseAndScheduleResponse;
      if (!res.ok) {
        throw new Error(data.error || `相片辨識失敗（HTTP ${res.status}）`);
      }
      const createdId = data.roster?.id ?? null;
      await loadRosters(createdId);
      setFeedback(
        `已由日曆相片（${data.mode ?? "image"}）建立更表草稿${
          data.persisted ? "並寫入 Supabase" : "（未寫入 Supabase）"
        }（ID: ${createdId ?? "—"}）`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "相片辨識時發生錯誤");
    } finally {
      setSubmittingImage(false);
    }
  }

  async function handleApprove(id: string | null) {
    if (!id) return;
    setApprovingId(id);
    setFeedback(null);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/rosters/${encodeURIComponent(id)}/approve`, {
        method: "POST",
      });
      const data = (await res.json()) as ApproveResponse;
      if (!res.ok) {
        throw new Error(data.error || `批准更表失敗（HTTP ${res.status}）`);
      }
      await loadRosters(id);
      setFeedback(`更表 ${id} 已更新為 approved`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "批准更表時發生錯誤");
    } finally {
      setApprovingId(null);
    }
  }

  const selectedRoster =
    rosters.find((item) => item.id === selectedId && item.weekStart === weekStart) ??
    rosters.find((item) => item.weekStart === weekStart) ??
    null;

  useEffect(() => {
    rosterRef.current = selectedRoster;
  }, [selectedRoster]);

  const days = selectedRoster?.schedule?.days ?? [];
  const assignments = selectedRoster?.schedule?.assignments ?? [];
  let weekDays: string[] = [];
  try {
    weekDays = weekDates(weekStart);
  } catch {
    weekDays = days;
  }
  const activeDay = weekDays.includes(selectedDay) ? selectedDay : (weekDays[0] ?? "");

  const orderedEmployees: string[] = [];
  const seenEmp = new Set<string>();
  const reserveEmployees = (selectedRoster?.parsed?.employees ?? []).filter(
    (emp) => emp.reserve && emp.name
  );
  for (const emp of selectedRoster?.parsed?.employees ?? []) {
    if (emp.reserve) continue;
    if (emp.name && !seenEmp.has(emp.name)) {
      seenEmp.add(emp.name);
      orderedEmployees.push(emp.name);
    }
  }
  const reserveNameSet = new Set(reserveEmployees.map((emp) => emp.name));
  for (const a of assignments) {
    if (!a.employee || seenEmp.has(a.employee) || reserveNameSet.has(a.employee)) {
      continue;
    }
    seenEmp.add(a.employee);
    orderedEmployees.push(a.employee);
  }

  const leaveMap = new Map<string, Set<string>>();
  const employeeByName = new Map<string, EmployeeAvailability>();
  for (const emp of selectedRoster?.parsed?.employees ?? []) {
    leaveMap.set(emp.name, new Set(emp.leave ?? []));
    employeeByName.set(emp.name, emp);
  }

  function dayKind(employee: string, day: string): "work" | "leave" | "off" {
    if (assignments.some((item) => item.employee === employee && item.date === day)) {
      return "work";
    }
    if (leaveMap.get(employee)?.has(day)) return "leave";
    return "off";
  }

  function dutyCode(employee: string, day: string, kind: "leave" | "off"): string {
    const prefix = kind === "leave" ? "W" : "AL";
    const index = weekDays.filter((item) => dayKind(employee, item) === kind).indexOf(day);
    return index >= 0 ? `${prefix}${index + 1}` : prefix;
  }

  function workDayCount(employee: string): number {
    return weekDays.filter((day) => dayKind(employee, day) === "work").length;
  }

  function weekHoursFor(employee: string): number {
    return assignments
      .filter((item) => item.employee === employee)
      .reduce((sum, item) => sum + (item.hours ?? 0), 0);
  }

  function splitDayHours(day: string): {
    regular: number;
    overtime: number;
    partTime: number;
    total: number;
  } {
    const names = new Set(
      assignments.filter((item) => item.date === day).map((item) => item.employee),
    );
    let regular = 0;
    let overtime = 0;
    let partTime = 0;
    for (const name of names) {
      const hours = assignments
        .filter((item) => item.employee === name && item.date === day)
        .reduce((sum, item) => sum + (item.hours ?? 0), 0);
      const category = resolveCategory(
        employeeByName.get(name) ?? {
          name,
          department: "Superme Cafe",
          leave: [],
          available: {},
        },
      );
      if (category === "part_time") {
        partTime += hours;
        continue;
      }
      const cap = category === "half_full_time" ? 5 : 10;
      regular += Math.min(hours, cap);
      overtime += Math.max(0, hours - cap);
    }
    return { regular, overtime, partTime, total: regular + overtime + partTime };
  }

  const daySplits = weekDays.map((day) => splitDayHours(day));
  const hourSummaryRows: { key: string; label: string; values: number[] }[] = [
    { key: "ft", label: "長工工時", values: daySplits.map((item) => item.regular) },
    { key: "ot", label: "長工加班工時", values: daySplits.map((item) => item.overtime) },
    { key: "pt", label: "兼職工時", values: daySplits.map((item) => item.partTime) },
    { key: "all", label: "每日總工時", values: daySplits.map((item) => item.total) },
  ];

  const coverageDays = selectedRoster
    ? auditWeekCoverage(
        weekDays,
        selectedRoster.parsed?.employees ?? [],
        assignments,
      )
    : [];
  const dayCoverage =
    coverageDays.find((item) => item.date === activeDay) ?? null;

  async function handleApplyDuty(employeeName: string, day: string, duty: DayDuty) {
    const selected = rosterRef.current;
    if (!selected) return;

    const existing =
      selected.parsed.employees.find((e) => e.name === employeeName) ??
      ({
        name: employeeName,
        department: selected.department || "Superme Cafe",
        leave: [],
        available: {},
      } satisfies EmployeeAvailability);

    const employees = selected.parsed.employees.some((e) => e.name === employeeName)
      ? selected.parsed.employees.map((e) => {
          if (e.name !== employeeName) {
            return { ...e, leave: [...(e.leave ?? [])] };
          }
          const leave = (e.leave ?? []).filter((d) => d !== day);
          if (duty === "leave") leave.push(day);
          return { ...e, leave };
        })
      : [
          ...selected.parsed.employees.map((e) => ({
            ...e,
            leave: [...(e.leave ?? [])],
          })),
          {
            ...existing,
            leave: duty === "leave" ? [day] : [...(existing.leave ?? [])].filter((d) => d !== day),
          },
        ];

    const nextEmp = employees.find((e) => e.name === employeeName) ?? existing;
    let nextAssignments = selected.schedule.assignments.filter(
      (a) => !(a.employee === employeeName && a.date === day),
    );
    if (duty === "AM" || duty === "PM" || duty === "EVE") {
      nextAssignments = [
        ...nextAssignments,
        {
          date: day,
          shift: duty,
          employee: employeeName,
          department: nextEmp.department || selected.department || "Superme Cafe",
          hours: hoursForEmployeeShift(nextEmp),
          timeSlot: slotForEmployee(nextEmp, duty),
        },
      ];
    }

    const scheduleDays = weekDays.length === 7 ? weekDays : selected.schedule.days;
    const employeeNames = [...new Set(employees.map((e) => e.name))];
    const { dailyHours: nextDaily, employeeHours: nextEmpHours } = summarizeSchedule(
      scheduleDays,
      nextAssignments,
      employeeNames,
    );
    const nextWarnings = [
      ...(selected.warnings ?? []).filter(isIntakeNote),
      ...evaluateRosterWarnings(scheduleDays, employees, nextAssignments),
    ];

    const nextRoster: WeekRoster = {
      ...selected,
      parsed: { employees },
      schedule: {
        ...selected.schedule,
        days: scheduleDays,
        assignments: nextAssignments,
        dailyHours: nextDaily,
        employeeHours: nextEmpHours,
      },
      warnings: nextWarnings,
    };

    const rosterId = selected.id;
    rosterRef.current = nextRoster;
    setRosters((prev) =>
      prev.map((item) => (item.id === rosterId ? nextRoster : item)),
    );
    setSelectedDay(day);
    setFeedback(`已改 ${formatDayHeader(day).top} ${formatDayHeader(day).sub} · ${employeeName}`);

    if (!rosterId) return;

    setSavingDay(true);
    setErrorMsg(null);
    saveQueue.current = saveQueue.current
      .then(async () => {
        const latest = rosterRef.current;
        if (!latest?.id) return;
        const res = await fetch(`/api/rosters/${encodeURIComponent(latest.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parsed: latest.parsed,
            schedule: latest.schedule,
            warnings: latest.warnings,
          }),
        });
        const data = (await res.json()) as SaveDayResponse;
        if (!res.ok) {
          throw new Error(data.error || `儲存當日更表失敗（HTTP ${res.status}）`);
        }
      })
      .catch((err: unknown) => {
        setErrorMsg(err instanceof Error ? err.message : "儲存當日更表時發生錯誤");
      })
      .finally(() => {
        setSavingDay(false);
      });
  }

  async function handleTogglePeriod(
    employeeName: string,
    day: string,
    periodId: ServicePeriodId,
  ) {
    const selected = rosterRef.current;
    if (!selected) return;

    const existing =
      selected.parsed.employees.find((e) => e.name === employeeName) ??
      ({
        name: employeeName,
        department: selected.department || "Superme Cafe",
        leave: [],
        available: {},
      } satisfies EmployeeAvailability);

    const dayAssignments = selected.schedule.assignments.filter(
      (item) => item.employee === employeeName && item.date === day,
    );
    const covered = new Set(coveredPeriodIds(dayAssignments));
    if (covered.has(periodId)) {
      covered.delete(periodId);
    } else {
      covered.add(periodId);
    }

    const employees = selected.parsed.employees.some((e) => e.name === employeeName)
      ? selected.parsed.employees.map((e) => {
          if (e.name !== employeeName) {
            return { ...e, leave: [...(e.leave ?? [])] };
          }
          const leave = (e.leave ?? []).filter((d) => d !== day);
          return { ...e, leave };
        })
      : [
          ...selected.parsed.employees.map((e) => ({
            ...e,
            leave: [...(e.leave ?? [])],
          })),
          { ...existing, leave: [...(existing.leave ?? [])].filter((d) => d !== day) },
        ];

    const nextEmp = employees.find((e) => e.name === employeeName) ?? existing;
    let nextAssignments = selected.schedule.assignments.filter(
      (item) => !(item.employee === employeeName && item.date === day),
    );
    for (const period of SERVICE_PERIODS) {
      if (!covered.has(period.id)) continue;
      nextAssignments = [
        ...nextAssignments,
        {
          date: day,
          shift: shiftForPeriod(period),
          employee: employeeName,
          department: nextEmp.department || selected.department || "Superme Cafe",
          hours: periodDurationHours(period),
          timeSlot: periodTimeSlot(period),
        },
      ];
    }

    const scheduleDays = weekDays.length === 7 ? weekDays : selected.schedule.days;
    const employeeNames = [...new Set(employees.map((e) => e.name))];
    const { dailyHours: nextDaily, employeeHours: nextEmpHours } = summarizeSchedule(
      scheduleDays,
      nextAssignments,
      employeeNames,
    );
    const nextWarnings = [
      ...(selected.warnings ?? []).filter(isIntakeNote),
      ...evaluateRosterWarnings(scheduleDays, employees, nextAssignments),
    ];

    const nextRoster: WeekRoster = {
      ...selected,
      parsed: { employees },
      schedule: {
        ...selected.schedule,
        days: scheduleDays,
        assignments: nextAssignments,
        dailyHours: nextDaily,
        employeeHours: nextEmpHours,
      },
      warnings: nextWarnings,
    };

    const rosterId = selected.id;
    rosterRef.current = nextRoster;
    setRosters((prev) =>
      prev.map((item) => (item.id === rosterId ? nextRoster : item)),
    );
    setSelectedDay(day);
    const period = SERVICE_PERIODS.find((item) => item.id === periodId);
    setFeedback(
      `已改 ${formatDayHeader(day).top} ${formatDayHeader(day).sub} · ${employeeName} · ${period?.shortLabel ?? periodId}`,
    );

    if (!rosterId) return;

    setSavingDay(true);
    setErrorMsg(null);
    saveQueue.current = saveQueue.current
      .then(async () => {
        const latest = rosterRef.current;
        if (!latest?.id) return;
        const res = await fetch(`/api/rosters/${encodeURIComponent(latest.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parsed: latest.parsed,
            schedule: latest.schedule,
            warnings: latest.warnings,
          }),
        });
        const data = (await res.json()) as SaveDayResponse;
        if (!res.ok) {
          throw new Error(data.error || `儲存當日更表失敗（HTTP ${res.status}）`);
        }
      })
      .catch((err: unknown) => {
        setErrorMsg(err instanceof Error ? err.message : "儲存當日更表時發生錯誤");
      })
      .finally(() => {
        setSavingDay(false);
      });
  }

  function getCellDisplay(employee: string, day: string): {
    label: string;
    sub?: string;
    kind: "work" | "leave" | "off";
  } {
    const matched = assignments.filter(
      (a) => a.employee === employee && a.date === day
    );
    if (matched.length > 0) {
      const totalH = matched.reduce((sum, m) => sum + (m.hours ?? 0), 0);
      return {
        label: formatAssignmentTimeLabel(matched),
        sub: totalH > 0 ? `${formatHours(totalH)}` : undefined,
        kind: "work",
      };
    }
    if (leaveMap.get(employee)?.has(day)) {
      return { label: dutyCode(employee, day, "leave"), kind: "leave" };
    }
    return { label: dutyCode(employee, day, "off"), kind: "off" };
  }

  /** 當日列「改時間」→ 連續時段合併成上班—落班，有空隙先拆段。 */
  function openTimeEditor(employee: string, day: string) {
    const matched = assignments.filter(
      (item) => item.employee === employee && item.date === day,
    );
    const merged = mergeConsecutiveWindows(matched.map((item) => getAssignmentWindowMinutes(item)));
    const segments: EditSegment[] =
      merged.length > 0
        ? merged.map((win, index) => ({
            key: `seg-${index}`,
            start: formatMinutes(win.start),
            end: formatMinutes(win.end),
          }))
        : [{ key: "seg-0", start: "07:00", end: "17:00" }];
    const baselineStartMin = hhmmToMinutes(segments[0]?.start ?? "07:00") ?? 7 * 60;
    const baselineEndMin =
      hhmmToMinutes(segments[segments.length - 1]?.end ?? "17:00") ?? 17 * 60;
    setEditCell({ employee, day, segments, baselineStartMin, baselineEndMin });
  }

  /** 早收以打開時的落班為準；半日更收成一段（上班後 5 小時）。 */
  function applyTimeShortcut(kind: "early1" | "early2" | "half") {
    setEditCell((prev) => {
      if (!prev) return prev;
      if (kind === "half") {
        const endMin = Math.min(prev.baselineStartMin + 5 * 60, 24 * 60);
        return {
          ...prev,
          segments: [
            {
              key: "seg-half",
              start: formatMinutes(prev.baselineStartMin),
              end: formatMinutes(endMin),
            },
          ],
        };
      }
      const cut = kind === "early1" ? 60 : 120;
      let nextEnd = prev.baselineEndMin - cut;
      if (prev.segments.length === 0) return prev;
      const segments = prev.segments.map((seg, index) => {
        if (index !== prev.segments.length - 1) return seg;
        const startMin = hhmmToMinutes(seg.start);
        if (startMin !== null && nextEnd <= startMin) nextEnd = Math.min(startMin + 30, 24 * 60);
        return { ...seg, end: formatMinutes(nextEnd) };
      });
      return { ...prev, segments };
    });
  }

  /** 逐段更新時間。 */
  function patchSegment(key: string, field: "start" | "end", value: string) {
    setEditCell((prev) =>
      prev
        ? {
            ...prev,
            segments: prev.segments.map((seg) =>
              seg.key === key ? { ...seg, [field]: value } : seg,
            ),
          }
        : prev,
    );
  }

  function removeSegment(key: string) {
    setEditCell((prev) =>
      prev ? { ...prev, segments: prev.segments.filter((seg) => seg.key !== key) } : prev,
    );
  }

  function addSegment() {
    setEditCell((prev) => {
      if (!prev) return prev;
      const last = prev.segments[prev.segments.length - 1];
      const nextStart = last?.end ?? "17:00";
      const startMin = hhmmToMinutes(nextStart);
      const endMin = startMin === null ? null : Math.min(startMin + 5 * 60, 24 * 60);
      const fmt = (minutes: number) =>
        `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
      return {
        ...prev,
        segments: [
          ...prev.segments,
          {
            key: `seg-${Date.now()}`,
            start: nextStart,
            end: endMin === null ? "22:00" : fmt(endMin),
          },
        ],
      };
    });
  }

  /** 確認按段修改 → 整組時段送去 /api/rosters (recalculate) 重算工時／OT／補鐘。 */
  async function handleConfirmTimeEdit() {
    const target = editCell;
    const selected = rosterRef.current;
    if (!target || !selected) return;

    if (target.segments.length === 0) {
      setErrorMsg("最少要保留一段上班時間，或按「取消」。");
      return;
    }

    const parsed: { start: string; end: string; startMin: number; endMin: number }[] = [];
    for (const seg of target.segments) {
      const startMin = hhmmToMinutes(seg.start);
      const endMin = hhmmToMinutes(seg.end);
      if (startMin === null || endMin === null) {
        setErrorMsg("時間格式必須為 HH:mm（例如 07:00）。");
        return;
      }
      if (endMin <= startMin) {
        setErrorMsg(`時段 ${seg.start}-${seg.end} 落班時間必須遲過上班時間。`);
        return;
      }
      parsed.push({ start: seg.start, end: seg.end, startMin, endMin });
    }
    parsed.sort((a, b) => a.startMin - b.startMin);

    const emp =
      selected.parsed.employees.find((item) => item.name === target.employee) ?? null;
    const empDepartment = emp?.department || selected.department || "Superme Cafe";

    const keptAssignments = selected.schedule.assignments.filter(
      (item) => !(item.employee === target.employee && item.date === target.day),
    );
    const nextAssignments = [
      ...keptAssignments,
      ...parsed.map((seg) => ({
        date: target.day,
        shift: shiftFromStart(seg.startMin),
        employee: target.employee,
        department: empDepartment,
        hours: Math.round(((seg.endMin - seg.startMin) / 60) * 100) / 100,
        timeSlot: `${seg.start}-${seg.end}`,
      })),
    ];

    const nextRoster: WeekRoster = {
      ...selected,
      schedule: { ...selected.schedule, assignments: nextAssignments },
    };
    rosterRef.current = nextRoster;
    setRosters((prev) =>
      prev.map((item) => (item.id === selected.id ? nextRoster : item)),
    );
    setSelectedDay(target.day);
    setSavingCell(true);
    setErrorMsg(null);
    const summary = parsed.map((seg) => `${seg.start}-${seg.end}`).join(" + ");
    setFeedback(
      `已改 ${target.employee} ${formatDayHeader(target.day).top} 為 ${summary}，重算工時中...`,
    );

    try {
      const res = await fetch("/api/rosters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "recalculate",
          weekStart: selected.weekStart,
          department: selected.department ?? department,
          id: selected.id ?? undefined,
          parsed: selected.parsed,
          schedule: nextRoster.schedule,
        }),
      });
      const data = (await res.json()) as RecalculateResponse;
      if (!res.ok) {
        throw new Error(data.error || `重算工時失敗（HTTP ${res.status}）`);
      }
      if (data.stats) setStats(data.stats);

      const merged: WeekRoster = data.roster
        ? data.roster
        : {
            ...nextRoster,
            schedule: data.schedule ?? nextRoster.schedule,
            warnings: data.warnings ?? nextRoster.warnings,
          };

      rosterRef.current = merged;
      setRosters((prev) =>
        prev.map((item) => (item.id === merged.id ? merged : item)),
      );
      setFeedback(
        `${target.employee} ${formatDayHeader(target.day).top} ${formatDayHeader(target.day).sub} 已改為 ${summary}（${
          parsed.length
        } 段），工時、OT／補鐘已重算${
          data.persisted === false || !selected.id ? "（未寫入 Supabase）" : "並儲存"
        }。`,
      );
      setEditCell(null);
    } catch (err) {
      rosterRef.current = selected;
      setRosters((prev) =>
        prev.map((item) => (item.id === selected.id ? selected : item)),
      );
      setErrorMsg(err instanceof Error ? err.message : "重算工時時發生錯誤");
    } finally {
      setSavingCell(false);
    }
  }

  const statItems: { label: string; value: string }[] = [
    { label: "總人數", value: stats ? String(stats.totalCount) : "—" },
    { label: "FT", value: stats ? String(stats.ftCount) : "—" },
    { label: "HFT", value: stats ? String(stats.hftCount) : "—" },
    { label: "PT", value: stats ? String(stats.ptCount) : "—" },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#D6EFE8] to-[#CBE8DF] text-zinc-900 print:bg-white print:text-black">
      {/* 列印專用樣式：A4 橫向、純白省墨、隱藏操作介面 */}
      <style jsx global>{`
        @media print {
          @page {
            size: A4 landscape;
            margin: 10mm;
          }
          body {
            background: #ffffff !important;
            color: #000000 !important;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          .no-print {
            display: none !important;
          }
          .print-area {
            border: none !important;
            box-shadow: none !important;
            border-radius: 0 !important;
            padding: 0 !important;
            margin: 0 !important;
            background: #ffffff !important;
          }
          .print-table {
            min-width: 0 !important;
            width: 100% !important;
            font-size: 8px !important;
          }
          .print-table th,
          .print-table td {
            border: 1px solid #333333 !important;
            background: #ffffff !important;
            color: #000000 !important;
            padding: 2px 3px !important;
            position: static !important;
          }
          .print-module {
            break-inside: avoid;
            page-break-inside: avoid;
          }
          .print-area h2 {
            font-size: 12px !important;
          }
          .print-area h3 {
            font-size: 10px !important;
            margin-bottom: 2px !important;
          }
          .print-area > * + * {
            margin-top: 6px !important;
          }
        }
      `}</style>

      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 print:max-w-none print:p-0">
        <header className="no-print pb-5">
          <div className="flex items-start gap-3">
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              className={BTN_GHOST}
              aria-expanded={menuOpen}
            >
              ☰ 功能選單
            </button>
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
                Superme Cafe · 自動排班控制台
              </h1>
              <p className="mt-1 text-sm text-zinc-600">
                週日開週制 · 員工橫向更表、工時核算、六大時段核數及放假(WH/SH)超額提示。
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {statItems.map((item) => (
                  <span
                    key={item.label}
                    className="inline-flex items-baseline gap-1.5 rounded-full border border-[#E4DDD2] bg-[#F5F1EB] px-3 py-1 text-xs text-zinc-600"
                  >
                    <span className="font-medium">{item.label}</span>
                    <span className="font-mono text-sm font-bold text-[#167763]">
                      {item.value}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        </header>

        {menuOpen ? (
          <div className="no-print fixed inset-0 z-40 flex">
            <aside className="flex h-full w-72 max-w-[85vw] flex-col gap-2 border-r border-[#E4DDD2] bg-white p-4 shadow-xl">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold text-zinc-800">功能選單</span>
                <button
                  type="button"
                  onClick={() => setMenuOpen(false)}
                  aria-label="關閉功能選單"
                  className="rounded-md px-2 py-1 text-lg leading-none text-zinc-500 hover:bg-[#F5F1EB]"
                >
                  ✕
                </button>
              </div>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setConfigOpen(true);
                }}
                className={BTN_PRIMARY}
              >
                店舖與員工設定
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setLoadingList(true);
                  void loadRosters(selectedId);
                  void loadStats();
                }}
                disabled={loadingList}
                className={BTN_GHOST}
              >
                {loadingList ? "載入中..." : "重新整理"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  void handleGenerateFromDb();
                }}
                disabled={generatingDb}
                className={BTN_OUTLINE}
              >
                {generatingDb ? "讀取 DB 排班中..." : "由 DB 員工庫生成草稿"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  void handleGenerateMock();
                }}
                disabled={generatingMock}
                className={BTN_GHOST}
              >
                {generatingMock ? "生成中..." : "＋ Mock 草稿"}
              </button>
            </aside>
            <button
              type="button"
              aria-label="關閉功能選單"
              className="min-h-full flex-1 bg-zinc-950/40"
              onClick={() => setMenuOpen(false)}
            />
          </div>
        ) : null}

        <section className={`no-print mt-4 ${CARD} p-4 shadow-[0_10px_40px_-18px_rgba(29,138,116,0.35)]`}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="weekStart" className={LBL}>
                每週起始日（星期日）
              </label>
              <div className="relative">
                <input
                  ref={weekStartInputRef}
                  id="weekStart"
                  type="date"
                  value={weekStart}
                  onChange={(e) => handleWeekStartChange(e.target.value)}
                  onClick={openWeekStartPicker}
                  className={`${FIELD} cursor-pointer pr-10`}
                />
                <button
                  type="button"
                  onClick={openWeekStartPicker}
                  className="absolute inset-y-0 right-0 mt-1 flex w-10 items-center justify-center text-zinc-500 hover:text-[#167763]"
                  aria-label="打開月曆揀日期"
                >
                  📅
                </button>
              </div>
            </div>
            <div>
              <label htmlFor="department" className={LBL}>
                部門名稱
              </label>
              <input
                id="department"
                type="text"
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                placeholder="Superme Cafe"
                className={FIELD}
              />
            </div>
          </div>
          <div className="relative mt-3" ref={excessRef}>
            <span id="leaveExcessLabel" className={LBL}>
              放假超額提示
            </span>
            <button
              type="button"
              aria-labelledby="leaveExcessLabel"
              aria-expanded={excessOpen}
              onClick={() => setExcessOpen((open) => !open)}
              className="mt-1 flex w-full items-start justify-between gap-3 rounded-lg border border-[#E4DDD2] bg-white px-3 py-1.5 text-left text-sm transition hover:bg-[#F5F1EB]"
            >
              <span className="min-w-0">
                <span
                  className={`block ${
                    dayCoverage?.leave.excess ? "font-bold text-rose-600" : "text-zinc-500"
                  }`}
                >
                  {dayCoverage?.leave.excess
                    ? `${formatDayHeader(activeDay).top} ${formatDayHeader(activeDay).sub} 請假 ${dayCoverage.leave.salariedLeave}/${dayCoverage.leave.maxAllowedOff}，請管理員指示`
                    : coverageDays.some((day) => day.leave.excess)
                      ? "當日沒有放假超額"
                      : "本週沒有放假超額"}
                </span>
                <span className="mt-0.5 block whitespace-nowrap text-xs text-zinc-700">
                  <PeriodRatio periods={dayCoverage?.periods} />
                </span>
              </span>
              <span className="pt-1 text-xs text-zinc-500" aria-hidden>
                ▾
              </span>
            </button>
            {excessOpen ? (
              <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-[#E4DDD2] bg-white py-1 shadow-lg">
                {coverageDays.length === 0 ? (
                  <li className="px-3 py-2 text-sm text-zinc-500">本週沒有放假超額</li>
                ) : (
                  coverageDays.map((day) => {
                    const header = formatDayHeader(day.date);
                    const on = day.date === activeDay;
                    return (
                      <li key={day.date}>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedDay(day.date);
                            setExcessOpen(false);
                          }}
                          className={`block w-full px-3 py-1.5 text-left text-sm transition hover:bg-[#F5F1EB] ${
                            on ? "bg-[#E8F3F0]" : ""
                          }`}
                        >
                          <span
                            className={`block ${day.leave.excess ? "font-bold text-rose-600" : "text-zinc-500"}`}
                          >
                            {day.leave.excess
                              ? `${header.top} ${header.sub} 請假 ${day.leave.salariedLeave}/${day.leave.maxAllowedOff}，請管理員指示`
                              : `${header.top} ${header.sub} 沒有放假超額`}
                          </span>
                          <span className="mt-0.5 block whitespace-nowrap text-xs text-zinc-700">
                            <PeriodRatio periods={day.periods} />
                          </span>
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
            ) : null}
          </div>
        </section>

        {weekDays.length === 7 ? (
          <div className="no-print mt-4 grid grid-cols-7 gap-1">
            {weekDays.map((day, index) => {
              const h = formatDayHeader(day);
              const on = day === activeDay;
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => setSelectedDay(day)}
                  className={`rounded-xl border px-1 py-2 text-center text-xs font-semibold transition ${
                    on
                      ? "border-[#1D8A74] bg-[#1D8A74] text-white shadow-[0_6px_18px_-8px_rgba(29,138,116,0.9)]"
                      : "border-[#E4DDD2] bg-white text-zinc-800 hover:bg-[#F5F1EB]"
                  }`}
                >
                  <div className="text-[10px] font-normal uppercase tracking-wide opacity-70">
                    {DAY_EN[index]}
                  </div>
                  <div>{h.top}</div>
                  <div className={`font-mono text-[11px] font-normal ${on ? "text-white/80" : "text-zinc-500"}`}>
                    {h.sub}
                  </div>
                  {(() => {
                    const names =
                      coverageDays
                        .find((item) => item.date === day)
                        ?.periods.filter((period) => !period.ok)
                        .map((period) => period.shortLabel) ?? [];
                    if (names.length === 0) return null;
                    return (
                      <div
                        className={`mt-0.5 text-[10px] font-bold leading-tight ${
                          on ? "text-white" : "text-rose-600"
                        }`}
                      >
                        唔夠人 {names.join("／")}
                      </div>
                    );
                  })()}
                </button>
              );
            })}
          </div>
        ) : null}

        <details className={`no-print mt-4 ${CARD} px-4 py-2`}>
          <summary className="cursor-pointer text-sm font-medium text-zinc-700">
            報更貼上 · 支援 WhatsApp / WeChat（微信）
          </summary>
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
            支援 WhatsApp / WeChat（微信）貼上。FT/HFT 填放假日（其餘照編）、PT 填返工日（無報唔編）。
          </p>
          <div className={`mt-3 flex flex-wrap gap-1.5 rounded-lg p-1 ${PANEL}`}>
            {(
              [
                { id: "whatsapp", label: "WhatsApp 文字" },
                { id: "wechat", label: "WeChat 文字" },
                { id: "image", label: "日曆相片" },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setIntakeTab(tab.id)}
                className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  intakeTab === tab.id
                    ? "bg-[#1D8A74] text-white"
                    : "text-zinc-600 hover:text-[#167763]"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {intakeTab === "whatsapp" ? (
            <form onSubmit={(e) => void handleTextSubmit(e)} className="mt-3 space-y-2">
              <label htmlFor="availabilityText" className={LBL}>
                WhatsApp 報更文字（亦可貼 WeChat／微信）
              </label>
              <textarea
                id="availabilityText"
                rows={6}
                value={availabilityText}
                onChange={(e) => setAvailabilityText(e.target.value)}
                placeholder="貼上 WhatsApp 或 WeChat（微信）。FT/HFT 填放假日（其餘照編）、PT 填返工日（無報唔編）。"
                className={`${FIELD} mt-0 p-2.5 font-mono text-xs`}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setAvailabilityText(SAMPLE_TEXT)}
                  className="text-xs text-zinc-500 underline hover:text-[#167763]"
                >
                  填入範例 WhatsApp 文字
                </button>
                <button
                  type="submit"
                  disabled={submittingText}
                  className={BTN_PRIMARY}
                >
                  {submittingText ? "解析排班中..." : "解析 WhatsApp 生成草稿"}
                </button>
              </div>
              <p className="text-[11px] text-zinc-500">
                自動接收：<code className="rounded bg-[#F5F1EB] px-1">GET/POST /api/webhook/whatsapp</code>
                （Meta Cloud API 驗證 token + 文字訊息解析）
              </p>
            </form>
          ) : null}

          {intakeTab === "wechat" ? (
            <form onSubmit={(e) => void handleWechatSubmit(e)} className="mt-3 space-y-2">
              <label htmlFor="wechatText" className={LBL}>
                WeChat（微信）報更文字（亦可貼 WhatsApp）
              </label>
              <textarea
                id="wechatText"
                rows={6}
                value={wechatText}
                onChange={(e) => setWechatText(e.target.value)}
                placeholder="貼上 WeChat（微信）或 WhatsApp。FT/HFT 填放假日（其餘照編）、PT 填返工日（無報唔編）。"
                className={`${FIELD} mt-0 p-2.5 font-mono text-xs`}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setWechatText(SAMPLE_WECHAT_TEXT)}
                  className="text-xs text-zinc-500 underline hover:text-[#167763]"
                >
                  填入範例 WeChat 文字
                </button>
                <button
                  type="submit"
                  disabled={submittingWechat}
                  className={BTN_PRIMARY}
                >
                  {submittingWechat ? "解析排班中..." : "解析 WeChat 生成草稿"}
                </button>
              </div>
              <p className="text-[11px] text-zinc-500">
                自動接收：<code className="rounded bg-[#F5F1EB] px-1">GET/POST /api/webhook/wechat</code>
                （公眾號 URL 驗證 echostr／企業微信 msg_signature + 訊息解析）
              </p>
            </form>
          ) : null}

          {intakeTab === "image" ? (
            <form onSubmit={(e) => void handleImageSubmit(e)} className="mt-3 space-y-3">
              <p className="text-xs text-zinc-600">
                上傳手寫日曆、更期截圖或用手機即場影相。伺服器會用 Vision 讀姓名、請假日同更段。
              </p>
              <input
                ref={imageInputRef}
                id="calendarImage"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => handlePickImage(e.target.files?.[0] ?? null)}
              />
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => imageInputRef.current?.click()}
                  className={BTN_GHOST}
                >
                  拍攝或上傳日曆／更期相片
                </button>
                <button
                  type="submit"
                  disabled={submittingImage || !imageFile}
                  className={BTN_PRIMARY}
                >
                  {submittingImage ? "辨識相片中..." : "辨識相片生成草稿"}
                </button>
              </div>
              {imageFile ? (
                <p className="text-xs text-zinc-500">
                  已選：{imageFile.name}（{Math.ceil(imageFile.size / 1024)} KB）
                </p>
              ) : (
                <p className="text-xs text-zinc-400">尚未選擇相片（JPEG / PNG / WebP，最大 4 MB）</p>
              )}
              {imagePreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={imagePreview}
                  alt="已選日曆相片預覽"
                  className="max-h-56 rounded-lg border border-[#E4DDD2] object-contain"
                />
              ) : null}
            </form>
          ) : null}
        </details>

        {feedback && (
          <div className="no-print mt-4 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-900">
            {feedback}
          </div>
        )}

        {errorMsg && (
          <div className="no-print mt-4 rounded-lg border border-red-300 bg-red-50 px-4 py-2.5 text-sm text-red-900">
            {errorMsg}
          </div>
        )}

        <section className="no-print mt-5" translate="no">
          <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-sm font-semibold text-zinc-700">
              {formatDayHeader(activeDay).top} {formatDayHeader(activeDay).sub} · 當日員工 · 撳掣改更 · 改時間
            </h2>
            {savingDay ? (
              <span className="text-xs text-zinc-500">儲存中...</span>
            ) : null}
          </div>
          {!selectedRoster ? (
            <p className="mt-3 text-xs text-zinc-500">
              暫無本週更表，請開左上角「☰ 功能選單」按「＋ Mock 草稿」後再改各日。
            </p>
          ) : activeDay ? (
            <div className="mt-1">
              <ul className="grid grid-cols-1 gap-x-8 lg:grid-cols-2">
                {[
                  ...orderedEmployees.map((name) => ({ name, reserve: false })),
                  ...reserveEmployees.map((emp) => ({ name: emp.name, reserve: true })),
                ].map((row) => {
                  const dayAssignments = assignments.filter(
                    (item) => item.employee === row.name && item.date === activeDay,
                  );
                  const covered = new Set(coveredPeriodIds(dayAssignments));
                  const onLeave = leaveMap.get(row.name)?.has(activeDay) ?? false;
                  const onRest = !onLeave && covered.size === 0;
                  const leaveLabel = onLeave ? dutyCode(row.name, activeDay, "leave") : "W";
                  const restLabel = onRest ? dutyCode(row.name, activeDay, "off") : "AL";
                  return (
                    <li
                      key={row.name}
                      className={`grid grid-cols-[7.5rem_1fr] items-center gap-2 border-b py-1.5 ${ROWLINE}`}
                    >
                      <span className="truncate text-sm font-medium">
                        {row.name}
                        {row.reserve ? (
                          <span className="ml-1 text-[10px] font-normal text-zinc-400">
                            後備
                          </span>
                        ) : null}
                      </span>
                      <div className="flex items-center gap-1">
                      <div className="grid min-w-0 flex-1 grid-cols-8 gap-1">
                        {SERVICE_PERIODS.map((period) => {
                          const on = covered.has(period.id);
                          return (
                            <button
                              key={`${row.name}-${activeDay}-${period.id}`}
                              type="button"
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                void handleTogglePeriod(row.name, activeDay, period.id);
                              }}
                              className={chipClass(on)}
                            >
                              {period.shortLabel}
                            </button>
                          );
                        })}
                        <button
                          type="button"
                          title={onLeave ? `第${leaveLabel.slice(1)}天假` : "請假"}
                          onClick={() => void handleApplyDuty(row.name, activeDay, "leave")}
                          className={chipClass(onLeave, "leave")}
                        >
                          {leaveLabel}
                        </button>
                        <button
                          type="button"
                          title={onRest ? `第${restLabel.slice(2)}天` : "休息"}
                          onClick={() => void handleApplyDuty(row.name, activeDay, "OFF")}
                          className={chipClass(onRest, "off")}
                        >
                          {restLabel}
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => openTimeEditor(row.name, activeDay)}
                        className="h-7 shrink-0 whitespace-nowrap rounded-md border border-[#1D8A74] bg-white px-2 text-[10px] font-medium text-[#167763] hover:bg-[#E8F3F0]"
                      >
                        改時間
                      </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </section>

        {!selectedRoster ? (
          <p className="mt-5 text-xs text-zinc-600">
            暫無本週更表，請開左上角「☰ 功能選單」按「＋ Mock 草稿」後再睇週更表。
          </p>
        ) : null}

        {selectedRoster ? (
          <section className="print-area mt-4 space-y-5 rounded-3xl border border-[#E4DDD2] bg-white p-5 shadow-[0_10px_40px_-12px_rgba(29,138,116,0.25)]">
            <div className="flex flex-col justify-between gap-3 border-b border-[#E4DDD2] pb-4 sm:flex-row sm:items-center print:border-black print:pb-2">
              <div>
                <div className="flex items-center gap-2.5">
                  <h2 className="text-lg font-bold">
                    {selectedRoster.department || "部門更表"} · {selectedRoster.isoWeek}（週日{" "}
                    {selectedRoster.weekStart} 至 週六 {weekEndDate(selectedRoster.weekStart)}）
                  </h2>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-semibold print:border print:border-black print:bg-white print:text-black ${
                      selectedRoster.status === "approved"
                        ? "bg-[#E8F3F0] text-[#167763]"
                        : "bg-[#F5F1EB] text-amber-800"
                    }`}
                  >
                    {selectedRoster.status === "approved" ? "已批准" : "草稿 (DRAFT)"}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-zinc-500 print:text-black">
                  共 {orderedEmployees.length} 位員工 · 列印時間：{new Date().toLocaleDateString("zh-HK")}
                </p>
              </div>

              <div className="no-print flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => window.print()}
                  className={BTN_GHOST}
                >
                  🖨️ 列印 / 匯出 PDF 更表
                </button>
                <button
                  type="button"
                  disabled={
                    !selectedRoster.id ||
                    selectedRoster.status === "approved" ||
                    approvingId === selectedRoster.id
                  }
                  onClick={() => void handleApprove(selectedRoster.id)}
                  className={BTN_PRIMARY}
                >
                  {selectedRoster.status === "approved"
                    ? "已批准"
                    : approvingId === selectedRoster.id
                    ? "批准中..."
                    : "批准此更表"}
                </button>
              </div>
            </div>

            {/* 列印積木勾選 */}
            <div className={`no-print ${CARD} ${PANEL} p-3`}>
              <p className="text-xs font-semibold text-zinc-700">列印積木</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-[#E4DDD2] bg-white px-2.5 py-1.5 text-xs text-zinc-700 transition hover:bg-[#E8F3F0]">
                  <input
                    type="checkbox"
                    className={CHK}
                    checked={printWeekGrid}
                    onChange={(e) => setPrintWeekGrid(e.target.checked)}
                  />
                  員工週更總表
                </label>
                <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-[#E4DDD2] bg-white px-2.5 py-1.5 text-xs text-zinc-700 transition hover:bg-[#E8F3F0]">
                  <input
                    type="checkbox"
                    className={CHK}
                    checked={printPeriodGrid}
                    onChange={(e) => setPrintPeriodGrid(e.target.checked)}
                  />
                  每日六大時段人手安排表
                </label>
              </div>
              <p className="mt-1.5 text-[11px] text-zinc-400">
                只印已勾選的積木。兩樣都勾時，A4 橫向緊湊排在同一頁。
              </p>
            </div>

            {/* 橫向一覽排更表（螢幕可撳格仔改時間、列印出全日週） */}
            <div>
              <div className="no-print mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">員工週更總表（唯讀總覽）</h3>
                <span className="text-xs text-zinc-500">Sun → Sat 由左至右 · 改時間請用上方當日列</span>
              </div>

              {weekDays.length === 0 || orderedEmployees.length === 0 ? (
                <p className="py-6 text-center text-xs text-zinc-500">
                  暫無可顯示的員工排班資料。
                </p>
              ) : (
                <>
                <div className="no-print overflow-x-auto rounded-xl border border-[#E4DDD2]">
                  <table className="w-full min-w-[920px] border-collapse text-xs">
                    <thead>
                      <tr className={`border-b border-[#E4DDD2] ${PANEL} text-zinc-800`}>
                        <th className="sticky left-0 z-10 w-32 border-r border-[#E4DDD2] bg-[#F5F1EB] px-3 py-2.5 text-left font-bold">
                          姓名
                        </th>
                        <th
                          colSpan={2}
                          className="border-r border-[#E4DDD2] bg-[#F5F1EB] px-2 py-2.5 text-center font-bold"
                        >
                          職位
                        </th>
                        {weekDays.map((day) => {
                          const h = formatDayHeader(day);
                          const isActive = day === activeDay;
                          return (
                            <th
                              key={day}
                              className={`border-r border-[#E4DDD2] px-2 py-2 text-center font-semibold ${
                                isActive ? "bg-[#E8F3F0] text-[#167763]" : "bg-[#F5F1EB]"
                              }`}
                            >
                              <div>{h.top}</div>
                              <div className="font-mono text-[11px] font-normal text-zinc-500">
                                {h.sub}
                              </div>
                            </th>
                          );
                        })}
                        <th className="w-20 bg-[#F5F1EB] px-2 py-2 text-center font-bold">
                          本週工時
                        </th>
                        <th className="w-16 bg-[#F5F1EB] px-2 py-2 text-center font-bold">
                          上班日數
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {orderedEmployees.map((emp) => {
                        const weekHours = weekHoursFor(emp);
                        const over60 = weekHours > 60;
                        const parts = roleParts(employeeByName.get(emp), empMeta.get(emp));
                        return (
                          <tr key={emp} className={`border-b ${ROWLINE} hover:bg-[#FBF8F3]`}>
                            <td className="sticky left-0 z-10 border-r border-[#E4DDD2] bg-white px-3 py-2 font-semibold text-zinc-900">
                              {emp}
                            </td>
                            <td className="border-r border-[#EFE9E0] px-2 py-2 text-center font-mono text-[11px] text-zinc-700">
                              {parts.rank || "—"}
                            </td>
                            <td className="border-r border-[#E4DDD2] px-2 py-2 text-center font-mono text-[11px] text-zinc-700">
                              {parts.kind}
                            </td>
                            {weekDays.map((day) => {
                              const cell = getCellDisplay(emp, day);
                              const isActive = day === activeDay;
                              return (
                                <td
                                  key={day}
                                  className={`border-r border-[#EFE9E0] px-1.5 py-1.5 text-center ${
                                    isActive ? "bg-[#E8F3F0]/60" : ""
                                  }`}
                                >
                                  {cell.kind === "work" ? (
                                    <div className="flex w-full flex-col items-center px-1 py-0.5">
                                      <span className="font-mono text-[11px] font-medium text-zinc-800">
                                        {cell.label}
                                      </span>
                                      {cell.sub ? (
                                        <span className="font-mono text-[9px] text-zinc-500">
                                          {cell.sub}
                                        </span>
                                      ) : null}
                                    </div>
                                  ) : cell.kind === "leave" ? (
                                    <span
                                      className="text-[11px] font-medium text-rose-700 print:font-bold print:text-black"
                                      title={`第${cell.label.slice(1)}天假`}
                                    >
                                      {cell.label}
                                    </span>
                                  ) : (
                                    <span
                                      className="text-[11px] text-zinc-400 print:text-zinc-500"
                                      title={`第${cell.label.slice(2)}天`}
                                    >
                                      {cell.label}
                                    </span>
                                  )}
                                </td>
                              );
                            })}
                            <td
                              className={`px-2 py-2 text-center font-mono font-semibold ${
                                over60
                                  ? "bg-red-50 text-red-700"
                                  : "text-zinc-800"
                              }`}
                            >
                              {formatHours(weekHours)}
                            </td>
                            <td className="px-2 py-2 text-center font-mono text-zinc-700">
                              {workDayCount(emp)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      {hourSummaryRows.map((row) => (
                        <tr
                          key={row.key}
                          className="border-t border-[#E4DDD2] bg-[#F5F1EB] font-semibold"
                        >
                          <td
                            colSpan={3}
                            className="sticky left-0 z-10 border-r border-[#E4DDD2] bg-[#F5F1EB] px-3 py-1.5 text-left"
                          >
                            {row.label}
                          </td>
                          {row.values.map((hours, index) => (
                            <td
                              key={weekDays[index]}
                              className="border-r border-[#EFE9E0] px-1 py-1.5 text-center font-mono text-[11px]"
                            >
                              {formatHours(hours)}
                            </td>
                          ))}
                          <td className="px-2 py-1.5 text-center font-mono text-[11px]">
                            {formatHours(row.values.reduce((sum, hours) => sum + hours, 0))}
                          </td>
                          <td className="px-2 py-1.5 text-center text-zinc-400">—</td>
                        </tr>
                      ))}
                    </tfoot>
                  </table>
                </div>
                <div className={`print-module hidden overflow-x-auto print:overflow-visible ${printWeekGrid ? "print:block" : ""}`}>
                  <table className="print-table w-full border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-black">
                        <th className="px-3 py-2.5 text-left font-bold">姓名</th>
                        <th colSpan={2} className="px-2 py-2.5 text-center font-bold">職位</th>
                        {weekDays.map((day) => {
                          const h = formatDayHeader(day);
                          return (
                            <th key={day} className="px-2 py-2 text-center font-semibold">
                              <div>{h.top}</div>
                              <div className="font-mono text-[11px] font-normal">{h.sub}</div>
                            </th>
                          );
                        })}
                        <th className="px-2 py-2 text-center font-bold">本週工時</th>
                        <th className="px-2 py-2 text-center font-bold">上班日數</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orderedEmployees.map((emp) => {
                        const parts = roleParts(employeeByName.get(emp), empMeta.get(emp));
                        return (
                          <tr key={`print-${emp}`} className="border-b border-[#999999]">
                            <td className="px-3 py-2 font-semibold">{emp}</td>
                            <td className="px-2 py-2 text-center font-mono">{parts.rank || "—"}</td>
                            <td className="px-2 py-2 text-center font-mono">{parts.kind}</td>
                            {weekDays.map((day) => {
                              const cell = getCellDisplay(emp, day);
                              return (
                                <td key={day} className="px-1.5 py-1.5 text-center">
                                  <div className="font-mono text-[11px]">{cell.label}</div>
                                </td>
                              );
                            })}
                            <td className="px-2 py-2 text-center font-mono font-semibold">
                              {formatHours(weekHoursFor(emp))}
                            </td>
                            <td className="px-2 py-2 text-center font-mono">{workDayCount(emp)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      {hourSummaryRows.map((row) => (
                        <tr key={`print-${row.key}`} className="border-t border-black font-semibold">
                          <td colSpan={3} className="px-3 py-1.5">{row.label}</td>
                          {row.values.map((hours, index) => (
                            <td key={weekDays[index]} className="px-1 py-1.5 text-center font-mono">
                              {formatHours(hours)}
                            </td>
                          ))}
                          <td className="px-2 py-1.5 text-center font-mono">
                            {formatHours(row.values.reduce((sum, hours) => sum + hours, 0))}
                          </td>
                          <td className="px-2 py-1.5 text-center">—</td>
                        </tr>
                      ))}
                    </tfoot>
                  </table>
                </div>
                </>
              )}
            </div>

            {printPeriodGrid ? (
              <div className="print-module">
                <h3 className="mb-2 text-sm font-semibold">每日六大時段人手安排表</h3>
                <div className="overflow-x-auto rounded-xl border border-[#E4DDD2] print:overflow-visible print:rounded-none print:border-black">
                  <table className="print-table w-full min-w-[640px] border-collapse text-xs">
                    <thead>
                      <tr className={`border-b border-[#E4DDD2] ${PANEL} text-zinc-700`}>
                        <th className={`${TH} text-left`}>時段</th>
                        {weekDays.map((day, index) => (
                          <th key={day} className={TH}>
                            {(DAY_EN[index] ?? "").toUpperCase()}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {SERVICE_PERIODS.map((period) => (
                        <tr key={period.id} className={`border-b ${ROWLINE}`}>
                          <td className="px-2 py-1.5 text-left font-medium">{period.shortLabel}</td>
                          {weekDays.map((day) => {
                            const cell = coverageDays
                              .find((item) => item.date === day)
                              ?.periods.find((item) => item.id === period.id);
                            const short = cell ? !cell.ok : false;
                            return (
                              <td
                                key={day}
                                className={`px-1 py-1.5 text-center font-mono ${short ? "font-bold text-rose-600 print:text-black" : ""}`}
                              >
                                {cell ? `${cell.actual}/${cell.required}` : "—"}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            <div className="no-print">
              <h3 className="text-sm font-semibold">後補名單（{reserveEmployees.length} 人）</h3>
              {reserveEmployees.length === 0 ? (
                <p className="mt-1.5 text-xs text-zinc-500">暫無後補員工。</p>
              ) : (
                <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {reserveEmployees.map((emp) => (
                    <li
                      key={emp.name}
                      className="rounded-lg border border-[#E4DDD2] bg-white px-3 py-2 text-sm"
                    >
                      <span className="font-medium">{emp.name}</span>
                      {emp.phone ? (
                        <span className="ml-2 font-mono text-xs text-zinc-500">{emp.phone}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        ) : null}

      </div>

      {/* 手改時間面板 */}
      {editCell ? (
        <div className="no-print fixed inset-0 z-50 flex items-center justify-center px-4">
          <div
            className="absolute inset-0 bg-zinc-950/40 backdrop-blur-[1px]"
            onClick={() => (savingCell ? null : setEditCell(null))}
            aria-hidden
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="修改上班時間"
            className="relative w-full max-w-md rounded-2xl border border-[#E4DDD2] bg-white p-5 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-zinc-900">修改上班時間</h3>
                <p className="mt-0.5 truncate text-xs text-zinc-500">
                  {editCell.employee} · {formatDayHeader(editCell.day).top}{" "}
                  {formatDayHeader(editCell.day).sub}
                </p>
              </div>
              <button
                type="button"
                onClick={() => (savingCell ? null : setEditCell(null))}
                aria-label="關閉"
                className="rounded-md px-2 py-1 text-lg leading-none text-zinc-500 transition hover:bg-[#F5F1EB]"
              >
                ✕
              </button>
            </div>

            <p className={`mt-3 rounded-lg px-3 py-2 text-[11px] text-zinc-600 ${PANEL}`}>
              連續時段已合併成上班至落班；中間有空隙先分兩段。確認後送{" "}
              <code className="font-mono">/api/rosters</code>（
              <code className="font-mono">action: recalculate</code>）重算當日工時、本週工時同每日總工時。
            </p>

            <div className="mt-3 flex flex-wrap gap-1.5">
              <button type="button" onClick={() => applyTimeShortcut("early1")} className={BTN_GHOST}>
                早收 1h
              </button>
              <button type="button" onClick={() => applyTimeShortcut("early2")} className={BTN_GHOST}>
                早收 2h
              </button>
              <button type="button" onClick={() => applyTimeShortcut("half")} className={BTN_GHOST}>
                半日更
              </button>
            </div>

            <div className="mt-3">
              <div className="flex items-center justify-between">
                <span className={LBL}>當日時段（{editCell.segments.length} 段）</span>
                <button
                  type="button"
                  onClick={addSegment}
                  className="rounded-md border border-[#1D8A74] bg-white px-2.5 py-1 text-xs font-medium text-[#167763] transition hover:bg-[#E8F3F0]"
                >
                  ＋ 新增時段
                </button>
              </div>

              <div className="mt-2 max-h-72 space-y-2 overflow-y-auto pr-0.5">
                {editCell.segments.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-[#E4DDD2] px-3 py-3 text-center text-xs text-zinc-500">
                    已移除全部時段，請按「＋ 新增時段」或取消。
                  </p>
                ) : (
                  editCell.segments.map((seg, index) => (
                    <div
                      key={seg.key}
                      className="rounded-lg border border-[#E4DDD2] bg-[#F5F1EB]/60 p-2"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-semibold text-zinc-600">
                          第 {index + 1} 段
                        </span>
                        <button
                          type="button"
                          onClick={() => removeSegment(seg.key)}
                          className="rounded-md px-1.5 py-0.5 text-[11px] font-medium text-rose-600 transition hover:bg-rose-50"
                        >
                          移除
                        </button>
                      </div>
                      <div className="mt-1.5 grid grid-cols-2 gap-2">
                        <label className="block">
                          <span className={LBL}>上班</span>
                          <input
                            type="time"
                            value={seg.start}
                            onChange={(e) => patchSegment(seg.key, "start", e.target.value)}
                            className={FIELD}
                          />
                        </label>
                        <label className="block">
                          <span className={LBL}>落班</span>
                          <input
                            type="time"
                            value={seg.end}
                            onChange={(e) => patchSegment(seg.key, "end", e.target.value)}
                            className={FIELD}
                          />
                        </label>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditCell(null)}
                disabled={savingCell}
                className={BTN_GHOST}
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmTimeEdit()}
                disabled={savingCell}
                className={BTN_PRIMARY}
              >
                {savingCell ? "重算中..." : "確認並重算"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <ConfigDrawer
        open={configOpen}
        onClose={() => setConfigOpen(false)}
        onSaved={() => {
          void loadRosters(selectedId);
          void loadStats();
          setFeedback("店舖／員工設定已儲存，已同步重新載入更表與人數。");
        }}
      />
    </div>
  );
}
