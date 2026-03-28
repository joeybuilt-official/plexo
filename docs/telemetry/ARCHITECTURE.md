# Telemetry Architecture — v2

## Root Cause (Phase 0 Finding)

`configureTelemetry({ enabled: false })` is hardcoded at startup in `apps/api/src/index.ts:250`. The in-memory flag is only synced from DB when a browser request hits `GET /api/v1/telemetry`. Every event between server start and first page load is silently dropped. After restart, flag resets to `false`.

**Fix:** Load consent state from DB at startup. Add startup log confirming telemetry state.

---

## Consent Model

Two independent boolean preferences per instance:

| Field | Default | Purpose |
|-------|---------|---------|
| `telemetry_errors_enabled` | `false` | Gate Sentry crash reports |
| `telemetry_usage_enabled` | `false` | Gate PostHog quality events |
| `telemetry_instance_id` | random UUID | Stable anonymous identifier |

Rules:
- Both default `false` — opt-in only
- Each toggles independently at any time
- Toggling off stops all new transmission immediately
- Consent state checked at runtime, not build time
- Consent changes written to audit log
- Fine print: "Data already received by Joeybuilt may be retained for up to 90 days."

### Storage

Currently stored in `workspaces.settings.telemetry` as JSONB. The new model adds a second toggle. Schema:

```json
{
  "telemetry": {
    "errors_enabled": false,
    "usage_enabled": false,
    "instance_id": "uuid"
  }
}
```

No migration needed — JSONB is schemaless. The code reads/writes these keys.

### Startup Sync

```
Server starts
  → Query first workspace's settings.telemetry from DB
  → Set in-memory flags: _errorsEnabled, _usageEnabled, _instanceId
  → Log: "Telemetry: errors={true|false}, usage={true|false}, instanceId={uuid}"
  → If no workspace exists yet, defaults remain false
```

This replaces the hardcoded `enabled: false`.

---

## Loop A — Error Signals (Sentry)

```
Runtime error
  → captureException() checks _errorsEnabled
  → Sentry SDK beforeSend: strip against allowlist
  → Sentry project at sentry.getplexo.com
  → Weekly: Inngest job queries Sentry API
  → GitHub issue: "Weekly Error Digest — [date]"
```

### Sentry Configuration

- DSN: `SENTRY_DSN` env var (operator) + hardcoded central DSN
- Central client: gated by `_errorsEnabled`
- Operator client: always active when `SENTRY_DSN` is set
- `tracesSampleRate: 0.1`
- `beforeSend`: validate against safe context allowlist, strip non-allowlist fields
- SDK timeout: 2000ms
- Source maps: uploaded in CI as required step

### Safe Context Allowlist

```
telemetry_instance_id    string
plexo_version            string
os_family                string   (linux | macos | windows)
error_type               string   (constructor name)
stack_frames             string[] (function names + sanitized paths only)
pipeline_step            string   (PLAN | CONFIRM | EXECUTE | VERIFY | REPORT)
task_category            string   (coding | research | ops | deployment | automation | unknown)
node_version             string
```

Never: IP, hostname, email, user ID, instance name, URL, content, extension names.

---

## Loop B — Usage Signals (PostHog)

```
User action
  → posthog.capture() checks _usageEnabled
  → Self-hosted PostHog at posthog.getplexo.com
  → Dashboards (human review)
  → Product decisions
```

### PostHog Configuration

- API key: `POSTHOG_API_KEY` env var
- Host: hardcoded to `posthog.getplexo.com` (never PostHog cloud)
- Autocapture: disabled
- Session recording: disabled
- Persistence: `memory` (no localStorage)
- Identify: `posthog.identify(instance_id, { plexo_version, os_family })`

### Event Taxonomy (10 events, v1)

| Event | Decision It Drives |
|-------|-------------------|
| `onboarding_started` | Is the onboarding funnel entry rate healthy? |
| `onboarding_completed` | Where do people drop out? |
| `extension_installed` | Which extensions drive activation? |
| `agent_run_started` | How often are agents used? |
| `agent_run_completed` | What is the success rate? |
| `agent_run_failed` | What failure modes need fixing first? |
| `inference_invoked` | Inference usage pattern per session? |
| `settings_changed` | Which settings do people adjust? |
| `connection_installed` | Is connection setup a drop-off point? |
| `session_started` | What is baseline weekly active usage? |

No other events in v1. Additions require a named decision.

---

## Subdomain Rename

| Service | Current | Target |
|---------|---------|--------|
| PostHog | `telemetry.getplexo.com` | `posthog.getplexo.com` |
| Sentry | `sentry.getplexo.com` | `sentry.getplexo.com` (no change) |

All code references to `telemetry.getplexo.com` updated to `posthog.getplexo.com`.

---

## Privacy Screen UI

### Onboarding (first run)

Context block: "Help make Plexo better" — explains why, no pressure, both toggles default off.

### Settings → Privacy

Two independent toggles:
1. "Share crash reports" → `telemetry_errors_enabled`
2. "Share usage patterns" → `telemetry_usage_enabled`

Each has: heading, body, benefit statement, fine print (90-day retention).

Below toggles:
- "See exactly what gets sent →" — modal with live JSON payload
- "How this data is used →" — links to TELEMETRY.md

### What the UI must never do

- Pre-check either toggle
- Use "are you sure?" language when opting out
- Bundle both into "agree to all"
- Imply opting in is required for functionality

---

## Weekly Digest Worker (Loop A closure)

- Schedule: Monday 08:00 UTC
- Query Sentry API for new issue groups (past 7 days)
- Filter: ≥3 occurrences
- Rate limit: max 30 items per digest
- Output: GitHub issue on joeybuilt-official/plexo with markdown table
- Labels: `auto-triage`, `from-sentry`
- Dead letter: 3 retries with 15-min backoff → write to `telemetry_digest_failures` table

---

## Instance-Level Learning (Separate)

Existing systems (RSI, reflection, corrections, preferences, memory consolidation) are architecturally separate from platform telemetry. They don't transmit to Joeybuilt. They share the consent infrastructure but have separate data flows and storage. No changes to instance learning in this build.

---

## Implementation Phases

| Phase | What | Gate |
|-------|------|------|
| 2 | Consent UI + split toggles + startup sync + preview modal | Tests pass, build succeeds |
| 3 | Sentry integration + beforeSend + source maps | Test error visible in Sentry |
| 4 | PostHog integration + 10 events + identify | Events visible in PostHog |
| 5 | Weekly digest worker + dead letter + TELEMETRY.md | E2E test passes |
| 6 | Instance learning documentation | Review only |
