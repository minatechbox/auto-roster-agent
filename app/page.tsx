"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  type EmployeeAvailability,
  type RosterWarning,
  type WeekRoster,
  type WorkingShift,
} from "@/lib/types";
import {
  SERVICE_PERIODS,
  STAFF_CONFIG,
  coveredPeriodIds,
  formatAssignmentTimeLabel,
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

const CHIP_SIZE =
  "inline-flex h-7 w-full items-center justify-center rounded px-0.5 text-[10px] font-medium leading-none";

function chipClass(on: boolean, tone: "work" | "leave" | "off" = "work"): string {
  if (on && tone === "leave") return `${CHIP_SIZE} bg-rose-600 text-white`;
  if (on && tone === "off") return `${CHIP_SIZE} bg-zinc-700 text-white`;
  if (on) return `${CHIP_SIZE} bg-indigo-600 text-white`;
  return `${CHIP_SIZE} bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700`;
}

const DEMO_RANK: Record<string, string> = {
  "Jamie Cole": "SM",
  "Noah Blake": "M",
  "Casey Quinn": "AM",
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

function roleParts(emp: EmployeeAvailability | undefined): { rank: string; kind: string } {
  return {
    rank: DEMO_RANK[emp?.name ?? ""] ?? "S",
    kind: emp && resolveCategory(emp) === "part_time" ? "P.T" : "F.T",
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
      if (!cancelled) void loadRosters();
    });
    return () => {
      cancelled = true;
    };
  }, [loadRosters]);

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
      setFeedback(
        data.persisted
          ? `已按示範條件生成草稿（10 位正選、4 位後補，ID: ${createdId ?? "—"}）`
          : "已按示範條件生成草稿，但未持久化至 Supabase"
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
  const employeeHours = selectedRoster?.schedule?.employeeHours ?? [];
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

  const empHoursMap = new Map<string, { totalHours: number; shiftsCount: number }>();
  for (const eh of employeeHours) {
    empHoursMap.set(eh.employee, {
      totalHours: eh.totalHours,
      shiftsCount: eh.shiftsCount,
    });
  }

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
    const selectedRoster = rosterRef.current;
    if (!selectedRoster) return;

    const existing =
      selectedRoster.parsed.employees.find((e) => e.name === employeeName) ??
      ({
        name: employeeName,
        department: selectedRoster.department || "Superme Cafe",
        leave: [],
        available: {},
      } satisfies EmployeeAvailability);

    const employees = selectedRoster.parsed.employees.some((e) => e.name === employeeName)
      ? selectedRoster.parsed.employees.map((e) => {
          if (e.name !== employeeName) {
            return { ...e, leave: [...(e.leave ?? [])] };
          }
          const leave = (e.leave ?? []).filter((d) => d !== day);
          if (duty === "leave") leave.push(day);
          return { ...e, leave };
        })
      : [
          ...selectedRoster.parsed.employees.map((e) => ({
            ...e,
            leave: [...(e.leave ?? [])],
          })),
          {
            ...existing,
            leave: duty === "leave" ? [day] : [...(existing.leave ?? [])].filter((d) => d !== day),
          },
        ];

    const nextEmp = employees.find((e) => e.name === employeeName) ?? existing;
    let nextAssignments = selectedRoster.schedule.assignments.filter(
      (a) => !(a.employee === employeeName && a.date === day),
    );
    if (duty === "AM" || duty === "PM" || duty === "EVE") {
      nextAssignments = [
        ...nextAssignments,
        {
          date: day,
          shift: duty,
          employee: employeeName,
          department: nextEmp.department || selectedRoster.department || "Superme Cafe",
          hours: hoursForEmployeeShift(nextEmp),
          timeSlot: slotForEmployee(nextEmp, duty),
        },
      ];
    }

    const scheduleDays = weekDays.length === 7 ? weekDays : selectedRoster.schedule.days;
    const employeeNames = [...new Set(employees.map((e) => e.name))];
    const { dailyHours: nextDaily, employeeHours: nextEmpHours } = summarizeSchedule(
      scheduleDays,
      nextAssignments,
      employeeNames,
    );
    const nextWarnings = [
      ...(selectedRoster.warnings ?? []).filter(isIntakeNote),
      ...evaluateRosterWarnings(scheduleDays, employees, nextAssignments),
    ];

    const nextRoster: WeekRoster = {
      ...selectedRoster,
      parsed: { employees },
      schedule: {
        ...selectedRoster.schedule,
        days: scheduleDays,
        assignments: nextAssignments,
        dailyHours: nextDaily,
        employeeHours: nextEmpHours,
      },
      warnings: nextWarnings,
    };

    const rosterId = selectedRoster.id;
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
    const selectedRoster = rosterRef.current;
    if (!selectedRoster) return;

    const existing =
      selectedRoster.parsed.employees.find((e) => e.name === employeeName) ??
      ({
        name: employeeName,
        department: selectedRoster.department || "Superme Cafe",
        leave: [],
        available: {},
      } satisfies EmployeeAvailability);

    const dayAssignments = selectedRoster.schedule.assignments.filter(
      (item) => item.employee === employeeName && item.date === day,
    );
    const covered = new Set(coveredPeriodIds(dayAssignments));
    if (covered.has(periodId)) {
      covered.delete(periodId);
    } else {
      covered.add(periodId);
    }

    const employees = selectedRoster.parsed.employees.some((e) => e.name === employeeName)
      ? selectedRoster.parsed.employees.map((e) => {
          if (e.name !== employeeName) {
            return { ...e, leave: [...(e.leave ?? [])] };
          }
          const leave = (e.leave ?? []).filter((d) => d !== day);
          return { ...e, leave };
        })
      : [
          ...selectedRoster.parsed.employees.map((e) => ({
            ...e,
            leave: [...(e.leave ?? [])],
          })),
          { ...existing, leave: [...(existing.leave ?? [])].filter((d) => d !== day) },
        ];

    const nextEmp = employees.find((e) => e.name === employeeName) ?? existing;
    let nextAssignments = selectedRoster.schedule.assignments.filter(
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
          department: nextEmp.department || selectedRoster.department || "Superme Cafe",
          hours: periodDurationHours(period),
          timeSlot: periodTimeSlot(period),
        },
      ];
    }

    const scheduleDays = weekDays.length === 7 ? weekDays : selectedRoster.schedule.days;
    const employeeNames = [...new Set(employees.map((e) => e.name))];
    const { dailyHours: nextDaily, employeeHours: nextEmpHours } = summarizeSchedule(
      scheduleDays,
      nextAssignments,
      employeeNames,
    );
    const nextWarnings = [
      ...(selectedRoster.warnings ?? []).filter(isIntakeNote),
      ...evaluateRosterWarnings(scheduleDays, employees, nextAssignments),
    ];

    const nextRoster: WeekRoster = {
      ...selectedRoster,
      parsed: { employees },
      schedule: {
        ...selectedRoster.schedule,
        days: scheduleDays,
        assignments: nextAssignments,
        dailyHours: nextDaily,
        employeeHours: nextEmpHours,
      },
      warnings: nextWarnings,
    };

    const rosterId = selectedRoster.id;
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
        sub: totalH > 0 ? `${totalH}h` : undefined,
        kind: "work",
      };
    }
    if (leaveMap.get(employee)?.has(day)) {
      return { label: dutyCode(employee, day, "leave"), kind: "leave" };
    }
    return { label: dutyCode(employee, day, "off"), kind: "off" };
  }

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100 print:bg-white print:text-black">
      {/* 列印專用樣式：A4 橫向、隱藏操作介面、黑框白底清晰字體 */}
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
            padding: 0 !important;
            margin: 0 !important;
            background: #ffffff !important;
          }
          .print-table {
            min-width: 100% !important;
            width: 100% !important;
            font-size: 10px !important;
          }
          .print-table th,
          .print-table td {
            border: 1px solid #333333 !important;
            padding: 4px 6px !important;
            position: static !important;
          }
        }
      `}</style>

      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 print:max-w-none print:p-0">
        <header className="no-print flex flex-col gap-4 border-b border-zinc-200 pb-5 dark:border-zinc-800 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Superme Cafe · 自動排班控制台
            </h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              週日開週制 · 員工橫向更表、工時核算、六大時段核數（開檔／早餐／午市／下午茶／晚市／收檔）及放假(WH/SH)超額提示。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => {
                setLoadingList(true);
                void loadRosters(selectedId);
              }}
              disabled={loadingList}
              className="rounded-lg border border-zinc-300 bg-white px-3.5 py-2 text-sm font-medium text-zinc-800 transition hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              {loadingList ? "載入中..." : "重新整理"}
            </button>
            <button
              type="button"
              onClick={() => void handleGenerateFromDb()}
              disabled={generatingDb}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-50"
            >
              {generatingDb ? "讀取 DB 排班中..." : "由 DB 員工庫生成草稿"}
            </button>
            <button
              type="button"
              onClick={() => void handleGenerateMock()}
              disabled={generatingMock}
              className="rounded-lg bg-zinc-900 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              {generatingMock ? "生成中..." : "+ Mock 草稿"}
            </button>
          </div>
        </header>

        <section className="no-print mt-4 rounded-xl border border-zinc-200 bg-white p-4 shadow-xs dark:border-zinc-800 dark:bg-zinc-900">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="weekStart"
                className="block text-xs font-medium text-zinc-600 dark:text-zinc-400"
              >
                每週起始日（星期日）
              </label>
              <div className="relative mt-1">
                <input
                  ref={weekStartInputRef}
                  id="weekStart"
                  type="date"
                  value={weekStart}
                  onChange={(e) => handleWeekStartChange(e.target.value)}
                  onClick={openWeekStartPicker}
                  className="w-full cursor-pointer rounded-lg border border-zinc-300 bg-white px-3 py-1.5 pr-10 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                />
                <button
                  type="button"
                  onClick={openWeekStartPicker}
                  className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                  aria-label="打開月曆揀日期"
                >
                  📅
                </button>
              </div>
            </div>
            <div>
              <label
                htmlFor="department"
                className="block text-xs font-medium text-zinc-600 dark:text-zinc-400"
              >
                部門名稱
              </label>
              <input
                id="department"
                type="text"
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                placeholder="Superme Cafe"
                className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
            </div>
          </div>
          <div className="relative mt-3" ref={excessRef}>
            <span
              id="leaveExcessLabel"
              className="block text-xs font-medium text-zinc-600 dark:text-zinc-400"
            >
              放假超額提示
            </span>
            <button
              type="button"
              aria-labelledby="leaveExcessLabel"
              aria-expanded={excessOpen}
              onClick={() => setExcessOpen((open) => !open)}
              className="mt-1 flex w-full items-start justify-between gap-3 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-left text-sm dark:border-zinc-700 dark:bg-zinc-950"
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
                <span className="mt-0.5 block whitespace-nowrap text-xs text-zinc-700 dark:text-zinc-200">
                  <PeriodRatio periods={dayCoverage?.periods} />
                </span>
              </span>
              <span className="pt-1 text-xs text-zinc-500" aria-hidden>
                ▾
              </span>
            </button>
            {excessOpen ? (
              <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-zinc-300 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-950">
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
                          className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                            on ? "bg-indigo-50 dark:bg-indigo-950/40" : ""
                          }`}
                        >
                          <span
                            className={`block ${day.leave.excess ? "font-bold text-rose-600" : "text-zinc-500"}`}
                          >
                            {day.leave.excess
                              ? `${header.top} ${header.sub} 請假 ${day.leave.salariedLeave}/${day.leave.maxAllowedOff}，請管理員指示`
                              : `${header.top} ${header.sub} 沒有放假超額`}
                          </span>
                          <span className="mt-0.5 block whitespace-nowrap text-xs text-zinc-700 dark:text-zinc-200">
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
            {weekDays.map((day) => {
              const h = formatDayHeader(day);
              const on = day === activeDay;
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => setSelectedDay(day)}
                  className={`rounded-lg border px-1 py-2 text-center text-xs font-semibold ${
                    on
                      ? "border-indigo-600 bg-indigo-50 text-indigo-950 dark:bg-indigo-950/40 dark:text-indigo-100"
                      : "border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                  }`}
                >
                  <div>{h.top}</div>
                  <div className={`font-mono text-[11px] font-normal ${on ? "text-indigo-700 dark:text-indigo-200" : "text-zinc-500"}`}>
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
                      <div className="mt-0.5 text-[10px] font-bold leading-tight text-rose-600">
                        唔夠人 {names.join("／")}
                      </div>
                    );
                  })()}
                </button>
              );
            })}
          </div>
        ) : null}

        <details className="no-print mt-4 rounded-xl border border-zinc-200 bg-white px-4 py-2 shadow-xs dark:border-zinc-800 dark:bg-zinc-900">
          <summary className="cursor-pointer text-sm font-medium text-zinc-700 dark:text-zinc-200">
            收更資料 · WhatsApp／WeChat／相片
          </summary>
          <div className="mt-3 flex flex-wrap gap-1.5 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800">
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
                    ? "bg-white text-zinc-900 shadow-xs dark:bg-zinc-950 dark:text-zinc-100"
                    : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {intakeTab === "whatsapp" ? (
            <form onSubmit={(e) => void handleTextSubmit(e)} className="mt-3 space-y-2">
              <label htmlFor="availabilityText" className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                貼上 WhatsApp 群組覆期文字
              </label>
              <textarea
                id="availabilityText"
                rows={6}
                value={availabilityText}
                onChange={(e) => setAvailabilityText(e.target.value)}
                placeholder="貼上 WhatsApp 群組員工覆期、請假日期..."
                className="w-full rounded-lg border border-zinc-300 bg-white p-2.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setAvailabilityText(SAMPLE_TEXT)}
                  className="text-xs text-zinc-500 underline hover:text-zinc-800"
                >
                  填入範例 WhatsApp 文字
                </button>
                <button
                  type="submit"
                  disabled={submittingText}
                  className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
                >
                  {submittingText ? "解析排班中..." : "解析 WhatsApp 生成草稿"}
                </button>
              </div>
              <p className="text-[11px] text-zinc-500">
                自動接收：<code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">GET/POST /api/webhook/whatsapp</code>
                （Meta Cloud API 驗證 token + 文字訊息解析）
              </p>
            </form>
          ) : null}

          {intakeTab === "wechat" ? (
            <form onSubmit={(e) => void handleWechatSubmit(e)} className="mt-3 space-y-2">
              <label htmlFor="wechatText" className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                貼上 WeChat 群組／私訊對話紀錄
              </label>
              <textarea
                id="wechatText"
                rows={6}
                value={wechatText}
                onChange={(e) => setWechatText(e.target.value)}
                placeholder="貼上微信群或私訊報更紀錄..."
                className="w-full rounded-lg border border-zinc-300 bg-white p-2.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setWechatText(SAMPLE_WECHAT_TEXT)}
                  className="text-xs text-zinc-500 underline hover:text-zinc-800"
                >
                  填入範例 WeChat 文字
                </button>
                <button
                  type="submit"
                  disabled={submittingWechat}
                  className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:opacity-50"
                >
                  {submittingWechat ? "解析排班中..." : "解析 WeChat 生成草稿"}
                </button>
              </div>
              <p className="text-[11px] text-zinc-500">
                自動接收：<code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">GET/POST /api/webhook/wechat</code>
                （公眾號 URL 驗證 echostr／企業微信 msg_signature + 訊息解析）
              </p>
            </form>
          ) : null}

          {intakeTab === "image" ? (
            <form onSubmit={(e) => void handleImageSubmit(e)} className="mt-3 space-y-3">
              <p className="text-xs text-zinc-600 dark:text-zinc-400">
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
                  className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
                >
                  拍攝或上傳日曆／更期相片
                </button>
                <button
                  type="submit"
                  disabled={submittingImage || !imageFile}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-50"
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
                  className="max-h-56 rounded-lg border border-zinc-200 object-contain dark:border-zinc-700"
                />
              ) : null}
            </form>
          ) : null}
        </details>

        {feedback && (
          <div className="no-print mt-4 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200">
            {feedback}
          </div>
        )}

        {errorMsg && (
          <div className="no-print mt-4 rounded-lg border border-red-300 bg-red-50 px-4 py-2.5 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/60 dark:text-red-200">
            {errorMsg}
          </div>
        )}


        <section className="no-print mt-5" translate="no">
          <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
              {formatDayHeader(activeDay).top} {formatDayHeader(activeDay).sub} · 當日員工 · 撳掣改更
            </h2>
            {savingDay ? (
              <span className="text-xs text-zinc-500">儲存中...</span>
            ) : null}
          </div>
              {!selectedRoster ? (
                <p className="mt-3 text-xs text-zinc-500">
                  暫無本週更表，請按右上角「+ Mock 草稿」後再改各日。
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
                          className="grid grid-cols-[7.5rem_1fr] items-center gap-2 border-b border-zinc-100 py-1.5 dark:border-zinc-800"
                        >
                          <span className="truncate text-sm font-medium">
                            {row.name}
                            {row.reserve ? (
                              <span className="ml-1 text-[10px] font-normal text-zinc-400">
                                後備
                              </span>
                            ) : null}
                          </span>
                          <div className="grid grid-cols-8 gap-1">
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
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}
        </section>

        {/* 主更表 Matrix 視圖（列印時保留呢一區） */}
        {!selectedRoster ? (
          <p className="mt-5 text-xs text-zinc-500">
            暫無本週更表，請按右上角「+ Mock 草稿」後再睇週更表。
          </p>
        ) : null}

        {selectedRoster ? (
          <section className="print-area mt-4 space-y-5 rounded-xl border border-zinc-200 bg-white p-5 shadow-xs dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex flex-col justify-between gap-3 border-b border-zinc-200 pb-4 dark:border-zinc-800 sm:flex-row sm:items-center print:border-black print:pb-2">
              <div>
                <div className="flex items-center gap-2.5">
                  <h2 className="text-lg font-bold">
                    {selectedRoster.department || "部門更表"} · {selectedRoster.isoWeek}（週日{" "}
                    {selectedRoster.weekStart} 至 週六 {weekEndDate(selectedRoster.weekStart)}）
                  </h2>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-semibold print:border print:border-black print:bg-white print:text-black ${
                      selectedRoster.status === "approved"
                        ? "bg-emerald-100 text-emerald-800"
                        : "bg-amber-100 text-amber-800"
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
                  className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-800 transition hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
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
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {selectedRoster.status === "approved"
                    ? "已批准"
                    : approvingId === selectedRoster.id
                    ? "批准中..."
                    : "批准此更表"}
                </button>
              </div>
            </div>

            {/* 橫向一覽排更表（螢幕只睇一日，列印先出全日週） */}
            <div>
              <div className="no-print mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">員工週更表（一目了然）</h3>
                <span className="text-xs text-zinc-500">只供睇，無掣</span>
              </div>

              {weekDays.length === 0 || orderedEmployees.length === 0 ? (
                <p className="py-6 text-center text-xs text-zinc-500">
                  暫無可顯示的員工排班資料。
                </p>
              ) : (
                <>
                <div className="no-print overflow-x-auto rounded-lg border border-zinc-300 dark:border-zinc-700">
                  <table className="pointer-events-none w-full min-w-[920px] border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-zinc-300 bg-zinc-100 text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 print:bg-zinc-200 print:text-black">
                        <th className="sticky left-0 z-10 w-32 border-r border-zinc-300 bg-zinc-100 px-3 py-2.5 text-left font-bold dark:border-zinc-700 dark:bg-zinc-800 print:bg-zinc-200">
                          姓名
                        </th>
                        <th
                          colSpan={2}
                          className="border-r border-zinc-300 bg-zinc-100 px-2 py-2.5 text-center font-bold dark:border-zinc-700 dark:bg-zinc-800 print:bg-zinc-200"
                        >
                          職位
                        </th>
                        {weekDays.map((day) => {
                          const h = formatDayHeader(day);
                          const isActive = day === activeDay;
                          return (
                            <th
                              key={day}
                              className={`border-r border-zinc-300 px-2 py-2 text-center font-semibold dark:border-zinc-700 ${
                                isActive ? "bg-indigo-100 dark:bg-indigo-950/60 print:bg-zinc-200" : ""
                              }`}
                            >
                              <div>{h.top}</div>
                              <div className="font-mono text-[11px] font-normal text-zinc-500 dark:text-zinc-400 print:text-black">
                                {h.sub}
                              </div>
                            </th>
                          );
                        })}
                        <th className="w-20 bg-zinc-100 px-2 py-2 text-center font-bold dark:bg-zinc-800 print:bg-zinc-200">
                          本週工時
                        </th>
                        <th className="w-16 bg-zinc-100 px-2 py-2 text-center font-bold dark:bg-zinc-800 print:bg-zinc-200">
                          上班日數
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {orderedEmployees.map((emp, rowIdx) => {
                        const stats = empHoursMap.get(emp);
                        const over60 = (stats?.totalHours ?? 0) > 60;
                        return (
                          <tr
                            key={emp}
                            className={`border-b border-zinc-200 dark:border-zinc-800 ${
                              rowIdx % 2 === 0
                                ? "bg-white dark:bg-zinc-950"
                                : "bg-zinc-50/60 dark:bg-zinc-900/60"
                            }`}
                          >
                            <td className="sticky left-0 z-10 border-r border-zinc-300 bg-inherit px-3 py-2 font-semibold text-zinc-900 dark:border-zinc-700 dark:text-zinc-100 print:text-black">
                              {emp}
                            </td>
                            <td className="border-r border-zinc-200 px-2 py-2 text-center font-mono text-[11px] text-zinc-700 dark:border-zinc-800 dark:text-zinc-200">
                              {roleParts(employeeByName.get(emp)).rank}
                            </td>
                            <td className="border-r border-zinc-300 px-2 py-2 text-center font-mono text-[11px] text-zinc-700 dark:border-zinc-700 dark:text-zinc-200">
                              {roleParts(employeeByName.get(emp)).kind}
                            </td>
                            {weekDays.map((day) => {
                              const cell = getCellDisplay(emp, day);
                              const isActive = day === activeDay;
                              return (
                                <td
                                  key={day}
                                  className={`border-r border-zinc-200 px-1.5 py-1.5 text-center dark:border-zinc-800 ${
                                    isActive ? "bg-indigo-50/70 dark:bg-indigo-950/30 print:bg-transparent" : ""
                                  }`}
                                >
                                  {cell.kind === "work" ? (
                                    <div className="font-mono text-[11px] font-medium text-zinc-800 dark:text-zinc-200 print:text-black">
                                      {cell.label}
                                    </div>
                                  ) : cell.kind === "leave" ? (
                                    <span
                                      className="text-[11px] font-medium text-rose-700 dark:text-rose-300 print:font-bold print:text-black"
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
                                  ? "bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300 print:bg-white print:text-black"
                                  : "text-zinc-800 dark:text-zinc-200 print:text-black"
                              }`}
                            >
                              {stats ? formatHours(stats.totalHours) : "0h"}
                            </td>
                            <td className="px-2 py-2 text-center font-mono text-zinc-700 dark:text-zinc-200">
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
                          className="border-t border-zinc-300 bg-zinc-100 font-semibold dark:border-zinc-700 dark:bg-zinc-800"
                        >
                          <td
                            colSpan={3}
                            className="sticky left-0 z-10 border-r border-zinc-300 bg-zinc-100 px-3 py-1.5 text-left dark:border-zinc-700 dark:bg-zinc-800"
                          >
                            {row.label}
                          </td>
                          {row.values.map((hours, index) => (
                            <td
                              key={weekDays[index]}
                              className="border-r border-zinc-200 px-1 py-1.5 text-center font-mono text-[11px] dark:border-zinc-800"
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
                <div className="hidden print:block overflow-x-auto rounded-lg border border-zinc-300 print:overflow-visible print:border-none">
                  <table className="print-table w-full min-w-[920px] border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-zinc-300 bg-zinc-100 print:bg-zinc-200">
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
                      {orderedEmployees.map((emp) => (
                        <tr key={`print-${emp}`} className="border-b border-zinc-200">
                          <td className="px-3 py-2 font-semibold">{emp}</td>
                          <td className="px-2 py-2 text-center font-mono">{roleParts(employeeByName.get(emp)).rank}</td>
                          <td className="px-2 py-2 text-center font-mono">{roleParts(employeeByName.get(emp)).kind}</td>
                          {weekDays.map((day) => {
                            const cell = getCellDisplay(emp, day);
                            return (
                              <td key={day} className="px-1.5 py-1.5 text-center">
                                <div className="font-mono text-[11px]">{cell.label}</div>
                              </td>
                            );
                          })}
                          <td className="px-2 py-2 text-center font-mono font-semibold">
                            {formatHours(empHoursMap.get(emp)?.totalHours ?? 0)}
                          </td>
                          <td className="px-2 py-2 text-center font-mono">{workDayCount(emp)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      {hourSummaryRows.map((row) => (
                        <tr key={`print-${row.key}`} className="border-t border-zinc-300 font-semibold">
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

            <div className="no-print">
              <h3 className="text-sm font-semibold">後補名單（{reserveEmployees.length} 人）</h3>
              {reserveEmployees.length === 0 ? (
                <p className="mt-1.5 text-xs text-zinc-500">暫無後補員工。</p>
              ) : (
                <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {reserveEmployees.map((emp) => (
                    <li
                      key={emp.name}
                      className="rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700"
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
    </div>
  );
}
