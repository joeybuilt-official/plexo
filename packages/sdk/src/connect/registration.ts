// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import type { AppProfile, PlexoClientOptions } from './types.js'

function buildHeaders(opts: PlexoClientOptions): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.serviceKey}`,
        'X-App-Id': opts.appId,
    }
}

async function post(
    opts: PlexoClientOptions,
    path: string,
    body: unknown,
): Promise<boolean> {
    const fetchImpl = opts.fetchImpl ?? fetch
    try {
        const res = await fetchImpl(
            `${opts.plexoUrl.replace(/\/$/, '')}${path}`,
            {
                method: 'POST',
                headers: buildHeaders(opts),
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(8_000),
            },
        )
        if (!res.ok) {
            const detail = await res.text().catch(() => `HTTP ${res.status}`)
            console.error(`[plexo/connect] registration rejected (${res.status}): ${detail}`)
            return false
        }
        return true
    } catch (err) {
        console.warn(`[plexo/connect] registration attempt failed: ${(err as Error).message}`)
        return false
    }
}

export async function register(
    opts: PlexoClientOptions,
    profile: AppProfile,
): Promise<void> {
    const backoff = opts.resilience?.registrationBackoffMs ?? [5_000, 15_000, 45_000]

    if (await post(opts, '/api/v1/profiles/register', profile)) {
        console.info(`[plexo/connect] registered appId=${opts.appId}`)
        return
    }

    for (const delay of backoff) {
        console.info(`[plexo/connect] retrying registration in ${delay / 1000}s`)
        await new Promise<void>((r) => setTimeout(r, delay))
        if (await post(opts, '/api/v1/profiles/register', profile)) {
            console.info(`[plexo/connect] registered appId=${opts.appId}`)
            return
        }
    }

    console.warn('[plexo/connect] registration retries exhausted — running in standalone mode')
}
