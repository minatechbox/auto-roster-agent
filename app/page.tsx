"use client";

import { useCallback, useEffect, useState } from "react";
import { WORKING_SHIFTS, type RosterWarning, type WeekRoster } from "@/lib/types";

interface RosterApiResponse {
  rosters?: WeekRoster[];
  error?: string;
}

interface ParseAndScheduleResponse {
  roster?: WeekRoster;
  persisted?: boolean;
  warnings?: RosterWarning[];
  error?: string;
}

interface ApproveResponse {
  roster?: WeekRoster;
  status?: string;
  error?: string;
}

export default function Home() {
  const [rosters, setRosters] = useState<WeekRoster[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState<boolean>(true);
  const [generatingMock, setGeneratingMock] = useState<boolean>(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);
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

  async function handleGenerateMock() {
    setGeneratingMock(true);
    setFeedback(null);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/parse-and-schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "mock" }),
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

  function getAssignedEmployees(day: string, shift: "AM" | "PM"): string[] {
    return assignments
      .filter((a) => a.date === day && a.shift === shift)
      .map((a) => a.employee);
  }

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <header className="flex flex-col gap-4 border-b border-zinc-200 pb-6 dark:border-zinc-800 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Auto Roster Agent — 更表草稿與批准控制台
            </h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              檢視 Supabase 內嘅每週更表草稿、排班警告與更表安排，並一鍵批准。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void loadRosters(selectedId)}
              disabled={loadingList}
              className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-800 transition hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              {loadingList ? "重新載入中..." : "重新整理"}
            </button>
            <button
              type="button"
              onClick={() => void handleGenerateMock()}
              disabled={generatingMock}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              {generatingMock ? "生成中..." : "+ 生成 Mock 草稿"}
            </button>
          </div>
        </header>

        {feedback && (
          <div className="mt-4 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200">
            {feedback}
          </div>
        )}

        {errorMsg && (
          <div className="mt-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/60 dark:text-red-200">
            {errorMsg}
          </div>
        )}

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* 左欄：更表列表 */}
          <section className="lg:col-span-5">
            <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-xs dark:border-zinc-800 dark:bg-zinc-900">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-base font-semibold">更表紀錄（{rosters.length}）</h2>
                <span className="text-xs text-zinc-500">最新優先</span>
              </div>

              {loadingList && rosters.length === 0 ? (
                <p className="py-8 text-center text-sm text-zinc-500">
                  正在讀取更表紀錄...
                </p>
              ) : rosters.length === 0 ? (
                <p className="py-8 text-center text-sm text-zinc-500">
                  暫時未有更表紀錄，可以撳右上角「+ 生成 Mock 草稿」測試。
                </p>
              ) : (
                <ul className="space-y-2.5">
                  {rosters.map((item, idx) => {
                    const key = item.id ?? `temp-${idx}`;
                    const isSelected = selectedRoster?.id === item.id && item.id !== null;
                    const isApproved = item.status === "approved";

                    return (
                      <li key={key}>
                        <button
                          type="button"
                          onClick={() => item.id && setSelectedId(item.id)}
                          className={`w-full rounded-lg border p-3 text-left transition ${
                            isSelected
                              ? "border-zinc-900 bg-zinc-50 dark:border-zinc-200 dark:bg-zinc-800/80"
                              : "border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/40"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-sm">
                              {item.isoWeek}（{item.weekStart}）
                            </span>
                            <span
                              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                                isApproved
                                  ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200"
                                  : "bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200"
                              }`}
                            >
                              {item.status}
                            </span>
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                            <span>
                              {item.department || "未分部門"} · {item.source} · {item.mode} · 警告{" "}
                              {item.warnings?.length ?? 0} 項
                            </span>
                            <span className="truncate max-w-[140px]">
                              {item.id ?? "未儲存"}
                            </span>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>

          {/* 右欄：選中更表明細與批准操作 */}
          <section className="lg:col-span-7">
            <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-xs dark:border-zinc-800 dark:bg-zinc-900">
              {!selectedRoster ? (
                <p className="py-12 text-center text-sm text-zinc-500">
                  請喺左邊揀一份更表檢視詳情。
                </p>
              ) : (
                <div className="space-y-5">
                  <div className="flex flex-col justify-between gap-3 border-b border-zinc-200 pb-4 dark:border-zinc-800 sm:flex-row sm:items-center">
                    <div>
                      <div className="flex items-center gap-2.5">
                        <h2 className="text-lg font-semibold">
                          {selectedRoster.isoWeek}（{selectedRoster.weekStart}）
                        </h2>
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                            selectedRoster.status === "approved"
                              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200"
                              : "bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200"
                          }`}
                        >
                          {selectedRoster.status}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                        ID: {selectedRoster.id ?? "—"} · 建立於{" "}
                        {selectedRoster.createdAt ?? "—"} · 批准於{" "}
                        {selectedRoster.approvedAt ?? "尚未批准"}
                      </p>
                    </div>

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
                        : "批准更表"}
                    </button>
                  </div>

                  {/* 警告提示 */}
                  <div>
                    <h3 className="text-sm font-semibold">
                      排班警告（{selectedRoster.warnings?.length ?? 0}）
                    </h3>
                    {!selectedRoster.warnings || selectedRoster.warnings.length === 0 ? (
                      <p className="mt-1.5 text-xs text-zinc-500">暫無排班警告。</p>
                    ) : (
                      <ul className="mt-2 space-y-1.5">
                        {selectedRoster.warnings.map((w, i) => (
                          <li
                            key={`${w.date}-${w.shift}-${i}`}
                            className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
                          >
                            <span className="font-semibold">
                              [{w.date} {w.shift}]
                            </span>{" "}
                            {w.message}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* 更表安排表 */}
                  <div>
                    <h3 className="text-sm font-semibold">更表安排（AM / PM）</h3>
                    {days.length === 0 ? (
                      <p className="mt-1.5 text-xs text-zinc-500">暫無日期資料。</p>
                    ) : (
                      <div className="mt-2 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
                        <table className="w-full border-collapse text-left text-xs">
                          <thead>
                            <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950/60">
                              <th className="px-3 py-2 font-semibold">日期</th>
                              {WORKING_SHIFTS.map((shift) => (
                                <th key={shift} className="px-3 py-2 font-semibold">
                                  {shift}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {days.map((day) => (
                              <tr
                                key={day}
                                className="border-b border-zinc-100 last:border-b-0 dark:border-zinc-800/70"
                              >
                                <td className="px-3 py-2 font-mono">{day}</td>
                                {WORKING_SHIFTS.map((shift) => {
                                  const staff = getAssignedEmployees(day, shift);
                                  return (
                                    <td key={shift} className="px-3 py-2">
                                      {staff.length > 0 ? staff.join(", ") : "—"}
                                    </td>
                                  );
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  {/* 原始排班 JSON */}
                  <div>
                    <h3 className="text-sm font-semibold">原始排班 JSON</h3>
                    <pre className="mt-2 max-h-60 overflow-auto rounded-lg bg-zinc-950 p-3.5 text-xs text-zinc-100">
                      {JSON.stringify(selectedRoster.schedule, null, 2)}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}