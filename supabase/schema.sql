-- Evolut Productivity Tracker — full schema, kept as ONE idempotent file.
--
-- Run this whole file any time the schema needs to change. It's safe to run
-- repeatedly against a database in any prior state — freshly empty,
-- partially set up, or already on an older column-naming generation from
-- before the productive/unproductive rework — and it converges all of them
-- to the same current schema. When the schema needs to change again, add
-- the change to this same file (a new column, a new "do $$ ... $$" fix-up
-- block, etc.) rather than creating a separate migration file.
--
-- Assumes the base AMS schema already exists: public.profiles, and a
-- public.is_admin() function usable in RLS policies (same one used by
-- attendance/salary_slips/etc). This script does not define those.

-- ============================================================
-- site_activity — per (employee, day, hostname) rollup
-- ============================================================

create table if not exists public.site_activity (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles(id) on delete cascade,
  work_date             date not null default (now() at time zone 'utc')::date,
  hostname              text not null,
  category              text not null default 'UNCATEGORIZED'
                          check (category in ('PRODUCTIVE','NEUTRAL','DISTRACTING','UNCATEGORIZED')),
  productive_seconds    integer not null default 0,
  unproductive_seconds  integer not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (user_id, work_date, hostname)
);

-- Fix up a table already created under the earlier active/idle naming.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'site_activity' and column_name = 'active_seconds'
  ) then
    alter table public.site_activity rename column active_seconds to productive_seconds;
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'site_activity' and column_name = 'idle_seconds'
  ) then
    alter table public.site_activity rename column idle_seconds to unproductive_seconds;
  end if;
end $$;

create index if not exists site_activity_user_date_idx on public.site_activity (user_id, work_date);
create index if not exists site_activity_date_idx on public.site_activity (work_date);

-- ============================================================
-- productivity_sessions — per (employee, day) rollup + anti-gaming flags
-- ============================================================

create table if not exists public.productivity_sessions (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null references public.profiles(id) on delete cascade,
  work_date                   date not null default (now() at time zone 'utc')::date,
  total_productive_seconds    integer not null default 0,
  total_unproductive_seconds  integer not null default 0,
  tab_switch_count            integer not null default 0,
  flagged_suspicious          boolean not null default false,
  flag_reason                 text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (user_id, work_date)
);

-- Fix up a table already created under an earlier generation of this schema.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'productivity_sessions' and column_name = 'total_active_seconds'
  ) then
    alter table public.productivity_sessions rename column total_active_seconds to total_productive_seconds;
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'productivity_sessions' and column_name = 'total_idle_seconds'
  ) then
    alter table public.productivity_sessions rename column total_idle_seconds to total_unproductive_seconds;
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'productivity_sessions' and column_name = 'paused_seconds'
  ) then
    alter table public.productivity_sessions drop column paused_seconds;
  end if;
end $$;

create index if not exists productivity_sessions_date_idx on public.productivity_sessions (work_date);

-- ============================================================
-- site_categories — admin-managed hostname -> category mapping
-- ============================================================

create table if not exists public.site_categories (
  id          uuid primary key default gen_random_uuid(),
  hostname    text not null unique,
  category    text not null check (category in ('PRODUCTIVE','NEUTRAL','DISTRACTING')),
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);

-- ============================================================
-- RLS — dropped and recreated every run so policy changes here always
-- take effect, rather than silently no-op'ing on a second run.
-- ============================================================

alter table public.site_activity enable row level security;
alter table public.productivity_sessions enable row level security;
alter table public.site_categories enable row level security;

drop policy if exists "own rows readable" on public.site_activity;
create policy "own rows readable" on public.site_activity
  for select using (auth.uid() = user_id or public.is_admin());
drop policy if exists "own rows insertable" on public.site_activity;
create policy "own rows insertable" on public.site_activity
  for insert with check (auth.uid() = user_id);
drop policy if exists "own rows updatable" on public.site_activity;
create policy "own rows updatable" on public.site_activity
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "admin full access" on public.site_activity;
create policy "admin full access" on public.site_activity
  for all using (public.is_admin());

drop policy if exists "own rows readable" on public.productivity_sessions;
create policy "own rows readable" on public.productivity_sessions
  for select using (auth.uid() = user_id or public.is_admin());
drop policy if exists "own rows insertable" on public.productivity_sessions;
create policy "own rows insertable" on public.productivity_sessions
  for insert with check (auth.uid() = user_id);
drop policy if exists "own rows updatable" on public.productivity_sessions;
create policy "own rows updatable" on public.productivity_sessions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "admin full access" on public.productivity_sessions;
create policy "admin full access" on public.productivity_sessions
  for all using (public.is_admin());

drop policy if exists "categories readable by all authenticated" on public.site_categories;
create policy "categories readable by all authenticated" on public.site_categories
  for select using (auth.role() = 'authenticated');
drop policy if exists "categories writable by admin only" on public.site_categories;
create policy "categories writable by admin only" on public.site_categories
  for all using (public.is_admin());
