// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Apply un-journaled ("orphaned") hand-SQL migrations — opt-in via
 * APPLY_ORPHANED_SQL=1 in migrate.sh (set only by docker-compose.e2e.yml).
 *
 * Repo convention keeps hand-SQL (0130+) OUT of meta/_journal.json so drizzle
 * never re-applies against prod DBs where they were applied manually. A fresh
 * e2e stack therefore lacks those tables; this script closes that gap by
 * applying every on-disk *.sql whose basename is not a journal tag (skipping
 * DRAFT_*), in filename order.
 *
 * Idempotency: statements are executed one at a time (never inside a
 * transaction — 0136 uses CREATE INDEX CONCURRENTLY, which forbids one) and
 * duplicate-object error codes are tolerated. Any other error fails loud.
 */

import path from 'node:path'
import { readdirSync, readFileSync } from 'node:fs'
import postgres from 'postgres'

const TOLERATED = new Set([
    '42P07', // duplicate_table / duplicate index
    '42701', // duplicate_column
    '42710', // duplicate_object
    '42P06', // duplicate_schema
    '42723', // duplicate_function
])

function statementsOf(fileText: string): string[] {
    const chunks = fileText.split(/-->\s*statement-breakpoint/)
    const stmts: string[] = []
    for (const chunk of chunks) {
        if (chunk.includes('$$')) {
            // DO $$ ... $$ bodies contain internal semicolons — never split them.
            // Authoring convention: $$ blocks must be breakpoint-isolated (0141 is);
            // trailing statements after the block would run in one implicit tx.
            const trimmed = chunk.trim()
            if (/\$\$\s*;[\s\S]*\S/.test(trimmed.slice(trimmed.lastIndexOf('$$')))) {
                throw new Error(`$$ chunk carries trailing statements — isolate with statement-breakpoint: ${trimmed.split('\n')[0]}`)
            }
            if (trimmed) stmts.push(trimmed)
            continue
        }
        // Strip comment lines first: a ';' at the end of a '--' comment would
        // otherwise split mid-comment (0136's header does exactly this).
        const code = chunk.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
        for (const piece of code.split(/;\s*(?:\r?\n|$)/)) {
            const trimmed = piece.trim()
            if (!trimmed) continue
            if (trimmed.split('\n').every(l => l.trim() === '' || l.trim().startsWith('--'))) continue
            stmts.push(trimmed)
        }
    }
    return stmts
}

async function main(): Promise<void> {
    const dir = process.env.MIGRATIONS_DIR ?? './drizzle'
    const journal = JSON.parse(
        readFileSync(path.join(dir, 'meta', '_journal.json'), 'utf-8'),
    ) as { entries: Array<{ tag: string }> }
    const journaledTags = new Set(journal.entries.map(e => e.tag))

    const orphans = readdirSync(dir)
        .filter(f => f.endsWith('.sql'))
        .filter(f => !f.startsWith('DRAFT_'))
        .filter(f => !journaledTags.has(f.replace(/\.sql$/, '')))
        .sort()

    console.log(`[orphaned-sql] ${orphans.length} orphaned migration(s) in ${dir}: ${orphans.join(', ') || '(none)'}`)
    if (orphans.length === 0) return

    const dryRun = process.env.DRY_RUN === '1'
    if (dryRun) {
        for (const file of orphans) {
            const stmts = statementsOf(readFileSync(path.join(dir, file), 'utf-8'))
            console.log(`[orphaned-sql] DRY_RUN ${file}: ${stmts.length} statement(s)`)
            for (const s of stmts) console.log(`  - ${s.split('\n')[0]}`)
        }
        return
    }

    const connectionString = process.env.DATABASE_URL
    if (!connectionString) {
        console.error('[orphaned-sql] ERROR: DATABASE_URL is required')
        process.exit(1)
    }
    const sql = postgres(connectionString, { max: 1, onnotice: () => { } })

    for (const file of orphans) {
        const stmts = statementsOf(readFileSync(path.join(dir, file), 'utf-8'))
        let applied = 0
        let tolerated = 0
        for (const stmt of stmts) {
            try {
                await sql.unsafe(stmt)
                applied++
            } catch (err: any) {
                if (TOLERATED.has(err?.code)) {
                    tolerated++
                    console.warn(`[orphaned-sql] tolerated ${err.code} in ${file}: ${stmt.split('\n')[0]}`)
                    continue
                }
                console.error(`[orphaned-sql] FAILED (${err?.code ?? 'no code'}) in ${file}: ${stmt.split('\n')[0]}`)
                console.error(err?.message ?? err)
                await sql.end()
                process.exit(1)
            }
        }
        console.log(`[orphaned-sql] ${file}: applied ${applied} statement(s) (${tolerated} tolerated)`)
    }

    await sql.end()
    console.log('[orphaned-sql] complete')
}

main().catch((err) => {
    console.error('[orphaned-sql] FAILED:', err)
    process.exit(1)
})
