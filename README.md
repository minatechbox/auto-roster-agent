# Auto Roster Agent

Superme Cafe 自動排班控制台：收集員工覆期、生成週日–週六更表草稿、即時改更，並寫入 Supabase。

線上示範：[https://auto-roster-agent.vercel.app](https://auto-roster-agent.vercel.app)

Phase 1 用虛構員工示範資料（10 位正選 + 4 位後補）。AI 金鑰、Supabase service role 只存在伺服器，不會送到瀏覽器。

## Phase 1 核心功能

### 三種收資料渠道

控制台同一個收資料面板有三個 Tab，解析完成後都會即時更新下方週更表草稿，並嘗試寫入 Supabase。

| 渠道 | 前端 | API |
|------|------|-----|
| **WhatsApp 文字** | 貼上群組覆期文字 | `POST /api/parse-and-schedule`（`kind: "text"`） |
| **WeChat 文字** | 貼上微信群／私訊對話紀錄 | 同上，`channel: "wechat"` |
| **更期／日曆相片** | 拍攝或上傳 JPEG／PNG／WebP（最大 4 MB） | `POST /api/parse-image`（Vision 讀姓名、請假日、更段） |

Webhook 已預留，方便之後接自動回覆（Phase 2 會再接到排程發送）：

- WhatsApp Cloud API：`GET/POST /api/webhook/whatsapp`（`hub.verify_token` / `hub.challenge`，以及文字訊息解析）
- WeChat 公眾號／企業微信：`GET/POST /api/webhook/wechat`（`signature` + `echostr`，或 `msg_signature` + 訊息 XML／JSON）

### 週更表草稿

- 週制由**星期日**開始、星期六結束
- 自動排 AM／PM／OFF，標示請假，並列出後補名單
- 顯示每日在崗人數、員工週工時、六大時段核數警告
- 可列印／匯出 PDF、批准草稿為 `approved`

### 即時點選快改

- 中間一列 **連續 7 日**，撳入去改當日
- 每人可揀 **早更／下午更／請假／休息**
- 更表格仔亦可撳，循環轉更
- `PATCH /api/rosters/[id]` 即時寫回 Supabase

### Supabase 同步

已設定 `SUPABASE_URL` 與 `SUPABASE_SERVICE_ROLE_KEY` 時：

- 生成草稿會寫入 `week_rosters`
- 同一週＋同一部門的舊草稿會被覆蓋
- 列表、批准、當日改更都經 server-side REST，金鑰唔會暴露到前端

未設定 Supabase 時仍可在本機產生草稿，但不會持久化。

### 無 `AI_API_KEY` 時的安全降級

未設定 `AI_API_KEY` 時，文字與相片解析**不會把內容送到外部模型**，改用內建 Superme Cafe 示範資料（`mode: "mock"`），並在警告中說明。方便本機／示範環境安全運行。

## 技術架構

| 層 | 技術 |
|----|------|
| 前端 | Next.js 16 App Router、React 19、TypeScript、Tailwind CSS 4 |
| 後端 | Next.js Route Handlers（`app/api/*`） |
| 資料 | Supabase（Postgres `week_rosters`，service role 只在伺服器） |
| AI | OpenAI 相容 Chat Completions（文字 + Vision）；金鑰只讀 `process.env` |
| 部署 | Vercel（[auto-roster-agent.vercel.app](https://auto-roster-agent.vercel.app)） |

主要路徑：

```
app/page.tsx                  控制台（收資料 Tab + 7 日編輯器）
app/api/parse-and-schedule    文字／mock／DB 示範生成
app/api/parse-image           日曆相片 Vision
app/api/webhook/whatsapp      WhatsApp Webhook
app/api/webhook/wechat        WeChat Webhook
app/api/rosters               列表
app/api/rosters/[id]          當日改更 PATCH
app/api/rosters/[id]/approve  批准草稿
lib/roster/*                  排班規則與工時
lib/ai/*                      文字／圖片解析（無金鑰則 mock）
```

## 環境變數

複製 `.env.example` 為 `.env.local`。**不要**加 `NEXT_PUBLIC_` 前綴；這些值只給伺服器。

| 變數 | 用途 |
|------|------|
| `AI_API_KEY` | 外部 AI。留空則用內建模擬解析，不外送原文／相片 |
| `AI_API_BASE_URL` | 預設 `https://api.openai.com/v1` |
| `AI_TEXT_MODEL` | 預設 `gpt-4o-mini` |
| `AI_VISION_MODEL` | 預設 `gpt-4o-mini` |
| `SUPABASE_URL` | Supabase 專案 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role（只放伺服器／Vercel Env） |
| `WEBHOOK_SECRET` | WhatsApp `X-Hub-Signature-256`；亦作為其他 verify token 後備 |
| `WHATSAPP_VERIFY_TOKEN` | Meta Cloud API `hub.verify_token`（未設則用 `WEBHOOK_SECRET`） |
| `WECHAT_TOKEN` | 公眾號／企業微信 Token（未設則用 `WEBHOOK_SECRET`） |
| `WECHAT_ENCODING_AES_KEY` | 可選，43 字元 EncodingAESKey，用於加密訊息 |

## 本地啟動

需要 Node.js 20+。

```bash
npm install
copy .env.example .env.local
```

在 `.env.local` 填入金鑰（可先留空 `AI_API_KEY` 用 mock）。然後：

```bash
npm run dev
```

瀏覽器打開 [http://localhost:3000](http://localhost:3000)。

其他指令：

```bash
npm run build
npm run start
npm run lint
```

## Vercel 部署

1. 將 repo 推上 GitHub（或用 Vercel CLI：`npx vercel`）。
2. 在 Vercel 專案 **Settings → Environment Variables** 填入與 `.env.example` 相同的伺服器變數（Production / Preview）。
3. 部署後網址為 [https://auto-roster-agent.vercel.app](https://auto-roster-agent.vercel.app)。
4. 接 WhatsApp／WeChat 時，把平台 webhook 指去：
   - `https://auto-roster-agent.vercel.app/api/webhook/whatsapp`
   - `https://auto-roster-agent.vercel.app/api/webhook/wechat`

CLI 部署本機變更：

```bash
npx vercel --prod
```

## Phase 2 未來自動化路線圖

Phase 1 已可人手貼文字、上傳相片、改更、批准。下一階段目標係減少人手跟進：

1. **排程設定面板**  
   管理員設定每週幾號幾點開始收覆期、截止時間、提醒次數、目標群組／部門。

2. **定時自動發送提醒**  
   按排程向 WhatsApp／WeChat 群或員工發送「請覆更／請假」提示，無需每次人手複製貼上。

3. **Webhook 自動接收回覆**  
   員工在群組回覆後，現有 `/api/webhook/whatsapp` 與 `/api/webhook/wechat` 自動解析並更新該週草稿，管理員只需抽查 7 日編輯器再批准。

Phase 2 完成後，流程會係：排程出發送 → 員工回覆 → Webhook 入表 → 管理員快改／批准。
