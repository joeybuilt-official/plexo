// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Admin Routes — Cross-workspace super-admin endpoints for the Command Center.
 * All routes require authentication + isSuperAdmin = true.
 */

import { Router, type Router as RouterType } from 'express'
import { DEFAULT_INTELLIGENCE_SETTINGS, DEFAULT_WORKSPACE_SETTINGS } from '@plexo/db'
import * as adminRepo from '../repositories/admin.repository.js'
import { logger } from '../logger.js'
import { recordAuditEventDirect } from '../audit.js'
import { getRecentErrors, getErrorRingSize } from '../lib/error-ring.js'

export const adminRouter: RouterType = Router()

// ── GET /admin/recent-errors — bounded in-process error ring (ADR 0038) ──
// Operator error surface. ?limit=N (1..200). Single-replica, resets on restart.
adminRouter.get('/recent-errors', (req, res) => {
    const limit = Number(req.query.limit) || 50
    res.json({ items: getRecentErrors(limit), ringSize: getErrorRingSize() })
})

// ── GET /admin/workspaces — list ALL workspaces with stats ──────────────
adminRouter.get('/workspaces', async (_req, res) => {
    try {
        const rows = await adminRepo.listWorkspaces()

        // Get task counts per workspace
        const taskCounts = await adminRepo.getTaskCountsByWorkspace()
        const taskMap = new Map(taskCounts.map(t => [t.workspaceId, Number(t.total)]))

        // Get member counts per workspace
        const memberCounts = await adminRepo.getMemberCountsByWorkspace()
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
        const ws = await adminRepo.getWorkspaceBasic(req.params.id)

        if (!ws) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } })
            return
        }

        const recentTasks = await adminRepo.listRecentTasks(ws.id)
        const connections = await adminRepo.listWorkspaceConnections(ws.id)
        const members = await adminRepo.listWorkspaceMembers(ws.id)

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
        const rows = await adminRepo.listUsers()

        // isSuperAdmin is derived from SUPER_ADMIN_EMAILS env var — the users
        // table is now a foreign table over auth.user and no longer
        // carries Plexo-specific role flags.
        const superAdminEmails = new Set(
            (process.env.SUPER_ADMIN_EMAILS ?? '')
                .split(',')
                .map((e) => e.trim().toLowerCase())
                .filter(Boolean),
        )
        const items = rows.map((r) => ({
            ...r,
            isSuperAdmin: superAdminEmails.has(r.email.toLowerCase()),
        }))

        res.json({ items, total: items.length })
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
        const rows = status
            ? await adminRepo.listTasksByStatus(status as 'queued' | 'claimed' | 'running' | 'complete' | 'blocked' | 'cancelled' | 'awaiting_approval', limit)
            : await adminRepo.listAllTasks(limit)

        res.json({ items: rows, total: rows.length })
    } catch (err) {
        logger.error({ err }, 'Admin: failed to list tasks')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list tasks' } })
    }
})

// ── GET /admin/tasks/stats — aggregated task statistics ────────────────
adminRouter.get('/tasks/stats', async (_req, res) => {
    try {
        const statusCounts = await adminRepo.getTaskStatusCounts()
        const [recentWeek] = await adminRepo.getTasksLastWeek()

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
        const [dbCheck] = await adminRepo.pingDb()
        const dbOk = !!(dbCheck as { ok?: number })?.ok

        // Counts
        const [wsCount] = await adminRepo.countWorkspaces()
        const [userCount] = await adminRepo.countUsers()
        const [taskCount] = await adminRepo.countTasks()
        const [memCount] = await adminRepo.countMemoryEntries()

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
        const rows = await adminRepo.listAllConnections()

        res.json({ items: rows, total: rows.length })
    } catch (err) {
        logger.error({ err }, 'Admin: failed to list integrations')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list integrations' } })
    }
})

// ── GET /admin/audit — cross-workspace audit log ───────────────────────
adminRouter.get('/audit', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200)

    try {
        const rows = await adminRepo.listAuditLog(limit)

        res.json({ items: rows, total: rows.length })
    } catch (err) {
        logger.error({ err }, 'Admin: failed to list audit log')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list audit log' } })
    }
})

// ── POST /admin/attachments/:contentHash/rescan — ADR 0012 §D9 ─────────
// Re-enqueue a previously-scanned attachment (e.g. after a signature DB
// update catches a previously-clean file). Mounted behind requireSuperAdmin.
adminRouter.post('/attachments/:contentHash/rescan', async (req, res) => {
    const contentHash = req.params.contentHash
    if (!contentHash || !/^[a-f0-9]{64}$/.test(contentHash)) {
        res.status(400).json({ error: { code: 'INVALID_HASH', message: 'contentHash must be a 64-char hex sha-256' } })
        return
    }
    try {
        const result = await adminRepo.rescanAttachment(contentHash)
        if (result.length === 0) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No queued attachment for that contentHash' } })
            return
        }
        const queueRow = result[0]!
        recordAuditEventDirect({
            workspaceId: queueRow.workspaceId,
            userId: req.user?.id,
            action: 'attachment.rescan_requested',
            resource: 'conversations.attachments',
            resourceId: contentHash,
            metadata: { adminUserId: req.user?.id ?? null, contentHash },
        })
        res.json({ ok: true, rescanned: result.length })
    } catch (err) {
        logger.error({ err, contentHash }, 'Admin: rescan failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Rescan failed' } })
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
            const owner = await adminRepo.findUserByEmail(ownerEmail)
            if (owner) ownerId = owner.id
        }

        const ws = await adminRepo.insertWorkspace({
            name,
            ownerId,
            settings: DEFAULT_WORKSPACE_SETTINGS,
            intelligenceSettings: DEFAULT_INTELLIGENCE_SETTINGS,
        })

        logger.info({ workspaceId: ws!.id, name, adminId: req.user!.id }, 'Admin: workspace provisioned')

        res.status(201).json(ws)
    } catch (err) {
        logger.error({ err }, 'Admin: failed to provision workspace')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to provision workspace' } })
    }
})
