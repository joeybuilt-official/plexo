// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Lightweight in-process Prometheus metrics collector.
 *
 * Hand-formatted Prometheus text exposition — no prom-client dep.
 * Keeps memory bounded by:
 *   - Counters/gauges: Map keyed by label-set string, no expiry
 *   - Histograms: fixed bucket array per label-set
 *   - Max cardinality cap per metric (drops new series when hit)
 *
 * DB-derived gauges (task counts, workspace counts, etc.) are NOT
 * held in memory — they're queried on scrape from Postgres so the
 * metrics endpoint is a thin projection, not a second source of truth.
 */

import type { Request, Response, NextFunction } from 'express'

const MAX_SERIES_PER_METRIC = 2000

type LabelMap = Record<string, string>

function labelsKey(labels: LabelMap): string {
    const keys = Object.keys(labels).sort()
    return keys.map(k => `${k}=${labels[k]}`).join(',')
}

function formatLabels(labels: LabelMap): string {
    const keys = Object.keys(labels).sort()
    if (keys.length === 0) return ''
    const parts = keys.map(k => `${k}="${escapeLabel(labels[k] ?? '')}"`)
    return `{${parts.join(',')}}`
}

function escapeLabel(v: string): string {
    return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

interface Counter {
    type: 'counter'
    help: string
    values: Map<string, { labels: LabelMap; value: number }>
}

interface Gauge {
    type: 'gauge'
    help: string
    values: Map<string, { labels: LabelMap; value: number }>
}

interface Histogram {
    type: 'histogram'
    help: string
    buckets: number[] // upper bounds in seconds
    values: Map<string, { labels: LabelMap; counts: number[]; sum: number; count: number }>
}

type Metric = Counter | Gauge | Histogram

const registry = new Map<string, Metric>()

// Default latency buckets — ms range suited to a web API
const DEFAULT_LATENCY_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

export function counter(name: string, help: string): void {
    if (!registry.has(name)) {
        registry.set(name, { type: 'counter', help, values: new Map() })
    }
}

export function gauge(name: string, help: string): void {
    if (!registry.has(name)) {
        registry.set(name, { type: 'gauge', help, values: new Map() })
    }
}

export function histogram(name: string, help: string, buckets: number[] = DEFAULT_LATENCY_BUCKETS): void {
    if (!registry.has(name)) {
        registry.set(name, { type: 'histogram', help, buckets: [...buckets].sort((a, b) => a - b), values: new Map() })
    }
}

export function incrementCounter(name: string, labels: LabelMap = {}, delta = 1): void {
    const m = registry.get(name)
    if (!m || m.type !== 'counter') return
    const key = labelsKey(labels)
    const existing = m.values.get(key)
    if (existing) {
        existing.value += delta
        return
    }
    if (m.values.size >= MAX_SERIES_PER_METRIC) return
    m.values.set(key, { labels: { ...labels }, value: delta })
}

export function setGauge(name: string, value: number, labels: LabelMap = {}): void {
    const m = registry.get(name)
    if (!m || m.type !== 'gauge') return
    const key = labelsKey(labels)
    const existing = m.values.get(key)
    if (existing) {
        existing.value = value
        return
    }
    if (m.values.size >= MAX_SERIES_PER_METRIC) return
    m.values.set(key, { labels: { ...labels }, value })
}

export function observeHistogram(name: string, valueSeconds: number, labels: LabelMap = {}): void {
    const m = registry.get(name)
    if (!m || m.type !== 'histogram') return
    const key = labelsKey(labels)
    let entry = m.values.get(key)
    if (!entry) {
        if (m.values.size >= MAX_SERIES_PER_METRIC) return
        entry = { labels: { ...labels }, counts: new Array(m.buckets.length).fill(0), sum: 0, count: 0 }
        m.values.set(key, entry)
    }
    entry.sum += valueSeconds
    entry.count += 1
    for (let i = 0; i < m.buckets.length; i++) {
        const bound = m.buckets[i] ?? Number.POSITIVE_INFINITY
        if (valueSeconds <= bound) {
            entry.counts[i] = (entry.counts[i] ?? 0) + 1
        }
    }
}

/**
 * Stabilization-agent helper: read raw counter series for a single metric.
 * Returns a list of `{ labels, value }` pairs the agent can aggregate.
 *
 * Returns an empty array if the metric isn't registered or is not a counter.
 */
export function getCounterSeries(name: string): { labels: LabelMap; value: number }[] {
    const m = registry.get(name)
    if (!m || m.type !== 'counter') return []
    return Array.from(m.values.values()).map((v) => ({ labels: { ...v.labels }, value: v.value }))
}

export function render(): string {
    const lines: string[] = []
    for (const [name, m] of registry.entries()) {
        lines.push(`# HELP ${name} ${m.help}`)
        lines.push(`# TYPE ${name} ${m.type}`)
        if (m.type === 'counter' || m.type === 'gauge') {
            if (m.values.size === 0) {
                // Emit a zero-valued sample so scrapers don't see a hole on cold start
                lines.push(`${name} 0`)
            } else {
                for (const { labels, value } of m.values.values()) {
                    lines.push(`${name}${formatLabels(labels)} ${value}`)
                }
            }
        } else if (m.type === 'histogram') {
            if (m.values.size === 0) {
                lines.push(`${name}_bucket{le="+Inf"} 0`)
                lines.push(`${name}_sum 0`)
                lines.push(`${name}_count 0`)
                continue
            }
            for (const { labels, counts, sum, count } of m.values.values()) {
                const base = formatLabels(labels)
                const innerLabels = Object.keys(labels).sort().map(k => `${k}="${escapeLabel(labels[k] ?? '')}"`)
                for (let i = 0; i < m.buckets.length; i++) {
                    const bound = m.buckets[i]
                    if (bound === undefined) continue
                    const le = bound.toString()
                    const parts = [...innerLabels, `le="${le}"`]
                    lines.push(`${name}_bucket{${parts.join(',')}} ${counts[i] ?? 0}`)
                }
                const infParts = [...innerLabels, `le="+Inf"`]
                lines.push(`${name}_bucket{${infParts.join(',')}} ${count}`)
                lines.push(`${name}_sum${base} ${sum}`)
                lines.push(`${name}_count${base} ${count}`)
            }
        }
    }
    return lines.join('\n') + '\n'
}

// ── Register default metrics ───────────────────────────────────

counter('plexo_http_requests_total', 'HTTP request count by method, route, status')
histogram('plexo_http_request_duration_seconds', 'HTTP request duration in seconds')
counter('plexo_llm_requests_total', 'LLM request count by provider and model')
counter('plexo_llm_tokens_total', 'LLM token count by provider, model, direction (in|out)')
counter('plexo_llm_cost_total_usd', 'LLM cost in USD by provider')
counter('plexo_tasks_created_total', 'Count of tasks created')
counter('plexo_tasks_completed_total', 'Count of tasks reaching terminal state by status')
histogram(
    'plexo_task_duration_seconds',
    'Task duration in seconds (claim → complete)',
    [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600],
)
gauge('plexo_tasks_in_state', 'Current tasks by status (gauge, sampled on scrape)')
gauge('plexo_workspace_count', 'Total workspace count')
gauge('plexo_memory_entries_total', 'Total memory entry count')
gauge('plexo_active_users', 'Active users by period (day|week|month)')
gauge('plexo_db_up', 'Postgres reachability — 1 = up, 0 = down')
gauge('plexo_redis_up', 'Redis reachability — 1 = up, 0 = down')
gauge('plexo_embeddings_up', 'Inference gateway reachability — 1 = up, 0 = down')
gauge('plexo_build_info', 'Static build info — always 1, labels carry version/commit')

// ── Stabilization: provider-level + SCL observability ──────────
histogram(
    'plexo_llm_latency_seconds',
    'LLM call latency in seconds by provider, model, task type, and status',
    [0.5, 1, 2, 3, 5, 8, 10, 15, 30, 60, 120],
)
histogram(
    'plexo_introspection_build_seconds',
    'Introspection snapshot assembly time in seconds by subsystem',
    [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
)
counter('plexo_credential_access_total', 'Credential decrypt operations by workspace')
counter('plexo_scl_mutation_total', 'SCL mutation operations by result type')
counter('plexo_embedding_dimension_mismatch_total', 'Embedding dimension mismatch rejections')

// QA-opt ADR 0042: memory recall is best-effort context behind a hard latency
// budget. A budget_exceeded (graphiti jammed) or error increment means a reply
// was generated with NO memory context — previously only a debug log, so the
// degradation was invisible. result ∈ {hit|miss|budget_exceeded|error}.
counter('plexo_memory_recall_total', 'Memory recall outcomes by result (hit|miss|budget_exceeded|error)')

// QA-opt ADR 0037: router-v2 decision outcomes. fallback=1 means the selector
// fell back off its first-choice provider; degraded=1 means it routed to a
// sub-recommended provider; operator_action=1 means the decision needs operator
// attention (e.g. all good providers exhausted). Sourced from emitRoutedEvent.
counter('plexo_model_routed_total', 'Router-v2 decisions by task_type, fallback, degraded, operator_action')

// AI1 (ADR 0037 §observe-only addendum): schema-mode calls that required the
// generateText repair path. repairUsed is computed entirely in-process inside
// call-model.ts — no DB reads, no scoring-path changes. Purely additive counter.
// Labels match plexo_llm_latency_seconds for join-ability. workspace_id omitted
// (high cardinality; join via task logs if needed).
counter('plexo_model_repair_total', 'Schema-mode LLM calls that required the generateText repair path, by provider, model, task_type')

// QA-opt ADR 0044: graphiti is the canonical recall store; the silent failure
// mode is a write that lands but extracts 0 facts (nothing recallable). result ∈
// {extracted, empty, failed}. (Replaces the originally-planned pgvector coverage
// gauge AI4 — that store is frozen legacy since the 2026-05-13 graphiti cutover.)
counter('plexo_memory_write_total', 'Memory-write outcomes by result (extracted|empty|failed)')

// Phase K (Item 15b): instruments the policy-only-gate footgun where a
// workspace standing approval on `general_task` silently bypasses the
// requireApprovalForGeneralTasks policy gate. Non-zero in production = signal
// to escalate the policy-only path to riskLevel='high' so SEC-016's
// standing-approval lockout protects it the same way it protects OWDs.
counter('plexo_policy_only_gate_standing_approval_passes_total', 'Policy-only CONFIRM gates auto-approved by a workspace standing approval (footgun signal)')

// L5 (ADR 0006 §D2/§D3/§D4): outbound channel tool calls auto-elevated to OWD
// regardless of planner verdict. Each increment = one tool that the
// elevation pass added to plan.oneWayDoors. Labels: tool, provider.
counter('plexo_owd_elevation_outbound_total', 'Outbound channel tool calls auto-elevated to OWD by the deterministic elevation pass')

// L5b (ADR 0006 §D5): executor-side mid-stream guard. Increment = an outbound
// connection-tool call the LLM emitted at execute-time that plan.oneWayDoors[]
// did NOT cover. Non-zero means either a planner missed `toolsRequired` for an
// outbound step (covered by the wrapper synthesizing a fresh approval) or a
// prompt-injected planner deliberately omitted the tool to bypass the gate.
counter('plexo_outbound_tool_call_uncovered_total', 'Outbound connection-tool calls intercepted by the executor-side approval guard with no covering OWD in plan.oneWayDoors')

// L5.5 #8 — fires once per (task, tool) pair when the per-task denial budget
// is first exhausted. Operator-fatigue signal: the model kept trying the same
// uncovered tool, the operator denied it `budget` times (default 3), and the
// guard switched to instant-deny so the operator is no longer woken on each
// re-emit. Non-zero on a healthy workspace usually means a buggy planner that
// keeps re-emitting an outbound call against operator wishes.
counter('plexo_outbound_denial_loop_total', 'Outbound tool calls switched to instant-deny after exhausting the per-task denial budget (L5.5 #8)')

// Phase O (ADR 0010) — channel-config encryption-at-rest observability.
// `legacy_read_total` counts every read of a sensitive config field that
// wasn't `enc:`-prefixed (i.e. legacy plaintext that survived the migration).
// Target: zero within 7 days post-deploy. Non-zero indicates a write site
// that's still inserting plaintext, OR a row the migration missed.
counter('plexo_channel_config_legacy_read_total', 'Sensitive channel-config field read with legacy plaintext (no enc: prefix)')
counter('plexo_channel_config_decrypt_failed_total', 'Sensitive channel-config field decrypt threw (corrupted ciphertext or wrong key)')

// Phase N (ADR 0009) — Gmail attachments observability.
counter('plexo_gmail_attachment_fetched_total', 'Gmail attachment fetched + stored, labeled by MIME prefix')
counter('plexo_gmail_attachment_rejected_total', 'Gmail attachment rejected before fetch, labeled by reason')
counter('plexo_gmail_attachment_fetch_failed_total', 'Gmail attachment fetch returned 4xx/5xx or empty bytes')

// Phase N+1 (ADR 0012) — clamd attachment-scan observability.
counter('plexo_clamd_scan_total', 'clamd INSTREAM scan results, labeled by result (clean|infected|error)')
histogram(
    'plexo_clamd_scan_duration_ms',
    'clamd INSTREAM scan duration in milliseconds',
    [10, 50, 100, 500, 1000, 5000],
)
gauge('plexo_clamd_scan_queue_depth', 'Pending rows in attachment_scan_queue (refreshed each tick)')

// ── Request timing middleware ──────────────────────────────────

/**
 * Normalises an Express route pattern into a metric label.
 * Uses the matched route pattern when available, otherwise falls back
 * to the first two path segments to avoid cardinality blow-up from IDs.
 */
function normaliseRoute(req: Request): string {
    // req.route.path only exists after route matching; use base + route when available
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const base = (req as any).baseUrl ?? ''
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const routePath = (req as any).route?.path
    if (typeof routePath === 'string') {
        return `${base}${routePath}` || '/'
    }
    // Fallback: strip query string and collapse deep paths
    const url = req.originalUrl.split('?')[0] ?? '/'
    const parts = url.split('/').filter(Boolean)
    if (parts.length <= 3) return '/' + parts.join('/')
    return '/' + parts.slice(0, 3).join('/') + '/*'
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
    const startNs = process.hrtime.bigint()
    res.on('finish', () => {
        const durationSec = Number(process.hrtime.bigint() - startNs) / 1e9
        const route = normaliseRoute(req)
        const method = req.method
        const status = String(res.statusCode)
        incrementCounter('plexo_http_requests_total', { method, route, status })
        observeHistogram('plexo_http_request_duration_seconds', durationSec, { method, route })
    })
    next()
}

// ── Convenience emitters for call-sites ────────────────────────

export function recordLlmCall(provider: string, model: string, tokensIn: number, tokensOut: number, costUsd: number): void {
    const pLabels = { provider, model }
    incrementCounter('plexo_llm_requests_total', pLabels)
    incrementCounter('plexo_llm_tokens_total', { ...pLabels, direction: 'in' }, tokensIn)
    incrementCounter('plexo_llm_tokens_total', { ...pLabels, direction: 'out' }, tokensOut)
    incrementCounter('plexo_llm_cost_total_usd', { provider }, costUsd)
}

export function recordTaskCreated(): void {
    incrementCounter('plexo_tasks_created_total')
}

export function recordTaskCompleted(status: string, durationSec: number): void {
    incrementCounter('plexo_tasks_completed_total', { status })
    observeHistogram('plexo_task_duration_seconds', durationSec, { status })
}

export function setBuildInfo(version: string, commit: string): void {
    setGauge('plexo_build_info', 1, { version, commit })
}

export function recordLlmLatency(provider: string, model: string, taskType: string, status: string, durationSec: number): void {
    observeHistogram('plexo_llm_latency_seconds', durationSec, { provider, model, task_type: taskType, status })
}

export function recordIntrospectionTiming(subsystem: string, durationSec: number): void {
    observeHistogram('plexo_introspection_build_seconds', durationSec, { subsystem })
}

export function recordCredentialAccess(workspaceId: string): void {
    incrementCounter('plexo_credential_access_total', { workspace_id: workspaceId })
}

export type MemoryRecallResult = 'hit' | 'miss' | 'budget_exceeded' | 'error'
export function recordMemoryRecall(result: MemoryRecallResult): void {
    incrementCounter('plexo_memory_recall_total', { result })
}

export function recordModelRouted(m: { taskType: string; fallback: boolean; degraded: boolean; operatorAction: boolean }): void {
    incrementCounter('plexo_model_routed_total', {
        task_type: m.taskType,
        fallback: m.fallback ? '1' : '0',
        degraded: m.degraded ? '1' : '0',
        operator_action: m.operatorAction ? '1' : '0',
    })
}

export function recordMemoryWrite(m: { graphitiOk: boolean; extractedFacts: number | null }): void {
    const result = !m.graphitiOk ? 'failed' : (m.extractedFacts ?? 0) > 0 ? 'extracted' : 'empty'
    incrementCounter('plexo_memory_write_total', { result })
}

export function recordModelRepair(m: { provider: string; model: string; taskType: string }): void {
    incrementCounter('plexo_model_repair_total', { provider: m.provider, model: m.model, task_type: m.taskType })
}
