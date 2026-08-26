// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Minimal, typed bridge. The renderer gets exactly these four methods and no
 * access to Node, the ipcRenderer object, or any other Electron internals.
 *
 * @typedef {{ ok: boolean, url?: string, error?: string }} Result
 */
contextBridge.exposeInMainWorld('plexo', {
  /** @returns {Promise<string>} the saved instance URL, or '' if none. */
  getInstanceUrl: () => ipcRenderer.invoke('plexo:getInstanceUrl'),

  /** @param {string} url @returns {Promise<Result>} */
  saveInstanceUrl: (url) => ipcRenderer.invoke('plexo:saveInstanceUrl', url),

  /** Persist + navigate the window to the instance. @param {string} url @returns {Promise<Result>} */
  openInstance: (url) => ipcRenderer.invoke('plexo:openInstance', url),

  /** Clear the saved instance and return to the connect screen. @returns {Promise<Result>} */
  forget: () => ipcRenderer.invoke('plexo:forget'),

  /** @returns {Promise<{ running: boolean, port: number|null, hostname: string }>} */
  getBridgeStatus: () => ipcRenderer.invoke('plexo:getBridgeStatus'),
});
