# AMS Productivity Tracker

A Chrome extension that tracks employee active/idle time and site categories,
using the same Supabase project and login as the existing AMS, plus
ready-to-drop-in AMS dashboard pages. Built to the constraints in the
original brief: no keystroke content, no page content, no screenshots, and
never covert.

## What is and isn't tracked

Share this section (or a copy of it) with employees before rollout — several
jurisdictions legally require notice for this kind of monitoring, and that's
on the business to handle, not something this tool can substitute for.

**Tracked:**
- Which website (hostname only, e.g. `docs.google.com` — not the full URL or
  page content) is open in the active browser tab, and for how long.
- Whether that time counted as "active" (mouse/keyboard input seen) or
  "idle" (no input for 3+ minutes, or the OS reports the screen locked/idle).
- A count of key presses, mouse moves, mouse clicks, and scroll events — as
  numbers only, to tell "active" from "idle." Never which key, never typed
  text, never form contents, never clipboard.
- Coarse timing/movement statistics on those same counts (e.g. "were mouse
  movements suspiciously uniform"), used only to flag possible automation
  (see "Anti-gaming flags" below) — not what was clicked or typed.
- Tab-switch counts.
- When you used the extension's own **Stop tracking** button and for how
  long — recorded as a separate "on a break" total, not counted as idle.

**Never tracked:** what you typed, page text or form field contents,
screenshots or screen recording, clipboard, webcam, or audio.

**Always visible:** the extension's toolbar icon always shows a badge
(`ON` / `IDLE` / `BRK` / `OFF`), and the popup shows a live stopwatch of
today's total tracking (active) time plus today's idle time, updating in
real time while it runs. It never runs invisibly.

## Starting and stopping (breaks)

The popup has a **Start tracking** / **Stop tracking** button for lunch,
meetings elsewhere, or anything else where "idle" (still clocked into
tracking, just no input seen) isn't the honest description — "not being
tracked right now" is. Clicking Stop: no active/idle ticks accrue, no
activity pings are recorded, and tab switches don't count toward the
tab-switch total or the anti-gaming checks. The toolbar badge shows `BRK`
the whole time, and the popup shows a plain "tracking is stopped" banner —
same never-covert principle as the rest of the extension. Clicking Start
again resets idle detection fresh rather than trusting whatever
`lastInputAt` was before the break.

Break time is still synced to Supabase as `productivity_sessions
.paused_seconds` — a neutral, transparent number, not folded into idle —
so an admin sees "on a declared break for 45m" instead of an unexplained gap
that looks like the employee walked away without saying so. Signing out
clears any stale paused state so it can't silently carry into the next
session.

## Project layout

```
supabase/migrations/   — the 3 new tables + RLS policies, plus a follow-up
                          migration adding paused_seconds
extension/              — the Chrome extension (MV3)
ams-integration/        — Next.js pages to drop into the actual AMS repo
```

## Setup

### 1. Database

Apply both migrations, in order, with the Supabase CLI (or however the AMS
repo already runs migrations):

1. `20260917120000_productivity_tracking.sql` — the 3 tables + RLS. Assumes
   `public.profiles` and a `public.is_admin()` function already exist (same
   ones the AMS's `attendance`/`salary_slips` policies use) — it doesn't
   redefine them.
2. `20260917130000_add_paused_seconds.sql` — adds the column the Stop
   tracking button's break time syncs to.

### 2. Extension

```bash
cd extension
npm install
cp .env.example .env   # fill in the same Supabase URL/anon key as the AMS's .env.local
npm run build
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → select `extension/dist`.

Sign in with an existing AMS email/password. `npm run watch` rebuilds on
file changes during development (you'll still need to click the reload icon
on `chrome://extensions` after a rebuild).

### 3. AMS dashboard pages

`ams-integration/` isn't wired into the real AMS repo yet — it's a separate
folder you were pointed away from for this pass. It contains:

- `app/admin/productivity/page.tsx` — all-employees view, per-day, with a
  "needs categorization" panel and the flagged-sessions list.
- `app/productivity/page.tsx` — an employee's own data only (today + last 7
  days), including their own flag status if any.
- `lib/supabaseClient.ts`, `lib/productivityQueries.ts`, `lib/format.ts`

To integrate: copy `app/` and `lib/` into the AMS repo (merging `lib/` if it
already has files by those names), then:

- **Delete `lib/supabaseClient.ts`** and import the AMS's existing Supabase
  browser client instead, if it has one — don't run two client instances.
- **Fix the admin access gate**: the admin page currently checks
  `profiles.role === 'ADMIN'` client-side as a quick UX guard (RLS is what
  actually enforces access). Swap it for whatever pattern `/admin/*` already
  uses in the AMS, if there is a shared one.
- **Fix `EmployeeProfile.full_name`**: the schema we were given only
  confirms `role`/`department`/`shift_start`/`shift_end` on `profiles` — we
  don't know the actual display-name column(s). Update the type and the
  `select()` in `lib/productivityQueries.ts` to match.
- If the AMS uses `@/lib/...` path aliases (the Next.js default) instead of
  relative imports, or a `src/` layout, adjust the import paths accordingly.
- Optionally wire `'PRODUCTIVITY_FLAGGED'` into the `notifications` table's
  `type` check constraint — see the commented-out block at the bottom of the
  migration file.

## Anti-gaming flags — what they mean

`productivity_sessions.flagged_suspicious` / `flag_reason` are set by
best-effort pattern matching (uniform input timing, near-zero mouse
movement, key-only activity with nothing else, or rapid tab switching with
no dwell time) — see `extension/src/lib/heuristics.js`. These are
**statistical anomalies for a human to review, not proof of anything**. A
person watching a training video with a still mouse will look "idle," not
"cheating." Nothing here auto-penalizes an employee, and nothing here can
reliably detect a physical mouse jiggler or auto-clicker — those produce
real OS-level input, indistinguishable from a human by any browser
extension.

## Notable deviations from the original spec (and why)

- **60-second tick, not 30.** Chrome clamps repeating `chrome.alarms` to a
  1-minute minimum once an extension is packed/published (unpacked dev
  builds can get away with less, which would have silently broken on
  release). The 3-minute idle threshold and backfill behavior are unchanged
  — it's just 3 ticks of 60s instead of 6 ticks of 30s.
- **Local state holds running daily totals, not since-last-flush deltas.**
  The brief describes accumulate-then-reset-after-flush. Reset-after-flush
  only works safely with an *additive* upsert (a Postgres function doing
  `... = existing + delta`), which the brief didn't ask for. Instead, local
  state keeps the day's full running total and every sync overwrites
  Supabase with that total — simpler, and trivially safe to retry (a failed
  or repeated push can never double-count, which a reset-based delta scheme
  can if a response is lost after the server already committed it).

## Limitations of this pass

- **Not tested against a real Chrome profile or a real Supabase project** —
  there's no Supabase project connected here and this environment can't
  drive `chrome://extensions`. What *was* verified: the extension builds
  cleanly with `npm run build`; the idle-detection accumulator, the four
  anti-gaming heuristics, and the pause/resume state (including resume-time
  break-duration accounting) were exercised with scripted inputs confirming
  correct behavior; and the actual popup HTML/CSS/JS were run in a browser
  against a mocked `chrome.runtime` to check the Start/Stop button, banner,
  badge colors, and live timer stay in sync.
- **Three real bugs were caught and fixed against actual usage feedback**,
  worth knowing about since this pass couldn't run a full real-world smoke
  test itself:
  - The "stopped" banner and button state could disagree, because `.hidden`
    was only ever defined as `.view.hidden` and didn't hide non-`.view`
    elements like the banner.
  - Today's totals could get stuck at zero. `chrome.alarms.create()` resets
    an alarm's schedule if one by that name already exists, and this
    top-level code re-runs on every service worker cold start (frequent in
    MV3 — even the popup's own status polling can trigger one). Creating
    the tick/flush alarms unconditionally on every restart kept pushing
    their "next fire" time back before it ever arrived, so nothing was ever
    committed. Fixed by only creating an alarm that doesn't already exist
    (`ensureAlarm` in `background.js`) — the underlying alarm is durable
    across service worker restarts, it just shouldn't be re-created.
  - Idle time could be significantly overcounted relative to active time.
    `lastInputAt`, `osIdleState`, `pendingTicks`, and `idleStreakConfirmed`
    lived only in plain module-level variables. Every service worker cold
    start (which, as above, happens constantly) reset them to their
    defaults — in particular `lastInputAt` back to 0 — so a tick evaluated
    right after a restart would see "no input in the last 60s" even during
    genuinely continuous typing/mouse use, because the *previous* wake
    instance's update to that variable never survived to this one. Fixed by
    moving all of it into `lib/tickState.js`, persisted to
    `chrome.storage.local` the same way `dailyState.js` already was — see
    that file's comment for the full explanation, and the restart-simulation
    test that reproduces and confirms the fix for this exact failure mode.
  Given bugs of the second and third kind already made it through once,
  budget for an actual multi-minute smoke test after loading unpacked —
  watch the popup for a few minutes of real, continuous use and confirm the
  active/idle split roughly matches what you actually did, not just that
  the UI renders and numbers move at all.
  Before rolling out, smoke-test end to end: load unpacked, sign in against
  a staging Supabase project, and watch a `site_activity` row update.
- The `ams-integration` pages haven't been run inside an actual Next.js app
  (no such app is available in this environment) — expect minor import-path
  fixes when you drop them in (see Setup step 3 above).
