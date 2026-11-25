import type { EmployeeAvailability, ParsedAvailability, WeekdayKey, WorkingShift } from "../types";
import { parseISODate, weekDates, weekdayKeyFromDate } from "./rules";

const WEEKDAY_ORDER: WeekdayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const DAY_CHAR: Record<string, WeekdayKey> = {
  日: "sun",
  天: "sun",
  一: "mon",
  二: "tue",
  三: "wed",
  四: "thu",
  五: "fri",
  六: "sat",
};

const NAME_RE =
  /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+|[\u4e00-\u9fff]{2,4})(?:\s+(\d{3,5}\s*\d{3,5}))?\s*[：:]?\s*([\s\S]*)$/;

interface Draft {
  name: string;
  phone?: string;
  reserve: boolean;
  leave: Set<string>;
  slots: Map<WeekdayKey, Set<WorkingShift>>;
  mentioned: boolean;
  generalShifts: WorkingShift[] | null;
  blockedDays: Set<WeekdayKey>;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function resolveMonthDay(month: number, day: number, weekStart: string): string | null {
  const year = Number(weekStart.slice(0, 4));
  const inWeek = new Set(weekDates(weekStart));
  for (const candidateYear of [year, year + 1, year - 1]) {
    const iso = `${candidateYear}-${pad(month)}-${pad(day)}`;
    try {
      parseISODate(iso);
    } catch {
      continue;
    }
    if (inWeek.has(iso)) return iso;
  }
  const fallback = `${year}-${pad(month)}-${pad(day)}`;
  try {
    parseISODate(fallback);
    return fallback;
  } catch {
    return null;
  }
}

function extractDates(text: string, weekStart: string): string[] {
  const found: string[] = [];
  const re = /(\d{4})-(\d{2})-(\d{2})|(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/g;
  for (const match of text.matchAll(re)) {
    if (match[1]) {
      found.push(`${match[1]}-${match[2]}-${match[3]}`);
      continue;
    }
    const month = Number(match[4]);
    const day = Number(match[5]);
    const yearRaw = match[6];
    if (yearRaw) {
      const year = yearRaw.length === 2 ? 2000 + Number(yearRaw) : Number(yearRaw);
      const iso = `${year}-${pad(month)}-${pad(day)}`;
      try {
        parseISODate(iso);
        found.push(iso);
      } catch {
        /* skip invalid */
      }
      continue;
    }
    const iso = resolveMonthDay(month, day, weekStart);
    if (iso) found.push(iso);
  }
  return found;
}

function expandRange(start: WeekdayKey, end: WeekdayKey): WeekdayKey[] {
  const from = WEEKDAY_ORDER.indexOf(start);
  const to = WEEKDAY_ORDER.indexOf(end);
  const days: WeekdayKey[] = [];
  let index = from;
  for (let step = 0; step < 7; step += 1) {
    days.push(WEEKDAY_ORDER[index]);
    if (index === to) break;
    index = (index + 1) % 7;
  }
  return days;
}

function extractWeekdays(text: string): WeekdayKey[] {
  if (/週末|周末/.test(text)) return ["sat", "sun"];
  const days: WeekdayKey[] = [];
  const seen = new Set<WeekdayKey>();
  const re = /(?:星期|週|周)?([日天一二三四五六])(?:\s*(?:至|到|-)\s*(?:星期|週|周)?([日天一二三四五六]))?/g;
  for (const match of text.matchAll(re)) {
    const start = DAY_CHAR[match[1]];
    const end = match[2] ? DAY_CHAR[match[2]] : undefined;
    const chunk = end ? expandRange(start, end) : [start];
    for (const day of chunk) {
      if (seen.has(day)) continue;
      seen.add(day);
      days.push(day);
    }
  }
  return days;
}

function extractShifts(text: string): WorkingShift[] | null {
  const hasAm = /早更|早班|上午|\bAM\b/i.test(text);
  const hasPm = /下午更|下午班|午更|下午|\bPM\b/i.test(text);
  const hasEve = /晚更|晚班|\bEVE\b/i.test(text);
  if (!hasAm && !hasPm && !hasEve) return null;
  const shifts: WorkingShift[] = [];
  if (hasAm) shifts.push("AM");
  if (hasPm) shifts.push("PM");
  if (hasEve) shifts.push("EVE");
  return shifts;
}

function datesForWeekdays(days: WeekdayKey[], weekStart: string): string[] {
  return weekDates(weekStart).filter((iso) => days.includes(weekdayKeyFromDate(iso)));
}

function addSlots(draft: Draft, days: WeekdayKey[], shifts: WorkingShift[]) {
  draft.mentioned = true;
  for (const day of days) {
    const bucket = draft.slots.get(day) ?? new Set<WorkingShift>();
    for (const shift of shifts) bucket.add(shift);
    draft.slots.set(day, bucket);
  }
}

function applyClause(draft: Draft, clause: string, weekStart: string) {
  const text = clause.trim();
  if (!text) return;
  const dates = extractDates(text, weekStart);
  const days = extractWeekdays(text);
  const shifts = extractShifts(text);
  const isLeave = /請假|放假|告假/.test(text);
  const isBlock = /唔得|唔可以|不能|不可|唔排/.test(text);
  const isAll = /全週|全日|每日/.test(text);
  const isRest = /其餘|其他日子|其他日/.test(text);

  if (isLeave && dates.length > 0 && !shifts) {
    for (const date of dates) draft.leave.add(date);
    return;
  }
  if (isLeave && days.length > 0 && !shifts && !/都可以|可上/.test(text)) {
    for (const date of datesForWeekdays(days, weekStart)) draft.leave.add(date);
    return;
  }
  if (isBlock) {
    const targetDays = days.length > 0 ? days : [...WEEKDAY_ORDER];
    if (!shifts) {
      for (const day of targetDays) draft.blockedDays.add(day);
      draft.mentioned = true;
      return;
    }
    for (const day of targetDays) {
      const bucket = draft.slots.get(day) ?? new Set<WorkingShift>();
      for (const shift of shifts) bucket.delete(shift);
      draft.slots.set(day, bucket);
    }
    return;
  }

  const targetShifts = shifts ?? ["AM", "PM"];
  const positive = Boolean(shifts || days.length > 0 || isAll || isRest || /都可以|可上|只可/.test(text));
  if (!positive) return;
  if (days.length > 0 && !isAll && !isRest) {
    addSlots(draft, days, targetShifts);
    return;
  }
  draft.generalShifts = targetShifts;
  draft.mentioned = true;
}

function draftFromBody(name: string, phone: string | undefined, body: string, reserve: boolean, weekStart: string): Draft {
  const draft: Draft = {
    name,
    phone,
    reserve,
    leave: new Set<string>(),
    slots: new Map(),
    mentioned: false,
    generalShifts: null,
    blockedDays: new Set(),
  };
  for (const clause of body.split(/[，,。；;\n]/)) {
    applyClause(draft, clause, weekStart);
  }
  if (draft.generalShifts) {
    for (const day of WEEKDAY_ORDER) {
      if (draft.slots.has(day)) continue;
      addSlots(draft, [day], draft.generalShifts);
    }
  } else if (!draft.mentioned) {
    addSlots(draft, [...WEEKDAY_ORDER], ["AM", "PM"]);
  }
  for (const day of draft.blockedDays) draft.slots.delete(day);
  for (const [day, shifts] of draft.slots) {
    if (shifts.size === 0) draft.slots.delete(day);
  }
  return draft;
}

function toEmployee(draft: Draft, department: string): EmployeeAvailability {
  const available: EmployeeAvailability["available"] = {};
  for (const day of WEEKDAY_ORDER) {
    const shifts = draft.slots.get(day);
    if (!shifts || shifts.size === 0) continue;
    available[day] = (["AM", "PM", "EVE"] as WorkingShift[]).filter((shift) => shifts.has(shift));
  }
  return {
    name: draft.name,
    department,
    ...(draft.phone ? { phone: draft.phone } : {}),
    ...(draft.reserve ? { reserve: true, category: "part_time" as const } : {}),
    leave: [...draft.leave].sort(),
    available,
  };
}

function pushPerson(people: Draft[], seen: Set<string>, draft: Draft) {
  const key = draft.name.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  people.push(draft);
}

/** Read WhatsApp / WeChat availability text into staff the scheduler can use. */
export function parseAvailabilityText(
  text: string,
  weekStart: string,
  department = "Superme Cafe",
): ParsedAvailability {
  const people: Draft[] = [];
  const seen = new Set<string>();
  let reserveSection = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/後補名單|後備名單|後補：|後備：/.test(line)) {
      reserveSection = true;
      const inline = line.replace(/^.*(?:後補名單|後備名單|後補|後備)\s*[：:]\s*/, "");
      if (inline && inline !== line) {
        for (const piece of inline.split(/[、,，]/)) {
          const match = piece.trim().match(NAME_RE);
          if (!match) continue;
          pushPerson(
            people,
            seen,
            draftFromBody(match[1].trim(), match[2]?.replace(/\s+/g, " "), match[3] ?? "", true, weekStart),
          );
        }
      }
      continue;
    }
    if (/報更/.test(line) && !/[：:]/.test(line) && !/請假|放假|早更|下午|\bAM\b|\bPM\b/i.test(line)) {
      continue;
    }

    const match = line.match(NAME_RE);
    if (!match) continue;
    pushPerson(
      people,
      seen,
      draftFromBody(match[1].trim(), match[2]?.replace(/\s+/g, " "), match[3] ?? "", reserveSection, weekStart),
    );
  }

  return {
    employees: people.map((draft) => toEmployee(draft, department)),
  };
}
