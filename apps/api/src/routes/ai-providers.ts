/**
 * POST /api/settings/ai-providers/test
 *
 * Delegates to testProvider() from @plexo/agent which owns all AI SDK deps.
 * This router only handles HTTP plumbing.
 */
import { Router, type Router as RouterType } from 'express'
import { testProvider, type ProviderKey } from '@plexo/agent/providers/registry'
import { logger } from '../logger.js'

export const aiProvidersRouter: RouterType = Router()

const VALID_PROVIDERS = new Set<string>([
    'openrouter', 'anthropic', 'openai', 'google',
    'mistral', 'groq', 'xai', 'deepseek', 'ollama',
])

aiProvidersRouter.post('/test', async (req, res) => {
    const { provider, apiKey, baseUrl, model } = req.body as {
        provider?: string
        apiKey?: string
        baseUrl?: string
        model?: string
    }

    if (!provider || !VALID_PROVIDERS.has(provider)) {
        res.status(400).json({ ok: false, message: 'Valid provider required' })
        return
    }

    try {
        const result = await testProvider(provider as ProviderKey, { apiKey, baseUrl, model })
        logger.info({ provider, model: result.model, ok: result.ok, latencyMs: result.latencyMs }, 'AI provider test')
        res.json(result)
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message.slice(0, 200) : 'Unknown error'
        logger.warn({ provider, err: message }, 'AI provider test error')
        res.json({ ok: false, message, latencyMs: 0, model: model ?? '' })
    }
})

/** GET /api/settings/ai-providers/models?provider=ollama&baseUrl=... */
aiProvidersRouter.get('/models', async (req, res) => {
    const { provider, baseUrl } = req.query as { provider?: string; baseUrl?: string }
    if (provider !== 'ollama') {
        res.status(400).json({ ok: false, message: 'Only ollama supports dynamic model listing' })
        return
    }
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
