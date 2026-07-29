// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Build WorkspaceAISettings from provider_instances table.
 *
 * This is the canonical routing path. Reads provider_instances,
 * decrypts API keys, and produces a WorkspaceAISettings object
 * that the LLM and embedding routers consume.
 */

import { eq, and, asc, isNull, isNotNull } from 'drizzle-orm'
import { db } from '@plexo/db'
import { providerInstances, workspaces } from '@plexo/db'
import type { WorkspaceAISettings, ProviderKey, AIProviderConfig } from './registry.js'
import { createHmac, createDecipheriv } from 'crypto'
import pino from 'pino'

const logger = pino({ name: 'provider:settings' })

// ── Inline decryption (same algorithm as apps/api/src/crypto.ts) ─────────

function fromB64url(s: string): Buffer {
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

function decryptKey(token: string, workspaceId: string): string | null {
    const secret = process.env.ENCRYPTION_SECRET
    if (!secret) return null

    try {
        // Strip the enc: prefix; also accept legacy tokens without it
        const raw = token.startsWith('enc:') ? token.slice(4) : token
        const parts = raw.split('.')
        if (parts.length !== 3) return token // not encrypted, return as-is

        const [ivStr, ciphertextStr, authTagStr] = parts
        const key = createHmac('sha256', secret).update(workspaceId).digest()
        const decipher = createDecipheriv('aes-256-gcm', key, fromB64url(ivStr!))
        decipher.setAuthTag(fromB64url(authTagStr!))
        return Buffer.concat([
            decipher.update(fromB64url(ciphertextStr!)),
            decipher.final(),
        ]).toString('utf8')
    } catch {
        return null
    }
}

// ── Short-TTL cache (Round-4 Phase 6) ─────────────────────────────────────────
// loadSettingsFromInstances sits on the inference hot path (every proxy call +
// every agent-loop credential walk). Pre-cache it was hit ~30×/min for a single
// workspace, each time costing 2 DB queries + per-row AES-GCM decrypt. Provider
// config changes ~daily, so a short TTL collapses that to ~1 load per window.
// PLEXO_SETTINGS_CACHE_TTL_MS=0 disables (today's behavior). The canonical
// provider CRUD layer (instances.ts) calls invalidateSettingsCache on writes for
// prompt freshness; other rare writers (judgeModel, capability refresh) rely on
// ≤TTL eventual consistency.
const SETTINGS_CACHE_TTL_MS = (() => {
    const raw = process.env.PLEXO_SETTINGS_CACHE_TTL_MS
    if (raw === undefined) return 30_000
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : 30_000
})()

interface SettingsCacheEntry {
    value: WorkspaceAISettings | null
    expiresAt: number
}
const settingsCache = new Map<string, SettingsCacheEntry>()

/** Drop cached settings for a workspace (or all workspaces when omitted). */
export function invalidateSettingsCache(workspaceId?: string): void {
    if (workspaceId) settingsCache.delete(workspaceId)
    else settingsCache.clear()
}

// ── Provider balance-exhaustion state (Fix A) ─────────────────────────────────

export interface BalanceExhaustedProvider {
    providerType: string
    nickname: string
    exhaustedAt: Date
}

/**
 * Mark every enabled instance of `providerType` in a workspace as balance-
 * exhausted (funds-depleted). Idempotent: only sets the timestamp on rows where
 * it's still NULL, so the "first seen" time is preserved across repeated
 * failures. Fire-and-forget from the router failure path — never throws.
 */
export async function markProviderBalanceExhausted(workspaceId: string, providerType: string): Promise<void> {
    try {
        const res = await db.update(providerInstances)
            .set({ balanceExhaustedAt: new Date() })
            .where(and(
                eq(providerInstances.workspaceId, workspaceId),
                eq(providerInstances.providerType, providerType),
                isNull(providerInstances.balanceExhaustedAt),
            ))
            .returning({ id: providerInstances.id })
        if (res.length > 0) {
            invalidateSettingsCache(workspaceId)
            logger.warn({ workspaceId, providerType, marked: res.length }, 'provider marked balance-exhausted — pulled from routing chain')
        }
    } catch (err) {
        logger.warn({ workspaceId, providerType, err: err instanceof Error ? err.message : String(err) }, 'markProviderBalanceExhausted failed (non-fatal)')
    }
}

/** Clear the balance-exhausted flag for a provider (operator dismissal → re-arm). */
export async function clearProviderBalanceExhausted(workspaceId: string, providerType: string): Promise<void> {
    await db.update(providerInstances)
        .set({ balanceExhaustedAt: null })
        .where(and(
            eq(providerInstances.workspaceId, workspaceId),
            eq(providerInstances.providerType, providerType),
        ))
    invalidateSettingsCache(workspaceId)
}

/** List the workspace's currently balance-exhausted providers (for the site-wide notice). */
export async function listBalanceExhaustedProviders(workspaceId: string): Promise<BalanceExhaustedProvider[]> {
    const rows = await db.select({
        providerType: providerInstances.providerType,
        nickname: providerInstances.nickname,
        exhaustedAt: providerInstances.balanceExhaustedAt,
    })
        .from(providerInstances)
        .where(and(
            eq(providerInstances.workspaceId, workspaceId),
            isNotNull(providerInstances.balanceExhaustedAt),
        ))
    const out: BalanceExhaustedProvider[] = []
    const seen = new Set<string>()
    for (const r of rows) {
        if (!r.exhaustedAt || seen.has(r.providerType)) continue
        seen.add(r.providerType)
        out.push({ providerType: r.providerType, nickname: r.nickname, exhaustedAt: r.exhaustedAt })
    }
    return out
}

// ── Main function ────────────────────────────────────────────────────────────

/**
 * Load WorkspaceAISettings from provider_instances table (short-TTL cached).
 * Returns null if no instances exist (not yet migrated).
 */
export async function loadSettingsFromInstances(workspaceId: string): Promise<WorkspaceAISettings | null> {
    if (SETTINGS_CACHE_TTL_MS > 0) {
        const hit = settingsCache.get(workspaceId)
        if (hit && hit.expiresAt > Date.now()) return hit.value
    }
    const value = await loadSettingsFromInstancesUncached(workspaceId)
    if (SETTINGS_CACHE_TTL_MS > 0) {
        settingsCache.set(workspaceId, { value, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS })
    }
    return value
}

/** Uncached read — DB + decrypt every call. Use loadSettingsFromInstances. */
async function loadSettingsFromInstancesUncached(workspaceId: string): Promise<WorkspaceAISettings | null> {
    const rows = await db.select()
        .from(providerInstances)
        .where(eq(providerInstances.workspaceId, workspaceId))
        .orderBy(asc(providerInstances.preferenceOrder))

    if (rows.length === 0) return null

    const providers: Partial<Record<ProviderKey, AIProviderConfig>> = {}
    const chain: ProviderKey[] = []
    let primaryProvider: ProviderKey | null = null

    for (const row of rows) {
        if (!row.enabled) continue
        // Funds-depleted instances are pulled from the routing chain entirely so
        // they stop wasting a cascade slot + latency on a dead provider. Cleared
        // on operator dismissal of the site-wide notice (Fix A).
        if (row.balanceExhaustedAt) continue

        const key = row.providerType as ProviderKey

        // Decrypt API key if present
        let apiKey: string | undefined
        if (row.encryptedKey) {
            const decrypted = decryptKey(row.encryptedKey, workspaceId)
            if (decrypted) apiKey = decrypted
        }

        // Resolve managed Ollama endpoint
        let baseUrl = row.endpointUrl ?? undefined
        if (row.managed && !baseUrl) {
            baseUrl = process.env.OLLAMA_INTERNAL_URL || undefined
        }

        const existing = providers[key]
        if (existing && baseUrl && baseUrl !== existing.baseUrl) {
            // A SECOND instance of an already-claimed provider type with its own
            // endpoint (e.g. another self-hosted Ollama server). Don't collapse
            // both into one type-keyed slot — give it an instance-scoped
            // custom key so every configured server participates in the
            // fallback chain independently. buildModel's `custom_*` branch
            // serves it via its OpenAI-compatible /v1 endpoint (Ollama and
            // LM Studio both expose one).
            const caps = row.capabilities as { chatModels?: string[] } | null
            const instanceKey = `custom_${key}_${row.id.slice(0, 8)}` as ProviderKey
            providers[instanceKey] = {
                provider: instanceKey,
                apiKey,
                baseUrl,
                // Never let this fall through to DEFAULT_MODEL_ROUTING (a
                // Claude id) — pin the instance's selected or first
                // discovered model.
                model: row.selectedModel ?? caps?.chatModels?.[0] ?? undefined,
                enabled: true,
                displayName: row.nickname,
                capabilities: (row.capabilities as Record<string, unknown>) ?? undefined,
            } as AIProviderConfig
            chain.push(instanceKey)
            if (!primaryProvider) primaryProvider = instanceKey
            continue
        }
        // Don't overwrite a provider that already has a key or URL with one that doesn't.
        // This handles the case where a user-configured Ollama (with URL) coexists with
        // the managed Plexo Built-in AI (without URL) — the user's config should win.
        if (existing && !apiKey && !baseUrl && (existing.apiKey || existing.baseUrl)) {
            // Keep existing, just ensure it stays in the chain
        } else {
            providers[key] = {
                provider: key,
                apiKey: apiKey ?? existing?.apiKey,
                baseUrl: baseUrl ?? existing?.baseUrl,
                model: row.selectedModel ?? existing?.model ?? undefined,
                enabled: true,
                // Pass through discovered capabilities so vision model finder
                // can check all available models, not just the selected one.
                capabilities: (row.capabilities as Record<string, unknown>) ?? undefined,
            } as AIProviderConfig
        }

        chain.push(key)
        if (!primaryProvider) primaryProvider = key
    }

    if (!primaryProvider) return null

    // Workspace-level overrides stored in workspaces.intelligence_settings.
    // Currently we read `judgeModel` (pinned model for the quality judge).
    let judgeModel: WorkspaceAISettings['judgeModel'] | undefined
    try {
        const wsRow = await db.select({ intelligenceSettings: workspaces.intelligenceSettings })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .limit(1)
        const intel = (wsRow[0]?.intelligenceSettings ?? {}) as Record<string, unknown>
        const j = intel.judgeModel as { provider?: string; model?: string } | undefined
        if (j?.provider && j.model) {
            judgeModel = { provider: j.provider as ProviderKey, model: j.model }
        }
    } catch (err) {
        logger.warn({ workspaceId, err: err instanceof Error ? err.message : String(err) }, 'failed to load intelligence_settings.judgeModel')
    }

    logger.info({
        workspaceId,
        primary: primaryProvider,
        chain,
        instanceCount: rows.length,
        judgeModel: judgeModel ? `${judgeModel.provider}/${judgeModel.model}` : null,
    }, 'AI settings loaded from provider_instances')

    return {
        primaryProvider,
        fallbackChain: chain.filter(k => k !== primaryProvider),
        providers,
        ...(judgeModel ? { judgeModel } : {}),
    }
}
