/** Working shifts plus an explicit rest cell. */
export const SHIFTS = ["AM", "PM", "OFF"] as const;
export type Shift = (typeof SHIFTS)[number];

/** Shifts that require coverage. OFF is the absence of an assignment. */
export const WORKING_SHIFTS = ["AM", "PM"] as const;
export type WorkingShift = (typeof WORKING_SHIFTS)[number];

/** Week starts on Sunday (Day 1) and ends on Saturday (Day 7). */
export const WEEKDAY_KEYS = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

export const WEEKDAY_LABELS: Record<WeekdayKey, string> = {
  sun: "星期日",
  mon: "星期一",
  tue: "星期二",
  wed: "星期三",
  thu: "星期四",
  fri: "星期五",
  sat: "星期六",
};

export type StaffCategory = "full_time" | "half_full_time" | "part_time";

export const ROSTER_STATUSES = ["draft", "approved"] as const;
export type RosterStatus = (typeof ROSTER_STATUSES)[number];

export type RosterSource = "text" | "image" | "mock" | "webhook";
export type RosterMode = "live" | "mock";

export interface TextIntake {
  kind: "text";
  text: string;
  /** Start date of the target week (Sunday), YYYY-MM-DD. */
  weekStart?: string;
  department?: string;
}

export interface ImageIntake {
  kind: "image";
  imageBase64: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  weekStart?: string;
  department?: string;
}

export interface MockIntake {
  kind: "mock";
  weekStart?: string;
  department?: string;
}

export type IntakeInput = TextIntake | ImageIntake | MockIntake;

export interface EmployeeAvailability {
  name: string;
  department: string;
  category?: StaffCategory;
  /** Full-time / half-full-time requested off dates (YYYY-MM-DD). */
  leave: string[];
  /** Part-time available work dates (YYYY-MM-DD). */
  availableDates?: string[];
  /** Optional shift preference by weekday. */
  available: Partial<Record<WeekdayKey, WorkingShift[]>>;
}

export interface ParsedAvailability {
  employees: EmployeeAvailability[];
}

export interface Assignment {
  date: string;
  shift: WorkingShift;
  employee: string;
  department: string;
  hours?: number;
  timeSlot?: string;
}

export interface DailyHourSummary {
  date: string;
  totalHours: number;
  headcount: number;
}

export interface EmployeeHourSummary {
  employee: string;
  totalHours: number;
  shiftsCount: number;
}

export interface Schedule {
  days: string[];
  shifts: WorkingShift[];
  assignments: Assignment[];
  dailyHours?: DailyHourSummary[];
  employeeHours?: EmployeeHourSummary[];
}

export interface RosterWarning {
  date: string;
  shift: WorkingShift;
  message: string;
  needsManagerAction?: boolean;
}

export interface ScheduleResult {
  schedule: Schedule;
  warnings: RosterWarning[];
}

export interface WeekRoster {
  id: string | null;
  weekStart: string;
  isoWeek: string;
  status: RosterStatus;
  department: string | null;
  source: RosterSource;
  mode: RosterMode;
  parsed: ParsedAvailability;
  schedule: Schedule;
  warnings: RosterWarning[];
  createdAt: string | null;
  approvedAt: string | null;
}