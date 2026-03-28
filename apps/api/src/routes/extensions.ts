// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Extensions API — Fabric Standard compliant
 *
 * GET    /api/extensions?workspaceId=   List installed extensions
 * GET    /api/extensions/:id            Get extension by ID
 * POST   /api/extensions                Install an extension (validates manifest)
 * PATCH  /api/extensions/:id            Toggle enabled / update settings
 * DELETE /api/extensions/:id            Uninstall extension (triggers deactivate hook)
 *
 * Install flow (§3.3):
 *  1. Validate extension manifest
 *  2. Check minHostLevel compliance
 *  3. Verify workspace exists
 *  4. Insert row (enabled=false — requires explicit enable)
 *
 * The agent executor calls loadExtensionTools(workspaceId) at task start,
 * which loads enabled extensions and runs their tools in sandboxed workers.
 */
import { Router, type Router as RouterType } from 'express'
import { db, eq, and, sql as rawSql } from '@plexo/db'
import { extensions, workspaces, extensionPrompts, extensionContexts } from '@plexo/db'
import { logger } from '../logger.js'
import { audit } from '../audit.js'
import { validateManifest } from '@plexo/sdk'
import type { ExtensionManifest } from '@plexo/sdk'
import { terminateWorker } from '@plexo/agent/persistent-pool'
import { UUID_RE } from '../validation.js'

export const extensionsRouter: RouterType = Router()


// Plexo compliance level — used to enforce minHostLevel
const PLEXO_COMPLIANCE_LEVEL: 'core' | 'standard' | 'full' = 'full'
const COMPLIANCE_ORDER = { core: 0, standard: 1, full: 2 }

// ── GET /api/extensions ──────────────────────────────────────────────────────────

extensionsRouter.get('/', async (req, res) => {
    const { workspaceId, type } = req.query as { workspaceId?: string; type?: string }

    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }
    if (!UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid UUID required for workspaceId' } })
        return
    }

    try {
        const conditions = [eq(extensions.workspaceId, workspaceId)]
        if (type) {
            conditions.push(eq(extensions.type, type as any))
        }

        const rows = await db
            .select()
            .from(extensions)
            .where(and(...conditions))
            .orderBy(extensions.installedAt)

        res.json({ items: rows, total: rows.length })
    } catch (err) {
        logger.error({ err }, 'GET /api/extensions failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list extensions' } })
    }
})

// ── GET /api/extensions/:id ──────────────────────────────────────────────────────

extensionsRouter.get('/:id', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }
    try {
        const [plugin] = await db.select().from(extensions).where(eq(extensions.id, req.params.id)).limit(1)
        if (!plugin) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Extension not found' } })
            return
        }
        res.json(plugin)
    } catch (err) {
        logger.error({ err }, 'GET /api/extensions/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get extension' } })
    }
})

// ── POST /api/extensions (install) ───────────────────────────────────────────────

extensionsRouter.post('/', async (req, res) => {
    const { workspaceId, manifest, settings = {} } = req.body as {
        workspaceId?: string
        manifest?: unknown
        settings?: Record<string, unknown>
    }

    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }
    if (!UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid UUID required for workspaceId' } })
        return
    }

    // §3.3 — Validate the extension manifest
    const validation = validateManifest(manifest)
    if (!validation.valid) {
        res.status(400).json({
            error: {
                code: 'INVALID_MANIFEST',
                message: 'Manifest validation failed',
                details: validation.errors,
            },
        })
        return
    }

    const m = manifest as ExtensionManifest

    // §11.4 — Enforce minHostLevel
    if (m.minHostLevel && COMPLIANCE_ORDER[m.minHostLevel] > COMPLIANCE_ORDER[PLEXO_COMPLIANCE_LEVEL]) {
        res.status(400).json({
            error: {
                code: 'COMPLIANCE_INSUFFICIENT',
                message: `Extension requires host compliance level "${m.minHostLevel}", but this host is "${PLEXO_COMPLIANCE_LEVEL}"`,
            },
        })
        return
    }

    try {
        const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
        if (!ws) {
            res.status(404).json({ error: { code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found' } })
            return
        }

        const [inserted] = await db.insert(extensions).values({
            workspaceId,
            name: m.name,
            version: m.version,
            type: m.type,
            fabricVersion: m.plexo ?? '0.4.0',
            entry: m.entry,
            manifest: m as object,
            enabled: false,      // always starts disabled (§9.1 — activate called on enable)
            settings,
        }).returning()

        if (!inserted) {
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Insert returned no data' } })
            return
        }
        
        // §5d: Auto-register behavior rules from extension manifest
        if (m.behaviorRules && m.behaviorRules.length > 0) {
            const { behaviorRules: dbBehaviorRules } = await import('@plexo/db')
            const rulesToInsert = m.behaviorRules.map((rule) => ({
                workspaceId,
                projectId: null,
                type: rule.type,
                key: rule.key,
                label: rule.label,
                description: rule.description,
                value: rule.defaultValue,
                locked: rule.locked,
                source: 'workspace' as const,
                tags: [`extension:${inserted.id}`],
            }))
            await db.insert(dbBehaviorRules).values(rulesToInsert)
        }

        // §7.6: Extract prompt artifacts from manifest and persist (disabled by default)
        if (m.prompts && Array.isArray(m.prompts) && m.prompts.length > 0) {
            try {
                const promptRows = m.prompts.map((p: any) => ({
                    workspaceId,
                    extensionName: m.name,
                    promptId: String(p.id),
                    name: String(p.name ?? ''),
                    description: String(p.description ?? ''),
                    template: String(p.template ?? ''),
                    variables: (p.variables ?? []) as object,
                    tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
                    version: String(p.version ?? '1.0.0'),
                    priority: (['low', 'normal', 'high', 'critical'].includes(String(p.priority)) ? String(p.priority) : 'normal') as 'low' | 'normal' | 'high' | 'critical',
                    dependencies: Array.isArray(p.dependencies) ? p.dependencies.map(String) : [],
                    enabled: false,
                }))
                await db.insert(extensionPrompts).values(promptRows).onConflictDoNothing()
                logger.info({ extensionName: m.name, count: promptRows.length }, 'Extracted prompt artifacts from extension')
            } catch (promptErr) {
                logger.warn({ err: promptErr, extensionName: m.name }, 'Failed to extract prompt artifacts — non-fatal')
            }
        }

        // §7.7: Extract context artifacts from manifest and persist (disabled by default)
        if (m.contexts && Array.isArray(m.contexts) && m.contexts.length > 0) {
            try {
                const contextRows = m.contexts.slice(0, 10).map((c: any) => ({
                    workspaceId,
                    extensionName: m.name,
                    contextId: String(c.id),
                    name: String(c.name ?? ''),
                    description: String(c.description ?? ''),
                    content: String(c.content ?? '').slice(0, 50_000),
                    contentType: String(c.contentType ?? 'text/plain'),
                    priority: (['low', 'normal', 'high', 'critical'].includes(String(c.priority)) ? String(c.priority) : 'normal') as 'low' | 'normal' | 'high' | 'critical',
                    ttl: typeof c.ttl === 'number' ? c.ttl : null,
                    tags: Array.isArray(c.tags) ? c.tags.map(String).slice(0, 10) : [],
                    estimatedTokens: typeof c.estimatedTokens === 'number' ? c.estimatedTokens : null,
                    enabled: false, // disabled by default — user opts in
                }))
                await db.insert(extensionContexts).values(contextRows).onConflictDoNothing()
                logger.info({ extensionName: m.name, count: contextRows.length }, 'Extracted context artifacts from extension')
            } catch (contextErr) {
                logger.warn({ err: contextErr, extensionName: m.name }, 'Failed to extract context artifacts — non-fatal')
            }
        }

        logger.info({ id: inserted.id, name: m.name, type: m.type, plexo: m.plexo }, 'Extension installed')
        audit(req, {
            workspaceId,
            action: 'extension.install',
            resource: 'extensions',
            resourceId: inserted.id,
            metadata: { name: m.name, version: m.version, type: m.type, plexo: m.plexo },
        })

        // Telemetry: extension installed (no user content — public registry name only)
        try {
            const { emitExtensionInstalled } = await import('../telemetry/events.js')
            emitExtensionInstalled({ extensionName: m.name, source: 'registry' })
        } catch { /* telemetry must never crash the app */ }

        // Surface validation warnings to the caller (non-fatal)
        const warnings = validation.errors.filter((e) => e.severity === 'warning')
        res.status(201).json({ ...inserted, warnings: warnings.length ? warnings : undefined })
    } catch (err) {
        logger.error({ err }, 'POST /api/extensions failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to install extension' } })
    }
})

// ── PATCH /api/extensions/:id ────────────────────────────────────────────────────

extensionsRouter.patch('/:id', async (req, res) => {
    const { enabled, settings, workspaceId } = req.body as { enabled?: boolean; settings?: Record<string, unknown>; workspaceId?: string }

    if (!UUID_RE.test(req.params.id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }

    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }

    try {
        const [existing] = await db.select().from(extensions).where(eq(extensions.id, req.params.id)).limit(1)
        if (!existing || existing.workspaceId !== workspaceId) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Extension not found in workspace' } })
            return
        }

        const update: Record<string, unknown> = {}
        if (typeof enabled === 'boolean') update.enabled = enabled
        if (settings) update.settings = { ...(existing.settings as object), ...settings }

        if (Object.keys(update).length === 0) {
            res.status(400).json({ error: { code: 'NOTHING_TO_UPDATE', message: 'Provide enabled or settings' } })
            return
        }

        await db.update(extensions).set(update).where(eq(extensions.id, req.params.id))
        logger.info({ id: req.params.id, update }, 'Extension updated')

        // Audit enable/disable — these trigger lifecycle hooks (§9.1)
        if (typeof enabled === 'boolean') {
            audit(req, {
                workspaceId: existing.workspaceId,
                action: enabled ? 'extension.enable' : 'extension.disable',
                resource: 'extensions',
                resourceId: req.params.id,
                metadata: { name: existing.name, fabricVersion: existing.fabricVersion },
            })
            // Terminate the persistent worker on disable so it's re-activated fresh on re-enable
            if (!enabled) terminateWorker(existing.name)
        }

        res.json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'PATCH /api/extensions/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Update failed' } })
    }
})

// ── DELETE /api/extensions/:id ───────────────────────────────────────────────────

extensionsRouter.delete('/:id', async (req, res) => {
    const { workspaceId } = req.query as { workspaceId?: string }

    if (!UUID_RE.test(req.params.id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }

    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId query required' } })
        return
    }

    try {
        const [existing] = await db
            .select({ id: extensions.id, workspaceId: extensions.workspaceId, name: extensions.name, fabricVersion: extensions.fabricVersion })
            .from(extensions)
            .where(eq(extensions.id, req.params.id))
            .limit(1)

        if (!existing || existing.workspaceId !== workspaceId) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Extension not found in workspace' } })
            return
        }

        // Terminate persistent worker + delete record
        terminateWorker(existing.name)
        await db.delete(extensions).where(eq(extensions.id, req.params.id))
        
        // §5d: Cleanup — soft-delete associated behavior rules using raw SQL
        // instead of fetching all rules and filtering/updating in JS (N+1)
        // Tags use "extension:<id>" format
        try {
            const extensionTag = `extension:${req.params.id}`
            await db.execute(rawSql`
                UPDATE behavior_rules
                SET deleted_at = NOW()
                WHERE workspace_id = ${workspaceId}
                  AND ${extensionTag} = ANY(tags)
                  AND deleted_at IS NULL
            `)
            logger.info({ id: req.params.id }, 'Soft-deleted extension behavior rules')
        } catch (ruleErr) {
            logger.warn({ err: ruleErr, id: req.params.id }, 'Failed to cleanup extension behavior rules — non-fatal')
        }

        // §7.6/§7.7: Soft-delete extension prompts and context blocks
        try {
            await db.execute(rawSql`
                UPDATE extension_prompts
                SET deleted_at = NOW()
                WHERE workspace_id = ${workspaceId}
                  AND extension_name = ${existing.name}
                  AND deleted_at IS NULL
            `)
            await db.execute(rawSql`
                UPDATE extension_contexts
                SET deleted_at = NOW()
                WHERE workspace_id = ${workspaceId}
                  AND extension_name = ${existing.name}
                  AND deleted_at IS NULL
            `)
            logger.info({ id: req.params.id, name: existing.name }, 'Soft-deleted extension prompts and context')
        } catch (pcErr) {
            logger.warn({ err: pcErr, id: req.params.id }, 'Failed to cleanup extension prompts/context — non-fatal')
        }

        logger.info({ id: req.params.id, name: existing.name }, 'Extension uninstalled')
        audit(req, {
            workspaceId: existing.workspaceId,
            action: 'extension.uninstall',
            resource: 'extensions',
            resourceId: req.params.id,
            metadata: { name: existing.name, fabricVersion: existing.fabricVersion },
        })
        res.json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'DELETE /api/extensions/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Uninstall failed' } })
    }
})
