// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase J0 — schema-vs-DDL drift gate.
//
// The Phase A audit found a class of bugs where a table was declared in
// schema.ts but never made it into a migration (or vice versa), causing 500s
// at runtime when Drizzle tried to project a column that didn't exist.
//
// Why not `drizzle-kit generate --dry-run`? drizzle-kit ^0.30 has no dry-run
// flag, and `generate` is interactive (prompts on every potential rename).
// Snapshot history in this repo is sparse (Phase A pruned mid-history
// snapshots; many migrations were authored manually outside drizzle-kit), so
// a naive generate would produce hundreds of false-positive diffs.
//
// The PRAGMATIC drift signal Phase J locks: every `pgTable('<n>'` declared
// in schema.ts must appear somewhere in `packages/db/drizzle/*.sql` — either
// as `CREATE TABLE … <n>` or as a target of `ALTER TABLE … RENAME TO <n>`.
// This catches the actual P0 failure mode without false positives from the
// foreign-table column-name mismatches (users / auth.user FDW) or sparse
// snapshots.
//
// Phase J added text→uuid drift fixes inline; type drift is NOT detected by
// this gate. The next time drizzle-kit's snapshot history is rebuilt cleanly
// (a separate, larger task), this gate can be expanded to include type
// checks via the snapshot json.

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const DRIZZLE_DIR = path.resolve(import.meta.dirname, '..', 'drizzle')
const SCHEMA_PATH = path.resolve(import.meta.dirname, '..', 'src', 'schema.ts')

function loadSchemaTables(): string[] {
    const src = readFileSync(SCHEMA_PATH, 'utf-8')
    const tables: string[] = []
    const re = /pgTable\(\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]\s*,/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
        tables.push(m[1]!)
    }
    return [...new Set(tables)]
}

function loadMigrationsAllSql(): string {
    const files = readdirSync(DRIZZLE_DIR).filter((f) => f.endsWith('.sql')).sort()
    let all = ''
    for (const f of files) {
        all += '\n' + readFileSync(path.join(DRIZZLE_DIR, f), 'utf-8')
    }
    return all
}

function findCreatedOrRenamedTables(allSql: string): Set<string> {
    const tables = new Set<string>()
    // CREATE TABLE [IF NOT EXISTS] [schema.]"<name>"|<name>
    const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?[a-zA-Z_][a-zA-Z0-9_]*"?\s*\.\s*)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi
    let m: RegExpExecArray | null
    while ((m = createRe.exec(allSql)) !== null) {
        tables.add(m[1]!)
    }
    // ALTER TABLE … RENAME TO <name>
    const renameRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"?[a-zA-Z_][a-zA-Z0-9_]*"?\s*\.\s*)?"?[a-zA-Z_][a-zA-Z0-9_]*"?\s+RENAME\s+TO\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi
    while ((m = renameRe.exec(allSql)) !== null) {
        tables.add(m[1]!)
    }
    return tables
}

function main(): void {
    const schemaTables = loadSchemaTables()
    const allSql = loadMigrationsAllSql()
    const ddlTables = findCreatedOrRenamedTables(allSql)

    const missing: string[] = []
    for (const t of schemaTables) {
        if (!ddlTables.has(t)) missing.push(t)
    }

    if (missing.length > 0) {
        console.error('[check-drift] Schema-vs-DDL drift detected:')
        for (const t of missing) {
            console.error(`  - schema.ts declares pgTable('${t}', …) but no CREATE TABLE / RENAME TO in drizzle/*.sql`)
        }
        console.error(`\n[check-drift] ${missing.length} table(s) need a migration. Run drizzle-kit generate or hand-author a CREATE TABLE migration in packages/db/drizzle/.`)
        process.exit(1)
    }

    console.log(`[check-drift] OK: ${schemaTables.length} pgTable declarations in schema.ts — every one is backed by a CREATE TABLE or RENAME TO in drizzle/*.sql.`)
}

main()
