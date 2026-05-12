# Analytics

Plexo collects anonymous analytics data to improve the product. All analytics is **opt-in** and **disabled by default**. Nothing is sent until you explicitly enable it in Settings > Privacy.

## Two Independent Channels

| Channel | Toggle | What it gates |
|---------|--------|---------------|
| **Crash reports** | "Share crash reports" | Sanitized error data stored in `plexo_ops_errors` table |
| **Usage patterns** | "Share usage patterns" | Product events stored in `plexo_ops_analytics` table |

Each channel can be enabled or disabled independently at any time. Toggling off stops all new transmission immediately. Both default to off.

## Identifier

Each instance generates a random UUID at install time (`analytics_instance_id`). This is the only identifier used. It has no relationship to your email, hostname, IP, or any user account. You can regenerate it at any time in Settings > Privacy.

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

These are the **only** properties that can appear in any analytics payload:

### Error Reports (plexo_ops_errors)

```
fingerprint              string   (hash of message + first stack frame)
message                  string   (error message)
stack_trace              string   (sanitized stack trace)
context                  jsonb    (structured context, allowlisted keys only)
deploy_id                string   (deploy hash, optional)
occurrence_count         integer  (auto-incremented on duplicate fingerprint)
```

### Usage Events (plexo_ops_analytics)

```
distinct_id              string   (same as analytics_instance_id)
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
setting_key              string   (e.g., "analytics", "integrations")
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

The following categories of data are never included in any analytics payload, regardless of consent state:

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

### Plexo-Native (plexo_ops)

All analytics is stored in the Plexo database under `plexo_ops_*` tables. No external services are required. Data never leaves the instance unless the operator explicitly configures external forwarding.

Tables:
- `plexo_ops_errors` — deduplicated error tracking with fingerprint-based upsert
- `plexo_ops_analytics` — anonymous usage events with hard property allowlist

Ingest endpoints:
- `POST /api/v1/analytics/ingest` — usage events (allowlisted event names only)
- `POST /api/v1/analytics/error` — error reports (fingerprint-based dedup)

## Preview UI

On first login, a analytics preview modal shows:
- Plain English description of what is collected
- Expandable preview of the exact JSON payload
- One-click opt-out toggle
- Acknowledgement persists in localStorage

You can also review analytics settings at any time in **Settings > Privacy**.

## Source Code

All analytics code is in `apps/api/src/analytics/` and is designed to be auditable:

- `events.ts` — all event definitions and the emit function (writes directly to plexo_ops)
- `sanitize.ts` — payload sanitizer for crash reports
- `router.ts` — API routes for consent management and plexo_ops ingest
- `posthog.ts` — consent state management and DB sync
