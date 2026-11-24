import type { EmployeeAvailability, ParsedAvailability } from "../types";

/** Monday 16 Nov 2026. ISO week 2026-W47. */
export const SAMPLE_WEEK_START = "2026-11-16";
export const SAMPLE_ISO_WEEK = "2026-W47";
export const SAMPLE_DEPARTMENT = "Superme Cafe";

/**
 * Fictional cafe availability for demos.
 * Includes full-day leave and shifts a person cannot work.
 */
export const sampleWeekRawText = `Superme Cafe 報更（11/16–11/22）

Jamie Cole 6000 1001：11/18 週三請假。週日只可上早更，其他日子早更、下午更都可以。
Noah Blake 6000 1002：全週只可上早更，唔可以排下午更。
Casey Quinn 6000 1003：週六、週日放假。週一至週五早更同下午更都可以。
Riley Shaw 6000 1004：只可上下午更，週末唔得。11/19 週四請假。`;

export const sampleWeekEmployees: EmployeeAvailability[] = [
  {
    name: "Jamie Cole",
    phone: "6000 1001",
    department: SAMPLE_DEPARTMENT,
    leave: ["2026-11-18"],
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
    leave: ["2026-11-21", "2026-11-22"],
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
    leave: ["2026-11-19"],
    available: {
      mon: ["PM"],
      tue: ["PM"],
      wed: ["PM"],
      fri: ["PM"],
    },
  },
];

export const sampleWeekParsed: ParsedAvailability = {
  employees: sampleWeekEmployees,
};
