// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * POST /api/settings/ai-providers/test
 *
 * Delegates to testProvider() from @plexo/agent which owns all AI SDK deps.
 * This router only handles HTTP plumbing.
 */
import { Router, type Router as RouterType } from 'express'
import { testProvider, type ProviderKey } from '@plexo/agent/providers/registry'
import { loadDecryptedAIProviders } from './ai-provider-creds.js'
import { logger } from '../logger.js'

export const aiProvidersRouter: RouterType = Router()

const VALID_PROVIDERS = new Set<string>([
    'openrouter', 'anthropic', 'openai', 'google',
    'mistral', 'groq', 'xai', 'deepseek', 'ollama', 'ollama_cloud',
])

aiProvidersRouter.post('/test', async (req, res) => {
    const { provider, apiKey, baseUrl, model, workspaceId } = req.body as {
        provider?: string
        apiKey?: string
        baseUrl?: string
        model?: string
        workspaceId?: string
    }

    if (!provider || (!VALID_PROVIDERS.has(provider) && !provider.startsWith('custom_'))) {
        res.status(400).json({ ok: false, message: 'Valid provider required' })
        return
    }

    let effectiveKey = apiKey
    if (!effectiveKey && workspaceId) {
        try {
            const decrypted = await loadDecryptedAIProviders(workspaceId)
            const entry = decrypted?.providers?.[provider]
            if (entry) {
                effectiveKey = entry.apiKey
            }
        } catch (err) {
            logger.error({ err, workspaceId, provider }, 'Failed to load stored provider key for test')
        }
    }

    try {
        const result = await testProvider(provider as ProviderKey, { apiKey: effectiveKey, baseUrl, model })
        logger.info({ provider, model: result.model, ok: result.ok, latencyMs: result.latencyMs }, 'AI provider test')
        res.json(result)
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message.slice(0, 200) : 'Unknown error'
        logger.warn({ provider, err: message }, 'AI provider test error')
        res.json({ ok: false, message, latencyMs: 0, model: model ?? '' })
    }
})

/** GET /api/settings/ai-providers/models?provider=ollama[_cloud]&baseUrl=...&apiKey=...&workspaceId=... */
aiProvidersRouter.get('/models', async (req, res) => {
    const { provider, baseUrl, apiKey, workspaceId } = req.query as {
        provider?: string; baseUrl?: string; apiKey?: string; workspaceId?: string
    }
    if (provider !== 'ollama' && provider !== 'ollama_cloud' && !provider?.startsWith('custom_')) {
        res.status(400).json({ ok: false, message: 'Only ollama / ollama_cloud / custom providers support dynamic model listing' })
        return
    }

    // Custom providers — discover models via OpenAI-compatible /v1/models
    if (provider?.startsWith('custom_')) {
        let effectiveKey = apiKey
        if (!effectiveKey && workspaceId) {
            try {
                const decrypted = await loadDecryptedAIProviders(workspaceId)
                const entry = decrypted?.providers?.[provider]
                if (entry) effectiveKey = entry.apiKey
            } catch (err) {
                logger.warn({ err, workspaceId, provider }, 'Failed to load custom provider key for model listing')
            }
        }
        if (!baseUrl) {
            res.status(400).json({ ok: false, message: 'baseUrl required for custom providers' })
            return
        }
        const base = baseUrl.replace(/\/+$/, '')
        const headers: Record<string, string> = {}
        if (effectiveKey) headers['Authorization'] = `Bearer ${effectiveKey}`
        try {
            const r = await fetch(`${base}/v1/models`, { headers, signal: AbortSignal.timeout(10_000) })
            if (!r.ok) { res.status(502).json({ ok: false, message: `Provider returned ${r.status}` }); return }
            const data = await r.json() as { data?: { id: string }[] }
            const models = (data.data ?? []).map((m) => m.id)
            res.json({ ok: true, models })
        } catch (err) {
            const message = err instanceof Error ? err.message.slice(0, 200) : 'Failed to list models'
            res.json({ ok: false, models: [], message })
        }
        return
    }

    if (provider === 'ollama_cloud') {
        // Resolve the API key — prefer explicit query param, then decrypt from workspace if available
        let effectiveKey = apiKey
        if (!effectiveKey && workspaceId) {
            try {
                const decrypted = await loadDecryptedAIProviders(workspaceId)
                const entry = decrypted?.providers?.['ollama_cloud']
                if (entry) effectiveKey = entry.apiKey
            } catch (err) {
                logger.warn({ err, workspaceId }, 'Failed to load ollama_cloud key for model listing')
            }
        }
        try {
            const r = await fetch('https://ollama.com/api/tags', {
                headers: effectiveKey ? { Authorization: `Bearer ${effectiveKey}` } : {},
                signal: AbortSignal.timeout(8000),
            })
            if (!r.ok) {
                const msg = r.status === 401 || r.status === 403
                    ? 'Invalid API key — check ollama.com/settings/keys'
                    : `Ollama Cloud returned ${r.status}`
                res.status(r.status === 401 ? 401 : 502).json({ ok: false, message: msg })
                return
            }
            const data = await r.json() as { models?: { name: string }[] }
            const models = (data.models ?? []).map((m) => m.name)
            res.json({ ok: true, models })
        } catch (err) {
            const message = err instanceof Error ? err.message.slice(0, 200) : 'Failed to list cloud models'
            res.json({ ok: false, models: [], message })
        }
        return
    }

    // Local Ollama
    const base = (baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '')
    try {
        const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) })
        if (!r.ok) { res.status(502).json({ ok: false, message: `Ollama returned ${r.status}` }); return }
        const data = await r.json() as { models?: { name: string }[] }
        const models = (data.models ?? []).map((m) => m.name)
        res.json({ ok: true, models })
    } catch (err) {
        const message = err instanceof Error ? err.message.slice(0, 200) : 'Failed to list models'
        res.json({ ok: false, models: [], message })
    }
})

/** POST /api/settings/ai-providers/probe — auto-detect provider protocol and models */
aiProvidersRouter.post('/probe', async (req, res) => {
    const { baseUrl, apiKey } = req.body as { baseUrl?: string; apiKey?: string }
    if (!baseUrl) { res.status(400).json({ ok: false, message: 'baseUrl required' }); return }

    const base = baseUrl.replace(/\/+$/, '')
    const headers: Record<string, string> = {}
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

    // Try OpenAI-compatible: GET /v1/models
    try {
        const r = await fetch(`${base}/v1/models`, { headers, signal: AbortSignal.timeout(10_000) })
        if (r.ok) {
            const data = await r.json() as { data?: { id: string }[] }
            const models = (data.data ?? []).map(m => m.id)
            res.json({ ok: true, protocol: 'openai', models })
            return
        }
    } catch { /* try next */ }

    // Try Ollama native: GET /api/tags
    try {
        const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(10_000) })
        if (r.ok) {
            const data = await r.json() as { models?: { name: string }[] }
            const models = (data.models ?? []).map(m => m.name)
            res.json({ ok: true, protocol: 'ollama', models })
            return
        }
    } catch { /* try next */ }

    // Try Anthropic-style: GET /v1/models with x-api-key
    try {
        const anthHeaders: Record<string, string> = { 'anthropic-version': '2023-06-01' }
        if (apiKey) anthHeaders['x-api-key'] = apiKey
        const r = await fetch(`${base}/v1/models`, { headers: anthHeaders, signal: AbortSignal.timeout(10_000) })
        if (r.ok) {
            const data = await r.json() as { data?: { id: string }[] }
            const models = (data.data ?? []).map(m => m.id)
            res.json({ ok: true, protocol: 'anthropic', models })
            return
        }
    } catch { /* try next */ }

    res.json({ ok: false, protocol: null, models: [], message: 'Could not detect provider protocol. Verify the URL and API key.' })
})
