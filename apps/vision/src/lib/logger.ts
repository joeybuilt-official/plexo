// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Shared pino logger for the vision service. Matches the apps/embeddings
 * pattern: each module creates a child logger with a `name` field.
 */

import pino from 'pino'

const level = process.env.LOG_LEVEL ?? 'info'

export const rootLogger = pino({
    name: 'vision',
    level,
    // pino-pretty is loaded as a transport in dev; in production we emit
    // structured JSON for whichever log aggregator the deploy environment
    // provides (matches apps/embeddings).
    ...(process.env.NODE_ENV !== 'production'
        ? {
              transport: {
                  target: 'pino-pretty',
                  options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
              },
          }
        : {}),
})

export function childLogger(name: string): pino.Logger {
    return rootLogger.child({ name })
}
