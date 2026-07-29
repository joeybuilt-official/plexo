<!--
SPDX-License-Identifier: MIT
Copyright (C) 2026 Joeybuilt LLC
-->

# Plexo Desktop

A thin, secure Electron shell for [Plexo](https://github.com/joeybuilt-official/plexo),
the open-source self-hostable AI platform.

Like the Android app (`apps/android`, Capacitor), this is **not** a bundled copy
of the web app. It shows a "Connect to Plexo" screen, you enter your self-hosted
instance URL, and the window then loads that instance directly. The Plexo web app
is server-rendered (Next.js standalone), so the desktop client only needs to host
the connect flow and the chosen URL is remembered for next launch.

## Architecture

- **Main process** (`src/main.cjs`) — creates a 1200×800 dark window, gates
  navigation to the local connect screen and the connected instance origin
  (everything else opens in the system browser), enforces a single-instance lock,
  and persists the instance URL via [`electron-store`](https://github.com/sindresorhus/electron-store).
- **Preload** (`src/preload.cjs`) — exposes a minimal typed API
  (`getInstanceUrl`, `saveInstanceUrl`, `openInstance`, `forget`) over the
  context bridge. No Node, no remote module, no `ipcRenderer` leak.
- **Renderer** (`src/renderer/`) — the dark zinc connect screen, mirrored from
  `apps/android/www/index.html`. Bundled CSS (no CDN) under a strict CSP.

Security defaults: `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`, `webSecurity: true`.

## Local development

```bash
pnpm install
pnpm start
```

`pnpm start` runs `electron .`. Enter any instance URL (e.g.
`https://app.your-domain.com`) to connect. Use **Plexo → Switch Instance…**
(`Ctrl+Shift+O`) to return to the connect screen.

## Build (Windows installer + portable)

```bash
pnpm dist          # NSIS installer + portable .exe -> dist/
pnpm dist:dir      # unpacked dir only (fast smoke test)
```

Outputs land in `dist/`:

- `Plexo-Setup-<version>.exe` — NSIS installer (not one-click; lets the user pick
  the install directory).
- `Plexo-<version>-portable.exe` — portable single-file build.

## Icon

The app icon source is `build/icon.svg`. A 256×256 raster placeholder lives at
`build/icon.png`, and electron-builder generates the multi-size Windows `.ico`
from it at build time.

**To ship a production icon**, supply a proper multi-size `build/icon.ico`
(16/32/48/256 px) rasterized from `build/icon.svg`, then change
`win.icon` in `electron-builder.yml` to `build/icon.ico`. The bundled PNG is a
functional placeholder only.

## CI (Codemagic)

Codemagic builds the Windows artifacts on a Windows worker with:

```bash
pnpm --filter @plexo/desktop run dist
```

`publish: null` in `electron-builder.yml` means no auto-update feed and no
artifact publishing — Codemagic collects the files from `apps/desktop/dist/`.
