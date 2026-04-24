// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Request, Response, NextFunction } from 'express'
import { SessionLogger } from '@plexo/logger'

export function sessionLogMiddleware(req: Request, res: Response, next: NextFunction) {
    const start = Date.now()
    const sessionId = (req.headers['x-session-id'] as string) || (req.cookies?.['plexo-session'] as string) || undefined
    const personaId = req.headers['x-persona-id'] as string || undefined

    const logger = new SessionLogger({ sessionId, personaId })

    res.on('finish', () => {
        const durationMs = Date.now() - start
        
        // Skip obvious highly-noisy or health endpoints
        if (req.path === '/health' || req.path === '/api/v1/sse' || req.path === '/api/v1/agent/status') return

        const errorMessage = res.statusCode >= 400 ? res.statusMessage || `HTTP ${res.statusCode}` : undefined

        void logger.log({
            eventType: 'page_view', // Can be refined if specific routes mean specific events
            route: req.path,
            action: `${req.method} ${req.path}`,
            durationMs,
            responseCode: res.statusCode,
            errorMessage,
        })
    })

    next()
}
