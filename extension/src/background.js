import { supabase, ensureFreshSession, fetchProfile } from './lib/supabaseClient.js';
import { rotateIfNeeded, getState, commitWindow, recordTabSwitch, applyFlagReasons } from './lib/dailyState.js';
import { getCategory, refreshCategories } from './lib/categories.js';
import { createHeuristicsEngine } from './lib/heuristics.js';
import { syncWithRetry } from './lib/sync.js';
import { getSessionState, saveSessionState } from './lib/sessionState.js';
import { isWindowProductive } from './lib/productivityFormula.js';

// The 3-minute evaluation is deliberately hidden from the employee (per
// spec) — the popup only ever shows the running session timer and today's
// cumulative Productive/Unproductive totals, never a per-window verdict.
// The classification thresholds themselves live in productivityFormula.js.
const WINDOW_SECONDS = 180;

let focusedTabId = null;
let currentHostname = null;
let tabFocusedAt = 0;

let currentUser = null; // { id, role, email }
const heuristics = createHeuristicsEngine();

// ---- lifecycle -------------------------------------------------------

// chrome.alarms.create() resets an alarm's schedule if one by that name
// already exists. This code re-runs on every service worker cold start
// (frequent in MV3 — even the popup's own status polling can trigger one),
// so creating unconditionally kept pushing the alarm's "next fire" time
// back before it ever arrived. Only create an alarm that doesn't already
// exist.
async function ensureAlarm(name, alarmInfo) {
  const existing = await chrome.alarms.get(name);
  if (!existing) chrome.alarms.create(name, alarmInfo);
}

ensureAlarm('window', { periodInMinutes: WINDOW_SECONDS / 60 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'window') return;
  // An uncaught rejection here would otherwise fail silently — this is a
  // recurring 3-minute handler with no caller to report back to, so it's
  // the only chance to surface a problem before it repeats indefinitely.
  handleWindowAlarm().catch((err) => console.error('[ams-productivity] window evaluation failed:', err));
});

chrome.runtime.onSuspend.addListener(() => {
  // Best-effort only — MV3 does not guarantee async work here finishes
  // before the process is torn down. A session ended by an unclean browser
  // close simply loses its current partial window, nothing more.
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

  if (isFirstFocus) return;

  const trackSession = await getSessionState();
  if (!trackSession.running) return;

  await recordTabSwitch();
  const reasons = heuristics.recordTabSwitch(dwellMs);
  if (reasons.length > 0) await applyFlagReasons(reasons);
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
    case 'START':
      handleStart().then(sendResponse);
      return true;
    case 'STOP':
      handleStop().then(sendResponse);
      return true;
    default:
      return false;
  }
});

async function handleActivityBatch(payload, sender) {
  // Previously also required `sender.tab?.id === focusedTabId`. Dropped:
  // a background/unfocused tab's page cannot receive real keydown/mousemove
  // DOM events from actual user input in the first place (the OS only
  // routes input to the focused window), so the check was redundant for
  // real activity — and it was a single point of failure that silently
  // dropped every batch if focusedTabId ever fell out of sync (e.g. missed
  // on the initial tab query, or lost across a service worker restart).
  if (!payload || !sender.tab) return;

  const trackSession = await getSessionState();
  if (!trackSession.running) return; // nothing accrues outside a Start/Stop session

  trackSession.windowKeyCount += payload.keyCount;
  trackSession.windowMouseActivityCount += payload.mouseMoveCount + payload.mouseDownCount + payload.scrollCount;
  await saveSessionState();
  console.debug(
    '[ams-productivity] activity batch:',
    JSON.stringify(payload),
    '-> window totals:',
    trackSession.windowKeyCount,
    'keys,',
    trackSession.windowMouseActivityCount,
    'mouse'
  );

  const reasons = heuristics.recordBatch(payload);
  if (reasons.length > 0) await applyFlagReasons(reasons);
}

// ---- 3-minute window evaluation ------------------------------------------

async function handleWindowAlarm() {
  await rotateIfNeeded((staleState) => flush(staleState));

  const trackSession = await getSessionState();
  if (!trackSession.running) return;

  const now = Date.now();
  const elapsedSeconds = trackSession.windowStartAt ? (now - trackSession.windowStartAt) / 1000 : WINDOW_SECONDS;
  await resolveWindow(trackSession, elapsedSeconds);

  trackSession.windowStartAt = now;
  trackSession.windowKeyCount = 0;
  trackSession.windowMouseActivityCount = 0;
  await saveSessionState();

  // Piggybacks on the same 3-minute cadence as the window evaluation, so a
  // long-running session (hours) still syncs periodically rather than only
  // at Stop time or the best-effort onSuspend flush.
  await flush();
}

async function resolveWindow(trackSession, elapsedSeconds) {
  if (elapsedSeconds <= 0) return;
  const isProductive = isWindowProductive({
    keyCount: trackSession.windowKeyCount,
    mouseActivityCount: trackSession.windowMouseActivityCount,
  });
  console.debug(
    '[ams-productivity] window resolved:',
    Math.round(elapsedSeconds),
    's, keys=',
    trackSession.windowKeyCount,
    'mouse=',
    trackSession.windowMouseActivityCount,
    '-> ',
    isProductive ? 'PRODUCTIVE' : 'unproductive',
    'on',
    currentHostname
  );
  const category = currentHostname ? await getCategory(currentHostname) : undefined;
  await commitWindow({ hostname: currentHostname, seconds: elapsedSeconds, isProductive, category });
}

// ---- Start / Stop session control ----------------------------------------

async function handleStart() {
  const trackSession = await getSessionState();
  if (trackSession.running) {
    return { ok: true, running: true, sessionStartedAt: trackSession.sessionStartedAt };
  }

  const now = Date.now();
  trackSession.running = true;
  trackSession.sessionStartedAt = now;
  trackSession.windowStartAt = now;
  trackSession.windowKeyCount = 0;
  trackSession.windowMouseActivityCount = 0;
  await saveSessionState();
  await updateBadge();
  return { ok: true, running: true, sessionStartedAt: now };
}

async function handleStop() {
  const trackSession = await getSessionState();
  if (!trackSession.running) return { ok: true, running: false };

  // Evaluate whatever's accumulated in the current partial window using its
  // real elapsed duration (not a full 180s) rather than discarding it.
  const now = Date.now();
  const elapsedSeconds = trackSession.windowStartAt ? (now - trackSession.windowStartAt) / 1000 : 0;
  await resolveWindow(trackSession, elapsedSeconds);

  trackSession.running = false;
  trackSession.sessionStartedAt = null;
  trackSession.windowStartAt = null;
  trackSession.windowKeyCount = 0;
  trackSession.windowMouseActivityCount = 0;
  await saveSessionState();

  await flush();
  await updateBadge();
  return { ok: true, running: false };
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
  const authSession = await ensureFreshSession();
  if (!authSession) return { authenticated: false };
  if (!currentUser) await loadCurrentUser(authSession);

  const state = await getState();
  const trackSession = await getSessionState();
  return {
    authenticated: true,
    email: currentUser?.email ?? authSession.user.email,
    running: trackSession.running,
    sessionStartedAt: trackSession.sessionStartedAt,
    todayProductiveSeconds: state.totalProductiveSeconds,
    todayUnproductiveSeconds: state.totalUnproductiveSeconds,
  };
}

async function handleSignIn({ email, password }) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, error: error.message };
  await loadCurrentUser(data.session);
  return { ok: true, email: data.session.user.email };
}

async function handleSignOut() {
  await handleStop(); // close out any running session cleanly first
  await supabase.auth.signOut();
  currentUser = null;
  await updateBadge();
  return { ok: true };
}

// ---- visible status badge -----------------------------------------------
// Required by design: this extension must never track silently. The badge
// always shows something, whether signed out, ready, or running.

async function updateBadge() {
  if (!currentUser) {
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#9CA3AF' });
    return;
  }
  const trackSession = await getSessionState();
  if (trackSession.running) {
    chrome.action.setBadgeText({ text: 'RUN' });
    chrome.action.setBadgeBackgroundColor({ color: '#16A34A' });
  } else {
    chrome.action.setBadgeText({ text: 'RDY' });
    chrome.action.setBadgeBackgroundColor({ color: '#9CA3AF' });
  }
}
