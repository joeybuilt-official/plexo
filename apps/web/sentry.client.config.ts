// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

// sentry.client.config.ts — runs in the browser
//
// DSN priority:
//   1. NEXT_PUBLIC_SENTRY_DSN — operator's own Sentry project (always used if set)
//   2. Plexo central DSN — used when telemetry is opted in and no operator DSN is set
//
// The browser SDK only supports one Sentry init. If an operator wants both,
// they should route their own events to sentry.getplexo.com via relay (advanced).
import * as Sentry from '@sentry/nextjs'

// Plexo's central Sentry — same project as the API central client
const PLEXO_CENTRAL_DSN = 'https://6d0a6e3fc7520f34ea7a26647013f2b6@sentry.getplexo.com/2'
const OPERATOR_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN
const TELEMETRY_DISABLED = process.env.NEXT_PUBLIC_TELEMETRY_DISABLED === 'true'

// Operator DSN takes precedence. Fall back to central if telemetry is opted in.
const dsn = OPERATOR_DSN ?? (!TELEMETRY_DISABLED ? PLEXO_CENTRAL_DSN : undefined)

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'production',
    // Errors only — no performance tracing
    tracesSampleRate: 0,
    // Session replay: 10% baseline, 100% on error
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    integrations: [
      Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }),
    ],
    ignoreErrors: [
      'ResizeObserver loop limit exceeded',
      'Network request failed',
      /ChunkLoadError/,
      'AbortError',
    ],
  })
}
