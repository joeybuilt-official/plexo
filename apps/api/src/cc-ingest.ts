// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Global error handlers — captures unhandled errors and relays them
 * to the Command Engine analytics ingest via the native relay.
 *
 * Uses ANALYTICS_RELAY_URL + X-Instance-Id + X-Service-Key headers
 * that the Command Engine ingest-auth middleware expects.
 */

import { logger } from './logger.js'

/**
 * Install global unhandled-rejection and uncaught-exception handlers.
 * Call once at process startup.
 */
export function installGlobalHandlers(): void {
    process.on('unhandledRejection', (reason) => {
        captureGlobalError(reason, 'unhandledRejection')
    })
    process.on('uncaughtException', (err) => {
        captureGlobalError(err, 'uncaughtException')
    })
}

function captureGlobalError(error: unknown, source: string): void {
    const err = error instanceof Error ? error : new Error(String(error))
    logger.error({ err, source }, 'Global error captured')

    // Relay via the analytics pipeline (fire-and-forget)
    void import('./analytics/config.js').then(({ getAnalyticsConfig }) => {
        const { instanceId } = getAnalyticsConfig()
        return import('./analytics/relay.js').then(({ relayError }) =>
            relayError({
                fingerprint: `${err.name}:${source}`,
                message: err.message,
                stack_trace: err.stack,
                context: {
                    source,
                    deploy_hash: process.env.APP_VERSION,
                },
            }, instanceId),
        )
    }).catch(() => { /* never throws */ })
}
