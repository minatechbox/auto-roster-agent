-- auto-roster-agent / Phase 1 Stage 1
-- Supabase schema: 6 tables + seed (1 store, 10 employees, 4 reserve, 1 ruleset)
-- 純儲存 Data：工時統計、假期 +1、年結等運算一律留在 Next.js Backend。
-- 可安全重跑（先 DROP 再 CREATE）。

begin;

-- 重跑時由最下游表開始刪
drop table if exists week_rosters cascade;
drop table if exists roster_templates cascade;
drop table if exists roster_rules cascade;
drop table if exists reserve_staff cascade;
drop table if exists employees cascade;
drop table if exists stores cascade;

-- ─────────────────────────────────────────────
-- 1. stores：公司／分店
-- ─────────────────────────────────────────────
create table stores (
  id               uuid primary key default gen_random_uuid(),
  store_name       text not null,
  address          text,
  phone            text,
  allowed_group_id text,   -- 指定報更群組 ID，防誤觸私人對話
  created_at       timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- 2. employees：正選員工（不含時薪）
-- al/sh/w_current_count = 用戶輸入基數（如 W49SH14AL5）的起始值
-- ─────────────────────────────────────────────
create table employees (
  id                      uuid primary key default gen_random_uuid(),
  store_id                uuid not null references stores(id) on delete cascade,
  name                    text not null,
  nickname                text,
  position                text,
  employment_type         text not null default 'PT'
                            check (employment_type in ('FT', 'HFT', 'PT')),
  fixed_shift_time        text,
  flexible_shift_options  jsonb not null default '[]'::jsonb,
  regular_days_off        jsonb not null default '[]'::jsonb,
  annual_leave_total      int  not null default 0 check (annual_leave_total >= 0),
  al_current_count        int  not null default 0 check (al_current_count >= 0),
  sh_current_count        int  not null default 0 check (sh_current_count >= 0),
  w_current_count         int  not null default 0 check (w_current_count >= 0),
  department              text,
  phone                   text,
  is_active               boolean not null default true
);

-- ─────────────────────────────────────────────
-- 3. reserve_staff：後備人員（priority 細 = 優先呼叫）
-- ─────────────────────────────────────────────
create table reserve_staff (
  id              uuid primary key default gen_random_uuid(),
  store_id        uuid not null references stores(id) on delete cascade,
  name            text not null,
  nickname        text,
  position        text,
  employment_type text not null default 'PT'
                    check (employment_type in ('FT', 'HFT', 'PT')),
  department      text,
  phone           text,
  priority        int not null default 100 check (priority > 0),
  is_active       boolean not null default true
);

-- ─────────────────────────────────────────────
-- 4. roster_rules：排班條件及限制（每店／部門一條）
-- ─────────────────────────────────────────────
create table roster_rules (
  id                      uuid primary key default gen_random_uuid(),
  store_id                uuid not null references stores(id) on delete cascade,
  department              text,
  -- {"opening":2,"breakfast":6,"lunch":8,"tea":6,"dinner":7,"closing":7}
  period_headcount        jsonb not null default '{}'::jsonb,
  -- {"FT":10,"HFT":5,"PT":4}
  max_daily_hours         jsonb not null default '{}'::jsonb,
  -- {"FT":60,"HFT":30,"PT":28}
  max_weekly_hours        jsonb not null default '{}'::jsonb,
  statutory_holidays_yearly int not null default 15 check (statutory_holidays_yearly >= 0),
  -- {"workDays":6,"restDays":1,"cycleDays":7}
  weekly_rest_rule        jsonb not null default '{}'::jsonb,
  -- {"settleMonth":12,"settleDay":31,"convertRemainingToSalary":true,"resetCurrentCount":true}
  al_settlement_rule      jsonb not null default '{}'::jsonb,
  -- [{"id":"opening","start":"06:00","end":"07:00"}, ...]
  shift_time_slots        jsonb not null default '[]'::jsonb,
  created_at              timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- 5. roster_templates：標準更表模板
-- ─────────────────────────────────────────────
create table roster_templates (
  id                     uuid primary key default gen_random_uuid(),
  store_id               uuid not null references stores(id) on delete cascade,
  template_name          text not null,
  department             text,
  schedule               jsonb not null default '{}'::jsonb,
  daily_hours_summary    jsonb not null default '[]'::jsonb,
  weekly_hours_summary   jsonb not null default '{}'::jsonb,
  monthly_hours_summary  jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- 6. week_rosters：實際週更表
-- 欄位名必須對齊 lib/db/rosters.ts（snake_case）
-- store_id 暫時 nullable：現有寫入流程未帶 store_id
-- ─────────────────────────────────────────────
create table week_rosters (
  id                     uuid primary key default gen_random_uuid(),
  store_id               uuid references stores(id) on delete cascade,
  week_start             date not null,
  iso_week               text not null,
  status                 text not null default 'draft'
                           check (status in ('draft', 'approved')),
  department             text,
  source                 text not null
                           check (source in ('text', 'image', 'mock', 'webhook')),
  mode                   text not null default 'live'
                           check (mode in ('live', 'mock')),
  parsed                 jsonb not null default '{}'::jsonb,
  schedule               jsonb not null default '{}'::jsonb,
  warnings               jsonb not null default '[]'::jsonb,
  daily_hours_summary    jsonb not null default '[]'::jsonb,
  weekly_hours_summary   jsonb not null default '{}'::jsonb,
  monthly_hours_summary  jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  approved_at            timestamptz
);

-- ─────────────────────────────────────────────
-- 索引
-- ─────────────────────────────────────────────
create index employees_store_id_idx      on employees (store_id);
create index reserve_staff_store_id_idx  on reserve_staff (store_id);
create index roster_rules_store_id_idx   on roster_rules (store_id);
create index roster_templates_store_idx  on roster_templates (store_id);
create index week_rosters_store_week_idx on week_rosters (store_id, week_start);
create index week_rosters_week_status_idx on week_rosters (week_start, status);

-- ─────────────────────────────────────────────
-- RLS：全部開啟但不建 policy，只准 service role（backend）通過
-- ─────────────────────────────────────────────
alter table stores           enable row level security;
alter table employees        enable row level security;
alter table reserve_staff    enable row level security;
alter table roster_rules     enable row level security;
alter table roster_templates enable row level security;
alter table week_rosters     enable row level security;

-- ─────────────────────────────────────────────
-- Seed 1：預設分店
-- ─────────────────────────────────────────────
insert into stores (id, store_name, address, phone, allowed_group_id)
values (
  '00000000-0000-4000-8000-000000000001',
  'Superme Cafe',
  null,
  null,
  null
);

-- ─────────────────────────────────────────────
-- Seed 2：10 位正選員工（來源 lib/mock/sample-week.ts）
-- FT x6 / HFT x2 / PT x2
-- ─────────────────────────────────────────────
insert into employees
  (store_id, name, nickname, employment_type, department, phone, flexible_shift_options)
values
  ('00000000-0000-4000-8000-000000000001', 'Jamie Cole',  'Jamie',  'FT',  'Superme Cafe', '6000 1001', '["06:30-16:30","07:00-17:00","08:00-18:00","11:00-21:00","12:00-22:00"]'::jsonb),
  ('00000000-0000-4000-8000-000000000001', 'Noah Blake',  'Noah',   'FT',  'Superme Cafe', '6000 1002', '["06:30-16:30","07:00-17:00","08:00-18:00","11:00-21:00","12:00-22:00"]'::jsonb),
  ('00000000-0000-4000-8000-000000000001', 'Casey Quinn', 'Casey',  'FT',  'Superme Cafe', '6000 1003', '["06:30-16:30","07:00-17:00","08:00-18:00","11:00-21:00","12:00-22:00"]'::jsonb),
  ('00000000-0000-4000-8000-000000000001', 'Riley Shaw',  'Riley',  'FT',  'Superme Cafe', '6000 1004', '["06:30-16:30","07:00-17:00","08:00-18:00","11:00-21:00","12:00-22:00"]'::jsonb),
  ('00000000-0000-4000-8000-000000000001', 'Avery Kim',   'Avery',  'FT',  'Superme Cafe', '6000 1005', '["06:30-16:30","07:00-17:00","08:00-18:00","11:00-21:00","12:00-22:00"]'::jsonb),
  ('00000000-0000-4000-8000-000000000001', 'Taylor Brooks','Taylor','FT',  'Superme Cafe', '6000 1008', '["06:30-16:30","07:00-17:00","08:00-18:00","11:00-21:00","12:00-22:00"]'::jsonb),
  ('00000000-0000-4000-8000-000000000001', 'Jordan Hale', 'Jordan', 'HFT', 'Superme Cafe', '6000 1006', '["07:00-12:00","17:00-22:00"]'::jsonb),
  ('00000000-0000-4000-8000-000000000001', 'Parker Nguyen','Parker','HFT', 'Superme Cafe', '6000 1009', '["07:00-12:00","17:00-22:00"]'::jsonb),
  ('00000000-0000-4000-8000-000000000001', 'Morgan Ellis','Morgan', 'PT',  'Superme Cafe', '6000 1007', '["17:00-22:00"]'::jsonb),
  ('00000000-0000-4000-8000-000000000001', 'Quinn Adler', 'Quinn',  'PT',  'Superme Cafe', '6000 1010', '["17:00-22:00"]'::jsonb);

-- ─────────────────────────────────────────────
-- Seed 3：4 位後備員工
-- ─────────────────────────────────────────────
insert into reserve_staff
  (store_id, name, nickname, employment_type, department, phone, priority)
values
  ('00000000-0000-4000-8000-000000000001', 'Reese Dalton', 'Reese',  'PT', 'Superme Cafe', '6000 1011', 1),
  ('00000000-0000-4000-8000-000000000001', 'Skyler Ortiz', 'Skyler', 'PT', 'Superme Cafe', '6000 1012', 2),
  ('00000000-0000-4000-8000-000000000001', 'Hayden Cho',   'Hayden', 'PT', 'Superme Cafe', '6000 1013', 3),
  ('00000000-0000-4000-8000-000000000001', 'Rowan Patel',  'Rowan',  'PT', 'Superme Cafe', '6000 1014', 4);

-- ─────────────────────────────────────────────
-- Seed 4：預設排班規則（來源 lib/roster/rules.ts）
-- period_headcount 取平日基準值；週末加人由 backend 動態調整
-- ─────────────────────────────────────────────
insert into roster_rules
  (store_id, department, period_headcount, max_daily_hours, max_weekly_hours,
   statutory_holidays_yearly, weekly_rest_rule, al_settlement_rule, shift_time_slots)
values (
  '00000000-0000-4000-8000-000000000001',
  'Superme Cafe',
  '{"opening":2,"breakfast":6,"lunch":8,"tea":6,"dinner":7,"closing":7}'::jsonb,
  '{"FT":10,"HFT":5,"PT":4}'::jsonb,
  '{"FT":60,"HFT":30,"PT":28}'::jsonb,
  15,
  '{"workDays":6,"restDays":1,"cycleDays":7}'::jsonb,
  '{"settleMonth":12,"settleDay":31,"convertRemainingToSalary":true,"resetCurrentCount":true}'::jsonb,
  '[{"id":"opening","start":"06:00","end":"07:00"},{"id":"breakfast","start":"07:00","end":"11:30"},{"id":"lunch","start":"11:30","end":"14:00"},{"id":"tea","start":"14:00","end":"17:00"},{"id":"dinner","start":"17:00","end":"22:00"},{"id":"closing","start":"22:00","end":"23:00"}]'::jsonb
);

commit;
