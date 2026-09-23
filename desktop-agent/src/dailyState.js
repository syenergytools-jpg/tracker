// File-backed daily accumulator — see store.js for why this can be much
// simpler than the extension's chrome.storage-based equivalent (no
// service-worker-restart defensiveness needed in a long-lived process).
// Still normalizes on load in case a future schema change leaves an older
// shape on disk — same lesson learned from the extension's dailyState.js.

const { readJSON, writeJSON } = require('./store');

const KEY = 'daily-state';

function utcDateString(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function emptyState(date) {
  return {
    workDate: date,
    apps: {}, // appName -> { productiveSeconds, unproductiveSeconds }
    totalProductiveSeconds: 0,
    totalUnproductiveSeconds: 0,
    appSwitchCount: 0,
    lastSyncedAt: null,
  };
}

function toFiniteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeState(existing, today) {
  const base = emptyState(today);
  if (!existing || typeof existing !== 'object') return base;

  const apps = {};
  if (existing.apps && typeof existing.apps === 'object') {
    for (const [appName, appEntry] of Object.entries(existing.apps)) {
      apps[appName] = {
        productiveSeconds: toFiniteNumber(appEntry?.productiveSeconds, 0),
        unproductiveSeconds: toFiniteNumber(appEntry?.unproductiveSeconds, 0),
      };
    }
  }

  return {
    ...base,
    ...existing,
    apps,
    totalProductiveSeconds: toFiniteNumber(existing.totalProductiveSeconds, 0),
    totalUnproductiveSeconds: toFiniteNumber(existing.totalUnproductiveSeconds, 0),
    appSwitchCount: toFiniteNumber(existing.appSwitchCount, 0),
  };
}

let cache = null;

function loadState() {
  const today = utcDateString();
  if (cache && cache.workDate === today) return cache;
  const existing = readJSON(KEY, null);
  cache = existing && existing.workDate === today ? normalizeState(existing, today) : emptyState(today);
  return cache;
}

function saveState() {
  if (cache) writeJSON(KEY, cache);
}

async function rotateIfNeeded(onRollover) {
  const today = utcDateString();
  if (cache && cache.workDate !== today) {
    const stale = cache;
    cache = null;
    if (onRollover) {
      try {
        await onRollover(stale);
      } catch (err) {
        console.warn('[evolut-productivity-agent] end-of-day flush failed:', err);
      }
    }
  }
  return loadState();
}

function getState() {
  return loadState();
}

function commitWindow({ appName, seconds, isProductive }) {
  const state = loadState();
  const secs = Math.max(0, Math.round(seconds));
  if (secs === 0 || !appName) return state;

  if (!state.apps[appName]) state.apps[appName] = { productiveSeconds: 0, unproductiveSeconds: 0 };
  const appEntry = state.apps[appName];
  if (isProductive) appEntry.productiveSeconds += secs;
  else appEntry.unproductiveSeconds += secs;

  if (isProductive) state.totalProductiveSeconds += secs;
  else state.totalUnproductiveSeconds += secs;

  saveState();
  return state;
}

function recordAppSwitch() {
  const state = loadState();
  state.appSwitchCount += 1;
  saveState();
  return state;
}

function markSynced() {
  const state = loadState();
  state.lastSyncedAt = Date.now();
  saveState();
  return state;
}

module.exports = { getState, commitWindow, recordAppSwitch, rotateIfNeeded, markSynced };
