const { uIOhook } = require('uiohook-napi');
const { getForegroundAppName } = require('./appTracking');
const { isSubBlockActive } = require('./productivityFormula');
const dailyState = require('./dailyState');
const { syncWithRetry } = require('./sync');

// Level 2 "active-seconds" model: time is measured in 15-second sub-blocks,
// each judged active (-> productive) or idle (-> unproductive) on its own.
// The day's productive/unproductive split is the sum of those blocks, which
// is what spreads scores out instead of pinning everyone near 100%.
const SUBBLOCK_MS = 15 * 1000; // 12 blocks per 3 minutes
const APP_POLL_MS = 5000;
const SYNC_PERIOD_MS = 3 * 60 * 1000;

let running = false;
let sessionStartedAt = null;

// Real-intent counters for the CURRENT 15s block only; reset every block.
let blockKeyCount = 0;
let blockClickScrollCount = 0;

// Foreground app changes can happen mid-block. Rather than attributing the
// whole block to whichever app merely happened to be in front at the instant
// it resolved, this accumulates real wall-clock seconds per app via polling,
// so each app that was actually used gets its own accurate share. (active-win
// can only report the foreground process, not which tab/site is open inside a
// browser, so browsers are tracked like any other app, without per-site
// detail.) The active/idle verdict itself is per-block, based on total
// key/click/scroll activity across that block.
let blockAppSeconds = new Map();
let lastPollAt = null;
let lastSeenAppName = null;

let subBlockTimer = null;
let appPollTimer = null;
let syncTimer = null;

let currentUserId = null;

function onKeyDown() {
  blockKeyCount += 1;
}
function onClickOrScroll() {
  blockClickScrollCount += 1;
}

// Deliberately NOT listening for 'mousemove'. Raw cursor movement is not work
// — it used to be counted and, firing 60-120 events/sec against a tiny
// threshold, made simply resting a hand on the mouse score ~100%. Only real
// intent counts now: keystrokes, mouse clicks, and scroll-wheel ticks.
uIOhook.on('keydown', onKeyDown);
uIOhook.on('mousedown', onClickOrScroll);
uIOhook.on('wheel', onClickOrScroll);

async function pollForegroundApp() {
  const appName = await getForegroundAppName();
  const now = Date.now();
  const elapsedSinceLastPoll = lastPollAt ? (now - lastPollAt) / 1000 : APP_POLL_MS / 1000;
  lastPollAt = now;

  if (appName) {
    blockAppSeconds.set(appName, (blockAppSeconds.get(appName) ?? 0) + elapsedSinceLastPoll);

    // Poll-based, so this only catches switches that persist across a 5-second
    // sample — a coarse signal, since active-win only exposes a "what's in
    // front right now" snapshot, not a foreground-changed event.
    if (lastSeenAppName && appName !== lastSeenAppName) {
      dailyState.recordAppSwitch();
    }
    lastSeenAppName = appName;
  }
}

async function resolveSubBlock() {
  await dailyState.rotateIfNeeded((staleState) => flush(staleState));

  // Capture the seconds right up to this block boundary before committing, so
  // the block owns its full ~15s instead of losing the tail since the last
  // 5s poll.
  await pollForegroundApp();

  const isProductive = isSubBlockActive({
    keyCount: blockKeyCount,
    clickScrollCount: blockClickScrollCount,
  });

  // Every app used in the block inherits the block's verdict. An idle block
  // (no keys/clicks/scroll) is productive === false, so idle time becomes
  // unproductive time — this is the idle penalty, at 15s granularity.
  for (const [appName, seconds] of blockAppSeconds.entries()) {
    dailyState.commitWindow({ appName, seconds, isProductive });
  }

  blockAppSeconds = new Map();
  blockKeyCount = 0;
  blockClickScrollCount = 0;
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
  blockKeyCount = 0;
  blockClickScrollCount = 0;
  blockAppSeconds = new Map();
  lastPollAt = null;
  lastSeenAppName = null;

  uIOhook.start();
  appPollTimer = setInterval(pollForegroundApp, APP_POLL_MS);
  subBlockTimer = setInterval(() => {
    resolveSubBlock();
  }, SUBBLOCK_MS);
  syncTimer = setInterval(() => flush(), SYNC_PERIOD_MS);

  return { running: true, sessionStartedAt };
}

async function stop() {
  if (!running) return { running: false };

  clearInterval(appPollTimer);
  clearInterval(subBlockTimer);
  clearInterval(syncTimer);
  appPollTimer = null;
  subBlockTimer = null;
  syncTimer = null;
  uIOhook.stop();

  // Resolve whatever partial block accumulated since the last 15s boundary
  // (resolveSubBlock does a final poll itself), rather than discarding it.
  await resolveSubBlock();
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
