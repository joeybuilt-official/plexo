import { Router, type Router as RouterType } from 'express'
import bcrypt from 'bcrypt'
import { z } from 'zod'
import { db, eq } from '@plexo/db'
import { users, workspaces } from '@plexo/db'
import { logger } from '../logger.js'

export const authRouter: RouterType = Router()

const RegisterSchema = z.object({
    name: z.string().min(1).max(100),
    email: z.string().email(),
    password: z.string().min(12).max(128),
})

// POST /api/auth/register
authRouter.post('/register', async (req, res) => {
    const parse = RegisterSchema.safeParse(req.body)
    if (!parse.success) {
        res.status(400).json({
            error: { code: 'VALIDATION_ERROR', issues: parse.error.issues },
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
        role: 'member',
    }).returning({ id: users.id, email: users.email })

    const user = inserted[0]
    if (!user) {
        res.status(500).json({ error: { code: 'INSERT_FAILED', message: 'Failed to create user' } })
        return
    }

    // Create default workspace for the new user
    await db.insert(workspaces).values({
        name: `${name}'s workspace`,
        ownerId: user.id,
        settings: {},
    })

    logger.info({ userId: user.id }, 'User registered')
    res.status(201).json({ id: user.id, email: user.email })
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
