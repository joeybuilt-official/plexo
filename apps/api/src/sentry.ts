// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * sentry.ts — Dual Sentry client: central Plexo project + optional operator project.
 *
 * Two independent Sentry clients:
 *
 * 1. CENTRAL (sentry.getplexo.com) — receives errors from all opted-in instances.
 *    Gated by isErrorsEnabled() at SEND TIME (not init time) so runtime consent
 *    changes take effect immediately.
 *    DSN is baked in — no operator config required, mirrors how PostHog works.
 *
 * 2. OPERATOR (SENTRY_DSN env var) — the operator's own Sentry project.
 *    Always active when SENTRY_DSN is set, regardless of the privacy toggle.
 *    Self-hosted operators use this to track errors on their own instance.
 *
 * captureException() sends to whichever clients are initialized.
 * Never throws. Never blocks the process.
 *
 * Hardening:
 *   - Central client gated by isErrorsEnabled() checked at send time
 *   - beforeSend strips all fields not on the safe context allowlist
 *   - SDK transport timeout: 2000ms
 */
import { NodeClient, defaultStackParser, getDefaultIntegrations, makeNodeTransport } from '@sentry/node'
import type { ErrorEvent, Event, EventHint } from '@sentry/node'
import { logger } from './logger.js'
import { isErrorsEnabled, getTelemetryConfig } from './telemetry/posthog.js'

// Plexo's central Sentry project — receives errors from opted-in instances.
// Sentry DSNs are designed to be public (client-side in browsers always).
// This allows submission only — no read access to the project.
const PLEXO_CENTRAL_DSN = 'https://6d0a6e3fc7520f34ea7a26647013f2b6@sentry.getplexo.com/2'

const IGNORE_ERRORS = [
    'Sprint cancelled by user',
    'AbortError',
]

// ── Safe context allowlist ──────────────────────────────────────────────────────
// Only these keys survive the beforeSend filter for the central client.
// Anything not on this list is stripped before the event leaves the instance.
const ALLOWED_TAG_KEYS = new Set([
    'pipeline_step',
    'task_category',
    'plexo_version',
    'node_version',
    'telemetry_instance_id',
])

/**
 * Sanitize a Sentry event to the safe context allowlist.
 * Strips: user data, request URLs, query params, headers, cookies, breadcrumb data.
 * Keeps: error type, sanitized stack frames, allowed tags.
 */
function sanitizeEvent(event: ErrorEvent): ErrorEvent {
    // Strip user data entirely
    delete event.user
    // Strip request data (URLs, query params, headers, cookies)
    delete event.request
    // Strip breadcrumbs — they can contain user data, URLs, etc.
    delete event.breadcrumbs
    // Strip server name / hostname
    delete event.server_name

    // Sanitize tags to allowlist only
    if (event.tags) {
        const clean: Record<string, string> = {}
        for (const [key, val] of Object.entries(event.tags)) {
            if (ALLOWED_TAG_KEYS.has(key)) {
                clean[key] = String(val)
            }
        }
        event.tags = clean
    }

    // Sanitize extra/contexts to allowlist only
    if (event.extra) {
        const clean: Record<string, unknown> = {}
        for (const key of Object.keys(event.extra)) {
            if (ALLOWED_TAG_KEYS.has(key)) {
                clean[key] = event.extra[key]
            }
        }
        event.extra = clean
    }

    if (event.contexts) {
        // Keep only 'os' and 'runtime' contexts (no user/device/browser)
        const allowed = ['os', 'runtime']
        const clean: Record<string, Record<string, unknown>> = {}
        for (const key of Object.keys(event.contexts)) {
            if (allowed.includes(key) && event.contexts[key]) {
                clean[key] = event.contexts[key] as Record<string, unknown>
            }
        }
        event.contexts = clean
    }

    // Sanitize stack frames — keep function name + filename only, strip abs paths
    if (event.exception?.values) {
        for (const ex of event.exception.values) {
            if (ex.stacktrace?.frames) {
                ex.stacktrace.frames = ex.stacktrace.frames.map((frame) => ({
                    function: frame.function,
                    filename: frame.filename?.replace(/^.*node_modules/, 'node_modules'),
                    lineno: frame.lineno,
                    in_app: frame.in_app,
                }))
            }
        }
    }

    return event
}

function makeCentralClient(dsn: string): NodeClient {
    return new NodeClient({
        dsn,
        environment: process.env.NODE_ENV ?? 'production',
        release: process.env.npm_package_version,
        tracesSampleRate: 0,
        stackParser: defaultStackParser,
        transport: makeNodeTransport,
        transportOptions: { timeout: 2000 } as Record<string, unknown>,
        integrations: getDefaultIntegrations({}).filter(
            (i) => !['OnUncaughtException', 'OnUnhandledRejection'].includes(i.name),
        ),
        beforeSend(event: ErrorEvent, _hint: EventHint): ErrorEvent | null {
            // Runtime consent check — flag can change at any time
            if (!isErrorsEnabled()) return null
            return sanitizeEvent(event)
        },
        beforeSendTransaction(): null {
            // Never send transactions from the central client
            return null
        },
    })
}

function makeOperatorClient(dsn: string): NodeClient {
    return new NodeClient({
        dsn,
        environment: process.env.NODE_ENV ?? 'production',
        release: process.env.npm_package_version,
        tracesSampleRate: 0,
        stackParser: defaultStackParser,
        transport: makeNodeTransport,
        integrations: getDefaultIntegrations({}).filter(
            (i) => !['OnUncaughtException', 'OnUnhandledRejection'].includes(i.name),
        ),
    })
}

let centralClient: NodeClient | null = null
let operatorClient: NodeClient | null = null

export function initSentry(): void {
    // Central client — for all opted-in instances
    // Consent is checked at send time via beforeSend, not here
    try {
        centralClient = makeCentralClient(PLEXO_CENTRAL_DSN)
        logger.info('Sentry: central client initialized (sentry.getplexo.com)')
    } catch (err) {
        logger.warn({ err }, 'Sentry: central client failed to initialize')
    }

    // Operator client — for the instance operator's own Sentry
    const operatorDsn = process.env.SENTRY_DSN
    if (operatorDsn && operatorDsn !== PLEXO_CENTRAL_DSN) {
        try {
            operatorClient = makeOperatorClient(operatorDsn)
            logger.info('Sentry: operator client initialized (SENTRY_DSN)')
        } catch (err) {
            logger.warn({ err }, 'Sentry: operator client failed to initialize')
        }
    }
}

/**
 * Capture an exception.
 *
 * - Central client: consent checked in beforeSend (runtime gate)
 * - Operator client: always fires when initialized (operator's own project)
 *
 * Always non-fatal — never throws.
 */
export function captureException(err: unknown, context?: Record<string, unknown>): void {
    const message = err instanceof Error ? err.message : String(err)

    // Ignore known non-actionable errors in both clients
    if (IGNORE_ERRORS.some((pat) => message.includes(pat))) return

    const hint: EventHint | undefined = context ? { data: context } : undefined

    // Central: beforeSend handles consent gate + payload sanitization
    if (centralClient) {
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

/**
 * Capture a lifecycle event (task started, completed, failed, etc.)
 * as a Sentry message for observability.
 *
 * This gives operators a timeline of all task/sprint/conversation events
 * in their Sentry project, even when there's no error.
 */
export function captureLifecycleEvent(
    eventName: string,
    level: 'info' | 'warning' | 'error',
    context?: Record<string, unknown>,
): void {
    const hint: EventHint | undefined = context ? { data: context } : undefined

    // Central: beforeSend handles consent gate + sanitization
    if (centralClient) {
        try {
            centralClient.captureMessage(eventName, level, hint)
        } catch { /* never crash */ }
    }

    if (operatorClient) {
        try {
            operatorClient.captureMessage(eventName, level, hint)
        } catch { /* never crash */ }
    }
}
