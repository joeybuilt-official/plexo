// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express'
import { resolveCredentials, resolveWorkspaceId } from './resolve-credentials.js'
import { cachedFetch } from './cache.js'
import { logger } from '../../logger.js'

export const statusRouter = Router()

statusRouter.get('/', async (req, res) => {
    try {
        const wsId = await resolveWorkspaceId(req)

        const result = await cachedFetch('cmd-center:status', 30, async () => {
            const [coolifyR, githubR, sentryR, posthogR, ovhR, plexoR] = await Promise.allSettled([
                wsId ? fetchCoolify(wsId) : Promise.resolve({ healthy: 0, total: 0, services: [] }),
                wsId ? fetchGitHub(wsId) : Promise.resolve({ openPrs: 0, openIssues: 0, repos: [] }),
                wsId ? fetchSentry(wsId) : Promise.resolve({ totalErrors24h: 0, projects: [] }),
                wsId ? fetchPostHog(wsId) : Promise.resolve({ totalDau: 0, insights: [] }),
                wsId ? fetchOVH(wsId) : Promise.resolve({ servers: [] }),
                fetchPlexoHealth(),
            ])
            return {
                coolify: coolifyR.status === 'fulfilled' ? coolifyR.value : { healthy: 0, total: 0, services: [] },
                github: githubR.status === 'fulfilled' ? githubR.value : { openPrs: 0, openIssues: 0, repos: [] },
                sentry: sentryR.status === 'fulfilled' ? sentryR.value : { totalErrors24h: 0, projects: [] },
                posthog: posthogR.status === 'fulfilled' ? posthogR.value : { totalDau: 0, insights: [] },
                ovhcloud: ovhR.status === 'fulfilled' ? ovhR.value : { servers: [] },
                plexo: plexoR.status === 'fulfilled' ? plexoR.value : { health: { status: 'unhealthy', version: '?', integrations: [] } },
            }
        })
        res.json(result)
    } catch (err) {
        logger.error({ err }, 'cmd-center: status board failed')
        res.status(500).json({ error: 'Failed to fetch status' })
    }
})

async function fetchCoolify(wsId: string) {
    const creds = await resolveCredentials(wsId, 'coolify')
    if (!creds) return { healthy: 0, total: 0, services: [] }
    const token = (creds.token ?? creds.api_token ?? '') as string
    const baseUrl = (creds.base_url ?? 'https://coolify.joeybuilt.com') as string
    const r = await fetch(`${baseUrl}/api/v1/applications`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
    if (!r.ok) return { healthy: 0, total: 0, services: [] }
    const apps = await r.json() as any[]
    const services = apps.map((a: any) => ({ id: a.uuid ?? a.id, name: a.name ?? 'Unknown', status: mapS(a.status) }))
    return { healthy: services.filter((s: any) => s.status === 'running').length, total: services.length, services }
}

async function fetchGitHub(wsId: string) {
    const creds = await resolveCredentials(wsId, 'github')
    if (!creds) return { openPrs: 0, openIssues: 0, repos: [] }
    const token = (creds.access_token ?? creds.token ?? '') as string
    const r = await fetch('https://api.github.com/user/repos?sort=updated&per_page=20&type=owner', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Plexo/1.0' },
    })
    if (!r.ok) return { openPrs: 0, openIssues: 0, repos: [] }
    const repos = await r.json() as any[]
    let openIssues = 0
    const mapped = repos.map((rp: any) => { openIssues += rp.open_issues_count ?? 0; return { id: rp.id, name: rp.name, openPrsCount: 0 } })
    return { openPrs: 0, openIssues, repos: mapped }
}

async function fetchSentry(wsId: string) {
    const creds = await resolveCredentials(wsId, 'sentry')
    if (!creds) return { totalErrors24h: 0, projects: [] }
    const token = (creds.auth_token ?? creds.token ?? '') as string
    const org = (creds.organization ?? '') as string
    const r = await fetch(`https://sentry.io/api/0/organizations/${org}/projects/`, { headers: { Authorization: `Bearer ${token}` } })
    if (!r.ok) return { totalErrors24h: 0, projects: [] }
    const projects = await r.json() as any[]
    const mapped = projects.map((p: any) => ({ id: p.id, slug: p.slug, name: p.name, errorCount24h: 0 }))
    return { totalErrors24h: 0, projects: mapped }
}

async function fetchPostHog(_wsId: string) { return { totalDau: 0, insights: [] } }
async function fetchOVH(_wsId: string) { return { servers: [] } }

async function fetchPlexoHealth() {
    // This runs inside the API process itself — we can just import the health check logic
    // or call our own port. Use 127.0.0.1 to avoid DNS issues in container environments.
    const port = process.env.PORT ?? '3001'
    try {
        const r = await fetch(`http://127.0.0.1:${port}/health`)
        if (!r.ok) return { health: { status: 'unhealthy', version: '?', integrations: [] } }
        const d = await r.json() as any
        return { health: { status: d.status === 'ok' ? 'healthy' : 'degraded', version: d.version ?? '?', integrations: [] as any[] } }
    } catch { return { health: { status: 'unhealthy', version: '?', integrations: [] } } }
}

function mapS(s: string | undefined): string {
    if (!s) return 'stopped'
    const l = s.toLowerCase()
    if (l.includes('running') || l === 'healthy') return 'running'
    if (l.includes('error') || l.includes('failed')) return 'error'
    return 'stopped'
}
