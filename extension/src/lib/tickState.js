// Per-tick idle-detection bookkeeping that MUST survive service worker
// restarts. MV3 terminates the service worker aggressively — often between
// almost every content-script activity batch (~7s) and the ~60s tick alarm
// — and each cold start re-runs background.js from scratch. If this lived
// only in module-level variables, `lastInputAt` would keep getting wiped
// back to 0 by an intervening restart, making genuinely active time look
// idle to the very next tick. Persisted the same way as dailyState.js:
// load once, mutate the live cached object, save explicitly.

const STORAGE_KEY = 'pt_tick_state';

function emptyState() {
  return {
    lastInputAt: 0,
    osIdleState: 'active',
    idleStreakConfirmed: false,
    pendingTicks: [],
  };
}

let cache = null;

export async function getTickState() {
  if (cache) return cache;
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  cache = stored[STORAGE_KEY] ?? emptyState();
  return cache;
}

export async function saveTickState() {
  if (cache) await chrome.storage.local.set({ [STORAGE_KEY]: cache });
}
