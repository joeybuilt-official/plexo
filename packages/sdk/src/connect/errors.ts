// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

export class PlexoNotConfiguredError extends Error {
    override readonly name = 'PlexoNotConfiguredError'
    constructor(missing: string) {
        super(`PlexoClient not configured: ${missing} is required`)
    }
}

export class PlexoUnreachableError extends Error {
    override readonly name = 'PlexoUnreachableError'
    readonly url: string
    constructor(url: string, cause?: unknown) {
        super(`Plexo Core unreachable at ${url}`)
        this.url = url
        if (cause) this.cause = cause
    }
}

export class PlexoProtocolError extends Error {
    override readonly name = 'PlexoProtocolError'
    readonly clientVersion: string
    readonly serverVersion: string
    constructor(clientVersion: string, serverVersion: string) {
        super(`PEX contract version mismatch: client ${clientVersion} vs server ${serverVersion} (incompatible major)`)
        this.clientVersion = clientVersion
        this.serverVersion = serverVersion
    }
}

export class PlexoApiError extends Error {
    override readonly name: string = 'PlexoApiError'
    readonly status: number
    readonly path: string
    constructor(status: number, path: string, detail?: string) {
        super(`Plexo API error ${status} on ${path}${detail ? `: ${detail}` : ''}`)
        this.status = status
        this.path = path
    }
}

export class PlexoAuthError extends PlexoApiError {
    readonly name = 'PlexoAuthError' as const
    constructor(path: string) {
        super(401, path, 'invalid or missing service key')
    }
}

export class PlexoRateLimitedError extends PlexoApiError {
    readonly name = 'PlexoRateLimitedError' as const
    readonly retryAfterMs: number
    constructor(path: string, retryAfterSec?: number) {
        super(429, path, 'rate limited')
        this.retryAfterMs = (retryAfterSec ?? 60) * 1000
    }
}
