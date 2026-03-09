// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * sentry.ts — Dual Sentry client: central Plexo project + optional operator project.
 *
 * Two independent Sentry clients:
 *
 * 1. CENTRAL (sentry.getplexo.com) — receives errors from all opted-in instances.
 *    Gated by the privacy toggle (Settings → Privacy → "Anonymous crash reports").
 *    DSN is baked in — no operator config required, mirrors how PostHog works.
 *
 * 2. OPERATOR (SENTRY_DSN env var) — the operator's own Sentry project.
 *    Always active when SENTRY_DSN is set, regardless of the privacy toggle.
 *    Self-hosted operators use this to track errors on their own instance.
 *
 * captureException() sends to whichever clients are initialized.
 * Never throws. Never blocks the process.
 */
import { NodeClient, defaultStackParser, getDefaultIntegrations, makeNodeTransport } from '@sentry/node'
import type { EventHint } from '@sentry/node'
import { logger } from './logger.js'
import { getTelemetryConfig } from './telemetry/posthog.js'

// Plexo's central Sentry project — receives errors from opted-in instances.
// Sentry DSNs are designed to be public (client-side in browsers always).
// This allows submission only — no read access to the project.
const PLEXO_CENTRAL_DSN = 'https://6d0a6e3fc7520f34ea7a26647013f2b6@sentry.getplexo.com/2'

const IGNORE_ERRORS = [
    'Sprint cancelled by user',
    'AbortError',
]

function makeClient(dsn: string): NodeClient {
    return new NodeClient({
        dsn,
        environment: process.env.NODE_ENV ?? 'production',
        release: process.env.npm_package_version,
        tracesSampleRate: 0,
        stackParser: defaultStackParser,
        transport: makeNodeTransport,
        integrations: getDefaultIntegrations({}).filter(
            (i) => !['OnUncaughtException', 'OnUnhandledRejection'].includes(i.name),
            // We handle these ourselves in index.ts for clean shutdown
        ),
    })
}

let centralClient: NodeClient | null = null
let operatorClient: NodeClient | null = null

export function initSentry(): void {
    // Central client — for all opted-in instances
    try {
        centralClient = makeClient(PLEXO_CENTRAL_DSN)
        logger.info('Sentry: central client initialized (sentry.getplexo.com)')
    } catch (err) {
        logger.warn({ err }, 'Sentry: central client failed to initialize')
    }

    // Operator client — for the instance operator's own Sentry
    const operatorDsn = process.env.SENTRY_DSN
    if (operatorDsn && operatorDsn !== PLEXO_CENTRAL_DSN) {
        try {
            operatorClient = makeClient(operatorDsn)
            logger.info('Sentry: operator client initialized (SENTRY_DSN)')
        } catch (err) {
            logger.warn({ err }, 'Sentry: operator client failed to initialize')
        }
    }
}

/**
 * Capture an exception.
 *
 * - Central client: only fires when telemetry is enabled (privacy toggle)
 * - Operator client: always fires when initialized (operator's own project)
 *
 * Always non-fatal — never throws.
 */
export function captureException(err: unknown, context?: Record<string, unknown>): void {
    const message = err instanceof Error ? err.message : String(err)

    // Ignore known non-actionable errors in both clients
    if (IGNORE_ERRORS.some((pat) => message.includes(pat))) return

    const hint: EventHint | undefined = context ? { data: context } : undefined

    // Central: gated by privacy toggle
    if (centralClient && getTelemetryConfig().enabled) {
        try {
            centralClient.captureException(err, hint)
        } catch { /* never crash */ }
    }

    // Operator: always active
    if (operatorClient) {
        try {
            operatorClient.captureException(err, hint)
        } catch { /* never crash */ }
    }
}
