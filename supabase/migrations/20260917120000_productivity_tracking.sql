-- Productivity tracking: per-site activity, daily rollups + anti-gaming flags,
-- and admin-managed site categorization.
--
-- Assumes the base AMS schema already exists: public.profiles, and a
-- public.is_admin() function usable in RLS policies (same one used by
-- attendance/salary_slips/etc). This migration does not redefine it.

create table public.site_activity (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  work_date       date not null default (now() at time zone 'utc')::date,
  hostname        text not null,
  category        text not null default 'UNCATEGORIZED'
                    check (category in ('PRODUCTIVE','NEUTRAL','DISTRACTING','UNCATEGORIZED')),
  active_seconds  integer not null default 0,
  idle_seconds    integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, work_date, hostname)
);
create index on public.site_activity (user_id, work_date);
create index on public.site_activity (work_date);

create table public.productivity_sessions (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles(id) on delete cascade,
  work_date             date not null default (now() at time zone 'utc')::date,
  total_active_seconds  integer not null default 0,
  total_idle_seconds    integer not null default 0,
  tab_switch_count      integer not null default 0,
  flagged_suspicious    boolean not null default false,
  flag_reason           text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (user_id, work_date)
);
create index on public.productivity_sessions (work_date);

create table public.site_categories (
  id          uuid primary key default gen_random_uuid(),
  hostname    text not null unique,
  category    text not null check (category in ('PRODUCTIVE','NEUTRAL','DISTRACTING')),
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);

-- RLS

alter table public.site_activity enable row level security;
alter table public.productivity_sessions enable row level security;
alter table public.site_categories enable row level security;

create policy "own rows readable" on public.site_activity
  for select using (auth.uid() = user_id or public.is_admin());
create policy "own rows insertable" on public.site_activity
  for insert with check (auth.uid() = user_id);
create policy "own rows updatable" on public.site_activity
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "admin full access" on public.site_activity
  for all using (public.is_admin());

create policy "own rows readable" on public.productivity_sessions
  for select using (auth.uid() = user_id or public.is_admin());
create policy "own rows insertable" on public.productivity_sessions
  for insert with check (auth.uid() = user_id);
create policy "own rows updatable" on public.productivity_sessions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "admin full access" on public.productivity_sessions
  for all using (public.is_admin());

create policy "categories readable by all authenticated" on public.site_categories
  for select using (auth.role() = 'authenticated');
create policy "categories writable by admin only" on public.site_categories
  for all using (public.is_admin());

-- Optional: surface productivity flags through the existing notifications table.
-- Uncomment and adjust once you confirm the exact name of the `type` check
-- constraint on public.notifications in the AMS schema:
--
-- alter table public.notifications drop constraint notifications_type_check;
-- alter table public.notifications add constraint notifications_type_check
--   check (type in (<...existing values...>, 'PRODUCTIVITY_FLAGGED'));
