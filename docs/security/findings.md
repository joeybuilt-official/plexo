# Security Audit Findings — PLEXO-LAUNCH-001 Phase D

**Date**: 2026-03-26
**Scope**: apps/api, packages/agent, SSE stream, auth boundary

## Critical (BLOCKS BETA)

### C1: SSE endpoint lacked authentication
- **Surface**: Auth boundary / SSE scoping
- **File**: `apps/api/src/routes/sse.ts`
- **Issue**: SSE endpoint accepted `workspaceId` as a query parameter with no authentication. Any user could subscribe to any workspace's event stream.
- **Impact**: Real-time eavesdropping on task completions, OWD approvals, and operational events.
- **Remediation**: Added `optionalSupabaseAuth` middleware + workspace membership check via `workspace_members` table. Unauthenticated connections to workspace-scoped streams are rejected with 403.
- **Status**: FIXED

### C2: web_fetch tool had no URL filtering (SSRF)
- **Surface**: Agent execution
- **File**: `packages/agent/src/executor/index.ts`
- **Issue**: Agent's `web_fetch` tool could access any URL including internal IPs (10.x, 192.168.x), localhost, and cloud metadata services (169.254.169.254).
- **Impact**: SSRF attacks, internal service enumeration, cloud credential exfiltration via metadata API.
- **Remediation**: Added URL blocklist covering localhost, private RFC 1918 ranges, link-local (169.254.x), IPv6 private ranges, and cloud metadata hostnames.
- **Status**: FIXED

## High (MUST FIX BEFORE BETA)

### H1: read_file allowed absolute path traversal
- **Surface**: Agent execution
- **File**: `packages/agent/src/executor/index.ts`
- **Issue**: `read_file` and `write_file` accepted absolute paths with no containment check. Agent could read `/etc/passwd`, `.env`, or any file accessible to the Node.js process.
- **Remediation**: Added path containment — resolved path must start with `defaultCwd` or `/tmp/plexo-`. Absolute paths outside these boundaries are rejected.
- **Status**: FIXED

### H2: Invitation tokens logged in plaintext
- **Surface**: Secret exposure
- **File**: `apps/api/src/routes/members.ts:212`
- **Issue**: Full invitation tokens were logged via `logger.info({ token })`. If logs are exposed, attackers could use tokens to join workspaces.
- **Remediation**: Changed to log only `tokenPrefix` (first 8 chars + "...").
- **Status**: FIXED

### H3: Shell env includes credential tokens
- **Surface**: Agent execution
- **File**: `packages/agent/src/executor/index.ts:172-186`
- **Issue**: `SAFE_ENV_KEYS` allowlist includes `GITHUB_TOKEN`, `GITLAB_TOKEN`, `NPM_TOKEN`, etc. These are passed to spawned shell commands.
- **Impact**: If a prompt instructs the agent to log or exfiltrate env vars, these tokens are exposed.
- **Remediation**: DOCUMENTED RISK — tokens are intentionally included because many agent tasks (git push, npm publish) require them. Mitigation: shell output is bounded to 2KB and web_fetch blocks internal URLs.
- **Status**: ACCEPTED RISK (documented)

## Medium (TRACKED)

### M1: Routes accept workspaceId without membership verification
- **Surface**: Auth boundary
- **Files**: `chat.ts`, `behavior.ts`, `memory.ts`, `tasks.ts`, and ~15 other routes
- **Issue**: Routes validate UUID format but don't verify the authenticated user is a member of the requested workspace.
- **Plan**: Add `verifyWorkspaceAccess()` helper to all workspace-scoped routes.
- **Status**: TRACKED — requires systematic route audit
