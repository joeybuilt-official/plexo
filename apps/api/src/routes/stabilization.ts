// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType, type Request, type Response, type NextFunction } from 'express'
import { timingSafeEqual } from 'crypto'
import { logger } from '../logger.js'
import * as stabilizationRepo from '../repositories/stabilization.repository.js'

export const stabilizationRouter: RouterType = Router()

// ── Service Key Guard ───────────────────────────────────────
// Ops harness scripts authenticate via X-Plexo-Service-Key.
// No user impersonation needed — these are machine-to-machine calls.

function requireServiceKey(req: Request, res: Response, next: NextFunction): void {
    const configured = process.env.PLEXO_SERVICE_KEY
    if (!configured) {
        res.status(503).json({ error: 'Service key not configured' })
        return
    }

    const provided = req.headers['x-plexo-service-key']
    if (typeof provided !== 'string' || provided.length === 0) {
        res.status(401).json({ error: 'Missing X-Plexo-Service-Key' })
        return
    }

    if (provided.length !== configured.length ||
        !timingSafeEqual(Buffer.from(provided), Buffer.from(configured))) {
        res.status(401).json({ error: 'Invalid service key' })
        return
    }

    next()
}

stabilizationRouter.use(requireServiceKey)

// ── GET /dashboard ──────────────────────────────────────────

stabilizationRouter.get('/dashboard', async (_req, res, next) => {
    try {
        const results = await Promise.all([
                stabilizationRepo.getLatestCycle(),
                stabilizationRepo.getCycleHistory(),
                stabilizationRepo.getLatestWorkloads(),
                stabilizationRepo.getSclEval(),
                stabilizationRepo.getFixerActivity(),
                stabilizationRepo.getOpenFindings(),
                stabilizationRepo.getProactiveAgents(),
                stabilizationRepo.getConversationQuality(),
            ])

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw SQL result typing
        const rows = (arr: unknown) => arr as any[]
        const [currentCycle, cycleHistory, workloads, sclEval, fixerActivity, findings, proactiveAgents, conversationQuality] = results

        const cycleRows = rows(cycleHistory)
        const latestRow = rows(currentCycle)[0]

        res.json({
            currentCycle: latestRow?.metadata ?? null,
            cycleHistory: cycleRows.map((r: any) => r.metadata),
            workloads: rows(workloads).map((r: any) => ({
                id: r.metadata?.workloadId ?? r.metric_name,
                name: r.metric_name,
                passed: r.metadata?.passed ?? r.metric_value > 0,
                latencyMs: r.metadata?.latencyMs ?? 0,
                quality: r.metric_value,
                error: r.metadata?.error,
                timestamp: r.created_at,
            })),
            sclEval: rows(sclEval).length > 0 ? rows(sclEval)[0]?.metadata : null,
            fixerActivity: rows(fixerActivity).map((r: any) => ({ ...r.metadata, _created_at: r.created_at })),
            findings: rows(findings).map((r: any) => r.metadata),
            proactiveAgents: rows(proactiveAgents).map((r: any) => ({ ...r.metadata, _created_at: r.created_at })),
            conversationQuality: rows(conversationQuality).map((r: any) => r.metadata),
        })
    } catch (err) {
        next(err)
    }
})

// ── POST /cycle ─────────────────────────────────────────────

// Accept the shape the execution loop actually sends
interface CycleBody {
    workspaceId: string
    cycle: number
    scenarios: { passed: number; failed: number; errors?: string[] }
    workloads: { ran: boolean; passed: number; failed: number; errors?: string[] }
    sclEval: { ran: boolean; recallAt5?: number; precisionAt5?: number; ndcgAt5?: number }
    security: { ran: boolean; passed: boolean; findings?: string[] }
    tests: { passed: boolean; summary?: string; deferred?: boolean }
    sloBreaches: string[]
    timestamp: string
}

stabilizationRouter.post('/cycle', async (req, res, next) => {
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body = req.body as CycleBody & { _proactiveAgent?: any; _conversationQuality?: any; _fixDispatch?: any }
        if (!body.workspaceId) {
            return res.status(400).json({ error: 'workspaceId required' })
        }

        const ts = body.timestamp ? new Date(body.timestamp) : new Date()
        const wsId = body.workspaceId

        // Conversation quality eval — different eval_type
        if (body._conversationQuality) {
            const cq = body._conversationQuality
            await stabilizationRepo.insertConversationQuality(wsId, 'cq_' + ts.getTime(), cq.passed ?? 0, JSON.stringify(cq), ts.toISOString())
            logger.info({ passed: cq.passed, failed: cq.failed, wsId }, 'Conversation quality eval recorded')
            return res.status(201).json({ ok: true, conversationQuality: true })
        }

        // Fix dispatch results — store as 'fixer' eval_type, not a regular cycle
        if (body._fixDispatch) {
            const fd = body._fixDispatch
            await stabilizationRepo.insertFixDispatch(wsId, 'fd_' + ts.getTime(), fd.improved ?? 0, JSON.stringify(fd), ts.toISOString())
            logger.info({ total: fd.total, improved: fd.improved, wsId }, 'Fix dispatch results recorded')
            return res.status(201).json({ ok: true, fixDispatch: true })
        }

        // Proactive agent activity — different eval_type
        if (body._proactiveAgent) {
            const agentData = body._proactiveAgent
            await stabilizationRepo.insertProactiveAgent(wsId, agentData.id, agentData.status === 'completed' ? 1 : 0, JSON.stringify(agentData), ts.toISOString())
            logger.info({ agent: agentData.id, status: agentData.status, wsId }, 'Proactive agent activity recorded')
            return res.status(201).json({ ok: true, agent: agentData.id })
        }

        // Regular stabilization cycle
        if (body.cycle == null) {
            return res.status(400).json({ error: 'cycle number required' })
        }

        const metadata = {
            cycle: body.cycle,
            timestamp: ts.toISOString(),
            scenarios: body.scenarios,
            workloads: body.workloads,
            sclEval: body.sclEval,
            security: body.security ? (body.security.passed ? 'PASS' : 'FAIL') : 'N/A',
            tests: body.tests ? (body.tests.deferred || body.tests.passed ? 'GREEN' : 'RED') : 'N/A',
            sloBreaches: Array.isArray(body.sloBreaches) ? body.sloBreaches.length : (body.sloBreaches ?? 0),
        }

        await stabilizationRepo.insertCycle(wsId, 'cycle_' + body.cycle, body.scenarios?.failed === 0 ? 1 : 0, JSON.stringify(metadata), ts.toISOString())

        logger.info({ cycle: body.cycle, wsId }, 'Stabilization cycle recorded')
        res.status(201).json({ ok: true, cycle: body.cycle })
    } catch (err) {
        next(err)
    }
})

// ── POST /workload ──────────────────────────────────────────

interface WorkloadBody {
    workspaceId: string
    results: Array<{
        id: string
        name: string
        passed: boolean
        latencyMs: number
        quality: number
        error?: string
    }>
}

stabilizationRouter.post('/workload', async (req, res, next) => {
    try {
        const body = req.body as WorkloadBody
        if (!body.workspaceId || !Array.isArray(body.results) || body.results.length === 0) {
            return res.status(400).json({ error: 'workspaceId and non-empty results array required' })
        }

        const now = new Date()
        const wsId = body.workspaceId

        for (const r of body.results) {
            const metadata = {
                workloadId: r.id,
                passed: r.passed,
                latencyMs: r.latencyMs,
                quality: r.quality,
                ...(r.error ? { error: r.error } : {}),
            }
            await stabilizationRepo.insertWorkload(wsId, r.name, r.quality ?? 0, JSON.stringify(metadata), now.toISOString())
        }

        logger.info({ wsId, count: body.results.length }, 'Stabilization workload results recorded')
        res.status(201).json({ ok: true, resultsWritten: body.results.length })
    } catch (err) {
        next(err)
    }
})
