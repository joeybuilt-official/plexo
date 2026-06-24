// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Ops alerts — batched operator notification for provider-unreliability and
 * failed synthetic canaries (Phase 4 observability/alerting).
 *
 * Two failure streams accumulate in memory:
 *   - provider failures   — router cascade-exhaust + auth/quota streaks
 *   - canary failures      — the onboarding canary (and any future canary)
 *
 * A cron (`flushOpsAlerts`) sends ONE batched Telegram summary per tick and
 * clears the buffers — never one message per failure (that would spam on an
 * outage). Delivery is env-gated and a no-op when unconfigured:
 *   PLEXO_OPS_ALERT_WORKSPACE_ID — workspace whose registered Telegram bot token is used
 *   PLEXO_OPS_ALERT_CHAT_ID      — chat to deliver the alert to
 *   PLEXO_OPS_ALERT_WEBHOOK_URL  — OBS4: optional fallback sink. The batched text
 *                                  is POSTed as {text} JSON alongside Telegram, so
 *                                  a single-replica Telegram outage doesn't drop the
 *                                  alert. Either sink alone satisfies delivery.
 */

import { getChannelToken } from './channel-delivery.js'
import { logger } from './logger.js'

const TELEGRAM_API = 'https://api.telegram.org/bot'
const MAX_BUFFER = 500  // hard cap so an outage can't grow the buffer unbounded

interface ProviderFailureRecord {
    kind: string
    provider: string
    taskType?: string
    statusCode?: number
    at: number
}

interface CanaryFailureRecord {
    check: string
    reason: string
    at: number
}

interface BudgetAlertRecord {
    workspaceId: string
    costUsd: number
    ceilingUsd: number
    at: number
}

interface SloBreachRecord {
    scope: string            // "provider/model (taskType)"
    successRate: number
    sampleCount: number
    p95Ms: number
    at: number
}

const providerFailures: ProviderFailureRecord[] = []
const canaryFailures: CanaryFailureRecord[] = []
const budgetAlerts: BudgetAlertRecord[] = []
const sloBreaches: SloBreachRecord[] = []

export function recordProviderFailureForAlert(rec: Omit<ProviderFailureRecord, 'at'>): void {
    if (providerFailures.length >= MAX_BUFFER) providerFailures.shift()
    providerFailures.push({ ...rec, at: Date.now() })
}

export function recordCanaryFailureForAlert(rec: Omit<CanaryFailureRecord, 'at'>): void {
    if (canaryFailures.length >= MAX_BUFFER) canaryFailures.shift()
    canaryFailures.push({ ...rec, at: Date.now() })
}

/**
 * Round-5 Phase 6 — pre-ceiling burn-rate alert. Called when a workspace's
 * weekly spend first crosses the 80% threshold (agent-loop detects the
 * false→true transition, so this fires once per workspace per week, not per task).
 */
export function recordBudgetAlertForAlert(rec: Omit<BudgetAlertRecord, 'at'>): void {
    if (budgetAlerts.length >= MAX_BUFFER) budgetAlerts.shift()
    budgetAlerts.push({ ...rec, at: Date.now() })
}

/**
 * Round-5 Phase 9 — SLO breach. Enqueued by the router-stats snapshot cron when
 * a (provider, model, task_type) bucket's success rate (or p95 latency) breaches
 * the SLO with enough samples to be meaningful.
 */
export function recordSloBreachForAlert(rec: Omit<SloBreachRecord, 'at'>): void {
    if (sloBreaches.length >= MAX_BUFFER) sloBreaches.shift()
    sloBreaches.push({ ...rec, at: Date.now() })
}

export interface SloThresholds {
    /** Minimum acceptable success rate (0..1). */
    minSuccess: number
    /** Ignore buckets with fewer samples than this (noise floor). */
    minSamples: number
    /** Max acceptable p95 latency in ms; 0 = don't check latency. */
    maxP95Ms: number
}

export interface RouterBucketStat {
    provider: string
    model: string
    taskType: string
    successRate: number
    sampleCount: number
    latencyP95Ms: number
}

/**
 * Per-scope record of the last sampleCount observed by the SLO evaluator. Used
 * to suppress re-firing a breach for a "frozen" bucket — i.e. one whose stats
 * are stuck at the same sampleCount because no new traffic has hit it since
 * the previous evaluation tick. Without this, an in-memory bucket whose last
 * sample failed (e.g. a model that's been quietly retired) would re-emit a
 * fresh alert on every snapshot tick until the 7-day rolling window finally
 * ages all samples out.
 */
const lastSeenSampleCount = new Map<string, number>()

/** Test-only — wipe stale-bucket suppression state between cases. */
export function _resetSloEvaluatorStateForTest(): void {
    lastSeenSampleCount.clear()
}

/**
 * SLO evaluation — returns the breaching buckets. Stateful: tracks the
 * previously observed sampleCount per scope so a bucket whose count hasn't
 * changed (no new traffic) doesn't re-emit on every cron tick. The cron maps
 * results into recordSloBreachForAlert. Read thresholds from env via
 * {@link sloThresholdsFromEnv}.
 */
export function evaluateSloBreaches(
    buckets: RouterBucketStat[],
    t: SloThresholds,
): Omit<SloBreachRecord, 'at'>[] {
    const out: Omit<SloBreachRecord, 'at'>[] = []
    const seenScopes = new Set<string>()
    for (const b of buckets) {
        const scope = `${b.provider}/${b.model} (${b.taskType})`
        seenScopes.add(scope)
        const prev = lastSeenSampleCount.get(scope)
        // Update the watermark unconditionally so a healthy bucket that later
        // turns into a breach (with new traffic) still fires.
        lastSeenSampleCount.set(scope, b.sampleCount)

        if (b.sampleCount < t.minSamples) continue
        const successBreach = b.successRate < t.minSuccess
        const latencyBreach = t.maxP95Ms > 0 && b.latencyP95Ms > t.maxP95Ms
        if (!successBreach && !latencyBreach) continue

        // Stale-bucket guard: skip if no new samples since the last evaluation.
        // A first observation (prev === undefined) is allowed through so the
        // initial breach still fires.
        if (prev !== undefined && prev === b.sampleCount) continue

        out.push({
            scope,
            successRate: b.successRate,
            sampleCount: b.sampleCount,
            p95Ms: b.latencyP95Ms,
        })
    }
    // Garbage-collect watermarks for scopes that no longer appear in the input
    // (bucket was aged out of router-v2 stats). Prevents unbounded growth.
    for (const k of lastSeenSampleCount.keys()) {
        if (!seenScopes.has(k)) lastSeenSampleCount.delete(k)
    }
    return out
}

/** SLO thresholds from env. PLEXO_SLO_MIN_SUCCESS=0 disables the SLO check entirely. */
export function sloThresholdsFromEnv(): SloThresholds | null {
    const minSuccess = Number(process.env.PLEXO_SLO_MIN_SUCCESS ?? 0.85)
    if (!Number.isFinite(minSuccess) || minSuccess <= 0) return null  // disabled
    const minSamples = Number(process.env.PLEXO_SLO_MIN_SAMPLES ?? 20)
    const maxP95Ms = Number(process.env.PLEXO_SLO_MAX_P95_MS ?? 0)
    return {
        minSuccess: Math.min(1, minSuccess),
        minSamples: Number.isFinite(minSamples) && minSamples > 0 ? minSamples : 20,
        maxP95Ms: Number.isFinite(maxP95Ms) && maxP95Ms > 0 ? maxP95Ms : 0,
    }
}

/** Test/introspection helper. */
export function _opsAlertBufferSizes(): { provider: number; canary: number; budget: number; slo: number } {
    return { provider: providerFailures.length, canary: canaryFailures.length, budget: budgetAlerts.length, slo: sloBreaches.length }
}

/** Aggregate provider failures into `kind/provider → count` lines. */
function summarizeProviderFailures(): string[] {
    const counts = new Map<string, number>()
    for (const f of providerFailures) {
        const key = `${f.kind} · ${f.provider}${f.taskType ? ` (${f.taskType})` : ''}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `• ${k} ×${n}`)
}

function summarizeCanaryFailures(): string[] {
    const counts = new Map<string, number>()
    for (const f of canaryFailures) {
        counts.set(f.check, (counts.get(f.check) ?? 0) + 1)
    }
    return [...counts.entries()].map(([k, n]) => `• ${k} canary FAILED ×${n}`)
}

function summarizeBudgetAlerts(): string[] {
    // One workspace can cross 80% once per week; if multiple buffered, show the
    // highest cost per workspace.
    const peak = new Map<string, BudgetAlertRecord>()
    for (const b of budgetAlerts) {
        const cur = peak.get(b.workspaceId)
        if (!cur || b.costUsd > cur.costUsd) peak.set(b.workspaceId, b)
    }
    return [...peak.values()]
        .sort((a, b) => b.costUsd - a.costUsd)
        .map((b) => `• ws ${b.workspaceId.slice(0, 8)} at $${b.costUsd.toFixed(2)} / $${b.ceilingUsd.toFixed(2)} ceiling (${Math.round((b.costUsd / b.ceilingUsd) * 100)}%)`)
}

function summarizeSloBreaches(): string[] {
    // De-dup by scope, keeping the worst (lowest success) observation.
    const worst = new Map<string, SloBreachRecord>()
    for (const s of sloBreaches) {
        const cur = worst.get(s.scope)
        if (!cur || s.successRate < cur.successRate) worst.set(s.scope, s)
    }
    return [...worst.values()]
        .sort((a, b) => a.successRate - b.successRate)
        .map((s) => `• ${s.scope}: ${Math.round(s.successRate * 100)}% success, p95 ${s.p95Ms}ms (n=${s.sampleCount})`)
}

/**
 * Batched flush. Sends one Telegram message if anything accumulated, then
 * clears the buffers. Safe to call on a cron even when nothing is configured.
 */
export async function flushOpsAlerts(): Promise<void> {
    const providerCount = providerFailures.length
    const canaryCount = canaryFailures.length
    const budgetCount = budgetAlerts.length
    const sloCount = sloBreaches.length
    if (providerCount === 0 && canaryCount === 0 && budgetCount === 0 && sloCount === 0) return

    const workspaceId = process.env.PLEXO_OPS_ALERT_WORKSPACE_ID
    const chatId = process.env.PLEXO_OPS_ALERT_CHAT_ID
    const token = workspaceId ? getChannelToken(workspaceId) : undefined

    const lines: string[] = ['⚠️ Plexo ops alert']
    if (providerCount > 0) {
        lines.push('', `Provider failures (${providerCount} in window):`, ...summarizeProviderFailures())
    }
    if (canaryCount > 0) {
        lines.push('', `Canary failures (${canaryCount} in window):`, ...summarizeCanaryFailures())
    }
    if (budgetCount > 0) {
        lines.push('', `Budget pre-ceiling (${budgetCount} in window):`, ...summarizeBudgetAlerts())
    }
    if (sloCount > 0) {
        lines.push('', `SLO breaches (${sloCount} in window):`, ...summarizeSloBreaches())
    }
    const text = lines.join('\n')

    // Clear regardless of delivery outcome — these are point-in-time alerts;
    // retaining them would compound into the next window and double-count.
    providerFailures.length = 0
    canaryFailures.length = 0
    budgetAlerts.length = 0
    sloBreaches.length = 0

    const counts = { providerCount, canaryCount, budgetCount, sloCount }
    const webhookUrl = process.env.PLEXO_OPS_ALERT_WEBHOOK_URL
    const telegramReady = Boolean(workspaceId && chatId && token)

    if (!telegramReady && !webhookUrl) {
        logger.warn(
            { ...counts, hasWorkspace: Boolean(workspaceId), hasChat: Boolean(chatId), hasToken: Boolean(token), alertText: text },
            'Ops alert accumulated but no sink is configured (Telegram trio or PLEXO_OPS_ALERT_WEBHOOK_URL) — logging only',
        )
        return
    }

    // Fan out to every configured sink independently — a failure or absence of
    // one must not suppress the other (OBS4: no single point of alert loss).
    await Promise.allSettled([
        telegramReady ? deliverTelegram(token as string, chatId as string, text, counts) : Promise.resolve(),
        webhookUrl ? deliverWebhook(webhookUrl, text, counts) : Promise.resolve(),
    ])
}

async function deliverTelegram(token: string, chatId: string, text: string, counts: Record<string, number>): Promise<void> {
    try {
        const res = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, disable_notification: false }),
        })
        if (!res.ok) logger.error({ status: res.status }, 'Ops alert Telegram delivery failed')
        else logger.info({ ...counts, sink: 'telegram' }, 'Ops alert delivered')
    } catch (err) {
        logger.error({ err }, 'Ops alert Telegram delivery threw')
    }
}

async function deliverWebhook(url: string, text: string, counts: Record<string, number>): Promise<void> {
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, ...counts }),
        })
        if (!res.ok) logger.error({ status: res.status }, 'Ops alert webhook delivery failed')
        else logger.info({ ...counts, sink: 'webhook' }, 'Ops alert delivered')
    } catch (err) {
        logger.error({ err }, 'Ops alert webhook delivery threw')
    }
}

/**
 * OBS3 boot-assert helper: true when at least one ops-alert sink is wired. The
 * boot path warns when the SLO evaluator is enabled but this returns false, so
 * breaches don't silently accrue with nowhere to go.
 */
export function opsAlertDeliveryConfigured(): boolean {
    const telegramReady = Boolean(process.env.PLEXO_OPS_ALERT_WORKSPACE_ID && process.env.PLEXO_OPS_ALERT_CHAT_ID)
    return telegramReady || Boolean(process.env.PLEXO_OPS_ALERT_WEBHOOK_URL)
}
