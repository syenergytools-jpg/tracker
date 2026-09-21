// Start/Stop session bookkeeping, plus the current (hidden) 3-minute
// evaluation window's running key/mouse-activity counts.
//
// Backed by chrome.storage.session, not chrome.storage.local:
//   - Like local storage, it survives a service worker restart (MV3 kills
//     the worker constantly — see dailyState.js for why that matters).
//   - Unlike local storage, it's cleared when the browser itself fully
//     closes. That gives "stop tracking when the browser/system closes"
//     for free, with no code needed to detect a shutdown — reopening the
//     browser just finds no session state and starts stopped.
// A session that ends abruptly (browser killed mid-window) loses only the
// current partial window's count, not any already-committed totals —
// those live in dailyState.js under chrome.storage.local.

const STORAGE_KEY = 'pt_session_state';

function emptyState() {
  return {
    running: false,
    sessionStartedAt: null,
    windowStartAt: null,
    windowKeyCount: 0,
    windowMouseActivityCount: 0,
  };
}

let cache = null;

function toFiniteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

// Same defensive normalization as dailyState.js — never trust a stored
// shape blindly, since a missing/non-numeric field silently becomes
// permanent NaN the moment something adds to it.
function normalizeState(existing) {
  const base = emptyState();
  if (!existing || typeof existing !== 'object') return base;
  return {
    ...base,
    ...existing,
    windowKeyCount: toFiniteNumber(existing.windowKeyCount, 0),
    windowMouseActivityCount: toFiniteNumber(existing.windowMouseActivityCount, 0),
  };
}

export async function getSessionState() {
  if (cache) return cache;
  const stored = await chrome.storage.session.get(STORAGE_KEY);
  cache = normalizeState(stored[STORAGE_KEY]);
  return cache;
}

export async function saveSessionState() {
  if (cache) await chrome.storage.session.set({ [STORAGE_KEY]: cache });
}
