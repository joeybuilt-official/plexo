// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

const { app, BrowserWindow, shell, Menu, ipcMain, Tray, nativeImage, globalShortcut } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');

const DARK_BG = '#09090b';
const STORE_KEY = 'plexo_instance_url';
const MIN_WIDTH = 480;
const MIN_HEIGHT = 600;

// Local Bridge — filesystem + shell exposed to NAS agent via Tailscale.
// Loaded lazily so the app still boots if the module is missing/broken.
let bridgeState = null;
async function startLocalBridge() {
  try {
    const { startBridge } = require('./bridge.cjs');
    bridgeState = await startBridge(getStore);
    console.log(`[plexo] Local Bridge started on :${bridgeState.port}`);
    // Persist for diagnostics
    try {
      const store = await getStore();
      store.set('plexo_bridge_last_error', '');
    } catch {}
  } catch (e) {
    console.warn('[plexo] Local Bridge failed to start:', e);
    try {
      const store = await getStore();
      store.set('plexo_bridge_last_error', String(e?.stack ?? e));
    } catch {}
  }
}
function stopLocalBridge() {
  if (bridgeState?.close) {
    try { bridgeState.close(); } catch {}
    bridgeState = null;
  }
}

// ---- Tray / close-to-tray / hotkey / autostart ---------------------------------

let tray = null;
let isQuitting = false;

function createTray() {
  const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Plexo');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Plexo',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Plexo',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);

  // Double-click tray icon to show/hide
  tray.on('double-click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) mainWindow.hide();
      else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

// Register global hotkey (CmdOrCtrl+Shift+P) to toggle window
function registerGlobalShortcut() {
  const ret = globalShortcut.register('CommandOrControl+Shift+P', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  if (!ret) {
    console.warn('Global shortcut CommandOrControl+Shift+P registration failed');
  }
}

// Enable autostart at login
function enableAutostart() {
  try {
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true,
    });
  } catch (e) {
    console.warn('Failed to set autostart:', e);
  }
}

// electron-store is ESM-only in v10; load it lazily via dynamic import.
let storePromise = null;
function getStore() {
  if (!storePromise) {
    storePromise = import('electron-store').then(({ default: Store }) => {
      return new Store({
        name: 'plexo-desktop',
        defaults: { [STORE_KEY]: '' },
      });
    });
  }
  return storePromise;
}

/** Normalize and validate a user-entered instance URL. Returns a string or null. */
function normalizeUrl(raw) {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) {
    value = 'https://' + value;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  // Strip a single trailing slash for a stable origin string.
  let out = parsed.toString();
  if (out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

let mainWindow = null;
let instanceOrigin = null; // origin of the connected instance, for nav gating

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    backgroundColor: DARK_BG,
    show: false,
    autoHideMenuBar: true,
    title: 'Plexo',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
      partition: 'persist:plexo',
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Keep auth + instance navigations in-app so cookies/session stay in Electron.
  // External links open in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedNavigation(url)) {
      return { action: 'allow' };
    }
    safeOpenExternal(url);
    return { action: 'deny' };
  });

  // Gate top-level navigation: allow the local renderer, the connected
  // instance origin, and auth providers; everything else goes to the system browser.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigation(url)) return;
    event.preventDefault();
    safeOpenExternal(url);
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  loadRenderer();
}

function loadRenderer() {
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function isAllowedNavigation(target) {
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return false;
  }
  if (parsed.protocol === 'file:') return true; // local renderer
  if (instanceOrigin && parsed.origin === instanceOrigin) return true;
  // Auth providers must stay in-app so the Electron session gets the cookies.
  // Keep this allowlist tight; add hosts as new providers are configured.
  const authHosts = [
    'github.com',
    'accounts.google.com',
    'oauth2.googleapis.com',
    'login.microsoftonline.com',
    'auth.getplexo.com',
  ];
  if (authHosts.some((h) => parsed.hostname === h || parsed.hostname.endsWith('.' + h))) {
    return true;
  }
  // Permissive fallback for Better Auth / OAuth discovery: keep any https navigation
  // in-app during auth flows. External doc links that use window.open will now stay
  // in-app too — acceptable for daily-driver until we add explicit external-link
  // detection (e.g., check referrer or add an allowlist for docs).
  if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return true;
  return false;
}

function safeOpenExternal(target) {
  try {
    const parsed = new URL(target);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:') {
      shell.openExternal(target);
    }
  } catch {
    /* ignore malformed urls */
  }
}

/** Navigate the main window to the chosen instance and remember its origin. */
function openInstance(url) {
  const normalized = normalizeUrl(url);
  if (!normalized || !mainWindow) return false;
  instanceOrigin = new URL(normalized).origin;
  mainWindow.loadURL(normalized);
  return true;
}

// ---- IPC: the only privileged surface exposed to the renderer ----------------

ipcMain.handle('plexo:getInstanceUrl', async () => {
  const store = await getStore();
  return store.get(STORE_KEY) || '';
});

ipcMain.handle('plexo:saveInstanceUrl', async (_event, url) => {
  const normalized = normalizeUrl(url);
  if (!normalized) return { ok: false, error: 'invalid-url' };
  const store = await getStore();
  store.set(STORE_KEY, normalized);
  return { ok: true, url: normalized };
});

ipcMain.handle('plexo:openInstance', async (_event, url) => {
  // Persist then navigate so a fresh launch reconnects automatically.
  const normalized = normalizeUrl(url);
  if (!normalized) return { ok: false, error: 'invalid-url' };
  const store = await getStore();
  store.set(STORE_KEY, normalized);
  const ok = openInstance(normalized);
  return ok ? { ok: true, url: normalized } : { ok: false, error: 'window-unavailable' };
});

ipcMain.handle('plexo:forget', async () => {
  const store = await getStore();
  store.set(STORE_KEY, '');
  instanceOrigin = null;
  if (mainWindow) loadRenderer();
  return { ok: true };
});

ipcMain.handle('plexo:getBridgeStatus', async () => {
  return {
    running: !!bridgeState,
    port: bridgeState?.port ?? null,
    hostname: os.hostname(),
    tailscaleHint: 'Reachable via Tailscale IP when Tailscale is running (token required).',
  };
});

// ---- Application menu --------------------------------------------------------

function buildMenu() {
  const template = [
    {
      label: 'Plexo',
      submenu: [
        {
          label: 'Switch Instance…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: async () => {
            const store = await getStore();
            store.set(STORE_KEY, '');
            instanceOrigin = null;
            if (mainWindow) loadRenderer();
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- Single-instance lock + lifecycle ---------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    buildMenu();
    createTray();
    registerGlobalShortcut();
    enableAutostart();
    createWindow();
    // Start local bridge in background — never block window creation.
    void startLocalBridge();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('will-quit', () => {
    stopLocalBridge();
    globalShortcut.unregisterAll();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
