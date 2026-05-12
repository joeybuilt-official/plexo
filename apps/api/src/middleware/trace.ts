// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { ulid } from 'ulid'
import type { Request, Response, NextFunction } from 'express'
import { AsyncLocalStorage } from 'node:async_hooks'

interface TraceContext {
    requestId: string
    correlationId: string
}

export const asyncLocalStorage = new AsyncLocalStorage<TraceContext>()

export function traceMiddleware(req: Request, res: Response, next: NextFunction): void {
    const requestId = ulid()
    const correlationId = (req.headers['x-correlation-id'] as string) ?? requestId

    res.setHeader('x-request-id', requestId)
    res.locals.requestId = requestId

    asyncLocalStorage.run({ requestId, correlationId }, () => {
        next()
    })
}

export function getTraceContext(): TraceContext | undefined {
    return asyncLocalStorage.getStore()
}
