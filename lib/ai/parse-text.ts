import type { ParsedAvailability, RosterMode } from "@/lib/types";
import { getServerEnv } from "../env";
import { sampleWeekParsed } from "../mock/sample-week";
import { parseAndValidateRosterJson } from "./schema";

export interface ParseOutcome {
  parsed: ParsedAvailability;
  mode: RosterMode;
  warnings: string[];
}

const SYSTEM_PROMPT = `你是排班報更結構化解析器。請只回傳嚴格符合以下 JSON 結構的純文字，不要加 markdown 圍欄或額外說明：
{
  "employees": [
    {
      "name": "員工姓名",
      "department": "部門名稱",
      "leave": ["YYYY-MM-DD"],
      "available": {
        "mon": ["AM", "PM"],
        "tue": ["AM"],
        "wed": ["AM", "PM"],
        "thu": ["AM", "PM"],
        "fri": ["AM", "PM"],
        "sat": ["AM", "PM"],
        "sun": ["AM"]
      }
    }
  ]
}
規則：
1. 若某天未特別限制可用更別且非請假，可填 ["AM", "PM"]；若只可早更填 ["AM"]，只可午更填 ["PM"]，全日不可填 []。
2. 請假日期必須轉為 YYYY-MM-DD 格式放入 leave。`;

export async function parseRosterFromText(options: {
  text: string;
  weekStart: string;
  department?: string;
}): Promise<ParseOutcome> {
  const env = getServerEnv();

  if (!env.aiApiKey) {
    const cloned: ParsedAvailability = JSON.parse(JSON.stringify(sampleWeekParsed));
    if (options.department?.trim()) {
      for (const emp of cloned.employees) {
        emp.department = options.department.trim();
      }
    }
    return {
      parsed: cloned,
      mode: "mock",
      warnings: ["未設定 AI_API_KEY，本次文字報更已改用內建模擬解析結果。"],
    };
  }

  const userPrompt = `排班週期起始日（星期日）：${options.weekStart}\n${
    options.department ? `預設部門：${options.department}\n` : ""
  }報更原文：\n${options.text}`;

  const response = await fetch(`${env.aiApiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.aiApiKey}`,
    },
    body: JSON.stringify({
      model: env.aiTextModel,
      temperature: 0.1,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`外部 AI 文字解析請求失敗（HTTP ${response.status}）。`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("外部 AI 未回傳任何文字內容。");
  }

  const validated = parseAndValidateRosterJson(content, options.department);
  if (!validated.ok) {
    const err = new Error(validated.reason) as Error & { code?: string };
    err.code = "SCHEMA_VALIDATION_FAILED";
    throw err;
  }

  return {
    parsed: validated.data,
    mode: "live",
    warnings: [],
  };
}