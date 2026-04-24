// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Cost-ceiling enforcement — Phase 2a of the intelligence overhaul.
 *
 * Two consumers:
 *   1. Express middleware (`enforceCostCeiling`) — gates HTTP routes that
 *      kick off model work. Returns 402 Payment Required when the workspace
 *      is at/over its hard ceiling.
 *   2. Pure helper (`evaluateCostCeiling`) — called from the executor
 *      hot path *before* a `generateText` call so we never burn one more
 *      cent past a hard ceiling. The executor turns the typed error from
 *      `assertCostCeilingOk` into the same 402 surface for the API layer.
 *
 * Soft mode emits a warning event at 80% (once per process per workspace
 * per cycle so we don't spam) and a banner-able event at 100%, but never
 * blocks. Hard mode blocks at 100%.
 *
 * The settings + spend reads both go through the existing 60s
 * intelligence-cache and the new 5min spend cache, so the hot-path cost
 * is one Map lookup in the steady state.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { db, eq } from '@plexo/db'
import { workspaces } from '@plexo/db'
import {
    getCachedIntelligenceSettings,
    type IntelligenceSettings,
} from '../lib/intelligence-cache.js'
import { getWorkspaceSpend, type WorkspaceSpend } from '../lib/intelligence-spend.js'

export type CostCeilingDecision =
    | { state: 'ok'; usagePct: number; spend: WorkspaceSpend; ceilingUsd: number | null }
    | { state: 'warn'; usagePct: number; spend: WorkspaceSpend; ceilingUsd: number; reason: 'soft_warn_80' | 'soft_warn_100' }
    | { state: 'block'; usagePct: number; spend: WorkspaceSpend; ceilingUsd: number; reason: 'hard_block_100' }

/**
 * Typed error the executor throws when a hard ceiling is hit. The API
 * layer (or the route handler that started the work) converts this to
 * an HTTP 402 with the structured payload the UI expects.
 */
export class CostCeilingExceededError extends Error {
    readonly code = 'COST_CEILING_EXCEEDED'
    readonly statusCode = 402
    constructor(
        public readonly workspaceId: string,
        public readonly ceilingUsd: number,
        public readonly spentUsd: number,
        public readonly usagePct: number,
    ) {
        super(
            `Workspace ${workspaceId} has spent $${spentUsd.toFixed(4)} of its `
            + `$${ceilingUsd.toFixed(2)} monthly ceiling (${(usagePct * 100).toFixed(0)}%). `
            + `New tasks are blocked until the ceiling is raised or next month begins.`,
        )
        this.name = 'CostCeilingExceededError'
    }
}

/**
 * Tiny per-process warning de-dupe so an executor that kicks 200 messages
 * in a minute only emits two soft-warn events (80% and 100%) per workspace,
 * not 400.
 *
 * Keys are `${workspaceId}:${threshold}`. Cleared on settings invalidation
 * via `clearWarnedWorkspace` for a given workspaceId.
 */
const WARNED = new Map<string, number>()
const WARN_DEDUPE_MS = 60 * 60 * 1000  // 1h

function shouldWarn(workspaceId: string, threshold: '80' | '100'): boolean {
    const key = `${workspaceId}:${threshold}`
    const last = WARNED.get(key) ?? 0
    if (Date.now() - last < WARN_DEDUPE_MS) return false
    WARNED.set(key, Date.now())
    return true
}

/** Clear the warning de-dupe so a fresh ceiling change re-emits banners. */
export function clearWarnedWorkspace(workspaceId: string): void {
    for (const key of Array.from(WARNED.keys())) {
        if (key.startsWith(`${workspaceId}:`)) WARNED.delete(key)
    }
}

/** Test-only — wipe the warn dedupe map. */
export function resetCostEnforcementForTests(): void {
    WARNED.clear()
}

/** Loader used by both the route middleware and the executor helper. */
async function loadIntelligenceSettings(workspaceId: string): Promise<IntelligenceSettings> {
    return getCachedIntelligenceSettings(workspaceId, async () => {
        const [row] = await db.select({ s: workspaces.intelligenceSettings })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .limit(1)
        return (row?.s ?? {}) as IntelligenceSettings
    })
}

/**
 * Pure decision function — no DB calls of its own; takes the resolved
 * settings + spend snapshot and returns what the caller should do.
 * Exposed for unit tests so we can pin the threshold logic.
 */
export function decideCostCeiling(
    settings: IntelligenceSettings,
    spend: WorkspaceSpend,
): CostCeilingDecision {
    const ceilingUsd = typeof settings.costCeilingUsd === 'number' && settings.costCeilingUsd > 0
        ? settings.costCeilingUsd
        : null
    if (!ceilingUsd) {
        return { state: 'ok', usagePct: 0, spend, ceilingUsd: null }
    }
    const usagePct = spend.pricedUsd / ceilingUsd
    const mode = settings.costCeilingMode ?? 'soft_warn'

    if (usagePct >= 1) {
        if (mode === 'hard_block') {
            return { state: 'block', usagePct, spend, ceilingUsd, reason: 'hard_block_100' }
        }
        return { state: 'warn', usagePct, spend, ceilingUsd, reason: 'soft_warn_100' }
    }
    if (usagePct >= 0.8) {
        return { state: 'warn', usagePct, spend, ceilingUsd, reason: 'soft_warn_80' }
    }
    return { state: 'ok', usagePct, spend, ceilingUsd }
}

/**
 * Resolve a fresh decision for a workspace by reading both caches.
 * The executor calls this; routes wrap it in the middleware below.
 */
export async function evaluateCostCeiling(workspaceId: string): Promise<CostCeilingDecision> {
    const [settings, spend] = await Promise.all([
        loadIntelligenceSettings(workspaceId),
        getWorkspaceSpend(workspaceId),
    ])
    return decideCostCeiling(settings, spend)
}

/**
 * Executor-facing helper. Throws CostCeilingExceededError on hard block,
 * returns the decision otherwise (so callers can also surface soft-warn
 * events).
 *
 * Soft-warn dedupe is built in — call sites don't need to track it.
 */
export async function assertCostCeilingOk(
    workspaceId: string,
    onWarn?: (decision: Extract<CostCeilingDecision, { state: 'warn' }>) => void,
): Promise<CostCeilingDecision> {
    const decision = await evaluateCostCeiling(workspaceId)
    if (decision.state === 'block') {
        throw new CostCeilingExceededError(
            workspaceId,
            decision.ceilingUsd,
            decision.spend.pricedUsd,
            decision.usagePct,
        )
    }
    if (decision.state === 'warn') {
        const threshold = decision.reason === 'soft_warn_100' ? '100' : '80'
        if (shouldWarn(workspaceId, threshold)) {
            try { onWarn?.(decision) } catch { /* warn callbacks must never throw */ }
        }
    }
    return decision
}

/**
 * Express middleware variant. Mount AFTER `requireWorkspaceMember` so
 * `req.workspaceId` is populated. Returns 402 on hard block; otherwise
 * lets the request through and stashes the decision on `req` for
 * downstream handlers that want to add the warn banner to their response.
 */
export function enforceCostCeiling(): RequestHandler {
    return async function enforceCostCeilingHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
        const workspaceId = req.workspaceId
        if (!workspaceId) {
            // No workspace resolved (probably misconfigured route order) —
            // fail open rather than 500. The membership middleware would
            // have already 400'd if the route really requires a workspace.
            next()
            return
        }
        try {
            const decision = await evaluateCostCeiling(workspaceId)
            ;(req as Request & { costCeiling?: CostCeilingDecision }).costCeiling = decision
            if (decision.state === 'block') {
                res.status(402).json({
                    error: {
                        code: 'COST_CEILING_EXCEEDED',
                        message: `Monthly cost ceiling reached ($${decision.ceilingUsd.toFixed(2)}). Raise the limit in Settings → Intelligence or wait until next month.`,
                        spentUsd: decision.spend.pricedUsd,
                        ceilingUsd: decision.ceilingUsd,
                        usagePct: decision.usagePct,
                    },
                })
                return
            }
            if (decision.state === 'warn') {
                res.setHeader('X-Plexo-Cost-Warn', decision.reason)
            }
            next()
        } catch (err) {
            // Never block on enforcement failure — log and fail open. The
            // executor still has its own gate so a hard ceiling is never
            // bypassed by a transient DB hiccup here.
            const log = (req as Request & { log?: { warn?: (obj: unknown, msg?: string) => void } }).log
            log?.warn?.({ err }, 'cost ceiling middleware failed open')
            next()
        }
    }
}
