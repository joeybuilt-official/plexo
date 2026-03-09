// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import type { ErrorCategory } from './types.js'

export class PlexoError extends Error {
    constructor(
        message: string,
        public readonly code: string,
        public readonly category: ErrorCategory,
        public readonly statusCode: number,
        public readonly detail?: unknown,
    ) {
        super(message)
        this.name = 'PlexoError'
    }
}

export class NotImplementedError extends PlexoError {
    constructor(method: string) {
        super(
            `${method} is not yet implemented`,
            'NOT_IMPLEMENTED',
            'system',
            501,
        )
        this.name = 'NotImplementedError'
    }
}

export class LogicError extends PlexoError {
    constructor(message: string) {
        super(message, 'LOGIC_ERROR', 'system', 500)
        this.name = 'LogicError'
    }
}
