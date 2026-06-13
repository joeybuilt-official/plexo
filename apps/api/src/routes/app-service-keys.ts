// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Admin App Service Keys API — A3 Phase 7.
 *
 * Mounted at /api/v1/admin/app-service-keys behind requireSuperAdmin.
 *
 *   GET    /                   — list keys (optional ?appId=)
 *   POST   /                   — issue a new key, returns raw token ONCE
 *   POST   /:id/rotate         — revoke + issue replacement (same appId, new name)
 *   POST   /:id/revoke         — set revoked=true
 *
 * Raw tokens are NEVER stored. We persist SHA-256(token + salt) + the salt,
 * matching the mcp_tokens pattern.
 */
import { Router, type Router as RouterType } from 'express'
import { z } from 'zod'
import { randomBytes, createHash } from 'crypto'
import * as keysRepo from '../repositories/app-service-keys.repository.js'
import { logger } from '../logger.js'

export const appServiceKeysRouter: RouterType = Router()

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateToken(): { token: string; salt: string; tokenHash: string } {
    const token = `psk_${randomBytes(32).toString('hex')}`
    const salt = randomBytes(32).toString('hex')
    const tokenHash = createHash('sha256').update(token + salt).digest('hex')
    return { token, salt, tokenHash }
}

type KeyRow = Awaited<ReturnType<typeof keysRepo.listKeys>>[number]

function withStatus(row: KeyRow) {
    const now = Date.now()
    const status: 'revoked' | 'expired' | 'active' = row.revoked
        ? 'revoked'
        : row.expiresAt && row.expiresAt.getTime() < now
            ? 'expired'
            : 'active'
    return { ...row, status }
}

// ── Schemas ──────────────────────────────────────────────────────────────────

const listQuerySchema = z.object({
    appId: z.string().min(1).optional(),
})

const issueSchema = z.object({
    appId: z.string().min(1),
    name: z.string().min(1),
    expiresInDays: z.number().int().positive().optional(),
    createdBy: z.string().min(1).optional(),
})

// ── Routes ───────────────────────────────────────────────────────────────────

appServiceKeysRouter.get('/', async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query)
    if (!parsed.success) {
        return res.status(400).json({
            error: { code: 'VALIDATION_ERROR', message: 'Invalid query', details: parsed.error.flatten().fieldErrors },
        })
    }
    try {
        const rows = await keysRepo.listKeys({ appId: parsed.data.appId })
        return res.json({ items: rows.map(withStatus), total: rows.length })
    } catch (err) {
        logger.error({ err }, 'GET /admin/app-service-keys failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list keys' } })
    }
})

appServiceKeysRouter.post('/', async (req, res) => {
    const parsed = issueSchema.safeParse(req.body)
    if (!parsed.success) {
        return res.status(400).json({
            error: { code: 'VALIDATION_ERROR', message: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        })
    }
    const { appId, name, expiresInDays } = parsed.data
    const createdBy = parsed.data.createdBy ?? req.user?.id ?? null
    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000) : null

    try {
        const { token, salt, tokenHash } = generateToken()
        const { id } = await keysRepo.insertKey({ appId, name, tokenHash, tokenSalt: salt, expiresAt, createdBy })
        logger.info({ event: 'app_service_key_issued', id, appId, name, by: createdBy }, 'App service key issued')
        return res.status(201).json({ id, appId, name, token })
    } catch (err) {
        logger.error({ err, appId, name }, 'POST /admin/app-service-keys failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to issue key' } })
    }
})

appServiceKeysRouter.post('/:id/rotate', async (req, res) => {
    const id = req.params.id as string
    try {
        const existing = await keysRepo.getById(id)
        if (!existing) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Key not found' } })
        }
        // Revoke the old key; issue a fresh one tied to the same appId. We append
        // a timestamp to the name so the (app_id,name) unique index doesn't trip.
        await keysRepo.revokeKey(existing.id)
        const newName = `${existing.name}#${Date.now()}`
        const createdBy = req.user?.id ?? null
        const { token, salt, tokenHash } = generateToken()
        const { id: newId } = await keysRepo.insertKey({
            appId: existing.appId,
            name: newName,
            tokenHash,
            tokenSalt: salt,
            expiresAt: null,
            createdBy,
        })
        logger.info({ event: 'app_service_key_rotated', oldId: existing.id, newId, appId: existing.appId, by: createdBy }, 'App service key rotated')
        return res.status(201).json({ id: newId, appId: existing.appId, name: newName, token })
    } catch (err) {
        logger.error({ err, id }, 'POST /admin/app-service-keys/:id/rotate failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to rotate key' } })
    }
})

appServiceKeysRouter.post('/:id/revoke', async (req, res) => {
    const id = req.params.id as string
    try {
        const existing = await keysRepo.getById(id)
        if (!existing) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Key not found' } })
        }
        await keysRepo.revokeKey(id)
        logger.info({ event: 'app_service_key_revoked', id, appId: existing.appId, by: req.user?.id ?? null }, 'App service key revoked')
        return res.json({ ok: true })
    } catch (err) {
        logger.error({ err, id }, 'POST /admin/app-service-keys/:id/revoke failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to revoke key' } })
    }
})
