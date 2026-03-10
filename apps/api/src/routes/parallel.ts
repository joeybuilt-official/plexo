// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { getParallelStatus, claimBatch, releaseSlot, clearAllSlots } from '../parallel-executor.js'

export const parallelRouter: RouterType = Router()

parallelRouter.get('/status', async (req, res, next) => {
    try {
        const status = await getParallelStatus()
        res.json(status)
    } catch (err) {
        next(err)
    }
})

parallelRouter.post('/claim-batch', async (req, res, next) => {
    try {
        const batch = await claimBatch()
        res.json({ claimed: batch.length, tasks: batch.map(t => t.id) })
    } catch (err) {
        next(err)
    }
})

parallelRouter.post('/release/:id', async (req, res, next) => {
    try {
        await releaseSlot(req.params.id!)
        res.json({ success: true })
    } catch (err) {
        next(err)
    }
})

parallelRouter.post('/clear', async (req, res, next) => {
    try {
        await clearAllSlots()
        res.json({ success: true })
    } catch (err) {
        next(err)
    }
})
