"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { EMPLOYMENT_TYPES, type EmploymentType } from "@/lib/types";

type Row = Record<string, unknown>;
type Target = "store" | "employee" | "reserve" | "rules";
type Tab = "employees" | "reserve" | "rules" | "store";
type Hydrate = "all" | "rules" | "store" | "none";
type Month = "30" | "31";
type MType = "FT" | "HFT";
type Kind = "employee" | "reserve";

interface Stats { totalCount: number; ftCount: number; hftCount: number; ptCount: number }
interface ConfigRes {
  store?: Row | null; employees?: Row[]; reserve_staff?: Row[]; roster_rules?: Row[];
  stats?: Stats; error?: string;
}
export interface ConfigDrawerProps {
  open: boolean;
  onClose: () => void;
  /** 任何一次儲存成功後通知父組件重新載入更表／設定。 */
  onSaved?: () => void;
  /** 留空則由 API 使用預設分店（DEFAULT_STORE_ID）。 */
  storeId?: string;
}

// ── 常數（對齊 lib/types.ts 與 supabase schema） ──
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const DAY_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_ZH = ["日", "一", "二", "三", "四", "五", "六"];
const PERIODS = [["opening", "開檔"], ["breakfast", "早餐"], ["lunch", "午市"],
  ["tea", "下午茶"], ["dinner", "晚市"], ["closing", "收檔"]] as const;
/** lib/roster/rules.ts STAFF_CONFIG 標準時段：FT 5 / HFT 2 / PT 1。 */
const SLOTS = ["06:30-16:30", "07:00-17:00", "08:00-18:00", "11:00-21:00",
  "12:00-22:00", "07:00-12:00", "17:00-22:00", "18:00-22:00"];
const ROLES = [{ value: "M", label: "M · 經理" }, { value: "A.M", label: "A.M · 副經理" },
  { value: "S", label: "S · 主任" }, { value: "", label: "一般員工" }];
const TYPES = EMPLOYMENT_TYPES.map((t) => ({ value: t, label: t }));
const OT_OPTS = [{ value: "time_off", label: "補鐘（time_off）" }, { value: "cash", label: "轉化薪金（cash）" }];
const CUSTOM = "__custom__";
const MONTHS = ["30", "31"] as const;
const MTYPES = ["FT", "HFT"] as const;
const TABS: { key: Tab; label: string }[] = [
  { key: "employees", label: "正選員工" }, { key: "reserve", label: "後備名單" },
  { key: "rules", label: "排班規則" }, { key: "store", label: "分店資料" }];

/** 後台解鎖密碼；未設定環境變數時用預設 8888。 */
const MANAGER_PIN = process.env.NEXT_PUBLIC_MANAGER_PIN || "8888";

// 清新東南亞現代風：底紙 #FFFFFF · 柔灰區塊／表頭 #F5F1EB
// 分隔線 #E4DDD2 / #EFE9E0 · 翡翠青 #1D8A74 · hover #167763 · 淺底 #E8F3F0
const BTN = "rounded-lg bg-[#1D8A74] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#167763] disabled:cursor-not-allowed disabled:opacity-50";
const GHOST = "rounded-lg border border-[#E4DDD2] bg-white px-3.5 py-2 text-sm font-medium text-zinc-700 transition hover:bg-[#F5F1EB] dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200";
const SM = "rounded-md border border-[#E4DDD2] bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 transition hover:bg-[#F5F1EB] disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200";
const DANGER = "rounded-md border border-rose-200 bg-white px-2.5 py-1 text-xs font-medium text-rose-600 transition hover:bg-rose-50";
const INPUT = "mt-1 w-full rounded-lg border border-[#E4DDD2] bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none transition focus:border-[#1D8A74] focus:ring-2 focus:ring-[#1D8A74]/20 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100";
const CELL = "w-full rounded-md border border-[#E4DDD2] bg-white px-1 py-1 text-center text-xs text-zinc-900 outline-none focus:border-[#1D8A74] dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100";
const LBL = "block text-[11px] font-medium text-zinc-500 dark:text-zinc-400";
const TH = "px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-300";
const TD = "px-2 py-1.5 text-[11px] text-zinc-600 dark:text-zinc-300";
const MONO = `${TD} font-mono`;
const CARD = "rounded-xl border border-[#E4DDD2] dark:border-zinc-700";
const THEAD = "bg-[#F5F1EB] dark:bg-zinc-800";
const ROWLINE = "border-t border-[#EFE9E0] dark:border-zinc-800";
const CHK = "h-3.5 w-3.5 accent-[#1D8A74]";
const NOTE = "rounded-lg border px-3 py-2 text-xs";

// ── 值轉換 ──
const str = (v: unknown, d = ""): string =>
  typeof v === "string" ? v : v === null || v === undefined ? d : String(v);
const num = (v: unknown, d = 0): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : d;
};
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((i): i is string => typeof i === "string") : [];
const numArr = (v: unknown): number[] =>
  Array.isArray(v) ? v.map((i) => num(i, NaN)).filter((n) => Number.isFinite(n)) : [];
const obj = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
const toggle = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((i) => i !== v) : [...list, v]);
const offLabel = (v: unknown): string => {
  const l = numArr(v);
  return l.length === 0 ? "—" : l.map((i) => DAY_EN[i] ?? "?").join("，");
};
const isType = (v: unknown): v is EmploymentType =>
  typeof v === "string" && (EMPLOYMENT_TYPES as readonly string[]).includes(v);

// ── 表單狀態 ──
interface EmpForm {
  id?: string; name: string; nickname: string; employment_type: EmploymentType; role_title: string;
  fixed_slot: string; fixed_custom: string; flexible_shift_options: string[]; regular_days_off: number[];
  annual_leave_total: string; al_current_count: string; sh_current_count: string;
  w_current_count: string; ot_compensation_mode: "time_off" | "cash"; department: string;
}
/** 後備：可頂更時段借用 position，聯絡備註借用 nickname（reserve_staff 無專屬欄位）。 */
interface ResForm {
  id?: string; name: string; employment_type: EmploymentType; position: string;
  nickname: string; phone: string; priority: string; department: string;
}
interface RulesForm {
  headcount: Record<string, Record<string, string>>;
  maxDaily: Record<EmploymentType, string>;
  monthly: Record<Month, Record<MType, { target: string; daily: string }>>;
  otTrigger: string; otCap: string; deficit: string; statutory: string;
}
/** 自訂規則只存入 shift_time_slots.customRules，與 servicePeriods、byEmployment 並存。 */
interface CustomRule {
  id: string; name: string; scope: string; params: string; detail: string; active: boolean;
}
type PinTarget = { kind: Kind; row: Row } | { kind: "custom"; id: string; name: string };
interface StoreForm {
  store_name: string; address: string; phone: string;
  hours: Record<string, { start: string; end: string }>;
}

/** 六大時段的預設時間（與 migration_v2.sql 預設值一致）。 */
const DEFAULT_HOURS: Record<string, { start: string; end: string }> = {
  opening: { start: "06:00", end: "07:00" }, breakfast: { start: "07:00", end: "11:30" },
  lunch: { start: "11:30", end: "14:00" }, tea: { start: "14:00", end: "17:00" },
  dinner: { start: "17:00", end: "22:00" }, closing: { start: "22:00", end: "23:00" },
};
const blankHours = () => Object.fromEntries(
  PERIODS.map(([id]) => [id, { ...DEFAULT_HOURS[id] }]));

/** shift_time_slots 兼容：舊式陣列或 v2 的 { servicePeriods, byEmployment }。 */
const periodList = (raw: unknown): Row[] => {
  const list = Array.isArray(raw) ? raw : obj(raw).servicePeriods;
  return Array.isArray(list)
    ? list.filter((i): i is Row => !!i && typeof i === "object" && !Array.isArray(i)) : [];
};

const hoursFromRules = (rule: Row | undefined): StoreForm["hours"] => {
  const out = blankHours();
  for (const item of periodList(rule?.shift_time_slots)) {
    const id = str(item.id);
    if (!out[id]) continue;
    out[id] = { start: str(item.start, out[id].start), end: str(item.end, out[id].end) };
  }
  return out;
};

const blankRules = (): RulesForm => {
  const headcount: Record<string, Record<string, string>> = {};
  for (const [id] of PERIODS) {
    headcount[id] = {};
    for (const d of DAYS) headcount[id][d] = "0";
  }
  const block = () => ({ FT: { target: "0", daily: "0" }, HFT: { target: "0", daily: "0" } });
  return { headcount, maxDaily: { FT: "0", HFT: "0", PT: "0" },
    monthly: { "30": block(), "31": block() },
    otTrigger: "0", otCap: "0", deficit: "0", statutory: "0" };
};

const rulesToForm = (rule: Row | undefined): RulesForm => {
  const f = blankRules();
  if (!rule) return f;
  const head = obj(rule.period_headcount);
  for (const [id] of PERIODS) {
    const legacy = num(head[id], 0); // 兼容舊格式：period_headcount 為純數字
    const dayMap = obj(head[id]);
    for (const d of DAYS) f.headcount[id][d] = String(num(dayMap[d], legacy));
  }
  const daily = obj(rule.max_daily_hours);
  for (const t of EMPLOYMENT_TYPES) f.maxDaily[t] = String(num(daily[t]));
  const monthly = obj(rule.monthly_hours_rules);
  for (const m of MONTHS) for (const t of MTYPES) {
    const b = obj(obj(monthly[m])[t]);
    f.monthly[m][t] = { target: String(num(b.targetHours)), daily: String(num(b.standardDailyHours)) };
  }
  const ot = obj(rule.ot_balance_rules);
  f.otTrigger = String(num(ot.otTriggerHours));
  f.otCap = String(num(ot.otMaxCapHours));
  f.deficit = String(num(ot.deficitTriggerHours));
  f.statutory = String(num(rule.statutory_holidays_yearly));
  return f;
};

const customRulesFrom = (rule: Row | undefined): CustomRule[] => {
  const list = obj(rule?.shift_time_slots).customRules;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const r = item as Row;
    return [{
      id: str(r.id) || `cr_${i}`, name: str(r.name), scope: str(r.scope),
      params: str(r.params), detail: str(r.detail), active: r.active !== false,
    }];
  });
};

const withCustomRules = (raw: unknown, customRules: CustomRule[]) =>
  Array.isArray(raw) ? { servicePeriods: raw, customRules } : { ...obj(raw), customRules };

const empToForm = (row: Row): EmpForm => {
  const fixed = str(row.fixed_shift_time);
  const standard = fixed.length > 0 && SLOTS.includes(fixed);
  return {
    id: str(row.id) || undefined, name: str(row.name), nickname: str(row.nickname),
    employment_type: isType(row.employment_type) ? row.employment_type : "FT",
    role_title: str(row.role_title),
    fixed_slot: fixed.length === 0 ? "" : standard ? fixed : CUSTOM,
    fixed_custom: fixed.length > 0 && !standard ? fixed : "",
    flexible_shift_options: strArr(row.flexible_shift_options),
    regular_days_off: numArr(row.regular_days_off),
    annual_leave_total: String(num(row.annual_leave_total)),
    al_current_count: String(num(row.al_current_count)),
    sh_current_count: String(num(row.sh_current_count)),
    w_current_count: String(num(row.w_current_count)),
    ot_compensation_mode: str(row.ot_compensation_mode) === "cash" ? "cash" : "time_off",
    department: str(row.department),
  };
};

const resToForm = (row: Row): ResForm => ({
  id: str(row.id) || undefined, name: str(row.name),
  employment_type: isType(row.employment_type) ? row.employment_type : "PT",
  position: str(row.position), nickname: str(row.nickname), phone: str(row.phone),
  priority: String(num(row.priority, 100)), department: str(row.department),
});

// ── 共用 atom ──
interface AtomProps {
  label: string; value: string; onChange: (v: string) => void;
  type?: "text" | "number"; opts?: { value: string; label: string }[];
  ph?: string; hint?: string; step?: string; min?: string; className?: string;
}
/** 表單欄位 spec：k = 對應 form 的 key。 */
type Spec = Omit<AtomProps, "value" | "onChange"> & { k: string };

function Atom(p: AtomProps) {
  return (
    <label className={`block ${p.className ?? ""}`}>
      <span className={LBL}>{p.label}</span>
      {p.opts ? (
        <select className={INPUT} value={p.value} onChange={(e) => p.onChange(e.target.value)}>
          {p.opts.map((o) => <option key={o.value || "__e"} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        <input type={p.type ?? "text"} step={p.step} min={p.min} className={INPUT} value={p.value}
          placeholder={p.ph} onChange={(e) => p.onChange(e.target.value)} />
      )}
      {p.hint ? <span className="mt-1 block text-[11px] text-zinc-400">{p.hint}</span> : null}
    </label>
  );
}

/** spec 驅動的欄位格：省掉每欄重複 JSX。 */
function Fields<T extends object>({ specs, value, onChange, cols = "sm:grid-cols-2" }: {
  specs: Spec[]; value: T; onChange: (p: Partial<T>) => void; cols?: string;
}) {
  const rec = value as Record<string, unknown>;
  return (
    <div className={`mt-3 grid grid-cols-1 gap-3 ${cols}`}>
      {specs.map((s) => (
        <Atom key={s.k} label={s.label} type={s.type} opts={s.opts} ph={s.ph} hint={s.hint}
          step={s.step} min={s.min} value={str(rec[s.k])}
          onChange={(v) => onChange({ [s.k]: v } as Partial<T>)} />
      ))}
    </div>
  );
}

const Section = ({ title, hint, children }: { title: string; hint?: string; children?: ReactNode }) => (
  <section>
    <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
    {hint ? <p className="mt-0.5 text-[11px] text-zinc-500">{hint}</p> : null}
    {children}
  </section>
);

const Badge = ({ children }: { children: ReactNode }) => (
  <span className="rounded-full bg-[#E8F3F0] px-2 py-0.5 text-[11px] font-semibold text-[#167763] dark:bg-[#1D8A74]/20 dark:text-[#7FD3C1]">
    {children}
  </span>
);

function Chips<T extends string | number>({ items, selected, onToggle, labels }: {
  items: readonly T[]; selected: T[]; onToggle: (v: T) => void; labels?: string[];
}) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {items.map((item, i) => {
        const on = selected.includes(item);
        return (
          <button key={String(item)} type="button" onClick={() => onToggle(item)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
              on ? "bg-[#1D8A74] text-white"
                : "border border-[#E4DDD2] bg-white text-zinc-600 hover:bg-[#F5F1EB] dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
            }`}>
            {labels ? labels[i] : String(item)}
          </button>
        );
      })}
    </div>
  );
}

function Shell({ title, saveLabel, saving, onSave, onCancel, children }: {
  title: string; saveLabel: string; saving: boolean;
  onSave: () => void; onCancel: () => void; children: ReactNode;
}) {
  return (
    <div className={`${CARD} bg-[#F5F1EB]/60 p-4 dark:bg-zinc-950/40`}>
      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
      {children}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={GHOST}>取消</button>
        <button type="button" onClick={onSave} disabled={saving} className={BTN}>
          {saving ? "儲存中..." : saveLabel}
        </button>
      </div>
    </div>
  );
}

// ── 員工／後備編輯器 ──
const empSpecs = (store: string): Spec[] => [
  { k: "name", label: "姓名 *", ph: "例如：Jamie Cole" },
  { k: "nickname", label: "暱稱", ph: "例如：Jamie" },
  { k: "employment_type", label: "職級", opts: TYPES },
  { k: "role_title", label: "職位標記", opts: ROLES },
  { k: "department", label: "部門", ph: store || "Superme Cafe" },
];
const LEAVE_SPECS: Spec[] = [
  { k: "annual_leave_total", label: "全年大假（日）", type: "number", step: "0.5", min: "0" },
  { k: "al_current_count", label: "AL 累計基數", type: "number", step: "0.5", min: "0" },
  { k: "sh_current_count", label: "SH 累計基數", type: "number", step: "0.5", min: "0" },
  { k: "w_current_count", label: "W 累計基數", type: "number", step: "0.5", min: "0" },
];
const resSpecs = (store: string): Spec[] => [
  { k: "name", label: "姓名 *", ph: "例如：Reese Dalton" },
  { k: "employment_type", label: "職級", opts: TYPES },
  { k: "position", label: "可頂更時段", ph: "17:00-22:00", hint: "多個時段以逗號分隔，例如：17:00-22:00, 07:00-12:00" },
  { k: "phone", label: "聯絡電話", ph: "6000 1011" },
  { k: "nickname", label: "聯絡備註", ph: "例如：只做週末" },
  { k: "priority", label: "優先次序（細 = 優先）", type: "number", min: "1" },
  { k: "department", label: "部門", ph: store || "Superme Cafe" },
];

function EmpEditor({ form, onChange, storeName, ...rest }: {
  form: EmpForm; onChange: (p: Partial<EmpForm>) => void; storeName: string;
  saveLabel: string; saving: boolean; onSave: () => void; onCancel: () => void;
}) {
  return (
    <Shell title={form.id ? "編輯員工" : "新增員工"} {...rest}>
      <Fields specs={empSpecs(storeName)} value={form} onChange={onChange} />
      <div className="mt-3">
        <Atom label="固定上班時間" value={form.fixed_slot} onChange={(v) => onChange({ fixed_slot: v })}
          opts={[{ value: "", label: "未設定" }, ...SLOTS.map((s) => ({ value: s, label: s })),
            { value: CUSTOM, label: "自訂時段…" }]} />
        {form.fixed_slot === CUSTOM ? (
          <input className={INPUT} value={form.fixed_custom} placeholder="例如：11:00-21:00"
            onChange={(e) => onChange({ fixed_custom: e.target.value })} />
        ) : null}
      </div>
      <div className="mt-3">
        <span className={LBL}>彈性頂更時間（多選，全空 = 不參與頂更）</span>
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1.5">
          {SLOTS.map((slot) => (
            <label key={slot} className="flex items-center gap-1.5 text-xs text-zinc-700 dark:text-zinc-300">
              <input type="checkbox" className={CHK} checked={form.flexible_shift_options.includes(slot)}
                onChange={() => onChange({ flexible_shift_options: toggle(form.flexible_shift_options, slot) })} />
              <span className="font-mono">{slot}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="mt-3">
        <span className={LBL}>固定每週例休</span>
        <Chips items={[0, 1, 2, 3, 4, 5, 6] as const} labels={DAY_EN} selected={form.regular_days_off}
          onToggle={(v) => onChange({ regular_days_off: toggle(form.regular_days_off, v) })} />
      </div>
      <Fields specs={LEAVE_SPECS} value={form} onChange={onChange} cols="grid-cols-2 sm:grid-cols-4" />
      <Atom label="OT 預設處理方式" className="mt-3" value={form.ot_compensation_mode}
        onChange={(v) => onChange({ ot_compensation_mode: v === "cash" ? "cash" : "time_off" })} opts={OT_OPTS} />
    </Shell>
  );
}

function ResEditor({ form, onChange, storeName, ...rest }: {
  form: ResForm; onChange: (p: Partial<ResForm>) => void; storeName: string;
  saveLabel: string; saving: boolean; onSave: () => void; onCancel: () => void;
}) {
  return (
    <Shell title={form.id ? "編輯後備人員" : "新增後備人員"} {...rest}>
      <Fields specs={resSpecs(storeName)} value={form} onChange={onChange} />
    </Shell>
  );
}

// ── 名單表格（top-level，避免每次 render 重建元件） ──
const HEAD: Record<Kind, string[]> = {
  employee: ["姓名", "職級 / 職位", "固定時間", "例休", "AL / SH / W", "狀態"],
  reserve: ["姓名", "職級", "可頂更時段", "聯絡備註", "電話", "優先"],
};

function ListTable({ kind, rows, locked, onEdit, onToggle }: {
  kind: Kind; rows: Row[]; locked: boolean;
  onEdit: (row: Row) => void; onToggle: (row: Row, active: boolean) => void;
}) {
  return (
    <div className={`${CARD} overflow-x-auto`}>
      <table className="w-full min-w-[760px] border-collapse text-xs">
        <thead><tr className={THEAD}>
          {HEAD[kind].map((h) => <th key={h} className={TH}>{h}</th>)}
          <th className={`${TH} text-right`}>操作</th>
        </tr></thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={7} className="px-3 py-6 text-center text-xs text-zinc-500">
              暫無紀錄，請按「＋ 新增」。
            </td></tr>
          ) : rows.map((row, i) => {
            const off = row.is_active === false;
            const name = str(row.name, "（無姓名）");
            return (
              <tr key={str(row.id) || `${str(row.name)}-${i}`} className={ROWLINE}>
                {kind === "employee" ? (
                  <>
                    <td className="px-2 py-1.5">
                      <div className="font-medium text-zinc-900 dark:text-zinc-100">{name}</div>
                      {str(row.nickname) ? <div className={TD}>{str(row.nickname)}</div> : null}
                    </td>
                    <td className="px-2 py-1.5">
                      <Badge>{str(row.employment_type, "PT")}</Badge>
                      <span className={`ml-1 ${TD}`}>{str(row.role_title) || "一般"}</span>
                    </td>
                    <td className={MONO}>{str(row.fixed_shift_time, "—")}</td>
                    <td className={TD}>{offLabel(row.regular_days_off)}</td>
                    <td className={MONO}>{`${num(row.al_current_count)} / ${num(row.sh_current_count)} / ${num(row.w_current_count)}`}</td>
                    <td className={TD}>
                      {off ? <span className="text-rose-600">已停用</span>
                        : <span className="text-[#167763] dark:text-[#7FD3C1]">在職</span>}
                    </td>
                  </>
                ) : (
                  <>
                    <td className="px-2 py-1.5 font-medium text-zinc-900 dark:text-zinc-100">{name}</td>
                    <td className="px-2 py-1.5"><Badge>{str(row.employment_type, "PT")}</Badge></td>
                    <td className={MONO}>{str(row.position, "—")}</td>
                    <td className={TD}>{str(row.nickname, "—")}</td>
                    <td className={MONO}>{str(row.phone, "—")}</td>
                    <td className={MONO}>{num(row.priority, 100)}</td>
                  </>
                )}
                <td className="px-2 py-1.5">
                  <div className="flex justify-end gap-1.5">
                    <button type="button" className={SM} onClick={() => onEdit(row)}>編輯</button>
                    <button type="button" className={off ? SM : DANGER} onClick={() => onToggle(row, off)}>
                      {off ? "復用" : locked ? "🔒 刪除" : "刪除"}
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── 主組件 ──
export default function ConfigDrawer({ open, onClose, onSaved, storeId }: ConfigDrawerProps) {
  const [tab, setTab] = useState<Tab>("employees");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [store, setStore] = useState<Row | null>(null);
  const [employees, setEmployees] = useState<Row[]>([]);
  const [reserve, setReserve] = useState<Row[]>([]);
  const [rules, setRules] = useState<Row[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);

  const [showInactive, setShowInactive] = useState(false);
  const [empForm, setEmpForm] = useState<EmpForm | null>(null);
  const [resForm, setResForm] = useState<ResForm | null>(null);
  const [rulesForm, setRulesForm] = useState<RulesForm>(blankRules);
  const [rulesView, setRulesView] = useState<"standard" | "custom">("standard");
  const [customRules, setCustomRules] = useState<CustomRule[]>([]);
  const [customForm, setCustomForm] = useState<CustomRule | null>(null);
  const [storeForm, setStoreForm] = useState<StoreForm>({
    store_name: "", address: "", phone: "", hours: blankHours(),
  });

  /** 刪除保護：只有「刪除／停用」需要經理密碼，新增與編輯不受限。 */
  const [unlocked, setUnlocked] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  /** 待執行的停用操作；非 null 時顯示密碼確認彈窗。 */
  const [pinTarget, setPinTarget] = useState<PinTarget | null>(null);

  const storeName = str(store?.store_name);

  const applyConfig = useCallback((data: ConfigRes, hydrate: Hydrate = "all") => {
    setStore(data.store ?? null);
    setEmployees(Array.isArray(data.employees) ? data.employees : []);
    setReserve(Array.isArray(data.reserve_staff) ? data.reserve_staff : []);
    const ruleRows = Array.isArray(data.roster_rules) ? data.roster_rules : [];
    setRules(ruleRows);
    setStats(data.stats ?? null);
    if (hydrate === "all" || hydrate === "rules") {
      setRulesForm(rulesToForm(ruleRows[0]));
      setCustomRules(customRulesFrom(ruleRows[0]));
      setCustomForm(null);
    }
    if (hydrate === "all" || hydrate === "store") {
      setStoreForm({ store_name: str(data.store?.store_name), address: str(data.store?.address),
        phone: str(data.store?.phone), hours: hoursFromRules(ruleRows[0]) });
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = storeId ? `?storeId=${encodeURIComponent(storeId)}` : "";
      const res = await fetch(`/api/config${q}`, { cache: "no-store" });
      const data = (await res.json()) as ConfigRes;
      if (!res.ok) throw new Error(data.error || `讀取設定失敗（HTTP ${res.status}）`);
      applyConfig(data, "all");
    } catch (err) {
      setError(err instanceof Error ? err.message : "讀取設定時發生錯誤");
    } finally {
      setLoading(false);
    }
  }, [applyConfig, storeId]);

  const save = useCallback(async (target: Target, payload: Row, key: string,
    hydrate: Hydrate = "none", done?: () => void) => {
    setSaving(key);
    setError(null);
    setNotice(null);
    try {
      const body: Record<string, unknown> = { target, payload };
      if (storeId) body.storeId = storeId;
      const res = await fetch("/api/config", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = (await res.json()) as ConfigRes;
      if (!res.ok) throw new Error(data.error || `儲存失敗（HTTP ${res.status}）`);
      applyConfig(data, hydrate);
      setNotice("已儲存設定");
      done?.();
      onSaved?.();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存設定時發生錯誤");
      return false;
    } finally {
      setSaving(null);
    }
  }, [applyConfig, onSaved, storeId]);

  useEffect(() => {
    if (!open) return;
    // microtask 推遲 setState，避免 effect 同步觸發連鎖 render
    void Promise.resolve().then(() => {
      setEmpForm(null); setResForm(null); setCustomForm(null); setRulesView("standard");
      setError(null); setNotice(null);
      setUnlocked(false); setPin(""); setPinError(null); setPinTarget(null);
      void load();
    });
  }, [open, load]);

  /** 關閉抽屜：一律重新上鎖。 */
  const closeDrawer = useCallback(() => {
    setUnlocked(false); setPin(""); setPinError(null); setPinTarget(null);
    setEmpForm(null); setResForm(null);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeDrawer(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, closeDrawer]);

  const unlock = () => {
    if (pin !== MANAGER_PIN) { setPinError("經理權限密碼不正確。"); return; }
    setPin(""); setPinError(null); setUnlocked(true);
  };
  const lockNow = () => {
    setUnlocked(false); setPin(""); setPinError(null); setPinTarget(null);
    setEmpForm(null); setResForm(null);
  };

  const visibleEmp = useMemo(
    () => (showInactive ? employees : employees.filter((r) => r.is_active !== false)),
    [employees, showInactive]);
  const visibleRes = useMemo(
    () => (showInactive ? reserve : reserve.filter((r) => r.is_active !== false)),
    [reserve, showInactive]);

  function newEmp() {
    setError(null);
    setEmpForm({ name: "", nickname: "", employment_type: "FT", role_title: "", fixed_slot: "",
      fixed_custom: "", flexible_shift_options: [], regular_days_off: [], annual_leave_total: "0",
      al_current_count: "0", sh_current_count: "0", w_current_count: "0",
      ot_compensation_mode: "time_off", department: storeName });
  }

  function saveEmp() {
    if (!empForm) return;
    const name = empForm.name.trim();
    if (!name) { setError("請輸入員工姓名。"); return; }
    const payload: Row = {
      name, nickname: empForm.nickname.trim() || null,
      employment_type: empForm.employment_type, role_title: empForm.role_title || null,
      fixed_shift_time: empForm.fixed_slot === CUSTOM
        ? empForm.fixed_custom.trim() || null : empForm.fixed_slot || null,
      flexible_shift_options: empForm.flexible_shift_options, regular_days_off: empForm.regular_days_off,
      annual_leave_total: num(empForm.annual_leave_total), al_current_count: num(empForm.al_current_count),
      sh_current_count: num(empForm.sh_current_count), w_current_count: num(empForm.w_current_count),
      ot_compensation_mode: empForm.ot_compensation_mode,
      department: empForm.department.trim() || null, is_active: true,
    };
    if (empForm.id) payload.id = empForm.id;
    void save("employee", payload, "employee", "none", () => setEmpForm(null));
  }

  function newRes() {
    setError(null);
    setResForm({ name: "", employment_type: "PT", position: "", nickname: "", phone: "",
      priority: "100", department: storeName });
  }

  function saveRes() {
    if (!resForm) return;
    const name = resForm.name.trim();
    if (!name) { setError("請輸入後備人員姓名。"); return; }
    const payload: Row = {
      name, employment_type: resForm.employment_type,
      position: resForm.position.trim() || null, nickname: resForm.nickname.trim() || null,
      phone: resForm.phone.trim() || null,
      priority: Math.max(1, Math.trunc(num(resForm.priority, 100))),
      department: resForm.department.trim() || null, is_active: true,
    };
    if (resForm.id) payload.id = resForm.id;
    void save("reserve", payload, "reserve", "none", () => setResForm(null));
  }

  /** 軟刪除：員工／後備只改 is_active，不動其他欄位。停用需先解鎖。 */
  function applyActive(kind: Kind, row: Row, active: boolean) {
    const id = str(row.id);
    if (!id) { setError("此紀錄缺少 ID，無法更新狀態。"); return; }
    void save(kind, { id, is_active: active }, kind);
  }

  function setActive(kind: Kind, row: Row, active: boolean) {
    const id = str(row.id);
    if (!id) { setError("此紀錄缺少 ID，無法更新狀態。"); return; }
    const label = str(row.name, "此紀錄");
    // 復用不受鎖限制；停用必須先解鎖（未解鎖時彈出密碼確認）。
    if (active) {
      if (!window.confirm(`確定復用「${label}」？`)) return;
      applyActive(kind, row, true);
      return;
    }
    if (!unlocked) { setPinTarget({ kind, row }); setPin(""); setPinError(null); return; }
    if (!window.confirm(`確定停用「${label}」？`)) return;
    applyActive(kind, row, false);
  }

  /** 刪除確認彈窗：密碼正確 → 解鎖並立即執行該次停用。 */
  function confirmPin() {
    if (pin !== MANAGER_PIN) { setPinError("經理權限密碼不正確。"); return; }
    const target = pinTarget;
    setPin(""); setPinError(null); setPinTarget(null); setUnlocked(true);
    if (!target) return;
    if (target.kind === "custom") {
      setCustomRules((list) => list.filter((r) => r.id !== target.id));
      return;
    }
    applyActive(target.kind, target.row, false);
  }

  function commitCustom() {
    if (!customForm) return;
    const name = customForm.name.trim();
    if (!name) { setError("請輸入規則名稱。"); return; }
    const next: CustomRule = {
      ...customForm, name, scope: customForm.scope.trim(), params: customForm.params.trim(),
      detail: customForm.detail.trim(),
      id: customForm.id || crypto.randomUUID(),
    };
    setCustomRules((list) => (customForm.id
      ? list.map((r) => (r.id === customForm.id ? next : r)) : [...list, next]));
    setCustomForm(null); setError(null);
  }

  function askRemoveCustom(rule: CustomRule) {
    const label = rule.name || "未命名";
    if (!unlocked) {
      setPinTarget({ kind: "custom", id: rule.id, name: label });
      setPin(""); setPinError(null);
      return;
    }
    if (!window.confirm(`確定刪除自訂規則「${label}」？`)) return;
    setCustomRules((list) => list.filter((r) => r.id !== rule.id));
  }

  const patchCustom = (patch: Partial<CustomRule>) =>
    setCustomForm((prev) => (prev ? { ...prev, ...patch } : prev));

  const setHc = (id: string, d: string) => (v: string) =>
    setRulesForm((p) => ({ ...p, headcount: { ...p.headcount, [id]: { ...p.headcount[id], [d]: v } } }));
  const patchMonthly = (m: Month, t: MType, k: "target" | "daily") => (v: string) =>
    setRulesForm((p) => ({
      ...p, monthly: { ...p.monthly, [m]: { ...p.monthly[m], [t]: { ...p.monthly[m][t], [k]: v } } },
    }));
  const rule = <K extends keyof RulesForm>(k: K) => (v: string) =>
    setRulesForm((p) => ({ ...p, [k]: v }));

  function saveRules() {
    if (customForm) { setError("請先按「加入列表」或「更新列表」，再儲存排班規則。"); return; }
    const ruleId = str(rules[0]?.id);
    const shift_time_slots = withCustomRules(rules[0]?.shift_time_slots, customRules);
    if (!unlocked) {
      if (!ruleId) { setError("未有排班規則紀錄，請先解鎖並儲存一次標準規則。"); return; }
      void save("rules", { id: ruleId, shift_time_slots }, "rules", "rules");
      return;
    }
    const headcount: Record<string, Record<string, number>> = {};
    for (const [id] of PERIODS) {
      headcount[id] = {};
      for (const d of DAYS) headcount[id][d] = Math.max(0, Math.trunc(num(rulesForm.headcount[id]?.[d])));
    }
    const mb = (m: Month) => ({
      FT: { targetHours: num(rulesForm.monthly[m].FT.target), standardDailyHours: num(rulesForm.monthly[m].FT.daily) },
      HFT: { targetHours: num(rulesForm.monthly[m].HFT.target), standardDailyHours: num(rulesForm.monthly[m].HFT.daily) },
    });
    const payload: Row = {
      period_headcount: headcount,
      max_daily_hours: { FT: num(rulesForm.maxDaily.FT), HFT: num(rulesForm.maxDaily.HFT), PT: num(rulesForm.maxDaily.PT) },
      monthly_hours_rules: { "30": mb("30"), "31": mb("31") },
      ot_balance_rules: {
        otTriggerHours: num(rulesForm.otTrigger), otMaxCapHours: num(rulesForm.otCap),
        deficitTriggerHours: num(rulesForm.deficit),
      },
      statutory_holidays_yearly: num(rulesForm.statutory),
      shift_time_slots,
    };
    if (ruleId) payload.id = ruleId;
    void save("rules", payload, "rules", "rules");
  }

  async function saveStore() {
    if (!storeForm.store_name.trim()) { setError("請輸入分店名稱。"); return; }
    for (const [id, label] of PERIODS) {
      const h = storeForm.hours[id];
      if (!h?.start || !h?.end) { setError(`請填寫「${label}」的開始與結束時間。`); return; }
      if (h.end <= h.start) { setError(`「${label}」的結束時間必須晚於開始時間。`); return; }
    }
    const ok = await save("store", {
      store_name: storeForm.store_name.trim(),
      address: storeForm.address.trim() || null,
      phone: storeForm.phone.trim() || null,
    }, "store", "store");
    if (!ok) return;
    // 六大時段一併寫回 roster_rules.shift_time_slots（保留 v2 的 byEmployment）
    const ruleId = str(rules[0]?.id);
    if (!ruleId) return; // 未建立排班規則紀錄時只存分店基本資料
    const raw = rules[0]?.shift_time_slots;
    const servicePeriods = PERIODS.map(([id]) => ({ id, ...storeForm.hours[id] }));
    const shift_time_slots = Array.isArray(raw) ? servicePeriods : { ...obj(raw), servicePeriods };
    await save("rules", { id: ruleId, shift_time_slots }, "store", "store");
  }

  if (!open) return null;

  const inactiveToggle = (
    <label className="flex items-center gap-1.5 text-xs text-zinc-500">
      <input type="checkbox" className={CHK} checked={showInactive}
        onChange={(e) => setShowInactive(e.target.checked)} />
      顯示已停用
    </label>
  );

  return (
    <div className="no-print fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-zinc-950/40 backdrop-blur-[1px]" onClick={closeDrawer} aria-hidden />
      <aside role="dialog" aria-modal="true" aria-label="系統設定"
        className="relative ml-auto flex h-full w-full max-w-5xl flex-col bg-white shadow-2xl dark:bg-zinc-900">
        <header className="flex items-start justify-between gap-3 border-b border-[#E4DDD2] px-5 py-4 dark:border-zinc-800">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">系統設定</h2>
            <p className="mt-0.5 truncate text-xs text-zinc-500">
              {storeName || "尚未讀取分店"}
              {stats ? ` · 在職 ${stats.totalCount} 人（FT ${stats.ftCount} / HFT ${stats.hftCount} / PT ${stats.ptCount}）` : ""}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" onClick={() => void load()} disabled={loading} className={SM}>
              {loading ? "載入中..." : "重新載入"}
            </button>
            <button type="button" onClick={closeDrawer} aria-label="關閉設定"
              className="rounded-md px-2 py-1 text-lg leading-none text-zinc-500 transition hover:bg-[#F5F1EB] hover:text-zinc-800 dark:hover:bg-zinc-800">
              ✕
            </button>
          </div>
        </header>

        {/* ── 刪除保護狀態條 ── */}
        {unlocked ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-emerald-300 bg-emerald-50 px-5 py-2.5 dark:border-emerald-800 dark:bg-emerald-950/40">
            <p className="text-xs font-medium text-emerald-900 dark:text-emerald-200">
              🔓 已解鎖：可修改排班規則，以及刪除／停用紀錄（關閉抽屜後自動重新上鎖）
            </p>
            <button type="button" onClick={lockNow} className={SM}>立即上鎖</button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 border-b border-amber-300 bg-amber-50 px-5 py-2.5 dark:border-amber-800 dark:bg-amber-950/40">
            <span className="text-xs font-semibold text-amber-900 dark:text-amber-200">
              🔒 刪除／停用同標準排班規則已上鎖（新增與編輯員工、自訂規則不受限）
            </span>
            <input type="password" inputMode="numeric" autoComplete="off" placeholder="經理權限密碼"
              value={pin} onChange={(e) => { setPin(e.target.value); setPinError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") unlock(); }}
              className="w-40 rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-xs text-zinc-900 outline-none focus:border-[#1D8A74] focus:ring-2 focus:ring-[#1D8A74]/20 dark:border-amber-800 dark:bg-zinc-950 dark:text-zinc-100" />
            <button type="button" onClick={unlock} className={SM}>解鎖</button>
            {pinError ? <span className="text-xs font-medium text-rose-600">{pinError}</span> : null}
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* ── 左側直排導航（手機自動變頂部橫排） ── */}
          <nav aria-label="設定分頁"
            className="shrink-0 overflow-x-auto border-b border-[#E4DDD2] bg-[#F5F1EB] p-2 dark:border-zinc-800 dark:bg-zinc-800/60 md:w-[190px] md:overflow-visible md:border-b-0 md:border-r">
            <div className="flex gap-1 md:flex-col">
              {TABS.map((t) => (
                <button key={t.key} type="button" onClick={() => setTab(t.key)}
                  className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition md:w-full md:text-left ${
                    tab === t.key ? "bg-[#1D8A74] text-white shadow-xs hover:bg-[#167763]"
                      : "text-zinc-600 hover:bg-white hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
                  }`}>
                  {t.label}
                </button>
              ))}
            </div>
          </nav>

          <div className="min-w-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {error ? <div className={`${NOTE} border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200`}>{error}</div> : null}
          {notice ? <div className={`${NOTE} border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200`}>{notice}</div> : null}

          {/* ── 分頁 1：正選員工 ── */}
          {tab === "employees" ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                {inactiveToggle}
                <button type="button" onClick={newEmp} className={BTN} disabled={!!empForm}>＋ 新增員工</button>
              </div>
              {empForm ? (
                <EmpEditor form={empForm} storeName={storeName}
                  onChange={(p) => setEmpForm((prev) => (prev ? { ...prev, ...p } : prev))}
                  onSave={saveEmp} onCancel={() => setEmpForm(null)}
                  saving={saving === "employee"} saveLabel="儲存員工" />
              ) : (
                <ListTable kind="employee" rows={visibleEmp} locked={!unlocked}
                  onEdit={(row) => setEmpForm(empToForm(row))}
                  onToggle={(row, active) => setActive("employee", row, active)} />
              )}
              <p className="text-[11px] text-zinc-400">刪除採軟刪除（is_active = false），可按「復用」重新啟用。</p>
            </div>
          ) : null}

          {/* ── 分頁 2：後備名單 ── */}
          {tab === "reserve" ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                {inactiveToggle}
                <button type="button" onClick={newRes} className={BTN} disabled={!!resForm}>＋ 新增後備</button>
              </div>
              {resForm ? (
                <ResEditor form={resForm} storeName={storeName}
                  onChange={(p) => setResForm((prev) => (prev ? { ...prev, ...p } : prev))}
                  onSave={saveRes} onCancel={() => setResForm(null)}
                  saving={saving === "reserve"} saveLabel="儲存後備人員" />
              ) : (
                <ListTable kind="reserve" rows={visibleRes} locked={!unlocked}
                  onEdit={(row) => setResForm(resToForm(row))}
                  onToggle={(row, active) => setActive("reserve", row, active)} />
              )}
            </div>
          ) : null}

          {/* ── 分頁 3：排班規則 ── */}
          {tab === "rules" ? (
            <div className="space-y-4">
              <div className="flex gap-1">
                {([["standard", "標準規則"], ["custom", "自訂規則"]] as const).map(([k, label]) => (
                  <button key={k} type="button" onClick={() => setRulesView(k)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                      rulesView === k ? "bg-[#1D8A74] text-white" : "bg-[#F5F1EB] text-zinc-600 hover:text-zinc-900 dark:bg-zinc-800 dark:text-zinc-300"
                    }`}>{label}</button>
                ))}
              </div>
            {rulesView === "standard" ? (
            <fieldset disabled={!unlocked} className="min-w-0 space-y-4 border-0 p-0 disabled:opacity-70">
              {unlocked ? null : (
                <p className="text-xs font-medium text-amber-800 dark:text-amber-200">
                  🔒 排班規則已上鎖。請用上方經理密碼解鎖後先可修改。
                </p>
              )}
              <Section title="每日六大時段所需人數" hint="列 = 營業時段；欄 = 星期日 → 星期六。單位：人。">
                <div className={`mt-2 ${CARD} overflow-x-auto`}>
                  <table className="w-full min-w-[620px] border-collapse text-xs">
                    <thead><tr className={THEAD}>
                      <th className={`${TH} whitespace-nowrap`}>時段</th>
                      {DAYS.map((d, i) => (
                        <th key={d} className={`${TH} text-center`}>
                          <div>{DAY_EN[i]}</div>
                          <div className="text-[10px] font-normal text-zinc-400">{DAY_ZH[i]}</div>
                        </th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {PERIODS.map(([id, label]) => (
                        <tr key={id} className={ROWLINE}>
                          <td className="whitespace-nowrap px-2 py-1.5 font-medium text-zinc-700 dark:text-zinc-200">{label}</td>
                          {DAYS.map((d) => (
                            <td key={d} className="px-1 py-1">
                              <input type="number" min="0" className={CELL}
                                value={rulesForm.headcount[id]?.[d] ?? "0"} onChange={(e) => setHc(id, d)(e.target.value)} />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>

              <Section title="各職級標準日工時（小時）">
                <div className="mt-2 grid grid-cols-3 gap-3">
                  {EMPLOYMENT_TYPES.map((t) => (
                    <Atom key={t} label={t} type="number" step="0.5" min="0" value={rulesForm.maxDaily[t]}
                      onChange={(v) => setRulesForm((p) => ({ ...p, maxDaily: { ...p.maxDaily, [t]: v } }))} />
                  ))}
                </div>
              </Section>

              <Section title="每月工時目標">
                <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {MONTHS.map((m) => (
                    <div key={m} className={`${CARD} p-3`}>
                      <p className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">{m} 日月</p>
                      <div className="mt-2 space-y-2">
                        {MTYPES.map((t) => (
                          <div key={t} className="grid grid-cols-2 gap-2">
                            <Atom label={`${t} 目標工時`} type="number" min="0"
                              value={rulesForm.monthly[m][t].target} onChange={patchMonthly(m, t, "target")} />
                            <Atom label={`${t} 標準日工時`} type="number" step="0.5" min="0"
                              value={rulesForm.monthly[m][t].daily} onChange={patchMonthly(m, t, "daily")} />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>

              <Section title="OT 與欠鐘門檻（小時）">
                <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Atom label="OT 補鐘觸發線" hint="例如 6 = 超過 6 小時開始補鐘" type="number" step="0.5"
                    min="0" value={rulesForm.otTrigger} onChange={rule("otTrigger")} />
                  <Atom label="OT 紅線上限" hint="例如 8 = 最多補 8 小時" type="number" step="0.5"
                    min="0" value={rulesForm.otCap} onChange={rule("otCap")} />
                  <Atom label="欠鐘補半天門檻" hint="例如 5 = 欠 5 小時補半天" type="number" step="0.5"
                    min="0" value={rulesForm.deficit} onChange={rule("deficit")} />
                </div>
                <Atom label="全年法定假期日數" className="mt-3 max-w-[12rem]" type="number" min="0"
                  value={rulesForm.statutory} onChange={rule("statutory")} />
              </Section>

              <div className="flex justify-end">
                <button type="button" onClick={saveRules} disabled={!unlocked || saving === "rules"} className={BTN}>
                  {saving === "rules" ? "儲存中..." : "儲存排班規則"}
                </button>
              </div>
            </fieldset>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[11px] text-zinc-500">新增同編輯免密碼。刪除要經理密碼。改完請按「儲存排班規則」先寫入資料庫。</p>
                  <button type="button" className={BTN} disabled={!!customForm}
                    onClick={() => { setError(null); setCustomForm({ id: "", name: "", scope: "", params: "", detail: "", active: true }); }}>
                    ＋ 新增自訂規則
                  </button>
                </div>
                {customForm ? (
                  <div className={`${CARD} space-y-3 p-3`}>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Atom label="規則名稱 *" value={customForm.name} ph="週末晚市加人"
                        onChange={(v) => patchCustom({ name: v })} />
                      <Atom label="適用範圍／條件" value={customForm.scope} ph="Fri–Sat 晚市、全週適用"
                        onChange={(v) => patchCustom({ scope: v })} />
                      <Atom label="數值／參數設定" className="sm:col-span-2" value={customForm.params} ph="晚市 +1 人"
                        onChange={(v) => patchCustom({ params: v })} />
                    </div>
                    <label className="block">
                      <span className={LBL}>詳細規則說明</span>
                      <textarea rows={3} className={INPUT} value={customForm.detail}
                        placeholder="例如：颱風／惡劣天氣安排、新人帶教限制"
                        onChange={(e) => patchCustom({ detail: e.target.value })} />
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-300">
                      <input type="checkbox" className={CHK} checked={customForm.active}
                        onChange={(e) => patchCustom({ active: e.target.checked })} />
                      啟用（Active）
                    </label>
                    <div className="flex justify-end gap-2">
                      <button type="button" className={GHOST} onClick={() => setCustomForm(null)}>取消</button>
                      <button type="button" className={BTN} onClick={commitCustom}>
                        {customForm.id ? "更新列表" : "加入列表"}
                      </button>
                    </div>
                  </div>
                ) : customRules.length === 0 ? (
                  <p className="text-xs text-zinc-400">尚未有自訂規則。</p>
                ) : customRules.map((item) => (
                  <div key={item.id} className={`${CARD} flex flex-wrap items-start justify-between gap-2 p-3`}>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
                        {item.name}
                        <span className={`ml-2 text-[11px] ${item.active ? "text-[#1D8A74]" : "text-zinc-400"}`}>
                          {item.active ? "啟用" : "停用"}
                        </span>
                      </p>
                      <p className="mt-0.5 text-[11px] text-zinc-500">
                        {item.scope || "未填範圍"}{item.params ? ` · ${item.params}` : ""}
                      </p>
                      {item.detail ? <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">{item.detail}</p> : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <label className="flex items-center gap-1 text-[11px] text-zinc-500">
                        <input type="checkbox" className={CHK} checked={item.active}
                          onChange={(e) => setCustomRules((list) => list.map((r) => (
                            r.id === item.id ? { ...r, active: e.target.checked } : r)))} />
                        Active
                      </label>
                      <button type="button" className={SM} onClick={() => { setError(null); setCustomForm(item); }}>編輯</button>
                      <button type="button" className={DANGER} onClick={() => askRemoveCustom(item)}>刪除</button>
                    </div>
                  </div>
                ))}
                <div className="flex justify-end">
                  <button type="button" onClick={saveRules} disabled={saving === "rules"} className={BTN}>
                    {saving === "rules" ? "儲存中..." : "儲存排班規則"}
                  </button>
                </div>
              </div>
            )}
            </div>
          ) : null}

          {/* ── 分頁 4：分店資料 ── */}
          {tab === "store" ? (
            <div className="space-y-4">
              <Section title="分店資料">
                <div className="mt-2 space-y-3">
                  <Atom label="分店名稱 *" value={storeForm.store_name} ph="Superme Cafe"
                    onChange={(v) => setStoreForm((p) => ({ ...p, store_name: v }))} />
                  <Atom label="地址" value={storeForm.address}
                    onChange={(v) => setStoreForm((p) => ({ ...p, address: v }))} />
                  <Atom label="電話" value={storeForm.phone}
                    onChange={(v) => setStoreForm((p) => ({ ...p, phone: v }))} />
                </div>
              </Section>

              <Section title="營業時間（六大時段）" hint="可直接修改每個時段的開始與結束時間，按「儲存分店資料」一併存入。">
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {PERIODS.map(([id, label]) => {
                    const h = storeForm.hours[id] ?? { start: "", end: "" };
                    const setH = (k: "start" | "end") => (v: string) =>
                      setStoreForm((p) => ({ ...p, hours: { ...p.hours, [id]: { ...h, [k]: v } } }));
                    return (
                      <div key={id} className={`${CARD} p-2.5`}>
                        <p className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">{label}</p>
                        <div className="mt-1.5 grid grid-cols-2 gap-2">
                          <label className="block">
                            <span className={LBL}>開始</span>
                            <input type="time" className={INPUT} value={h.start}
                              onChange={(e) => setH("start")(e.target.value)} />
                          </label>
                          <label className="block">
                            <span className={LBL}>結束</span>
                            <input type="time" className={INPUT} value={h.end}
                              onChange={(e) => setH("end")(e.target.value)} />
                          </label>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Section>

              <div className="flex justify-end">
                <button type="button" onClick={() => void saveStore()} disabled={saving === "store"} className={BTN}>
                  {saving === "store" ? "儲存中..." : "儲存分店資料"}
                </button>
              </div>
            </div>
          ) : null}
          </div>
        </div>
      </aside>

      {/* ── 刪除確認：經理密碼 ── */}
      {pinTarget ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-950/50 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-[#E4DDD2] bg-white p-5 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              🔒 需要經理權限
            </h3>
            <p className="mt-1 text-xs text-zinc-500">
              {pinTarget.kind === "custom"
                ? `即將刪除自訂規則「${pinTarget.name}」。請輸入經理權限密碼確認。`
                : `即將停用「${str(pinTarget.row.name, "此紀錄")}」。請輸入經理權限密碼確認。`}
            </p>
            <input type="password" inputMode="numeric" autoComplete="off" placeholder="經理權限密碼"
              value={pin} autoFocus
              onChange={(e) => { setPin(e.target.value); setPinError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") confirmPin(); }}
              className={INPUT} />
            {pinError ? <p className="mt-1.5 text-xs font-medium text-rose-600">{pinError}</p> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className={GHOST}
                onClick={() => { setPinTarget(null); setPin(""); setPinError(null); }}>取消</button>
              <button type="button" className={BTN} onClick={confirmPin}>
                {pinTarget.kind === "custom" ? "確認刪除" : "確認停用"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
