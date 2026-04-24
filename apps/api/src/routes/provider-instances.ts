// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * API routes for provider instances (Intelligence page).
 *
 * GET  /api/v1/workspaces/:id/providers          — list all provider instances
 * POST /api/v1/workspaces/:id/providers/refresh   — refresh capabilities for all instances
 */

import { Router } from 'express'
import pino from 'pino'

const logger = pino({ name: 'provider-instances' })
const router: import('express').Router = Router({ mergeParams: true })

// GET /api/v1/workspaces/:id/providers
router.get('/', async (req: any, res: any) => {
    const workspaceId = req.params.id as string
    if (!workspaceId) return res.status(400).json({ error: 'workspace ID required' })

    try {
        const { listProviders, seedManagedProvider } = await import('@plexo/agent/providers/instances')
        const { needsMigration, migrateWorkspaceProviders } = await import('@plexo/agent/providers/migrate-to-instances')

        // Auto-migrate from vault/arbiter on first access (idempotent)
        if (await needsMigration(workspaceId)) {
            const result = await migrateWorkspaceProviders(workspaceId)
            logger.info({ workspaceId, migrated: result.migratedProviders, errors: result.errors.length }, 'intelligence.migration.completed')
        }

        // Ensure managed provider exists (idempotent)
        await seedManagedProvider(workspaceId)

        const providers = await listProviders(workspaceId)

        // Auto-refresh stale capabilities (older than 1 hour) in the background.
        // This ensures model lists stay current without requiring manual refresh.
        const ONE_HOUR = 60 * 60 * 1000
        const stale = providers.filter(p =>
            p.encryptedKey && (!p.lastDiscoveredAt || Date.now() - new Date(p.lastDiscoveredAt).getTime() > ONE_HOUR)
        )
        if (stale.length > 0) {
            const { refreshInstanceCapabilities } = await import('@plexo/agent/providers/instances')
            // Fire-and-forget — don't block the response
            Promise.allSettled(stale.map(p => refreshInstanceCapabilities(p.id))).catch(() => {})
        }

        // Redact encrypted keys for the response
        const safe = providers.map(p => ({
            ...p,
            encryptedKey: p.encryptedKey ? '__configured__' : null,
        }))

        return res.json({ providers: safe })
    } catch (err) {
        logger.error({ err, workspaceId }, 'Failed to list provider instances')
        return res.status(500).json({ error: 'Failed to load providers' })
    }
})

// POST /api/v1/workspaces/:id/providers/refresh
router.post('/refresh', async (req: any, res: any) => {
    const workspaceId = req.params.id as string
    if (!workspaceId) return res.status(400).json({ error: 'workspace ID required' })

    try {
        const { refreshWorkspaceCapabilities } = await import('@plexo/agent/providers/instances')
        await refreshWorkspaceCapabilities(workspaceId)
        return res.json({ ok: true })
    } catch (err) {
        logger.warn({ err, workspaceId }, 'Capability refresh failed')
        return res.status(500).json({ error: 'Refresh failed' })
    }
})

// POST /api/v1/workspaces/:id/providers — add a new provider instance
router.post('/', async (req: any, res: any) => {
    const workspaceId = req.params.id as string
    const { nickname, providerType, endpointUrl, apiKey } = req.body as {
        nickname?: string
        providerType?: string
        endpointUrl?: string
        apiKey?: string
    }

    if (!nickname || !providerType) {
        return res.status(400).json({ error: 'nickname and providerType required' })
    }

    // Whitelist check — reject unknown provider keys up front so they can't
    // be silently persisted and then blow up on first use.
    try {
        const { isKnownProviderKey } = await import('@plexo/agent/providers/registry')
        if (!isKnownProviderKey(providerType)) {
            return res.status(400).json({ error: `Unknown provider: ${providerType}` })
        }
    } catch {
        // If the registry import fails, fall through — the later code paths
        // will still fail loudly rather than pretend things worked.
    }

    try {
        // Duplicate detection
        const { listProviders, addProvider } = await import('@plexo/agent/providers/instances')
        const existing = await listProviders(workspaceId)

        // Cloud provider: same type = duplicate
        if (!endpointUrl && existing.some(p => p.providerType === providerType && !p.managed)) {
            return res.status(409).json({ error: 'This provider is already added. You can edit the existing one instead.' })
        }

        // Own server: same endpoint URL = duplicate
        if (endpointUrl) {
            const normalized = endpointUrl.replace(/\/+$/, '').toLowerCase()
            if (existing.some(p => p.endpointUrl?.replace(/\/+$/, '').toLowerCase() === normalized)) {
                return res.status(409).json({ error: 'A provider with this server address is already added.' })
            }
        }

        // Encrypt API key if provided
        let encryptedKey: string | null = null
        if (apiKey) {
            const { encrypt } = await import('../crypto.js')
            encryptedKey = encrypt(apiKey, workspaceId)
        }

        const instance = await addProvider(workspaceId, {
            nickname,
            providerType,
            endpointUrl: endpointUrl || null,
            encryptedKey,
        })

        // FUN-025: Validate the key immediately after save via a lightweight test.
        // Key is still saved even if validation fails — user gets a warning.
        let keyWarning: string | undefined
        if (apiKey) {
            try {
                const { testProvider } = await import('@plexo/agent/providers/registry')
                const testResult = await testProvider(providerType as any, { apiKey, baseUrl: endpointUrl }, 8_000)
                if (!testResult.ok) {
                    keyWarning = `Key saved, but connection test failed: ${testResult.message}`
                    logger.warn({ workspaceId, providerType, message: testResult.message }, 'FUN-025: BYOK key validation failed on save')
                }
            } catch (testErr) {
                keyWarning = 'Key saved, but we could not verify it. It may still work.'
                logger.warn({ testErr, workspaceId, providerType }, 'FUN-025: BYOK key validation threw on save')
            }
        }

        return res.json({
            ok: true,
            provider: { ...instance, encryptedKey: instance.encryptedKey ? '__configured__' : null },
            ...(keyWarning ? { warning: keyWarning } : {}),
        })
    } catch (err) {
        logger.error({ err, workspaceId, providerType }, 'Failed to add provider')
        return res.status(500).json({ error: 'Something went wrong on our end. Try again in a moment.' })
    }
})

// POST /api/v1/workspaces/:id/providers/test — test a provider connection
router.post('/test', async (req: any, res: any) => {
    const workspaceId = req.params.id as string
    const { providerType, apiKey: rawApiKey, endpointUrl, instanceId } = req.body as {
        providerType?: string
        apiKey?: string
        endpointUrl?: string
        instanceId?: string
    }

    if (!providerType) return res.status(400).json({ ok: false, error: 'providerType required' })

    // Whitelist check — an unknown key means the UI catalog is out of sync
    // with the backend registry. Surface that clearly.
    try {
        const { isKnownProviderKey } = await import('@plexo/agent/providers/registry')
        if (providerType !== 'ollama' && !isKnownProviderKey(providerType)) {
            return res.status(400).json({ ok: false, error: `Unknown provider: ${providerType}`, errorCode: 'unknown_provider' })
        }
    } catch {
        // Fall through if the import fails
    }

    // If no API key provided but instanceId given, decrypt the stored key
    let apiKey = rawApiKey
    if (!apiKey && instanceId && workspaceId) {
        try {
            const { getProvider } = await import('@plexo/agent/providers/instances')
            const instance = await getProvider(instanceId)
            if (instance?.encryptedKey) {
                const { decrypt } = await import('../crypto.js')
                apiKey = decrypt(instance.encryptedKey, workspaceId)
            }
        } catch (err) {
            logger.warn({ err, instanceId }, 'Failed to decrypt stored key for test')
        }
    }

    // ── Helper: classify an error into a user-friendly message + errorCode ──
    function classifyError(raw: string, provider: string): { error: string; errorCode: string } {
        const lower = raw.toLowerCase()

        if (
            lower.includes('401') ||
            lower.includes('unauthorized') ||
            lower.includes('incorrect api key') ||
            lower.includes('invalid api key') ||
            lower.includes('invalid x-api-key') ||
            lower.includes('authentication fails') ||
            lower.includes('authentication failed') ||
            lower.includes('missing api key') ||
            lower.includes('missing authentication') ||
            lower.includes('no api key') ||
            lower.includes('api key you provided is invalid') ||
            lower.includes('key is invalid') ||
            lower.includes('key is not valid') ||
            lower.includes('wrong api key')
        )
            return { error: 'API key is invalid or expired. Replace it with a new key.', errorCode: '401' }
        if (lower.includes('403') || lower.includes('forbidden'))
            return { error: "API key doesn't have permission for this model.", errorCode: '403' }
        if (lower.includes('model not found') || lower.includes('model_not_found') || lower.includes('does not exist'))
            return { error: `Model not available on ${provider}. Try a different model.`, errorCode: 'model_not_found' }
        if (lower.includes('bad request') || lower.includes('400'))
            return { error: `${provider} rejected the request. Check your API key and try again.`, errorCode: '400' }
        if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many'))
            return { error: 'Rate limited — try again in a minute.', errorCode: '429' }
        if (lower.includes('500') || lower.includes('502') || lower.includes('503') || lower.includes('internal server'))
            return { error: `${provider} is having issues — try again later.`, errorCode: '5xx' }
        if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('connect'))
            return { error: `Can't reach ${provider} — check the URL or your internet connection.`, errorCode: 'network' }
        if (lower.includes('timeout') || lower.includes('timedout') || lower.includes('timed out') || lower.includes('abort'))
            return { error: 'Connection timed out — the provider may be slow or unreachable.', errorCode: 'timeout' }
        if (lower.includes('insufficient') || lower.includes('quota') || lower.includes('balance'))
            return { error: 'Account has insufficient balance or quota. Top up your account.', errorCode: 'quota' }

        return { error: raw.slice(0, 300) || 'Connection test failed.', errorCode: 'unknown' }
    }

    const providerLabel = (providerType ?? '').charAt(0).toUpperCase() + (providerType ?? '').slice(1)

    try {
        // Ollama: test via /api/tags
        if (providerType === 'ollama' && endpointUrl) {
            const { OllamaAdapter } = await import('@plexo/agent/ollama/adapter')
            const adapter = new OllamaAdapter({ id: 'test', endpoint: endpointUrl })
            const healthy = await adapter.isHealthy()
            if (!healthy) {
                return res.json({ ok: false, error: 'We couldn\'t reach that server. Check the address and make sure the server is running.', errorCode: 'network' })
            }
            const caps = await adapter.discoverCapabilities()
            return res.json({
                ok: true,
                message: `Connected. ${caps.chatModels.length} conversation model${caps.chatModels.length !== 1 ? 's' : ''}, ${caps.embeddingModels.length} memory model${caps.embeddingModels.length !== 1 ? 's' : ''}.`,
                capabilities: caps,
                warnings: [
                    ...(!caps.supportsChat ? ['This server is reachable but has no AI models installed yet. You can still add it, but it won\'t be used until you install a model.'] : []),
                    ...(!caps.supportsEmbeddings ? ['This server doesn\'t have a memory model installed. Plexo will use another provider for memory.'] : []),
                ].filter(Boolean),
            })
        }

        // Cloud provider: use existing test infrastructure.
        // Before the smoke test, discover which chat models the key actually
        // has access to — the hardcoded DEFAULT_TEST_MODELS picks may not be
        // in the user's tier and cause a 403 "permission for this model"
        // error even though the key is otherwise valid. We pass the first
        // discovered model into testProvider so the smoke test reflects
        // what the key can actually do.
        let testModel: string | undefined
        try {
            const { discoverModels } = await import('@plexo/agent/providers/discover-models')
            const disco = await discoverModels(providerType, { apiKey })
            if (disco.ok && disco.models.length > 0) {
                testModel = disco.models[0]!.id
            }
        } catch {
            // Discovery is best-effort — if it fails, testProvider falls back
            // to its own default model selection.
        }
        const { testProvider } = await import('@plexo/agent/providers/registry')
        const start = Date.now()
        const result = await testProvider(providerType as any, { apiKey, model: testModel }, 12_000)
        const latencyMs = Date.now() - start
        const testResult = result as { ok: boolean; message?: string; model?: string; error?: string }

        if (!testResult.ok) {
            const classified = classifyError(testResult.message || 'Connection test failed.', providerLabel)
            return res.json({
                ok: false,
                error: classified.error,
                errorCode: classified.errorCode,
                providerType,
            })
        }

        return res.json({
            ok: true,
            message: `Connected in ${latencyMs}ms.`,
            model: testResult.model,
            latencyMs,
        })
    } catch (err) {
        logger.warn({ err, providerType }, 'Provider test failed')
        const message = err instanceof Error ? err.message.slice(0, 300) : 'Unknown error'
        const classified = classifyError(message, providerLabel)
        return res.json({ ok: false, error: classified.error, errorCode: classified.errorCode, providerType })
    }
})

// POST /api/v1/workspaces/:id/providers/discover-models — list the chat models
// a specific API key actually has access to, by hitting the provider's
// model-listing endpoint (e.g. GET /v1/models for OpenAI-compatible providers).
// Accepts either an apiKey in the body, or an instanceId to decrypt the
// stored key from provider_instances.
router.post('/discover-models', async (req: any, res: any) => {
    const workspaceId = req.params.id as string
    const { providerType, apiKey: rawApiKey, baseUrl, instanceId } = req.body as {
        providerType?: string
        apiKey?: string
        baseUrl?: string
        instanceId?: string
    }

    if (!providerType) {
        return res.status(400).json({ error: 'providerType required' })
    }

    // Whitelist check
    try {
        const { isKnownProviderKey } = await import('@plexo/agent/providers/registry')
        if (
            providerType !== 'ollama'
            && providerType !== 'ollama_cloud'
            && !isKnownProviderKey(providerType)
        ) {
            return res.status(400).json({ error: `Unknown provider: ${providerType}` })
        }
    } catch {
        // Fall through
    }

    // Resolve the API key — either passed directly, or decrypted from an
    // existing provider instance (so the "Test" button on an already-saved
    // provider doesn't need the user to retype their key).
    let apiKey = rawApiKey
    let resolvedBaseUrl = baseUrl
    if ((!apiKey || !resolvedBaseUrl) && instanceId && workspaceId) {
        try {
            const { getProvider } = await import('@plexo/agent/providers/instances')
            const instance = await getProvider(instanceId)
            if (instance) {
                if (!resolvedBaseUrl && instance.endpointUrl) {
                    resolvedBaseUrl = instance.endpointUrl
                }
                if (!apiKey && instance.encryptedKey) {
                    const { decrypt } = await import('../crypto.js')
                    apiKey = decrypt(instance.encryptedKey, workspaceId)
                }
            }
        } catch (err) {
            logger.warn({ err, instanceId }, 'Failed to decrypt stored key for discover-models')
        }
    }

    try {
        const { discoverModels } = await import('@plexo/agent/providers/discover-models')
        const result = await discoverModels(providerType, { apiKey, baseUrl: resolvedBaseUrl })
        return res.json(result)
    } catch (err) {
        logger.warn({ err, providerType }, 'discoverModels failed')
        // discoverModels should never throw, but handle it anyway.
        return res.status(500).json({ ok: false, error: 'Discovery failed', fallbackModels: [] })
    }
})

// POST /api/v1/workspaces/:id/providers/reorder
router.post('/reorder', async (req: any, res: any) => {
    const workspaceId = req.params.id as string
    const { orderedIds, capability } = req.body as { orderedIds?: string[]; capability?: 'chat' | 'embedding' | 'global' }
    if (!orderedIds?.length) return res.status(400).json({ error: 'orderedIds required' })

    try {
        const { reorderProviders } = await import('@plexo/agent/providers/instances')
        await reorderProviders(workspaceId, orderedIds, capability ?? 'global')
        return res.json({ ok: true })
    } catch (err) {
        logger.warn({ err, workspaceId }, 'Reorder failed')
        return res.status(500).json({ error: 'Reorder failed' })
    }
})

// PATCH /api/v1/workspaces/:id/providers/:instanceId — update a provider instance
router.patch('/:instanceId', async (req: any, res: any) => {
    const instanceId = req.params.instanceId as string
    const updates = req.body as { nickname?: string; selectedModel?: string; enabled?: boolean }

    try {
        const { updateProvider } = await import('@plexo/agent/providers/instances')
        const updated = await updateProvider(instanceId, updates)
        if (!updated) return res.status(404).json({ error: 'Provider not found' })
        return res.json({ ok: true, provider: { ...updated, encryptedKey: updated.encryptedKey ? '__configured__' : null } })
    } catch (err) {
        logger.error({ err, instanceId }, 'Failed to update provider')
        return res.status(500).json({ error: 'Update failed' })
    }
})

// DELETE /api/v1/workspaces/:id/providers/:instanceId
router.delete('/:instanceId', async (req: any, res: any) => {
    const instanceId = req.params.instanceId as string
    try {
        const { removeProvider } = await import('@plexo/agent/providers/instances')
        await removeProvider(instanceId)
        return res.json({ ok: true })
    } catch (err: any) {
        if (err.message?.includes('managed')) {
            return res.status(403).json({ error: err.message })
        }
        return res.status(500).json({ error: 'Failed to remove provider' })
    }
})

export { router as providerInstancesRouter }
