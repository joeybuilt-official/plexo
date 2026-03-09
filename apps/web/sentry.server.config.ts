// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

// sentry.server.config.ts — runs on the Next.js Node.js server
// Respects the same opt-in as PostHog crash reporting (Settings → Privacy).
import * as Sentry from '@sentry/nextjs'

const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN
const TELEMETRY_DISABLED = process.env.NEXT_PUBLIC_TELEMETRY_DISABLED === 'true'

if (SENTRY_DSN && !TELEMETRY_DISABLED) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NODE_ENV ?? 'production',
    tracesSampleRate: 0,
  })
}
