require('dotenv').config();
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, dialog } = require('electron');
const path = require('node:path');
const { supabase, fetchProfile } = require('./src/supabaseClient');
const trackingEngine = require('./src/trackingEngine');

let tray = null;
let popupWindow = null;
let currentUser = null; // { id, role, email }

function createPopupWindow() {
  popupWindow = new BrowserWindow({
    width: 300,
    height: 480,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  popupWindow.loadFile('popup.html');
  // Same click-outside-to-dismiss pattern as any tray-anchored popup
  // (Slack, Dropbox, etc.) — never destroyed, just hidden, so app state
  // (and the tracking engine, which lives in this same process) keeps
  // running regardless of whether the popup is open.
  popupWindow.on('blur', () => popupWindow.hide());
}

function positionPopupNearTray() {
  const trayBounds = tray.getBounds();
  const windowBounds = popupWindow.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const x = Math.round(Math.min(trayBounds.x, display.workArea.x + display.workArea.width - windowBounds.width - 8));
  const y = Math.round(display.workArea.y + display.workArea.height - windowBounds.height - 8);
  popupWindow.setPosition(Math.max(x, display.workArea.x), Math.max(y, display.workArea.y), false);
}

function togglePopup() {
  if (!popupWindow) return;
  if (popupWindow.isVisible()) {
    popupWindow.hide();
    return;
  }
  positionPopupNearTray();
  popupWindow.show();
  popupWindow.focus();
}

// Required by design, same principle as the extension: this agent must
// never track silently. The tray tooltip always shows a state.
function updateTrayState() {
  if (!tray) return;
  if (!currentUser) {
    tray.setToolTip('Evolut Productivity Agent — signed out');
    return;
  }
  const status = trackingEngine.getStatus();
  tray.setToolTip(`Evolut Productivity Agent — ${status.running ? 'running' : 'ready'}`);
}

async function loadCurrentUser(session) {
  if (!session) {
    currentUser = null;
    trackingEngine.setUser(null);
    updateTrayState();
    return;
  }
  try {
    const profile = await fetchProfile(session.user.id);
    currentUser = { id: session.user.id, role: profile.role, email: session.user.email };
  } catch (err) {
    console.warn('[evolut-productivity-agent] failed to load profile:', err);
    currentUser = { id: session.user.id, role: null, email: session.user.email };
  }
  trackingEngine.setUser(currentUser.id);
  updateTrayState();
}

async function handleGetStatus() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return { authenticated: false };
  if (!currentUser) await loadCurrentUser(session);

  const status = trackingEngine.getStatus();
  return {
    authenticated: true,
    email: currentUser?.email ?? session.user.email,
    running: status.running,
    sessionStartedAt: status.sessionStartedAt,
    todayProductiveSeconds: status.todayProductiveSeconds,
    todayUnproductiveSeconds: status.todayUnproductiveSeconds,
  };
}

async function handleSignIn({ email, password }) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, error: error.message };
  await loadCurrentUser(data.session);
  return { ok: true, email: data.session.user.email };
}

async function handleSignOut() {
  await trackingEngine.stop();
  await supabase.auth.signOut();
  await loadCurrentUser(null);
  return { ok: true };
}

function handleStart() {
  if (!currentUser) return { ok: false, error: 'Not signed in' };
  const result = trackingEngine.start(currentUser.id);
  updateTrayState();
  return { ok: true, ...result };
}

async function handleStop() {
  const result = await trackingEngine.stop();
  updateTrayState();
  return { ok: true, ...result };
}

async function confirmAndQuit() {
  // This is now the sole tracking tool (see README) — quitting it means a
  // gap in coverage for however long it stays closed, not something that
  // should happen from a stray click on the tray menu.
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Quit', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Quit Evolut Productivity Agent?',
    message: 'Quitting stops all tracking until you reopen the app.',
  });
  if (response === 0) app.quit();
}

app.whenReady().then(async () => {
  // Sole tracking tool now, so it needs to actually be running for tracking
  // to happen at all — relying on the employee to remember to launch it
  // each day isn't a reasonable expectation. Runs once per app start; a
  // no-op on Windows if already registered.
  app.setLoginItemSettings({ openAtLogin: true });

  createPopupWindow();

  tray = new Tray(path.join(__dirname, 'icons', 'tray.ico'));
  tray.on('click', togglePopup);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open', click: togglePopup },
      { type: 'separator' },
      { label: 'Quit', click: () => confirmAndQuit() },
    ])
  );

  ipcMain.handle('message', async (_event, { type, payload }) => {
    switch (type) {
      case 'GET_STATUS':
        return handleGetStatus();
      case 'SIGN_IN':
        return handleSignIn(payload);
      case 'SIGN_OUT':
        return handleSignOut();
      case 'START':
        return handleStart();
      case 'STOP':
        return handleStop();
      default:
        return {};
    }
  });

  const {
    data: { session },
  } = await supabase.auth.getSession();
  await loadCurrentUser(session);
});

// Tray app — the popup is hidden, not destroyed (see createPopupWindow),
// so this normally never fires in practice. Kept as a safety net rather
// than relied upon.
app.on('window-all-closed', (event) => {
  event.preventDefault();
});

app.on('before-quit', async () => {
  await trackingEngine.stop();
});
