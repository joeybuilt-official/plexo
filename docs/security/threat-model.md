# Plexo Security Audit — LAUNCH-001 Phase D

**Date:** 2026-03-27
**Scope:** API server (`apps/api/src/`), agent executor (`packages/agent/src/executor/`)
**Auditor:** Automated (Claude Code)

## 1. Audit Methodology

Four attack surfaces were audited in priority order:

1. **Auth boundary** — Every route file in `apps/api/src/routes/` was inspected for auth middleware usage (`requireSupabaseAuth`, `optionalSupabaseAuth`, `requireServiceKey`, `requireSuperAdmin`, `cmdCenterAuth`). Each route was classified as protected or unprotected.

2. **Secret exposure** — All `logger.*()` calls and API response payloads were searched for leaked secrets (API keys, tokens, passwords, credentials). Error responses were checked for stack traces and internal paths.

3. **Agent execution surface** — The agent tool runner (`packages/agent/src/executor/tool-runner.ts`) was audited for path traversal, command injection, and env var exfiltration. The code mode API (`apps/api/src/routes/code.ts`) was checked for containment.

4. **SSE stream** — The SSE route (`apps/api/src/routes/sse.ts`) was audited for workspace isolation and auth enforcement.

## 2. Findings

| # | Severity | Surface | Description | Status |
|---|----------|---------|-------------|--------|
| F1 | **Critical** | SSE stream | Unauthenticated users could subscribe to any workspace's SSE stream. `optionalSupabaseAuth` meant the membership check was skipped when no JWT was provided. Any client knowing a workspace UUID could receive all real-time events (task status, agent activity, OWD approvals). | **Fixed** |
| F2 | **Critical** | Secret exposure | OAuth token exchange failure logged `{ tokenData, provider }` where `tokenData` contains `access_token`, `refresh_token`, and other secrets from the identity provider response. | **Fixed** |
| F3 | **High** | Secret exposure | Health endpoint (`/health`) exposed internal state to unauthenticated callers: DB/Redis latency, AI provider status/error details, app version, uptime, worker stats, prompt/context counts. Useful for reconnaissance. | **Fixed** |
| F4 | **High** | Secret exposure | Invite acceptance logged the full invite token in plaintext (`{ token, userId, workspaceId }`). Tokens in logs can be harvested by anyone with log access. | **Fixed** |
| F5 | **High** | Agent execution | Agent tool runner `read_file` and `write_file` resolved paths relative to workDir but never validated containment. A prompt-injected agent could read `/etc/passwd`, env files, or write to arbitrary filesystem locations. | **Fixed** |
| F6 | **Medium** | Auth boundary | Debug routes (`/api/v1/debug/*`) are protected by `x-debug-token` header only in production or when `DEBUG_TOKEN` env var is set. If neither condition is met, debug routes are open. The guard logic is explicit but fragile — relies on `NODE_ENV` being correctly set. | Documented |
| F7 | **Medium** | Auth boundary | Most API routes have no per-user auth. They rely on workspace UUID as an authorization boundary. This is by design for a self-hosted app (CORS restricts browser origins), but any client that bypasses CORS (curl, server-side code) can access any workspace's data by UUID. | Documented |
| F8 | **Medium** | Agent execution | The shell tool's env allowlist includes `GITHUB_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN`, `GITLAB_TOKEN`, `NPM_TOKEN`, `VERCEL_TOKEN`, and `NETLIFY_AUTH_TOKEN`. A prompt-injected agent could exfiltrate these via shell commands (`curl` to attacker server). These tokens are needed for legitimate agent operations but represent a prompt injection risk. | Documented |
| F9 | **Low** | Secret exposure | Error handler in `index.ts` returns a generic `INTERNAL_ERROR` message with no stack trace or internal paths. This is correct. | N/A (good) |
| F10 | **Low** | Secret exposure | AI provider health ping explicitly avoids logging raw error bodies from providers, parsing only `error.type`/`error.code`. This is correct. | N/A (good) |
| F11 | **Low** | Agent execution | Code mode API (`/api/v1/code/file`) has proper path traversal protection using `resolve()` + `startsWith()` containment check. | N/A (good) |

## 3. Remediation Notes

### F1 — SSE workspace stream auth (Critical, Fixed)

**File:** `apps/api/src/routes/sse.ts`

**Before:** `optionalSupabaseAuth` was used, and the membership check only ran when `req.user` was set. Unauthenticated requests bypassed the check entirely.

**After:** Workspace-scoped SSE streams now require authentication. If `workspaceId !== 'global'` and no user is authenticated, a 401 is returned. DB errors during membership verification now deny by default instead of allowing the connection.

### F2 — OAuth tokenData log redaction (Critical, Fixed)

**File:** `apps/api/src/routes/oauth.ts`

**Before:** `logger.error({ tokenData, provider }, ...)` logged the entire token exchange response including access/refresh tokens.

**After:** Only `{ provider, tokenDataKeys: Object.keys(tokenData), hasAuthedUser: !!authedUser }` is logged — enough to debug the issue without exposing secrets.

### F3 — Health endpoint information disclosure (High, Fixed)

**File:** `apps/api/src/routes/health.ts`

**Before:** All callers received full diagnostics: latencies, version, uptime, worker stats, DB counts.

**After:** Unauthenticated callers receive only `{ status, services: { postgres: { ok }, redis: { ok }, ai: { ok } } }`. Full diagnostics are returned only when a valid `x-debug-token` header or `Authorization: Bearer` header is present.

### F4 — Invite token log redaction (High, Fixed)

**File:** `apps/api/src/routes/members.ts`

**Before:** Full invite token logged in plaintext.

**After:** Only the first 8 characters + `...` are logged (consistent with how invite creation already logged tokens).

### F5 — Agent tool-runner path containment (High, Fixed)

**File:** `packages/agent/src/executor/tool-runner.ts`

**Before:** `read_file` and `write_file` resolved paths but never validated they stayed within the task's working directory. Absolute paths or `../../` traversals could access any file on the host.

**After:** An `assertContained()` guard validates that every resolved path starts with the task's `workDir` prefix. Attempts to escape throw an error that is returned to the agent as a tool failure.

### F6 — Debug routes auth (Medium, Documented)

**Recommendation:** Always set `DEBUG_TOKEN` in production. Consider requiring Supabase JWT auth (super-admin) for debug routes instead of a static token, or disable them entirely in production builds.

### F7 — Workspace UUID as authorization boundary (Medium, Documented)

**Recommendation:** This is acceptable for a self-hosted, single-tenant deployment behind CORS. For multi-tenant or public deployments, add `requireSupabaseAuth` middleware to the v1 router for all workspace-scoped routes and validate workspace membership on each request.

### F8 — Agent env var exfiltration via shell (Medium, Documented)

**Recommendation:** Consider moving sensitive tokens (GITHUB_TOKEN, etc.) out of the allowlist and instead injecting them per-tool-call only when the agent's task explicitly requires Git/deploy operations. Alternatively, implement egress filtering (network policy) to prevent the agent process from making outbound HTTP requests to non-allowlisted domains.
