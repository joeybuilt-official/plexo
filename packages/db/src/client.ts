// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export type Database = ReturnType<typeof drizzle<typeof schema>>

/**
 * Slow-query threshold in milliseconds. Queries slower than this are logged
 * via console.warn at `warn` level with the truncated SQL and the caller
 * stack frame. Override with `DB_SLOW_QUERY_MS` env var (default 500 ms).
 *
 * Log format is single-line JSON so it's grep/jq-friendly and flows through
 * pino transports on the API side without modification.
 */
const SLOW_QUERY_MS = Number.parseInt(process.env.DB_SLOW_QUERY_MS ?? '500', 10)

/** Max characters of the SQL text included in the slow-query log. */
const SQL_LOG_MAX_LEN = 600

function emitSlowQuery(payload: Record<string, unknown>) {
    try {
        // eslint-disable-next-line no-console
        console.warn(JSON.stringify({ level: 'warn', ns: 'db.slow-query', ...payload }))
    } catch {
        // eslint-disable-next-line no-console
        console.warn('[db.slow-query]', payload)
    }
}

/** Best-effort caller frame outside of packages/db / drizzle / postgres-js. */
function findCallerFrame(): string | undefined {
    const err = new Error()
    const stack = err.stack?.split('\n') ?? []
    for (const line of stack) {
        if (!line.includes('at ')) continue
        if (line.includes('/packages/db/')) continue
        if (line.includes('drizzle-orm') || line.includes('postgres-js')) continue
        if (line.includes('node:internal') || line.includes('/node_modules/')) continue
        return line.trim()
    }
    return undefined
}

let _db: Database | null = null

/**
 * Lazy DB accessor. Creates the postgres-js pool + drizzle instance on first
 * property access so that scripts importing from @plexo/db without a
 * DATABASE_URL (e.g. type-only consumers, migration planners) don't crash at
 * import time.
 *
 * Slow-query logging is implemented via a Drizzle `logger` implementation
 * that queues each call on a monotonic timeline. Drizzle invokes `logQuery`
 * *before* execution, so duration is captured by wrapping the returned
 * drizzle instance and intercepting every query builder call-site. For the
 * postgres-js driver, drizzle's session batches the query through
 * `client.unsafe(sql, params)` — we monkey-patch `unsafe` on the client to
 * time each call and emit a warning if duration >= SLOW_QUERY_MS.
 */
function createClient(): Database {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL environment variable is required')

    const client = postgres(url, {
        max: 20,
        idle_timeout: 30,
        connect_timeout: 10,
        onnotice: () => { /* swallow NOTICE output */ },
    })

    // Monkey-patch `unsafe` — drizzle-orm/postgres-js routes every query
    // through this method. Signature: sql.unsafe(query, params, options).
    // It returns a PendingQuery which is thenable, so we can observe
    // completion by chaining off the returned promise.
    const originalUnsafe = client.unsafe.bind(client) as typeof client.unsafe
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(client as any).unsafe = function patchedUnsafe(
        query: string,
        params?: unknown[],
        options?: unknown,
    ) {
        const t0 = Date.now()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pending: any = originalUnsafe(query, params as any, options as any)
        // PendingQuery is thenable. Tag a then-handler without awaiting so we
        // don't change the return type the caller sees.
        if (pending && typeof pending.then === 'function') {
            pending.then(
                () => {
                    const dt = Date.now() - t0
                    if (dt >= SLOW_QUERY_MS) {
                        emitSlowQuery({
                            durationMs: dt,
                            threshold: SLOW_QUERY_MS,
                            sql: query.slice(0, SQL_LOG_MAX_LEN),
                            truncated: query.length > SQL_LOG_MAX_LEN,
                            paramCount: params?.length ?? 0,
                            caller: findCallerFrame(),
                        })
                    }
                },
                (err: unknown) => {
                    const dt = Date.now() - t0
                    if (dt >= SLOW_QUERY_MS) {
                        emitSlowQuery({
                            durationMs: dt,
                            threshold: SLOW_QUERY_MS,
                            sql: query.slice(0, SQL_LOG_MAX_LEN),
                            truncated: query.length > SQL_LOG_MAX_LEN,
                            paramCount: params?.length ?? 0,
                            caller: findCallerFrame(),
                            failed: true,
                            error: err instanceof Error ? err.message : String(err),
                        })
                    }
                    // Do NOT rethrow here — this is a side-channel observer.
                    // The original promise chain still propagates the error to
                    // the actual caller.
                },
            )
        }
        return pending
    }

    return drizzle(client, { schema })
}

/** Lazy DB accessor — throws at first use if DATABASE_URL is missing, not at import time */
export const db: Database = new Proxy({} as Database, {
    get(_target, prop) {
        if (!_db) {
            _db = createClient()
        }
        return ((_db as unknown) as Record<string | symbol, unknown>)[prop]
    },
})
