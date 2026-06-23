// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * QA-opt ADR 0038: a bounded in-process ring of the most recent error/fatal
 * log records, exposed at GET /admin/recent-errors (super-admin) so the
 * operator has a queryable error surface. Previously errors only went to pino
 * stdout — no way to ask "what is erroring right now" without shell access to
 * the container logs, and there was no Sentry-equivalent sink.
 *
 * Deliberately in-memory + single-replica (matches the SSE-registry / SLO-buffer
 * reality): it answers "is it erroring now", not "historical error analytics".
 * Records reset on process restart. We capture ONLY redaction-safe scalar fields
 * pulled out of the log object — never the whole merge-object — so secrets that
 * pino's `redact` would strip from stdout cannot leak into this ring either.
 */

const MAX_ERRORS = 200

export interface ErrorRecord {
    ts: string
    level: 'error' | 'fatal'
    msg: string
    errName?: string
    errMessage?: string
    errCode?: string | number
    status?: number
    requestId?: string
    correlationId?: string
    workspaceId?: string
}

const ring: ErrorRecord[] = []

function str(v: unknown): string | undefined {
    return typeof v === 'string' && v.length > 0 ? v.slice(0, 500) : undefined
}

/**
 * Build a safe record from raw pino log args. pino call shapes:
 *   logger.error(mergeObj, msg)  → args = [obj, msg]
 *   logger.error(msg)            → args = [msg]
 * We never persist `obj` itself — only a hand-picked allowlist of scalar fields.
 */
export function recordErrorFromArgs(args: unknown[], levelNum: number): void {
    const obj = (args.length > 0 && typeof args[0] === 'object' && args[0] !== null)
        ? args[0] as Record<string, unknown>
        : undefined
    const msg = str(args.find(a => typeof a === 'string')) ?? '(no message)'
    const err = (obj?.err && typeof obj.err === 'object') ? obj.err as Record<string, unknown> : undefined

    const rec: ErrorRecord = {
        ts: new Date().toISOString(),
        level: levelNum >= 60 ? 'fatal' : 'error',
        msg,
        errName: str(err?.name),
        errMessage: str(err?.message),
        errCode: (typeof err?.code === 'string' || typeof err?.code === 'number') ? err.code : undefined,
        status: typeof obj?.status === 'number' ? obj.status : undefined,
        requestId: str(obj?.requestId),
        correlationId: str(obj?.correlationId),
        workspaceId: str(obj?.workspaceId),
    }
    ring.push(rec)
    if (ring.length > MAX_ERRORS) ring.splice(0, ring.length - MAX_ERRORS)
}

export function getRecentErrors(limit = MAX_ERRORS): ErrorRecord[] {
    const n = Math.max(1, Math.min(limit, MAX_ERRORS))
    return ring.slice(-n).reverse()
}

export function getErrorRingSize(): number {
    return ring.length
}
