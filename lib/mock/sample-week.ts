import type { EmployeeAvailability, ParsedAvailability } from "../types";

/** Sunday 22 Nov 2026. Cafe week 週日–週六. */
export const SAMPLE_WEEK_START = "2026-11-22";
export const SAMPLE_ISO_WEEK = "2026-W48";
export const SAMPLE_DEPARTMENT = "Superme Cafe";

/**
 * Fictional cafe availability for demos.
 * Includes full-day leave and shifts a person cannot work.
 */
export const sampleWeekRawText = `Superme Cafe 報更（11/22–11/28）

Jamie Cole 6000 1001：11/25 週三請假。週日只可上早更，其他日子早更、下午更都可以。
Noah Blake 6000 1002：全週只可上早更，唔可以排下午更。
Casey Quinn 6000 1003：週六、週日放假。週一至週五早更同下午更都可以。
Riley Shaw 6000 1004：只可上下午更，週末唔得。11/26 週四請假。
Avery Kim 6000 1005：11/25 請假，其餘日子早更、下午更都可以。
Jordan Hale 6000 1006：全週只可上早更。
Morgan Ellis 6000 1007：只可星期一、三、五、六下午更。
Taylor Brooks 6000 1008：11/27 請假，其餘日子早更、下午更都可以。
Parker Nguyen 6000 1009：週一至週五只可上下午更，週末唔得。
Quinn Adler 6000 1010：只可星期日、二、四早更。

後補名單：
Reese Dalton 6000 1011：早更、下午更都可以。
Skyler Ortiz 6000 1012：只可上早更。
Hayden Cho 6000 1013：只可上下午更。
Rowan Patel 6000 1014：週末早更、下午更都可以。`;

export const sampleWeekEmployees: EmployeeAvailability[] = [
  {
    name: "Jamie Cole",
    phone: "6000 1001",
    department: SAMPLE_DEPARTMENT,
    leave: ["2026-11-25"],
    available: {
      mon: ["AM", "PM"],
      tue: ["AM", "PM"],
      thu: ["AM", "PM"],
      fri: ["AM", "PM"],
      sat: ["AM", "PM"],
      sun: ["AM"],
    },
  },
  {
    name: "Noah Blake",
    phone: "6000 1002",
    department: SAMPLE_DEPARTMENT,
    leave: [],
    available: {
      mon: ["AM"],
      tue: ["AM"],
      wed: ["AM"],
      thu: ["AM"],
      fri: ["AM"],
      sat: ["AM"],
      sun: ["AM"],
    },
  },
  {
    name: "Casey Quinn",
    phone: "6000 1003",
    department: SAMPLE_DEPARTMENT,
    leave: ["2026-11-22", "2026-11-28"],
    available: {
      mon: ["AM", "PM"],
      tue: ["AM", "PM"],
      wed: ["AM", "PM"],
      thu: ["AM", "PM"],
      fri: ["AM", "PM"],
    },
  },
  {
    name: "Riley Shaw",
    phone: "6000 1004",
    department: SAMPLE_DEPARTMENT,
    leave: ["2026-11-26"],
    available: {
      mon: ["PM"],
      tue: ["PM"],
      wed: ["PM"],
      fri: ["PM"],
    },
  },
  {
    name: "Avery Kim",
    phone: "6000 1005",
    department: SAMPLE_DEPARTMENT,
    category: "full_time",
    leave: ["2026-11-25"],
    available: {
      sun: ["AM", "PM"],
      mon: ["AM", "PM"],
      tue: ["AM", "PM"],
      wed: ["AM", "PM"],
      thu: ["AM", "PM"],
      fri: ["AM", "PM"],
      sat: ["AM", "PM"],
    },
  },
  {
    name: "Jordan Hale",
    phone: "6000 1006",
    department: SAMPLE_DEPARTMENT,
    category: "half_full_time",
    leave: [],
    available: {
      sun: ["AM"],
      mon: ["AM"],
      tue: ["AM"],
      wed: ["AM"],
      thu: ["AM"],
      fri: ["AM"],
      sat: ["AM"],
    },
  },
  {
    name: "Morgan Ellis",
    phone: "6000 1007",
    department: SAMPLE_DEPARTMENT,
    category: "part_time",
    leave: [],
    available: {
      mon: ["PM"],
      wed: ["PM"],
      fri: ["PM"],
      sat: ["PM"],
    },
  },
  {
    name: "Taylor Brooks",
    phone: "6000 1008",
    department: SAMPLE_DEPARTMENT,
    category: "full_time",
    leave: ["2026-11-27"],
    available: {
      sun: ["AM", "PM"],
      mon: ["AM", "PM"],
      tue: ["AM", "PM"],
      wed: ["AM", "PM"],
      thu: ["AM", "PM"],
      fri: ["AM", "PM"],
      sat: ["AM", "PM"],
    },
  },
  {
    name: "Parker Nguyen",
    phone: "6000 1009",
    department: SAMPLE_DEPARTMENT,
    category: "half_full_time",
    leave: [],
    available: {
      mon: ["PM"],
      tue: ["PM"],
      wed: ["PM"],
      thu: ["PM"],
      fri: ["PM"],
    },
  },
  {
    name: "Quinn Adler",
    phone: "6000 1010",
    department: SAMPLE_DEPARTMENT,
    category: "part_time",
    leave: [],
    available: {
      sun: ["AM"],
      tue: ["AM"],
      thu: ["AM"],
    },
  },
  {
    name: "Reese Dalton",
    phone: "6000 1011",
    department: SAMPLE_DEPARTMENT,
    category: "part_time",
    reserve: true,
    leave: [],
    available: {
      sun: ["AM", "PM"],
      mon: ["AM", "PM"],
      tue: ["AM", "PM"],
      wed: ["AM", "PM"],
      thu: ["AM", "PM"],
      fri: ["AM", "PM"],
      sat: ["AM", "PM"],
    },
  },
  {
    name: "Skyler Ortiz",
    phone: "6000 1012",
    department: SAMPLE_DEPARTMENT,
    category: "part_time",
    reserve: true,
    leave: [],
    available: {
      sun: ["AM"],
      mon: ["AM"],
      tue: ["AM"],
      wed: ["AM"],
      thu: ["AM"],
      fri: ["AM"],
      sat: ["AM"],
    },
  },
  {
    name: "Hayden Cho",
    phone: "6000 1013",
    department: SAMPLE_DEPARTMENT,
    category: "part_time",
    reserve: true,
    leave: [],
    available: {
      mon: ["PM"],
      tue: ["PM"],
      wed: ["PM"],
      thu: ["PM"],
      fri: ["PM"],
      sat: ["PM"],
    },
  },
  {
    name: "Rowan Patel",
    phone: "6000 1014",
    department: SAMPLE_DEPARTMENT,
    category: "part_time",
    reserve: true,
    leave: [],
    available: {
      sun: ["AM", "PM"],
      sat: ["AM", "PM"],
    },
  },
];

export const sampleWeekParsed: ParsedAvailability = {
  employees: sampleWeekEmployees,
};

/** 10 rostered staff + 4 reserve, labelled for the demo cafe. */
export function cloneSampleWeekParsed(department?: string): ParsedAvailability {
  const cloned: ParsedAvailability = JSON.parse(JSON.stringify(sampleWeekParsed));
  const dept = department?.trim() || SAMPLE_DEPARTMENT;
  for (const emp of cloned.employees) {
    emp.department = dept;
  }
  return cloned;
}
