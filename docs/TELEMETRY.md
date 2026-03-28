# Telemetry

Plexo collects anonymous telemetry data to improve the product. All telemetry is **opt-in** and **disabled by default**. Nothing is sent until you explicitly enable it in Settings > Privacy.

## Two Independent Channels

| Channel | Toggle | What it gates |
|---------|--------|---------------|
| **Crash reports** | "Share crash reports" | Sanitized error data sent to Sentry at `sentry.getplexo.com` |
| **Usage patterns** | "Share usage patterns" | Product events sent to PostHog at `posthog.getplexo.com` |

Each channel can be enabled or disabled independently at any time. Toggling off stops all new transmission immediately. Both default to off.

## Identifier

Each instance generates a random UUID at install time (`telemetry_instance_id`). This is the only identifier used. It has no relationship to your email, hostname, IP, or any user account. You can regenerate it at any time in Settings > Privacy.

## Event Taxonomy (v1)

These are the only events Plexo sends when usage patterns are enabled. No additional events will be added without updating this document.

| Event | Decision It Drives | Properties Sent |
|-------|-------------------|-----------------|
| `onboarding_started` | Is the onboarding funnel entry rate healthy? | `source` |
| `onboarding_completed` | Where do people drop out? | `duration_bucket` |
| `extension_installed` | Which extensions drive activation? | `extension_name`, `source` |
| `agent_run_started` | How often are agents used? | `task_type`, `task_source`, `model_family` |
| `agent_run_completed` | What is the success rate? | `task_type`, `task_source`, `duration_bucket`, `cost_bucket`, `model_family`, `step_count_bucket` |
| `agent_run_failed` | What failure modes need fixing first? | `task_type`, `task_source`, `duration_bucket`, `cost_bucket`, `model_family`, `step_count_bucket`, `failure_type` |
| `inference_invoked` | Inference usage pattern per session? | `model_family`, `latency_bucket`, `success` |
| `settings_changed` | Which settings do people adjust? | `setting_key`, `source` |
| `connection_installed` | Is connection setup a drop-off point? | `connection_type`, `source` |
| `session_started` | What is baseline weekly active usage? | *(none beyond standard properties)* |

### Standard Properties (attached to all events)

Every event also includes:

- `plexo_version` — the Plexo API version (e.g., `0.5.2`)
- `node_version` — the Node.js runtime version
- `$lib` — always `plexo-api`

### Legacy Events (backwards compatible)

These events predate the canonical taxonomy and are still emitted alongside the canonical names for migration continuity:

- `task_outcome` — also emits `agent_run_completed` or `agent_run_failed`
- `sprint_outcome` — sprint completion data
- `instance_heartbeat` — daily feature flag inventory (also serves as `session_started`)

### Quality Signal Events

Additional events for product quality tracking:

- `classifier_decision` — intent classification result (no message content)
- `user_correction` — correction type only
- `tool_failure` — tool name and failure type only
- `routing_fallback` — model family routing decisions
- `quality_score` — bucketed quality scores
- `reflection_event` — which track (success/failure) fired
- `conversation_latency` — bucketed response time
- `rsi_proposal_created` — anomaly type only
- `rsi_proposal_resolved` — action taken (approved/rejected)

## Complete Property Allowlist

These are the **only** properties that can appear in any telemetry payload:

### Sentry (crash reports)

```
telemetry_instance_id    string   (random UUID)
plexo_version            string   (e.g., "0.5.2")
node_version             string   (e.g., "v22.12.0")
error_type               string   (constructor name only — e.g., "TypeError")
stack_frames             string[] (function names + sanitized file paths, no args)
pipeline_step            string   (PLAN | CONFIRM | EXECUTE | VERIFY | REPORT)
task_category            string   (coding | research | ops | deployment | automation | unknown)
os.name                  string   (from Sentry runtime context)
runtime.name             string   (from Sentry runtime context)
```

### PostHog (usage patterns)

```
distinct_id              string   (same as telemetry_instance_id)
plexo_version            string
node_version             string
$lib                     string   (always "plexo-api")
source                   string   (web | cli | api | chat | telegram | slack | discord)
task_type                string   (ops | coding | research | deployment | automation)
task_source              string   (chat | dashboard | telegram | sentry | cron)
model_family             string   (anthropic | openai | google | ollama | mistral | groq | deepseek | xai | openrouter | custom | unknown)
success                  boolean
duration_bucket          string   (<5s | 5-30s | 30s-2m | 2-10m | >10m)
cost_bucket              string   ($0 | <$0.01 | $0.01-$0.10 | $0.10-$0.50 | $0.50-$2.00 | >$2.00)
step_count_bucket        string   (0 | 1-9 | 10-49 | 50-199 | 200-999 | 1000+)
failure_type             string   (error | timeout | cancelled | blocked)
setting_key              string   (e.g., "telemetry", "integrations")
connection_type          string   (mcp | custom_api | webhook)
extension_name           string   (public registry name, max 64 chars)
latency_bucket           string   (same buckets as duration_bucket)
intent                   string   (TASK | PROJECT | CONVERSATION)
confidence_bucket        string   (<0.5 | 0.5-0.72 | 0.72-0.9 | 0.9+)
overridden               boolean
correction_type          string   (explicit_rejection | output_edit | instruction_override)
had_recent_task          boolean
tool                     string   (tool name — e.g., "read_file", "shell")
track                    string   (success | failure)
observation_count        number
anomaly_type             string
action                   string   (approved | rejected)
score_bucket             string   (<0.3 | 0.3-0.5 | 0.5-0.7 | 0.7-0.9 | 0.9+)
task_count_bucket        string   (same buckets as step_count_bucket)
wave_count_bucket        string   (same buckets as step_count_bucket)
category                 string   (general | code)
has_telegram             boolean
has_slack                boolean
has_discord              boolean
has_github               boolean
has_sentry_webhook       boolean
has_memory               boolean
has_sprints              boolean
has_rsi                  boolean
task_volume_bucket       string   (same buckets as step_count_bucket)
memory_entries_bucket    string   (same buckets as step_count_bucket)
```

## What Is NEVER Collected

The following categories of data are never included in any telemetry payload, regardless of consent state:

- Task content, prompts, goals, or outputs
- User names, email addresses, or account identifiers
- Workspace names or project names
- IP addresses, hostnames, or server names
- File paths containing user data
- Request URLs, query parameters, headers, or cookies
- API keys, tokens, or credentials
- Model IDs or specific model names (bucketed to family)
- Exact counts (bucketed to ranges)
- Exact costs (bucketed to ranges)
- Exact durations (bucketed to ranges)
- Memory entries, agent reasoning, or conversation content
- Extension configuration or connection credentials
- Browser cookies or session data

## Data Retention

- Data received by Joeybuilt LLC may be retained for up to **90 days**.
- After 90 days, data is permanently deleted from all systems.
- You can request early deletion by emailing privacy@getplexo.com.

## Infrastructure

### PostHog

PostHog is **self-hosted** on Plexo infrastructure at `posthog.getplexo.com`. No data touches PostHog's cloud service. Events are forwarded through a keyless relay — no PostHog API key exists in the Plexo codebase. The relay injects the key server-side.

Configuration:
- Autocapture: disabled
- Session recording: disabled
- Persistence: memory only (no localStorage)
- Identify: instance UUID only (no user accounts)

### Sentry

Sentry is **self-hosted** at `sentry.getplexo.com`. The central Sentry DSN is baked into the codebase (Sentry DSNs are designed to be public). The `beforeSend` hook strips all fields not on the safe context allowlist before any event leaves the instance.

Operators can configure their own Sentry project via the `SENTRY_DSN` environment variable. The operator's Sentry is always active regardless of telemetry consent — it's their own infrastructure.

## Preview UI

You can see exactly what gets sent before enabling telemetry:

1. Go to **Settings > Privacy**
2. Click **"See exactly what gets sent"**
3. A modal shows the live JSON payload that would be transmitted

## Source Code

All telemetry code is in `apps/api/src/telemetry/` and is designed to be auditable:

- `posthog.ts` — PostHog client, consent management, DB sync
- `events.ts` — all event definitions and the emit function
- `sanitize.ts` — payload sanitizer for crash reports
- `router.ts` — API routes for consent management

The Sentry integration lives in `apps/api/src/sentry.ts`.
