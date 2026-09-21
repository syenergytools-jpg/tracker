# AMS Productivity Tracker

A Chrome extension that tracks employee productive/unproductive time and
site categories via an explicit Start/Stop session, using the same Supabase
project and login as the existing AMS. Built to the constraints in the
original brief: no keystroke content, no page content, no screenshots, and
never covert.

**Scope note:** this tracks activity *inside the browser* — keyboard/mouse
events on web pages, and which site/tab is focused. It has no visibility
into other applications (Excel, Slack desktop, an IDE, etc.). Covering those
would mean a native, system-wide input-monitoring component outside the
browser, which is a materially different and much larger project than a
Chrome extension — this repo does not attempt that.

## How tracking works

1. Sign in via the popup with an AMS email/password.
2. Click **Start**. A session timer begins counting up from `00:00:00`.
3. Tracking runs until you click **Stop**, or the browser/system closes —
   whichever comes first. Closing the browser doesn't need special handling
   to detect: the running flag lives in `chrome.storage.session`, which
   Chrome itself clears on a full browser close, so reopening just finds no
   session running.
4. While running, every 3 minutes the extension privately checks: did this
   window see at least a certain number of keypresses **or** at least a
   certain amount of mouse activity (moves + clicks + scrolls, summed)?
   Either on its own is enough — if so, the whole 3 minutes counts as
   **Productive**; if neither crosses its threshold, the whole 3 minutes
   counts as **Unproductive**. This check is intentionally not shown to the
   employee — the popup only ever shows the running session timer and
   today's cumulative Productive / Unproductive totals, never a per-window
   verdict.
5. Tab switches are counted separately the whole time a session runs.

## What is and isn't tracked

Share this section (or a copy of it) with employees before rollout — several
jurisdictions legally require notice for this kind of monitoring, and that's
on the business to handle, not something this tool can substitute for.

**Tracked (only while a session is running):**
- Which website (hostname only, e.g. `docs.google.com` — never the full URL
  or page content) is open in the active browser tab.
- A count of key presses, mouse moves, mouse clicks, and scroll events — as
  numbers only. Never which key, never typed text, never form contents,
  never clipboard.
- Every 3 minutes, whether those counts crossed the productive threshold
  (see above) — recorded as Productive or Unproductive seconds, attributed
  to whichever site was focused when the window closed.
- Tab-switch counts, and coarse timing/movement statistics on the same
  key/mouse counts (e.g. "were mouse movements suspiciously uniform"), used
  only for the best-effort anti-gaming flags below — not what was clicked or
  typed.

**Never tracked:** what you typed, page text or form field contents,
screenshots or screen recording, clipboard, webcam, or audio. Nothing is
tracked before Start is clicked or after Stop / a browser close.

**Always visible:** the toolbar badge always shows a state (`OFF` signed
out, `RDY` signed in but stopped, `RUN` while a session runs) and the popup
shows the live session timer plus today's totals. It never runs invisibly.

**Be aware:** the productive/unproductive formula only requires *either*
real typing or real mouse/scroll activity within the same 3-minute window —
so keyboard-only work (e.g. writing code with little mouse use) and
mouse-only work (e.g. reviewing a design with little typing) both count as
productive on their own. The tradeoff is the opposite of an AND-based
formula: it's more forgiving of one-sided legitimate work, but also easier
to satisfy with minimal, non-work activity (e.g. idly scrolling). The two
thresholds (`PRODUCTIVE_KEY_THRESHOLD`, `PRODUCTIVE_MOUSE_ACTIVITY_
THRESHOLD` in `extension/src/lib/productivityFormula.js`) are deliberately
the only tunable knobs; adjust them from observed false-positive/negative
rates rather than reworking the OR shape.

## Project layout

```
supabase/schema.sql   — the whole schema, as one idempotent script (see below)
extension/             — the Chrome extension (MV3)
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
sessions`, and `site_categories` with `create table if not exists`, and
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

### 2. Extension

```bash
cd extension
npm install
cp .env.example .env   # fill in the same Supabase URL/anon key as the AMS's .env.local
npm run build
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → select `extension/dist`.

Sign in with an existing AMS email/password, then click **Start**.
`npm run watch` rebuilds on file changes during development (you'll still
need to click the reload icon on `chrome://extensions` after a rebuild, and
refresh any tabs that were already open before that reload — see
"Limitations" below).

## Anti-gaming flags — what they mean

`productivity_sessions.flagged_suspicious` / `flag_reason` are set by
best-effort pattern matching (uniform input timing, near-zero mouse
movement, key-only activity with nothing else, or rapid tab switching with
no dwell time) — see `extension/src/lib/heuristics.js`. These are
**statistical anomalies for a human to review, not proof of anything**, and
they're independent of the productive/unproductive formula above — a
session can be flagged regardless of how its windows were classified.
Nothing here auto-penalizes an employee, and nothing here can reliably
detect a physical mouse jiggler or auto-clicker — those produce real
OS-level input, indistinguishable from a human by any browser extension.

## Architecture notes

- **Why a 3-minute alarm works cleanly here:** Chrome clamps repeating
  `chrome.alarms` to a 1-minute floor once an extension is packed/published.
  The spec's window size (3 minutes) is comfortably above that floor, so —
  unlike an earlier design in this project that used a 30s/60s tick and had
  to explicitly account for the clamp — no compromise was needed here.
- **Why session/window state lives in `chrome.storage.session`, not plain
  variables:** MV3 service workers are killed and cold-started constantly —
  often between almost every content-script activity batch (~7s) and the
  3-minute window alarm. Anything held only in a module-level `let` gets
  wiped on each restart. `extension/src/lib/sessionState.js` and
  `dailyState.js` persist everything that needs to survive that (today's
  totals, and the current session/window's running counts) to
  `chrome.storage`, loaded once and mutated in place. `chrome.storage
  .session` specifically (rather than `.local`) is used for the run/window
  state because it's *also* cleared on a full browser close — which is
  exactly the "stop when the browser closes" behavior needed, with no extra
  detection code.
- **Why `chrome.alarms.create()` is only ever called if the alarm doesn't
  already exist:** re-creating an alarm resets its schedule. Since the
  top-level script re-runs on every service worker cold start, calling
  `create()` unconditionally there kept pushing the alarm's next fire time
  back before it ever arrived — the underlying alarm is durable across
  restarts, it just must not be re-created every time. See `ensureAlarm` in
  `background.js`.
- **Why `sync.js` always overwrites Supabase with the day's running total**
  rather than sending a since-last-sync delta: an additive "increment and
  reset" scheme can double-count if a response is lost after the server
  already committed it. Local state keeps the full day's total and every
  sync overwrites with that total, which is trivially safe to retry.

## Limitations of this pass

- **Not tested against a real Chrome profile or a real Supabase project** —
  there's no Supabase project connected in this environment and it can't
  drive `chrome://extensions` directly. What *was* verified: the extension
  builds cleanly with `npm run build`; `dailyState.commitWindow`, the
  productive/unproductive formula's threshold edges, tab-switch/flag
  bookkeeping, and all four anti-gaming heuristics were exercised with
  scripted inputs; `sessionState`'s persistence was confirmed to survive a
  simulated service-worker restart; and the actual popup HTML/CSS/JS were
  run in a browser against a mocked `chrome.runtime` (including a fake
  window that turns productive after simulated activity) to check Start/
  Stop, the session timer, and the totals stay in sync end to end.
  Before rolling out, still smoke-test for real: load unpacked, sign in
  against a staging Supabase project, run a session for several minutes of
  genuine mixed work, and confirm the Productive/Unproductive split is
  reasonable and a `site_activity` row actually updates.
- **Real bugs already caught this way, worth knowing about** since this
  pass can't run that real-world smoke test itself:
  - A CSS bug where a "stopped" banner could stay visible regardless of
    actual state, because `.hidden` was only ever defined as `.view.hidden`
    and didn't hide non-`.view` elements.
  - Totals stuck at zero, from the alarm-recreation bug described above.
  - Time being systematically miscounted, from tracking bookkeeping
    (equivalent to today's `sessionState.js`) living only in plain
    module-level variables that a service-worker restart would wipe.
  All three were architectural, not one-off typos — the general lesson
  (anything that must survive a tick-to-tick or restart-to-restart gap
  belongs in `chrome.storage`, not a `let`) is now applied consistently, but
  a real multi-minute smoke test is still the way to catch anything like
  this that scripted tests didn't.
- The productive/unproductive formula uses OR (either keys or mouse
  activity alone is enough) — a deliberate, known tradeoff, not a bug. It's
  more forgiving of one-sided legitimate work than an AND-based formula
  would be, but also easier to satisfy with minimal, non-work activity.
  It's still the first thing to reconsider — along with remembering this
  only sees activity inside the browser tab, not other applications — if
  reported numbers don't match reality.
