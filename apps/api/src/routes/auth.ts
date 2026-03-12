// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import bcrypt from 'bcrypt'
import { z } from 'zod'
import { db, eq, sql, and } from '@plexo/db'
import { users, accounts, workspaces, workspaceMembers } from '@plexo/db'
import { logger } from '../logger.js'
import { captureLifecycleEvent } from '../sentry.js'

export const authRouter: RouterType = Router()

const RegisterSchema = z.object({
    name: z.string().min(1).max(100),
    email: z.string().email(),
    password: z.string().min(12).max(128),
})

// POST /api/auth/register
// Open only when no users exist (first-run); closed thereafter.
authRouter.post('/register', async (req, res) => {
    const parse = RegisterSchema.safeParse(req.body)
    if (!parse.success) {
        res.status(400).json({
            error: { code: 'VALIDATION_ERROR', issues: parse.error.issues },
        })
        return
    }

    // First-run gate: only allow registration when no users exist yet
    const rows = await db.select({ count: sql<number>`count(*)` }).from(users)
    if (Number(rows[0]?.count || 0) > 0) {
        res.status(403).json({
            error: { code: 'REGISTRATION_CLOSED', message: 'Registration is closed. Contact your administrator.' },
        })
        return
    }

    const { name, email, password } = parse.data

    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
    if (existing.length > 0) {
        res.status(409).json({ error: { code: 'EMAIL_TAKEN', message: 'An account with that email already exists' } })
        return
    }

    const passwordHash = await bcrypt.hash(password, 12)

    const inserted = await db.insert(users).values({
        email,
        name,
        passwordHash,
        role: 'admin',  // first user is always admin
    }).returning({ id: users.id, email: users.email })

    const user = inserted[0]
    if (!user) {
        res.status(500).json({ error: { code: 'INSERT_FAILED', message: 'Failed to create user' } })
        return
    }

    captureLifecycleEvent('user.registered', 'info', { userId: user.id, role: 'admin' })
    logger.info({ userId: user.id }, 'First user registered (admin)')
    res.status(201).json({ id: user.id, email: user.email })
})

// GET /api/auth/setup-status — returns whether initial setup is needed
authRouter.get('/setup-status', async (_req, res) => {
    const rows = await db.select({ count: sql<number>`count(*)` }).from(users)
    const needsSetup = Number(rows[0]?.count || 0) === 0
    res.json({ needsSetup })
})

// POST /api/auth/verify-password — used by Auth.js credentials provider
authRouter.post('/verify-password', async (req, res) => {
    const { email, password } = req.body as { email?: string; password?: string }
    if (!email || !password) {
        res.status(400).json({ error: 'Missing email or password' })
        return
    }

    const [user] = await db
        .select({ id: users.id, email: users.email, name: users.name, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.email, email))
        .limit(1)

    if (!user || !user.passwordHash) {
        // Constant-time delay to prevent user enumeration
        await bcrypt.hash('dummy', 12)
        res.status(401).json({ error: 'Invalid credentials' })
        return
    }

    const ok = await bcrypt.compare(password, user.passwordHash)
    if (!ok) {
        res.status(401).json({ error: 'Invalid credentials' })
        return
    }

    res.json({ id: user.id, email: user.email, name: user.name })
})

const OAuthSyncSchema = z.object({
    email: z.string().email(),
    name: z.string().optional().nullable(),
    image: z.string().optional().nullable(),
    provider: z.string(),
    providerAccountId: z.string(),
})

// POST /api/auth/sync-oauth - internal only route used by NextAuth to lazily provision OAuth users
authRouter.post('/sync-oauth', async (req, res) => {
    const parse = OAuthSyncSchema.safeParse(req.body)
    if (!parse.success) {
        res.status(400).json({ error: 'invalid body', issues: parse.error.issues })
        return
    }
    const { email, name, image, provider, providerAccountId } = parse.data

    try {
        let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1)

        if (!user) {
            // First-run gate: only allow registration when no users exist yet
            const rows = await db.select({ count: sql<number>`count(*)` }).from(users)
            const count = Number(rows[0]?.count || 0)

            if (count > 0) {
                logger.warn({ email, provider }, 'Blocked OAuth registration - registration is closed')
                res.status(403).json({ error: 'REGISTRATION_CLOSED', message: 'Registration is closed. Contact your administrator.' })
                return
            }

            const inserted = await db.insert(users).values({
                email,
                name: name ?? undefined,
                image: image ?? undefined,
                role: 'admin',
            }).returning()
            user = inserted[0]!
            logger.info({ userId: user.id, provider }, 'Created user from OAuth sync (admin)')
        }

        const [existingAccount] = await db.select().from(accounts)
            .where(
                and(
                    eq(accounts.provider, provider),
                    eq(accounts.providerAccountId, providerAccountId)
                )
            ).limit(1)

        if (!existingAccount) {
            await db.insert(accounts).values({
                userId: user.id,
                type: 'oauth',
                provider,
                providerAccountId,
            })
        }

        res.json({ id: user.id, email: user.email })
    } catch (err) {
        logger.error({ err }, 'POST /api/auth/sync-oauth failed')
        res.status(500).json({ error: 'Internal server error' })
    }
})

// POST /api/auth/workspace — create a workspace (used by setup wizard)
authRouter.post('/workspace', async (req, res) => {
    const { name, ownerId: bodyOwnerId } = req.body as { name?: string; ownerId?: string }
    if (!name?.trim()) {
        res.status(400).json({ error: { code: 'MISSING_NAME', message: 'name required' } })
        return
    }

    try {
        // Resolve owner: explicit body param → first registered user (setup wizard case)
        let resolvedOwnerId = bodyOwnerId
        if (!resolvedOwnerId) {
            const [firstUser] = await db
                .select({ id: users.id })
                .from(users)
                .limit(1)
            if (!firstUser) {
                res.status(400).json({
                    error: { code: 'NO_USERS', message: 'Create a user account before setup' },
                })
                return
            }
            resolvedOwnerId = firstUser.id
        }

        const [ws] = await db.insert(workspaces).values({
            name: name.trim(),
            ownerId: resolvedOwnerId,
            settings: {},
        }).returning({ workspaceId: workspaces.id })

        // Seed the owner as a member so the Members page shows them immediately
        await db.insert(workspaceMembers).values({
            workspaceId: ws!.workspaceId,
            userId: resolvedOwnerId,
            role: 'owner',
        }).onConflictDoNothing()

        captureLifecycleEvent('workspace.created', 'info', { workspaceId: ws!.workspaceId, name: name.trim() })
        logger.info({ name: name.trim(), ownerId: resolvedOwnerId }, 'Workspace created')
        res.status(201).json({ workspaceId: ws!.workspaceId, name: name.trim() })
    } catch (err) {
        logger.error({ err }, 'POST /api/auth/workspace failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create workspace' } })
    }
})


