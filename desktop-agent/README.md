# Evolut Productivity Agent (Windows desktop)

A standalone Windows tray app that tracks productive/unproductive time
across **all** applications, including the browser — the sole tracking
tool for employees, no Chrome extension required. Uses the same Supabase
project and login as the AMS.

**No signed installer yet.** `npm run build:win` does produce a working
one-click NSIS installer (verified — see "What was actually verified"
below), but it's unsigned: `Get-AuthenticodeSignature` on the output
reports `NotSigned`, so Windows SmartScreen and most antivirus/EDR will
flag it on every employee machine until it's code-signed. See "What's not
done" before rolling this out to anyone.

## How it works

1. Sign in with the same AMS email/password.
2. Click **Start**. Global keyboard/mouse counting and foreground-app
   detection begin, covering every application — Excel, an IDE, Slack,
   the browser, anything.
3. Every 3 minutes (hidden from the employee, per spec), it checks whether
   that window saw enough keypresses **or** enough mouse/scroll activity —
   the identical formula and thresholds as the original extension design,
   kept in `src/productivityFormula.js`.
4. Tracking stops when you click **Stop**, when you lock the PC
   (`powerMonitor`'s `lock-screen` event — stops tracking but does **not**
   sign you out; unlocking doesn't auto-resume either, click Start again
   when you're back), or when you quit the app (with a confirmation, since
   quitting now means a real coverage gap). The app is registered to
   auto-start on Windows login, since a sole tracking tool needs to
   actually be running for tracking to happen at all.

## The tradeoff you already accepted

This agent has **no visibility into which website is open inside a
browser** — `active-win` (the library used for foreground-app detection)
can only report that "Chrome" is the foreground process, not which tab or
URL. So browser time is tracked as one bucket (e.g. `chrome.exe`) with a
productive/unproductive split, same as any other app, but with none of the
per-site detail or category labels (`PRODUCTIVE`/`DISTRACTING` per
hostname) the browser extension could see. That's a deliberate,
accepted simplification — not a bug to fix later, unless you decide the
site-level detail is worth reintroducing the extension for.

## What is and isn't tracked

**Tracked (only while a session is running):** count of key presses and
mouse moves/clicks/scrolls (numbers only — never which key, never window
content); which application is in the foreground (the executable name
only, e.g. `EXCEL.EXE` or `chrome.exe` — **never the window title**, which
can contain a document name, page title, or other content `active-win`
happens to expose but this code explicitly discards); and how often the
foreground application changes (`app_switch_count` — a coarser, poll-based
analog of the extension's tab-switch count, since there's no
foreground-changed *event* available here, only a 5-second snapshot).

**Never tracked:** what you typed, any window/document content, window
titles, screenshots, clipboard, webcam, or audio, and nothing at all
outside a running Start/Stop session.

**Always visible:** the tray icon tooltip always shows a state (signed
out / ready / running), and quitting requires an explicit confirmation
rather than being a stray-click accident.

## Setup (development)

```bash
cd desktop-agent
npm install
cp .env.example .env   # same Supabase URL/anon key as the AMS's .env.local
npm start
```

Click the tray icon to open the popup, sign in, click Start.

## Database

Writes to `productivity_sessions` (the daily rollup — `total_productive_
seconds`, `total_unproductive_seconds`, `app_switch_count`) and
`app_activity` (the per-application breakdown), both from
`supabase/schema.sql`. This agent is the sole writer to
`productivity_sessions` in this deployment — if a browser extension is
ever reintroduced alongside it, that table would need to go back to being
extension-only, with the two totals combined at query time instead via
the `daily_productivity_totals` view (still in the schema, unused for now
but there if needed).

## What's not done — read before rolling this out

- **No signed installer.** `package.json` has an `electron-builder` config
  (`npm run build:win`) that will *produce* an NSIS installer, but an
  unsigned one will be flagged by Windows SmartScreen and most antivirus/
  EDR software on every employee machine. A global keyboard/mouse hook is
  the same mechanism a malicious keylogger uses — code signing (a
  purchased certificate) and likely proactive outreach to AV vendors for
  allowlisting are both needed before wide deployment, and neither is
  something this pass could do for you.
- **No update mechanism.** Auto-start on login is wired up, but shipping a
  code change means manually redeploying to every machine — no
  auto-updater yet.
- **No anti-gaming heuristics.** The extension design's uniform-interval /
  minimal-movement / etc. pattern detection was deliberately not
  replicated here — this agent's productive/unproductive signal exists,
  but the "flag for human review" layer doesn't yet.
- **Per-window app attribution is an approximation.** If the foreground
  app changes mid-window, each app gets its own accurately-timed share
  (via 5-second polling), but the productive/unproductive *verdict* is
  still whole-window (based on total key/mouse activity across the full 3
  minutes), not attributed per-app-within-the-window.

## What was actually verified in this environment

- Both native dependencies (`uiohook-napi` for global input, `active-win`
  for foreground-window detection) install without needing a local
  compiler toolchain, and were smoke-tested directly: `active-win`
  correctly returns the foreground app's executable path, and the
  keyboard/mouse hook starts without error.
- The full app was launched (`npm start`) with real Supabase credentials
  after every change in this pass and stays running without crashing.
- `dailyState.js`'s accumulation (including that browsers now accumulate
  like any other app, and `app_switch_count`) and its normalization
  against a stale/foreign shape on disk were confirmed with scripted
  tests, along with confirming this agent uses the identical productivity
  formula as the original extension design.
- **`npm run build:win` was run for real** and produces a working one-click
  NSIS installer (`dist/Evolut Productivity Agent Setup 1.0.0.exe`, ~114MB).
  Confirmed unsigned via `Get-AuthenticodeSignature` (`Status: NotSigned`) —
  see above.
- **A real Start→work→sync round trip has since been confirmed against
  production data**, not just scripted tests: after real usage (tracking
  correctly accumulated ~24 minutes across `chrome.exe`, an editor, and
  other apps), a sync failure was diagnosed by reproducing the exact
  Supabase calls with the real cached session and real accumulated
  data — root cause was a database that hadn't been updated to the current
  `supabase/schema.sql` (missing `app_activity` table and
  `app_switch_count` column), not an application bug. Once the schema was
  brought current, sync succeeded and the dashboard reflected real data.
- **Not verified**: the actual tray icon rendering or the popup window's
  visual layout (no way to see a native window render from this
  environment), and the confirm-before-quit / lock-screen-stops-tracking
  dialogs specifically (added after the round trip above, not yet
  exercised against a real lock/quit).
