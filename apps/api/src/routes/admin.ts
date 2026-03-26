// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Admin Routes — Cross-workspace super-admin endpoints for the Command Center.
 * All routes require Supabase JWT + isSuperAdmin = true.
 */

import { Router, type Router as RouterType } from 'express'
import { db, eq, desc, sql, count } from '@plexo/db'
import { workspaces, tasks, users, conversations, installedConnections, memoryEntries, auditLog, workspaceMembers } from '@plexo/db'
import { logger } from '../logger.js'

export const adminRouter: RouterType = Router()

// ── GET /admin/workspaces — list ALL workspaces with stats ──────────────
adminRouter.get('/workspaces', async (_req, res) => {
    try {
        const rows = await db
            .select({
                id: workspaces.id,
                name: workspaces.name,
                ownerId: workspaces.ownerId,
                createdAt: workspaces.createdAt,
            })
            .from(workspaces)
            .orderBy(desc(workspaces.createdAt))
            .limit(100)

        // Get task counts per workspace
        const taskCounts = await db
            .select({
                workspaceId: tasks.workspaceId,
                total: count(),
            })
            .from(tasks)
            .groupBy(tasks.workspaceId)

        const taskMap = new Map(taskCounts.map(t => [t.workspaceId, Number(t.total)]))

        // Get member counts per workspace
        const memberCounts = await db
            .select({
                workspaceId: workspaceMembers.workspaceId,
                total: count(),
            })
            .from(workspaceMembers)
            .groupBy(workspaceMembers.workspaceId)

        const memberMap = new Map(memberCounts.map(m => [m.workspaceId, Number(m.total)]))

        const items = rows.map(ws => ({
            ...ws,
            taskCount: taskMap.get(ws.id) ?? 0,
            memberCount: memberMap.get(ws.id) ?? 0,
        }))

        res.json({ items, total: items.length })
    } catch (err) {
        logger.error({ err }, 'Admin: failed to list workspaces')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list workspaces' } })
    }
})

// ── GET /admin/workspaces/:id — detailed workspace view ────────────────
adminRouter.get('/workspaces/:id', async (req, res) => {
    try {
        const [ws] = await db
            .select({
                id: workspaces.id,
                name: workspaces.name,
                ownerId: workspaces.ownerId,
                createdAt: workspaces.createdAt,
            })
            .from(workspaces)
            .where(eq(workspaces.id, req.params.id))
            .limit(1)

        if (!ws) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } })
            return
        }

        // Get recent tasks
        const recentTasks = await db
            .select({
                id: tasks.id,
                title: tasks.outcomeSummary,
                status: tasks.status,
                type: tasks.type,
                createdAt: tasks.createdAt,
            })
            .from(tasks)
            .where(eq(tasks.workspaceId, ws.id))
            .orderBy(desc(tasks.createdAt))
            .limit(10)

        // Get installed connections
        const connections = await db
            .select({
                id: installedConnections.id,
                type: installedConnections.registryId,
                name: installedConnections.name,
                status: installedConnections.status,
            })
            .from(installedConnections)
            .where(eq(installedConnections.workspaceId, ws.id))

        // Get members
        const members = await db
            .select({
                userId: workspaceMembers.userId,
                role: workspaceMembers.role,
            })
            .from(workspaceMembers)
            .where(eq(workspaceMembers.workspaceId, ws.id))

        res.json({
            workspace: ws,
            recentTasks,
            connections,
            members,
        })
    } catch (err) {
        logger.error({ err }, 'Admin: failed to get workspace')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get workspace' } })
    }
})

// ── GET /admin/users — list all platform users ─────────────────────────
adminRouter.get('/users', async (_req, res) => {
    try {
        const rows = await db
            .select({
                id: users.id,
                email: users.email,
                name: users.name,
                role: users.role,
                isSuperAdmin: users.isSuperAdmin,
                createdAt: users.createdAt,
            })
            .from(users)
            .orderBy(desc(users.createdAt))
            .limit(100)

        res.json({ items: rows, total: rows.length })
    } catch (err) {
        logger.error({ err }, 'Admin: failed to list users')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list users' } })
    }
})

// ── GET /admin/tasks — tasks across all workspaces ─────────────────────
adminRouter.get('/tasks', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200)
    const status = req.query.status as string | undefined

    try {
        let query = db
            .select({
                id: tasks.id,
                title: tasks.outcomeSummary,
                status: tasks.status,
                type: tasks.type,
                workspaceId: tasks.workspaceId,
                createdAt: tasks.createdAt,
                completedAt: tasks.completedAt,
            })
            .from(tasks)
            .orderBy(desc(tasks.createdAt))
            .limit(limit)

        const rows = status
            ? await db
                .select({
                    id: tasks.id,
                    title: tasks.outcomeSummary,
                    status: tasks.status,
                    type: tasks.type,
                    workspaceId: tasks.workspaceId,
                    createdAt: tasks.createdAt,
                    completedAt: tasks.completedAt,
                })
                .from(tasks)
                .where(eq(tasks.status, status as 'queued' | 'claimed' | 'running' | 'complete' | 'blocked' | 'cancelled'))
                .orderBy(desc(tasks.createdAt))
                .limit(limit)
            : await query

        res.json({ items: rows, total: rows.length })
    } catch (err) {
        logger.error({ err }, 'Admin: failed to list tasks')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list tasks' } })
    }
})

// ── GET /admin/tasks/stats — aggregated task statistics ────────────────
adminRouter.get('/tasks/stats', async (_req, res) => {
    try {
        const statusCounts = await db
            .select({
                status: tasks.status,
                total: count(),
            })
            .from(tasks)
            .groupBy(tasks.status)

        const [recentWeek] = await db
            .select({ total: count() })
            .from(tasks)
            .where(sql`${tasks.createdAt} >= NOW() - INTERVAL '7 days'`)

        res.json({
            byStatus: Object.fromEntries(statusCounts.map(s => [s.status, Number(s.total)])),
            lastWeek: Number(recentWeek?.total ?? 0),
        })
    } catch (err) {
        logger.error({ err }, 'Admin: failed to get task stats')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get task stats' } })
    }
})

// ── GET /admin/health — system-wide health ─────────────────────────────
adminRouter.get('/health', async (_req, res) => {
    try {
        // DB check
        const [dbCheck] = await db.execute(sql`SELECT 1 AS ok`)
        const dbOk = !!(dbCheck as { ok?: number })?.ok

        // Counts
        const [wsCount] = await db.select({ total: count() }).from(workspaces)
        const [userCount] = await db.select({ total: count() }).from(users)
        const [taskCount] = await db.select({ total: count() }).from(tasks)
        const [memCount] = await db.select({ total: count() }).from(memoryEntries)

        res.json({
            status: dbOk ? 'ok' : 'degraded',
            counts: {
                workspaces: Number(wsCount?.total ?? 0),
                users: Number(userCount?.total ?? 0),
                tasks: Number(taskCount?.total ?? 0),
                memoryEntries: Number(memCount?.total ?? 0),
            },
        })
    } catch (err) {
        logger.error({ err }, 'Admin: health check failed')
        res.status(500).json({ status: 'error', error: 'Health check failed' })
    }
})

// ── GET /admin/connections — all installed connections ──────────────────
adminRouter.get('/connections', async (_req, res) => {
    try {
        const rows = await db
            .select({
                id: installedConnections.id,
                type: installedConnections.registryId,
                name: installedConnections.name,
                status: installedConnections.status,
                workspaceId: installedConnections.workspaceId,
                createdAt: installedConnections.createdAt,
            })
            .from(installedConnections)
            .orderBy(desc(installedConnections.createdAt))
            .limit(200)

        res.json({ items: rows, total: rows.length })
    } catch (err) {
        logger.error({ err }, 'Admin: failed to list connections')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list connections' } })
    }
})

// ── GET /admin/audit — cross-workspace audit log ───────────────────────
adminRouter.get('/audit', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200)

    try {
        const rows = await db
            .select({
                id: auditLog.id,
                userId: auditLog.userId,
                action: auditLog.action,
                resource: auditLog.resource,
                resourceId: auditLog.resourceId,
                metadata: auditLog.metadata,
                createdAt: auditLog.createdAt,
            })
            .from(auditLog)
            .orderBy(desc(auditLog.createdAt))
            .limit(limit)

        res.json({ items: rows, total: rows.length })
    } catch (err) {
        logger.error({ err }, 'Admin: failed to list audit log')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list audit log' } })
    }
})

// ── POST /admin/workspaces — provision a new workspace ─────────────────
adminRouter.post('/workspaces', async (req, res) => {
    const { name, ownerEmail } = req.body as { name?: string; ownerEmail?: string }

    if (!name) {
        res.status(400).json({ error: { code: 'MISSING_NAME', message: 'Workspace name is required' } })
        return
    }

    try {
        // Resolve owner by email if provided, otherwise use the admin's ID
        let ownerId = req.user!.id
        if (ownerEmail) {
            const [owner] = await db
                .select({ id: users.id })
                .from(users)
                .where(eq(users.email, ownerEmail))
                .limit(1)
            if (owner) ownerId = owner.id
        }

        const [ws] = await db.insert(workspaces).values({
            name,
            ownerId,
        }).returning({
            id: workspaces.id,
            name: workspaces.name,
            ownerId: workspaces.ownerId,
            createdAt: workspaces.createdAt,
        })

        logger.info({ workspaceId: ws!.id, name, adminId: req.user!.id }, 'Admin: workspace provisioned')

        res.status(201).json(ws)
    } catch (err) {
        logger.error({ err }, 'Admin: failed to provision workspace')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to provision workspace' } })
    }
})
