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
import { connectionsRegistry, installedConnections, channels } from '@plexo/db'
import { encrypt, decrypt } from '../crypto.js'
import { logger } from '../logger.js'
import { captureLifecycleEvent } from '../sentry.js'
import { UUID_RE } from '../validation.js'

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
    // Validate repo format (owner/name) to prevent URL injection/SSRF
    if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo) || repo.length > 200) {
        res.status(400).json({ error: { code: 'INVALID_REPO', message: 'Repo must be in "owner/name" format' } })
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

// ── POST /api/connections/mcp/discover — probe an MCP server for tools ───────

connectionsRouter.post('/mcp/discover', async (req, res) => {
    const { transport, url, command, args, api_key } = req.body as Record<string, string>
    if (!transport || !['sse', 'stdio'].includes(transport)) {
        res.status(400).json({ error: { code: 'INVALID_TRANSPORT', message: 'transport must be "sse" or "stdio"' } })
        return
    }
    if (transport === 'sse' && !url) {
        res.status(400).json({ error: { code: 'MISSING_URL', message: 'SSE transport requires a url' } })
        return
    }
    if (transport === 'stdio' && !command) {
        res.status(400).json({ error: { code: 'MISSING_COMMAND', message: 'stdio transport requires a command' } })
        return
    }

    try {
        const { discoverMCPTools } = await import('@plexo/agent/mcp/client')
        const tools = await discoverMCPTools({
            transport: transport as 'sse' | 'stdio',
            url,
            command,
            args: args ? args.split(',').map(s => s.trim()) : undefined,
            apiKey: api_key,
        })
        res.json({ tools, count: tools.length })
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn({ err, transport, url, command }, 'MCP discovery failed')
        res.status(502).json({ error: { code: 'MCP_DISCOVERY_FAILED', message: msg } })
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
    if (typeof registryId !== 'string' || registryId.length > 100) {
        res.status(400).json({ error: { code: 'INVALID_REGISTRY_ID', message: 'registryId must be a string, max 100 chars' } })
        return
    }

    try {
        const [reg] = await db.select({ id: connectionsRegistry.id, name: connectionsRegistry.name, authType: connectionsRegistry.authType, category: connectionsRegistry.category })
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

        // Bridge: communication connections auto-create a channel record so the
        // webhook handler picks them up. This eliminates the Connections/Channels
        // split for messaging services — connect once, works everywhere.
        const CHANNEL_TYPES = ['telegram', 'slack', 'discord', 'whatsapp', 'signal', 'matrix'] as const
        if (reg.category === 'communication' && CHANNEL_TYPES.includes(registryId as any)) {
            try {
                const channelConfig = { ...credentials } // plain-text config for webhook handler
                const [ch] = await db.insert(channels).values({
                    workspaceId,
                    type: registryId as typeof CHANNEL_TYPES[number],
                    name: name ?? reg.name,
                    config: channelConfig,
                    enabled: true,
                }).onConflictDoNothing().returning({ id: channels.id })

                if (ch) {
                    logger.info({ workspaceId, channelType: registryId, channelId: ch.id }, 'Auto-created channel from connection')

                    // Auto-register webhook for Telegram
                    if (registryId === 'telegram') {
                        const token = credentials.bot_token ?? credentials.token ?? null
                        if (token) {
                            const { registerTelegramChannel } = await import('./telegram.js')
                            void registerTelegramChannel(ch.id, token, workspaceId).catch(
                                (err: Error) => logger.warn({ err }, 'Telegram webhook auto-register from connection failed'),
                            )
                        }
                    }
                }
            } catch (chErr) {
                // Non-fatal — the connection itself succeeded
                logger.warn({ err: chErr, registryId }, 'Failed to auto-create channel from connection — non-fatal')
            }
        }

        // Bridge: MCP connections auto-discover tools on install
        let mcpTools: string[] | undefined
        if (reg.category === 'mcp' || registryId === 'mcp_custom') {
            try {
                const { connectMCP } = await import('@plexo/agent/mcp/client')
                const mcpConfig = {
                    transport: (credentials.transport as 'sse' | 'stdio') ?? 'sse',
                    url: credentials.url,
                    command: credentials.command,
                    args: credentials.args ? credentials.args.split(',').map((s: string) => s.trim()) : undefined,
                    apiKey: credentials.api_key,
                }
                const tools = await connectMCP(installed!.id, mcpConfig)
                mcpTools = tools.map(t => t.name)
                // Update the installed connection with discovered tools
                if (mcpTools.length > 0) {
                    await db.update(installedConnections)
                        .set({ enabledTools: mcpTools })
                        .where(eq(installedConnections.id, installed!.id))
                }
                logger.info({ connectionId: installed!.id, toolCount: mcpTools.length }, 'MCP tools discovered on install')
            } catch (mcpErr) {
                logger.warn({ err: mcpErr, registryId }, 'MCP tool discovery failed on install — connection saved without tools')
            }
        }

        res.status(201).json({ id: installed!.id, message: 'Connection installed', ...(mcpTools ? { discoveredTools: mcpTools } : {}) })
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
        // Read the connection before deleting so we can clean up the channel bridge
        const [conn] = await db.select({ registryId: installedConnections.registryId })
            .from(installedConnections)
            .where(and(eq(installedConnections.id, id), eq(installedConnections.workspaceId, workspaceId)))
            .limit(1)

        await db.delete(installedConnections)
            .where(and(eq(installedConnections.id, id), eq(installedConnections.workspaceId, workspaceId)))

        // Bridge cleanup: remove the auto-created channel when a communication connection is disconnected
        const CHANNEL_TYPES = ['telegram', 'slack', 'discord', 'whatsapp', 'signal', 'matrix'] as const
        if (conn && CHANNEL_TYPES.includes(conn.registryId as any)) {
            await db.delete(channels)
                .where(and(eq(channels.workspaceId, workspaceId), eq(channels.type, conn.registryId as any)))
                .catch((err: unknown) => logger.warn({ err }, 'Failed to clean up bridged channel — non-fatal'))
        }

        logger.info({ id, workspaceId, registryId: conn?.registryId }, 'Connection uninstalled')
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

        // Look up registry entries for custom MCP connections
        const regRows = await db.select({
            id: connectionsRegistry.id,
            category: connectionsRegistry.category,
            isGenerated: connectionsRegistry.isGenerated,
        }).from(connectionsRegistry)

        const regMap = new Map(regRows.map(r => [r.id, r]))

        for (const row of rows) {
            if (row.status !== 'active') continue

            const binding = MCP_BINDINGS[row.registryId]
            const reg = regMap.get(row.registryId)

            // Handle built-in MCP bindings
            if (binding) {
                let tokenValue = '*** stored securely ***'

                if (!isPreview) {
                    try {
                        const raw = row.credentials as Record<string, unknown>
                        if (raw.encrypted) {
                            const decrypted = decrypt(raw.encrypted as string, workspaceId)
                            const creds = JSON.parse(decrypted) as Record<string, string>
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
                continue
            }

            // Handle custom MCP connections (generated registry entries with category 'mcp')
            if (reg?.category === 'mcp' && reg.isGenerated) {
                if (isPreview) {
                    mcpServers[row.registryId] = {
                        url: '*** stored securely ***',
                        transport: 'sse',
                    }
                } else {
                    try {
                        const raw = row.credentials as Record<string, unknown>
                        if (raw.encrypted) {
                            const decrypted = decrypt(raw.encrypted as string, workspaceId)
                            const creds = JSON.parse(decrypted) as Record<string, string>
                            const mcpEntry: Record<string, unknown> = {
                                url: creds.url,
                                transport: 'sse',
                            }
                            if (creds.token) {
                                mcpEntry.headers = { Authorization: `Bearer ${creds.token}` }
                            }
                            mcpServers[row.registryId] = mcpEntry
                        }
                    } catch (decryptErr) {
                        logger.warn({ err: decryptErr, registryId: row.registryId }, 'Failed to decrypt credentials for custom MCP config')
                    }
                }
            }
        }

        res.json({ mcpServers, count: Object.keys(mcpServers).length })
    } catch (err: unknown) {
        logger.error({ err }, 'GET /api/connections/mcp-config failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to generate MCP config' } })
    }
})

// ── GET /api/connections/token ────────────────────────────────────────────────
// Service-to-service endpoint: returns decrypted credentials for a specific
// installed connection. Requires PLEXO_SERVICE_KEY auth.
// Used by Joeybuilt apps (Levio, Fylo, etc.) to retrieve OAuth tokens stored in Plexo.
//
// Query params:
//   workspaceId  UUID of the workspace
//   registryId   ID of the connection (e.g. 'google-workspace')

import { requireServiceKey } from '../middleware/service-key-auth.js'

connectionsRouter.get('/token', requireServiceKey, async (req, res) => {
    const { workspaceId, registryId } = req.query as Record<string, string>

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!registryId || typeof registryId !== 'string' || registryId.length > 100) {
        res.status(400).json({ error: { code: 'INVALID_REGISTRY_ID', message: 'registryId required' } })
        return
    }

    try {
        const [row] = await db.select({
            credentials: installedConnections.credentials,
            status: installedConnections.status,
            scopesGranted: installedConnections.scopesGranted,
            lastVerifiedAt: installedConnections.lastVerifiedAt,
        }).from(installedConnections)
            .where(and(
                eq(installedConnections.workspaceId, workspaceId),
                eq(installedConnections.registryId, registryId),
                eq(installedConnections.status, 'active'),
            ))
            .limit(1)

        if (!row) {
            res.status(404).json({ error: { code: 'NOT_CONNECTED', message: `${registryId} not connected for this workspace` } })
            return
        }

        const raw = row.credentials as Record<string, unknown>
        if (!raw.encrypted) {
            res.status(500).json({ error: { code: 'NO_CREDENTIALS', message: 'No encrypted credentials found' } })
            return
        }

        const decrypted = decrypt(raw.encrypted as string, workspaceId)
        const creds = JSON.parse(decrypted) as Record<string, unknown>

        res.json({
            access_token: creds.access_token ?? null,
            refresh_token: creds.refresh_token ?? null,
            expires_at: creds.expires_at ?? null,
            email: creds.email ?? null,
            scope: creds.scope ?? null,
        })
    } catch (err: unknown) {
        logger.error({ err }, 'GET /api/connections/token failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to retrieve token' } })
    }
})

// ── GET /api/connections/registry — augmented with mcpPackage ─────────────────
// The base registry route is on connectionsRouter but we need to enrich items
// with the mcpPackage field from MCP_BINDINGS so the UI can display it.
// This shadow-patches the registry response in-process.

connectionsRouter.get('/registry-mcp-meta', (_req, res) => {
    res.json({ bindings: MCP_BINDINGS })
})

// ── POST /api/connections/custom ──────────────────────────────────────────────
// Creates a custom connection (MCP server or custom API) that bypasses the
// static registry. Creates a generated registry entry + installs in one step.

connectionsRouter.post('/custom', async (req, res) => {
    const {
        workspaceId,
        type,        // 'mcp' | 'custom_api'
        name,
        url,
        description,
        authType,    // 'none' | 'api_key' | 'bearer'
        authValue,
        discoveredTools,
    } = req.body as {
        workspaceId?: string
        type?: string
        name?: string
        url?: string
        description?: string
        authType?: string
        authValue?: string
        discoveredTools?: string[]
    }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!type || !['mcp', 'custom_api'].includes(type)) {
        res.status(400).json({ error: { code: 'INVALID_TYPE', message: 'type must be "mcp" or "custom_api"' } })
        return
    }
    if (!name || name.length > 100) {
        res.status(400).json({ error: { code: 'INVALID_NAME', message: 'name required, max 100 chars' } })
        return
    }
    if (!url || url.length > 2000) {
        res.status(400).json({ error: { code: 'INVALID_URL', message: 'url required, max 2000 chars' } })
        return
    }

    try {
        // Generate a slug-based registry ID
        const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        const registryId = `custom-${type}-${slug}-${Date.now()}`

        const category = type === 'mcp' ? 'mcp' : 'custom_api'
        const resolvedAuthType = authType === 'bearer' ? 'api_key' as const
            : (authType === 'api_key' ? 'api_key' as const
            : 'none' as const)

        // Create a generated registry entry
        await db.insert(connectionsRegistry).values({
            id: registryId,
            name,
            description: description || (type === 'mcp' ? `Custom MCP server at ${url}` : `Custom API at ${url}`),
            category,
            logoUrl: null,
            authType: resolvedAuthType,
            oauthScopes: [],
            setupFields: [],
            toolsProvided: discoveredTools ?? [],
            cardsProvided: [],
            isCore: false,
            isGenerated: true,
            docUrl: null,
        })

        // Build credentials object
        const credentials: Record<string, string> = { url }
        if (authValue) credentials.token = authValue
        if (authType) credentials.authType = authType

        const encryptedCreds = { encrypted: encrypt(JSON.stringify(credentials), workspaceId) }

        // Install the connection
        const [installed] = await db.insert(installedConnections).values({
            workspaceId,
            registryId,
            name,
            credentials: encryptedCreds,
            status: 'active',
            enabledTools: null,
        }).returning({ id: installedConnections.id })

        logger.info({ workspaceId, registryId, type, name }, 'Custom connection created')
        captureLifecycleEvent('connection.custom_created', 'info', { workspaceId, registryId, type, name })

        res.status(201).json({
            id: installed!.id,
            registryId,
            message: 'Custom connection created',
        })
    } catch (err: unknown) {
        logger.error({ err }, 'POST /api/connections/custom failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create custom connection' } })
    }
})

// ── POST /api/connections/test ────────────────────────────────────────────────
// Tests connectivity to an installed connection or a URL before connecting.

connectionsRouter.post('/test', async (req, res) => {
    const { url, authType, authValue, connectionId, workspaceId } = req.body as {
        url?: string
        authType?: string
        authValue?: string
        connectionId?: string
        workspaceId?: string
    }

    // If connectionId is provided, look up the stored URL/credentials
    let testUrl = url
    let testAuthType = authType
    let testAuthValue = authValue

    if (connectionId && workspaceId && UUID_RE.test(connectionId) && UUID_RE.test(workspaceId)) {
        try {
            const [row] = await db.select({
                credentials: installedConnections.credentials,
                registryId: installedConnections.registryId,
            }).from(installedConnections)
                .where(and(eq(installedConnections.id, connectionId), eq(installedConnections.workspaceId, workspaceId)))
                .limit(1)

            if (row) {
                const raw = row.credentials as Record<string, unknown>
                if (raw.encrypted) {
                    const decrypted = decrypt(raw.encrypted as string, workspaceId)
                    const creds = JSON.parse(decrypted) as Record<string, string>
                    testUrl = creds.url ?? testUrl
                    testAuthType = creds.authType ?? testAuthType
                    testAuthValue = creds.token ?? testAuthValue
                }
            }
        } catch (err) {
            logger.warn({ err }, 'Failed to look up connection for test')
        }
    }

    if (!testUrl) {
        res.status(400).json({ error: { code: 'NO_URL', message: 'URL required for testing' } })
        return
    }

    try {
        const headers: Record<string, string> = { 'User-Agent': 'Plexo/1.0' }
        if (testAuthValue) {
            if (testAuthType === 'bearer' || testAuthType === 'api_key') {
                headers['Authorization'] = `Bearer ${testAuthValue}`
            } else if (testAuthType === 'basic') {
                headers['Authorization'] = `Basic ${Buffer.from(testAuthValue).toString('base64')}`
            }
        }

        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 10_000)

        const r = await fetch(testUrl, {
            method: 'GET',
            headers,
            signal: controller.signal,
        })

        clearTimeout(timeout)

        res.json({
            ok: r.ok,
            status: r.status,
            statusText: r.statusText,
            contentType: r.headers.get('content-type') ?? 'unknown',
        })
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Connection failed'
        res.json({
            ok: false,
            status: 0,
            statusText: message,
            contentType: 'unknown',
        })
    }
})
