// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Jex Identity Mesh API (ADR-0016 B3) — Plexo as identity COORDINATOR.
 *
 * POST /api/jex/identity/recognition      — record a cross-app recognition (idempotent)
 * GET  /api/jex/identity/profile/:userId  — canonical mesh-wide profile, 404 if unknown
 *
 * Both require a valid PLEXO_SERVICE_KEY (Bearer) via requireMeshServiceKey.
 * The wire contract is fixed by the client shipping in Nexalog (PlexoCoordinator).
 * The edge only validates + maps errors; all identity logic lives in the
 * use-cases behind JexRecognitionRepository (Dependency Rule).
 */

import { Router, type Router as RouterType } from 'express'
import { z } from 'zod'
import { logger } from '../logger.js'
import { requireMeshServiceKey } from '../middleware/service-key-auth.js'
import type { JexRecognitionRepository } from '../application/jex/ports.js'
import { makeRecordRecognition } from '../application/jex/record-recognition.js'
import { makeGetProfile } from '../application/jex/get-profile.js'

const recognitionSchema = z.object({
    appId: z.string().min(1).max(64),
    userId: z.string().uuid(),
    email: z.string().email(),
    credentialId: z.string().min(1).max(1024),
})

const userIdSchema = z.string().uuid()

export function makeJexIdentityRouter(repo: JexRecognitionRepository): RouterType {
    const router = Router()
    const recordRecognition = makeRecordRecognition(repo)
    const getProfile = makeGetProfile(repo)

    router.use(requireMeshServiceKey)

    router.post('/identity/recognition', async (req, res) => {
        const parsed = recognitionSchema.safeParse(req.body)
        if (!parsed.success) {
            return res.status(400).json({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Invalid request body',
                    details: parsed.error.flatten().fieldErrors,
                },
            })
        }
        try {
            await recordRecognition(parsed.data)
            return res.status(204).end()
        } catch (err) {
            logger.error({ err }, 'jex recognition upsert failed')
            return res.status(500).json({ error: { code: 'INTERNAL', message: 'Failed to record recognition' } })
        }
    })

    router.get('/identity/profile/:userId', async (req, res) => {
        if (!userIdSchema.safeParse(req.params.userId).success) {
            return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'userId must be a UUID' } })
        }
        try {
            const profile = await getProfile(req.params.userId)
            if (!profile) {
                return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown identity' } })
            }
            return res.status(200).json(profile)
        } catch (err) {
            logger.error({ err }, 'jex profile fetch failed')
            return res.status(500).json({ error: { code: 'INTERNAL', message: 'Failed to fetch profile' } })
        }
    })

    return router
}
