// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express'
import { db, eq } from '@plexo/db'
import { connectionsRegistry } from '@plexo/db'
import { statusRouter } from './status.js'
import { coolifyRouter } from './coolify.js'
import { githubRouter } from './github.js'
import { sentryRouter } from './sentry.js'
import { posthogRouter } from './posthog.js'
import { ovhcloudRouter } from './ovhcloud.js'
import { agentsRouter } from './agents.js'
import { logger } from '../../logger.js'

export const cmdCenterRouter = Router()

cmdCenterRouter.use('/status', statusRouter)
cmdCenterRouter.use('/coolify', coolifyRouter)
cmdCenterRouter.use('/github', githubRouter)
cmdCenterRouter.use('/sentry', sentryRouter)
cmdCenterRouter.use('/posthog', posthogRouter)
cmdCenterRouter.use('/ovhcloud', ovhcloudRouter)
cmdCenterRouter.use('/agents', agentsRouter)

// Admin: seed connection registry entries (idempotent)
cmdCenterRouter.post('/seed-registry', async (_req, res) => {
    try {
        const entries = [
            { id: 'coolify', name: 'Coolify', description: 'Self-hosted PaaS — manage deployments, services, and infrastructure.', category: 'infrastructure', authType: 'api_key' as const, isCore: true, setupFields: [{ key: 'token', label: 'API Token', type: 'password', required: true }, { key: 'base_url', label: 'Coolify URL', type: 'url', required: true }], toolsProvided: ['list_services', 'list_deployments', 'redeploy_service'] },
            { id: 'sentry', name: 'Sentry', description: 'Error tracking and performance monitoring.', category: 'observability', authType: 'api_key' as const, isCore: true, setupFields: [{ key: 'auth_token', label: 'Auth Token', type: 'password', required: true }, { key: 'organization', label: 'Organization Slug', type: 'text', required: true }], toolsProvided: ['list_projects', 'list_issues', 'resolve_issue'] },
            { id: 'posthog', name: 'PostHog', description: 'Product analytics — insights and feature flags.', category: 'analytics', authType: 'api_key' as const, isCore: true, setupFields: [{ key: 'api_key', label: 'Personal API Key', type: 'password', required: true }, { key: 'project_id', label: 'Project ID', type: 'text', required: true }, { key: 'api_host', label: 'API Host', type: 'url', required: false }], toolsProvided: ['list_insights', 'list_feature_flags', 'toggle_feature_flag'] },
            { id: 'ovhcloud', name: 'OVHcloud', description: 'Cloud infrastructure — monitor dedicated servers.', category: 'infrastructure', authType: 'api_key' as const, isCore: true, setupFields: [{ key: 'application_key', label: 'Application Key', type: 'text', required: true }, { key: 'application_secret', label: 'Application Secret', type: 'password', required: true }, { key: 'consumer_key', label: 'Consumer Key', type: 'password', required: true }], toolsProvided: ['list_servers', 'get_server_status'] },
        ]

        const results: string[] = []
        for (const entry of entries) {
            const [existing] = await db.select({ id: connectionsRegistry.id }).from(connectionsRegistry).where(eq(connectionsRegistry.id, entry.id)).limit(1)
            if (existing) {
                results.push(`${entry.id}: already exists`)
                continue
            }
            await db.insert(connectionsRegistry).values({
                id: entry.id,
                name: entry.name,
                description: entry.description,
                category: entry.category,
                authType: entry.authType,
                isCore: entry.isCore,
                setupFields: entry.setupFields,
                toolsProvided: entry.toolsProvided,
                oauthScopes: [],
                cardsProvided: [],
            }).onConflictDoNothing()
            results.push(`${entry.id}: created`)
        }

        res.json({ results })
    } catch (err) {
        logger.error({ err }, 'cmd-center: seed-registry failed')
        res.status(500).json({ error: 'Failed to seed registry' })
    }
})
