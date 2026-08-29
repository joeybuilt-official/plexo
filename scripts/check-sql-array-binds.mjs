#!/usr/bin/env node
/**
 * Fails on `${someArray}::type[]` inside a Drizzle `sql` template.
 *
 * Drizzle expands an interpolated JS array into a comma-separated list of
 * placeholders, not an array parameter, so `ANY(${ids}::uuid[])` renders as
 * `ANY(($1, $2, $3)::uuid[])` — a ROW constructor, which Postgres rejects with
 * `cannot cast type record to uuid[]`. A one-element array fails too, with
 * `malformed array literal`.
 *
 * Nothing about it is a type error, so it only fails at runtime. Three call
 * sites shipped this way and each swallowed the failure into a `.catch()`:
 * memory consolidation and tier promotion never ran at all, and rule
 * quarantine reported a count of rules it had not quarantined. Use
 * `sqlArray(values, 'uuid')` from `packages/agent/src/sql-array.ts`, which
 * renders `ARRAY[$1, $2, $3]::uuid[]`.
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

// A bare identifier or property path interpolated directly into an array cast.
// A call expression — `${sqlArray(ids, 'uuid')}` — is the correct form and has
// parentheses, so it does not match.
const BAD = /\$\{\s*[A-Za-z_$][A-Za-z0-9_$.]*\s*\}\s*::\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\[\]/

const files = execFileSync('git', ['ls-files', '*.ts', '*.mts', '*.cts'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)

// Comment lines are skipped so the rule can be documented — including in this
// file and in the tests that pin the behaviour — without tripping itself.
const COMMENT = /^\s*(\/\/|\/\*|\*)/

const findings = []
for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
        if (COMMENT.test(line)) return
        if (BAD.test(line)) findings.push(`${file}:${i + 1}: ${line.trim()}`)
    })
}

if (findings.length > 0) {
    console.error('Array interpolated into a SQL array cast — this renders a ROW constructor and fails at runtime.')
    console.error('Use sqlArray(values, type) from packages/agent/src/sql-array.ts instead.\n')
    for (const f of findings) console.error(`  ${f}`)
    process.exit(1)
}

console.log(`✔ no array-into-cast SQL binds (${files.length} files scanned)`)
