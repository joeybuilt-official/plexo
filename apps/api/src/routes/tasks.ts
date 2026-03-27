// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { db, desc, eq, and, sql } from '@plexo/db'
import { tasks, taskSteps, artifacts, artifactVersions } from '@plexo/db'
import { push, list } from '@plexo/queue'
import { logger } from '../logger.js'
import { emitToWorkspace } from '../sse-emitter.js'
import { cancelActiveTask } from '../agent-loop.js'
import { captureLifecycleEvent } from '../sentry.js'
import { UUID_RE } from '../validation.js'

export const tasksRouter: RouterType = Router()


const VALID_TASK_TYPES = new Set(['coding', 'deployment', 'research', 'ops', 'opportunity', 'monitoring', 'report', 'online', 'automation'])
const VALID_TASK_SOURCES = new Set(['telegram', 'slack', 'discord', 'scanner', 'github', 'cron', 'dashboard', 'api', 'extension', 'sentry'])

// ── GET /api/tasks?workspaceId=&status=&type=&limit=&cursor= ─────────────────

tasksRouter.get('/', async (req, res) => {
    const {
        workspaceId,
        status,
        type,
        projectId,
        limit = '25',
        cursor,
    } = req.query as Record<string, string>

    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }
    if (!UUID_RE.test(workspaceId)) {
        res.json({ items: [], nextCursor: null, total: 0 })
        return
    }
    if (projectId && !UUID_RE.test(projectId)) {
        res.json({ items: [], nextCursor: null, total: 0 })
        return
    }

    try {
        const items = await list({
            workspaceId,
            status: status ?? undefined,
            type: type ?? undefined,
            projectId: projectId ?? undefined,
            limit: Math.min(parseInt(limit, 10) || 25, 100),
            cursor: cursor ?? undefined,
        })

        const nextCursor = items.length === (parseInt(limit, 10) || 25)
            ? items[items.length - 1]?.id ?? null
            : null

        res.json({ items, nextCursor, total: items.length })
    } catch (err) {
        logger.error({ err }, 'GET /api/tasks failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch tasks' } })
    }
})

// ── POST /api/tasks ──────────────────────────────────────────────────────────

tasksRouter.post('/', async (req, res) => {
    const { workspaceId, type, source = 'api', context = {}, priority, projectId } = req.body as {
        workspaceId: string
        type: string
        source?: string
        context?: Record<string, unknown>
        priority?: number
        projectId?: string
    }

    if (!workspaceId || !type) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId and type are required' } })
        return
    }
    if (!UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid UUID required for workspaceId' } })
        return
    }
    if (!VALID_TASK_TYPES.has(type)) {
        res.status(400).json({ error: { code: 'INVALID_TYPE', message: `type must be one of: ${[...VALID_TASK_TYPES].join(', ')}` } })
        return
    }
    if (!VALID_TASK_SOURCES.has(source)) {
        res.status(400).json({ error: { code: 'INVALID_SOURCE', message: `source must be one of: ${[...VALID_TASK_SOURCES].join(', ')}` } })
        return
    }
    if (projectId && !UUID_RE.test(projectId)) {
        res.status(400).json({ error: { code: 'INVALID_PROJECT', message: 'Valid UUID required for projectId' } })
        return
    }
    if (priority !== undefined && (typeof priority !== 'number' || priority < 1 || priority > 10)) {
        res.status(400).json({ error: { code: 'INVALID_PRIORITY', message: 'priority must be 1–10' } })
        return
    }

    try {
        const id = await push({
            workspaceId,
            type: type as Parameters<typeof push>[0]['type'],
            source: source as Parameters<typeof push>[0]['source'],
            context,
            priority,
            projectId,
        })
        emitToWorkspace(workspaceId, { type: 'task_queued', taskId: id, source })
        captureLifecycleEvent('task.queued', 'info', { taskId: id, type, source, workspaceId })
        res.status(201).json({ id })
    } catch (err) {
        logger.error({ err }, 'POST /api/tasks failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create task' } })
    }
})

// ── GET /api/tasks/:id ───────────────────────────────────────────────────────

tasksRouter.get('/:id', async (req, res) => {
    const { id } = req.params
    const workspaceId = req.query.workspaceId as string | undefined
    if (!id || id.length > 64) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid task id' } })
        return
    }
    try {
        const [task] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1)
        if (!task) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Task not found' } })
            return
        }
        // Workspace isolation: if workspaceId is provided, verify the task belongs to it
        if (workspaceId && task.workspaceId !== workspaceId) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Task not found' } })
            return
        }
        const steps = await db.select().from(taskSteps)
            .where(eq(taskSteps.taskId, id))
            .orderBy(taskSteps.stepNumber)
        res.json({ task, steps })
    } catch (err) {
        logger.error({ err }, 'GET /api/tasks/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch task' } })
    }
})

// ── DELETE /api/tasks/:id ────────────────────────────────────────────────────

tasksRouter.delete('/:id', async (req, res) => {
    const { id } = req.params
    if (!id || id.length > 64) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid task id' } })
        return
    }
    try {
        // Fetch workspace id before we tombstone the row (for SSE emit)
        const [existing] = await db.select({ workspaceId: tasks.workspaceId, status: tasks.status })
            .from(tasks).where(eq(tasks.id, id)).limit(1)

        if (!existing) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Task not found' } })
            return
        }

        await db.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.id, id))

        // Signal the executor immediately if this task is currently running
        const aborted = cancelActiveTask(id)
        logger.info({ taskId: id, aborted }, 'Task cancelled')

        emitToWorkspace(existing.workspaceId, { type: 'task_cancelled', taskId: id })
        captureLifecycleEvent('task.cancelled', 'warning', { taskId: id, workspaceId: existing.workspaceId, previousStatus: existing.status })
        res.json({ ok: true, aborted })
    } catch (err) {
        logger.error({ err }, 'DELETE /api/tasks/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to cancel task' } })
    }
})

// ── POST /api/tasks/:id/retry ─────────────────────────────────────────────────
// Re-queues a blocked task with its original context. Cancels the original.

tasksRouter.post('/:id/retry', async (req, res) => {
    const { id } = req.params
    if (!id || id.length > 64) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid task id' } })
        return
    }
    try {
        const [task] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1)
        if (!task) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Task not found' } })
            return
        }
        if (task.status !== 'blocked' && task.status !== 'cancelled') {
            res.status(400).json({ error: { code: 'NOT_BLOCKED_OR_FAILED', message: 'Only blocked or failed tasks can be retried' } })
            return
        }

        // Re-queue with same parameters
        const newId = await push({
            workspaceId: task.workspaceId,
            type: task.type as Parameters<typeof push>[0]['type'],
            source: (task.source ?? 'api') as Parameters<typeof push>[0]['source'],
            context: (task.context as Record<string, unknown>) ?? {},
            projectId: task.projectId ?? undefined,
        })

        // Cancel the blocked original
        await db.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.id, id))

        captureLifecycleEvent('task.retry', 'info', { originalId: id, newId, type: task.type, source: task.source, workspaceId: task.workspaceId })
        logger.info({ originalId: id, newId }, 'Task retried')
        res.status(201).json({ id: newId })
    } catch (err) {
        logger.error({ err }, 'POST /api/tasks/:id/retry failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to retry task' } })
    }
})

// ── GET /api/tasks/:id/assets ──────────────────────────────────────────────
// Lists agent-produced assets for a task. 
// Prioritizes versioned artifacts from DB (Phase 4), falls back to /tmp filesystem.
tasksRouter.get('/:id/assets', async (req, res) => {
    const { id } = req.params
    if (!id || id.length > 64) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid task id' } })
        return
    }

    try {
        // 1. Fetch from DB first (Phase 4)
        const dbArtifacts = await db.select({
            id: artifacts.id,
            filename: artifacts.filename,
            type: artifacts.type,
            currentVersion: artifacts.currentVersion,
            updatedAt: artifacts.updatedAt,
            content: artifactVersions.content,
        })
        .from(artifacts)
        .innerJoin(artifactVersions, and(
            eq(artifactVersions.artifactId, artifacts.id),
            eq(artifactVersions.version, artifacts.currentVersion)
        ))
        .where(eq(artifacts.taskId, id))

        if (dbArtifacts.length > 0) {
            res.json({
                items: dbArtifacts.map(a => ({
                    artifactId: a.id,
                    filename: a.filename,
                    bytes: Buffer.byteLength(a.content || ''),
                    isText: true,
                    content: a.content,
                    version: a.currentVersion,
                    updatedAt: a.updatedAt,
                }))
            })
            return
        }

        // 2. Fallback to /tmp filesystem (Phase 1)
        const { readdirSync, statSync, readFileSync, existsSync } = await import('node:fs')
        const { join, extname } = await import('node:path')

        const dir = `/tmp/plexo-assets/${id}`
        if (!existsSync(dir)) {
            res.json({ items: [] })
            return
        }

        const files = readdirSync(dir)
        const TEXT_EXTS = new Set(['.txt', '.md', '.json', '.csv', '.html', '.xml', '.yaml', '.yml', '.toml', '.sh', '.py', '.ts', '.js', '.sql', '.mermaid', '.mmd'])
        const MAX_INLINE = 5 * 1024 * 1024 // 5MB for DB-backed

        const items = files.map((filename) => {
            const filePath = join(dir, filename)
            const stat = statSync(filePath)
            const ext = extname(filename).toLowerCase()
            const isText = TEXT_EXTS.has(ext)
            let content: string | null = null
            if (isText && stat.size <= MAX_INLINE) {
                try {
                    content = readFileSync(filePath, 'utf8')
                } catch { /* skip */ }
            }
            return {
                filename,
                bytes: stat.size,
                isText,
                content,
                path: filePath,
            }
        })

        res.json({ items })
    } catch (err) {
        logger.error({ err, id }, 'GET /api/tasks/:id/assets failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list assets' } })
    }
})

// ── GET /api/tasks/:id/artifacts/:artifactId/versions ───────────────────────
// Returns version history for a specific artifact.
tasksRouter.get('/:id/artifacts/:artifactId/versions', async (req, res) => {
    const { artifactId } = req.params
    if (!UUID_RE.test(artifactId)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required for artifactId' } })
        return
    }
    try {
        const versions = await db.select({
            version: artifactVersions.version,
            changeDescription: artifactVersions.changeDescription,
            createdAt: artifactVersions.createdAt,
            // Don't return full content in list
        })
        .from(artifactVersions)
        .where(eq(artifactVersions.artifactId, artifactId))
        .orderBy(desc(artifactVersions.version))

        res.json({ versions })
    } catch (err) {
        logger.error({ err, artifactId }, 'GET artifact versions failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch version history' } })
    }
})

// ── GET /api/tasks/:id/artifacts/:artifactId/versions/:version ──────────────
// Returns a specific version of an artifact.
tasksRouter.get('/:id/artifacts/:artifactId/versions/:version', async (req, res) => {
    const { artifactId, version } = req.params
    if (!UUID_RE.test(artifactId)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required for artifactId' } })
        return
    }
    const versionNum = parseInt(version, 10)
    if (isNaN(versionNum) || versionNum < 0) {
        res.status(400).json({ error: { code: 'INVALID_VERSION', message: 'version must be a non-negative integer' } })
        return
    }
    try {
        const [ver] = await db.select()
            .from(artifactVersions)
            .where(and(
                eq(artifactVersions.artifactId, artifactId),
                eq(artifactVersions.version, versionNum)
            ))
            .limit(1)

        if (!ver) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Version not found' } })
            return
        }

        res.json({ version: ver })
    } catch (err) {
        logger.error({ err, artifactId, version }, 'GET artifact version failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch version' } })
    }
})

// ── POST /api/tasks/:id/assets/export ──────────────────────────────────────────────
// Exports a text asset to PDF or DOCX format.

tasksRouter.post('/:id/assets/export', async (req, res) => {
    const { id } = req.params
    const { filename, format } = req.body as { filename: string, format: 'pdf' | 'docx' }

    if (!id || !filename || !format) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'id, filename, and format are required' } })
        return
    }
    if (format !== 'pdf' && format !== 'docx') {
        res.status(400).json({ error: { code: 'UNSUPPORTED_FORMAT', message: 'format must be "pdf" or "docx"' } })
        return
    }

    try {
        const { existsSync, readFileSync } = await import('node:fs')
        // @ts-ignore
        const { join, resolve } = await import('node:path')

        const baseDir = resolve(`/tmp/plexo-assets/${id}`)
        const filePath = resolve(join(baseDir, filename))
        // Path traversal protection: ensure resolved path stays within the task's asset directory
        if (!filePath.startsWith(baseDir + '/') && filePath !== baseDir) {
            res.status(400).json({ error: { code: 'INVALID_PATH', message: 'Invalid filename' } })
            return
        }
        if (!existsSync(filePath)) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Asset not found' } })
            return
        }

        const content = readFileSync(filePath, 'utf8')
        
        if (format === 'pdf') {
            const { marked } = await import('marked')
            const puppeteer = await import('puppeteer')
            
            const htmlContent = await marked.parse(content)
            const wrappedHtml = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; padding: 2em; max-width: 800px; margin: 0 auto; color: #333; }
                    code { background: #f4f4f4; padding: 0.2em 0.4em; border-radius: 3px; font-family: monospace; }
                    pre { background: #f4f4f4; padding: 1em; border-radius: 5px; overflow-x: auto; font-family: monospace; }
                    blockquote { border-left: 4px solid #ccc; padding-left: 1em; color: #666; }
                    h1, h2, h3, h4 { color: #111; border-bottom: 1px solid #eaeaea; padding-bottom: 0.3em; }
                    img { max-width: 100%; }
                </style>
            </head>
            <body>
                ${htmlContent}
            </body>
            </html>
            `
            
            const browser = await puppeteer.default.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
            const page = await browser.newPage()
            await page.setContent(wrappedHtml, { waitUntil: 'networkidle0' })
            const pdfBuffer = await page.pdf({ format: 'A4', margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' } })
            await browser.close()
            
            res.setHeader('Content-Type', 'application/pdf')
            res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/\.[^/.]+$/, "")}.pdf"`)
            res.send(Buffer.from(pdfBuffer))
            return
        }
        
        if (format === 'docx') {
            const { Document, Packer, Paragraph, TextRun } = await import('docx')
            
            // Naive plain text fallback wrapper
            const lines = content.split('\n')
            
            const doc = new Document({
                sections: [{
                    properties: {},
                    children: lines.map((line: string) => new Paragraph({
                        children: [
                            new TextRun(line)
                        ],
                    })),
                }],
            })
            
            const b64string = await Packer.toBase64String(doc)
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
            res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/\.[^/.]+$/, "")}.docx"`)
            res.send(Buffer.from(b64string, 'base64'))
            return
        }

        res.status(400).json({ error: { code: 'UNSUPPORTED_FORMAT', message: 'Unsupported format' } })
    } catch (err) {
        logger.error({ err, id }, 'POST /api/tasks/:id/assets/export failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to export asset' } })
    }
})


tasksRouter.get('/stats/summary', async (req, res) => {
    const { workspaceId } = req.query as { workspaceId?: string }
    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }

    if (!UUID_RE.test(workspaceId)) {
        res.json({ byStatus: {}, cost: { total: 0, thisWeek: 0, ceiling: parseFloat(process.env.API_COST_CEILING_USD ?? '10') } })
        return
    }

    try {
        const rows = await db.execute<{ status: string; count: string }>(sql`
      SELECT status, COUNT(*) as count
      FROM tasks
      WHERE workspace_id = ${workspaceId}
      GROUP BY status
    `)

        const stats: Record<string, number> = {}
        for (const row of rows) {
            stats[row.status] = parseInt(row.count, 10)
        }

        const costCeiling = parseFloat(process.env.API_COST_CEILING_USD ?? '10')
        const [weekCostRow] = await db.execute<{ cost_usd: string | null }>(sql`
            SELECT cost_usd
            FROM api_cost_tracking
            WHERE workspace_id = ${workspaceId}::uuid
              AND week_start = date_trunc('week', NOW())::date
            LIMIT 1
        `)
        const [allTimeCostRow] = await db.execute<{ total: string }>(sql`
            SELECT COALESCE(SUM(cost_usd), 0)::text AS total
            FROM work_ledger
            WHERE workspace_id = ${workspaceId}::uuid
        `)

        res.json({
            byStatus: stats,
            cost: {
                total: parseFloat(allTimeCostRow?.total ?? '0'),
                thisWeek: parseFloat(weekCostRow?.cost_usd ?? '0'),
                ceiling: costCeiling,
            },
        })
    } catch (err) {
        logger.error({ err }, 'GET /api/tasks/stats failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch stats' } })
    }
})
