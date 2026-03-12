// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Connections & marketplace API
 *
 * GET    /api/connections/registry              All available integrations
 * GET    /api/connections/registry/:id          Single integration detail
 * GET    /api/connections/installed?workspaceId Installed connections for a workspace
 * POST   /api/connections/install               Install a connection
 * PATCH  /api/connections/installed/:id         Update settings/credentials/status
 * PUT    /api/connections/installed/:id/tools   Replace enabled tool list
 * DELETE /api/connections/installed/:id         Uninstall
 */
import { Router, type Router as RouterType } from 'express'
import { db, eq, and } from '@plexo/db'
import { connectionsRegistry, installedConnections } from '@plexo/db'
import { encrypt, decrypt } from '../crypto.js'
import { logger } from '../logger.js'
import { captureLifecycleEvent } from '../sentry.js'

/**
 * Maps connections registry IDs → MCP server binding metadata.
 * command / args are used to produce the mcpServers JSON block.
 * envKey is the env var name the MCP server expects for the credential.
 */
const MCP_BINDINGS: Record<string, { mcpPackage: string; envKey: string }> = {
    github: {
        mcpPackage: '@modelcontextprotocol/server-github',
        envKey: 'GITHUB_PERSONAL_ACCESS_TOKEN',
    },
    gitlab: {
        mcpPackage: '@modelcontextprotocol/server-gitlab',
        envKey: 'GITLAB_PERSONAL_ACCESS_TOKEN',
    },
    slack: {
        mcpPackage: '@modelcontextprotocol/server-slack',
        envKey: 'SLACK_BOT_TOKEN',
    },
    notion: {
        mcpPackage: '@modelcontextprotocol/server-notion',
        envKey: 'NOTION_API_TOKEN',
    },
    linear: {
        mcpPackage: '@linear/mcp',
        envKey: 'LINEAR_API_KEY',
    },
    jira: {
        mcpPackage: '@mcp-atlassian/jira',
        envKey: 'JIRA_API_TOKEN',
    },
    'google-drive': {
        mcpPackage: '@modelcontextprotocol/server-gdrive',
        envKey: 'GDRIVE_ACCESS_TOKEN',
    },
}

export const connectionsRouter: RouterType = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── GET /api/connections/registry ────────────────────────────────────────────

connectionsRouter.get('/registry', async (_req, res) => {
    try {
        const items = await db.select().from(connectionsRegistry)
        // Augment each item with mcpPackage so the frontend can show MCP indicators
        const augmented = items.map(item => ({
            ...item,
            mcpPackage: MCP_BINDINGS[item.id]?.mcpPackage ?? null,
        }))
        res.json({ items: augmented, total: augmented.length })
    } catch (err: unknown) {
        logger.error({ err }, 'GET /api/connections/registry failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load registry' } })
    }
})


// ── GET /api/connections/registry/:id ────────────────────────────────────────

connectionsRouter.get('/registry/:id', async (req, res) => {
    const { id } = req.params
    if (!UUID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }
    try {
        const [item] = await db.select().from(connectionsRegistry).where(eq(connectionsRegistry.id, id)).limit(1)
        if (!item) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Connection not found in registry' } })
            return
        }
        res.json(item)
    } catch (err: unknown) {
        logger.error({ err, id }, 'GET /api/connections/registry/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load connection' } })
    }
})

// ── GET /api/connections/installed ───────────────────────────────────────────

connectionsRouter.get('/github/repos', async (req, res) => {
    const { workspaceId } = req.query as Record<string, string>

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    try {
        const [row] = await db.select({
            credentials: installedConnections.credentials,
        }).from(installedConnections)
            .where(and(
                eq(installedConnections.workspaceId, workspaceId),
                eq(installedConnections.registryId, 'github'),
                eq(installedConnections.status, 'active'),
            ))
            .limit(1)

        if (!row) {
            res.status(404).json({ error: { code: 'NOT_CONNECTED', message: 'GitHub not connected for this workspace' } })
            return
        }

        let token = ''
        const raw = row.credentials as Record<string, unknown>
        if (raw.encrypted) {
            const decrypted = decrypt(raw.encrypted as string, workspaceId)
            const creds = JSON.parse(decrypted) as Record<string, string>
            token = creds.access_token ?? creds.token ?? Object.values(creds).find(v => v) ?? ''
        }

        if (!token) {
            res.status(400).json({ error: { code: 'NO_TOKEN', message: 'No access token found' } })
            return
        }

        // Fetch repos from GitHub
        const ghRes = await fetch('https://api.github.com/user/repos?sort=updated&per_page=100', {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'Plexo/1.0',
            },
        })

        if (!ghRes.ok) {
            const errText = await ghRes.text()
            logger.error({ err: errText, status: ghRes.status }, 'GitHub API failed')
            res.status(ghRes.status).json({ error: { code: 'GITHUB_ERROR', message: 'Failed to fetch repositories from GitHub' } })
            return
        }

        const data = await ghRes.json() as any[]
        const repos = data.map(r => ({
            id: r.id,
            fullName: r.full_name,
            name: r.name,
            owner: r.owner.login,
            description: r.description,
            private: r.private,
            updatedAt: r.updated_at,
            defaultBranch: r.default_branch,
        }))

        res.json({ items: repos, total: repos.length })
    } catch (err: unknown) {
        logger.error({ err }, 'GET /api/connections/github/repos failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch repositories' } })
    }
})

connectionsRouter.get('/github/branches', async (req, res) => {
    const { workspaceId, repo } = req.query as Record<string, string>

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    if (!repo) {
        res.status(400).json({ error: { code: 'INVALID_REPO', message: 'Repo name required' } })
        return
    }

    try {
        const [row] = await db.select({
            credentials: installedConnections.credentials,
        }).from(installedConnections)
            .where(and(
                eq(installedConnections.workspaceId, workspaceId),
                eq(installedConnections.registryId, 'github'),
                eq(installedConnections.status, 'active'),
            ))
            .limit(1)

        if (!row) {
            res.status(404).json({ error: { code: 'NOT_CONNECTED', message: 'GitHub not connected for this workspace' } })
            return
        }

        let token = ''
        const raw = row.credentials as Record<string, unknown>
        if (raw.encrypted) {
            const decrypted = decrypt(raw.encrypted as string, workspaceId)
            const creds = JSON.parse(decrypted) as Record<string, string>
            token = creds.access_token ?? creds.token ?? Object.values(creds).find(v => v) ?? ''
        }

        if (!token) {
            res.status(400).json({ error: { code: 'NO_TOKEN', message: 'No access token found' } })
            return
        }

        // Fetch branches from GitHub
        const ghRes = await fetch(`https://api.github.com/repos/${repo}/branches?per_page=100`, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'Plexo/1.0',
            },
        })

        if (!ghRes.ok) {
            const errText = await ghRes.text()
            logger.error({ err: errText, status: ghRes.status }, `GitHub API failed for ${repo}`)
            res.status(ghRes.status).json({ error: { code: 'GITHUB_ERROR', message: `Failed to fetch branches for ${repo}` } })
            return
        }

        const data = await ghRes.json() as any[]
        const branches = data.map(b => ({
            name: b.name,
            protected: b.protected,
        }))

        res.json({ items: branches, total: branches.length })
    } catch (err: unknown) {
        logger.error({ err }, 'GET /api/connections/github/branches failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch branches' } })
    }
})

connectionsRouter.get('/installed', async (req, res) => {
    const { workspaceId } = req.query as Record<string, string>

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    try {
        const items = await db.select({
            id: installedConnections.id,
            registryId: installedConnections.registryId,
            name: installedConnections.name,
            status: installedConnections.status,
            enabledTools: installedConnections.enabledTools,
            scopesGranted: installedConnections.scopesGranted,
            lastVerifiedAt: installedConnections.lastVerifiedAt,
            createdAt: installedConnections.createdAt,
        }).from(installedConnections)
            .where(eq(installedConnections.workspaceId, workspaceId))

        res.json({ items, total: items.length })
    } catch (err: unknown) {
        logger.error({ err }, 'GET /api/connections/installed failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load installed connections' } })
    }
})

// ── POST /api/connections/install ─────────────────────────────────────────────

connectionsRouter.post('/install', async (req, res) => {
    const { workspaceId, registryId, credentials = {}, name } = req.body as {
        workspaceId?: string
        registryId?: string
        credentials?: Record<string, string>
        name?: string
    }

    if (!workspaceId || !UUID_RE.test(workspaceId) || !registryId) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId and registryId required' } })
        return
    }

    try {
        const [reg] = await db.select({ id: connectionsRegistry.id, name: connectionsRegistry.name, authType: connectionsRegistry.authType })
            .from(connectionsRegistry).where(eq(connectionsRegistry.id, registryId)).limit(1)

        if (!reg) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Integration not found in registry' } })
            return
        }

        // Encrypt credentials at rest with workspace-scoped AES-256-GCM key
        const encryptedCreds = Object.keys(credentials).length > 0
            ? { encrypted: encrypt(JSON.stringify(credentials), workspaceId) }
            : {}

        const [installed] = await db.insert(installedConnections).values({
            workspaceId,
            registryId: reg.id,
            name: name ?? reg.name,
            credentials: encryptedCreds,
            status: 'active',
        }).returning({ id: installedConnections.id })

        logger.info({ workspaceId, registryId, name: reg.name }, 'Connection installed')
        captureLifecycleEvent('connection.installed', 'info', { workspaceId, registryId: reg.id, name: reg.name })
        res.status(201).json({ id: installed!.id, message: 'Connection installed' })
    } catch (err: unknown) {
        logger.error({ err }, 'POST /api/connections/install failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Install failed' } })
    }
})

// ── PATCH /api/connections/installed/:id ─────────────────────────────────────

connectionsRouter.patch('/installed/:id', async (req, res) => {
    const { id } = req.params
    if (!UUID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }
    const { workspaceId, status, credentials } = req.body as {
        workspaceId?: string
        status?: 'active' | 'disconnected'
        credentials?: Record<string, string>
    }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    try {
        const update: Record<string, unknown> = {}
        if (status) update.status = status
        if (credentials && Object.keys(credentials).length > 0) {
            update.credentials = { encrypted: encrypt(JSON.stringify(credentials), workspaceId) }
        }

        await db.update(installedConnections)
            .set(update)
            .where(and(eq(installedConnections.id, id), eq(installedConnections.workspaceId, workspaceId)))

        if (status) captureLifecycleEvent('connection.status_updated', 'info', { connectionId: id, workspaceId, status })
        res.json({ ok: true })
    } catch (err: unknown) {
        logger.error({ err, id }, 'PATCH /api/connections/installed/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Update failed' } })
    }
})

// ── PUT /api/connections/installed/:id/tools ──────────────────────────────────
// Replaces the enabled tools list. null enables all tools for this connection.

connectionsRouter.put('/installed/:id/tools', async (req, res) => {
    const { id } = req.params
    if (!UUID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }
    const { workspaceId, enabledTools } = req.body as {
        workspaceId?: string
        enabledTools: string[] | null
    }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    try {
        await db.update(installedConnections)
            .set({ enabledTools })
            .where(and(eq(installedConnections.id, id), eq(installedConnections.workspaceId, workspaceId)))

        logger.info({ id, workspaceId, count: enabledTools?.length ?? 'all' }, 'Connection tools updated')
        res.json({ ok: true })
    } catch (err: unknown) {
        logger.error({ err, id }, 'PUT /api/connections/installed/:id/tools failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Tool update failed' } })
    }
})

// ── DELETE /api/connections/installed/:id ────────────────────────────────────

connectionsRouter.delete('/installed/:id', async (req, res) => {
    const { id } = req.params
    const { workspaceId } = req.query as Record<string, string>

    if (!UUID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    try {
        await db.delete(installedConnections)
            .where(and(eq(installedConnections.id, id), eq(installedConnections.workspaceId, workspaceId)))

        logger.info({ id, workspaceId }, 'Connection uninstalled')
        captureLifecycleEvent('connection.uninstalled', 'info', { connectionId: id, workspaceId })
        res.json({ ok: true })
    } catch (err: unknown) {
        logger.error({ err, id }, 'DELETE /api/connections/installed/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Uninstall failed' } })
    }
})

// ── GET /api/connections/mcp-config ──────────────────────────────────────────
// Returns the combined mcpServers JSON block for all connected MCP-capable
// integrations. The `preview` query param (= '1') redacts token values.
// At agent boot the engine calls this with preview=0 to get live credentials.

connectionsRouter.get('/mcp-config', async (req, res) => {
    const { workspaceId, preview } = req.query as Record<string, string>

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    const isPreview = preview === '1' || preview === 'true'

    try {
        const rows = await db.select({
            registryId: installedConnections.registryId,
            credentials: installedConnections.credentials,
            status: installedConnections.status,
        }).from(installedConnections)
            .where(eq(installedConnections.workspaceId, workspaceId))

        const mcpServers: Record<string, unknown> = {}

        for (const row of rows) {
            const binding = MCP_BINDINGS[row.registryId]
            if (!binding) continue  // no MCP server mapping for this integration
            if (row.status !== 'active') continue

            let tokenValue = '*** stored securely ***'

            if (!isPreview) {
                try {
                    const raw = row.credentials as Record<string, unknown>
                    if (raw.encrypted) {
                        const decrypted = decrypt(raw.encrypted as string, workspaceId)
                        const creds = JSON.parse(decrypted) as Record<string, string>
                        // Find first non-empty credential value
                        tokenValue = Object.values(creds).find(v => v) ?? ''
                    }
                } catch (decryptErr) {
                    logger.warn({ err: decryptErr, registryId: row.registryId }, 'Failed to decrypt credentials for MCP config')
                    continue
                }
            }

            mcpServers[row.registryId] = {
                command: 'npx',
                args: ['-y', binding.mcpPackage, 'stdio'],
                env: {
                    [binding.envKey]: tokenValue,
                },
            }
        }

        res.json({ mcpServers, count: Object.keys(mcpServers).length })
    } catch (err: unknown) {
        logger.error({ err }, 'GET /api/connections/mcp-config failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to generate MCP config' } })
    }
})

// ── GET /api/connections/registry — augmented with mcpPackage ─────────────────
// The base registry route is on connectionsRouter but we need to enrich items
// with the mcpPackage field from MCP_BINDINGS so the UI can display it.
// This shadow-patches the registry response in-process.

connectionsRouter.get('/registry-mcp-meta', (_req, res) => {
    res.json({ bindings: MCP_BINDINGS })
})
