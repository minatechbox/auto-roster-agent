/** Working shifts plus an explicit rest cell. */
export const SHIFTS = ["AM", "PM", "EVE", "OFF"] as const;
export type Shift = (typeof SHIFTS)[number];

/** Shifts that require coverage. OFF is the absence of an assignment. */
export const WORKING_SHIFTS = ["AM", "PM", "EVE"] as const;
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
  /** Demo contact only. Never store a real phone number in source. */
  phone?: string;
  /** Standby staff. Listed on the reserve roster and not auto-scheduled. */
  reserve?: boolean;
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
  /** 半日放假 + 半日上班（通常 FT 的 days: 0.5）。 */
  halfDayLeave?: LeaveEntry;
  /**
   * 當日工時加減：正數 = OT 多返時數；負數 = 補鐘早收或欠公司鐘。
   * 完全動態，不寫死上限。
   */
  hoursAdjustment?: number;
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
  /** 每月工時（跨週累計）。 */
  monthlyHours?: EmployeeMonthlyHours[];
  /** 補鐘時數（OT 補鐘制）。 */
  compTimeHours?: EmployeeHoursAllocation[];
  /** 轉薪金 OT 時數（OT 現金制）。 */
  payableOtHours?: EmployeeHoursAllocation[];
  /** 年終 AL 結算摘要。 */
  alSettlement?: AlSettlementSummary[];
  /** 列印／匯出時要顯示邊幾項。 */
  printOptions?: PrintOptions;
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

// ─────────────────────────────────────────────
// 職級：FT / HFT / PT（對齊 employees.employment_type）
// ─────────────────────────────────────────────
export const EMPLOYMENT_TYPES = ["FT", "HFT", "PT"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

/** 舊 StaffCategory ↔ 新 EmploymentType 對照。 */
export const STAFF_CATEGORY_BY_EMPLOYMENT: Record<EmploymentType, StaffCategory> = {
  FT: "full_time",
  HFT: "half_full_time",
  PT: "part_time",
};

export const EMPLOYMENT_BY_STAFF_CATEGORY: Record<StaffCategory, EmploymentType> = {
  full_time: "FT",
  half_full_time: "HFT",
  part_time: "PT",
};

// ─────────────────────────────────────────────
// 假期代號：單一累計編號（W50 / SH15 / AL6）
// ─────────────────────────────────────────────
export const LEAVE_CODES = ["AL", "SH", "W"] as const;
export type LeaveCode = (typeof LEAVE_CODES)[number];

export interface LeaveEntry {
  /** YYYY-MM-DD */
  date: string;
  code: LeaveCode;
  /** 已組好的顯示字串，例如 "W50"、"SH15"、"AL6"。 */
  label?: string;
  /** 1 = 全日；0.5 = 半日（主要供 FT 放半日假，累計如 AL5.5）。 */
  days: 0.5 | 1;
}

// ─────────────────────────────────────────────
// 營業時段：六大時段（沿用 roster_rules.period_headcount 的 key）
// ─────────────────────────────────────────────
export const SERVICE_PERIOD_IDS = [
  "opening",
  "breakfast",
  "lunch",
  "tea",
  "dinner",
  "closing",
] as const;
export type ServicePeriodKey = (typeof SERVICE_PERIOD_IDS)[number];

/** 六大營業時段所需人數：全部必填。 */
export type PeriodHeadcount = Record<ServicePeriodKey, number>;

/** 各職級標準日工時（小時）。FT 10h（5h = 0.5 半日）；HFT 5h，不設拆半。 */
export const STANDARD_DAILY_HOURS: Record<EmploymentType, number> = {
  FT: 10,
  HFT: 5,
  PT: 4,
};

export interface ShiftTimeSlot {
  id: ServicePeriodKey;
  /** HH:mm */
  start: string;
  /** HH:mm */
  end: string;
}

/** 每職級上限／數值，例如 {"FT":10,"HFT":5,"PT":4}。 */
export type HoursByEmployment = Partial<Record<EmploymentType, number>>;

// ─────────────────────────────────────────────
// 資料庫實體（snake_case，對齊 supabase/schema.sql）
// ─────────────────────────────────────────────
export interface Store {
  id: string;
  store_name: string;
  address: string | null;
  phone: string | null;
  allowed_group_id: string | null;
  created_at?: string;
}

export interface Employee {
  id: string;
  store_id: string;
  name: string;
  nickname: string | null;
  position: string | null;
  employment_type: EmploymentType;
  /** 固定上班時間，例如 "11:00-21:00"。 */
  fixed_shift_time: string | null;
  /** 第一關補缺口用的彈性時間選項。 */
  flexible_shift_options: string[];
  /** 固定例休 weekday key（0=Sun … 6=Sat）。 */
  regular_days_off: number[];
  annual_leave_total: number;
  al_current_count: number;
  sh_current_count: number;
  w_current_count: number;
  /** 超 10 小時 OT 補鐘或轉薪金。 */
  ot_compensation_mode?: "time_off" | "cash";
  department: string | null;
  phone: string | null;
  is_active: boolean;
}

export interface ReserveStaff {
  id: string;
  store_id: string;
  name: string;
  nickname: string | null;
  position: string | null;
  employment_type: EmploymentType;
  department: string | null;
  phone: string | null;
  /** 數字越細越優先被呼叫。 */
  priority: number;
  is_active: boolean;
}

export interface WeeklyRestRule {
  workDays: number;
  restDays: number;
  cycleDays: number;
}

export interface AlSettlementRule {
  settleMonth: number;
  settleDay: number;
  convertRemainingToSalary: boolean;
  resetCurrentCount: boolean;
}

export interface RosterRules {
  id: string;
  store_id: string;
  department: string | null;
  period_headcount: PeriodHeadcount;
  max_daily_hours: HoursByEmployment;
  max_weekly_hours: HoursByEmployment;
  statutory_holidays_yearly: number;
  weekly_rest_rule: WeeklyRestRule;
  al_settlement_rule: AlSettlementRule;
  shift_time_slots: ShiftTimeSlot[];
  created_at?: string;
}

export interface RosterTemplate {
  id: string;
  store_id: string;
  template_name: string;
  department: string | null;
  schedule: Schedule;
  daily_hours_summary: DailyHourSummary[];
  weekly_hours_summary: EmployeeWeeklyHours[];
  monthly_hours_summary: EmployeeMonthlyHours[];
  created_at?: string;
}

// ─────────────────────────────────────────────
// 工時統計：每日 / 每週 / 每月
// ─────────────────────────────────────────────
export interface EmployeeDailyHours {
  /** YYYY-MM-DD */
  date: string;
  employee: string;
  totalHours: number;
  /** 超出該職級每日上限的部分。 */
  overtimeHours?: number;
  /** 當日工時加減（正 = OT；負 = 補鐘早收／欠鐘）。 */
  hoursAdjustment?: number;
  /** 可正可負的時間結餘：正數 = 可補鐘餘額；負數 = 欠公司鐘。 */
  timeBalanceHours?: number;
  leave?: LeaveEntry[];
}

export interface EmployeeWeeklyHours {
  /** 該週的星期日 YYYY-MM-DD */
  weekStart: string;
  employee: string;
  totalHours: number;
  daysWorked: number;
  /** 可正可負的時間結餘（正 = 累計可補鐘；負 = 欠公司鐘）。 */
  timeBalanceHours?: number;
}

export interface EmployeeMonthlyHours {
  /** YYYY-MM */
  yearMonth: string;
  employee: string;
  totalHours: number;
  daysWorked: number;
  /** 可正可負的時間結餘（正 = 累計可補鐘；負 = 欠公司鐘）。 */
  timeBalanceHours?: number;
}

/** 補鐘／轉薪金 OT 的分配明細。 */
export interface EmployeeHoursAllocation {
  employee: string;
  overtimeHours: number;
  /** time_off = 補鐘；cash = 轉薪金。 */
  mode: "time_off" | "cash";
}

/** 年終 AL 結算：剩餘大假轉薪金。 */
export interface AlSettlementSummary {
  year: number;
  employee: string;
  /** 結算前剩餘 AL 日數。 */
  remainingAl: number;
  convertedToSalary: boolean;
  convertedDays?: number;
  salaryAmount?: number;
  settledAt?: string;
}

// ─────────────────────────────────────────────
// 列印／匯出選項
// ─────────────────────────────────────────────
export interface PrintOptions {
  showDailyHours?: boolean;
  showMonthlyHours: boolean;
  showCompTimeHours: boolean;
  showPayableOtHours: boolean;
  showAlSettlement: boolean;
}