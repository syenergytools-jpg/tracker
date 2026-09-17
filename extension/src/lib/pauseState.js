// Manual pause ("I'm on a break") — separate from idle detection. Idle means
// "at the desk but not working"; paused means "the employee said so." No
// tick, activity ping, or tab-switch counts while paused. Persisted so it
// survives the service worker being killed/restarted mid-break.

const STORAGE_KEY = 'pt_paused_state';

let cache = null;

async function load() {
  if (cache) return cache;
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  cache = stored[STORAGE_KEY] ?? { paused: false, pausedAt: null };
  return cache;
}

export async function getPauseState() {
  return load();
}

export async function isPaused() {
  const state = await load();
  return state.paused;
}

export async function setPaused(paused) {
  const state = await load();
  state.paused = paused;
  state.pausedAt = paused ? Date.now() : null;
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  return state;
}
