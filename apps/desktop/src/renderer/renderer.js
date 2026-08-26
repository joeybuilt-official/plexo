// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

// Runs in the sandboxed renderer. The only privileged surface is window.plexo,
// exposed via the contextBridge in preload.cjs.

(function () {
  'use strict';

  const connectScreen = document.getElementById('connectScreen');
  const loader = document.getElementById('loader');
  const form = document.getElementById('connectForm');
  const urlInput = document.getElementById('urlInput');
  const errorEl = document.getElementById('error');

  function showLoader() {
    connectScreen.hidden = true;
    loader.hidden = false;
  }

  function showConnect() {
    loader.hidden = true;
    connectScreen.hidden = false;
    urlInput.focus();
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }

  function clearError() {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }

  // Mirror the main-process validation so we give immediate feedback.
  function normalize(raw) {
    let value = (raw || '').trim();
    if (!value) return null;
    if (!/^https?:\/\//i.test(value)) value = 'https://' + value;
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname || !parsed.hostname.includes('.')) return null;
    let out = parsed.toString();
    if (out.endsWith('/')) out = out.slice(0, -1);
    return out;
  }

  let started = false;
  async function init() {
    if (started) return;
    started = true;
    if (!window.plexo) {
      // Should never happen in the packaged app; fail to the connect screen.
      showConnect();
      return;
    }
    try {
      const saved = await window.plexo.getInstanceUrl();
      if (saved) {
        showLoader();
        await window.plexo.openInstance(saved);
        return; // main process navigates the window away
      }
    } catch (err) {
      console.error('Failed to read saved instance URL:', err);
    }
    showConnect();
    // Show local bridge status
    try {
      const st = await window.plexo.getBridgeStatus();
      const info = document.getElementById('bridgeInfo');
      if (info && st) {
        info.textContent = st.running
          ? `Local Bridge: ${st.hostname} :${st.port} — ${st.tailscaleHint}`
          : 'Local Bridge: not running';
      }
    } catch {}
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();

    const normalized = normalize(urlInput.value);
    if (!normalized) {
      showError('Enter a valid instance URL, e.g. https://app.your-domain.com');
      return;
    }

    showLoader();
    try {
      const res = await window.plexo.openInstance(normalized);
      if (!res || !res.ok) {
        showConnect();
        showError('Could not connect to that instance. Check the URL and try again.');
      }
      // On success the main process navigates the window to the instance.
    } catch (err) {
      console.error('openInstance failed:', err);
      showConnect();
      showError('Something went wrong connecting. Please try again.');
    }
  });

  urlInput.addEventListener('input', clearError);

  document.addEventListener('DOMContentLoaded', init);
  // DOMContentLoaded may have already fired before this script ran.
  if (document.readyState !== 'loading') init();
})();
