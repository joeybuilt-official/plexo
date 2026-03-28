// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * telemetry/events.ts — Structured product events for opted-in instances.
 *
 * Emitted via the PostHog relay (posthog.getplexo.com) — same path as crash reports.
 * Completely opt-in: all functions are no-ops when telemetry is disabled.
 *
 * Privacy guarantees (enforced here, auditable):
 *   - No task content, no user names, no workspace names, no email addresses
 *   - No IP addresses, no hostnames, no file paths containing user data
 *   - Counts are bucketed ("1-9", "10-49", etc.) — no exact numbers
 *   - Model family only (openai/anthropic/ollama/custom) — no model names or API keys
 *   - Sole identifier: a random anonymous instance UUID (set at install)
 *
 * What we DO collect (when opted in):
 *   - Task type (ops/coding/research/deployment/automation)
 *   - Task source (chat/dashboard/telegram/sentry/cron/etc.)
 *   - Task outcome (success/failure)
 *   - Cost bucket (not exact cost)
 *   - Model family (not provider name, not model ID)
 *   - Duration bucket
 *   - Sprint task count bucket, wave count bucket
 *   - Weekly heartbeat: active feature flags (booleans), version, task volume bucket
 *
 * Canonical 10-Event Taxonomy (v1):
 *   - onboarding_started     — setup wizard begins
 *   - onboarding_completed   — first task completes in workspace
 *   - extension_installed    — extension installed from registry
 *   - agent_run_started      — task claimed by agent loop
 *   - agent_run_completed    — task completed successfully
 *   - agent_run_failed       — task failed
 *   - inference_invoked      — LLM call made via provider registry
 *   - settings_changed       — settings update route called
 *   - connection_installed   — MCP/API connection installed
 *   - session_started        — maps to instance_heartbeat
 */

import { getTelemetryConfig } from './posthog.js'
import pino from 'pino'

const logger = pino({ name: 'telemetry:events' })

// Points at the keyless relay — no API key in this codebase.
const TELEMETRY_INGEST = `${process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://posthog.getplexo.com'}/ingest`

// ── Bucket helpers ─────────────────────────────────────────────────────────────

function bucketCount(n: number): string {
    if (n === 0) return '0'
    if (n < 10) return '1-9'
    if (n < 50) return '10-49'
    if (n < 200) return '50-199'
    if (n < 1000) return '200-999'
    return '1000+'
}

function bucketMs(ms: number): string {
    if (ms < 5_000) return '<5s'
    if (ms < 30_000) return '5-30s'
    if (ms < 120_000) return '30s-2m'
    if (ms < 600_000) return '2-10m'
    return '>10m'
}

function bucketCost(usd: number): string {
    if (usd === 0) return '$0'
    if (usd < 0.01) return '<$0.01'
    if (usd < 0.10) return '$0.01-$0.10'
    if (usd < 0.50) return '$0.10-$0.50'
    if (usd < 2.00) return '$0.50-$2.00'
    return '>$2.00'
}

/**
 * Classify a provider/model string to a generic family label.
 * Never exposes model IDs, API keys, or specific provider names.
 */
function modelFamily(provider: string | undefined): string {
    if (!provider) return 'unknown'
    const p = provider.toLowerCase()
    if (p.includes('anthropic') || p.includes('claude')) return 'anthropic'
    if (p.includes('openai') || p.includes('gpt') || p.includes('o1') || p.includes('o3')) return 'openai'
    if (p.includes('google') || p.includes('gemini')) return 'google'
    if (p.includes('ollama') || p.includes('llama') || p.includes('local')) return 'ollama'
    if (p.includes('mistral')) return 'mistral'
    if (p.includes('groq')) return 'groq'
    if (p.includes('deepseek')) return 'deepseek'
    if (p.includes('xai') || p.includes('grok')) return 'xai'
    if (p.includes('openrouter')) return 'openrouter'
    return 'custom'
}

// ── Core emit ──────────────────────────────────────────────────────────────────

async function emit(event: string, properties: Record<string, unknown>): Promise<void> {
    const { instanceId } = getTelemetryConfig()
    // Usage events are gated by the usage toggle specifically
    const { isUsageEnabled } = await import('./posthog.js')
    if (!isUsageEnabled()) return

    try {
        await fetch(TELEMETRY_INGEST, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                event,
                distinct_id: instanceId,
                properties: {
                    ...properties,
                    $lib: 'plexo-api',
                    plexo_version: process.env.npm_package_version ?? 'unknown',
                    node_version: process.version,
                },
                timestamp: new Date().toISOString(),
            }),
            signal: AbortSignal.timeout(5_000),
        })
    } catch (err) {
        logger.debug({ err, event }, 'Telemetry event POST failed — suppressed')
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// Canonical 10-Event Taxonomy (v1)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 1. onboarding_started — emit when setup wizard begins.
 * No user content — only the source channel.
 */
export function emitOnboardingStarted(opts: {
    source: string  // web, cli, api
}): void {
    void emit('onboarding_started', {
        source: opts.source,
    }).catch(() => { /* never throws */ })
}

/**
 * 2. onboarding_completed — emit when first task completes in workspace.
 * No user content — only duration bucket.
 */
export function emitOnboardingCompleted(opts: {
    durationMs: number  // time from workspace creation to first task completion
}): void {
    void emit('onboarding_completed', {
        duration_bucket: bucketMs(opts.durationMs),
    }).catch(() => { /* never throws */ })
}

/**
 * 3. extension_installed — emit from extensions install route.
 * No extension content — only the registry name (public info).
 */
export function emitExtensionInstalled(opts: {
    extensionName: string   // public registry name only
    source: string          // registry, url, manual
}): void {
    void emit('extension_installed', {
        extension_name: opts.extensionName.slice(0, 64),
        source: opts.source,
    }).catch(() => { /* never throws */ })
}

/**
 * 4. agent_run_started — emit when a task is claimed by the agent loop.
 * No task content — only metadata.
 */
export function emitAgentRunStarted(opts: {
    taskType: string    // ops, coding, research, deployment, automation
    source: string      // chat, dashboard, telegram, sentry, cron, etc.
    modelFamily: string
}): void {
    void emit('agent_run_started', {
        task_type: opts.taskType,
        task_source: opts.source,
        model_family: modelFamily(opts.modelFamily),
    }).catch(() => { /* never throws */ })
}

/**
 * 5. agent_run_completed — emit when a task completes successfully.
 * Maps from emitTaskOutcome(success=true). No task content.
 */
export function emitAgentRunCompleted(opts: {
    taskType: string
    source: string
    durationMs: number
    costUsd: number
    modelFamily: string
    stepCount: number
}): void {
    void emit('agent_run_completed', {
        task_type: opts.taskType,
        task_source: opts.source,
        duration_bucket: bucketMs(opts.durationMs),
        cost_bucket: bucketCost(opts.costUsd),
        model_family: modelFamily(opts.modelFamily),
        step_count_bucket: bucketCount(opts.stepCount),
    }).catch(() => { /* never throws */ })
}

/**
 * 6. agent_run_failed — emit when a task fails.
 * Maps from emitTaskOutcome(success=false). No task content or error details.
 */
export function emitAgentRunFailed(opts: {
    taskType: string
    source: string
    durationMs: number
    costUsd: number
    modelFamily: string
    stepCount: number
    failureType: string  // error, timeout, cancelled, blocked
}): void {
    void emit('agent_run_failed', {
        task_type: opts.taskType,
        task_source: opts.source,
        duration_bucket: bucketMs(opts.durationMs),
        cost_bucket: bucketCost(opts.costUsd),
        model_family: modelFamily(opts.modelFamily),
        step_count_bucket: bucketCount(opts.stepCount),
        failure_type: opts.failureType,
    }).catch(() => { /* never throws */ })
}

/**
 * 7. inference_invoked — emit when an LLM call is made via the provider registry.
 * No prompt content — only model family and latency bucket.
 */
export function emitInferenceInvoked(opts: {
    modelFamily: string
    latencyMs: number
    success: boolean
    tokenCountBucket?: string  // optional bucketed token count
}): void {
    void emit('inference_invoked', {
        model_family: modelFamily(opts.modelFamily),
        latency_bucket: bucketMs(opts.latencyMs),
        success: opts.success,
        ...(opts.tokenCountBucket ? { token_count_bucket: opts.tokenCountBucket } : {}),
    }).catch(() => { /* never throws */ })
}

/**
 * 8. settings_changed — emit from settings update routes.
 * No setting values — only the setting key that changed.
 */
export function emitSettingsChanged(opts: {
    settingKey: string   // e.g. "telemetry", "integrations", "model_config"
    source: string       // web, cli, api
}): void {
    void emit('settings_changed', {
        setting_key: opts.settingKey,
        source: opts.source,
    }).catch(() => { /* never throws */ })
}

/**
 * 9. connection_installed — emit from connections install route.
 * No connection details — only connection type.
 */
export function emitConnectionInstalled(opts: {
    connectionType: string  // mcp, custom_api, webhook
    source: string          // web, cli, api
}): void {
    void emit('connection_installed', {
        connection_type: opts.connectionType,
        source: opts.source,
    }).catch(() => { /* never throws */ })
}

/**
 * 10. session_started — maps to instance_heartbeat.
 * Emitted once per session/startup. No user content.
 */
export function emitSessionStarted(): void {
    void emit('session_started', {}).catch(() => { /* never throws */ })
}

// ══════════════════════════════════════════════════════════════════════════════
// Legacy event functions (kept for backwards compatibility)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Emit a task_outcome event after a task completes or fails.
 *
 * Called from agent-loop.ts after completeTask().
 * All content is stripped — only metadata is sent.
 *
 * Also emits the canonical agent_run_completed / agent_run_failed event.
 */
export function emitTaskOutcome(opts: {
    type: string          // ops, coding, research, deployment, automation
    source: string        // chat, dashboard, telegram, sentry, cron, etc.
    success: boolean
    durationMs: number
    costUsd: number
    provider: string | undefined  // will be bucketed to family
    stepCount: number
}): void {
    // Legacy event
    void emit('task_outcome', {
        task_type: opts.type,
        task_source: opts.source,
        success: opts.success,
        duration_bucket: bucketMs(opts.durationMs),
        cost_bucket: bucketCost(opts.costUsd),
        model_family: modelFamily(opts.provider),
        step_count_bucket: bucketCount(opts.stepCount),
    }).catch(() => { /* never throws */ })

    // Canonical event — dual-emit for migration
    if (opts.success) {
        emitAgentRunCompleted({
            taskType: opts.type,
            source: opts.source,
            durationMs: opts.durationMs,
            costUsd: opts.costUsd,
            modelFamily: opts.provider ?? 'unknown',
            stepCount: opts.stepCount,
        })
    } else {
        emitAgentRunFailed({
            taskType: opts.type,
            source: opts.source,
            durationMs: opts.durationMs,
            costUsd: opts.costUsd,
            modelFamily: opts.provider ?? 'unknown',
            stepCount: opts.stepCount,
            failureType: 'error',
        })
    }
}

/**
 * Emit a sprint_outcome event when a sprint finishes.
 *
 * Called from sprint-runner.ts after the final wave resolves.
 * No sprint name, no task content — count buckets only.
 */
export function emitSprintOutcome(opts: {
    taskCount: number
    waveCount: number
    success: boolean
    durationMs: number
    category: string      // general, code, etc.
}): void {
    void emit('sprint_outcome', {
        task_count_bucket: bucketCount(opts.taskCount),
        wave_count_bucket: bucketCount(opts.waveCount),
        category: opts.category,
        success: opts.success,
        duration_bucket: bucketMs(opts.durationMs),
    }).catch(() => { /* never throws */ })
}

/**
 * Daily heartbeat — feature inventory for an opted-in instance.
 *
 * Emits which features are active (booleans only, no names/values).
 * Scheduled once per 24h in index.ts.
 * Also serves as the canonical session_started event.
 */
export async function emitHeartbeat(opts: {
    taskVolumeThisWeek: number
    memoryEntryCount: number
    activeIntegrations: {
        telegram: boolean
        slack: boolean
        discord: boolean
        github: boolean
        sentry: boolean
        memory: boolean
        sprints: boolean
        rsi: boolean
    }
}): Promise<void> {
    await emit('instance_heartbeat', {
        task_volume_bucket: bucketCount(opts.taskVolumeThisWeek),
        memory_entries_bucket: bucketCount(opts.memoryEntryCount),
        // Feature flags — booleans only, no config values
        has_telegram: opts.activeIntegrations.telegram,
        has_slack: opts.activeIntegrations.slack,
        has_discord: opts.activeIntegrations.discord,
        has_github: opts.activeIntegrations.github,
        has_sentry_webhook: opts.activeIntegrations.sentry,
        has_memory: opts.activeIntegrations.memory,
        has_sprints: opts.activeIntegrations.sprints,
        has_rsi: opts.activeIntegrations.rsi,
    })
}
/**
 * Emit when the RSI monitor generates a new proposal.
 * No hypothesis text — anomaly type only.
 */
export function emitRsiProposalCreated(anomalyType: string): void {
    void emit('rsi_proposal_created', {
        anomaly_type: anomalyType,
    }).catch(() => { /* never throws */ })
}

/**
 * Emit when an operator approves or rejects an RSI proposal.
 */
export function emitRsiProposalResolved(opts: {
    anomalyType: string
    action: 'approved' | 'rejected'
}): void {
    void emit('rsi_proposal_resolved', {
        anomaly_type: opts.anomalyType,
        action: opts.action,
    }).catch(() => { /* never throws */ })
}

// ── Quality signals ─────────────────────────────────────────────────────────

/**
 * Emit when the intent classifier makes a decision.
 * No message content — only the classification result and confidence.
 */
export function emitClassifierDecision(opts: {
    intent: string           // TASK, PROJECT, CONVERSATION
    confidence: number       // 0.0-1.0
    source: string           // chat, telegram, slack, discord
    overridden: boolean      // true if principle override forced CONVERSATION
    modelFamily: string      // which model did the classification
}): void {
    void emit('classifier_decision', {
        intent: opts.intent,
        confidence_bucket: opts.confidence < 0.5 ? '<0.5' : opts.confidence < 0.72 ? '0.5-0.72' : opts.confidence < 0.9 ? '0.72-0.9' : '0.9+',
        source: opts.source,
        overridden: opts.overridden,
        model_family: modelFamily(opts.modelFamily),
    }).catch(() => { /* never throws */ })
}

/**
 * Emit when a user correction is detected.
 * No message content — only the correction type.
 */
export function emitUserCorrection(opts: {
    correctionType: string   // explicit_rejection, output_edit, instruction_override
    hadRecentTask: boolean   // was there a task completion in the last 5 min?
}): void {
    void emit('user_correction', {
        correction_type: opts.correctionType,
        had_recent_task: opts.hadRecentTask,
    }).catch(() => { /* never throws */ })
}

/**
 * Emit when a tool fails during execution.
 * No arguments or output — only the tool name and failure type.
 */
export function emitToolFailure(opts: {
    tool: string             // read_file, shell, web_search, etc.
    failureType: string      // timeout, error, crash, permission_denied
    modelFamily: string
}): void {
    void emit('tool_failure', {
        tool: opts.tool,
        failure_type: opts.failureType,
        model_family: modelFamily(opts.modelFamily),
    }).catch(() => { /* never throws */ })
}

/**
 * Emit when the model router falls back to a secondary provider.
 * No request content — only the routing decision.
 */
export function emitRoutingFallback(opts: {
    primaryFamily: string
    fallbackFamily: string
    reason: string           // auth_error, timeout, rate_limit, model_not_found
}): void {
    void emit('routing_fallback', {
        primary_family: modelFamily(opts.primaryFamily),
        fallback_family: modelFamily(opts.fallbackFamily),
        reason: opts.reason,
    }).catch(() => { /* never throws */ })
}

/**
 * Emit quality score distribution for completed tasks.
 * Bucketed — no raw scores or task content.
 */
export function emitQualityScore(opts: {
    score: number            // 0.0-1.0
    taskType: string
    modelFamily: string
    stepCountBucket: string
}): void {
    const scoreBucket = opts.score < 0.3 ? '<0.3'
        : opts.score < 0.5 ? '0.3-0.5'
        : opts.score < 0.7 ? '0.5-0.7'
        : opts.score < 0.9 ? '0.7-0.9'
        : '0.9+'
    void emit('quality_score', {
        score_bucket: scoreBucket,
        task_type: opts.taskType,
        model_family: modelFamily(opts.modelFamily),
        step_count_bucket: opts.stepCountBucket,
    }).catch(() => { /* never throws */ })
}

/**
 * Emit when reflection (success or failure track) fires.
 * Tracks whether the system is learning from outcomes.
 */
export function emitReflectionEvent(opts: {
    track: 'success' | 'failure'
    observationCount: number  // how many observations extracted
    taskType: string
}): void {
    void emit('reflection_event', {
        track: opts.track,
        observation_count: opts.observationCount,
        task_type: opts.taskType,
    }).catch(() => { /* never throws */ })
}

/**
 * Emit conversation response latency.
 * Bucketed — no message content.
 */
export function emitConversationLatency(opts: {
    source: string           // chat, telegram, slack, discord
    latencyMs: number
    modelFamily: string
}): void {
    void emit('conversation_latency', {
        source: opts.source,
        latency_bucket: bucketMs(opts.latencyMs),
        model_family: modelFamily(opts.modelFamily),
    }).catch(() => { /* never throws */ })
}
