// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Executor-side cost gate — Phase 2a of the intelligence overhaul.
 *
 * The executor lives in `@plexo/agent` and cannot import from `apps/api`,
 * so it gets its own minimal copy of the workspace cost ceiling check.
 * The express middleware in `apps/api/middleware/cost-enforcement.ts`
 * uses the same SQL but is not shared via package boundary because that
 * would invert the dep direction.
 *
 * Spend tracking uses Redis atomic INCRBYFLOAT (SEC-034) so concurrent
 * tasks across processes see a single consistent counter. Falls back to
 * in-process cache if Redis is unavailable.
 */

import pino from 'pino'
import { DrizzleCostGateRepository } from './cost-gate.repository.js'
import type { CostGateRepository, AgentIntelligenceSettings } from './cost-gate.ports.js'

const logger = pino({ name: 'cost-gate' })

// Re-export for consumers that import the settings type from this module.
export type { AgentIntelligenceSettings } from './cost-gate.ports.js'

// ── Composition root + test seam ────────────────────────────────────────────
let repo: CostGateRepository = new DrizzleCostGateRepository()

/** Swap the persistence adapter (e.g. an in-memory fake in unit tests). */
export function setCostGateRepository(next: CostGateRepository): void {
    repo = next
}

export interface AgentSpendSnapshot {
    pricedUsd: number
    inputTokens: number
    outputTokens: number
    requests: number
    monthStart: string
    computedAt: string
}

export type AgentCostDecision =
    | { state: 'ok'; usagePct: number; ceilingUsd: number | null; spend: AgentSpendSnapshot }
    | { state: 'warn'; usagePct: number; ceilingUsd: number; spend: AgentSpendSnapshot; reason: 'soft_warn_80' | 'soft_warn_100' }
    | { state: 'block'; usagePct: number; ceilingUsd: number; spend: AgentSpendSnapshot; reason: 'hard_block_100' }

/** Typed error the executor throws when a hard ceiling is hit. */
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
            `Monthly AI spend limit reached: $${spentUsd.toFixed(2)} of $${ceilingUsd.toFixed(2)} used `
            + `(${(usagePct * 100).toFixed(0)}%). New tasks are paused until the ceiling is raised `
            + `in Settings → Intelligence, or until next month begins.`,
        )
        this.name = 'CostCeilingExceededError'
    }
}

// ── Redis client (lazy singleton, same pattern as memory/store.ts) ───────

/* eslint-disable @typescript-eslint/no-explicit-any */
let _redis: any = null
let _redisFailed = false

async function getRedis(): Promise<any | null> {
    if (_redis) return _redis
    if (_redisFailed) return null
    try {
        const { createClient } = await import('redis')
        const client = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' })
        await client.connect()
        _redis = client
        return _redis
    } catch (redisErr) {
        logger.warn({ err: redisErr }, 'Redis connection failed — cost ceiling enforcement will use DB fallback')
        _redisFailed = true
        return null
    }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Redis key: `plexo:spend:{workspaceId}:{YYYY-MM}` */
function spendRedisKey(workspaceId: string): string {
    const now = new Date()
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
    return `plexo:spend:${workspaceId}:${ym}`
}

/** 35 days in seconds — covers month boundary. */
const SPEND_KEY_TTL_SEC = 35 * 24 * 60 * 60

// ── Caches ────────────────────────────────────────────────────────────────

interface SettingsEntry { value: AgentIntelligenceSettings; expiresAt: number }
interface SpendEntry { value: AgentSpendSnapshot; expiresAt: number }

const SETTINGS_TTL_MS = 60_000
const SPEND_TTL_MS = 5 * 60 * 1000

const settingsCache = new Map<string, SettingsEntry>()
const spendCache = new Map<string, SpendEntry>()

export function invalidateAgentSettings(workspaceId: string): void {
    settingsCache.delete(workspaceId)
}
export function invalidateAgentSpend(workspaceId: string): void {
    spendCache.delete(workspaceId)
}
export function resetCostGateForTests(): void {
    settingsCache.clear()
    spendCache.clear()
    WARNED.clear()
    _redis = null
    _redisFailed = false
}

// ── Loaders ───────────────────────────────────────────────────────────────

async function loadSettings(workspaceId: string): Promise<AgentIntelligenceSettings> {
    const hit = settingsCache.get(workspaceId)
    if (hit && hit.expiresAt > Date.now()) return hit.value
    let value: AgentIntelligenceSettings = {}
    try {
        value = await repo.getIntelligenceSettings(workspaceId)
    } catch (err) {
        logger.warn({ err, workspaceId }, 'settings query failed')
        value = {}
    }
    settingsCache.set(workspaceId, { value, expiresAt: Date.now() + SETTINGS_TTL_MS })
    return value
}

function monthStartUtc(): Date {
    const now = new Date()
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))
}

async function loadSpend(workspaceId: string): Promise<AgentSpendSnapshot> {
    const hit = spendCache.get(workspaceId)
    if (hit && hit.expiresAt > Date.now()) return hit.value

    const start = monthStartUtc()
    let snapshot: AgentSpendSnapshot = {
        pricedUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        requests: 0,
        monthStart: start.toISOString(),
        computedAt: new Date().toISOString(),
    }

    // Try Redis first — atomic counter is the source of truth for pricedUsd
    const redis = await getRedis()
    if (redis) {
        try {
            const key = spendRedisKey(workspaceId)
            const cached = await redis.get(key)
            if (cached !== null) {
                // Redis has the running total. We still need token counts from DB
                // but cost (the gating field) comes from the atomic counter.
                snapshot.pricedUsd = parseFloat(cached) || 0
                snapshot.computedAt = new Date().toISOString()

                // Best-effort: load token counts from DB for reporting only
                try {
                    const counts = await repo.getTokenCounts(workspaceId, start.toISOString())
                    snapshot.inputTokens = counts.inputTokens
                    snapshot.outputTokens = counts.outputTokens
                    snapshot.requests = counts.requests
                } catch (err) {
                    logger.warn({ err, workspaceId }, 'token count query failed')
                }

                spendCache.set(workspaceId, { value: snapshot, expiresAt: Date.now() + SPEND_TTL_MS })
                return snapshot
            }
            // Key doesn't exist yet — fall through to DB to seed it
        } catch (err) {
            logger.warn({ err, workspaceId }, 'Redis spend read failed')
        }
    }

    // Fallback: full DB query (original path)
    try {
        const full = await repo.getFullSpend(workspaceId, start.toISOString())
        snapshot = {
            pricedUsd: full.pricedUsd,
            inputTokens: full.inputTokens,
            outputTokens: full.outputTokens,
            requests: full.requests,
            monthStart: start.toISOString(),
            computedAt: new Date().toISOString(),
        }

        // Seed Redis with the DB-computed total so subsequent increments are atomic
        if (redis) {
            try {
                const key = spendRedisKey(workspaceId)
                await redis.set(key, snapshot.pricedUsd.toString())
                await redis.expire(key, SPEND_KEY_TTL_SEC)
            } catch (err) {
                logger.warn({ err, workspaceId }, 'Redis spend seed failed (non-fatal)')
            }
        }
    } catch (err) {
        logger.warn({ err, workspaceId }, 'DB spend query failed')
    }
    spendCache.set(workspaceId, { value: snapshot, expiresAt: Date.now() + SPEND_TTL_MS })
    return snapshot
}

/**
 * Record task cost atomically. Call this after each completed inference.
 * Uses Redis INCRBYFLOAT for cross-process consistency; also invalidates
 * the in-process cache so the next ceiling check sees the new total.
 */
export async function recordSpend(workspaceId: string, costUsd: number): Promise<void> {
    if (costUsd <= 0) return

    // Invalidate in-process cache so next check re-reads
    spendCache.delete(workspaceId)

    const redis = await getRedis()
    if (!redis) return // No Redis — loadSpend will recompute from DB next time

    try {
        const key = spendRedisKey(workspaceId)
        const exists = await redis.exists(key)
        await redis.incrByFloat(key, costUsd)
        // Set TTL only on first creation
        if (!exists) {
            await redis.expire(key, SPEND_KEY_TTL_SEC)
        }
    } catch {
        // Non-fatal — next loadSpend will recompute from DB
    }
}

// ── Decision logic ────────────────────────────────────────────────────────

/** Pure decision function — exposed for tests. */
export function decideAgentCost(
    settings: AgentIntelligenceSettings,
    spend: AgentSpendSnapshot,
): AgentCostDecision {
    const ceilingUsd = typeof settings.costCeilingUsd === 'number' && settings.costCeilingUsd > 0
        ? settings.costCeilingUsd
        : null
    if (!ceilingUsd) {
        return { state: 'ok', usagePct: 0, ceilingUsd: null, spend }
    }
    const usagePct = spend.pricedUsd / ceilingUsd
    const mode = settings.costCeilingMode ?? 'soft_warn'
    // 'off' = trust provider-level caps; never warn or block in the executor mid-run gate.
    if (mode === 'off') {
        return { state: 'ok', usagePct, ceilingUsd, spend }
    }
    if (usagePct >= 1) {
        if (mode === 'hard_block') {
            return { state: 'block', usagePct, ceilingUsd, spend, reason: 'hard_block_100' }
        }
        return { state: 'warn', usagePct, ceilingUsd, spend, reason: 'soft_warn_100' }
    }
    if (usagePct >= 0.8) {
        return { state: 'warn', usagePct, ceilingUsd, spend, reason: 'soft_warn_80' }
    }
    return { state: 'ok', usagePct, ceilingUsd, spend }
}

const WARNED = new Map<string, number>()
const WARN_DEDUPE_MS = 60 * 60 * 1000

function shouldWarn(workspaceId: string, threshold: '80' | '100'): boolean {
    const key = `${workspaceId}:${threshold}`
    const last = WARNED.get(key) ?? 0
    if (Date.now() - last < WARN_DEDUPE_MS) return false
    WARNED.set(key, Date.now())
    return true
}

/**
 * Evaluate the workspace's current cost state. The executor calls this
 * once at the start of each task.
 */
export async function evaluateAgentCostCeiling(workspaceId: string): Promise<AgentCostDecision> {
    const [settings, spend] = await Promise.all([
        loadSettings(workspaceId),
        loadSpend(workspaceId),
    ])
    return decideAgentCost(settings, spend)
}

/**
 * Throw on hard block; return the decision otherwise. The optional
 * `onWarn` callback fires once per workspace per threshold per hour
 * so the executor can emit a UI event without spamming.
 */
export async function assertAgentCostCeilingOk(
    workspaceId: string,
    onWarn?: (decision: Extract<AgentCostDecision, { state: 'warn' }>) => void,
): Promise<AgentCostDecision> {
    const decision = await evaluateAgentCostCeiling(workspaceId)
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
