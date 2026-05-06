# PLEXO Google Messages connector — operator runbook

**Audience:** on-call operator / SRE handling a paged incident or a planned bump.
**Scope:** the Go sidecar at `apps/gmessages/` plus the Plexo API surfaces it talks to (`/api/plexo/channels/gmessages/*` HMAC + `/api/v1/channels/*` Better-Auth + `/api/v1/connections/gmessages/*` pair flow).

This document covers four scenarios. Read the **symptoms** column first to identify which one you're in, then jump to the matching procedure.

| # | Scenario | Symptoms |
|---|---|---|
| 1 | **Session expired / revoked** | One or more `paired_sessions` rows in `state='expired'` or `'revoked'`; users see the offline banner; no inbound messages for the affected workspace. |
| 2 | **libgm version bump** | Planned monthly maintenance, or upstream advisory. Bump cadence: monthly minimum, 5% canary for 24h. |
| 3 | **Google protocol drift detected** | `decode_error_count` rising across multiple sessions simultaneously; inbound traffic stalls; libgm logs `ListenFatalError` or `HTTPError`. |
| 4 | **Connector restart loop** | The `gmessages` Docker container repeatedly restarts (visible in `docker compose ps` or Coolify dashboard). |

---

## 1. Session expired or revoked

### Detection

```sh
# On the Plexo API host:
psql -c "SELECT id, workspace_id, channel_id, state, state_changed_at, error_detail
         FROM plexo_gmessages.paired_sessions
         WHERE state IN ('expired','revoked','errored')
         ORDER BY state_changed_at DESC LIMIT 20;"
```

The `Inngest gmessages-stale-session-monitor` cron flips a session to `errored` after 24h with no `lastInboundAt`. Connect-time refusal flips to `expired`. `*events.GaiaLoggedOut` flips to `revoked`.

### Procedure

1. **Communicate** — the affected user sees the offline banner ("Your phone is offline. Messages will arrive when it reconnects.") in the Plexo viewer (`/app/channels/<channelId>`). The Reconnect link deep-links to `/app/connections/gmessages/pair`. No operator action is *required* — the user can re-pair self-service.
2. **If self-service fails** — check the API logs for `gmessages.pair.started` / `gmessages.pair.linked` audit events to see how far the user got. If stuck at "starting", check `GMESSAGES_SIDECAR_URL` env on the api container (default `http://gmessages:3010`) is reachable.
3. **If the entire workspace's sessions are expired in lockstep** — that's likely scenario #3 (protocol drift), not scenario #1.

**Do NOT** delete `paired_sessions` rows manually unless you've coordinated with the workspace owner. Each row carries the encrypted libgm AuthData via FK to `installed_connections.credentials`; deleting the connection cascades the session.

---

## 2. libgm version bump

Cadence: **monthly minimum** per ADR-0001. The package is `go.mau.fi/mautrix-gmessages/pkg/libgm`; pinned in `apps/gmessages/go.mod` (currently `v0.2604.0`).

### Pre-bump checklist

- [ ] Confirm there's no active deploy in progress.
- [ ] Confirm the Plexo API isn't in a known-bad state (`decode_error_count` should be near-zero across active sessions).
- [ ] Stage the canary plan: 5% of paired sessions, 24h soak, decode-error counter watch.

### Procedure

1. **Update go.mod**:
   ```sh
   cd apps/gmessages
   docker run --rm -v "$PWD":/work -w /work golang:1.25-alpine \
       sh -c "go get go.mau.fi/mautrix-gmessages@<NEW_TAG> && go mod tidy"
   ```
   If the new libgm version requires a newer Go, bump `go.mod` `go` directive AND the Dockerfile base image in lockstep (currently `golang:1.25-alpine` → distroless static).
2. **Verify locally**:
   ```sh
   docker run --rm -v "$PWD":/work -w /work golang:1.25-alpine \
       sh -c "go vet ./... && go build ./... && go test -count=1 ./..."
   ```
   All three must be green. If `dispatchEvent`'s type-switch breaks (e.g., libgm renamed `*libgm.WrappedMessage` or `*events.GaiaLoggedOut`), update the symbol references in `internal/session/handler.go`.
3. **Bump version constant** in `cmd/gmessages/main.go` (`version = "0.0.X-libgm-<TAG>"`) — surfaces in `/health` for ops visibility.
4. **Check libgm CHANGELOG** for breaking changes to `client.SendMessage`, `client.RefreshPhoneRelay`, the `events` package, or `event_handler.go`'s `WrappedMessage` shape. Any rename = update Plexo callsites.
5. **Build + push** the new sidecar image. Tag the image with both the libgm version AND a Plexo phase tag.
6. **Canary deploy**:
   - Deploy to 5% of paired sessions only (use a feature flag on `paired_sessions.workspace_id` or rolling-deploy a single replica, depending on your topology).
   - Watch the dashboard:
     ```sql
     SELECT workspace_id,
            channel_id,
            state,
            decode_error_count,
            last_inbound_at,
            now() - last_inbound_at AS idle_for
     FROM plexo_gmessages.paired_sessions
     WHERE state IN ('active','refreshing')
     ORDER BY decode_error_count DESC LIMIT 50;
     ```
   - **Rollback signal**: any session crossing ~10 `decode_error_count` increments per hour, OR `last_inbound_at` aging past 2× the typical idle window for that workspace.
7. **24-hour soak.** If clean, broaden to 100% of sessions.
8. **Document the bump** with: date, old tag, new tag, soak observations, rollback events. Append to `PLEXO-GMESSAGES-PROGRESS.md` decisions log.

### Rollback

`docker compose pull gmessages && docker compose up -d gmessages` against the previous image tag. The sidecar's boot-restore (`runBootRestore`) re-establishes sessions from `paired_sessions.state IN ('active','refreshing')` rows automatically.

---

## 3. Google protocol drift detected

This is the dominant operational risk per Mira (master plan §"Audit-stage expert panel"). Symptom: Google changes the upstream Web Messages protocol, libgm hasn't caught up, and inbound events stop normalizing or arrive corrupt.

### Detection

```sql
-- Spike in decode errors across multiple sessions in a short window:
SELECT date_trunc('hour', last_inbound_at) AS hour,
       avg(decode_error_count) AS avg_errs,
       count(*) AS sessions
FROM plexo_gmessages.paired_sessions
WHERE state = 'active' AND last_inbound_at > now() - interval '6 hours'
GROUP BY 1 ORDER BY 1 DESC;
```

A sudden cross-workspace rise in `avg_errs` with no recent libgm bump is the canonical drift signature.

### Procedure

1. **Confirm cross-workspace** — single-workspace decode-error spikes are usually session corruption (re-pair fixes); cross-workspace = upstream drift.
2. **Check upstream** — visit the libgm repo (`https://go.mau.fi/mautrix-gmessages`) issues + recent commits. If drift is acknowledged, an updated tag may already exist; jump to scenario #2.
3. **If no upstream fix yet**:
   - **Surface user-visible state honestly** — the "Google Messages is updating. Reconnecting your phone may take a few minutes." copy from ADR-0005 §"Copy lock" (currently shown when the system suspects drift; auto-trigger logic = Phase 6+ work). Until that auto-trigger lands, manually flip affected sessions to `errored` so users see the offline banner and re-pair attempts surface the drift signal.
   - **Pause the stale-session monitor** if it's flooding events (`docker compose stop` the inngest service, or disable `gmessagesStaleSessionMonitor` in the API).
   - **File an upstream issue** with sample event traces from `go test` if reproducible.
4. **When upstream ships a fix**: scenario #2 (libgm bump) with shortened canary (12h instead of 24h since the alternative is broken).

### What NOT to do

- Don't try to patch libgm in-tree. Doing so forks Plexo from upstream and silently masks future protocol drift detection. Always wait for upstream + bump.
- Don't disable `decode_error_count` to "quiet the alerts." It's the primary protocol-drift signal per ADR-0004.

---

## 4. Connector restart loop

### Detection

```sh
docker compose ps gmessages
docker compose logs --tail 200 gmessages
```

A restart loop usually means the sidecar boot path is failing **before** the HTTP server starts listening, so `/health` never goes green. Common causes:

- `PLEXO_SERVICE_KEY` not set or doesn't match the api container. **Phase 6 fast-fail:** `runStartupSelfCheck` POSTs an HMAC-signed request at boot. A persistent 401 exits 1 with a clear `"startup HMAC self-check failed: HTTP 401"` log line + the fix command. If you see this in logs, jump straight to step 2 below.
- `ENCRYPTION_SECRET` / `GMESSAGES_MASTER_KEY` missing or different from the api's.
- `PLEXO_API_URL` unreachable from inside the gmessages container's network namespace.
- `runBootRestore` failing on a corrupt `paired_sessions` row. **Phase 6 hardening:** all realistic decrypt failure modes are explicitly tested in `cryptosvc.TestDecrypt_BootRestoreFailureModes` and produce errors (which post `state='errored'`) rather than panicking the process. If you see a panic stack, it's a regression — file against the Plexo repo with the trace.

### Procedure

1. **Inspect logs** — look for the panic stack trace or the env-var validation error at startup.
2. **Verify env**:
   ```sh
   docker compose exec gmessages env | grep -E 'PLEXO_(SERVICE_KEY|API_URL)|ENCRYPTION_SECRET|GMESSAGES_MASTER_KEY|GMESSAGES_HTTP_PORT'
   ```
   Cross-reference against `apps/api/`'s env (must use the same `PLEXO_SERVICE_KEY` + `ENCRYPTION_SECRET`).
3. **Verify network**:
   ```sh
   docker compose exec gmessages wget -O- http://api:3001/api/health 2>&1 | head -3
   ```
4. **Skip boot restore as a triage step** (only if 1-3 don't reveal the cause):
   ```sh
   docker compose stop gmessages
   psql -c "UPDATE plexo_gmessages.paired_sessions SET state='paired' WHERE state IN ('active','refreshing');"
   docker compose start gmessages
   ```
   This forces the sidecar to boot with **no** sessions to restore. If it stays up, the panic was in `runBootRestore` against a specific session — narrow down by re-flipping sessions one at a time. Note: while `state='paired'` the sidecar won't process inbound for those sessions; users will need to either wait for the next heartbeat (which won't arrive without an active sidecar binding) or re-pair.
5. **Boot-loop with no obvious cause** — the `gmessages -healthcheck` self-probe hitting the local HTTP server inside Docker's healthcheck can mask startup issues if the port binds late. Increase the healthcheck `start_period` in `docker-compose.yml`.

### Escalation

If the loop persists after env + network + boot-skip triage, the most likely remaining cause is a libgm-side init panic (see scenario #3 — protocol drift can manifest as a startup panic). File against the Plexo repo with the full stack trace and current libgm pin.

---

## Appendix A — Useful one-liners

```sh
# Restart just the sidecar (preserves api + db + inngest):
docker compose up -d --no-deps --no-build gmessages

# Tail sidecar logs:
docker compose logs -f --tail 100 gmessages

# Force-trigger a session refresh (bypasses Inngest):
curl -X POST http://localhost:3010/sessions/<pairedSessionId>/refresh \
    -H "X-App-Id: plexo-api" \
    -H "X-Plexo-Timestamp: $(date -u +%FT%TZ)" \
    -H "X-Plexo-Signature: sha256=$(printf '{}' | openssl dgst -sha256 -hmac "$PLEXO_SERVICE_KEY" -hex | cut -d' ' -f2)" \
    -H "Content-Type: application/json" -d '{}'

# Show active session count + decode error spread:
psql -c "SELECT state, count(*), max(decode_error_count)
         FROM plexo_gmessages.paired_sessions
         GROUP BY state ORDER BY count DESC;"
```

---

## Appendix B — Cross-references

- `/PLEXO-GMESSAGES-PROGRESS.md` — full status tracker, every phase's decisions log.
- `/PLEXO-GMESSAGES-PHASE-5-INGEST.md` §9 — open seams Phase 6+ should pick up.
- `/adr/0001-gmessages-go-sidecar.md` — pre-mortem + version pin policy.
- `/adr/0004-sidecar-tenancy.md` — single-process multi-tenant invariants.
- `/adr/0005-plexo-viewer-and-pairing.md` — locked copy + UX flows.
- `/adr/0006-inngest-install.md` — Inngest patterns the cron + receiver use.
- `apps/gmessages/README.md` — local dev + architecture summary.
