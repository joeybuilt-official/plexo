// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Build WorkspaceAISettings from provider_instances table.
 *
 * This is the canonical routing path. Reads provider_instances,
 * decrypts API keys, and produces a WorkspaceAISettings object
 * that the LLM and embedding routers consume.
 */

import { db, eq, asc } from '@plexo/db'
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

// ── Main function ────────────────────────────────────────────────────────────

/**
 * Load WorkspaceAISettings from provider_instances table.
 * Returns null if no instances exist (not yet migrated).
 */
export async function loadSettingsFromInstances(workspaceId: string): Promise<WorkspaceAISettings | null> {
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
