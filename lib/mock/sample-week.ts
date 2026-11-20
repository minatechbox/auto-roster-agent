import type { EmployeeAvailability, ParsedAvailability } from "../types";

/** Monday 16 Nov 2026. ISO week 2026-W47. */
export const SAMPLE_WEEK_START = "2026-11-16";
export const SAMPLE_ISO_WEEK = "2026-W47";
export const SAMPLE_DEPARTMENT = "門市";

/**
 * WhatsApp-style availability for one shop week.
 * Includes full-day leave and shifts a person cannot work.
 */
export const sampleWeekRawText = `旺角門市報更（11/16–11/22）

陳大文：11/18 週三請假返鄉下。週日只可上早更（要返教會），其他日子早更、下午更都可以。
李小美：全週只可上早更，下午要接小朋友，唔可以排下午更。
黃志強：週六、週日放假。週一至週五早更同下午更都可以。
張詠詩：只可上下午更，週末唔得。11/19 週四睇醫生請假。`;

export const sampleWeekEmployees: EmployeeAvailability[] = [
  {
    name: "陳大文",
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
    name: "李小美",
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
    name: "黃志強",
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
    name: "張詠詩",
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
