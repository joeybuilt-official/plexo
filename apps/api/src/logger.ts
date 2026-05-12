// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import pino from 'pino'
import { asyncLocalStorage } from './middleware/trace.js'

export const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: 'plexo-api' },
    ...(process.env.NODE_ENV === 'production'
        ? {}
        : { transport: { target: 'pino-pretty' } }
    ),
    redact: {
        paths: [
            'req.headers.authorization',
            '*.token',
            '*.password',
            '*.secret',
            '*.apiKey',
            '*.accessToken',
            '*.refreshToken',
        ],
    },
})

/**
 * OPS-001: Returns a child logger enriched with per-request context
 * from AsyncLocalStorage (requestId, correlationId) plus optional
 * userId and workspaceId bindings.
 */
export function getRequestLogger(extra?: { userId?: string; workspaceId?: string }): pino.Logger {
    return getChildLogger(extra)
}

export function getChildLogger(extra?: { userId?: string; workspaceId?: string }): pino.Logger {
    const trace = asyncLocalStorage.getStore()
    const bindings: Record<string, string> = {}
    if (trace?.requestId) bindings.requestId = trace.requestId
    if (trace?.correlationId) bindings.correlationId = trace.correlationId
    if (extra?.userId) bindings.userId = extra.userId
    if (extra?.workspaceId) bindings.workspaceId = extra.workspaceId
    return Object.keys(bindings).length > 0 ? logger.child(bindings) : logger
}
