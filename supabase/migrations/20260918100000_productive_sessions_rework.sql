-- Renames the active/idle axis to productive/unproductive to match the new
-- 3-minute-window classification model, and retires paused_seconds — the
-- separate "on a break" control is superseded by Start/Stop sessions
-- (stop before a break, start again after), so there's no longer a
-- distinct paused state to track.

alter table public.productivity_sessions
  rename column total_active_seconds to total_productive_seconds;
alter table public.productivity_sessions
  rename column total_idle_seconds to total_unproductive_seconds;
alter table public.productivity_sessions
  drop column paused_seconds;

alter table public.site_activity
  rename column active_seconds to productive_seconds;
alter table public.site_activity
  rename column idle_seconds to unproductive_seconds;
