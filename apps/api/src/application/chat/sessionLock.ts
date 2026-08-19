// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Per-session mutex use-case for the webchat message route.
 *
 * Extracted verbatim from `routes/chat.ts` (FUN-001). Prevents concurrent
 * message processing for the same session key, which would race on session
 * resolution, duplicate provider calls, and corrupt conversation history.
 *
 * Pure module: no Express/Drizzle/SDK imports. The route supplies the session
 * key and the async thunk; this module serializes execution per key and
 * reentrantly cleans up the lock map entry once the chain drains.
 */

const sessionLocks = new Map<string, Promise<void>>()

/**
 * Run `fn` after any in-flight turn for `sessionKey` settles, and block the
 * next turn for the same key until `fn` settles. Returns `fn`'s result.
 *
 * The lock is chained on a per-key Promise: each caller waits on the prior
 * caller's completion promise, then installs its own. The map entry is
 * deleted only if it still points at the current promise, so a later caller
 * installing a newer promise is not clobbered.
 */
export function withSessionLock<T>(sessionKey: string, fn: () => Promise<T>): Promise<T> {
    const prev = sessionLocks.get(sessionKey) ?? Promise.resolve()
    let resolve: () => void
    const current = new Promise<void>(r => { resolve = r })
    sessionLocks.set(sessionKey, current)
    return prev.then(() => fn()).finally(() => {
        resolve!()
        if (sessionLocks.get(sessionKey) === current) {
            sessionLocks.delete(sessionKey)
        }
    })
}

/**
 * Test-only hook: clear the lock map. Exported so characterization tests can
 * assert the map drains to empty after a serialized chain. Not for route use.
 */
export function __clearSessionLocksForTest(): void {
    sessionLocks.clear()
}

/** Test-only hook: live count of held/queued keys. */
export function __sessionLockCountForTest(): number {
    return sessionLocks.size
}