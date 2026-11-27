-- auto-roster-agent / Phase 1 Stage 4 Step 1
-- 增量遷移 v2：只新增欄位、改型別、回填預設值。
-- 可安全重跑：全部 IF NOT EXISTS / SET DEFAULT / 條件式 UPDATE，無 DROP、無 DELETE。

begin;

-- ─────────────────────────────────────────────
-- 1. employees 升級
-- ─────────────────────────────────────────────
alter table employees add column if not exists role_title text;
alter table employees add column if not exists ot_compensation_mode text not null default 'time_off';
-- 正數 = 補鐘餘額；負數 = 欠公司鐘，所以刻意不加 >= 0
alter table employees add column if not exists time_balance_hours numeric(6,1) not null default 0;

-- 假期欄位升級：支援半日假小數累計（AL5.5）。原有 >= 0 約束保留。
alter table employees alter column annual_leave_total type numeric(5,1) using annual_leave_total::numeric(5,1);
alter table employees alter column al_current_count   type numeric(5,1) using al_current_count::numeric(5,1);
alter table employees alter column sh_current_count   type numeric(5,1) using sh_current_count::numeric(5,1);
alter table employees alter column w_current_count    type numeric(5,1) using w_current_count::numeric(5,1);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'employees_role_title_check') then
    alter table employees add constraint employees_role_title_check
      check (role_title is null or role_title in ('M', 'A.M', 'S'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'employees_ot_compensation_mode_check') then
    alter table employees add constraint employees_ot_compensation_mode_check
      check (ot_compensation_mode in ('time_off', 'cash'));
  end if;
end $$;

-- ─────────────────────────────────────────────
-- 2. roster_rules 升級
-- ─────────────────────────────────────────────

-- 2.1 六大營業時段 + 各職級可揀時間段（FT 5 / HFT 2 / PT 1）
alter table roster_rules alter column shift_time_slots set default $json$
{"servicePeriods":[{"id":"opening","start":"06:00","end":"07:00"},{"id":"breakfast","start":"07:00","end":"11:30"},{"id":"lunch","start":"11:30","end":"14:00"},{"id":"tea","start":"14:00","end":"17:00"},{"id":"dinner","start":"17:00","end":"22:00"},{"id":"closing","start":"22:00","end":"23:00"}],"byEmployment":{"FT":[{"start":"06:30","end":"16:30"},{"start":"07:00","end":"17:00"},{"start":"08:00","end":"18:00"},{"start":"11:00","end":"21:00"},{"start":"12:00","end":"22:00"}],"HFT":[{"start":"07:00","end":"12:00"},{"start":"17:00","end":"22:00"}],"PT":[{"start":"18:00","end":"22:00"}]}}
$json$::jsonb;

-- 2.2 每月工時目標（30 日 / 31 日）
alter table roster_rules add column if not exists monthly_hours_rules jsonb not null default $json$
{"30":{"FT":{"targetHours":260,"standardDailyHours":10},"HFT":{"targetHours":130,"standardDailyHours":5}},"31":{"FT":{"targetHours":270,"standardDailyHours":10},"HFT":{"targetHours":135,"standardDailyHours":5}}}
$json$::jsonb;

-- 2.3 OT 與欠鐘門檻
alter table roster_rules add column if not exists ot_balance_rules jsonb not null default $json$
{"otTriggerHours":6,"otMaxCapHours":8,"deficitTriggerHours":5}
$json$::jsonb;

-- 2.4 六大時段所需人數：改為 Sun–Sat 每日獨立（數值抄 lib/roster/rules.ts）
alter table roster_rules alter column period_headcount set default $json$
{"opening":{"sun":2,"mon":2,"tue":2,"wed":2,"thu":2,"fri":2,"sat":2},"breakfast":{"sun":6,"mon":6,"tue":6,"wed":6,"thu":6,"fri":6,"sat":6},"lunch":{"sun":9,"mon":8,"tue":8,"wed":8,"thu":8,"fri":8,"sat":9},"tea":{"sun":7,"mon":6,"tue":6,"wed":6,"thu":6,"fri":6,"sat":7},"dinner":{"sun":7,"mon":7,"tue":7,"wed":7,"thu":7,"fri":8,"sat":9},"closing":{"sun":7,"mon":6,"tue":6,"wed":7,"thu":7,"fri":8,"sat":7}}
$json$::jsonb;

-- ─────────────────────────────────────────────
-- 3. 回填舊格式記錄（只補未升級的，不覆蓋已自訂的物件）
-- ─────────────────────────────────────────────
update roster_rules set shift_time_slots = default
 where jsonb_typeof(shift_time_slots) is distinct from 'object';

update roster_rules set period_headcount = default
 where jsonb_typeof(period_headcount -> 'lunch') is distinct from 'object';

commit;
