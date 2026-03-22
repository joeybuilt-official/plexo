// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Users management API
 *
 * GET    /api/users?workspaceId=     List users (those who own or have access)
 * GET    /api/users/:id              Get user by ID
 * PATCH  /api/users/:id             Update name/role
 * DELETE /api/users/:id             Remove user (workspace-scoped soft-delete via role)
 *
 * Note: this lists all users for now (no workspace membership table yet).
 * When RBAC lands, this will filter by workspace membership.
 */
import { Router, type Router as RouterType } from 'express'
import { db, eq, desc } from '@plexo/db'
import { users } from '@plexo/db'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'

export const usersRouter: RouterType = Router()


// ── GET /api/users ─────────────────────────────────────────────────────────────

usersRouter.get('/', async (_req, res) => {
    try {
        const rows = await db
            .select({
                id: users.id,
                email: users.email,
                name: users.name,
                role: users.role,
                createdAt: users.createdAt,
            })
            .from(users)
            .orderBy(desc(users.createdAt))
            .limit(100)

        res.json({ items: rows, total: rows.length })
    } catch (err) {
        logger.error({ err }, 'GET /api/users failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list users' } })
    }
})

// ── GET /api/users/:id ────────────────────────────────────────────────────────

usersRouter.get('/:id', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }
    try {
        const [user] = await db
            .select({
                id: users.id,
                email: users.email,
                name: users.name,
                role: users.role,
                createdAt: users.createdAt,
            })
            .from(users)
            .where(eq(users.id, req.params.id))
            .limit(1)

        if (!user) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } })
            return
        }
        res.json(user)
    } catch (err) {
        logger.error({ err }, 'GET /api/users/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get user' } })
    }
})

// ── PATCH /api/users/:id ──────────────────────────────────────────────────────

usersRouter.patch('/:id', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }
    const { name, role } = req.body as { name?: string; role?: string }
    if (name !== undefined && (typeof name !== 'string' || name.length > 200)) {
        res.status(400).json({ error: { code: 'INVALID_NAME', message: 'name must be a string, max 200 chars' } })
        return
    }
    try {
        const update: Record<string, unknown> = {}
        if (name) update.name = name
        if (role && ['admin', 'member'].includes(role)) update.role = role

        if (Object.keys(update).length === 0) {
            res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'name or role required' } })
            return
        }

        await db.update(users).set(update).where(eq(users.id, req.params.id))
        logger.info({ id: req.params.id, update }, 'User updated')
        res.json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'PATCH /api/users/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Update failed' } })
    }
})
