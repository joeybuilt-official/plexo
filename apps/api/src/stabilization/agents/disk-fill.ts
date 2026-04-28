// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Reads the filesystem stats for /var/lib/docker (or PLEXO_DISK_PATH)
 * and alerts when usage exceeds 85%. Disk-full incidents are the
 * single most common cause of silent service failure on the VPS, and
 * by the time pgsql or Redis notices, recovery is hard.
 */

import type { Agent, Alert } from './index.js'
import { statfs } from 'fs/promises'

const DISK_PATH = process.env.PLEXO_DISK_PATH ?? '/var/lib/docker'
const FILL_THRESHOLD = parseFloat(process.env.DISK_FILL_THRESHOLD ?? '0.85')

export const diskFill: Agent = {
    name: 'disk-fill',
    intervalSec: 5 * 60,
    async check(): Promise<Alert | null> {
        const at = new Date().toISOString()
        try {
            // statfs is Node 18+; types may not declare it on older @types/node.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const stats = await (statfs as unknown as (p: string) => Promise<any>)(DISK_PATH)
            const total = Number(stats.bsize) * Number(stats.blocks)
            const free = Number(stats.bsize) * Number(stats.bavail)
            if (!Number.isFinite(total) || total <= 0) return null
            const used = total - free
            const usage = used / total
            if (usage > FILL_THRESHOLD) {
                return {
                    agent: 'disk-fill',
                    at,
                    severity: 'critical',
                    message: `Disk ${DISK_PATH} at ${(usage * 100).toFixed(1)}% (>${(FILL_THRESHOLD * 100).toFixed(0)}%)`,
                    metadata: {
                        path: DISK_PATH,
                        usage,
                        usedBytes: used,
                        totalBytes: total,
                        threshold: FILL_THRESHOLD,
                    },
                }
            }
            return null
        } catch (err) {
            // Path missing is informational, not critical
            return {
                agent: 'disk-fill',
                at,
                severity: 'warn',
                message: `Disk probe at ${DISK_PATH} failed: ${err instanceof Error ? err.message : String(err)}`,
            }
        }
    },
}
