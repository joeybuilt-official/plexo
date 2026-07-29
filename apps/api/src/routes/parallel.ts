// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { getParallelStatus, claimBatch, releaseSlot, clearAllSlots } from '../parallel-executor.js'
import { logger } from '../logger.js'

export const parallelRouter: RouterType = Router()

parallelRouter.get('/status', async (req, res, next) => {
    try {
        const status = await getParallelStatus()
        res.json(status)
    } catch (err) {
        logger.error({ err }, 'parallel executor route error')
        next(err)
    }
})

parallelRouter.post('/claim-batch', async (req, res, next) => {
    try {
        const batch = await claimBatch()
        res.json({ claimed: batch.length, tasks: batch.map(t => t.id) })
    } catch (err) {
        logger.error({ err }, 'parallel executor route error')
        next(err)
    }
})

parallelRouter.post('/release/:id', async (req, res, next) => {
    try {
        await releaseSlot(req.params.id!)
        res.json({ success: true })
    } catch (err) {
        logger.error({ err }, 'parallel executor route error')
        next(err)
    }
})

parallelRouter.post('/clear', async (req, res, next) => {
    try {
        await clearAllSlots()
        res.json({ success: true })
    } catch (err) {
        logger.error({ err }, 'parallel executor route error')
        next(err)
    }
})
