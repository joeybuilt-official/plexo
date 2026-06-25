// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Migrate existing vault/arbiter provider config to provider_instances table.
 *
 * Reads workspaces.settings.vault + arbiter and creates ProviderInstance rows
 * for each configured provider. Idempotent — skips workspaces that already
 * have non-managed instances.
 */

import { eq, sql } from 'drizzle-orm'
import { db } from '@plexo/db'
import { workspaces } from '@plexo/db'
import { addProvider } from './instances.js'
import pino from 'pino'

const logger = pino({ name: 'provider:migrate' })

export interface MigrationResult {
    workspaceId: string
    migratedProviders: string[]
    errors: string[]
}

/**
 * Migrate a single workspace's vault/arbiter to provider_instances.
 * Idempotent — skips if non-managed instances already exist.
 */
export async function migrateWorkspaceProviders(workspaceId: string): Promise<MigrationResult> {
    const result: MigrationResult = { workspaceId, migratedProviders: [], errors: [] }

    try {
        // Check if already migrated (has non-managed instances)
        const [countRow] = await db.execute<{ count: string }>(sql`
            SELECT COUNT(*) AS count FROM provider_instances
            WHERE workspace_id = ${workspaceId}::uuid AND managed = false
        `)
        if (Number(countRow?.count ?? 0) > 0) {
            return result
        }

        // Load vault/arbiter from workspace settings
        const [ws] = await db.select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .limit(1)

        const settings = ws?.settings as Record<string, unknown> | null
        if (!settings) return result

        const vault = (settings.vault ?? {}) as Record<string, Record<string, unknown>>
        const arbiter = (settings.arbiter ?? {}) as Record<string, unknown>
        const arbiterProviders = (arbiter.providers ?? {}) as Record<string, Record<string, unknown>>
        const fallbackChain = ((arbiter.fallbackChain ?? arbiter.fallbackOrder ?? []) as string[])

        // Build ordered list of providers to migrate
        const primary = (arbiter.primaryProvider ?? arbiter.primary ?? '') as string
        const ordered = primary ? [primary, ...fallbackChain.filter(k => k !== primary)] : fallbackChain
        const seen = new Set<string>()

        let order = 0
        for (const key of ordered) {
            if (seen.has(key)) continue
            seen.add(key)

            const vaultEntry = vault[key]
            if (!vaultEntry) continue

            const status = vaultEntry.status as string | undefined
            if (status === 'unconfigured' && !vaultEntry.apiKey && !vaultEntry.baseUrl) continue

            const providerConfig = arbiterProviders[key] ?? {}
            const selectedModel = (providerConfig.selectedModel ?? providerConfig.defaultModel) as string | undefined

            // Determine nickname
            const nicknames: Record<string, string> = {
                anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google Gemini',
                groq: 'Groq', mistral: 'Mistral', deepseek: 'DeepSeek', xai: 'xAI',
                openrouter: 'OpenRouter', ollama: 'Ollama', ollama_cloud: 'Ollama Cloud',
            }
            const nickname = nicknames[key] ?? key

            try {
                // Encrypt key for the new table (it's already encrypted in vault, but with old format)
                // We store the encrypted key as-is since it uses the same workspace-scoped encryption
                const encryptedKey = vaultEntry.apiKey as string | undefined

                await addProvider(workspaceId, {
                    nickname,
                    providerType: key,
                    endpointUrl: (vaultEntry.baseUrl as string) || null,
                    encryptedKey: encryptedKey || null,
                    selectedModel: selectedModel || null,
                })

                result.migratedProviders.push(key)
                order++
            } catch (err) {
                result.errors.push(`Failed to migrate ${key}: ${err instanceof Error ? err.message : String(err)}`)
                logger.warn({ err, workspaceId, provider: key }, 'Failed to migrate provider')
            }
        }

        logger.info({
            workspaceId,
            migrated: result.migratedProviders,
            errors: result.errors.length,
        }, 'Provider migration complete')

    } catch (err) {
        result.errors.push(`Migration failed: ${err instanceof Error ? err.message : String(err)}`)
        logger.error({ err, workspaceId }, 'Provider migration failed')
    }

    return result
}

/**
 * Check if a workspace needs migration.
 */
export async function needsMigration(workspaceId: string): Promise<boolean> {
    const [countRow] = await db.execute<{ count: string }>(sql`
        SELECT COUNT(*) AS count FROM provider_instances
        WHERE workspace_id = ${workspaceId}::uuid
    `)
    return Number(countRow?.count ?? 0) === 0
}
