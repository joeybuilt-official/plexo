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
//
// ── Column-level drift (added after the A6 money-column incident) ───────────
//
// The table-only check above missed a whole class of the same bug: schema.ts
// declared nine `*_numeric` money columns whose only DDL lived in
// drizzle/DRAFT_money_numeric.sql — a draft that is never applied. The tables
// all existed, so the gate passed, while every INSERT into tasks / sprints /
// work_ledger / api_cost_tracking failed on a fresh database (Drizzle names
// every schema column in an INSERT).
//
// So the signal is now per column as well: every column declared inside a
// `pgTable(…)` block in schema.ts must appear somewhere in the APPLIED DDL —
// a CREATE TABLE body, an `ADD COLUMN`, or a `RENAME COLUMN … TO`.
//
// Two deliberate scoping decisions, both of which the money bug turns on:
//   1. DRAFT_*.sql is EXCLUDED. Those files are drafts pending operator
//      sign-off and scripts/apply-orphaned-sql.ts skips them, so DDL that
//      only exists in a draft is exactly the drift we are hunting. (The table
//      check now reads the same filtered set; no table depends on a draft.)
//   2. COLUMN_CHECK_EXEMPT_TABLES below carries the known-good exceptions.
//
// Type, nullability, and default drift are still NOT detected — same caveat as
// the table check. Presence only.

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const DRIZZLE_DIR = path.resolve(import.meta.dirname, '..', 'drizzle')
const SCHEMA_PATH = path.resolve(import.meta.dirname, '..', 'src', 'schema.ts')

// Tables whose columns are NOT owned by this repo's migrations.
//
// `users` is a postgres_fdw FOREIGN TABLE onto Better Auth's auth."user" on the
// joeybuilt deployment (see 0126_self_host_users_casing.sql). Better Auth owns
// that shape upstream, so its admin-plugin columns ("banned", "banReason",
// "banExpires") have no local DDL by design. This is the same false-positive
// class the table check's header already calls out.
const COLUMN_CHECK_EXEMPT_TABLES = new Set(['users'])

// Drizzle column builders used in schema.ts; the first string argument is the
// SQL column name.
const COLUMN_BUILDERS = [
    'text', 'varchar', 'char', 'uuid', 'integer', 'bigint', 'smallint', 'serial',
    'boolean', 'timestamp', 'date', 'time', 'interval', 'jsonb', 'json',
    'numeric', 'decimal', 'real', 'doublePrecision', 'vector', 'bytea', 'inet',
]

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
    // DRAFT_*.sql is excluded: apply-orphaned-sql.ts skips it, so it is not
    // applied DDL. Counting it would hide exactly the drift this gate hunts.
    const files = readdirSync(DRIZZLE_DIR)
        .filter((f) => f.endsWith('.sql'))
        .filter((f) => !f.startsWith('DRAFT_'))
        .sort()
    let all = ''
    for (const f of files) {
        all += '\n' + readFileSync(path.join(DRIZZLE_DIR, f), 'utf-8')
    }
    return all
}

/**
 * Strip SQL comments so a trailing `-- note` never glues itself to the next
 * column definition. Quote- and dollar-quote-aware so a `--` inside a string
 * literal or a DO $$ … $$ body is left alone.
 */
function stripSqlComments(sql: string): string {
    let out = ''
    for (let i = 0; i < sql.length;) {
        const two = sql.slice(i, i + 2)
        if (two === '--') {
            const nl = sql.indexOf('\n', i)
            if (nl === -1) break
            i = nl // keep the newline as a separator
            continue
        }
        if (two === '/*') {
            const end = sql.indexOf('*/', i + 2)
            if (end === -1) break
            out += ' '
            i = end + 2
            continue
        }
        if (sql[i] === "'") {
            const end = sql.indexOf("'", i + 1)
            if (end === -1) break
            out += sql.slice(i, end + 1)
            i = end + 1
            continue
        }
        if (two === '$$') {
            const end = sql.indexOf('$$', i + 2)
            if (end === -1) break
            out += sql.slice(i, end + 2)
            i = end + 2
            continue
        }
        out += sql[i]
        i++
    }
    return out
}

/** Columns declared per table inside each `pgTable('<name>', { … })` block. */
function loadSchemaColumns(): Map<string, Set<string>> {
    const src = readFileSync(SCHEMA_PATH, 'utf-8')
    const blockRe = /pgTable\(\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]\s*,/g
    const starts: Array<{ table: string; at: number }> = []
    let m: RegExpExecArray | null
    while ((m = blockRe.exec(src)) !== null) starts.push({ table: m[1]!, at: m.index })

    const colRe = new RegExp(
        String.raw`\b(?:${COLUMN_BUILDERS.join('|')})\(\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]`,
        'g',
    )
    const byTable = new Map<string, Set<string>>()
    for (let i = 0; i < starts.length; i++) {
        const end = i + 1 < starts.length ? starts[i + 1]!.at : src.length
        const body = src.slice(starts[i]!.at, end)
        if (!byTable.has(starts[i]!.table)) byTable.set(starts[i]!.table, new Set())
        const cols = byTable.get(starts[i]!.table)!
        let c: RegExpExecArray | null
        colRe.lastIndex = 0
        while ((c = colRe.exec(body)) !== null) cols.add(c[1]!)
    }
    return byTable
}

/** Columns each table gains anywhere in the applied DDL. */
function findDdlColumns(allSql: string): Map<string, Set<string>> {
    const sql = stripSqlComments(allSql)
    const byTable = new Map<string, Set<string>>()
    const add = (table: string, column: string): void => {
        if (!byTable.has(table)) byTable.set(table, new Set())
        byTable.get(table)!.add(column)
    }

    // CREATE TABLE … ( <column defs> ) — balanced-paren scan, then split the
    // body on top-level commas.
    const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?[a-zA-Z_][a-zA-Z0-9_]*"?\s*\.\s*)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(/gi
    let m: RegExpExecArray | null
    while ((m = createRe.exec(sql)) !== null) {
        let depth = 1
        let i = createRe.lastIndex
        while (i < sql.length && depth > 0) {
            if (sql[i] === '(') depth++
            else if (sql[i] === ')') depth--
            i++
        }
        const body = sql.slice(createRe.lastIndex, i - 1)
        let d = 0
        let cur = ''
        const parts: string[] = []
        for (const ch of body) {
            if (ch === '(') d++
            if (ch === ')') d--
            if (ch === ',' && d === 0) { parts.push(cur); cur = '' } else cur += ch
        }
        parts.push(cur)
        for (const part of parts) {
            const name = part.trim().match(/^"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+/)
            if (!name) continue
            // table-level constraint clauses, not columns
            if (/^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|EXCLUDE|LIKE)$/i.test(name[1]!)) continue
            add(m[1]!, name[1]!)
        }
    }

    // ALTER TABLE <t> … ; — one statement may carry several ADD COLUMN /
    // RENAME COLUMN clauses (0102 and 0036 both do), so scan the whole thing.
    const alterRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:"?[a-zA-Z_][a-zA-Z0-9_]*"?\s*\.\s*)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?([\s\S]*?);/gi
    while ((m = alterRe.exec(sql)) !== null) {
        const table = m[1]!
        const clauses = m[2]!
        const addColRe = /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi
        let c: RegExpExecArray | null
        while ((c = addColRe.exec(clauses)) !== null) add(table, c[1]!)
        const renColRe = /RENAME\s+COLUMN\s+"?[a-zA-Z_][a-zA-Z0-9_]*"?\s+TO\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi
        while ((c = renColRe.exec(clauses)) !== null) add(table, c[1]!)
    }

    // A renamed table keeps its columns under the new name.
    const renameRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"?[a-zA-Z_][a-zA-Z0-9_]*"?\s*\.\s*)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+RENAME\s+TO\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi
    while ((m = renameRe.exec(sql)) !== null) {
        const from = byTable.get(m[1]!)
        if (from) for (const col of from) add(m[2]!, col)
    }

    return byTable
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

    // Column-level pass. Drizzle names every schema column in an INSERT, so a
    // column with no DDL breaks every write to its table on a fresh database.
    const schemaColumns = loadSchemaColumns()
    const ddlColumns = findDdlColumns(allSql)

    const missingColumns: Array<{ table: string; column: string }> = []
    let checkedColumns = 0
    for (const [table, columns] of schemaColumns) {
        if (COLUMN_CHECK_EXEMPT_TABLES.has(table)) continue
        const have = ddlColumns.get(table) ?? new Set<string>()
        for (const column of columns) {
            checkedColumns++
            if (!have.has(column)) missingColumns.push({ table, column })
        }
    }

    if (missingColumns.length > 0) {
        console.error('[check-drift] Schema-vs-DDL COLUMN drift detected:')
        for (const { table, column } of missingColumns) {
            console.error(`  - schema.ts declares ${table}.${column} but no CREATE TABLE body / ADD COLUMN / RENAME COLUMN in drizzle/*.sql (DRAFT_*.sql does not count — it is never applied)`)
        }
        console.error(`\n[check-drift] ${missingColumns.length} column(s) need a migration. Every write to the affected table fails on a database built from this repo.`)
        process.exit(1)
    }

    console.log(`[check-drift] OK: ${schemaTables.length} pgTable declarations in schema.ts — every one is backed by a CREATE TABLE or RENAME TO in drizzle/*.sql.`)
    console.log(`[check-drift] OK: ${checkedColumns} column declarations across ${schemaColumns.size - COLUMN_CHECK_EXEMPT_TABLES.size} table(s) — every one is backed by a CREATE TABLE body, ADD COLUMN, or RENAME COLUMN.`)
}

main()
