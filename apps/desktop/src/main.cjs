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

// Resolve the app icon. electron-builder packages `build/icon.png` into the
// app (see electron-builder.yml `files`); in `electron .` dev runs it sits at
// ../build/icon.png. Return null when neither exists so callers can fall back
// to a generated icon instead of a blank one.
function resolveIconPath() {
  const candidates = [
    path.join(__dirname, '..', 'build', 'icon.png'), // packaged + dev
    path.join(process.resourcesPath || '', 'build', 'icon.png'),
  ];
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

/** A 16x16 rounded dark tile with the Delta-Frame mark (closed triangle +
 *  three differently-colored vertex dots), as a last-resort icon. Built
 *  programmatically (BGRA) so it never depends on a packaged asset. */
function fallbackTrayIcon() {
  const S = 16;
  const buf = Buffer.alloc(S * S * 4); // BGRA
  const put = (x, y, b, g, r, a) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const o = (y * S + x) * 4;
    buf[o] = b; buf[o + 1] = g; buf[o + 2] = r; buf[o + 3] = a;
  };
  const tile = [0x20, 0x15, 0x10, 255];   // #101520 (BGR)
  const edge = [0xf0, 0xe8, 0xe2, 255];   // #E2E8F0 (BGR)
  // Dot colors (BGR): accent blue #4DAAFC, signal green #10B981, amber #F59E0B.
  const dotColors = [
    [0xfc, 0xaa, 0x4d, 255],
    [0x81, 0xb9, 0x10, 255],
    [0x0b, 0x9e, 0xf5, 255],
  ];
  const dx = 7.5, dy = 7.5;

  // Closed-triangle geometry mapped from the 48-unit brand space (bbox
  // x 12..36, y 10..34) into the 16px tile, bbox center (24,22) -> (8,8).
  const s = 0.42, ox = 8, oy = 8;
  const P = (px, py) => [ox + (px - 24) * s, oy + (py - 22) * s];
  const apex = P(24, 10), left = P(12, 34), right = P(36, 34);
  const segs = [
    [apex[0], apex[1], left[0], left[1]],
    [apex[0], apex[1], right[0], right[1]],
    [left[0], left[1], right[0], right[1]], // closed base (no gap)
  ];
  const dots = [[apex, dotColors[0]], [left, dotColors[1]], [right, dotColors[2]]];
  const nearSeg = (x, y, [x1, y1, x2, y2]) => {
    const vx = x2 - x1, vy = y2 - y1;
    const t = Math.max(0, Math.min(1, ((x - x1) * vx + (y - y1) * vy) / (vx * vx + vy * vy)));
    const px = x1 + t * vx, py = y1 + t * vy;
    return Math.hypot(x - px, y - py) < 0.75;
  };
  const dotR = 1.35;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const cx = x + 0.5 - dx, cy = y + 0.5 - dy;
      if (cx * cx + cy * cy > 62) continue; // rounded tile mask
      const onEdge = segs.some((sg) => nearSeg(x + 0.5, y + 0.5, sg));
      const dot = dots.find(([[px, py]]) => Math.hypot(x + 0.5 - px, y + 0.5 - py) < dotR);
      if (dot) put(x, y, dot[1][0], dot[1][1], dot[1][2], dot[1][3]);
      else if (onEdge) put(x, y, edge[0], edge[1], edge[2], edge[3]);
      else put(x, y, tile[0], tile[1], tile[2], tile[3]);
    }
  }
  return nativeImage.createFromBuffer(buf, { width: S, height: S });
}

function createTray() {
  const iconPath = resolveIconPath();
  let icon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  if (icon.isEmpty()) icon = fallbackTrayIcon();
  icon = icon.resize({ width: 16, height: 16 });
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
  const iconPath = resolveIconPath();
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    backgroundColor: DARK_BG,
    show: false,
    autoHideMenuBar: true,
    title: 'Plexo',
    ...(iconPath ? { icon: iconPath } : {}),
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
  let token = null;
  try {
    const store = await getStore();
    token = store.get('plexo_bridge_token') || null;
  } catch {}
  let tailscaleIp = null;
  try {
    const { execSync } = require('node:child_process');
    tailscaleIp = execSync('tailscale ip -4', { timeout: 2000, encoding: 'utf8' }).trim().split('\n')[0] || null;
  } catch {}
  return {
    running: !!bridgeState,
    port: bridgeState?.port ?? null,
    hostname: os.hostname(),
    tailscaleIp,
    token,
    tailscaleHint: tailscaleIp ? `Tailscale ${tailscaleIp}:${bridgeState?.port ?? ''}` : 'Reachable via Tailscale IP when Tailscale is running (token required).',
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
