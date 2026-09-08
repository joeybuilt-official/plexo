// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Migrate existing vault/arbiter provider config to provider_instances table.
 *
 * Reads workspaces.settings.vault + arbiter and creates ProviderInstance rows
 * for each configured provider. Idempotent — skips workspaces that already
 * have non-managed instances.
 *
 * Still live: `GET /api/v1/workspaces/:id/providers` calls `needsMigration`
 * and runs this on first access.
 *
 * Persistence sits behind `ProviderMigrationStore`
 * (`../provider-migration.ports.js`); the drizzle adapter is
 * `../provider-migration.repository.js`.
 */

import { addProvider } from './instances.js'
import { DrizzleProviderMigrationStore } from '../provider-migration.repository.js'
import type { ProviderMigrationStore } from '../provider-migration.ports.js'
import pino from 'pino'

const logger = pino({ name: 'provider:migrate' })

// ── Composition root + test seam ───────────────────────────────────

let store: ProviderMigrationStore = new DrizzleProviderMigrationStore()

/** Swap the migration store (e.g. an in-memory fake in unit tests). */
export function setProviderMigrationStore(next: ProviderMigrationStore): void {
    store = next
}

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
        if (await store.hasUnmanagedInstances(workspaceId)) {
            return result
        }

        const legacy = await store.getLegacyProviderConfig(workspaceId)
        if (!legacy) return result

        const { vault, arbiter } = legacy
        const arbiterProviders = arbiter.providers ?? {}
        const fallbackChain = arbiter.fallbackChain ?? arbiter.fallbackOrder ?? []

        // Build ordered list of providers to migrate
        const primary = arbiter.primaryProvider ?? arbiter.primary ?? ''
        const ordered = primary ? [primary, ...fallbackChain.filter(k => k !== primary)] : fallbackChain
        const seen = new Set<string>()

        let order = 0
        for (const key of ordered) {
            if (seen.has(key)) continue
            seen.add(key)

            const vaultEntry = vault[key]
            if (!vaultEntry) continue

            const status = vaultEntry.status
            if (status === 'unconfigured' && !vaultEntry.apiKey && !vaultEntry.baseUrl) continue

            const providerConfig = arbiterProviders[key] ?? {}
            const selectedModel = providerConfig.selectedModel ?? providerConfig.defaultModel

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
                const encryptedKey = vaultEntry.apiKey

                await addProvider(workspaceId, {
                    nickname,
                    providerType: key,
                    endpointUrl: vaultEntry.baseUrl || null,
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
    return !(await store.hasAnyInstances(workspaceId))
}
