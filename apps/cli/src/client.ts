// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Authenticated API client — thin fetch wrapper.
 * Sends x-user-id + x-workspace-id on every request.
 * Throws on non-2xx with structured error details.
 */
import type { PlexoProfile } from './config.js'

export class ApiError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
    ) {
        super(message)
        this.name = 'ApiError'
    }
}

export function buildClient(profile: PlexoProfile, verbose = false) {
    const base = profile.host.replace(/\/$/, '')

    async function request<T>(
        method: string,
        path: string,
        body?: unknown,
        extraHeaders?: Record<string, string>,
    ): Promise<T> {
        const url = `${base}${path}`
        const headers: Record<string, string> = {
            'content-type': 'application/json',
            'x-user-id': profile.userId,
            'x-workspace-id': profile.workspace,
            'authorization': `Bearer ${profile.token}`,
            ...extraHeaders,
        }

        if (verbose) {
            console.error(`→ ${method} ${url}`)
        }

        const res = await fetch(url, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
        })

        const text = await res.text()
        let json: unknown
        try { json = JSON.parse(text) } catch { json = { message: text } }

        if (verbose) {
            console.error(`← ${res.status}`)
        }

        if (!res.ok) {
            const err = json as { error?: { code?: string; message?: string }; message?: string }
            throw new ApiError(
                res.status,
                err?.error?.code ?? 'API_ERROR',
                err?.error?.message ?? err?.message ?? `HTTP ${res.status}`,
            )
        }

        return json as T
    }

    return {
        get: <T>(path: string) => request<T>('GET', path),
        post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
        patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
        delete: <T>(path: string) => request<T>('DELETE', path),
    }
}

export type ApiClient = ReturnType<typeof buildClient>
