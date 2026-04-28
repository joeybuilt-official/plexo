// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Memory-pattern embedding coverage: alerts if more than 10% of memory
 * patterns lack an embedding. Low coverage silently breaks similarity
 * recall (the agent appears amnesic) without throwing visible errors.
 *
 * Threshold tuned to the audit baseline (>= 90% covered).
 */

import type { Agent, Alert } from './index.js'

const COVERAGE_THRESHOLD = parseFloat(process.env.CLUSTER_COVERAGE_THRESHOLD ?? '0.90')

export const clusterCoverage: Agent = {
    name: 'cluster-coverage',
    intervalSec: 30 * 60,
    async check(): Promise<Alert | null> {
        const at = new Date().toISOString()
        try {
            const { db, sql } = await import('@plexo/db')
            const rows = await db.execute<{ total: number; embedded: number }>(sql`
                SELECT
                    COUNT(*)::int AS total,
                    COUNT(embedding)::int AS embedded
                FROM memory_patterns
            `)
            const row = rows[0]
            if (!row || row.total === 0) return null
            const coverage = row.embedded / row.total
            if (coverage < COVERAGE_THRESHOLD) {
                return {
                    agent: 'cluster-coverage',
                    at,
                    severity: 'warn',
                    message: `Memory embedding coverage ${(coverage * 100).toFixed(1)}% < threshold ${(COVERAGE_THRESHOLD * 100).toFixed(0)}%`,
                    metadata: { coverage, total: row.total, embedded: row.embedded, threshold: COVERAGE_THRESHOLD },
                }
            }
            return null
        } catch (err) {
            // memory_patterns may not exist on all deployments — treat as informational
            return {
                agent: 'cluster-coverage',
                at,
                severity: 'warn',
                message: `Cluster coverage probe failed: ${err instanceof Error ? err.message : String(err)}`,
            }
        }
    },
}
