import { saveDraftRoster } from "@/lib/db/rosters";
import { DEFAULT_STORE_ID, getStoreConfig } from "@/lib/db/config";
import { parseRosterFromImage } from "@/lib/ai/parse-image";
import { parseRosterFromText } from "@/lib/ai/parse-text";
import { SAMPLE_WEEK_START } from "@/lib/mock/sample-week";
import { buildWeekSchedule } from "@/lib/roster/schedule";
import {
  STAFF_CATEGORY_BY_EMPLOYMENT,
  WEEKDAY_KEYS,
} from "@/lib/types";
import type {
  Employee,
  EmployeeAvailability,
  EmploymentType,
  ImageIntake,
  LeaveCode,
  ParsedAvailability,
  RosterMode,
  RosterSource,
  RosterWarning,
  WeekRoster,
  WorkingShift,
} from "@/lib/types";
import { SERVICE_PERIODS, parseISODate, weekDates } from "./rules";
import type { EmployeeLeaveEntry } from "./rules";

export const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const SUPPORTED_IMAGE_MIMES = new Set<ImageIntake["mimeType"]>([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export interface IntakeSaveResult {
  roster: WeekRoster;
  persisted: boolean;
  mode: RosterMode;
  warnings: RosterWarning[];
}

export function isValidWeekStart(dateStr: string): boolean {
  if (!DATE_REGEX.test(dateStr)) {
    return false;
  }
  const parsed = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dateStr) {
    return false;
  }
  const day = parsed.getUTCDay();
  return day === 0 || day === 1;
}

export function getIsoWeekLabel(weekStart: string): string {
  const date = new Date(`${weekStart}T00:00:00Z`);
  if (date.getUTCDay() === 0) {
    date.setUTCDate(date.getUTCDate() + 4);
  } else {
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  }
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

export function resolveWeekStart(raw?: string | null): string {
  const value = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : SAMPLE_WEEK_START;
  if (!isValidWeekStart(value)) {
    throw new Error("weekStart 必須為有效的 YYYY-MM-DD 格式且為星期日或星期一。");
  }
  return value;
}

export function intakeErrorPayload(err: unknown, fallback: string): {
  error: string;
  status: number;
} {
  const errorWithCode = err as Error & { code?: string };
  if (errorWithCode.code === "SCHEMA_VALIDATION_FAILED") {
    return {
      error: `AI 回傳資料不符合排班結構：${errorWithCode.message}`,
      status: 422,
    };
  }
  if (err instanceof Error && err.message.includes("weekStart")) {
    return { error: err.message, status: 400 };
  }
  return { error: fallback, status: 502 };
}

// ═════════════════════════════════════════════
// WhatsApp / WeChat 共用報更文字解析
// FT / HFT = 報「放假日」；PT = 報「返工日」（語意完全相反）
// ═════════════════════════════════════════════

export interface ReportInterpretation {
  parsed: ParsedAvailability;
  leaveEntries: EmployeeLeaveEntry[];
  partTimeAvailableDates: Record<string, string[]>;
  warnings: string[];
  matched: number;
}

interface ReportBlock {
  name: string;
  nickname?: string;
  phone?: string;
  /** 名稱之後的完整原文（保持原順序，供日期／時段配對）。 */
  raw: string;
  headerDates: string[];
  headerSlots: string[];
  body: string;
  reserve: boolean;
}

const LEAVE_WORD_RE =
  /放假|請假|告假|休息|例休|大假|勞工假|勞假|唔得閒|不得閒|返唔到|唔返得|缺席|離港/;
/** 明確「唔可以返」的封鎖語。 */
const BLOCK_WORD_RE = /唔得|唔可以|唔能|不能|不可|唔排|唔返|不能返|no\s*work/i;
const AVAILABLE_WORD_RE = /可返|可以返|返得|返工|上班|能返|得閒|可排|有時間|空檔|頂更|\bok\b/i;
const SHIFT_WORD_RE =
  /早更|早班|午更|午班|晚更|晚班|開檔|早餐|早市|午市|下午茶|晚市|收檔/;
const HEADER_STOP_RE =
  /^(?:星期|禮拜|周|週|放假|請假|休息|報更|更表|其餘|其他|全週|本週|每日|全日|備註|後補|後備|兼職|長工|半長工|經理|主任|店長|時段|時間|AL|SH|W)$/i;
/** 以「星期／禮拜／週」開頭的行一定係內容，唔係人名。 */
const CONTENT_PREFIX_RE = /^(?:星期|禮拜|週|周|其餘|其他|每日|全日|本週|全週|後補|後備)/;

const CJK_NAME = "[\\u4e00-\\u9fff]{2,4}";
const EN_NAME = "[A-Za-z][A-Za-z.]*(?:\\s+[A-Za-z][A-Za-z.]*)*";
const NAME_HEAD_RE = new RegExp(
  `^(?:\\d{1,2}\\s*[.、)]\\s*)?(${CJK_NAME}|${EN_NAME})\\s*(?:[（(]([^）)]{0,12})[）)])?\\s*`,
);
const DATE_TOKEN_RE =
  /^(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{1,2}\s*月\s*\d{1,2}\s*[日號]?)\s*[：:]?\s*/;
const TIME_TOKEN_RE =
  /^(\d{1,2}\s*[:：]\s*\d{2}\s*[-~－至到]\s*\d{1,2}\s*[:：]\s*\d{2})\s*[：:]?\s*/;
const DATE_SCAN_RE =
  /(\d{4}-\d{2}-\d{2})|(\d{1,2}\s*月\s*\d{1,2}\s*[日號]?)|(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/g;
const SLOT_SCAN_RE =
  /(\d{1,2})\s*[:：]\s*(\d{2})\s*[-~－至到]\s*(\d{1,2})\s*[:：]\s*(\d{2})/g;

const CJK_DAY_INDEX: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};
const EN_DAY_INDEX: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};
const EN_DAY_PATTERN =
  "sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|weds|wed|thurs|thur|thu|fri|sat";
const SHIFT_ANCHORS: Array<{ shift: WorkingShift; start: number; end: number }> = [
  { shift: "AM", start: 7 * 60, end: 17 * 60 },
  { shift: "PM", start: 12 * 60, end: 22 * 60 },
  { shift: "EVE", start: 17 * 60, end: 22 * 60 },
];

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function clockText(minutes: number): string {
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

function isValidIso(iso: string): boolean {
  try {
    parseISODate(iso);
    return true;
  } catch {
    return false;
  }
}

/** `11/28`、`11/28/2026`、`11月28日` → 目標週內的 ISO 日期。 */
function resolveDateToken(token: string, weekStart: string): string | null {
  const text = token.replace(/\s+/g, "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return isValidIso(text) ? text : null;
  }
  const slash = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(text);
  const cn = /^(\d{1,2})月(\d{1,2})[日號]?$/.exec(text);
  const month = Number((slash ?? cn)?.[1] ?? 0);
  const day = Number((slash ?? cn)?.[2] ?? 0);
  if (!month || !day) return null;
  const rawYear = slash?.[3];
  const year = rawYear
    ? rawYear.length === 2
      ? 2000 + Number(rawYear)
      : Number(rawYear)
    : null;
  const baseYear = Number(weekStart.slice(0, 4));
  const candidates = year ? [year] : [baseYear, baseYear + 1, baseYear - 1];
  const inWeek = weekDates(weekStart);
  for (const candidate of candidates) {
    const iso = `${candidate}-${pad2(month)}-${pad2(day)}`;
    if (isValidIso(iso) && inWeek.includes(iso)) return iso;
  }
  for (const candidate of candidates) {
    const iso = `${candidate}-${pad2(month)}-${pad2(day)}`;
    if (isValidIso(iso)) return iso;
  }
  return null;
}

function expandDayRange(from: number, to: number): number[] {
  const days: number[] = [];
  let index = from;
  for (let step = 0; step < 7; step += 1) {
    days.push(index);
    if (index === to) break;
    index = (index + 1) % 7;
  }
  return days;
}

/** 中文（星期一／週六／禮拜日／一至五）＋英文（Mon／Monday／Mon-Fri）星期。 */
const CJK_WEEKDAY_RE =
  /(?:星期|禮拜|拜|周|週)\s*([日天一二三四五六])(?:\s*(?:至|到|~|－|-)\s*(?:星期|禮拜|拜|周|週)?\s*([日天一二三四五六]))?/g;
const EN_WEEKDAY_BODY = `\\b(${EN_DAY_PATTERN})\\b(?:\\s*(?:-|–|~|to)\\s*\\b(${EN_DAY_PATTERN})\\b)?`;

interface WeekdayHit {
  days: number[];
  index: number;
}

function scanWeekdayHits(text: string): WeekdayHit[] {
  const hits: WeekdayHit[] = [];
  if (/週末|周末/.test(text)) {
    const index = Math.max(text.search(/週末|周末/), 0);
    hits.push({ days: [0, 6], index });
  }
  for (const match of text.matchAll(CJK_WEEKDAY_RE)) {
    const from = CJK_DAY_INDEX[match[1]];
    const to = match[2] ? CJK_DAY_INDEX[match[2]] : from;
    if (from === undefined || to === undefined) continue;
    const index = match.index ?? 0;
    const days = expandDayRange(from, to);
    if (!match[2]) {
      // 「星期一、三、五、六」這種用頓號／斜線串起來的清單。
      let cursor = text.slice(index + match[0].length);
      for (let guard = 0; guard < 7; guard += 1) {
        const next =
          /^\s*(?:[、,，/]|同|及)\s*(?:星期|禮拜|拜|周|週)?\s*([日天一二三四五六])/.exec(
            cursor,
          );
        if (!next) break;
        const value = CJK_DAY_INDEX[next[1]];
        if (value !== undefined && !days.includes(value)) days.push(value);
        cursor = cursor.slice(next[0].length);
      }
    }
    hits.push({ days, index });
  }
  const english = new RegExp(EN_WEEKDAY_BODY, "gi");
  for (const match of text.matchAll(english)) {
    const from = EN_DAY_INDEX[match[1].toLowerCase()];
    const to = match[2] ? EN_DAY_INDEX[match[2].toLowerCase()] : from;
    if (from === undefined || to === undefined) continue;
    hits.push({ days: expandDayRange(from, to), index: match.index ?? 0 });
  }
  return hits;
}

function extractWeekdayIndexes(text: string): number[] {
  const days: number[] = [];
  for (const hit of scanWeekdayHits(text)) {
    for (const value of hit.days) {
      if (!days.includes(value)) days.push(value);
    }
  }
  return days;
}

function datesForWeekdays(indexes: number[], weekStart: string): string[] {
  return weekDates(weekStart).filter((iso) =>
    indexes.includes(parseISODate(iso).getDay()),
  );
}

interface SlotHit {
  start: number;
  end: number;
  /** 實際時間段，例如 "18:00-22:00"。 */
  text: string;
  /** 對齊店舖六大營業時段名稱（開檔／早餐／午市／下午茶／晚市／收檔）。 */
  label?: string;
  /** 該時段在原句的起點，用於配對緊接的日期。 */
  index: number;
}

export function extractReportSlots(text: string): SlotHit[] {
  const hits: SlotHit[] = [];
  const push = (hit: SlotHit) => {
    if (!hits.some((item) => item.text === hit.text)) hits.push(hit);
  };
  for (const match of text.matchAll(SLOT_SCAN_RE)) {
    const start = Number(match[1]) * 60 + Number(match[2]);
    const end = Number(match[3]) * 60 + Number(match[4]);
    if (end <= start || end > 24 * 60) continue;
    push({
      start,
      end,
      text: `${clockText(start)}-${clockText(end)}`,
      index: match.index ?? 0,
    });
  }
  const periodWords: Array<{ pattern: RegExp; id: string }> = [
    { pattern: /開檔|開市/, id: "opening" },
    { pattern: /早餐|早市|朝早/, id: "breakfast" },
    { pattern: /午市|午餐|中午/, id: "lunch" },
    { pattern: /下午茶|茶市/, id: "tea" },
    { pattern: /晚市|晚餐|夜晚/, id: "dinner" },
    { pattern: /收檔|收市/, id: "closing" },
  ];
  for (const item of periodWords) {
    const wordHit = item.pattern.exec(text);
    if (!wordHit) continue;
    const period = SERVICE_PERIODS.find((entry) => entry.id === item.id);
    if (!period) continue;
    const slot = `${clockText(period.startMinutes)}-${clockText(period.endMinutes)}`;
    push({
      start: period.startMinutes,
      end: period.endMinutes,
      text: slot,
      label: period.shortLabel,
      index: wordHit.index,
    });
  }
  return hits;
}

function shiftForWindow(start: number, end: number): WorkingShift {
  let best: { shift: WorkingShift; overlap: number; span: number } = {
    shift: "AM",
    overlap: -1,
    span: Number.MAX_SAFE_INTEGER,
  };
  for (const anchor of SHIFT_ANCHORS) {
    const overlap = Math.max(0, Math.min(end, anchor.end) - Math.max(start, anchor.start));
    const span = anchor.end - anchor.start;
    if (overlap > best.overlap || (overlap === best.overlap && span < best.span)) {
      best = { shift: anchor.shift, overlap, span };
    }
  }
  return best.overlap > 0 ? best.shift : start < 12 * 60 ? "AM" : "PM";
}

function shiftsFromText(text: string): WorkingShift[] {
  const shifts: WorkingShift[] = [];
  const add = (shift: WorkingShift) => {
    if (!shifts.includes(shift)) shifts.push(shift);
  };
  if (/早更|早班|上午|開檔|早餐|早市/.test(text)) add("AM");
  if (/午更|午班|下午|午市|午餐|下午茶|茶市/.test(text)) add("PM");
  if (/晚更|晚班|晚市|晚餐|收檔|夜晚/.test(text)) add("EVE");
  for (const hit of extractReportSlots(text)) add(shiftForWindow(hit.start, hit.end));
  return shifts;
}

function uniqueShifts(shifts: readonly WorkingShift[]): WorkingShift[] {
  return (["AM", "PM", "EVE"] as WorkingShift[]).filter((shift) =>
    shifts.includes(shift),
  );
}

function detectLeaveCode(text: string): LeaveCode | null {
  if (/大假|年假|\bAL\s*\d*/i.test(text)) return "AL";
  if (/勞工假|勞假|\bSH\s*\d*/i.test(text)) return "SH";
  if (/例休|例假|\bW\s*\d*/i.test(text)) return "W";
  return null;
}

function guessEmployment(text: string): { employment: EmploymentType; explicit: boolean } {
  if (/兼職|\bP\.?\s*T\.?\b|part[\s-]*time/i.test(text)) {
    return { employment: "PT", explicit: true };
  }
  if (/半長工|半全職|\bH\.?F\.?T\.?\b/i.test(text)) {
    return { employment: "HFT", explicit: true };
  }
  if (/長工|全職|\bF\.?\s*T\.?\b|full[\s-]*time/i.test(text)) {
    return { employment: "FT", explicit: true };
  }
  if (LEAVE_WORD_RE.test(text) || detectLeaveCode(text)) {
    return { employment: "FT", explicit: true };
  }
  if (AVAILABLE_WORD_RE.test(text)) {
    return { employment: "PT", explicit: true };
  }
  if (SHIFT_WORD_RE.test(text) || extractReportSlots(text).length > 0) {
    return { employment: "PT", explicit: true };
  }
  return { employment: "FT", explicit: false };
}

/**
 * 微信常見「姓名 時間:」換行格式 → 以名稱行切 block，其餘行併入 body。
 * 只有「真係人名」才算 header：必須有冒號／電話／日期／時間，或對得上資料庫名單，
 * 否則「大假」「晚市」「兼職可返」等內容行會被誤認成員工。
 */
function parseHeaderLine(
  line: string,
  reserve: boolean,
  known: ReadonlySet<string>,
): ReportBlock | null {
  const match = NAME_HEAD_RE.exec(line);
  if (!match) return null;
  const name = match[1].trim();
  if (HEADER_STOP_RE.test(name)) return null;
  // 「黃小強 週六 SH 勞工假」這種同行式報更，名字後面接星期 → 真 header；
  // 但「星期一至三放假」開頭 → 內容行。
  if (CONTENT_PREFIX_RE.test(line) && !/^[（(]/.test(line.slice(name.length).trimStart())) {
    return null;
  }

  const nickname = match[2]?.trim() || undefined;
  let rest = line.slice(match[0].length);
  const phoneHit = /^(\d{3,5}\s*\d{3,5})/.exec(rest);
  const phone = phoneHit ? phoneHit[1].replace(/\s+/g, " ") : undefined;
  if (phoneHit) rest = rest.slice(phoneHit[0].length).trimStart();

  let hadColon = false;
  if (/^[：:]/.test(rest)) {
    hadColon = true;
    rest = rest.replace(/^[：:]\s*/, "");
  }

  const headerDates: string[] = [];
  const headerSlots: string[] = [];
  for (let guard = 0; guard < 4; guard += 1) {
    const label = /^(?:時間|報更|更表|上班時間|可返時間|返工時間|備註)\s*[：:]/.exec(rest);
    if (label) {
      hadColon = true;
      rest = rest.slice(label[0].length).trimStart();
      continue;
    }
    const dateHit = DATE_TOKEN_RE.exec(rest);
    if (dateHit) {
      if (/[：:]\s*$/.test(dateHit[0])) hadColon = true;
      headerDates.push(dateHit[1]);
      rest = rest.slice(dateHit[0].length).trimStart();
      continue;
    }
    const timeHit = TIME_TOKEN_RE.exec(rest);
    if (timeHit) {
      if (/[：:]\s*$/.test(timeHit[0])) hadColon = true;
      headerSlots.push(timeHit[1]);
      rest = rest.slice(timeHit[0].length).trimStart();
      continue;
    }
    break;
  }

  const knownName =
    known.has(name.toLowerCase()) ||
    (nickname ? known.has(nickname.toLowerCase()) : false);
  const weekdayHint =
    extractWeekdayIndexes(rest).length > 0 &&
    (LEAVE_WORD_RE.test(rest) ||
      AVAILABLE_WORD_RE.test(rest) ||
      SHIFT_WORD_RE.test(rest) ||
      detectLeaveCode(rest) !== null);
  const isHeader =
    knownName ||
    Boolean(phone) ||
    hadColon ||
    headerDates.length > 0 ||
    headerSlots.length > 0 ||
    weekdayHint;
  if (!isHeader) return null;

  return {
    name,
    nickname,
    phone,
    raw: line.slice(match[0].length).trim(),
    headerDates,
    headerSlots,
    body: "",
    reserve,
  };
}

function splitReportBlocks(
  text: string,
  known: ReadonlySet<string>,
): ReportBlock[] {
  const blocks: ReportBlock[] = [];
  const byName = new Map<string, ReportBlock>();
  let reserveSection = false;

  const addBlock = (block: ReportBlock) => {
    const key = block.name.toLowerCase();
    const existing = byName.get(key);
    if (existing) {
      // 同一人分幾段報（微信常見）：合併而不是開新員工。
      existing.body = [existing.body, block.raw, block.body]
        .filter((part) => part.length > 0)
        .join("\n");
      existing.headerDates.push(...block.headerDates);
      existing.headerSlots.push(...block.headerSlots);
      return;
    }
    byName.set(key, block);
    blocks.push(block);
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\u3000/g, " ").trim();
    if (!line) continue;
    if (/後補名單|後備名單|後補\s*[：:]|後備\s*[：:]/.test(line)) {
      reserveSection = true;
      const inline = line.replace(/^.*?(?:後補名單|後備名單|後補|後備)\s*[：:]\s*/, "");
      for (const piece of inline.split(/[、,，]/)) {
        const trimmed = piece.trim();
        if (!trimmed) continue;
        const block = parseHeaderLine(trimmed, true, known);
        if (block) addBlock(block);
      }
      continue;
    }
    const header = parseHeaderLine(line, reserveSection, known);
    if (header) {
      addBlock(header);
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (last) last.body = last.body ? `${last.body}\n${line}` : line;
  }
  return blocks;
}

interface ReportedDate {
  date: string;
  code: LeaveCode | null;
  /** 該日期所在句子報出的時段（例如 ["18:00-22:00"]）。 */
  slots: string[];
}

interface DateHit {
  date: string;
  index: number;
}

function scanDateHits(text: string, weekStart: string): DateHit[] {
  const hits: DateHit[] = [];
  for (const match of text.matchAll(DATE_SCAN_RE)) {
    const token = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!token) continue;
    const iso = resolveDateToken(token, weekStart);
    if (iso) hits.push({ date: iso, index: match.index ?? 0 });
  }
  return hits;
}

/** 一個句子內：每個日期只認「跟住佢、下一個日期之前」出現的時段。 */
function collectReportDates(
  block: ReportBlock,
  weekStart: string,
  /** true = 只收集「放假」語意的日期（FT / HFT 用）。 */
  onlyLeave = false,
): ReportedDate[] {
  const out: ReportedDate[] = [];
  const push = (date: string, code: LeaveCode | null, slots: string[]) => {
    const existing = out.find((item) => item.date === date);
    if (existing) {
      if (!existing.code && code) existing.code = code;
      for (const slot of slots) {
        if (!existing.slots.includes(slot)) existing.slots.push(slot);
      }
      return;
    }
    out.push({ date, code, slots: [...slots] });
  };

  const clauses = [block.raw, block.body]
    .filter((part) => part.trim().length > 0)
    .flatMap((part) => part.split(/[，,。；;\n]/))
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);

  for (const clause of clauses) {
    const isRestrictive =
      AVAILABLE_WORD_RE.test(clause) ||
      /只可|可上|都可以/.test(clause) ||
      BLOCK_WORD_RE.test(clause);
    // FT 語意：報出的日期本身已經係「放假日」，只有明確限制句
    //（只可上早更／週末唔得／都可以）才唔當放假。
    if (onlyLeave && isRestrictive) continue;

    const code = detectLeaveCode(clause);
    const slots = extractReportSlots(clause);
    const dates = scanDateHits(clause, weekStart);
    if (dates.length > 0) {
      const marks = [
        ...dates.map((hit) => ({ kind: "date" as const, index: hit.index, date: hit.date })),
        ...slots.map((hit) => ({ kind: "slot" as const, index: hit.index, text: hit.text })),
      ].sort((left, right) => left.index - right.index);

      let current: string | null = null;
      for (const mark of marks) {
        if (mark.kind === "date") {
          current = mark.date;
          push(mark.date, code, []);
        } else if (current) {
          push(current, code, [mark.text]);
        }
      }
    }
    // 星期式報更（星期一至三放假）→ 屬於整句日期。
    const weekdayHits = scanWeekdayHits(clause);
    if (weekdayHits.length > 0) {
      const weekdaySlots = slots.map((hit) => hit.text);
      for (const hit of weekdayHits) {
        for (const iso of datesForWeekdays(hit.days, weekStart)) {
          push(iso, code, weekdaySlots);
        }
      }
    }
  }
  return out;
}

/**
 * 共用報更解析：
 * - DB 有 `employees` 時，一律以其 `employment_type` 決定語意方向。
 * - FT / HFT 報出的日期 = 請假／休息日（AL / SH / W），其餘日子照常可上班。
 * - PT 報出的日期 = 可上班日子，其餘日子不排更，且永不編入 AL / SH / W。
 */
export function interpretReportText(options: {
  text: string;
  weekStart: string;
  department?: string;
  employees?: readonly Employee[];
}): ReportInterpretation {
  const fallbackDepartment = options.department ?? "Superme Cafe";
  const week = weekDates(options.weekStart);
  const weekSet = new Set(week);

  const dbIndex = new Map<string, Employee>();
  for (const employee of options.employees ?? []) {
    dbIndex.set(employee.name.trim().toLowerCase(), employee);
    if (employee.nickname) {
      dbIndex.set(employee.nickname.trim().toLowerCase(), employee);
    }
  }
  const known = new Set<string>(dbIndex.keys());

  const warnings: string[] = [];
  const parsedEmployees: EmployeeAvailability[] = [];
  const leaveEntries: EmployeeLeaveEntry[] = [];
  const partTimeAvailableDates: Record<string, string[]> = {};
  const seen = new Set<string>();

  for (const block of splitReportBlocks(options.text, known)) {
    const db =
      dbIndex.get(block.name.toLowerCase()) ??
      (block.nickname ? dbIndex.get(block.nickname.toLowerCase()) : undefined);
    const name = db?.name ?? block.name;
    const key = name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const allText = [block.raw, block.body]
      .filter((part) => part.length > 0)
      .join(" ");
    const department = db?.department?.trim() || fallbackDepartment;

    if (block.reserve) {
      parsedEmployees.push({
        name,
        department,
        ...(db?.phone ? { phone: db.phone } : {}),
        reserve: true,
        category: "part_time",
        leave: [],
        available: {},
      });
      continue;
    }

    const guess = db
      ? { employment: db.employment_type, explicit: true }
      : guessEmployment(allText);
    if (!guess.explicit) {
      warnings.push(
        `${name} 未在員工資料庫亦未標明職級，暫按 FT（放假日解析）處理，請核對。`,
      );
    }

    const isPartTimeTarget = guess.employment === "PT";
    const reported = collectReportDates(block, options.weekStart, !isPartTimeTarget);
    const outside = reported.filter((item) => !weekSet.has(item.date));
    if (outside.length > 0) {
      warnings.push(
        `${name} 有 ${outside.length} 個日期不在 ${options.weekStart} 起的本週內，已忽略：${outside
          .map((item) => item.date)
          .join("、")}。`,
      );
    }
    const inWeek = reported.filter((item) => weekSet.has(item.date));

    if (guess.employment === "PT") {
      const dates = Array.from(new Set(inWeek.map((item) => item.date))).sort();
      const slots = extractReportSlots(allText);
      const globalShifts = shiftsFromText(allText);
      const fallbackShifts: WorkingShift[] =
        globalShifts.length > 0 ? globalShifts : ["AM", "PM"];
      const available: EmployeeAvailability["available"] = {};
      for (const item of inWeek) {
        // 每個日期用「自己那句」報出的時段，避免把 11/28 的時段蓋到 11/27。
        const own = extractReportSlots(item.slots.join(" "));
        const shiftsForDate =
          own.length > 0
            ? uniqueShifts(own.map((hit) => shiftForWindow(hit.start, hit.end)))
            : fallbackShifts;
        available[WEEKDAY_KEYS[parseISODate(item.date).getDay()]] = [...shiftsForDate];
      }
      partTimeAvailableDates[name] = dates;
      parsedEmployees.push({
        name,
        department,
        ...(db?.phone ? { phone: db.phone } : {}),
        category: STAFF_CATEGORY_BY_EMPLOYMENT.PT,
        leave: [],
        availableDates: dates,
        available,
      });
      const perDateSlots = inWeek
        .filter((item) => item.slots.length > 0)
        .map((item) => `${item.date.slice(5).replace("-", "/")} ${item.slots.join("／")}`);
      if (dates.length === 0) {
        warnings.push(`兼職 ${name} 未報任何可返日子，本週不排更。`);
      } else {
        warnings.push(
          `兼職 ${name} 可返日子：${dates.map((iso) => iso.slice(5).replace("-", "/")).join("、")}；未報出的其他日子不排更。`,
        );
      }
      if (perDateSlots.length > 0) {
        const labels = new Map(slots.map((slot) => [slot.text, slot.label]));
        const detail = perDateSlots.map((entry) => {
          const slotText = entry.split(" ")[1] ?? "";
          const label = labels.get(slotText);
          return `${entry}${label ? `（${label}）` : ""}`;
        });
        warnings.push(`兼職 ${name} 報更時段：${detail.join("；")}。`);
      } else if (slots.length > 0) {
        warnings.push(
          `兼職 ${name} 報更時段：${slots
            .map((slot) => `${slot.text}${slot.label ? `（${slot.label}）` : ""}`)
            .join("、")}。`,
        );
      }
      continue;
    }

    const blockCode = detectLeaveCode(allText);
    const leaveDates = Array.from(new Set(inWeek.map((item) => item.date))).sort();
    for (const item of inWeek) {
      leaveEntries.push({
        date: item.date,
        code: item.code ?? blockCode ?? "W",
        days: 1,
        employee: name,
      });
    }
    // 逐句解析 FT 時段偏好：分辨「可返邊個更」「邊個更唔得」「邊個星期幾」。
    const clauses = [block.raw, block.body]
      .filter((part) => part.trim().length > 0)
      .flatMap((part) => part.split(/[，,。；;\n]/))
      .map((clause) => clause.trim())
      .filter((clause) => clause.length > 0);

    const generalShifts: WorkingShift[] = [];
    const perWeekday = new Map<number, WorkingShift[]>();
    const blockedWeekdays = new Set<number>();
    let hasPreference = false;

    for (const clause of clauses) {
      if (LEAVE_WORD_RE.test(clause)) continue;
      const shifts = shiftsFromText(clause);
      const weekdays = Array.from(
        new Set(scanWeekdayHits(clause).flatMap((hit) => hit.days)),
      );
      const isBlock = BLOCK_WORD_RE.test(clause);
      if (shifts.length === 0 && !isBlock) continue;
      hasPreference = true;

      if (weekdays.length === 0) {
        if (isBlock) continue;
        for (const shift of shifts) {
          if (!generalShifts.includes(shift)) generalShifts.push(shift);
        }
        continue;
      }
      for (const day of weekdays) {
        if (isBlock) {
          blockedWeekdays.add(day);
          perWeekday.delete(day);
          continue;
        }
        const bucket = perWeekday.get(day) ?? [];
        for (const shift of shifts) {
          if (!bucket.includes(shift)) bucket.push(shift);
        }
        perWeekday.set(day, bucket);
      }
    }

    const available: EmployeeAvailability["available"] = {};
    if (hasPreference) {
      for (const iso of week) {
        if (leaveDates.includes(iso)) continue;
        const day = parseISODate(iso).getDay();
        if (blockedWeekdays.has(day)) continue;
        const own = perWeekday.get(day);
        const shifts =
          own && own.length > 0
            ? own
            : generalShifts.length > 0
              ? generalShifts
              : (["AM", "PM"] as WorkingShift[]);
        available[WEEKDAY_KEYS[day]] = uniqueShifts(shifts);
      }
    }
    parsedEmployees.push({
      name,
      department,
      ...(db?.phone ? { phone: db.phone } : {}),
      category: STAFF_CATEGORY_BY_EMPLOYMENT[guess.employment],
      leave: leaveDates,
      available,
    });
    if (leaveDates.length > 0) {
      warnings.push(
        `${name}（${guess.employment}）放假日：${leaveDates
          .map((iso) => iso.slice(5).replace("-", "/"))
          .join("、")}；其餘日子照常排更。`,
      );
    }
    if (!blockCode) {
      // 同一句未寫假種才算「預設 W」；有寫 AL/SH 就唔應該出誤導警告。
      const missingCode = inWeek.filter((item) => !item.code).length;
      if (missingCode > 0) {
        warnings.push(
          `${name}（${guess.employment}）有 ${missingCode} 日未標明假種，已按預設 W 處理，請核對。`,
        );
      }
    }
  }

  return {
    parsed: { employees: parsedEmployees },
    leaveEntries,
    partTimeAvailableDates,
    warnings,
    matched: parsedEmployees.length,
  };
}

export async function saveParsedDraft(options: {
  weekStart: string;
  department?: string;
  parsed: ParsedAvailability;
  mode: RosterMode;
  source: RosterSource;
  parseWarnings?: string[];
  /** 已帶假種代號的假期紀錄（AL / SH / W）。 */
  leaveEntries?: readonly EmployeeLeaveEntry[];
  /** PT 報更可返日子：姓名或 id → YYYY-MM-DD[]。 */
  partTimeAvailableDates?: Record<string, string[]>;
  /** DB employees：提供時以 DB 職級、固定更、例休為準。 */
  staff?: readonly Employee[];
}): Promise<IntakeSaveResult> {
  const scheduleResult = buildWeekSchedule({
    weekStart: options.weekStart,
    employees: options.parsed.employees,
    ...(options.leaveEntries ? { leaveEntries: options.leaveEntries } : {}),
    ...(options.partTimeAvailableDates
      ? { partTimeAvailableDates: options.partTimeAvailableDates }
      : {}),
    ...(options.staff ? { staff: options.staff } : {}),
  });

  const combinedWarnings: RosterWarning[] = [
    ...scheduleResult.warnings,
    ...(options.parseWarnings ?? []).map((msg) => ({
      date: options.weekStart,
      shift: "AM" as const,
      message: msg,
    })),
  ];

  const saveResult = await saveDraftRoster({
    weekStart: options.weekStart,
    isoWeek: getIsoWeekLabel(options.weekStart),
    department: options.department ?? options.parsed.employees[0]?.department ?? null,
    source: options.source,
    mode: options.mode,
    parsed: options.parsed,
    schedule: scheduleResult.schedule,
    warnings: combinedWarnings,
  });

  const warnings: RosterWarning[] = [
    ...combinedWarnings,
    ...(saveResult.error
      ? [
          {
            date: options.weekStart,
            shift: "AM" as const,
            message: saveResult.error,
          },
        ]
      : []),
  ];

  return {
    roster: {
      ...saveResult.roster,
      warnings,
    },
    persisted: saveResult.persisted,
    mode: options.mode,
    warnings,
  };
}

/**
 * 由 DB 讀在職員工名單（含 employment_type），供報更解析對齊職級。
 * 讀唔到（未設 Supabase／網絡問題）就回 null，唔會阻住報更流程。
 */
export async function loadEmployeeRoster(
  storeId: string = DEFAULT_STORE_ID,
): Promise<Employee[] | null> {
  try {
    const config = await getStoreConfig(storeId);
    return config.employees
      .filter((row) => row.is_active !== false)
      .map((row) => ({
        id: String(row.id ?? ""),
        store_id: String(row.store_id ?? storeId),
        name: String(row.name ?? ""),
        nickname: typeof row.nickname === "string" ? row.nickname : null,
        position: typeof row.position === "string" ? row.position : null,
        employment_type: isEmploymentType(row.employment_type)
          ? row.employment_type
          : "PT",
        fixed_shift_time:
          typeof row.fixed_shift_time === "string" ? row.fixed_shift_time : null,
        flexible_shift_options: Array.isArray(row.flexible_shift_options)
          ? row.flexible_shift_options.filter(
              (item): item is string => typeof item === "string",
            )
          : [],
        regular_days_off: Array.isArray(row.regular_days_off)
          ? row.regular_days_off.filter((item): item is number => typeof item === "number")
          : [],
        annual_leave_total: Number(row.annual_leave_total ?? 0),
        al_current_count: Number(row.al_current_count ?? 0),
        sh_current_count: Number(row.sh_current_count ?? 0),
        w_current_count: Number(row.w_current_count ?? 0),
        department: typeof row.department === "string" ? row.department : null,
        phone: typeof row.phone === "string" ? row.phone : null,
        is_active: true,
      }))
      .filter((employee) => employee.name.length > 0);
  } catch {
    return null;
  }
}

function isEmploymentType(value: unknown): value is EmploymentType {
  return value === "FT" || value === "HFT" || value === "PT";
}

export async function parseTextAndSave(options: {
  text: string;
  weekStart: string;
  department?: string;
  source?: RosterSource;
  extraWarnings?: string[];
  /** DB employees：優先依真實 employment_type 判定放假日／返工日語意。 */
  employees?: readonly Employee[];
}): Promise<IntakeSaveResult> {
  const parsedResult = await parseRosterFromText({
    text: options.text,
    weekStart: options.weekStart,
    department: options.department,
  });
  const dbEmployees = options.employees ?? (await loadEmployeeRoster()) ?? undefined;
  const interpretation = interpretReportText({
    text: options.text,
    weekStart: options.weekStart,
    department: options.department ?? "Superme Cafe",
    employees: dbEmployees,
  });
  return saveParsedDraft({
    weekStart: options.weekStart,
    department: options.department,
    parsed:
      interpretation.parsed.employees.length > 0
        ? interpretation.parsed
        : parsedResult.parsed,
    mode: parsedResult.mode,
    source: options.source ?? "text",
    leaveEntries: interpretation.leaveEntries,
    partTimeAvailableDates: interpretation.partTimeAvailableDates,
    staff: dbEmployees,
    parseWarnings: [
      ...parsedResult.warnings,
      ...interpretation.warnings,
      ...(options.extraWarnings ?? []),
    ],
  });
}

export async function parseImageAndSave(options: {
  imageBase64: string;
  mimeType: ImageIntake["mimeType"];
  weekStart: string;
  department?: string;
}): Promise<IntakeSaveResult> {
  const parsedResult = await parseRosterFromImage({
    imageBase64: options.imageBase64,
    mimeType: options.mimeType,
    weekStart: options.weekStart,
    department: options.department,
  });
  return saveParsedDraft({
    weekStart: options.weekStart,
    department: options.department,
    parsed: parsedResult.parsed,
    mode: parsedResult.mode,
    source: "image",
    parseWarnings: parsedResult.warnings,
  });
}

export function normalizeImageBase64(raw: string): string {
  return raw.includes(",") ? (raw.split(",")[1] ?? raw) : raw;
}

export function estimatedBase64Bytes(base64: string): number {
  return Math.floor((base64.length * 3) / 4);
}
