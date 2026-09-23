const { uIOhook } = require('uiohook-napi');
const { getForegroundAppName } = require('./appTracking');
const { isWindowProductive } = require('./productivityFormula');
const dailyState = require('./dailyState');
const { syncWithRetry } = require('./sync');

const WINDOW_MS = 3 * 60 * 1000; // 3 minutes — same as the extension, and for the same reason: hidden from the employee, see popup.js
const APP_POLL_MS = 5000;
const SYNC_PERIOD_MS = 3 * 60 * 1000;

let running = false;
let sessionStartedAt = null;
let windowKeyCount = 0;
let windowMouseActivityCount = 0;

// Foreground app changes can happen mid-window (e.g. 2 minutes in Excel,
// then a minute in Chrome before the window closes). Rather than
// attributing the whole 3-minute window to whichever app merely happened
// to be in front at the instant it resolved, this accumulates real
// wall-clock seconds per app via polling, so each app that was actually
// used gets its own accurate share of the window — this is the sole
// tracking source now (see README: no separate browser-only tool), so
// browsers are tracked the same as any other app, just without per-site
// detail (active-win can only report the foreground process, not which
// tab/site is open inside it). The productive/unproductive verdict itself
// is still whole-window (based on total key/mouse activity across the
// window) — there's no reliable way to attribute which keystrokes happened
// in which app without much finer correlation than this attempts.
let windowAppSeconds = new Map();
let lastPollAt = null;
let lastSeenAppName = null;

let windowTimer = null;
let appPollTimer = null;
let syncTimer = null;

let currentUserId = null;

function onKeyDown() {
  windowKeyCount += 1;
}
function onMouseActivity() {
  windowMouseActivityCount += 1;
}

uIOhook.on('keydown', onKeyDown);
uIOhook.on('mousemove', onMouseActivity);
uIOhook.on('mousedown', onMouseActivity);
uIOhook.on('wheel', onMouseActivity);

async function pollForegroundApp() {
  const appName = await getForegroundAppName();
  const now = Date.now();
  const elapsedSinceLastPoll = lastPollAt ? (now - lastPollAt) / 1000 : APP_POLL_MS / 1000;
  lastPollAt = now;

  if (appName) {
    windowAppSeconds.set(appName, (windowAppSeconds.get(appName) ?? 0) + elapsedSinceLastPoll);

    // Poll-based, so this only catches switches that persist across a
    // 5-second sample — a much coarser signal than the extension's
    // event-driven tab-switch count, since active-win only exposes a
    // "what's in front right now" snapshot, not a foreground-changed event.
    if (lastSeenAppName && appName !== lastSeenAppName) {
      dailyState.recordAppSwitch();
    }
    lastSeenAppName = appName;
  }
}

async function resolveWindow() {
  await dailyState.rotateIfNeeded((staleState) => flush(staleState));

  const isProductive = isWindowProductive({
    keyCount: windowKeyCount,
    mouseActivityCount: windowMouseActivityCount,
  });

  for (const [appName, seconds] of windowAppSeconds.entries()) {
    dailyState.commitWindow({ appName, seconds, isProductive });
  }

  windowAppSeconds = new Map();
  windowKeyCount = 0;
  windowMouseActivityCount = 0;
}

async function flush(stateOverride) {
  if (!currentUserId) return;
  const state = stateOverride ?? dailyState.getState();
  await syncWithRetry(state, currentUserId);
}

function start(userId) {
  if (running) return { running: true, sessionStartedAt };
  currentUserId = userId;

  running = true;
  sessionStartedAt = Date.now();
  windowKeyCount = 0;
  windowMouseActivityCount = 0;
  windowAppSeconds = new Map();
  lastPollAt = null;
  lastSeenAppName = null;

  uIOhook.start();
  appPollTimer = setInterval(pollForegroundApp, APP_POLL_MS);
  windowTimer = setInterval(() => {
    resolveWindow();
  }, WINDOW_MS);
  syncTimer = setInterval(() => flush(), SYNC_PERIOD_MS);

  return { running: true, sessionStartedAt };
}

async function stop() {
  if (!running) return { running: false };

  clearInterval(appPollTimer);
  clearInterval(windowTimer);
  clearInterval(syncTimer);
  appPollTimer = null;
  windowTimer = null;
  syncTimer = null;
  uIOhook.stop();

  // Resolve whatever partial window accumulated since the last full 3
  // minutes, rather than discarding it.
  await pollForegroundApp(); // final poll so the last stretch is attributed
  await resolveWindow();
  await flush();

  running = false;
  sessionStartedAt = null;

  return { running: false };
}

function getStatus() {
  const state = dailyState.getState();
  return {
    running,
    sessionStartedAt,
    todayProductiveSeconds: state.totalProductiveSeconds,
    todayUnproductiveSeconds: state.totalUnproductiveSeconds,
  };
}

function setUser(userId) {
  currentUserId = userId;
}

module.exports = { start, stop, getStatus, setUser };
