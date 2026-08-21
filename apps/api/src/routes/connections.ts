// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

// UI term: "Integrations" — route path preserved as /connections for backward compatibility

/**
 * Integrations API (DB tables: connectionsRegistry, installedConnections)
 *
 * GET    /api/connections/registry              All available integrations
 * GET    /api/connections/registry/:id          Single integration detail
 * GET    /api/connections/installed?workspaceId Installed integrations for a workspace
 * POST   /api/connections/install               Install an integration
 * PATCH  /api/connections/installed/:id         Update settings/credentials/status
 * PUT    /api/connections/installed/:id/tools   Replace enabled tool list
 * DELETE /api/connections/installed/:id         Uninstall
 */
import { timingSafeEqual } from 'node:crypto'
import { Router, type Router as RouterType } from 'express'
import { isSsrfTarget, safeFetch } from '../utils/ssrf.js'
import * as connectionsRepo from '../repositories/connections.repository.js'
import { encrypt, decrypt } from '../crypto.js'
import { encryptSensitiveConfigKeys } from '../lib/channel-config-crypto.js'
import { logger } from '../logger.js'
import { trackEvent } from '../event-tracker.js'
import { UUID_RE } from '../validation.js'
import { audit } from '../audit.js'
import { getRegistryStub, liveConnectionTools } from '../services/connections.service.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'
import { invalidateWorkspaceToolSets } from '@plexo/agent/tool-set-cache'

function redactCredentials(obj: Record<string, unknown>): Record<string, string> {
    const redacted: Record<string, string> = {}
    for (const key of Object.keys(obj)) {
        redacted[key] = '***'
    }
    return redacted
}

/** Allow Joeybuilt service apps (Levio, Fylo, etc.) to call workspace-scoped endpoints. */
function isServiceKeyRequest(req: { headers: Record<string, string | string[] | undefined> }): boolean {
    const svcKey = process.env.PLEXO_SERVICE_KEY
    const rawToken = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    const xAppId = req.headers['x-app-id']
    if (!svcKey || !rawToken || !xAppId) return false
    const a = Buffer.from(rawToken)
    const b = Buffer.from(svcKey)
    return a.length === b.length && timingSafeEqual(a, b)
}


/**
 * Maps integration registry IDs → MCP server binding metadata.
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
        const items = await connectionsRepo.listRegistry()
        // Augment each item with mcpPackage and stub flag from in-memory registry
        const augmented = items.map(item => ({
            ...item,
            mcpPackage: MCP_BINDINGS[item.id]?.mcpPackage ?? null,
            stub: getRegistryStub(item.id),
        }))
        res.json({ items: augmented, total: augmented.length })
    } catch (err: unknown) {
        logger.error({ err }, 'GET /api/connections/registry failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load registry' } })
    }
})


// ── GET /api/connections/registry/:id ────────────────────────────────────────

const REGISTRY_ID_RE = /^[a-z0-9_-]{1,100}$/i

connectionsRouter.get('/registry/:id', async (req, res) => {
    const { id } = req.params
    if (!REGISTRY_ID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid registry ID required' } })
        return
    }
    try {
        const item = await connectionsRepo.getRegistryById(id)
        if (!item) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Integration not found in registry' } })
            return
        }
        res.json(item)
    } catch (err: unknown) {
        logger.error({ err, id }, 'GET /api/connections/registry/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load integration' } })
    }
})

// ── GET /api/connections/installed ───────────────────────────────────────────

connectionsRouter.get('/github/repos', async (req, res) => {
    const { workspaceId } = req.query as Record<string, string>

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const row = await connectionsRepo.getActiveCredentialsByRegistry(workspaceId, 'github')

        if (!row) {
            res.status(404).json({ error: { code: 'NOT_CONNECTED', message: 'GitHub not connected for this workspace' } })
            return
        }

        let token = ''
        const raw = row.credentials as Record<string, unknown>
        if (raw.encrypted) {
            const decrypted = decrypt(raw.encrypted as string, workspaceId)
            let creds: Record<string, string>
            try {
                creds = JSON.parse(decrypted) as Record<string, string>
            } catch (parseErr) {
                logger.error({ err: parseErr, workspaceId, credentials: redactCredentials(raw) }, 'Failed to parse decrypted credentials for GitHub repos')
                res.status(500).json({ error: { code: 'CREDENTIAL_CORRUPT', message: 'Stored credential is corrupted' } })
                return
            }
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
            signal: AbortSignal.timeout(8_000),
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
        logger.error({ err, workspaceId }, 'GET /api/connections/github/repos failed')
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
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const row = await connectionsRepo.getActiveCredentialsByRegistry(workspaceId, 'github')

        if (!row) {
            res.status(404).json({ error: { code: 'NOT_CONNECTED', message: 'GitHub not connected for this workspace' } })
            return
        }

        let token = ''
        const raw = row.credentials as Record<string, unknown>
        if (raw.encrypted) {
            const decrypted = decrypt(raw.encrypted as string, workspaceId)
            let creds: Record<string, string>
            try {
                creds = JSON.parse(decrypted) as Record<string, string>
            } catch (parseErr) {
                logger.error({ err: parseErr, workspaceId, credentials: redactCredentials(raw) }, 'Failed to parse decrypted credentials for GitHub branches')
                res.status(500).json({ error: { code: 'CREDENTIAL_CORRUPT', message: 'Stored credential is corrupted' } })
                return
            }
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
            signal: AbortSignal.timeout(8_000),
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
        logger.error({ err, workspaceId }, 'GET /api/connections/github/branches failed')
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
    if (transport === 'sse' && url && isSsrfTarget(url)) {
        res.status(400).json({ error: { code: 'BLOCKED_URL', message: 'URL targets a restricted or invalid address' } })
        return
    }
    if (transport === 'stdio' && !command) {
        res.status(400).json({ error: { code: 'MISSING_COMMAND', message: 'stdio transport requires a command' } })
        return
    }
    if (args && args.length > 2048) {
        res.status(400).json({ error: { code: 'ARGS_TOO_LONG', message: 'args must be under 2048 characters' } })
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
        // Redact URL to avoid logging auth tokens in query params
        const safeUrl = url ? (() => { try { const u = new URL(url); u.search = ''; return u.toString() } catch { return '[invalid url]' } })() : undefined
        logger.warn({ err, transport, url: safeUrl, command }, 'MCP discovery failed')
        res.status(502).json({ error: { code: 'MCP_DISCOVERY_FAILED', message: msg } })
    }
})

connectionsRouter.get('/installed', async (req, res) => {
    const { workspaceId } = req.query as Record<string, string>

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!isServiceKeyRequest(req) && !await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const items = await connectionsRepo.listInstalled(workspaceId)

        res.json({ items, total: items.length })
    } catch (err: unknown) {
        logger.error({ err }, 'GET /api/connections/installed failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load installed integrations' } })
    }
})

// ── POST /api/connections/install ─────────────────────────────────────────────

connectionsRouter.post('/install', async (req, res) => {
    const { workspaceId, registryId, credentials = {}, name, label } = req.body as {
        workspaceId?: string
        registryId?: string
        credentials?: Record<string, string>
        name?: string
        label?: string
    }

    if (!workspaceId || !UUID_RE.test(workspaceId) || !registryId) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId and registryId required' } })
        return
    }
    if (typeof registryId !== 'string' || registryId.length > 100) {
        res.status(400).json({ error: { code: 'INVALID_REGISTRY_ID', message: 'registryId must be a string, max 100 chars' } })
        return
    }
    if (typeof credentials !== 'object' || Array.isArray(credentials) || credentials === null) {
        res.status(400).json({ error: { code: 'INVALID_CREDENTIALS', message: 'credentials must be an object' } })
        return
    }
    if (Object.keys(credentials).length > 20 || JSON.stringify(credentials).length > 10_000) {
        res.status(400).json({ error: { code: 'CREDENTIALS_TOO_LARGE', message: 'credentials exceeds size limit' } })
        return
    }
    if (!isServiceKeyRequest(req) && !await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const reg = await connectionsRepo.getRegistryInstallMeta(registryId)

        if (!reg) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Integration not found in registry' } })
            return
        }

        // Encrypt credentials at rest with workspace-scoped AES-256-GCM key (integration install)
        const encryptedCreds = Object.keys(credentials).length > 0
            ? { encrypted: encrypt(JSON.stringify(credentials), workspaceId) }
            : {}

        const installed = await connectionsRepo.insertInstalled({
            workspaceId,
            registryId: reg.id,
            name: name ?? reg.name,
            label: label ?? 'default',
            credentials: encryptedCreds,
            status: 'active',
        })

        logger.info({ workspaceId, registryId, name: reg.name }, 'Integration installed')
        invalidateWorkspaceToolSets(workspaceId)
        trackEvent('connection.installed', 'info', { workspaceId, registryId: reg.id, name: reg.name })

        // Analytics: integration installed (no connection details — type only)
        try {
            const { emitConnectionInstalled } = await import('../analytics/events.js')
            emitConnectionInstalled({ connectionType: registryId, source: 'web' })
        } catch (err) { logger.debug({ err }, 'analytics event failed (non-fatal)') }

        // Bridge: communication integrations auto-create a channel record so the
        // webhook handler picks them up. This eliminates the Integrations/Channels
        // split for messaging services — connect once, works everywhere.
        const CHANNEL_TYPES = ['telegram', 'slack', 'discord', 'whatsapp', 'signal', 'matrix'] as const
        if (reg.category === 'communication' && CHANNEL_TYPES.includes(registryId as any)) {
            try {
                const channelConfig = encryptSensitiveConfigKeys(registryId, { ...credentials }, workspaceId)
                const ch = await connectionsRepo.insertBridgedChannel({
                    workspaceId,
                    type: registryId as typeof CHANNEL_TYPES[number],
                    name: name ?? reg.name,
                    config: channelConfig,
                    enabled: true,
                })

                if (ch) {
                    logger.info({ workspaceId, channelType: registryId, channelId: ch.id }, 'Auto-created channel from integration')

                    // Auto-register webhook for Telegram
                    if (registryId === 'telegram') {
                        const token = credentials.bot_token ?? credentials.token ?? null
                        if (token) {
                            const { registerTelegramChannel } = await import('./telegram.js')
                            void registerTelegramChannel(ch.id, token, workspaceId).catch(
                                (err: Error) => logger.warn({ err }, 'Telegram webhook auto-register from integration failed'),
                            )
                        }
                    }
                }
            } catch (chErr) {
                // Non-fatal — the integration itself succeeded
                logger.warn({ err: chErr, registryId }, 'Failed to auto-create channel from integration — non-fatal')
            }
        }

        // Bridge: MCP integrations auto-discover tools on install
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
                    await connectionsRepo.setEnabledToolsById(installed!.id, mcpTools)
                }
                logger.info({ connectionId: installed!.id, toolCount: mcpTools.length }, 'MCP tools discovered on integration install')

                // Analytics: MCP connected
                try {
                    const { emitConnectionInstalled } = await import('../analytics/events.js')
                    emitConnectionInstalled({ connectionType: 'mcp', source: 'web' })
                } catch (err) { logger.debug({ err }, 'analytics event failed (non-fatal)') }
            } catch (mcpErr) {
                logger.warn({ err: mcpErr, registryId }, 'MCP tool discovery failed on install — integration saved without tools')
            }
        }

        res.status(201).json({ id: installed!.id, message: 'Integration installed', ...(mcpTools ? { discoveredTools: mcpTools } : {}) })
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
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const update: Record<string, unknown> = {}
        if (status) update.status = status
        if (credentials && Object.keys(credentials).length > 0) {
            update.credentials = { encrypted: encrypt(JSON.stringify(credentials), workspaceId) }
        }

        await connectionsRepo.updateInstalledScoped(id, workspaceId, update)

        invalidateWorkspaceToolSets(workspaceId)
        if (status) trackEvent('connection.status_updated', 'info', { connectionId: id, workspaceId, status })
        res.json({ ok: true })
    } catch (err: unknown) {
        logger.error({ err, id }, 'PATCH /api/connections/installed/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Update failed' } })
    }
})

// ── GET /api/connections/installed/:id/tools ─────────────────────────────────
// Returns the live tool list (from CONNECTION_REGISTRY) plus the current
// enabled subset. Used by the Tool Toggle UI and the agent introspection path.

connectionsRouter.get('/installed/:id/tools', async (req, res) => {
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
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const row = await connectionsRepo.getInstalledToolsScoped(id, workspaceId)

        if (!row) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Installed integration not found' } })
            return
        }

        const tools = liveConnectionTools(row.registryId)
        const enabled = row.enabledTools as string[] | null

        // Annotate each tool with its enabled state. `null` = all enabled.
        const annotated = tools.map((t) => ({
            ...t,
            enabled: enabled === null || enabled.includes(t.shortName) || enabled.includes(t.name),
        }))

        res.json({
            connectionId: row.id,
            registryId: row.registryId,
            allEnabled: enabled === null,
            enabledTools: enabled,
            tools: annotated,
            total: annotated.length,
            enabledCount: annotated.filter((t) => t.enabled).length,
        })
    } catch (err: unknown) {
        logger.error({ err, id }, 'GET /api/connections/installed/:id/tools failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load tool list' } })
    }
})

// ── PUT /api/connections/installed/:id/tools ──────────────────────────────────
// Replaces the enabled tools list. Accepts either a fully-resolved list or a
// `mode` shortcut ("read-only" disables every tool matching WRITE_TOOL_PATTERNS).
//   body.enabledTools — string[] | null   (null = enable all)
//   body.mode         — 'read-only' | 'all' | undefined
//
// Writes an audit_log entry with the old and new enabled_tools arrays.

connectionsRouter.put('/installed/:id/tools', async (req, res) => {
    const { id } = req.params
    if (!UUID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }
    const { workspaceId, enabledTools, mode } = req.body as {
        workspaceId?: string
        enabledTools?: string[] | null
        mode?: 'read-only' | 'all'
    }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        // Look up the connection so we can validate against the live registry
        const row = await connectionsRepo.getInstalledToolsScoped(id, workspaceId)

        if (!row) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Installed integration not found' } })
            return
        }

        const liveTools = liveConnectionTools(row.registryId)

        // Resolve the next enabled_tools value from body.mode OR body.enabledTools
        let next: string[] | null
        if (mode === 'all') {
            next = null
        } else if (mode === 'read-only') {
            // Keep only non-write tools. Stored as SHORT names — bridge.ts accepts
            // either short or fully-qualified names.
            next = liveTools.filter((t) => !t.isWrite).map((t) => t.shortName)
        } else if (enabledTools === null) {
            next = null
        } else if (Array.isArray(enabledTools)) {
            // Validate: every entry must correspond to a real tool in the registry.
            // Allow either short name ('create_page') or fully-qualified ('notion__create_page').
            const validShort = new Set(liveTools.map((t) => t.shortName))
            const validFull = new Set(liveTools.map((t) => t.name))
            const invalid = enabledTools.filter((t) => !validShort.has(t) && !validFull.has(t))
            if (invalid.length > 0) {
                res.status(400).json({
                    error: {
                        code: 'UNKNOWN_TOOL',
                        message: `Unknown tool(s) for this integration: ${invalid.join(', ')}`,
                    },
                })
                return
            }
            next = enabledTools
        } else {
            res.status(400).json({ error: { code: 'INVALID_BODY', message: 'Provide enabledTools or mode' } })
            return
        }

        const previous = row.enabledTools as string[] | null

        await connectionsRepo.setEnabledToolsScoped(id, workspaceId, next)

        audit(req, {
            workspaceId,
            action: 'connection_tools_updated',
            resource: 'installed_connections',
            resourceId: id,
            metadata: {
                registryId: row.registryId,
                mode: mode ?? 'explicit',
                previous,
                next,
                previousCount: previous === null ? 'all' : previous.length,
                nextCount: next === null ? 'all' : next.length,
            },
        })

        logger.info(
            { id, workspaceId, registryId: row.registryId, mode: mode ?? 'explicit', count: next?.length ?? 'all' },
            'Integration tools updated',
        )
        invalidateWorkspaceToolSets(workspaceId)
        res.json({
            ok: true,
            enabledTools: next,
            allEnabled: next === null,
        })
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
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        // Read the integration before deleting so we can clean up the channel bridge
        const conn = await connectionsRepo.getInstalledRegistryIdScoped(id, workspaceId)

        await connectionsRepo.deleteInstalledScoped(id, workspaceId)

        // Bridge cleanup: remove the auto-created channel when a communication integration is disconnected
        const CHANNEL_TYPES = ['telegram', 'slack', 'discord', 'whatsapp', 'signal', 'matrix'] as const
        if (conn && CHANNEL_TYPES.includes(conn.registryId as any)) {
            await connectionsRepo.deleteBridgedChannel(workspaceId, conn.registryId as any)
                .catch((err: unknown) => logger.warn({ err }, 'Failed to clean up bridged channel — non-fatal'))
        }

        logger.info({ id, workspaceId, registryId: conn?.registryId }, 'Integration uninstalled')
        invalidateWorkspaceToolSets(workspaceId)
        trackEvent('connection.uninstalled', 'info', { connectionId: id, workspaceId })
        res.json({ ok: true })
    } catch (err: unknown) {
        logger.error({ err, id }, 'DELETE /api/connections/installed/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Uninstall failed' } })
    }
})

// ── GET /api/connections/mcp-config ──────────────────────────────────────────
// Returns the combined mcpServers JSON block for all connected MCP-capable
// integrations. The `preview` query param (='1') redacts token values.
// At agent boot the engine calls this with preview=0 to get live credentials.

connectionsRouter.get('/mcp-config', async (req, res) => {
    const { workspaceId, preview } = req.query as Record<string, string>

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    const isPreview = preview === '1' || preview === 'true'

    try {
        const rows = await connectionsRepo.listInstalledForMcpConfig(workspaceId)

        const mcpServers: Record<string, unknown> = {}

        // Look up registry entries for custom MCP integrations
        const regRows = await connectionsRepo.listRegistryMcpMeta()

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
                            let creds: Record<string, string>
try {
                creds = JSON.parse(decrypted) as Record<string, string>
            } catch (parseErr) {
                logger.error({ err: parseErr, workspaceId }, 'Failed to parse decrypted credentials for GitHub repos')
                res.status(500).json({ error: { code: 'CREDENTIAL_CORRUPT', message: 'Stored credential is corrupted' } })
                return
            }
                            tokenValue = Object.values(creds).find(v => v) ?? ''
                        }
                    } catch (decryptErr) {
                        logger.error({ err: decryptErr, registryId: row.registryId, credentials: redactCredentials(row.credentials as Record<string, unknown>) }, 'Failed to decrypt credentials for MCP config — tool will be unavailable')
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

            // Handle custom MCP integrations (generated registry entries with category 'mcp')
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
                        logger.error({ err: decryptErr, registryId: row.registryId, credentials: redactCredentials(row.credentials as Record<string, unknown>) }, 'Failed to decrypt credentials for custom MCP config — tool will be unavailable')
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
// installed integration. Requires PLEXO_SERVICE_KEY auth.
// Used by Joeybuilt apps (Levio, Fylo, etc.) to retrieve OAuth tokens stored in Plexo.
//
// Query params:
//   workspaceId  UUID of the workspace
//   registryId   ID of the connection (e.g. 'google-workspace')
//   connectionId (optional) UUID of a specific installed connection — when provided,
//                fetches that exact connection instead of the first match by registryId.

import { requireServiceKey } from '../middleware/service-key-auth.js'
import { refreshAndPersistCredentials, type GmailCredentials } from '../lib/gmail-client.js'

connectionsRouter.get('/token', requireServiceKey, async (req, res) => {
    const { workspaceId, registryId, connectionId } = req.query as Record<string, string>

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!registryId || typeof registryId !== 'string' || registryId.length > 100) {
        res.status(400).json({ error: { code: 'INVALID_REGISTRY_ID', message: 'registryId required' } })
        return
    }

    try {
        // When connectionId is provided, fetch that exact connection
        const row = await connectionsRepo.getTokenRow(
            workspaceId,
            registryId,
            connectionId && UUID_RE.test(connectionId) ? connectionId : undefined,
        )

        if (!row) {
            res.status(404).json({ error: { code: 'NOT_CONNECTED', message: `${registryId} not connected for this workspace` } })
            return
        }

        const raw = row.credentials as Record<string, unknown>
        const encryptedCreds = raw.encrypted as string | undefined
        if (!encryptedCreds) {
            res.status(500).json({ error: { code: 'NO_CREDENTIALS', message: 'No encrypted credentials found' } })
            return
        }

        try {
            const decrypted = decrypt(encryptedCreds, workspaceId)
            let creds: Record<string, unknown>
            try {
                creds = JSON.parse(decrypted) as Record<string, string>
            } catch (parseErr) {
                logger.error({ err: parseErr, workspaceId, credentials: redactCredentials(raw) }, 'Failed to parse decrypted credentials for token endpoint')
                res.status(500).json({ error: { code: 'CREDENTIAL_CORRUPT', message: 'Stored credential is corrupted' } })
                return
            }

            res.json({
                access_token: creds.access_token ?? null,
                refresh_token: creds.refresh_token ?? null,
                expires_at: creds.expires_at ?? null,
                email: creds.email ?? null,
                scope: creds.scope ?? null,
            })
        } catch (err: unknown) {
            logger.error({ err, credentials: redactCredentials(raw) }, 'GET /api/connections/token failed')
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to retrieve token' } })
        }
    } catch (err: unknown) {
        logger.error({ err }, 'GET /api/connections/token failed (outer)')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to retrieve token' } })
    }
})

// ── GET /api/connections/tokens ───────────────────────────────────────────────
// Returns ALL active connections for a registryId, each with decrypted credentials.
// Used when a workspace has multiple accounts of the same type (e.g. 4 Google accounts).

connectionsRouter.get('/tokens', requireServiceKey, async (req, res) => {
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
        const rows = await connectionsRepo.listActiveCredentials(workspaceId, registryId)

        const tokens: Array<{ connectionId: string; access_token: string | null; refresh_token: string | null; expires_at: string | null; email: string | null; scope: string | null }> = []

        for (const row of rows) {
            const raw = row.credentials as Record<string, unknown>
            if (!raw.encrypted) continue
            try {
                const decrypted = decrypt(raw.encrypted as string, workspaceId)
                let creds = JSON.parse(decrypted) as Record<string, unknown>
                // Lazy refresh-on-read: external apps (Levio/Fylo) get a usable
                // token even when the stored access token has expired. Google
                // access tokens last ~1h and nothing else refreshes these for
                // multi-account consumers, so they'd otherwise receive stale
                // expired tokens. Refresh + persist when within 60s of expiry.
                const expMs = creds.expires_at ? Date.parse(creds.expires_at as string) : NaN
                if (!Number.isNaN(expMs) && expMs - Date.now() < 60_000 && creds.refresh_token) {
                    const refreshed = await refreshAndPersistCredentials(row.id, workspaceId, creds as unknown as GmailCredentials)
                    if (refreshed) creds = refreshed as unknown as Record<string, unknown>
                }
                tokens.push({
                    connectionId: row.id,
                    access_token: (creds.access_token as string) ?? null,
                    refresh_token: (creds.refresh_token as string) ?? null,
                    expires_at: (creds.expires_at as string) ?? null,
                    email: (creds.email as string) ?? null,
                    scope: (creds.scope as string) ?? null,
                })
            } catch {
                // Skip corrupted credentials
            }
        }

        res.json(tokens)
    } catch (err: unknown) {
        logger.error({ err, workspaceId, registryId }, 'GET /api/connections/tokens failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to retrieve tokens' } })
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
// Creates a custom integration (MCP server or custom API) that bypasses the
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
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return
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
        await connectionsRepo.insertCustomRegistry({
            id: registryId,
            name,
            description: description || (type === 'mcp' ? `Custom connector at ${url}` : `Custom API at ${url}`),
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
        const installed = await connectionsRepo.insertInstalled({
            workspaceId,
            registryId,
            name,
            credentials: encryptedCreds,
            status: 'active',
            enabledTools: null,
        })

        logger.info({ workspaceId, registryId, type, name }, 'Custom integration created')
        trackEvent('connection.custom_created', 'info', { workspaceId, registryId, type, name })

        res.status(201).json({
            id: installed!.id,
            registryId,
            message: 'Custom integration created',
        })
    } catch (err: unknown) {
        logger.error({ err }, 'POST /api/connections/custom failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create custom integration' } })
    }
})

// ── POST /api/connections/test ────────────────────────────────────────────────
// Tests connectivity to an installed integration or a URL before connecting.

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
            const row = await connectionsRepo.getInstalledForTest(connectionId, workspaceId)

            if (row?.registryId === 'gmessages') {
                // Paired-session connections have no URL — check session state from DB
                // plus the sidecar's /health to confirm the session is alive in-process,
                // not just paired-in-DB.
                const session = await connectionsRepo.getPairedSessionForTest(connectionId, workspaceId)

                if (!session) {
                    res.json({ ok: false, status: 0, statusText: 'No paired session found — re-pair your phone', contentType: 'paired_session' })
                    return
                }
                const dbHealthy = session.state === 'active' || session.state === 'refreshing'
                let sidecarOk = false
                let sidecarActive = 0
                try {
                    const url = (process.env.GMESSAGES_SIDECAR_URL ?? 'http://gmessages:3010') + '/health'
                    const r = await fetch(url, { signal: AbortSignal.timeout(3_000) })
                    if (r.ok) {
                        const h = await r.json() as { ok?: boolean; activeSessions?: number }
                        sidecarOk = !!h.ok
                        sidecarActive = typeof h.activeSessions === 'number' ? h.activeSessions : 0
                    }
                } catch (err) {
                    logger.warn({ err }, 'gmessages sidecar /health probe failed in connections/test')
                }
                const ok = dbHealthy && sidecarOk && sidecarActive >= 1
                let detail: string
                if (ok) {
                    detail = `session ${session.state}, sidecar reports ${sidecarActive} active session${sidecarActive === 1 ? '' : 's'}`
                } else if (!sidecarOk) {
                    detail = 'sidecar /health unreachable — gmessages container down?'
                } else if (sidecarActive < 1) {
                    detail = `session ${session.state} in DB but sidecar reports 0 active sessions — likely needs re-pair`
                } else if (session.state === 'errored' && session.errorDetail) {
                    detail = `${session.state}: ${session.errorDetail}`
                } else {
                    detail = session.state
                }
                res.json({ ok, status: ok ? 200 : 0, statusText: detail, contentType: 'paired_session' })
                return
            }

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
            logger.warn({ err, connectionId, workspaceId }, 'Failed to look up connection for test')
        }
    }

    if (!testUrl) {
        res.status(400).json({ error: { code: 'NO_URL', message: 'URL required for testing' } })
        return
    }

    if (isSsrfTarget(testUrl)) {
        res.status(400).json({ error: { code: 'BLOCKED_URL', message: 'URL targets a restricted or invalid address' } })
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

        // safeFetch: DNS-validates + manual-redirect re-validation (SEC1 / ADR 0039)
        const r = await safeFetch(testUrl, {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(10_000),
        })

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

// ── POST /api/connections/ssh/test ──────────────────────────────────────────
// Test an SSH connection without storing credentials.

connectionsRouter.post('/ssh/test', async (req, res) => {
    const { host, port, username, auth_method, private_key, password } = req.body as {
        host?: string
        port?: string | number
        username?: string
        auth_method?: string
        private_key?: string
        password?: string
    }

    if (!host || !username) {
        res.status(400).json({ ok: false, message: 'Host and username are required.' })
        return
    }
    if (host.length > 253 || username.length > 64) {
        res.status(400).json({ ok: false, message: 'Host or username too long.' })
        return
    }
    const portNum = Number(port ?? 22)
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        res.status(400).json({ ok: false, message: 'Port must be 1–65535.' })
        return
    }

    try {
        const { sshTest } = await import('@plexo/agent/ssh/client')
        const result = await sshTest({
            host,
            port: portNum,
            username,
            privateKey: auth_method === 'Private Key' ? private_key : undefined,
            password: auth_method === 'Password' ? password : undefined,
        })
        res.json(result)
    } catch (err) {
        res.json({ ok: false, message: err instanceof Error ? err.message : 'Test failed', durationMs: 0 })
    }
})
