// dotenv's default config() looks for .env relative to process.cwd(),
// which for an installed app launched from a shortcut or auto-start is NOT
// reliably the app's own install directory. Resolve it explicitly against
// this file's own location instead — works whether running from source
// (npm start) or packaged inside app.asar, since Electron's patched fs
// reads plain text files out of an asar archive transparently.
require('dotenv').config({ path: require('node:path').join(__dirname, '.env') });
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, dialog, powerMonitor } = require('electron');
const path = require('node:path');
const { supabase, fetchProfile } = require('./src/supabaseClient');
const trackingEngine = require('./src/trackingEngine');
const { readJSON, writeJSON } = require('./src/store');

// Without these, a thrown error during startup (e.g. tray icon creation)
// can otherwise disappear rather than showing up in the terminal, which is
// exactly the "nothing happened, no error either" situation this is meant
// to prevent from happening silently again.
process.on('uncaughtException', (err) => {
  console.error('[evolut-productivity-agent] uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[evolut-productivity-agent] unhandled rejection:', err);
});

let tray = null;
let popupWindow = null;
let floatingWindow = null;
let currentUser = null; // { id, role, email }

// Set whenever the popup hides because it lost focus. Lets a click on the
// floating launcher that stole that focus read as "close", not "reopen".
let popupHiddenByBlurAt = 0;

const FLOATING_SIZE = 72; // window px; the bubble itself is 56px, centred inside
const EDGE_MARGIN = 8;

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
  popupWindow.on('blur', () => {
    popupHiddenByBlurAt = Date.now();
    popupWindow.hide();
  });
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

// ---- Floating always-on-top launcher ----------------------------------
// A small round bubble pinned to a screen edge. The hidden tray icon (in
// the "^" overflow) is why employees forget to press Start; this keeps the
// control visible at all times. It owns no tracking logic — a click just
// toggles the same popup window the tray opens.

function clampToWorkArea(x, y, width, height) {
  const display = screen.getDisplayNearestPoint({
    x: Math.round(x + width / 2),
    y: Math.round(y + height / 2),
  });
  const area = display.workArea;
  return {
    display,
    x: Math.max(area.x, Math.min(Math.round(x), area.x + area.width - width)),
    y: Math.max(area.y, Math.min(Math.round(y), area.y + area.height - height)),
  };
}

function createFloatingWindow() {
  floatingWindow = new BrowserWindow({
    width: FLOATING_SIZE,
    height: FLOATING_SIZE,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Above normal windows so it stays visible, but 'floating' rather than a
  // higher level so it doesn't sit over screensavers etc.
  floatingWindow.setAlwaysOnTop(true, 'floating');
  floatingWindow.loadFile('floating.html');

  // Default: parked against the right edge, vertically centred. Restore the
  // employee's last spot if they've dragged it, clamped back onto a real
  // display in case the monitor layout changed since.
  const saved = readJSON('floating-position', null);
  const primary = screen.getPrimaryDisplay().workArea;
  const startX =
    saved && Number.isFinite(saved.x)
      ? saved.x
      : primary.x + primary.width - FLOATING_SIZE - EDGE_MARGIN;
  const startY =
    saved && Number.isFinite(saved.y)
      ? saved.y
      : Math.round(primary.y + (primary.height - FLOATING_SIZE) / 2);
  const placed = clampToWorkArea(startX, startY, FLOATING_SIZE, FLOATING_SIZE);
  floatingWindow.setPosition(placed.x, placed.y, false);

  // showInactive so appearing on launch never steals focus from whatever
  // the employee is already doing.
  floatingWindow.once('ready-to-show', () => floatingWindow.showInactive());
  floatingWindow.webContents.on('did-finish-load', updateFloatingState);
}

function updateFloatingState() {
  if (!floatingWindow || floatingWindow.isDestroyed()) return;
  const running = currentUser ? trackingEngine.getStatus().running : false;
  floatingWindow.webContents.send('floating-state', {
    authenticated: !!currentUser,
    running,
  });
}

function positionPopupNearFloating() {
  const anchor = floatingWindow.getBounds();
  const popup = popupWindow.getBounds();
  const display = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y });
  const area = display.workArea;

  const spaceRight = area.x + area.width - (anchor.x + anchor.width);
  // Open on whichever side of the bubble has room; prefer the left when the
  // bubble is parked against the right edge (the default).
  let x =
    spaceRight < popup.width + EDGE_MARGIN
      ? anchor.x - popup.width - EDGE_MARGIN
      : anchor.x + anchor.width + EDGE_MARGIN;
  let y = anchor.y + anchor.height / 2 - popup.height / 2;

  x = Math.max(area.x, Math.min(x, area.x + area.width - popup.width));
  y = Math.max(area.y, Math.min(y, area.y + area.height - popup.height));
  popupWindow.setPosition(Math.round(x), Math.round(y), false);
}

function togglePopupFromFloating() {
  if (!popupWindow) return;
  if (popupWindow.isVisible()) {
    popupWindow.hide();
    return;
  }
  // If clicking the bubble just stole focus from an open popup (hiding it via
  // blur a moment ago), treat this click as "close" and leave it hidden
  // rather than flickering it straight back open.
  if (Date.now() - popupHiddenByBlurAt < 300) return;
  positionPopupNearFloating();
  popupWindow.show();
  popupWindow.focus();
}

// Required by design, same principle as the extension: this agent must
// never track silently. The tray tooltip (and now the floating bubble's
// colour) always shows a state.
function updateTrayState() {
  if (tray) {
    if (!currentUser) {
      tray.setToolTip('Evolut Productivity Agent — signed out');
    } else {
      const status = trackingEngine.getStatus();
      tray.setToolTip(`Evolut Productivity Agent — ${status.running ? 'running' : 'ready'}`);
    }
  }
  // Keep the floating launcher in sync with every state change that already
  // routes through here (sign in/out, start, stop, lock).
  updateFloatingState();
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

// Single-instance guard. The app auto-starts at login AND can be opened
// manually, and nothing stopped those from stacking — each extra copy spawned
// its own tray icon and its own tracking engine, i.e. duplicate tracking (and
// inflated hours). Hold a process-wide lock so only the first copy runs; any
// later launch simply hands off to the running one and quits.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone launched a second copy — surface the existing one instead of
    // letting another start.
    if (floatingWindow && !floatingWindow.isDestroyed()) floatingWindow.showInactive();
    if (popupWindow && !popupWindow.isDestroyed() && tray) {
      positionPopupNearTray();
      popupWindow.show();
      popupWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  // Lost the single-instance race: this is a duplicate launch, so do nothing
  // (app.quit() was already called above) rather than create a second tray.
  if (!gotSingleInstanceLock) return;

  console.log('[evolut-productivity-agent] app ready, creating window and tray icon...');

  // Sole tracking tool now, so it needs to actually be running for tracking
  // to happen at all — relying on the employee to remember to launch it
  // each day isn't a reasonable expectation. Runs once per app start; a
  // no-op on Windows if already registered.
  app.setLoginItemSettings({ openAtLogin: true });

  createPopupWindow();
  createFloatingWindow();

  const trayIconPath = path.join(__dirname, 'icons', 'tray.ico');
  tray = new Tray(trayIconPath);
  tray.on('click', togglePopup);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open', click: togglePopup },
      { type: 'separator' },
      { label: 'Quit', click: () => confirmAndQuit() },
    ])
  );
  console.log(
    `[evolut-productivity-agent] tray icon created from ${trayIconPath} — check the Windows taskbar's ` +
      `hidden-icons overflow (the "^" near the clock) if you don't see it in the main tray area.`
  );

  // Locking the PC means stopping tracking, not signing out — the employee
  // hasn't done anything (didn't click Stop, didn't sign out), the machine
  // just isn't in use. trackingEngine.stop() already does exactly the right
  // thing here: resolves the final partial window, flushes it, and leaves
  // currentUser/the auth session untouched. Deliberately does NOT
  // auto-resume on unlock — same reasoning as everywhere else in this
  // project, starting a tracked session is the employee's action to take,
  // not something the system does for them.
  powerMonitor.on('lock-screen', async () => {
    console.log('[evolut-productivity-agent] screen locked — stopping tracking (session stays signed in)');
    await trackingEngine.stop();
    updateTrayState();
  });
  powerMonitor.on('unlock-screen', () => {
    console.log('[evolut-productivity-agent] screen unlocked — click Start to resume tracking');
  });

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

  // Floating launcher -> main. These are fire-and-forget (ipcRenderer.send):
  // dragging needs to be smooth, and none of them return a value.
  ipcMain.on('floating-move', (_event, { x, y }) => {
    if (!floatingWindow || floatingWindow.isDestroyed()) return;
    floatingWindow.setPosition(Math.round(x), Math.round(y), false);
  });

  ipcMain.on('floating-drag-end', (_event, { x, y }) => {
    if (!floatingWindow || floatingWindow.isDestroyed()) return;
    // Snap to whichever vertical edge the bubble ended up closest to, so it
    // always parks cleanly against a side instead of floating mid-screen.
    const placed = clampToWorkArea(x, y, FLOATING_SIZE, FLOATING_SIZE);
    const area = placed.display.workArea;
    const centerX = placed.x + FLOATING_SIZE / 2;
    const finalX =
      centerX < area.x + area.width / 2
        ? area.x + EDGE_MARGIN
        : area.x + area.width - FLOATING_SIZE - EDGE_MARGIN;
    floatingWindow.setPosition(finalX, placed.y, false);
    writeJSON('floating-position', { x: finalX, y: placed.y });
  });

  ipcMain.on('floating-click', () => togglePopupFromFloating());

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
