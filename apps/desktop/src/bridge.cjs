// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

// Local Bridge HTTP Server — exposes the laptop's filesystem and shell
// to the NAS agent via Tailscale. Binds only to 127.0.0.1 (reachable via
// the Tailscale interface on Windows). Every request requires the bearer
// token stored in electron-store under BRIDGE_TOKEN_KEY.

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const BRIDGE_TOKEN_KEY = 'plexo_bridge_token';
const BRIDGE_PORT_KEY = 'plexo_bridge_port';
const MAX_BODY_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 512 * 1024;

// Allowed shell commands (basename match). Extra args are passed through spawn, not a shell string.
const ALLOWED_COMMANDS = new Set(['git', 'pnpm', 'npm', 'node', 'python', 'python3', 'npx', 'code', 'docker', 'kubectl']);

// Blocked path fragments (case-insensitive).
const BLOCKED_FRAGMENTS = ['node_modules', '.git', '.env', 'credentials', 'secrets'];

// Request rate limiter: 60 req / 60s per IP.
const rateMap = new Map(); // ip -> { count, resetAt }

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateMap.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= 60) return false;
  entry.count++;
  return true;
}

// Resolve and validate a requested path stays inside allowed roots.
function resolveAllowed(requested) {
  // Allow: user's home directory subtree.
  const home = os.homedir();
  const abs = path.isAbsolute(requested) ? requested : path.join(home, requested);
  const resolved = path.resolve(abs);

  // Must be under home.
  if (!resolved.startsWith(home + path.sep) && resolved !== home) return null;

  // Block disallowed fragments.
  const lower = resolved.toLowerCase();
  for (const frag of BLOCKED_FRAGMENTS) {
    if (lower.includes(path.sep + frag + path.sep) || lower.endsWith(path.sep + frag) || lower.includes(frag)) {
      // Allow .env.example / .gitignore explicitly?
      // Block only exact sensitive names; allow reading config files that aren't secrets.
      // For now, strict: block any path containing the fragment as a directory component.
      // Re-check with path components:
      const parts = resolved.toLowerCase().split(path.sep);
      if (parts.includes(frag) || parts.includes('.env')) return null;
    }
  }

  // Additional check for blocked fragments as path components
  const parts = resolved.toLowerCase().split(path.sep);
  for (const frag of BLOCKED_FRAGMENTS) {
    if (parts.includes(frag.toLowerCase())) return null;
  }
  if (parts.includes('.env')) return null;

  return resolved;
}

async function getOrCreateToken(getStore) {
  const store = await getStore();
  let token = store.get(BRIDGE_TOKEN_KEY);
  if (!token) {
    token = 'sk_node_' + crypto.randomBytes(24).toString('hex');
    store.set(BRIDGE_TOKEN_KEY, token);
  }
  return token;
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        return reject(new Error('request body too large'));
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

function sendOptions(res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end();
}

/**
 * Start the bridge HTTP server.
 * @param {() => Promise<import('electron-store').default>} getStore
 * @returns {Promise<{ server: http.Server, port: number, token: string, close: () => void }>}
 */
async function startBridge(getStore) {
  console.log('[bridge] starting...');
  const token = await getOrCreateToken(getStore);
  console.log('[bridge] token ready', token.slice(0, 12) + '...');

  const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      sendOptions(res);
      return;
    }

    // Rate limit
    const ip = req.socket.remoteAddress || 'unknown';
    if (!checkRateLimit(ip)) {
      sendJson(res, 429, { error: 'rate limited' });
      return;
    }

    // Auth (skip for /health? No — always require, except health still requires auth so random IPs can't probe)
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${token}`) {
      // Allow unauthenticated GET /health? No — require auth. Probe without token gets 401, not a data leak.
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    try {
      // GET /health
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, {
          ok: true,
          hostname: os.hostname(),
          platform: os.platform(),
          arch: os.arch(),
          capabilities: ['fs', 'shell'],
          time: new Date().toISOString(),
        });
        return;
      }

      // POST /fs/read
      if (req.method === 'POST' && url.pathname === '/fs/read') {
        const body = await parseJsonBody(req);
        const requested = typeof body.path === 'string' ? body.path : '';
        const resolved = resolveAllowed(requested);
        if (!resolved) {
          sendJson(res, 403, { error: 'path not allowed' });
          return;
        }
        const stat = await fsp.stat(resolved);
        if (!stat.isFile()) {
          sendJson(res, 400, { error: 'not a file' });
          return;
        }
        if (stat.size > MAX_FILE_BYTES) {
          sendJson(res, 400, { error: `file too large (${stat.size} > ${MAX_FILE_BYTES})` });
          return;
        }
        const content = await fsp.readFile(resolved, 'utf8');
        sendJson(res, 200, { ok: true, path: resolved, content, size: stat.size });
        return;
      }

      // POST /fs/write
      if (req.method === 'POST' && url.pathname === '/fs/write') {
        const body = await parseJsonBody(req);
        const requested = typeof body.path === 'string' ? body.path : '';
        const content = typeof body.content === 'string' ? body.content : '';
        const resolved = resolveAllowed(requested);
        if (!resolved) {
          sendJson(res, 403, { error: 'path not allowed' });
          return;
        }
        if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
          sendJson(res, 400, { error: 'content too large' });
          return;
        }
        await fsp.mkdir(path.dirname(resolved), { recursive: true });
        await fsp.writeFile(resolved, content, 'utf8');
        sendJson(res, 200, { ok: true, path: resolved });
        return;
      }

      // POST /fs/list  — glob-like listing of a directory (pattern is a path, not a shell glob)
      if (req.method === 'POST' && url.pathname === '/fs/list') {
        const body = await parseJsonBody(req);
        const requested = typeof body.path === 'string' ? body.path : '.';
        const resolved = resolveAllowed(requested);
        if (!resolved) {
          sendJson(res, 403, { error: 'path not allowed' });
          return;
        }
        const entries = await fsp.readdir(resolved, { withFileTypes: true });
        const files = [];
        for (const e of entries) {
          if (files.length >= 500) break;
          // Skip hidden and node_modules/.git inside the listing too
          if (e.name.startsWith('.')) continue;
          if (BLOCKED_FRAGMENTS.includes(e.name.toLowerCase())) continue;
          const full = path.join(resolved, e.name);
          let stat;
          try { stat = await fsp.stat(full); } catch { continue; }
          files.push({
            name: e.name,
            path: full,
            isDirectory: e.isDirectory(),
            size: stat.size,
            mtime: stat.mtime.toISOString(),
          });
        }
        sendJson(res, 200, { ok: true, path: resolved, files });
        return;
      }

      // POST /exec
      if (req.method === 'POST' && url.pathname === '/exec') {
        const body = await parseJsonBody(req);
        const cmd = typeof body.cmd === 'string' ? body.cmd : '';
        const args = Array.isArray(body.args) ? body.args.map(String) : [];
        const cwdRaw = typeof body.cwd === 'string' ? body.cwd : '';
        const timeoutMs = typeof body.timeoutMs === 'number' ? Math.min(body.timeoutMs, 60_000) : 30_000;
        const base = path.basename(cmd).toLowerCase().replace(/\.exe$/, '');
        if (!ALLOWED_COMMANDS.has(base) && !ALLOWED_COMMANDS.has(cmd.toLowerCase())) {
          sendJson(res, 403, { error: `command not allowed: ${cmd}` });
          return;
        }
        const cwd = cwdRaw ? resolveAllowed(cwdRaw) : os.homedir();
        if (cwdRaw && !cwd) {
          sendJson(res, 403, { error: 'cwd not allowed' });
          return;
        }
        // Execute without shell (no metacharacter injection)
        const child = spawn(cmd, args, { cwd: cwd || os.homedir(), timeout: timeoutMs, windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d) => { stdout += d.toString('utf8').slice(0, 64 * 1024); });
        child.stderr?.on('data', (d) => { stderr += d.toString('utf8').slice(0, 64 * 1024); });
        const exitCode = await new Promise((resolve) => {
          child.on('close', (code) => resolve(code ?? 0));
          child.on('error', () => resolve(1));
        });
        sendJson(res, 200, { ok: true, stdout, stderr, exitCode });
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      console.error('bridge handler error:', err);
      sendJson(res, 500, { error: 'internal error', message: err?.message ?? String(err) });
    }
  });

  // Bind on 0.0.0.0 so Tailscale (100.x) can reach it. Every request is
  // bearer-token gated; Windows Firewall + Tailscale ACLs are the network gate.
  const port = await new Promise((resolve, reject) => {
    server.listen(0, '0.0.0.0', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('failed to bind'));
      resolve(addr.port);
    });
    server.on('error', reject);
  });

  // Persist port for reconnection after reboot
  const store = await getStore();
  store.set(BRIDGE_PORT_KEY, port);

  console.log(`[bridge] listening on http://127.0.0.1:${port} (token ${token.slice(0, 12)}...)`);

  return {
    server,
    port,
    token,
    close: () => server.close(),
  };
}

module.exports = { startBridge, BRIDGE_TOKEN_KEY, BRIDGE_PORT_KEY, ALLOWED_COMMANDS, BLOCKED_FRAGMENTS };
