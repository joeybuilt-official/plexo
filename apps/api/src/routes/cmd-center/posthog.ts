// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express'
import { resolveCredentials, resolveWorkspaceId } from './resolve-credentials.js'
import { cachedFetch, freshResponse } from './cache.js'
import { logger } from '../../logger.js'

export const posthogRouter = Router()

posthogRouter.get('/insights', async (req, res) => {
    try {
        const wsId = await resolveWorkspaceId(req)
        if (!wsId) { res.status(400).json({ error: 'No workspace' }); return }
        const creds = await resolveCredentials(wsId, 'posthog')
        if (!creds) { res.json(freshResponse([])); return }
        const apiKey = (creds.api_key ?? creds.token ?? '') as string
        const projectId = (creds.project_id ?? '') as string
        const apiHost = (creds.api_host ?? 'https://app.posthog.com') as string

        const result = await cachedFetch('cmd-center:posthog:insights', 120, async () => {
            const r = await fetch(`${apiHost}/api/projects/${projectId}/insights/?limit=20`, { headers: { Authorization: `Bearer ${apiKey}` } })
            if (!r.ok) throw new Error(`PostHog: ${r.status}`)
            const d = await r.json() as { results: any[] }
            return (d.results ?? []).map((i: any) => ({
                productName: i.name ?? 'Unnamed', dau: 0, wau: 0, keyEvents: [],
            }))
        })
        res.json(result)
    } catch (err) {
        logger.error({ err }, 'cmd-center: posthog insights failed')
        res.json(freshResponse([]))
    }
})

posthogRouter.get('/feature-flags', async (req, res) => {
    try {
        const wsId = await resolveWorkspaceId(req)
        if (!wsId) { res.status(400).json({ error: 'No workspace' }); return }
        const creds = await resolveCredentials(wsId, 'posthog')
        if (!creds) { res.json(freshResponse([])); return }
        const apiKey = (creds.api_key ?? creds.token ?? '') as string
        const projectId = (creds.project_id ?? '') as string
        const apiHost = (creds.api_host ?? 'https://app.posthog.com') as string

        const result = await cachedFetch('cmd-center:posthog:flags', 120, async () => {
            const r = await fetch(`${apiHost}/api/projects/${projectId}/feature_flags/`, { headers: { Authorization: `Bearer ${apiKey}` } })
            if (!r.ok) throw new Error(`PostHog: ${r.status}`)
            const d = await r.json() as { results: any[] }
            return (d.results ?? []).map((f: any) => ({
                id: String(f.id), key: f.key, name: f.name ?? f.key,
                active: f.active ?? false, rolloutPercentage: f.rollout_percentage ?? (f.active ? 100 : 0),
            }))
        })
        res.json(result)
    } catch (err) {
        logger.error({ err }, 'cmd-center: posthog flags failed')
        res.json(freshResponse([]))
    }
})

posthogRouter.post('/feature-flags/:id/toggle', async (req, res) => {
    try {
        const wsId = await resolveWorkspaceId(req)
        if (!wsId) { res.status(400).json({ error: 'No workspace' }); return }
        const creds = await resolveCredentials(wsId, 'posthog')
        if (!creds) { res.status(400).json({ error: 'PostHog not connected' }); return }
        const apiKey = (creds.api_key ?? creds.token ?? '') as string
        const projectId = (creds.project_id ?? '') as string
        const apiHost = (creds.api_host ?? 'https://app.posthog.com') as string
        const r = await fetch(`${apiHost}/api/projects/${projectId}/feature_flags/${req.params.id}/`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ active: req.body.active }),
        })
        res.json(freshResponse({ toggled: r.ok }))
    } catch (err) {
        logger.error({ err }, 'cmd-center: posthog toggle failed')
        res.json(freshResponse({ toggled: false }))
    }
})
