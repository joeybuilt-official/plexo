// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

// sentry.server.config.ts — runs on the Next.js Node.js server
//
// Same DSN priority as client config:
//   1. NEXT_PUBLIC_SENTRY_DSN — operator's own Sentry
//   2. Plexo central — telemetry opted-in instances without their own Sentry
import * as Sentry from '@sentry/nextjs'

const PLEXO_CENTRAL_DSN = 'https://6d0a6e3fc7520f34ea7a26647013f2b6@sentry.getplexo.com/2'
const OPERATOR_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN
const TELEMETRY_DISABLED = process.env.NEXT_PUBLIC_TELEMETRY_DISABLED === 'true'

const dsn = OPERATOR_DSN ?? (!TELEMETRY_DISABLED ? PLEXO_CENTRAL_DSN : undefined)

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'production',
    tracesSampleRate: 0,
  })
}
