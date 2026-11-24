"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { type RosterWarning, type WeekRoster } from "@/lib/types";

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

const SAMPLE_TEXT = `Superme Cafe 報更
Jamie Cole 6000 1001：星期一至五 AM/PM 都可以，星期六 AM，星期日放假
Noah Blake 6000 1002：星期二至六 AM，星期一、日放假
Casey Quinn 6000 1003：星期一、三、五 PM，星期六全天，2026-11-22 請假`;

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

export default function Home() {
  const [rosters, setRosters] = useState<WeekRoster[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState<boolean>(true);
  const [generatingDb, setGeneratingDb] = useState<boolean>(false);
  const [generatingMock, setGeneratingMock] = useState<boolean>(false);
  const [submittingText, setSubmittingText] = useState<boolean>(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  const [weekStart, setWeekStart] = useState<string>("2026-11-22");
  const [department, setDepartment] = useState<string>("Superme Cafe");
  const [availabilityText, setAvailabilityText] = useState<string>(SAMPLE_TEXT);

  const [feedback, setFeedback] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadRosters = useCallback(async (preferredId?: string | null) => {
    setLoadingList(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/rosters", { cache: "no-store" });
      const data = (await res.json()) as RosterApiResponse;
      if (!res.ok) {
        throw new Error(data.error || `讀取更表失敗（HTTP ${res.status}）`);
      }
      const list = Array.isArray(data.rosters) ? data.rosters : [];
      setRosters(list);

      if (preferredId) {
        setSelectedId(preferredId);
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
    void loadRosters();
  }, [loadRosters]);

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
          ? `已讀取 Supabase 員工資料並建立草稿（ID: ${createdId ?? "—"}）`
          : "已讀取員工資料生成草稿，但未持久化至 Supabase"
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

  async function handleTextSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!availabilityText.trim()) {
      setErrorMsg("請先輸入員工可用時段文字。");
      return;
    }

    setSubmittingText(true);
    setFeedback(null);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/parse-and-schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "text",
          text: availabilityText.trim(),
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
      setFeedback(
        `已由文字（${data.mode ?? "text"}）建立更表草稿${
          data.persisted ? "並寫入 Supabase" : "（未寫入 Supabase）"
        }（ID: ${createdId ?? "—"}）`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "解析文字時發生錯誤");
    } finally {
      setSubmittingText(false);
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
    rosters.find((item) => item.id && item.id === selectedId) ?? rosters[0] ?? null;

  const days = selectedRoster?.schedule?.days ?? [];
  const assignments = selectedRoster?.schedule?.assignments ?? [];
  const dailyHours = selectedRoster?.schedule?.dailyHours ?? [];
  const employeeHours = selectedRoster?.schedule?.employeeHours ?? [];

  const orderedEmployees: string[] = [];
  const seenEmp = new Set<string>();
  for (const emp of selectedRoster?.parsed?.employees ?? []) {
    if (emp.name && !seenEmp.has(emp.name)) {
      seenEmp.add(emp.name);
      orderedEmployees.push(emp.name);
    }
  }
  for (const a of assignments) {
    if (a.employee && !seenEmp.has(a.employee)) {
      seenEmp.add(a.employee);
      orderedEmployees.push(a.employee);
    }
  }

  const leaveMap = new Map<string, Set<string>>();
  for (const emp of selectedRoster?.parsed?.employees ?? []) {
    leaveMap.set(emp.name, new Set(emp.leave ?? []));
  }

  const empHoursMap = new Map<string, { totalHours: number; shiftsCount: number }>();
  for (const eh of employeeHours) {
    empHoursMap.set(eh.employee, {
      totalHours: eh.totalHours,
      shiftsCount: eh.shiftsCount,
    });
  }

  const dailyHoursMap = new Map<string, { headcount: number; totalHours: number }>();
  for (const dh of dailyHours) {
    dailyHoursMap.set(dh.date, {
      headcount: dh.headcount,
      totalHours: dh.totalHours,
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
      const slots = matched.map((m) => m.timeSlot || m.shift).join(" / ");
      const totalH = matched.reduce((sum, m) => sum + (m.hours ?? 0), 0);
      return {
        label: slots,
        sub: totalH > 0 ? `${totalH}h` : undefined,
        kind: "work",
      };
    }
    if (leaveMap.get(employee)?.has(day)) {
      return { label: "請假", kind: "leave" };
    }
    return { label: "OFF", kind: "off" };
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
              初遇 · 自動排班代理控制台
            </h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              週日開週制 · 員工橫向更表、工時核算、六大時段核數及放假超額提示。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => void loadRosters(selectedId)}
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

        {/* 簡潔單行設定 + 可收合文字輸入（列印時自動隱藏） */}
        <section className="no-print mt-5 rounded-xl border border-zinc-200 bg-white p-4 shadow-xs dark:border-zinc-800 dark:bg-zinc-900">
          <form onSubmit={(e) => void handleTextSubmit(e)} className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label
                  htmlFor="weekStart"
                  className="block text-xs font-medium text-zinc-600 dark:text-zinc-400"
                >
                  每週起始日（星期日）
                </label>
                <input
                  id="weekStart"
                  type="date"
                  value={weekStart}
                  onChange={(e) => setWeekStart(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                />
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
              <div className="flex items-end justify-end gap-2">
                <button
                  type="submit"
                  disabled={submittingText}
                  className="w-full rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50 sm:w-auto"
                >
                  {submittingText ? "解析排班中..." : "解析下方文字生成草稿"}
                </button>
              </div>
            </div>

            <details className="group">
              <summary className="cursor-pointer select-none text-xs font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200">
                展開／收起 WhatsApp 覆期文字輸入框
              </summary>
              <div className="mt-2 space-y-2">
                <textarea
                  id="availabilityText"
                  rows={3}
                  value={availabilityText}
                  onChange={(e) => setAvailabilityText(e.target.value)}
                  placeholder="貼上員工可用更期、請假日期..."
                  className="w-full rounded-lg border border-zinc-300 bg-white p-2.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                />
                <button
                  type="button"
                  onClick={() => setAvailabilityText(SAMPLE_TEXT)}
                  className="text-xs text-zinc-500 underline hover:text-zinc-800"
                >
                  填入範例覆期文字
                </button>
              </div>
            </details>
          </form>
        </section>

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

        {/* 更表紀錄橫向切換條（列印時自動隱藏） */}
        <section className="no-print mt-5">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
              更表紀錄（{rosters.length} 份 · 點擊切換）
            </h2>
          </div>
          {loadingList && rosters.length === 0 ? (
            <p className="text-xs text-zinc-500">正在讀取更表紀錄...</p>
          ) : rosters.length === 0 ? (
            <p className="text-xs text-zinc-500">
              暫無更表紀錄，請按右上角「由 DB 員工庫生成草稿」。
            </p>
          ) : (
            <div className="flex gap-2.5 overflow-x-auto pb-2">
              {rosters.map((item, idx) => {
                const key = item.id ?? `temp-${idx}`;
                const isSelected = selectedRoster?.id === item.id && item.id !== null;
                const isApproved = item.status === "approved";

                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => item.id && setSelectedId(item.id)}
                    className={`min-w-[210px] shrink-0 rounded-lg border p-2.5 text-left transition ${
                      isSelected
                        ? "border-indigo-600 bg-indigo-50/70 ring-1 ring-indigo-600 dark:border-indigo-400 dark:bg-indigo-950/40"
                        : "border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold">
                        {item.isoWeek} ({item.weekStart})
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          isApproved
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-amber-100 text-amber-800"
                        }`}
                      >
                        {item.status}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-zinc-500">
                      {item.department || "未分部門"} · 警告 {item.warnings?.length ?? 0} 項
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* 主更表 Matrix 視圖（列印時保留呢一區） */}
        {selectedRoster && (
          <section className="print-area mt-4 space-y-5 rounded-xl border border-zinc-200 bg-white p-5 shadow-xs dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex flex-col justify-between gap-3 border-b border-zinc-200 pb-4 dark:border-zinc-800 sm:flex-row sm:items-center print:border-black print:pb-2">
              <div>
                <div className="flex items-center gap-2.5">
                  <h2 className="text-lg font-bold">
                    {selectedRoster.department || "部門更表"} · {selectedRoster.isoWeek}（
                    {selectedRoster.weekStart} 起）
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

            {/* 橫向一覽排更表（每位員工一行、週日至週六七欄） */}
            <div>
              <div className="no-print mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">員工週更表（一目了然）</h3>
                <span className="text-xs text-zinc-500">
                  藍底＝當值更期 ｜ 紅底＝請假 ｜ 灰字＝OFF
                </span>
              </div>

              {days.length === 0 || orderedEmployees.length === 0 ? (
                <p className="py-6 text-center text-xs text-zinc-500">
                  暫無可顯示的員工排班資料。
                </p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-zinc-300 dark:border-zinc-700 print:overflow-visible print:border-none">
                  <table className="print-table w-full min-w-[920px] border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-zinc-300 bg-zinc-100 text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 print:bg-zinc-200 print:text-black">
                        <th className="sticky left-0 z-10 w-44 border-r border-zinc-300 bg-zinc-100 px-3 py-2.5 text-left font-bold dark:border-zinc-700 dark:bg-zinc-800 print:bg-zinc-200">
                          員工姓名
                        </th>
                        {days.map((day) => {
                          const h = formatDayHeader(day);
                          return (
                            <th
                              key={day}
                              className="border-r border-zinc-300 px-2 py-2 text-center font-semibold dark:border-zinc-700"
                            >
                              <div>{h.top}</div>
                              <div className="font-mono text-[11px] font-normal text-zinc-500 dark:text-zinc-400 print:text-black">
                                {h.sub}
                              </div>
                            </th>
                          );
                        })}
                        <th className="w-24 bg-zinc-100 px-2.5 py-2 text-center font-bold dark:bg-zinc-800 print:bg-zinc-200">
                          本週工時
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
                            {days.map((day) => {
                              const cell = getCellDisplay(emp, day);
                              return (
                                <td
                                  key={day}
                                  className="border-r border-zinc-200 px-1.5 py-1.5 text-center dark:border-zinc-800"
                                >
                                  {cell.kind === "work" ? (
                                    <div className="rounded bg-blue-50 px-1.5 py-1 font-mono text-[11px] font-medium text-blue-900 ring-1 ring-blue-200 dark:bg-blue-950/60 dark:text-blue-200 dark:ring-blue-800 print:bg-white print:text-black print:ring-0">
                                      <div>{cell.label}</div>
                                      {cell.sub && (
                                        <div className="text-[10px] text-blue-600 dark:text-blue-400 print:text-black">
                                          {cell.sub}
                                        </div>
                                      )}
                                    </div>
                                  ) : cell.kind === "leave" ? (
                                    <span className="inline-block rounded bg-rose-50 px-2 py-1 text-[11px] font-medium text-rose-700 ring-1 ring-rose-200 dark:bg-rose-950/50 dark:text-rose-300 dark:ring-rose-800 print:bg-white print:font-bold print:text-black print:ring-0">
                                      請假
                                    </span>
                                  ) : (
                                    <span className="text-[11px] text-zinc-400 print:text-zinc-500">
                                      OFF
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
                              {stats ? `${stats.totalHours}h` : "0h"}
                              {stats && (
                                <div className="text-[10px] font-normal text-zinc-500 print:text-black">
                                  ({stats.shiftsCount}日)
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-zinc-300 bg-zinc-100 font-semibold dark:border-zinc-700 dark:bg-zinc-800 print:bg-zinc-200 print:text-black">
                        <td className="sticky left-0 z-10 border-r border-zinc-300 bg-zinc-100 px-3 py-2 text-left dark:border-zinc-700 dark:bg-zinc-800 print:bg-zinc-200">
                          每日在崗 / 總工時
                        </td>
                        {days.map((day) => {
                          const dh = dailyHoursMap.get(day);
                          return (
                            <td
                              key={day}
                              className="border-r border-zinc-300 px-2 py-2 text-center font-mono text-[11px] dark:border-zinc-700"
                            >
                              <div>{dh ? `${dh.headcount} 人` : "0 人"}</div>
                              <div className="text-zinc-600 dark:text-zinc-400 print:text-black">
                                {dh ? `${dh.totalHours}h` : "0h"}
                              </div>
                            </td>
                          );
                        })}
                        <td className="px-2 py-2 text-center font-mono text-[11px]">
                          {dailyHours.reduce((s, d) => s + d.totalHours, 0)}h
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>

            {/* 警告與六大時段核數（列印時自動隱藏，保持更表乾淨） */}
            <div className="no-print">
              <h3 className="text-sm font-semibold">
                排班警告與六大時段核數（{selectedRoster.warnings?.length ?? 0} 項）
              </h3>
              {!selectedRoster.warnings || selectedRoster.warnings.length === 0 ? (
                <p className="mt-1.5 text-xs text-zinc-500">
                  暫無排班警告，各時段人手達標。
                </p>
              ) : (
                <ul className="mt-2 grid grid-cols-1 gap-1.5 md:grid-cols-2">
                  {selectedRoster.warnings.map((w, i) => {
                    const isManagerAlert = Boolean(w.needsManagerAction);
                    return (
                      <li
                        key={`${w.date}-${w.shift}-${i}`}
                        className={`rounded-md border px-3 py-2 text-xs ${
                          isManagerAlert
                            ? "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/60 dark:text-red-200"
                            : "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
                        }`}
                      >
                        {isManagerAlert && (
                          <span className="mr-1.5 inline-block rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                            ⚠️ 請管理員指示
                          </span>
                        )}
                        <span className="font-semibold">[{w.date}]</span> {w.message}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
