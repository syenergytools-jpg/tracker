// Local accumulator for "today" (UTC), persisted to chrome.storage.local so
// it survives the service worker being killed/restarted. sync.js pushes the
// current snapshot to Supabase on a schedule; nothing here talks to the
// network directly.

const STORAGE_KEY = 'pt_day_state';
export const TICK_SECONDS = 60; // see background.js for why this is 60, not 30

function utcDateString(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function emptyState(date) {
  return {
    workDate: date,
    sites: {}, // hostname -> { activeSeconds, idleSeconds, category }
    totalActiveSeconds: 0,
    totalIdleSeconds: 0,
    tabSwitchCount: 0,
    pausedSeconds: 0,
    flagReasons: [],
    lastSyncedAt: null,
  };
}

let cache = null;

async function loadState() {
  const today = utcDateString();
  if (cache && cache.workDate === today) return cache;

  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const existing = stored[STORAGE_KEY];
  cache = existing && existing.workDate === today ? existing : emptyState(today);
  return cache;
}

async function saveState() {
  if (cache) await chrome.storage.local.set({ [STORAGE_KEY]: cache });
}

// Call at the top of every tick, before touching state. If the UTC day has
// rolled over since the last tick, hands the previous day's final snapshot
// to `onRollover` (sync.js's flush) so the last few seconds before midnight
// aren't dropped, then starts today fresh.
export async function rotateIfNeeded(onRollover) {
  const today = utcDateString();
  if (cache && cache.workDate !== today) {
    const stale = cache;
    cache = null;
    if (onRollover) {
      try {
        await onRollover(stale);
      } catch (err) {
        console.warn('[ams-productivity] end-of-day flush failed:', err);
      }
    }
  }
  return loadState();
}

export async function getState() {
  return loadState();
}

// Commits one or more ticks at once — the idle-detection backfill (see
// background.js) resolves several buffered ticks in a single pass, each
// possibly attributed to a different hostname if a tab switch happened
// mid-buffer.
export async function commitTicks(ticks) {
  const state = await loadState();
  for (const { hostname, isActive, category } of ticks) {
    if (hostname) {
      if (!state.sites[hostname]) {
        state.sites[hostname] = { activeSeconds: 0, idleSeconds: 0, category: category ?? 'UNCATEGORIZED' };
      }
      if (category) state.sites[hostname].category = category;
      const site = state.sites[hostname];
      if (isActive) site.activeSeconds += TICK_SECONDS;
      else site.idleSeconds += TICK_SECONDS;
    }
    if (isActive) state.totalActiveSeconds += TICK_SECONDS;
    else state.totalIdleSeconds += TICK_SECONDS;
  }
  await saveState();
  return state;
}

export async function recordTabSwitch() {
  const state = await loadState();
  state.tabSwitchCount += 1;
  await saveState();
  return state;
}

// Called once on resume with the elapsed break duration (see
// pauseState.js) rather than accrued per-tick, since ticks are skipped
// entirely while paused. A pause spanning a UTC midnight rollover is
// attributed to whichever day the resume happens on — an acceptable
// simplification for a rare edge case.
export async function addPausedSeconds(seconds) {
  const state = await loadState();
  state.pausedSeconds = (state.pausedSeconds ?? 0) + Math.max(0, Math.round(seconds));
  await saveState();
  return state;
}

export async function applyFlagReasons(reasons) {
  if (!reasons || reasons.length === 0) return loadState();
  const state = await loadState();
  const merged = new Set([...state.flagReasons, ...reasons]);
  state.flagReasons = Array.from(merged);
  await saveState();
  return state;
}

export async function markSynced() {
  const state = await loadState();
  state.lastSyncedAt = Date.now();
  await saveState();
  return state;
}
