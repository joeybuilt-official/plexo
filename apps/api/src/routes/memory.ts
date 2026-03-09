/**
 * Memory API
 *
 * GET  /api/memory/search?workspaceId=&q=&type=        Semantic search
 * GET  /api/memory/preferences?workspaceId=            Workspace preferences
 * GET  /api/memory/improvements?workspaceId=           Agent improvement log
 * POST /api/memory/improvements/run                    Trigger improvement cycle (synchronous)
 */
import { Router, type Router as RouterType } from 'express'
import { searchMemory } from '@plexo/agent/memory/store'
import { getPreferences } from '@plexo/agent/memory/preferences'
import { runSelfImprovementCycle, getImprovementLog } from '@plexo/agent/memory/self-improvement'
import { proposePromptImprovements, applyPromptPatch } from '@plexo/agent/memory/prompt-improvement'
import { loadDecryptedAIProviders } from './ai-provider-creds.js'
import type { WorkspaceAISettings, ProviderKey } from '@plexo/agent/providers/registry'
import { logger } from '../logger.js'

export const memoryRouter: RouterType = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── GET /api/memory/search ────────────────────────────────────────────────────

memoryRouter.get('/search', async (req, res) => {
    const { workspaceId, q, type, limit } = req.query as Record<string, string>

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!q) {
        res.status(400).json({ error: { code: 'MISSING_QUERY', message: 'q parameter required' } })
        return
    }

    try {
        const results = await searchMemory({
            workspaceId,
            query: q,
            type: type as 'task' | 'incident' | 'session' | 'pattern' | undefined,
            limit: Math.min(parseInt(limit ?? '5', 10), 20),
        })
        res.json({ results, total: results.length })
    } catch (err: unknown) {
        logger.error({ err }, 'Memory search failed')
        res.status(500).json({ error: { code: 'SEARCH_FAILED', message: 'Memory search failed' } })
    }
})

// ── GET /api/memory/preferences ───────────────────────────────────────────────

memoryRouter.get('/preferences', async (req, res) => {
    const { workspaceId } = req.query as Record<string, string>

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    try {
        const preferences = await getPreferences(workspaceId)
        res.json({ preferences, count: Object.keys(preferences).length })
    } catch (err: unknown) {
        logger.error({ err }, 'Get preferences failed')
        res.status(500).json({ error: { code: 'PREF_FETCH_FAILED', message: 'Failed to load preferences' } })
    }
})

// ── GET /api/memory/improvements ─────────────────────────────────────────────

memoryRouter.get('/improvements', async (req, res) => {
    const { workspaceId, limit } = req.query as Record<string, string>

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    try {
        const log = await getImprovementLog(workspaceId, Math.min(parseInt(limit ?? '20', 10), 100))
        res.json({ items: log, total: log.length })
    } catch (err: unknown) {
        logger.error({ err }, 'Get improvement log failed')
        res.status(500).json({ error: { code: 'LOG_FETCH_FAILED', message: 'Failed to load improvement log' } })
    }
})

// ── POST /api/memory/improvements/run ────────────────────────────────────────
// Synchronous — waits for the cycle to complete and returns the actual count.
// Times out at 90s (generous for claude-haiku).

memoryRouter.post('/improvements/run', async (req, res) => {
    const { workspaceId, lookbackDays } = req.body as {
        workspaceId?: string
        lookbackDays?: number
    }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    // Load workspace AI settings so the cycle uses the configured provider, not just env fallback
    let aiSettings: WorkspaceAISettings | undefined
    try {
        const ap = await loadDecryptedAIProviders(workspaceId)
        if (ap?.providers) {
            aiSettings = {
                inferenceMode: ap.inferenceMode as WorkspaceAISettings['inferenceMode'],
                primaryProvider: (ap.primary ?? ap.primaryProvider ?? 'anthropic') as ProviderKey,
                fallbackChain: (ap.fallbackOrder ?? ap.fallbackChain ?? []) as ProviderKey[],
                providers: Object.fromEntries(
                    Object.entries(ap.providers as Record<string, Record<string, unknown>>).map(([k, p]) => [k, {
                        provider: k as ProviderKey,
                        apiKey: p.apiKey as string | undefined,
                        oauthToken: p.oauthToken as string | undefined,
                        baseUrl: p.baseUrl as string | undefined,
                        model: (p.selectedModel ?? p.defaultModel) as string | undefined,
                        enabled: p.enabled as boolean | undefined,
                    }])
                ) as WorkspaceAISettings['providers'],
            }
        }
    } catch (err) {
        logger.warn({ err, workspaceId }, 'memory/run: failed to load workspace AI settings — using env fallback')
    }

    try {
        const result = await runSelfImprovementCycle({
            workspaceId,
            lookbackDays: lookbackDays ?? 7,
            aiSettings,
        })

        // Reload the improvement log so UI can display results immediately
        const log = await getImprovementLog(workspaceId, 30)

        res.json({
            ok: true,
            count: result.proposals,
            applied: result.applied,
            message: `Cycle complete — ${result.proposals} proposal(s) generated`,
            proposals: log,
        })
    } catch (err: unknown) {
        logger.error({ err, workspaceId }, 'Self-improvement cycle failed')
        res.status(500).json({ error: { code: 'CYCLE_FAILED', message: 'Self-improvement cycle failed' } })
    }
})

// ── POST /api/memory/improvements/prompt ─────────────────────────────────────

memoryRouter.post('/improvements/prompt', async (req, res) => {
    const { workspaceId, lookbackDays } = req.body as {
        workspaceId?: string
        lookbackDays?: number
    }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    res.status(202).json({ message: 'Prompt improvement analysis started', workspaceId })

    proposePromptImprovements({
        workspaceId,
        lookbackDays: lookbackDays ?? 14,
    }).catch((err: unknown) => {
        logger.error({ err, workspaceId }, 'Prompt improvement analysis failed')
    })
})

// ── POST /api/memory/improvements/:id/apply ───────────────────────────────────

memoryRouter.post('/improvements/:id/apply', async (req, res) => {
    const { id } = req.params
    const { workspaceId } = req.body as { workspaceId?: string }

    if (!UUID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required for improvement id' } })
        return
    }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    try {
        await applyPromptPatch({ workspaceId, improvementLogId: id })
        res.json({ ok: true, message: 'Prompt patch applied and active' })
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Apply failed'
        logger.error({ err, id }, 'Prompt patch apply failed')
        res.status(400).json({ error: { code: 'APPLY_FAILED', message: msg } })
    }
})
