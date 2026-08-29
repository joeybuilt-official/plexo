// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { sql, type SQL } from 'drizzle-orm'

/**
 * Bind a JS array as a Postgres array, for `= ANY(...)` and friends.
 *
 * Interpolating an array straight into a `sql` template does NOT produce an
 * array parameter. Drizzle expands it into a comma-separated list of
 * placeholders, so `ANY(${ids}::uuid[])` renders as:
 *
 *     ANY(($1, $2, $3)::uuid[])
 *
 * Postgres parses that as a ROW constructor and rejects it —
 * `cannot cast type record to uuid[]`. A single-element array is no better:
 * `($1)::uuid[]` fails with `malformed array literal`. Nothing about either
 * form is reachable by a type error, so the query only fails at runtime, and
 * three separate call sites shipped this way and swallowed the failure into a
 * `.catch()` for months.
 *
 * `sqlArray(ids, 'uuid')` renders `ARRAY[$1, $2, $3]::uuid[]`, which is what
 * was meant. An empty array renders `ARRAY[]::uuid[]` — it matches nothing
 * rather than raising a syntax error, so callers need no special case.
 *
 * This module sits at the top level of `packages/agent/src` deliberately: the
 * `agent-core-imports-orm` boundary scopes to the inner-ring subdirectories,
 * so ORM-aware helpers belong here beside `audit.repository.ts`, never inside
 * `memory/` or `executor/`.
 */
export function sqlArray(values: readonly (string | number)[], pgType: string): SQL {
    if (values.length === 0) return sql.raw(`ARRAY[]::${pgType}[]`)
    return sql`ARRAY[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::${sql.raw(pgType)}[]`
}
