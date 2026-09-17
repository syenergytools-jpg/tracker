-- Adds explicit "on a break" time, separate from idle time, now that the
-- extension has a manual pause/resume control. Declared break time is a
-- transparent, non-penalized fact for admins to see — not lumped in with
-- idle (which represents unexplained inactivity while still "clocked in"
-- to tracking).

alter table public.productivity_sessions
  add column paused_seconds integer not null default 0;