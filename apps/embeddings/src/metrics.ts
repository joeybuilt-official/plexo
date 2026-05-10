// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Request metrics — tracks embedding request stats for observability
 * and future self-improvement.
 */

import pino from 'pino'

const logger = pino({ name: 'metrics' })

interface RequestRecord {
    timestamp: string
    inputLength: number
    tokenCount: number
    latencyMs: number
    batchSize: number
    model: string
}

// Ring buffer for recent requests (last 1000)
const MAX_RECORDS = 1000
const records: RequestRecord[] = []
let totalRequests = 0
let totalTokens = 0
let totalLatencyMs = 0

export function recordRequest(record: Omit<RequestRecord, 'timestamp'>): void {
    const entry: RequestRecord = {
        ...record,
        timestamp: new Date().toISOString(),
    }

    if (records.length >= MAX_RECORDS) {
        records.shift()
    }
    records.push(entry)

    totalRequests++
    totalTokens += record.tokenCount
    totalLatencyMs += record.latencyMs
}

export interface MetricsSummary {
    totalRequests: number
    totalTokens: number
    avgLatencyMs: number
    p50LatencyMs: number
    p95LatencyMs: number
    p99LatencyMs: number
    recentRequests: number
}

export function getMetrics(): MetricsSummary {
    const latencies = records.map(r => r.latencyMs).sort((a, b) => a - b)
    const p = (pct: number) => {
        if (latencies.length === 0) return 0
        const idx = Math.ceil(latencies.length * pct / 100) - 1
        return latencies[Math.max(0, idx)]!
    }

    return {
        totalRequests,
        totalTokens,
        avgLatencyMs: totalRequests > 0 ? totalLatencyMs / totalRequests : 0,
        p50LatencyMs: p(50),
        p95LatencyMs: p(95),
        p99LatencyMs: p(99),
        recentRequests: records.length,
    }
}
