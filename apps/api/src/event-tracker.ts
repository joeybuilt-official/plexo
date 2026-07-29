// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Event tracker — native analytics relay.
 *
 * trackError() relays errors to Command Engine.
 * trackEvent() logs lifecycle events for observability.
 */

import { logger } from './logger.js'
import { isErrorsEnabled, getAnalyticsConfig } from './analytics/config.js'
import { relayError } from './analytics/relay.js'

const IGNORE_ERRORS = [
    'Sprint cancelled by user',
    'AbortError',
]

export function trackError(err: unknown, context?: Record<string, unknown>): void {
    const message = err instanceof Error ? err.message : String(err)
    if (IGNORE_ERRORS.some((pat) => message.includes(pat))) return

    logger.error({ err, context }, 'trackError')

    if (isErrorsEnabled()) {
        const { instanceId } = getAnalyticsConfig()
        void relayError({
            fingerprint: `${err instanceof Error ? err.constructor.name : 'Error'}:${message.slice(0, 80)}`,
            message,
            stack_trace: err instanceof Error ? err.stack : undefined,
            context: context ?? {},
        }, instanceId)
    }
}

export function trackEvent(
    eventName: string,
    level: 'info' | 'warning' | 'error',
    context?: Record<string, unknown>,
): void {
    const log = level === 'error' ? logger.error : level === 'warning' ? logger.warn : logger.info
    log.call(logger, { event: eventName, ...context }, eventName)
}
