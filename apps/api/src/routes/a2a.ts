// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * A2A (Agent-to-Agent) Protocol Routes
 *
 * Full A2A spec compliance:
 *   GET  /.well-known/agent.json        — default agent discovery
 *   GET  /.well-known/agents            — list all agent cards
 *   GET  /api/v1/a2a/agents             — list agent cards (with workspaceId)
 *   GET  /api/v1/a2a/agents/:id/card    — single agent card
 *   POST /api/v1/a2a/:agentId/tasks     — submit task (A2A message format)
 *   GET  /api/v1/a2a/:agentId/tasks/:id — task status with artifacts + children
 */
import { Router, type Router as RouterType } from 'express'
import * as a2aRepo from '../repositories/a2a.repository.js'
import { push } from '@plexo/queue'
import { logger } from '../logger.js'
import { timingSafeEqual as cryptoTimingSafeEqual } from 'crypto'
import crypto from 'crypto'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'
import { resolveServiceAuth } from '../middleware/service-key-auth.js'
import { isSsrfTarget } from '../utils/ssrf.js'

export const a2aRouter: RouterType = Router()

const PUBLIC_URL = process.env.PUBLIC_URL ?? 'https://getplexo.com'

// ── Agent Card builder ──────────────────────────────────────────────────────

interface A2AAgentCard {
    name: string
    description: string
    url: string
    version: string
    capabilities: {
        streaming: boolean
        pushNotifications: boolean
        stateTransitionHistory: boolean
    }
    defaultInputModes: string[]
    defaultOutputModes: string[]
    skills: { id: string; name: string; description: string }[]
    authentication: { schemes: string[] }
}

function buildAgentCard(ext: { id: string; name: string; version: string; manifest: any }): A2AAgentCard {
    const m = ext.manifest ?? {}
    return {
        name: m.displayName ?? ext.name,
        description: m.description ?? '',
        url: `${PUBLIC_URL}/api/v1/a2a/${ext.id}/tasks`,
        version: ext.version,
        capabilities: {
            streaming: true,
            pushNotifications: true,
            stateTransitionHistory: true,
        },
        defaultInputModes: ['text', 'data'],
        defaultOutputModes: ['text', 'data'],
        skills: (m.capabilities ?? []).map((c: string) => ({
            id: c,
            name: c,
            description: `Capability: ${c}`,
        })),
        authentication: { schemes: ['Bearer'] },
    }
}

function defaultAgentCard(): A2AAgentCard {
    return {
        name: 'Plexo',
        description: 'AI agentic platform — autonomous task execution, skills, and multi-agent orchestration',
        url: `${PUBLIC_URL}/api/v1/a2a/default/tasks`,
        version: process.env.npm_package_version ?? '0.8.0',
        capabilities: {
            streaming: true,
            pushNotifications: true,
            stateTransitionHistory: true,
        },
        defaultInputModes: ['text', 'data'],
        defaultOutputModes: ['text', 'data'],
        skills: [],
        authentication: { schemes: ['Bearer'] },
    }
}

// ── GET /api/v1/a2a/agents — list all agent cards ───────────────────────────

a2aRouter.get('/agents', async (req, res) => {
    const { workspaceId } = req.query as { workspaceId?: string }

    const cards: A2AAgentCard[] = [defaultAgentCard()]

    if (workspaceId) {
        try {
            const agents = await a2aRepo.listAgentExtensions(workspaceId)
            cards.push(...agents.map(buildAgentCard))
        } catch (err) {
            logger.error({ err }, 'GET /a2a/agents failed to query extensions')
        }
    }

    res.json(cards)
})

// ── GET /api/v1/a2a/agents/:id/card — single agent card ────────────────────

a2aRouter.get('/agents/:id/card', async (req, res) => {
    if (req.params.id === 'default') {
        res.json(defaultAgentCard())
        return
    }

    try {
        const ext = await a2aRepo.getAgentExtension(req.params.id)

        if (!ext) {
            res.status(404).json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' } })
            return
        }

        res.json(buildAgentCard(ext))
    } catch (err) {
        logger.error({ err }, 'GET /a2a/agents/:id/card failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal error' } })
    }
})

// ── A2A Bearer auth helper ─────────────────────────────────────────────────
// Accepts either:
//   1. PLEXO_SERVICE_KEY as Bearer token (service-to-service)
//   2. Workspace API key (plx_...) as Bearer token — resolves workspaceId from the key
// Returns { workspaceId } on success, or sends an error response and returns null.

async function authenticateA2A(req: import('express').Request, res: import('express').Response, bodyWorkspaceId?: string): Promise<{ workspaceId: string } | null> {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authorization: Bearer <token> required' } })
        return null
    }
    const token = authHeader.slice(7)

    // Path 1: service auth — dual-accept the legacy shared PLEXO_SERVICE_KEY OR a
    // per-app key (psk_…). Either way the caller must name the workspace in the body.
    const headerAppId = req.headers['x-app-id'] as string | undefined
    const resolved = await resolveServiceAuth(token, headerAppId)
    if (resolved) {
        if (!bodyWorkspaceId) {
            res.status(400).json({ error: { code: 'MISSING_FIELD', message: 'workspaceId required when using service key auth' } })
            return null
        }
        return { workspaceId: bodyWorkspaceId }
    }

    // Path 2: Workspace API key (plx_...)
    if (token.startsWith('plx_')) {
        try {
            const allKeys = await a2aRepo.listActiveTokens()

            for (const key of allKeys) {
                const hash = crypto.createHash('sha256').update(token + key.tokenSalt).digest('hex')
                if (hash.length === key.tokenHash.length && cryptoTimingSafeEqual(Buffer.from(hash, 'utf-8'), Buffer.from(key.tokenHash, 'utf-8'))) {
                    // If body includes workspaceId, it must match the key's workspace
                    if (bodyWorkspaceId && bodyWorkspaceId !== key.workspaceId) {
                        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'API key does not belong to the specified workspace' } })
                        return null
                    }
                    await a2aRepo.touchTokenLastUsed(key.tokenHash, key.tokenSalt)
                        .catch((err: unknown) => logger.warn({ err }, 'failed to update token lastUsedAt — audit trail may be incomplete'))
                    return { workspaceId: key.workspaceId }
                }
            }
        } catch (err) {
            logger.error({ err }, 'A2A API key validation failed')
        }
    }

    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } })
    return null
}

// ── POST /api/v1/a2a/:agentId/tasks — submit task (A2A spec) ───────────────
// Auth required: Bearer token (PLEXO_SERVICE_KEY or workspace API key)

a2aRouter.post('/:agentId/tasks', async (req, res) => {
    const { agentId } = req.params

    // Accept A2A message format OR simple { workspaceId, message } format
    const body = req.body as {
        workspaceId?: string
        message?: string | { role?: string; parts?: { type: string; text: string }[] }
    }

    // Authenticate before processing
    const auth = await authenticateA2A(req, res, body.workspaceId)
    if (!auth) return // response already sent

    // Extract text from A2A message format
    let messageText: string
    if (typeof body.message === 'string') {
        messageText = body.message
    } else if (body.message?.parts) {
        messageText = body.message.parts
            .filter(p => p.type === 'text')
            .map(p => p.text)
            .join('\n')
    } else {
        res.status(400).json({ error: { code: 'MISSING_FIELD', message: 'message required (string or { role, parts: [{type:"text", text}] })' } })
        return
    }

    if (!messageText.trim()) {
        res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'message text cannot be empty' } })
        return
    }

    const workspaceId = auth.workspaceId

    try {
        const taskId = await push({
            workspaceId,
            type: 'general',
            source: 'a2a',
            context: {
                description: messageText,
                a2a: true,
                agentId: agentId === 'default' ? null : agentId,
            },
        })

        res.status(201).json({
            id: taskId,
            status: 'submitted',
            artifacts: [],
        })
    } catch (err) {
        logger.error({ err }, 'POST /a2a/:agentId/tasks failed')
        res.status(500).json({ error: { code: 'TASK_FAILED', message: 'Failed to create task' } })
    }
})

// ── GET /api/v1/a2a/:agentId/tasks/:id — task status + children ────────────

a2aRouter.get('/:agentId/tasks/:id', async (req, res) => {
    try {
        const auth = await authenticateA2A(req, res)
        if (!auth) return

        const task = await a2aRepo.getTask(req.params.id)

        if (!task) {
            res.status(404).json({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } })
            return
        }

        if (task.workspaceId !== auth.workspaceId) {
            res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access denied' } })
            return
        }

        // Query child tasks (sub-agent delegation)
        const children = await a2aRepo.listChildTasks(req.params.id)

        // Map Plexo status → A2A status
        const statusMap: Record<string, string> = {
            queued: 'submitted',
            claimed: 'working',
            running: 'working',
            complete: 'completed',
            blocked: 'failed',
            cancelled: 'canceled',
            awaiting_approval: 'input-required',
        }

        res.json({
            id: task.id,
            status: statusMap[task.status] ?? task.status,
            artifacts: task.deliverable ? [{ type: 'data', data: task.deliverable }] : [],
            result: task.outcomeSummary ?? null,
            children: children.map(c => ({
                id: c.id,
                status: statusMap[c.status] ?? c.status,
                result: c.outcomeSummary ?? null,
            })),
        })
    } catch (err) {
        logger.error({ err }, 'GET /a2a/:agentId/tasks/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal error' } })
    }
})

// ── POST /api/v1/a2a/agents/external — register an external A2A agent ────────
// Validates the URL's agent card and stores in extensions table.

a2aRouter.post('/agents/external', async (req, res) => {
    const { workspaceId, url, bearerToken } = req.body as {
        workspaceId?: string
        url?: string
        bearerToken?: string
    }

    if (!workspaceId || !url) {
        res.status(400).json({ error: { code: 'MISSING_FIELD', message: 'workspaceId and url required' } })
        return
    }

    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    if (isSsrfTarget(url)) {
        res.status(400).json({ error: { code: 'BLOCKED_URL', message: 'URL targets a restricted or private address' } })
        return
    }

    try {
        const cardUrl = `${url.replace(/\/$/, '')}/.well-known/agent.json`
        const cardRes = await fetch(cardUrl, {
            headers: bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {},
            signal: AbortSignal.timeout(10_000),
        })
        if (!cardRes.ok) {
            res.status(400).json({ error: { code: 'INVALID_REQUEST', message: `Failed to fetch agent card from ${cardUrl}: ${cardRes.status}` } })
            return
        }
        const card = await cardRes.json() as Record<string, unknown>
        if (!card.name || !card.url) {
            res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid A2A agent card: missing name or url' } })
            return
        }

        const agentName = `a2a-external:${String(card.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`

        const existing = await a2aRepo.getExtensionByName(workspaceId, agentName)

        if (existing) {
            await a2aRepo.updateExternalAgent(existing.id, { ...card, externalUrl: url, bearerToken: bearerToken ?? null })
            res.json({ id: existing.id, name: agentName, updated: true })
            return
        }

        const row = await a2aRepo.insertExternalAgent({
            workspaceId,
            name: agentName,
            version: String(card.version ?? '1.0.0'),
            type: 'agent',
            entry: String(card.url),
            manifest: { ...card, externalUrl: url, source: 'a2a-external', bearerToken: bearerToken ?? null },
            enabled: true,
            source: 'a2a-external',
        })

        res.status(201).json({ id: row.id, name: agentName, card })
    } catch (err) {
        logger.error({ err }, 'POST /a2a/agents/external failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal error' } })
    }
})

// ── .well-known handlers (mounted at app level, no auth) ────────────────────

export function wellKnownAgentHandler(): RouterType {
    const router: RouterType = Router()

    // A2A spec — single default agent card
    router.get('/agent.json', async (_req, res) => {
        res.json(defaultAgentCard())
    })

    // Plexo extension — list all agent cards
    router.get('/agents', async (_req, res) => {
        const cards: A2AAgentCard[] = [defaultAgentCard()]

        // If there's a default workspace, include its agents
        try {
            const ws = await a2aRepo.getFirstWorkspaceId()
            if (ws) {
                const agents = await a2aRepo.listAgentExtensions(ws.id)
                cards.push(...agents.map(buildAgentCard))
            }
        } catch (err) {
            logger.warn({ err }, '.well-known/agents failed to query extensions')
        }

        res.json(cards)
    })

    return router
}
