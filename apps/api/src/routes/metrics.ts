// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * /api/v1/metrics — Prometheus text exposition endpoint.
 *
 * Protected by a bearer token (METRICS_TOKEN env var) so the endpoint
 * can be scraped by Prometheus/Grafana Agent without tying scraping to
 * user sessions. If METRICS_TOKEN is unset, the endpoint requires a
 * super-admin session.
 *
 * The route is mounted as PUBLIC (pre-auth) in index.ts because the
 * bearer-token check here is the auth boundary. If no token is set,
 * we fall back to the session check using req.user, which will still
 * be populated if the caller happens to be authenticated.
 */

import { Router, type Router as RouterType } from 'express'
import { db, sql } from '@plexo/db'
import { render, setGauge } from '../lib/metrics.js'
import { logger } from '../logger.js'

export const metricsRouter: RouterType = Router()

function tokenOk(authHeader: string | undefined): boolean {
    const token = process.env.METRICS_TOKEN
    if (!token) return false
    if (!authHeader) return false
    const m = /^Bearer\s+(.+)$/i.exec(authHeader)
    if (!m) return false
    const supplied = (m[1] ?? '').trim()
    if (supplied.length !== token.length) return false
    let diff = 0
    for (let i = 0; i < token.length; i++) {
        diff |= supplied.charCodeAt(i) ^ token.charCodeAt(i)
    }
    return diff === 0
}

/**
 * Refresh DB-derived gauges immediately before rendering.
 * Each query is independent and non-fatal — a failed query leaves
 * the gauge at its previous value rather than breaking the whole scrape.
 */
async function refreshDbGauges(): Promise<void> {
    // Task counts by status
    try {
        const rows = await db.execute<{ status: string; n: string }>(sql`
            SELECT status::text AS status, COUNT(*)::text AS n
            FROM tasks
            GROUP BY status
        `)
        for (const r of rows as unknown as { status: string; n: string }[]) {
            setGauge('plexo_tasks_in_state', Number(r.n), { status: r.status })
        }
    } catch (err) { logger.debug({ err }, 'metrics: tasks_in_state query failed') }

    // Workspace count
    try {
        const [row] = await db.execute<{ n: string }>(sql`SELECT COUNT(*)::text AS n FROM workspaces`)
        setGauge('plexo_workspace_count', Number((row as { n?: string })?.n ?? 0))
    } catch (err) { logger.debug({ err }, 'metrics: workspace_count query failed') }

    // Memory entries
    try {
        const [row] = await db.execute<{ n: string }>(sql`SELECT COUNT(*)::text AS n FROM memory_entries`)
        setGauge('plexo_memory_entries_total', Number((row as { n?: string })?.n ?? 0))
    } catch (err) { logger.debug({ err }, 'metrics: memory_entries query failed') }

    // Active users (distinct user_id with any audit_log entry) — day/week/month
    const windows: Array<{ period: string; interval: string }> = [
        { period: 'day', interval: '1 day' },
        { period: 'week', interval: '7 days' },
        { period: 'month', interval: '30 days' },
    ]
    for (const w of windows) {
        try {
            const [row] = await db.execute<{ n: string }>(sql`
                SELECT COUNT(DISTINCT user_id)::text AS n
                FROM audit_log
                WHERE created_at >= NOW() - (${w.interval})::interval
                  AND user_id IS NOT NULL
            `)
            setGauge('plexo_active_users', Number((row as { n?: string })?.n ?? 0), { period: w.period })
        } catch (err) { logger.debug({ err, period: w.period }, 'metrics: active_users query failed') }
    }

    // Rolling 24h LLM cost / tokens derived from inference_logs — coarse but
    // useful without needing to instrument every provider call-site yet.
    try {
        const rows = await db.execute<{ provider: string; model: string; tokens_in: string; tokens_out: string; n: string }>(sql`
            SELECT
                COALESCE(provider, 'unknown') AS provider,
                model,
                COALESCE(SUM(input_tokens), 0)::text  AS tokens_in,
                COALESCE(SUM(output_tokens), 0)::text AS tokens_out,
                COUNT(*)::text AS n
            FROM inference_logs
            WHERE created_at >= NOW() - INTERVAL '24 hours'
            GROUP BY provider, model
            LIMIT 500
        `)
        // Use gauges for 24h-windowed aggregates (they're derived, not counters)
        for (const r of rows as unknown as { provider: string; model: string; tokens_in: string; tokens_out: string; n: string }[]) {
            setGauge('plexo_llm_requests_24h', Number(r.n), { provider: r.provider, model: r.model })
            setGauge('plexo_llm_tokens_24h', Number(r.tokens_in), { provider: r.provider, model: r.model, direction: 'in' })
            setGauge('plexo_llm_tokens_24h', Number(r.tokens_out), { provider: r.provider, model: r.model, direction: 'out' })
        }
    } catch (err) { logger.debug({ err }, 'metrics: inference_logs query failed') }

    // Workspace-level API cost (cumulative since week start, summed across workspaces)
    try {
        const [row] = await db.execute<{ total: string }>(sql`
            SELECT COALESCE(SUM(cost_usd), 0)::text AS total
            FROM api_cost_tracking
            WHERE week_start = (DATE_TRUNC('week', NOW())::date)
        `)
        setGauge('plexo_llm_cost_week_usd', Number((row as { total?: string })?.total ?? 0))
    } catch (err) { logger.debug({ err }, 'metrics: api_cost_tracking query failed') }
}

metricsRouter.get('/', async (req, res) => {
    // Bearer-token path (preferred for scrapers)
    const authHeader = (req.headers.authorization ?? req.headers.Authorization) as string | undefined
    const hasToken = !!process.env.METRICS_TOKEN
    const tokenAccepted = tokenOk(authHeader)

    // Fall back to super-admin session when no token is configured
    const sessionAccepted = !hasToken && !!req.user?.isSuperAdmin

    if (!tokenAccepted && !sessionAccepted) {
        res.status(401).type('text/plain').send('unauthorized\n')
        return
    }

    try {
        await refreshDbGauges()
    } catch (err) {
        logger.warn({ err }, 'metrics: refresh failed — returning cached values')
    }

    res.type('text/plain; version=0.0.4; charset=utf-8')
    res.status(200).send(render())
})
