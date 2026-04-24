# SSH Connection — Security Design & Threat Model

**Date:** 2026-04-08
**Status:** Phase 0 — design review before implementation
**Classification:** Security-critical feature

---

## 1. Infrastructure Audit

### Tool Factory Pattern

Existing connections (GitHub, Slack, etc.) follow this pattern:

1. **Registry:** `connections_registry` row defines the integration (id, name, auth_type, tools_provided)
2. **Installation:** `POST /api/connections/install` encrypts credentials and stores in `installed_connections`
3. **Bridge loading:** `loadConnectionTools(workspaceId)` at `packages/agent/src/connections/bridge.ts:778` reads all active connections, decrypts credentials, calls the factory, and merges tools into the agent's tool set
4. **Factory:** `TOOL_FACTORIES[registryId](creds, ctx)` returns a `Record<string, ToolDefinition>` namespaced as `{registryId}__{toolName}`

SSH follows this identical pattern. No special architecture needed.

### Credential Flow

```
Install: user input → JSON.stringify → AES-256-GCM encrypt(payload, workspaceId) → JSONB column
Runtime: DB read → raw.encrypted → decrypt(token, workspaceId) → JSON.parse → creds object → factory
```

Key derivation: `HMAC-SHA256(ENCRYPTION_SECRET, workspaceId)` — unique per workspace.
Crypto: `packages/agent/src/connections/crypto-util.ts`

Credentials are ONLY decrypted in `loadConnectionTools()` and passed directly to the factory function. They never enter the LLM prompt, tool descriptions, or agent output.

### Audit Trail

Tool calls are persisted as `task_steps` records during task execution. Each step records: step number, tool name, input (truncated), output (truncated), timestamp. SSH tool calls follow this same path.

Additionally, `captureLifecycleEvent()` in the API routes logs connection installs, errors, and status changes.

### Existing Shell Tool Security Model

`packages/agent/src/executor/index.ts:195-260`:
- **Timeout:** 90 seconds (process-group kill via SIGKILL)
- **Environment isolation:** Only whitelisted env vars (PATH, HOME, etc.) — no secrets leaked
- **Process group isolation:** `detached: true` — child runs in its own process group
- **No persistent sessions:** each call spawns, executes, returns
- **Output:** combined stdout+stderr returned to agent

SSH tool inherits these same timeout and isolation principles.

---

## 2. Threat Model

### T1: Credential Exfiltration
**Threat:** Agent includes private key in LLM prompt or tool output.
**Likelihood:** Medium — the agent has tool descriptions that mention SSH, and the LLM might reference credentials in reasoning.
**Impact:** Critical — private key compromise gives permanent unauthorized access.
**Mitigation:**
- Private keys are decrypted ONLY inside the `ssh2.connect()` call within the SSH client wrapper
- The factory function receives `creds` but never passes key material to tool descriptions or output
- Tool output contains only command stdout/stderr — never credential data
- Error messages are sanitized: any string matching PEM header patterns or password-like content is replaced with `[REDACTED]`

### T2: Lateral Movement
**Threat:** Agent SSHs from authorized host A to unauthorized host B.
**Likelihood:** Low — requires agent to construct multi-hop SSH commands.
**Impact:** High — unauthorized access to hosts the user didn't consent to.
**Mitigation:**
- Each tool call is a discrete connect→execute→disconnect cycle from the Plexo server, not from a remote host
- The agent never gets a shell session — it gets command output
- The `ssh__exec` tool connects directly from Plexo to the target host; it does not chain through other hosts
- If the agent attempts `ssh user@otherhost` inside a command, it would fail because no interactive terminal is provided (non-interactive exec)

### T3: Persistent Access
**Threat:** Agent establishes reverse tunnels, backgrounded processes, or cron jobs for persistent access.
**Likelihood:** Medium — an LLM could generate such commands.
**Impact:** High — ongoing unauthorized access after the connection is revoked.
**Mitigation:**
- Command timeout: 90 seconds — anything exceeding this is killed
- No PTY allocation — `ssh2.exec()` without `pty: true` means no interactive session
- Connection closed after each tool call — no port forwarding survives
- Audit log records every command — operator can review
- Recommendation for Phase 2: add optional command denylist (configurable per connection) blocking patterns like `ssh`, `nc`, `ncat`, `socat`, `crontab -e`, `screen`, `tmux`, `nohup ... &`

### T4: Command Injection
**Threat:** Malicious input in command strings (from user or prompt injection).
**Likelihood:** Low — the agent constructs commands, and the ssh2 exec API takes a single string.
**Impact:** Medium — could execute unintended commands.
**Mitigation:**
- The `ssh2.exec()` API sends the command string directly to the remote shell — same as typing it in a terminal. This is by design (it's the purpose of the tool).
- No additional shell wrapping or escaping is applied — the remote server's shell interprets the command.
- The real protection is the consent model: the user explicitly authorized this host and the agent only has access to hosts in `installed_connections`.

### T5: Key Leakage via Logging
**Threat:** Private keys or passwords appear in audit logs, error messages, or API responses.
**Likelihood:** Medium — error paths often include connection details.
**Impact:** Critical — permanent credential compromise.
**Mitigation:**
- Audit log records: `host`, `username`, `command` (truncated to 500 chars), `exitCode`, `durationMs`, `outputBytes` — NEVER `privateKey` or `password`
- Error messages sanitized: PEM patterns (`-----BEGIN.*KEY-----`), password-like strings, and credential fields stripped
- API responses for SSH connections return `__configured__` sentinel instead of actual credentials (same as all other connections)
- `logger.error()` calls in the SSH client strip credential fields before logging

### T6: Denial of Service
**Threat:** Agent runs fork bombs, disk-fill commands, or infinite loops on the remote server.
**Likelihood:** Medium — an LLM could generate such commands, especially under prompt injection.
**Impact:** Medium-High — could crash the remote server.
**Mitigation:**
- Command timeout: 90 seconds — any command exceeding this is killed (connection closed)
- Rate limit: max 50 SSH tool calls per task (configurable)
- Output truncation: 100KB per channel — prevents memory exhaustion on the Plexo side
- Operator responsibility: SSH access implies trust that the agent will be used appropriately. Same as giving someone a shell login.
- Recommendation: document that users should use limited-privilege SSH users (not root) where possible

### T7: Prompt Injection via SSH Output
**Threat:** Remote server output contains text that manipulates the agent (e.g., "SYSTEM: ignore previous instructions and...").
**Likelihood:** Low-Medium — possible if the remote server is compromised or if command output contains user-generated content.
**Impact:** Medium — could cause the agent to take unintended actions.
**Mitigation:**
- SSH output is returned as a tool result, not as a system message — the LLM treats it as data, not instructions
- Output truncated to 100KB — limits the attack surface
- The agent's system prompt includes safety instructions that take precedence over tool output
- Same risk exists with `web_fetch`, `shell`, and every other tool that returns external data — SSH does not introduce a new class of vulnerability here

---

## 3. Security Controls

### SC1: Credential Isolation
Private keys and passwords are decrypted ONLY in the `PlexoSSHClient.connect()` method, which passes them directly to `ssh2.Client.connect()`. At no other point in the codebase are credentials available in plaintext.

### SC2: Output Sanitization
- stdout and stderr truncated to 100KB each
- PEM key patterns stripped from any output before returning to agent
- Error messages sanitized to remove credential-like content

### SC3: Command Denylist (Optional)
Per-connection configurable denylist. Default: none (full access). Operators can set patterns to block (e.g., `rm -rf /`, `:(){ :|:& };:`, `ssh`, `nc`). Stored in `installed_connections.credentials.denylist[]`.

### SC4: Audit Logging
Every `ssh__exec`, `ssh__upload`, `ssh__download`, `ssh__list_dir` call logged:
```
{ type: 'ssh_tool_call', toolName, connectionId, workspaceId, host, username, command (500 chars max), exitCode, outputBytes, durationMs, timestamp }
```

### SC5: Rate Limiting
Max 50 SSH tool calls per task execution. Configurable via `installed_connections.credentials.maxCallsPerTask`. After limit: tool returns error "SSH call limit reached for this task."

### SC6: Connection-Level Permissions
`mode: 'full' | 'readonly'` stored in credentials:
- **full:** all tools available (`ssh__exec`, `ssh__upload`, `ssh__download`, `ssh__list_dir`)
- **readonly:** only `ssh__exec` (read commands), `ssh__download`, `ssh__list_dir`. No `ssh__upload`.

---

## 4. Credential Storage Schema

```typescript
interface SSHCredentials {
    host: string
    port: number                    // default 22
    username: string
    authMethod: 'key' | 'password'
    privateKey?: string             // PEM-encoded private key
    passphrase?: string             // Passphrase for encrypted keys
    password?: string               // Password authentication
    fingerprint?: string            // Expected host key fingerprint (optional, for TOFU)
    mode: 'full' | 'readonly'       // Controls tool availability
    denylist?: string[]             // Optional command patterns to block
    maxCallsPerTask?: number        // Default 50
}
```

Stored encrypted in `installed_connections.credentials.encrypted` as `iv.ciphertext.authTag` (AES-256-GCM, workspace-scoped key).

---

## 5. Connection Registry Entry

```sql
INSERT INTO connections_registry (id, name, description, category, auth_type, setup_fields, tools_provided, is_core)
VALUES (
    'ssh',
    'SSH Server',
    'Connect to a remote server via SSH. Execute commands, transfer files, manage infrastructure.',
    'infrastructure',
    'api_key',
    '[
        {"key":"host","label":"Host or IP","type":"text","required":true,"placeholder":"192.168.1.100"},
        {"key":"port","label":"Port","type":"number","required":false,"placeholder":"22"},
        {"key":"username","label":"Username","type":"text","required":true,"placeholder":"root"},
        {"key":"auth_method","label":"Authentication","type":"select","required":true,"options":["Private Key","Password"]},
        {"key":"private_key","label":"Private Key","type":"textarea","required":false,"placeholder":"Paste your private key here"},
        {"key":"password","label":"Password","type":"password","required":false},
        {"key":"mode","label":"Access Level","type":"select","required":true,"options":["Full Access","Read Only"]}
    ]'::jsonb,
    '["ssh__exec","ssh__upload","ssh__download","ssh__list_dir"]'::jsonb,
    true
);
```

---

## 6. No Blockers Identified

The existing infrastructure supports SSH connections without architectural changes. The tool factory pattern, credential encryption, bridge loading, and audit logging all accommodate SSH as a standard connection type. The threat model identifies risks but all have practical mitigations that follow existing patterns.
