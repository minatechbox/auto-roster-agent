import type { ParsedAvailability } from "@/lib/types";
import { getServerEnv } from "../env";
import { sampleWeekParsed } from "../mock/sample-week";
import { parseAndValidateRosterJson } from "./schema";
import type { ParseOutcome } from "./parse-text";

const VISION_SYSTEM_PROMPT = `你是手寫或拍照排班月曆辨識器。請只回傳嚴格符合以下 JSON 結構的純文字，不要加 markdown 圍欄或額外說明：
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
}`;

export async function parseRosterFromImage(options: {
  imageBase64: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
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
      warnings: ["未設定 AI_API_KEY，本次月曆圖片已改用內建模擬解析結果（圖片未送出外部模型）。"],
    };
  }

  const dataUrl = `data:${options.mimeType};base64,${options.imageBase64}`;
  const response = await fetch(`${env.aiApiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.aiApiKey}`,
    },
    body: JSON.stringify({
      model: env.aiVisionModel,
      temperature: 0.1,
      messages: [
        { role: "system", content: VISION_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `請辨識這張排班月曆／更期相片（本週星期日為 ${options.weekStart}${
                options.department ? `，預設部門：${options.department}` : ""
              }），輸出每位員工的請假日期與可用更別。`,
            },
            {
              type: "image_url",
              image_url: { url: dataUrl },
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`外部 AI 圖片辨識請求失敗（HTTP ${response.status}）。`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("外部 AI 未回傳任何圖片辨識內容。");
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