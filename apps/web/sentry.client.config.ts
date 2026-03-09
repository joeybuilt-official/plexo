// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

// sentry.client.config.ts — runs in the browser
// Respects the same opt-in as PostHog crash reporting (Settings → Privacy).
// Disabled when NEXT_PUBLIC_TELEMETRY_DISABLED=true or NEXT_PUBLIC_SENTRY_DSN is unset.
import * as Sentry from '@sentry/nextjs'

const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN
const TELEMETRY_DISABLED = process.env.NEXT_PUBLIC_TELEMETRY_DISABLED === 'true'

if (SENTRY_DSN && !TELEMETRY_DISABLED) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NODE_ENV ?? 'production',
    // Capture JS exceptions; no performance tracing
    tracesSampleRate: 0,
    // Replay 10% of sessions; 100% when an error occurs
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    integrations: [
      Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }),
    ],
    // Don't send expected/benign errors
    ignoreErrors: [
      'ResizeObserver loop limit exceeded',
      'Network request failed',
      /ChunkLoadError/,
    ],
  })
}
