/** Working shifts plus an explicit rest cell. */
export const SHIFTS = ["AM", "PM", "OFF"] as const;
export type Shift = (typeof SHIFTS)[number];

/** Shifts that require coverage. OFF is the absence of an assignment. */
export const WORKING_SHIFTS = ["AM", "PM"] as const;
export type WorkingShift = (typeof WORKING_SHIFTS)[number];

export const WEEKDAY_KEYS = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

export const WEEKDAY_LABELS: Record<WeekdayKey, string> = {
  mon: "星期一",
  tue: "星期二",
  wed: "星期三",
  thu: "星期四",
  fri: "星期五",
  sat: "星期六",
  sun: "星期日",
};

export const ROSTER_STATUSES = ["draft", "approved"] as const;
export type RosterStatus = (typeof ROSTER_STATUSES)[number];

export type RosterSource = "text" | "image" | "mock" | "webhook";
export type RosterMode = "live" | "mock";

export interface TextIntake {
  kind: "text";
  text: string;
  /** Monday of the target week, YYYY-MM-DD. */
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

/** One employee's leave dates and shifts they can actually work. */
export interface EmployeeAvailability {
  name: string;
  department: string;
  /** ISO dates (YYYY-MM-DD). Leave overrides anything listed in `available`. */
  leave: string[];
  /**
   * Shifts the employee can work, keyed by weekday.
   * A missing day, or a missing shift, means they must not be scheduled.
   */
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
}

/** One Monday–Sunday roster grid. Unassigned cells are OFF, not stored here. */
export interface Schedule {
  days: string[];
  shifts: WorkingShift[];
  assignments: Assignment[];
}

export interface RosterWarning {
  date: string;
  shift: WorkingShift;
  /** Example: `11/22 PM 人手不足` */
  message: string;
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
