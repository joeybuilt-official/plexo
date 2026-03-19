// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { SessionLogger } from '@plexo/logger'

export interface SimulationSession {
    logEvent: (eventType: string, details?: Record<string, unknown>) => Promise<void>
    fail: (action: string, errorMessage: string) => Promise<void>
    complete: (action: string, durationMs?: number) => Promise<void>
}

export function createSimulationSession(personaId: string, sessionId?: string): SimulationSession {
    const logger = new SessionLogger({ personaId, sessionId })
    const startTime = Date.now()

    return {
        logEvent: async (eventType, details = {}) => {
            const { action, durationMs, errorMessage, route, payload, ...rest } = details
            await logger.log({
                eventType,
                action: action as string | undefined,
                durationMs: durationMs as number | undefined,
                errorMessage: errorMessage as string | undefined,
                route: route as string | undefined,
                payload: payload ?? (Object.keys(rest).length > 0 ? rest : undefined)
            })
        },

        fail: async (action, errorMessage) => {
            await logger.log({
                eventType: 'simulation_run_failed',
                action,
                errorMessage,
                durationMs: Date.now() - startTime
            })
        },

        complete: async (action, durationMs) => {
            await logger.log({
                eventType: 'simulation_run_completed',
                action,
                durationMs: durationMs ?? (Date.now() - startTime),
            })
        }
    }
}
