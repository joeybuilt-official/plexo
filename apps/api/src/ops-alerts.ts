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

const providerFailures: ProviderFailureRecord[] = []
const canaryFailures: CanaryFailureRecord[] = []

export function recordProviderFailureForAlert(rec: Omit<ProviderFailureRecord, 'at'>): void {
    if (providerFailures.length >= MAX_BUFFER) providerFailures.shift()
    providerFailures.push({ ...rec, at: Date.now() })
}

export function recordCanaryFailureForAlert(rec: Omit<CanaryFailureRecord, 'at'>): void {
    if (canaryFailures.length >= MAX_BUFFER) canaryFailures.shift()
    canaryFailures.push({ ...rec, at: Date.now() })
}

/** Test/introspection helper. */
export function _opsAlertBufferSizes(): { provider: number; canary: number } {
    return { provider: providerFailures.length, canary: canaryFailures.length }
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

/**
 * Batched flush. Sends one Telegram message if anything accumulated, then
 * clears the buffers. Safe to call on a cron even when nothing is configured.
 */
export async function flushOpsAlerts(): Promise<void> {
    const providerCount = providerFailures.length
    const canaryCount = canaryFailures.length
    if (providerCount === 0 && canaryCount === 0) return

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
    const text = lines.join('\n')

    // Clear regardless of delivery outcome — these are point-in-time alerts;
    // retaining them would compound into the next window and double-count.
    providerFailures.length = 0
    canaryFailures.length = 0

    if (!workspaceId || !chatId || !token) {
        logger.warn(
            { providerCount, canaryCount, hasWorkspace: Boolean(workspaceId), hasChat: Boolean(chatId), hasToken: Boolean(token) },
            'Ops alert accumulated but delivery is not configured (PLEXO_OPS_ALERT_WORKSPACE_ID / PLEXO_OPS_ALERT_CHAT_ID / registered bot token) — logging only',
        )
        return
    }

    try {
        const res = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, disable_notification: false }),
        })
        if (!res.ok) {
            logger.error({ status: res.status }, 'Ops alert Telegram delivery failed')
        } else {
            logger.info({ providerCount, canaryCount }, 'Ops alert delivered')
        }
    } catch (err) {
        logger.error({ err }, 'Ops alert Telegram delivery threw')
    }
}
