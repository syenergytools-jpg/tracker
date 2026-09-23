# Evolut Productivity Tracker

Tracks employee productive/unproductive time via an explicit Start/Stop
session, using the same Supabase project and login as the existing AMS.
Built to the constraints in the original brief: no keystroke content, no
page content, no screenshots, and never covert.

## The product: `desktop-agent/`

A standalone Windows tray app is the deployed solution — one tool per
employee, no browser extension required. It tracks every application,
including the browser, via global keyboard/mouse counting and foreground-
app detection. The one accepted tradeoff: it can tell *that* the browser
was used, not *which website* — see `desktop-agent/README.md` for exactly
why, and for what's still needed (no signed installer yet, in particular)
before this goes on a real employee machine.

## `extension/` — kept, not currently deployed

A Chrome extension exists in this repo from an earlier design (tracks
browser activity with full per-site detail and categorization) but isn't
part of the current rollout plan. It still works and is still documented
(`extension/README.md`) in case per-site browser detail ever becomes worth
reintroducing alongside the desktop agent — `supabase/schema.sql`'s
`daily_productivity_totals` view exists specifically to combine both
sources cleanly if that happens. Until then, nothing needs to be installed
in employees' browsers.

## How tracking works (both components, same model)

1. Sign in with an AMS email/password.
2. Click **Start**. A session timer begins counting up from `00:00:00`.
3. Every 3 minutes, it privately checks whether that window saw enough
   keypresses **or** enough mouse/scroll activity — either alone is enough.
   The whole 3 minutes counts as **Productive** or **Unproductive**
   accordingly. This check is intentionally hidden from the employee — only
   the running session timer and today's cumulative totals are shown, never
   a per-window verdict.
4. Tracking stops on **Stop**, or automatically if the app/browser closes.

Component-specific detail (exactly what's tracked, the anti-gaming flags,
architecture decisions, and known limitations) lives in each component's
own README — `desktop-agent/README.md` for the deployed product,
`extension/README.md` for the not-currently-deployed browser extension.

## Project layout

```
supabase/schema.sql   — the whole schema, as one idempotent script (see below)
extension/             — the Chrome extension (MV3)
desktop-agent/         — the Windows tray app; see desktop-agent/README.md
```

An earlier pass of this project also scaffolded `ams-integration/` (Next.js
admin/employee dashboard pages meant to be copied into the real AMS repo).
That folder isn't part of the repo anymore — it's not on disk and isn't in
git history here. If you still want dashboard pages wired to the schema
below, that would need to be rebuilt against whatever the AMS repo looks
like now, since the two have very likely drifted from what was scaffolded
before.

## Setup

### 1. Database

Paste the whole of `supabase/schema.sql` into the Supabase SQL Editor (or
run it with `psql`/the CLI) and run it. It's intentionally **one file, not a
sequence of migrations** — it creates `site_activity`, `productivity_
sessions`, `app_activity`, and `site_categories` with `create table if not
exists` (plus a `daily_productivity_totals` view combining the first two
tables with `app_activity`, for once the desktop agent is in use), and
fixes up a table already created under an earlier column-naming generation
(the pre-rework `active`/`idle` names, or a retired `paused_seconds`
column) via conditional `do $$ ... $$` blocks. That makes it safe to run
against a brand-new database, a partially-set-up one, or one that already
has an older version of this schema — and safe to just run again after any
future change to this file, rather than needing to track which of several
migration files have already been applied.

It assumes `public.profiles` and a `public.is_admin()` function already
exist (same ones the AMS's `attendance`/`salary_slips` policies use) — it
doesn't define those.

If you hit `column "..." does not exist` running this, it usually means the
base tables were never created in that database yet — this file handles
that itself (it creates them), so just re-run the whole file rather than
trying to run part of it.

### 2. Desktop agent (the deployed product)

```bash
cd desktop-agent
npm install
cp .env.example .env   # same Supabase URL/anon key as the AMS's .env.local
npm start
```

Read `desktop-agent/README.md` in full before rolling this out to anyone —
in particular, there's no signed installer yet, which matters a lot for a
tool built on a global keyboard/mouse hook.

### 3. Extension (optional, not currently deployed)

Only relevant if per-site browser detail is ever worth reintroducing
alongside the desktop agent — see `extension/README.md`.

## Anti-gaming flags, architecture decisions, and known limitations

All of this is component-specific and documented in each component's own
README (`desktop-agent/README.md`, `extension/README.md`) rather than
duplicated here — the two components' internals differ enough (Electron vs.
MV3 service worker, `active-win`/global-hook vs. DOM events, file storage
vs. `chrome.storage`) that a shared description would blur real
differences worth knowing about.
