// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Agent Behavior Configuration API (Phase 5).
 *
 * GET    /api/v1/behavior/:workspaceId                  → rules list
 * GET    /api/v1/behavior/:workspaceId/groups           → group definitions
 * GET    /api/v1/behavior/:workspaceId/resolve          → compiled ResolvedBehavior
 * GET    /api/v1/behavior/:workspaceId/snapshots        → version history
 * POST   /api/v1/behavior/:workspaceId/rules            → create rule
 * PATCH  /api/v1/behavior/:workspaceId/rules/:ruleId   → update rule
 * DELETE /api/v1/behavior/:workspaceId/rules/:ruleId   → soft delete
 */

import { Router, type IRouter } from 'express'
import type { Request, Response } from 'express'
import { db, eq, and, isNull, isNotNull, desc, or } from '@plexo/db'
import { behaviorRules, behaviorSnapshots } from '@plexo/db'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'

// Lazy-import to avoid circular deps during startup
async function getResolver() {
    const { resolveBehavior } = await import('@plexo/agent/behavior/resolver')
    return resolveBehavior
}
async function getGroups() {
    const { PLATFORM_DEFAULT_GROUPS } = await import('@plexo/agent/behavior/types')
    return PLATFORM_DEFAULT_GROUPS
}
async function getImportParser() {
    const { parseAgentsMd } = await import('@plexo/agent/behavior/import')
    return parseAgentsMd
}
async function getExportGenerator() {
    const { generateAgentsMd } = await import('@plexo/agent/behavior/export')
    return generateAgentsMd
}

export const behaviorRouter: IRouter = Router({ mergeParams: true })

const VALID_TYPES = new Set(['safety_constraint', 'operational_rule', 'communication_style', 'domain_knowledge', 'persona_trait', 'tool_preference', 'quality_gate'])

function badId(res: Response, param = 'workspaceId') {
    res.status(400).json({ error: { code: 'INVALID_ID', message: `${param} must be a valid UUID` } })
}

// ── GET / — workspace rules (optionally filtered by projectId) ───────────────

behaviorRouter.get('/', async (req: Request, res: Response) => {
    const workspaceId = req.params['workspaceId'] as string
    if (!UUID_RE.test(workspaceId)) return void badId(res)
    const projectId = (req.query['projectId'] as string | undefined) ?? null
    if (projectId && !UUID_RE.test(projectId)) return void badId(res, 'projectId')

    try {
        let rows
        if (projectId) {
            rows = await db.select().from(behaviorRules).where(
                and(
                    eq(behaviorRules.workspaceId, workspaceId),
                    isNull(behaviorRules.deletedAt),
                    or(
                        isNull(behaviorRules.projectId),
                        eq(behaviorRules.projectId, projectId),
                    ),
                )
            ).orderBy(behaviorRules.createdAt)
        } else {
            rows = await db.select().from(behaviorRules).where(
                and(
                    eq(behaviorRules.workspaceId, workspaceId),
                    isNull(behaviorRules.projectId),
                    isNull(behaviorRules.deletedAt),
                )
            ).orderBy(behaviorRules.createdAt)
        }
        res.json({ rules: rows })
    } catch (err) {
        logger.error({ err }, 'GET /behavior failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch behavior rules' } })
    }
})

// ── GET /groups ──────────────────────────────────────────────────────────────

behaviorRouter.get('/groups', async (_req: Request, res: Response) => {
    try {
        const groups = await getGroups()
        res.json({ groups })
    } catch (err) {
        logger.error({ err }, 'GET /behavior/groups failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load groups' } })
    }
})

// ── GET /resolve — preview compiled behavior (no snapshot) ──────────────────

behaviorRouter.get('/resolve', async (req: Request, res: Response) => {
    const workspaceId = req.params['workspaceId'] as string
    if (!UUID_RE.test(workspaceId)) return void badId(res)
    const projectId = (req.query['projectId'] as string | undefined) ?? null
    if (projectId && !UUID_RE.test(projectId)) return void badId(res, 'projectId')

    try {
        const resolveBehavior = await getResolver()
        const resolved = await resolveBehavior(workspaceId, projectId, [], { snapshot: false })
        res.json(resolved)
    } catch (err) {
        logger.error({ err }, 'GET /behavior/resolve failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to resolve behavior' } })
    }
})

// ── GET /snapshots ───────────────────────────────────────────────────────────

behaviorRouter.get('/snapshots', async (req: Request, res: Response) => {
    const workspaceId = req.params['workspaceId'] as string
    if (!UUID_RE.test(workspaceId)) return void badId(res)
    const limit = Math.min(parseInt((req.query['limit'] as string) ?? '20'), 50)

    try {
        const rows = await db.select({
            id: behaviorSnapshots.id,
            workspaceId: behaviorSnapshots.workspaceId,
            projectId: behaviorSnapshots.projectId,
            compiledPrompt: behaviorSnapshots.compiledPrompt,
            triggeredBy: behaviorSnapshots.triggeredBy,
            triggerResourceId: behaviorSnapshots.triggerResourceId,
            createdAt: behaviorSnapshots.createdAt,
        }).from(behaviorSnapshots)
            .where(eq(behaviorSnapshots.workspaceId, workspaceId))
            .orderBy(desc(behaviorSnapshots.createdAt))
            .limit(limit)
        res.json({ snapshots: rows })
    } catch (err) {
        logger.error({ err }, 'GET /behavior/snapshots failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch snapshots' } })
    }
})

// ── POST /rules ──────────────────────────────────────────────────────────────

behaviorRouter.post('/rules', async (req: Request, res: Response) => {
    const workspaceId = req.params['workspaceId'] as string
    if (!UUID_RE.test(workspaceId)) return void badId(res)
    const { projectId, type, key, label, description, value, tags } = req.body as {
        projectId?: string | null
        type: string
        key: string
        label: string
        description?: string
        value: Record<string, unknown>
        tags?: string[]
    }

    if (!type || !key || !label || !value) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'type, key, label, value required' } })
        return
    }
    if (!VALID_TYPES.has(type)) {
        res.status(400).json({ error: { code: 'INVALID_TYPE', message: `type must be one of: ${[...VALID_TYPES].join(', ')}` } })
        return
    }
    if (key.length > 80 || !/^[a-z0-9_]+$/.test(key)) {
        res.status(400).json({ error: { code: 'INVALID_KEY', message: 'key must be lowercase alphanumeric/underscore, max 80 chars' } })
        return
    }
    if (label.length > 200) {
        res.status(400).json({ error: { code: 'INVALID_LABEL', message: 'label max 200 chars' } })
        return
    }
    if (projectId && !UUID_RE.test(projectId)) return void badId(res, 'projectId')

    try {
        const [rule] = await db.insert(behaviorRules).values({
            workspaceId,
            projectId: projectId ?? null,
            type: type as 'safety_constraint' | 'operational_rule' | 'communication_style' | 'domain_knowledge' | 'persona_trait' | 'tool_preference' | 'quality_gate',
            key,
            label,
            description: description ?? '',
            value,
            source: projectId ? 'project' : 'workspace',
            tags: tags ?? [],
        }).returning()
        res.status(201).json(rule)
    } catch (err) {
        logger.error({ err }, 'POST /behavior/rules failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create rule' } })
    }
})

// ── PATCH /rules/:ruleId ─────────────────────────────────────────────────────

behaviorRouter.patch('/rules/:ruleId', async (req: Request, res: Response) => {
    const workspaceId = req.params['workspaceId'] as string
    const ruleId = req.params['ruleId'] as string
    if (!UUID_RE.test(workspaceId)) return void badId(res)
    if (!UUID_RE.test(ruleId)) return void badId(res, 'ruleId')
    const { label, description, value, tags } = req.body as {
        label?: string
        description?: string
        value?: Record<string, unknown>
        tags?: string[]
    }

    try {
        const [existing] = await db.select().from(behaviorRules).where(
            and(eq(behaviorRules.id, ruleId), eq(behaviorRules.workspaceId, workspaceId))
        ).limit(1)

        if (!existing) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Rule not found' } })
            return
        }
        if (existing.locked && value !== undefined) {
            res.status(403).json({ error: { code: 'LOCKED', message: 'Safety constraint value cannot be modified' } })
            return
        }

        const updates: Record<string, unknown> = { updatedAt: new Date() }
        if (label !== undefined) updates['label'] = label
        if (description !== undefined) updates['description'] = description
        if (value !== undefined) updates['value'] = value
        if (tags !== undefined) updates['tags'] = tags

        const [updated] = await db.update(behaviorRules)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .set(updates as any)
            .where(eq(behaviorRules.id, ruleId))
            .returning()
        res.json(updated)
    } catch (err) {
        logger.error({ err }, 'PATCH /behavior/rules/:ruleId failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update rule' } })
    }
})

// ── DELETE /rules/:ruleId (soft delete) ──────────────────────────────────────

behaviorRouter.delete('/rules/:ruleId', async (req: Request, res: Response) => {
    const workspaceId = req.params['workspaceId'] as string
    const ruleId = req.params['ruleId'] as string
    if (!UUID_RE.test(workspaceId)) return void badId(res)
    if (!UUID_RE.test(ruleId)) return void badId(res, 'ruleId')

    try {
        const [existing] = await db.select().from(behaviorRules).where(
            and(eq(behaviorRules.id, ruleId), eq(behaviorRules.workspaceId, workspaceId))
        ).limit(1)

        if (!existing) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Rule not found' } })
            return
        }
        if (existing.locked) {
            res.status(403).json({ error: { code: 'LOCKED', message: 'Locked rules cannot be deleted' } })
            return
        }

        await db.update(behaviorRules)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .set({ deletedAt: new Date(), updatedAt: new Date() } as any)
            .where(eq(behaviorRules.id, ruleId))

        res.json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'DELETE /behavior/rules/:ruleId failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to delete rule' } })
    }
})

// ── POST /rules/import ───────────────────────────────────────────────────────

behaviorRouter.post('/rules/import', async (req: Request, res: Response) => {
    const workspaceId = req.params['workspaceId'] as string
    if (!UUID_RE.test(workspaceId)) return void badId(res)
    const projectId = (req.query['projectId'] as string | undefined) ?? null
    if (projectId && !UUID_RE.test(projectId)) return void badId(res, 'projectId')
    
    let rawContent = ''
    if (typeof req.body === 'string') rawContent = req.body
    else if (req.body && typeof req.body === 'object' && 'content' in req.body) rawContent = String(req.body.content)

    if (!rawContent) {
        res.status(400).json({ error: { code: 'MISSING_CONTENT', message: 'No content provided to import' } })
        return
    }

    try {
        const parseAgentsMd = await getImportParser()
        const parsedRules = parseAgentsMd(rawContent)
        
        const inserts = parsedRules.map((r: any) => ({
            workspaceId,
            projectId: projectId ?? null,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            type: r.type as any,
            key: r.key!,
            label: r.label!,
            description: r.description ?? '',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            value: r.value as any,
            source: projectId ? ('project' as const) : ('workspace' as const),
            tags: r.tags ?? [],
        }))

        if (inserts.length === 0) {
            res.json({ message: 'No rules parsed', rules: [] })
            return
        }

        const inserted = await db.insert(behaviorRules).values(inserts).returning()
        res.status(201).json({ message: `Imported ${inserted.length} rules`, rules: inserted })
    } catch (err) {
        logger.error({ err }, 'POST /behavior/rules/import failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to import rules' } })
    }
})

// ── GET /rules/export ────────────────────────────────────────────────────────

behaviorRouter.get('/rules/export', async (req: Request, res: Response) => {
    const workspaceId = req.params['workspaceId'] as string
    if (!UUID_RE.test(workspaceId)) return void badId(res)
    const projectId = (req.query['projectId'] as string | undefined) ?? null
    if (projectId && !UUID_RE.test(projectId)) return void badId(res, 'projectId')

    try {
        let rows
        if (projectId) {
            rows = await db.select().from(behaviorRules).where(
                and(
                    eq(behaviorRules.workspaceId, workspaceId),
                    isNull(behaviorRules.deletedAt),
                    or(
                        isNull(behaviorRules.projectId),
                        eq(behaviorRules.projectId, projectId),
                    ),
                )
            ).orderBy(behaviorRules.createdAt)
        } else {
            rows = await db.select().from(behaviorRules).where(
                and(
                    eq(behaviorRules.workspaceId, workspaceId),
                    isNull(behaviorRules.projectId),
                    isNull(behaviorRules.deletedAt),
                )
            ).orderBy(behaviorRules.createdAt)
        }

        const generateAgentsMd = await getExportGenerator()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const markdown = generateAgentsMd(rows as any[])
        
        res.setHeader('Content-Type', 'text/markdown')
        res.setHeader('Content-Disposition', 'attachment; filename="AGENTS.md"')
        res.send(markdown)
    } catch (err) {
        logger.error({ err }, 'GET /behavior/rules/export failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to export rules' } })
    }
})

// Suppress unused import warning — or is used for combined conditions
void isNotNull
