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
import * as usersRepo from '../repositories/users.repository.js'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'

export const usersRouter: RouterType = Router()


// ── GET /api/users ─────────────────────────────────────────────────────────────

usersRouter.get('/', async (req, res) => {
    // SEC-012: Listing all users is a super-admin-only operation
    if (!req.user?.isSuperAdmin) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Super admin access required' } })
        return
    }

    try {
        const rows = await usersRepo.listUsers(100)

        res.json({ items: rows, total: rows.length })
    } catch (err) {
        logger.error({ err }, 'GET /api/users failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list users' } })
    }
})

// ── GET /api/users/:id ────────────────────────────────────────────────────────

usersRouter.get('/:id', async (req, res) => {
    // SEC-012: mirror the super-admin gate from GET / — any authenticated user should not
    // be able to enumerate arbitrary user profiles by UUID.
    if (!req.user?.isSuperAdmin) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Super admin access required' } })
        return
    }
    if (!UUID_RE.test(req.params.id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }
    try {
        const user = await usersRepo.getUserById(req.params.id)

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
// User profile updates now happen through Better Auth's own API (auth.user).
// Plexo's users table is a postgres_fdw foreign table and is read-only by contract.
usersRouter.patch('/:id', (_req, res) => {
    res.status(410).json({
        error: {
            code: 'GONE',
            message: 'User profile updates moved to the Joeybuilt SSO (Better Auth) — call the auth service instead.',
        },
    })
})
