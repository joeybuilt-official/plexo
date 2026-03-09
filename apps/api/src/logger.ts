// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import pino from 'pino'

export const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: 'plexo-api' },
    ...(process.env.NODE_ENV === 'production'
        ? {}
        : { transport: { target: 'pino-pretty' } }
    ),
    redact: {
        paths: [
            'req.headers.authorization',
            '*.token',
            '*.password',
            '*.secret',
            '*.apiKey',
            '*.accessToken',
            '*.refreshToken',
        ],
    },
})
