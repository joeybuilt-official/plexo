// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Better Auth route handler — mounts the auth API at /api/auth/*.
 *
 * The next.config.ts rewrite intentionally excludes /api/auth so these
 * requests stay in this Next.js app rather than being proxied to plexo-ops.
 */

import { toNextJsHandler } from 'better-auth/next-js'
import { getAuth } from '@web/lib/auth'

export const runtime = 'nodejs'

function wrap(method: 'GET' | 'POST') {
    return async (req: Request): Promise<Response> => {
        try {
            const auth = getAuth()
            const handlers = toNextJsHandler(auth.handler)
            const fn = handlers[method]
            return await fn(req)
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            const stack = err instanceof Error ? err.stack : undefined
            console.error(JSON.stringify({ level: 'error', ns: 'auth.route', method, url: req.url, msg, stack }))
            return new Response(JSON.stringify({ error: 'auth_handler_failure', message: msg }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            })
        }
    }
}

export const GET = wrap('GET')
export const POST = wrap('POST')
