// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * In-memory sliding window rate limiter for /auth/handshake.
 *
 * 10 requests per IP per 60-second window.
 *
 * This is an in-memory store — it resets on server restart and does not
 * share state across multiple instances. For multi-instance deployments,
 * replace with a Redis/Valkey INCR + TTL counter keyed on `handshake:<ip>`.
 */

const WINDOW_MS = 60_000
const MAX_REQUESTS = 10

interface Entry {
    timestamps: number[]
}

const store = new Map<string, Entry>()

// Evict stale entries every 5 minutes to prevent unbounded memory growth
const CLEANUP_INTERVAL = 5 * 60_000
let lastCleanup = Date.now()

function cleanup(now: number) {
    if (now - lastCleanup < CLEANUP_INTERVAL) return
    lastCleanup = now
    for (const [key, entry] of store) {
        if (entry.timestamps.every((ts) => now - ts > WINDOW_MS)) {
            store.delete(key)
        }
    }
}

/**
 * Returns `true` if the request is allowed, `false` if rate-limited.
 */
export function handshakeRateLimit(ip: string): boolean {
    const now = Date.now()
    cleanup(now)

    const key = `handshake:${ip}`
    let entry = store.get(key)

    if (!entry) {
        entry = { timestamps: [] }
        store.set(key, entry)
    }

    // Drop timestamps outside the current window
    entry.timestamps = entry.timestamps.filter((ts) => now - ts < WINDOW_MS)

    if (entry.timestamps.length >= MAX_REQUESTS) {
        return false
    }

    entry.timestamps.push(now)
    return true
}
