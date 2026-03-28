// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { db, sessionLogs } from '@plexo/db'
import * as Sentry from '@sentry/core'

type InsertSessionLog = typeof sessionLogs.$inferInsert

export class SessionLogger {
    private sessionId: string
    private personaId?: string

    constructor(opts: { sessionId?: string; personaId?: string }) {
        this.sessionId = opts.sessionId ?? crypto.randomUUID()
        this.personaId = opts.personaId
    }

    async log(eventOpts: Omit<InsertSessionLog, 'id' | 'sessionId' | 'personaId' | 'createdAt'>): Promise<void> {
        const { eventType, route, action, durationMs, errorMessage, outputType, llmModel, userId } = eventOpts
        
        try {
            await db.insert(sessionLogs).values({
                ...eventOpts,
                sessionId: this.sessionId,
                personaId: this.personaId,
            })
        } catch (e) {
            console.error('Failed to write session log to DB', e)
        }

        // PostHog telemetry via keyless relay — fire-and-forget
        try {
            const TELEMETRY_INGEST = `${process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://posthog.getplexo.com'}/ingest`
            fetch(TELEMETRY_INGEST, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    event: `plexo_session_${eventType}`,
                    distinct_id: userId ?? this.sessionId,
                    properties: {
                        persona_id: this.personaId,
                        route,
                        action,
                        duration_ms: durationMs,
                        error_message: errorMessage,
                        output_type: outputType,
                        llm_model: llmModel,
                        $lib: 'plexo-logger',
                    },
                    timestamp: new Date().toISOString()
                }),
                // non blocking
                signal: AbortSignal.timeout(5000),
            }).catch(() => { /* telemetry is best-effort, never block on failure */ })
        } catch {
            // telemetry is best-effort — swallow network/serialization errors
        }

        try {
            Sentry.addBreadcrumb({
                category: 'session',
                message: `${eventType} — ${action}`,
                level: errorMessage ? 'error' : 'info',
                data: {
                    personaId: this.personaId,
                    route,
                    durationMs,
                    outputType,
                },
            })

            // Capture Sentry exceptions on specified events
            const captureEvents = ['agent_task_failed', 'file_output_failed', 'plugin_failed', 'error_boundary_hit']
            if (captureEvents.includes(eventType) && errorMessage) {
                Sentry.captureException(new Error(errorMessage), {
                    tags: { simulation: 'true', eventType },
                    extra: { ...eventOpts, personaId: this.personaId, sessionId: this.sessionId }
                })
            }
        } catch {
            // Sentry SDK may not be initialized in all environments
        }
    }
}
