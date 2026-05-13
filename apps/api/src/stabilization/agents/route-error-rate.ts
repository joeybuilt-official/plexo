// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Reads the in-process `plexo_http_requests_total` counter series and
 * alerts when any single (method, route) pair has a 5xx rate above 5%
 * with at least MIN_REQUESTS samples.
 *
 * The counter is cumulative since process start, so the alert fires
 * once a route goes unhealthy and stays until the process restarts —
 * for short-lived spikes this is a feature (visibility), not a bug.
 */

import type { Agent, Alert } from './index.js'
import { getCounterSeries } from '../../lib/metrics.js'

const ERROR_RATE_THRESHOLD = parseFloat(process.env.ROUTE_5XX_THRESHOLD ?? '0.05')
const MIN_REQUESTS = parseInt(process.env.ROUTE_MIN_REQUESTS ?? '20', 10)

interface RouteAggregate {
    method: string
    route: string
    total: number
    fiveXx: number
}

function aggregate(): RouteAggregate[] {
    const series = getCounterSeries('plexo_http_requests_total')
    const map = new Map<string, RouteAggregate>()
    for (const s of series) {
        const method = String(s.labels.method ?? 'GET')
        const route = String(s.labels.route ?? 'unknown')
        const status = String(s.labels.status ?? '0')
        const key = `${method} ${route}`
        let agg = map.get(key)
        if (!agg) {
            agg = { method, route, total: 0, fiveXx: 0 }
            map.set(key, agg)
        }
        agg.total += s.value
        if (status.startsWith('5')) agg.fiveXx += s.value
    }
    return Array.from(map.values())
}

export const routeErrorRate: Agent = {
    name: 'route-error-rate',
    intervalSec: 5 * 60,
    async check(): Promise<Alert | null> {
        const at = new Date().toISOString()
        const counts = aggregate()
        if (counts.length === 0) return null

        const offenders = counts
            .filter((c) => c.total >= MIN_REQUESTS)
            .map((c) => ({ ...c, rate: c.total > 0 ? c.fiveXx / c.total : 0 }))
            .filter((c) => c.rate > ERROR_RATE_THRESHOLD)
            .sort((a, b) => b.rate - a.rate)

        if (offenders.length === 0) return null
        return {
            agent: 'route-error-rate',
            at,
            severity: 'error',
            message: `${offenders.length} route(s) above ${(ERROR_RATE_THRESHOLD * 100).toFixed(0)}% 5xx rate`,
            metadata: {
                offenders: offenders.slice(0, 10).map((o) => ({
                    method: o.method,
                    route: o.route,
                    rate: Number(o.rate.toFixed(4)),
                    total: o.total,
                    fiveXx: o.fiveXx,
                })),
            },
        }
    },
}
