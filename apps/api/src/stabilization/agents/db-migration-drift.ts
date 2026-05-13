// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Compares Drizzle's `__drizzle_migrations` ledger to the on-disk
 * migration files in `packages/db/drizzle/`. Any disk file that isn't
 * applied — or any applied entry without a matching file — indicates
 * deploy/code drift that almost always presages an outage.
 */

import type { Agent, Alert } from './index.js'
import { promises as fs } from 'fs'
import { join } from 'path'

const MIGRATION_DIR = process.env.PLEXO_MIGRATION_DIR
    ?? join(process.cwd(), 'packages', 'db', 'drizzle')

export const dbMigrationDrift: Agent = {
    name: 'db-migration-drift',
    intervalSec: 30 * 60,
    async check(): Promise<Alert | null> {
        const at = new Date().toISOString()
        let onDisk: string[]
        try {
            const dirEntries = await fs.readdir(MIGRATION_DIR)
            onDisk = dirEntries
                .filter((f) => f.endsWith('.sql'))
                .map((f) => f.replace(/\.sql$/, ''))
                .sort()
        } catch (err) {
            return {
                agent: 'db-migration-drift',
                at,
                severity: 'warn',
                message: `Migration dir unreadable: ${err instanceof Error ? err.message : String(err)}`,
                metadata: { dir: MIGRATION_DIR },
            }
        }

        try {
            const { db, sql } = await import('@plexo/db')
            const rows = await db.execute<{ hash: string }>(sql`
                SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id ASC
            `)
            const applied = rows.map((r) => r.hash).filter(Boolean)
            // Drizzle stores migration hashes, not filenames, so we can't do
            // a strict 1:1 set diff. Instead we count: applied count should
            // match the number of on-disk files. Mismatch → drift.
            if (applied.length !== onDisk.length) {
                return {
                    agent: 'db-migration-drift',
                    at,
                    severity: 'critical',
                    message: `Migration count drift: ${applied.length} applied vs ${onDisk.length} on disk`,
                    metadata: { applied: applied.length, onDisk: onDisk.length, dir: MIGRATION_DIR },
                }
            }
            return null
        } catch (err) {
            return {
                agent: 'db-migration-drift',
                at,
                severity: 'warn',
                message: `Migration ledger probe failed: ${err instanceof Error ? err.message : String(err)}`,
            }
        }
    },
}
