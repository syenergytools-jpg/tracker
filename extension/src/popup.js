// Talks to the background service worker over chrome.runtime messaging
// rather than creating its own Supabase client. That keeps exactly one
// source of truth for the auth session — if the popup held its own client,
// its session could drift out of sync with the one background.js uses to
// write activity data.

const loadingView = document.getElementById('loadingView');
const loginView = document.getElementById('loginView');
const trackingView = document.getElementById('trackingView');
const statusDot = document.getElementById('statusDot');
const loginForm = document.getElementById('loginForm');
const loginError = document.getElementById('loginError');
const userName = document.getElementById('userName');
const activeTimerEl = document.getElementById('activeTimer');
const idleTimerEl = document.getElementById('idleTimer');
const signOutBtn = document.getElementById('signOutBtn');
const pauseBtn = document.getElementById('pauseBtn');
const pauseBanner = document.getElementById('pauseBanner');

function showView(view) {
  for (const el of [loadingView, loginView, trackingView]) el.classList.add('hidden');
  view.classList.remove('hidden');
}

function formatStopwatch(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

// The popup only runs while open, so "live" ticking here is purely a local
// display effect between syncs with background.js (the actual source of
// truth). Every refreshStatus() call snaps these back to the authoritative
// totals, so a slow tick or a missed second here never drifts permanently —
// it just self-corrects on the next poll.
let authenticated = false;
let currentPaused = false;
let currentlyActive = false;
let displayActiveSeconds = 0;
let displayIdleSeconds = 0;

function renderTimers() {
  activeTimerEl.textContent = formatStopwatch(displayActiveSeconds);
  idleTimerEl.textContent = formatStopwatch(displayIdleSeconds);
  activeTimerEl.className = `timer-value ${currentPaused ? 'stopped' : currentlyActive ? 'active' : 'idle'}`;
}

function applyPausedUI(paused) {
  pauseBanner.classList.toggle('hidden', !paused);
  pauseBtn.textContent = paused ? 'Start tracking' : 'Stop tracking';
  pauseBtn.className = paused ? 'start' : 'stop';
}

async function refreshStatus() {
  const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  authenticated = !!status?.authenticated;

  if (!authenticated) {
    statusDot.className = 'popup__dot';
    showView(loginView);
    return;
  }

  userName.textContent = status.email;
  currentPaused = !!status.paused;
  currentlyActive = !!status.currentlyActive;
  displayActiveSeconds = status.todayActiveSeconds;
  displayIdleSeconds = status.todayIdleSeconds;

  applyPausedUI(currentPaused);
  renderTimers();
  statusDot.className = currentPaused ? 'popup__dot paused' : `popup__dot ${currentlyActive ? 'active' : 'idle'}`;
  showView(trackingView);
}

// Smooth per-second tick between the ~3s authoritative polls below.
setInterval(() => {
  if (!authenticated || currentPaused) return;
  if (currentlyActive) displayActiveSeconds += 1;
  else displayIdleSeconds += 1;
  renderTimers();
}, 1000);

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginError.classList.add('hidden');

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const submitBtn = loginForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Signing in…';

  try {
    const result = await chrome.runtime.sendMessage({ type: 'SIGN_IN', payload: { email, password } });
    if (result.ok) {
      loginForm.reset();
      await refreshStatus();
    } else {
      loginError.textContent = result.error || 'Sign in failed.';
      loginError.classList.remove('hidden');
    }
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Sign in';
  }
});

signOutBtn.addEventListener('click', async () => {
  signOutBtn.disabled = true;
  await chrome.runtime.sendMessage({ type: 'SIGN_OUT' });
  signOutBtn.disabled = false;
  await refreshStatus();
});

pauseBtn.addEventListener('click', async () => {
  pauseBtn.disabled = true;
  const result = await chrome.runtime.sendMessage({ type: 'SET_PAUSED', payload: { paused: !currentPaused } });
  pauseBtn.disabled = false;
  if (result?.ok) {
    currentPaused = result.paused;
    applyPausedUI(currentPaused);
  }
  await refreshStatus();
});

showView(loadingView);
refreshStatus();
setInterval(refreshStatus, 3000);
