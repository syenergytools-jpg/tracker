import { supabase, ensureFreshSession, fetchProfile } from './lib/supabaseClient.js';
import {
  rotateIfNeeded,
  getState,
  commitTicks,
  recordTabSwitch,
  applyFlagReasons,
  addPausedSeconds,
  TICK_SECONDS,
} from './lib/dailyState.js';
import { getCategory, refreshCategories } from './lib/categories.js';
import { createHeuristicsEngine } from './lib/heuristics.js';
import { syncWithRetry } from './lib/sync.js';
import { getPauseState, isPaused, setPaused } from './lib/pauseState.js';
import { getTickState, saveTickState } from './lib/tickState.js';

// Chrome clamps repeating alarms to a 1-minute floor once an extension is
// packed/published (unpacked dev builds can get away with shorter periods,
// but that would silently break on release). The brief's 30s tick and 180s
// idle window still hold in spirit — TICK_SECONDS = 60 everywhere, so "3
// minutes of silence" is 3 ticks instead of 6. Do not use setInterval here;
// MV3 kills service workers that try to keep their own timers alive.
const IDLE_THRESHOLD_MS = 180 * 1000;
const FLUSH_PERIOD_MINUTES = 3;

let focusedTabId = null;
let currentHostname = null;
let tabFocusedAt = 0;

let currentUser = null; // { id, role, email }
const heuristics = createHeuristicsEngine();

// ---- lifecycle -------------------------------------------------------

chrome.idle.setDetectionInterval(60);
chrome.idle.onStateChanged.addListener((state) => {
  // 'active' | 'idle' | 'locked' — persisted; see tickState.js for why.
  recordOsIdleState(state);
});

async function recordOsIdleState(state) {
  const tickState = await getTickState();
  tickState.osIdleState = state;
  await saveTickState();
}

// chrome.alarms.create() resets an alarm's schedule if one by that name
// already exists. This code re-runs on every service worker cold start
// (frequent in MV3 — even the popup's own status polling can trigger one),
// so creating unconditionally kept pushing the tick's "next fire" time back
// before it ever arrived, and nothing was ever committed. Only create an
// alarm that doesn't already exist.
async function ensureAlarm(name, alarmInfo) {
  const existing = await chrome.alarms.get(name);
  if (!existing) chrome.alarms.create(name, alarmInfo);
}

ensureAlarm('tick', { periodInMinutes: 1 });
ensureAlarm('flush', { periodInMinutes: FLUSH_PERIOD_MINUTES });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'tick') handleTick();
  else if (alarm.name === 'flush') flush();
});

chrome.runtime.onSuspend.addListener(() => {
  // Best-effort only — MV3 does not guarantee async work here finishes
  // before the process is torn down. Real resilience comes from persisting
  // state to chrome.storage.local on every tick and flushing every few
  // minutes, not from this hook.
  flush();
});

restoreSession();
initFocusedTab();

async function restoreSession() {
  const { data: { session } } = await supabase.auth.getSession();
  await loadCurrentUser(session);
  refreshCategories();
}

async function initFocusedTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) await handleTabFocusChange(tab.id);
}

// ---- tab / focus tracking ---------------------------------------------

chrome.tabs.onActivated.addListener(({ tabId }) => handleTabFocusChange(tabId));

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return; // browser lost OS focus; keep last known tab
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab) await handleTabFocusChange(tab.id);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId === focusedTabId && changeInfo.url && tab.active) {
    currentHostname = hostnameOf(changeInfo.url);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === focusedTabId) {
    focusedTabId = null;
    currentHostname = null;
  }
});

async function handleTabFocusChange(tabId) {
  const isFirstFocus = focusedTabId === null;
  const dwellMs = tabFocusedAt ? Date.now() - tabFocusedAt : null;

  focusedTabId = tabId;
  tabFocusedAt = Date.now();

  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    // tab closed before we could read it
  }
  currentHostname = hostnameOf(tab?.url);

  if (!isFirstFocus && !(await isPaused())) {
    await recordTabSwitch();
    const reasons = heuristics.recordTabSwitch(dwellMs);
    if (reasons.length > 0) await applyFlagReasons(reasons);
  }
}

function hostnameOf(url) {
  try {
    return url ? new URL(url).hostname : null;
  } catch {
    return null; // chrome://, about:blank, etc. — not attributable to a site
  }
}

// ---- activity ingestion (from content.js) ------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    case 'ACTIVITY_BATCH':
      handleActivityBatch(message.payload, sender);
      return false;
    case 'GET_STATUS':
      handleGetStatus().then(sendResponse);
      return true;
    case 'SIGN_IN':
      handleSignIn(message.payload).then(sendResponse);
      return true;
    case 'SIGN_OUT':
      handleSignOut().then(sendResponse);
      return true;
    case 'SET_PAUSED':
      handleSetPaused(message.payload).then(sendResponse);
      return true;
    default:
      return false;
  }
});

async function handleActivityBatch(payload, sender) {
  if (!payload || sender.tab?.id !== focusedTabId) return; // only the focused tab counts
  if (await isPaused()) return;

  const hasActivity =
    payload.keyCount > 0 || payload.mouseMoveCount > 0 || payload.mouseDownCount > 0 || payload.scrollCount > 0;
  if (hasActivity) {
    const tickState = await getTickState();
    tickState.lastInputAt = payload.batchEndedAt ?? Date.now();
    await saveTickState();
  }

  const reasons = heuristics.recordBatch(payload);
  if (reasons.length > 0) applyFlagReasons(reasons);
}

// ---- idle detection tick ------------------------------------------------
//
// A tick is a 60s slice attributed to whatever hostname was focused during
// it. It's "active" if an input ping arrived AND the OS reports the user
// present; "idle" otherwise. To avoid punishing a normal pause (reading a
// doc for a minute without touching the mouse), a silent tick isn't
// committed immediately — it's held in `pendingTicks` until either new
// input arrives (resolve the whole buffer as active) or the silence reaches
// 180s (resolve the whole buffer as idle, backfilling every tick in it).
async function handleTick() {
  await rotateIfNeeded((staleState) => flush(staleState));

  if (await isPaused()) {
    await updateBadge();
    return;
  }

  const tickState = await getTickState();
  const now = Date.now();
  const hostname = currentHostname;

  if (tickState.osIdleState !== 'active') {
    const toResolve = [...tickState.pendingTicks, { hostname }];
    tickState.pendingTicks = [];
    tickState.idleStreakConfirmed = true;
    await saveTickState();
    await commitResolved(toResolve, false);
    await updateBadge();
    return;
  }

  const inputSinceLastTick = tickState.lastInputAt >= now - TICK_SECONDS * 1000;
  if (inputSinceLastTick) {
    const toResolve = [...tickState.pendingTicks, { hostname }];
    tickState.pendingTicks = [];
    tickState.idleStreakConfirmed = false;
    await saveTickState();
    await commitResolved(toResolve, true);
    await updateBadge();
    return;
  }

  if (tickState.idleStreakConfirmed) {
    await commitResolved([{ hostname }], false);
    await updateBadge();
    return;
  }

  tickState.pendingTicks.push({ hostname });
  if (now - tickState.lastInputAt >= IDLE_THRESHOLD_MS) {
    const toResolve = tickState.pendingTicks;
    tickState.pendingTicks = [];
    tickState.idleStreakConfirmed = true;
    await saveTickState();
    await commitResolved(toResolve, false);
  } else {
    await saveTickState();
  }
  await updateBadge();
}

// Manual "on a break" control (see extension popup). Distinct from idle:
// idle is inferred from silence, paused is an explicit employee action, and
// neither activity pings nor tab switches count while paused.
async function handleSetPaused({ paused }) {
  const current = await getPauseState();
  if (paused === current.paused) return { ok: true, paused };

  const tickState = await getTickState();

  if (paused) {
    // Resolve whatever's mid-buffer as active rather than leaving an
    // ambiguous tail to be judged later — the break started now, not
    // sometime in the last 180s.
    if (tickState.pendingTicks.length > 0) {
      await commitResolved(tickState.pendingTicks, true);
      tickState.pendingTicks = [];
    }
  } else {
    if (current.pausedAt) {
      await addPausedSeconds((Date.now() - current.pausedAt) / 1000);
    }
    // Coming back from a break isn't itself activity — start idle detection
    // fresh instead of trusting a stale pre-break lastInputAt.
    tickState.lastInputAt = 0;
    tickState.idleStreakConfirmed = false;
    tabFocusedAt = Date.now();
  }
  await saveTickState();

  await setPaused(paused);
  await updateBadge();
  return { ok: true, paused };
}

async function commitResolved(ticks, isActive) {
  if (ticks.length === 0) return;
  const uniqueHostnames = [...new Set(ticks.map((t) => t.hostname).filter(Boolean))];
  const categoryByHostname = new Map();
  for (const hostname of uniqueHostnames) {
    categoryByHostname.set(hostname, await getCategory(hostname));
  }
  await commitTicks(
    ticks.map((t) => ({
      hostname: t.hostname,
      isActive,
      category: t.hostname ? categoryByHostname.get(t.hostname) : undefined,
    }))
  );
}

// ---- sync ----------------------------------------------------------------

async function flush(stateOverride) {
  if (!currentUser) return;
  const state = stateOverride ?? (await getState());
  await syncWithRetry(state, currentUser.id);
}

// ---- auth ------------------------------------------------------------

async function loadCurrentUser(session) {
  if (!session) {
    currentUser = null;
    return;
  }
  try {
    const profile = await fetchProfile(session.user.id);
    currentUser = { id: session.user.id, role: profile.role, email: session.user.email };
  } catch (err) {
    console.warn('[ams-productivity] failed to load profile:', err);
    currentUser = { id: session.user.id, role: null, email: session.user.email };
  }
  await updateBadge();
}

async function handleGetStatus() {
  const session = await ensureFreshSession();
  if (!session) return { authenticated: false };
  if (!currentUser) await loadCurrentUser(session);
  const state = await getState();
  const paused = await isPaused();
  const tickState = await getTickState();
  const currentlyActive =
    !paused &&
    tickState.osIdleState === 'active' &&
    !tickState.idleStreakConfirmed &&
    tickState.lastInputAt >= Date.now() - TICK_SECONDS * 1000;
  return {
    authenticated: true,
    email: currentUser?.email ?? session.user.email,
    todayActiveSeconds: state.totalActiveSeconds,
    todayIdleSeconds: state.totalIdleSeconds,
    paused,
    currentlyActive,
  };
}

async function handleSignIn({ email, password }) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, error: error.message };
  await loadCurrentUser(data.session);
  return { ok: true, email: data.session.user.email };
}

async function handleSignOut() {
  await flush();
  await supabase.auth.signOut();
  currentUser = null;
  await setPaused(false); // don't carry a stale "on a break" across sessions
  await updateBadge();
  return { ok: true };
}

// ---- visible status badge -----------------------------------------------
// Required by design: this extension must never track silently. The badge
// always shows something, whether signed out, active, or idle.

async function updateBadge() {
  if (!currentUser) {
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#9CA3AF' });
    return;
  }
  if (await isPaused()) {
    chrome.action.setBadgeText({ text: 'BRK' });
    chrome.action.setBadgeBackgroundColor({ color: '#3B82F6' });
    return;
  }
  const tickState = await getTickState();
  const isActive =
    tickState.osIdleState === 'active' &&
    !tickState.idleStreakConfirmed &&
    tickState.lastInputAt >= Date.now() - TICK_SECONDS * 1000;
  chrome.action.setBadgeText({ text: isActive ? 'ON' : 'IDLE' });
  chrome.action.setBadgeBackgroundColor({ color: isActive ? '#16A34A' : '#F59E0B' });
}
