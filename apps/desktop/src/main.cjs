// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

const { app, BrowserWindow, shell, Menu, ipcMain } = require('electron');
const path = require('node:path');

const DARK_BG = '#09090b';
const STORE_KEY = 'plexo_instance_url';
const MIN_WIDTH = 480;
const MIN_HEIGHT = 600;

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
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Open links to other origins in the system browser; keep instance nav in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    safeOpenExternal(url);
    return { action: 'deny' };
  });

  // Gate top-level navigation: allow the local renderer and the connected
  // instance origin; everything else goes to the system browser.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigation(url)) return;
    event.preventDefault();
    safeOpenExternal(url);
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
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
