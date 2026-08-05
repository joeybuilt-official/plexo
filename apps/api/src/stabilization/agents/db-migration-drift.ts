// SPDX-License-Identifier: MIT
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
            const { db } = await import('@plexo/db')
            const { sql } = await import('drizzle-orm')
            const rows = await db.execute<{ hash: string }>(sql`
                SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id ASC
            `)
            const applied = rows.map((r) => r.hash).filter(Boolean)
            // The repo INTENTIONALLY keeps hand-SQL (0130+) and DRAFT_* OUT of
            // meta/_journal.json — they're applied via apply-orphaned-sql.ts and
            // never journaled, so drizzle won't re-apply them on prod. Counting
            // ALL on-disk .sql therefore over-reports drift by the orphan count
            // (it can never read 0). Compare the applied ledger against the
            // JOURNALED files only; orphans + DRAFT_ are expected on disk.
            let expected = onDisk
            try {
                const journalRaw = await fs.readFile(join(MIGRATION_DIR, 'meta', '_journal.json'), 'utf-8')
                const journaledTags = new Set(
                    (JSON.parse(journalRaw) as { entries: Array<{ tag: string }> }).entries.map((e) => e.tag),
                )
                expected = onDisk.filter((tag) => journaledTags.has(tag))
            } catch {
                // No journal readable — fall back to counting all on-disk files.
            }
            if (applied.length !== expected.length) {
                return {
                    agent: 'db-migration-drift',
                    at,
                    severity: 'critical',
                    message: `Migration count drift: ${applied.length} applied vs ${expected.length} journaled on disk`,
                    metadata: { applied: applied.length, journaledOnDisk: expected.length, onDiskTotal: onDisk.length, dir: MIGRATION_DIR },
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
