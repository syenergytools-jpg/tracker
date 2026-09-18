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
const sessionTimerEl = document.getElementById('sessionTimer');
const productiveTotalEl = document.getElementById('productiveTotal');
const unproductiveTotalEl = document.getElementById('unproductiveTotal');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const signOutBtn = document.getElementById('signOutBtn');

function showView(view) {
  for (const el of [loadingView, loginView, trackingView]) el.classList.add('hidden');
  view.classList.remove('hidden');
}

function formatStopwatch(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

let authenticated = false;
let running = false;
let sessionStartedAt = null;

function renderSessionTimer() {
  const elapsed = running && sessionStartedAt ? (Date.now() - sessionStartedAt) / 1000 : 0;
  sessionTimerEl.textContent = formatStopwatch(elapsed);
  sessionTimerEl.className = `timer-value ${running ? 'running' : 'stopped'}`;
}

function applyRunningUI() {
  startBtn.disabled = running;
  stopBtn.disabled = !running;
  statusDot.className = running ? 'popup__dot running' : 'popup__dot';
  renderSessionTimer();
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
  running = !!status.running;
  sessionStartedAt = status.sessionStartedAt ?? null;
  productiveTotalEl.textContent = formatStopwatch(status.todayProductiveSeconds);
  unproductiveTotalEl.textContent = formatStopwatch(status.todayUnproductiveSeconds);

  applyRunningUI();
  showView(trackingView);
}

// The session timer is exact wall-clock elapsed time, so it's recomputed
// from sessionStartedAt every second rather than locally accumulated —
// no drift possible. Productive/Unproductive only change once per hidden
// 3-minute window, so they're left to update from the next refreshStatus()
// poll rather than faked with a local per-second tick.
setInterval(renderSessionTimer, 1000);

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

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  const result = await chrome.runtime.sendMessage({ type: 'START' });
  if (result?.ok) {
    running = true;
    sessionStartedAt = result.sessionStartedAt;
    applyRunningUI();
  }
  await refreshStatus();
});

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  const result = await chrome.runtime.sendMessage({ type: 'STOP' });
  if (result?.ok) {
    running = false;
    sessionStartedAt = null;
    applyRunningUI();
  }
  await refreshStatus();
});

showView(loadingView);
refreshStatus();
setInterval(refreshStatus, 3000);
