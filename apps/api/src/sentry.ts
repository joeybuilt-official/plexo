// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * sentry.ts — Sentry initializer and thin capture wrapper.
 *
 * Import this module ONCE at the top of index.ts before any other app code.
 * All other modules import captureException() from here rather than @sentry/node
 * directly, so Sentry stays opt-in (no-ops when SENTRY_DSN is unset).
 *
 * Sentry respects the same privacy toggle as PostHog crash reporting.
 * If the operator has disabled anonymous crash reporting via Settings → Privacy,
 * captureException() is a no-op — no data leaves the instance.
 */
import * as SentrySDK from '@sentry/node'
import { logger } from './logger.js'
import { getTelemetryConfig } from './telemetry/posthog.js'

let initialized = false

export function initSentry(): void {
    const dsn = process.env.SENTRY_DSN
    if (!dsn) {
        logger.info('Sentry: SENTRY_DSN not set — error reporting disabled')
        return
    }

    SentrySDK.init({
        dsn,
        environment: process.env.NODE_ENV ?? 'production',
        release: process.env.npm_package_version,
        tracesSampleRate: 0,         // no performance tracing — errors only
        // Avoid capturing noisy/expected errors
        ignoreErrors: [
            'Sprint cancelled by user',
        ],
    })
    initialized = true
    logger.info('Sentry: initialized')
}

/**
 * Capture an exception to Sentry. No-op if:
 *   - Sentry was not initialized (no SENTRY_DSN)
 *   - The operator has disabled crash reporting via Settings → Privacy
 * Always non-fatal — never throws.
 */
export function captureException(err: unknown, context?: Record<string, unknown>): void {
    if (!initialized) return
    // Respect the privacy toggle — same gate as PostHog captureError()
    if (!getTelemetryConfig().enabled) return
    try {
        SentrySDK.captureException(err, context ? { extra: context } : undefined)
    } catch {
        // Never let Sentry itself crash the process
    }
}
