// Local accumulator for "today" (UTC), persisted to chrome.storage.local so
// it survives the service worker being killed/restarted. sync.js pushes the
// current snapshot to Supabase on a schedule; nothing here talks to the
// network directly.

const STORAGE_KEY = 'pt_day_state';

function utcDateString(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function emptyState(date) {
  return {
    workDate: date,
    sites: {}, // hostname -> { productiveSeconds, unproductiveSeconds, category }
    totalProductiveSeconds: 0,
    totalUnproductiveSeconds: 0,
    tabSwitchCount: 0,
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

// Call at the top of every window evaluation, before touching state. If the
// UTC day has rolled over, hands the previous day's final snapshot to
// `onRollover` (sync.js's flush) so the last window before midnight isn't
// dropped, then starts today fresh.
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

// Commits one resolved 3-minute (or partial, at session start/stop) window:
// `seconds` actually elapsed, classified as productive or unproductive as a
// whole by the caller's key/mouse-activity formula, attributed to whatever
// hostname was focused when the window closed.
export async function commitWindow({ hostname, seconds, isProductive, category }) {
  const state = await loadState();
  const secs = Math.max(0, Math.round(seconds));
  if (secs === 0) return state;

  if (hostname) {
    if (!state.sites[hostname]) {
      state.sites[hostname] = { productiveSeconds: 0, unproductiveSeconds: 0, category: category ?? 'UNCATEGORIZED' };
    }
    if (category) state.sites[hostname].category = category;
    const site = state.sites[hostname];
    if (isProductive) site.productiveSeconds += secs;
    else site.unproductiveSeconds += secs;
  }

  if (isProductive) state.totalProductiveSeconds += secs;
  else state.totalUnproductiveSeconds += secs;

  await saveState();
  return state;
}

export async function recordTabSwitch() {
  const state = await loadState();
  state.tabSwitchCount += 1;
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
