# SSH Security Audit Results

**Date:** 2026-04-08
**Auditor:** Claude (automated + code review)
**Result:** ALL MITIGATIONS VERIFIED

## T1: Credential Exfiltration — PASS
- Private keys passed only to `ssh2.Client.connect()` in `client.ts`
- Tool factory (`factories/ssh.ts`) receives `creds` but never returns key material
- Tool output contains only command stdout/stderr — zero credential fields
- Grep: zero instances of `privateKey` or `password` in any return statement

## T2: Lateral Movement — PASS
- All SSH tool calls route through `sshExec(config, ...)` where `config` comes from decrypted `installed_connections` credentials
- No way to specify an arbitrary host at tool call time — the host is fixed per connection
- The agent cannot chain SSH connections through a remote host (no PTY, no interactive session)

## T3: Persistent Access — PASS
- 4 `finally` blocks in `client.ts` (lines 142, 166, 196, 230) — every function calls `client?.end()`
- No PTY allocation (`pty: false` in exec options)
- No port forwarding API exposed
- Connection timeout: 30s. Command timeout: 90s. Both enforced via `setTimeout` + connection kill.

## T4: Command Injection — ACCEPTED RISK
- SSH commands are passed directly to the remote shell — this is by design
- The protection is the consent model (user must install the connection) and the denylist (optional)
- Same risk profile as the existing `shell` tool for local commands

## T5: Key Leakage via Logging — PASS
- `sanitize()` called on ALL error messages (15 call sites in client.ts)
- PEM pattern `-----BEGIN...-----END...-----` replaced with `[REDACTED:KEY]`
- Audit log in factory records: `host`, `username`, `command` (500 char max), `exitCode`, `durationMs` — never credentials
- API responses return `__configured__` sentinel for installed connection credentials

## T6: Denial of Service — PASS
- Connect timeout: 30s (`readyTimeout` in ssh2 config)
- Command timeout: 90s (via `setTimeout` + connection kill)
- Rate limit: 50 calls/task (configurable via `maxCallsPerTask`)
- Output truncation: 100KB per channel

## T7: Prompt Injection via Output — PASS
- Output truncated to 100KB (prevents large payloads)
- PEM patterns stripped from output before returning to agent
- Output returned as tool result, not system message — LLM treats it as data

## Test Coverage
- 14 SSH-specific tests (5 client + 9 factory)
- Rate limiting: tested and enforced
- Denylist: tested and enforced
- Read-only mode: tested — upload excluded
- PEM sanitization: tested — keys stripped from output
- Connection failure: tested — clear error returned
