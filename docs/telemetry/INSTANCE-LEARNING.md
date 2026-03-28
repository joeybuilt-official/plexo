# Instance Learning Interface

How Plexo's instance-level learning systems relate to (and stay separate from) platform telemetry.

## What Exists

Plexo includes several systems that learn and adapt at the individual instance level. These run entirely on the operator's infrastructure and never transmit data to Joeybuilt.

### RSI Monitor

The Recursive Self-Improvement monitor detects anomalies in agent behavior and generates proposals for system-level improvements. Proposals require operator approval before taking effect.

- **Source:** `apps/api/src/routes/rsi.ts`, `@plexo/agent/memory/self-improvement`
- **Storage:** `rsi_proposals` and `rsi_test_results` tables (local DB)
- **Cycle:** Anomaly detected -> proposal created -> operator reviews -> approved/rejected -> test results tracked

### Self-Improvement Cycle

The self-improvement cycle analyzes completed task outcomes to identify patterns in agent performance and generates improvement suggestions. Triggered manually or on schedule.

- **Source:** `@plexo/agent/memory/self-improvement` (`runSelfImprovementCycle`)
- **Storage:** Improvement log in local DB
- **Trigger:** `POST /api/memory/improvements/run` or cron schedule

### Reflection (Success + Failure Tracks)

After task completion, the reflection system extracts observations about what worked and what didn't. Success and failure tracks run independently — both produce structured observations that feed back into future planning.

- **Source:** `apps/api/src/agent-loop.ts` (post-task reflection step)
- **Storage:** Memory entries in local DB
- **Tracks:** `success` (what to repeat) and `failure` (what to avoid)

### Corrections Feedback Loop

When a user explicitly corrects the agent (rejection, output edit, instruction override), the correction is recorded and used to adjust future behavior. No correction content leaves the instance.

- **Source:** Chat handlers, behavior routes
- **Storage:** Local memory and behavior rules
- **Types:** `explicit_rejection`, `output_edit`, `instruction_override`

### Preference Learning

The preference system tracks operator and user patterns: tool preferences, communication style, domain knowledge, operational rules, safety constraints, and quality gates.

- **Source:** `@plexo/agent/memory/preferences` (`getPreferences`)
- **Storage:** Structured entries in local memory store
- **Categories:** `safety_constraint`, `operational_rule`, `communication_style`, `domain_knowledge`, `persona_trait`, `tool_preference`, `quality_gate`

### Memory Consolidation

Periodic consolidation merges related memory entries, prunes stale data, and maintains memory hygiene. Runs as a background job.

- **Source:** `@plexo/agent/memory/store` (semantic search + consolidation)
- **Storage:** Local DB with vector embeddings

### Quality Judge

The ensemble quality judge evaluates task outputs before delivery. Scores are used for internal gating (below-threshold results trigger retry) and feed back into the self-improvement cycle.

- **Source:** `apps/api/src/agent-loop.ts` (quality-judge settings merge)
- **Storage:** Quality scores attached to task records in local DB

## Interface Points with Telemetry

Each instance learning system can optionally emit telemetry events. These events contain **metadata only** — never the learning content itself.

| System | Telemetry Event | What's Sent | What's NOT Sent |
|--------|----------------|-------------|-----------------|
| RSI Monitor | `rsi_proposal_created` | Anomaly type | Hypothesis text, improvement code |
| RSI Monitor | `rsi_proposal_resolved` | Action (approved/rejected) | Proposal content, test results |
| Reflection | `reflection_event` | Track (success/failure), observation count, task type | Observation text, reasoning |
| Corrections | `user_correction` | Correction type, had_recent_task | Message content, correction details |
| Quality Judge | `quality_score` | Score bucket, task type, model family | Raw score, output content |
| Self-Improvement | *(via heartbeat)* | `has_rsi` boolean | Improvement log, cycle results |
| Memory | *(via heartbeat)* | Memory entry count bucket | Entry content, embeddings |

All telemetry events are gated by the `telemetry_usage_enabled` consent toggle. When disabled, no events are emitted regardless of instance learning activity.

## How They Coexist Without Coupling

Instance learning and platform telemetry are architecturally separate systems that share infrastructure but not data flows.

### Separate Data Flows

```
Instance Learning                    Platform Telemetry

Task outcome                         Task outcome
  -> Reflection extracts obs           -> emit('agent_run_completed')
  -> Observations stored locally       -> POST to posthog.getplexo.com
  -> Feed into future planning         -> Dashboard analytics
  -> Never leave the instance          -> 90-day retention, then deleted
```

The same event (e.g., task completion) can trigger both an instance learning action and a telemetry emission. These are independent code paths. Disabling telemetry does not affect instance learning. Disabling instance learning (e.g., turning off RSI) does not affect telemetry.

### Separate Storage

| System | Storage | Location | Leaves Instance? |
|--------|---------|----------|-----------------|
| Instance learning | PostgreSQL + vector store | Operator's DB | Never |
| Crash reports | Sentry event | sentry.getplexo.com | Only when opted in |
| Usage patterns | PostHog event | posthog.getplexo.com | Only when opted in |

### Separate Consent

Instance learning has no consent toggle — it's a core product feature that runs on the operator's own infrastructure with the operator's own data. There is nothing to consent to because nothing leaves.

Platform telemetry has two independent consent toggles (crash reports + usage patterns) that default to off.

The consent infrastructure (DB storage, in-memory flags, Settings UI) is shared, but the consent decisions are independent.

## What's NOT in Scope for Platform Telemetry

All of the following stay local to the instance. They are never transmitted to Joeybuilt under any circumstances, regardless of consent state:

- Memory entries (content, embeddings, metadata)
- Reflection observations (success or failure track text)
- Self-improvement cycle outputs (improvement log entries)
- RSI proposals (hypothesis text, proposed code changes)
- RSI test results (test outputs, pass/fail details)
- Preference entries (rules, constraints, learned patterns)
- Quality judge raw scores and evaluations
- Correction content (what the user said, what was corrected)
- Prompt improvement patches
- Consolidated memory state

The telemetry system can report that these systems *ran* (e.g., "reflection fired, produced 3 observations") but never reports *what* they produced.
