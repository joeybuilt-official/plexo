// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Single-writer local-instance descriptor claim (ADR 0001 §1, rung-2
 * "reuse-running" discovery — the WRITE side).
 *
 * A locally-running Plexo can advertise itself to SDK clients by writing a
 * descriptor lockfile at an OS-conventional path. The SDK client reads it in
 * `PlexoClient.#readInstanceDescriptor()` and attaches if the URL health-checks.
 * Until now nothing wrote that file; this module adds the claim.
 *
 * Default-OFF behind `PLEXO_CLAIM_LOCAL_INSTANCE=1`: in a multi-replica prod
 * deployment several API pods share one Postgres and one filesystem image, so a
 * descriptor write would be ambiguous (which replica's loopback URL "wins"?).
 * The flag is meant for single-node local installs (the laptop / dev box that
 * an app wants to discover-and-reuse), where exactly one writer should claim.
 */

import { db } from '@plexo/db'
import { logger } from '../logger.js'
import { PEX_CONTRACT_VERSION } from '@joeybuilt/plexo-sdk'

/**
 * Fixed 64-bit advisory-lock key for the local-instance claim. Arbitrary but
 * stable — every API process competes for this same key, so only one wins the
 * non-blocking `pg_try_advisory_lock` and becomes the descriptor writer.
 * (0x504c58 = 5262424 = ASCII "PLX"). A plain number (not bigint): it is far
 * inside int8 range and postgres-js serializes JS numbers natively, whereas its
 * tagged-template params do not accept `bigint`.
 */
const ADVISORY_LOCK_KEY = 0x504c58

/**
 * Resolve the descriptor path IDENTICALLY to the SDK client's read logic
 * (`client.ts` #readInstanceDescriptor): `$XDG_RUNTIME_DIR/plexo/instance.json`,
 * falling back to `/tmp/plexo/instance.json` when XDG_RUNTIME_DIR is unset.
 *
 * The SDK exposes a per-client `instanceDescriptorPath` override, but that is a
 * client constructor option — not an env var — so the server has no shared
 * channel to honor it. Both sides therefore agree on the env-derived default.
 */
function descriptorPath(): string {
    return `${process.env.XDG_RUNTIME_DIR ?? '/tmp'}/plexo/instance.json`
}

/**
 * A connection RESERVED from the existing postgres-js pool (`db.$client`) and
 * held open for the descriptor's lifetime. postgres-js session advisory locks
 * are tied to the connection that issued them; the shared pool (max 20) could
 * otherwise hand the try-lock and the unlock to DIFFERENT connections, breaking
 * single-writer semantics. `reserve()` pins ONE connection so lock + unlock land
 * on the same session and the claim holds for as long as the process runs —
 * and reuses the existing dependency (no new postgres-js client to configure).
 */
let lockConn: Awaited<ReturnType<typeof db.$client.reserve>> | null = null

/**
 * Try to become the single local-instance descriptor writer.
 *
 * Returns true only if this process won the advisory lock AND wrote the
 * descriptor; false otherwise (flag off, lock held by a peer, or any error).
 * Never throws — a claim failure must never block API boot.
 */
export async function claimLocalInstance(opts: { url: string }): Promise<boolean> {
    // Gate: default OFF. Protects multi-replica prod from ambiguous writes.
    if (process.env.PLEXO_CLAIM_LOCAL_INSTANCE !== '1') return false

    try {
        // Pinned single connection so the session lock survives for the
        // process lifetime and is released on the same connection.
        lockConn = await db.$client.reserve()

        const [row] = await lockConn`select pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) as locked`
        if (!row?.locked) {
            logger.info('another local instance holds the claim; skipping descriptor write')
            // We did not win — return the reserved connection to the pool.
            lockConn.release()
            lockConn = null
            return false
        }

        const { mkdir, writeFile, rename } = await import('node:fs/promises')
        const { dirname } = await import('node:path')
        const path = descriptorPath()
        await mkdir(dirname(path), { recursive: true })

        const descriptor = {
            url: opts.url,
            pid: process.pid,
            contractVersion: PEX_CONTRACT_VERSION,
            startedAt: new Date().toISOString(),
        }

        // Atomic publish: write to a temp sibling then rename over the target so
        // a reader never observes a half-written file.
        const tmp = `${path}.tmp`
        await writeFile(tmp, JSON.stringify(descriptor), 'utf8')
        await rename(tmp, path)

        logger.info({ path, url: opts.url, pid: process.pid }, 'local instance descriptor claimed')
        return true
    } catch (err) {
        logger.warn({ err }, 'claimLocalInstance failed — continuing without descriptor')
        if (lockConn) {
            try { lockConn.release() } catch { /* best-effort */ }
            lockConn = null
        }
        return false
    }
}

/**
 * Best-effort release of the local-instance claim: unlink the descriptor file
 * (ignore ENOENT), release the advisory lock, and close the pinned connection.
 * Never throws.
 */
export async function releaseLocalInstance(): Promise<void> {
    try {
        const { unlink } = await import('node:fs/promises')
        await unlink(descriptorPath()).catch((err: NodeJS.ErrnoException) => {
            if (err?.code !== 'ENOENT') throw err
        })
    } catch (err) {
        logger.warn({ err }, 'releaseLocalInstance: descriptor unlink failed (ignored)')
    }

    if (lockConn) {
        try {
            await lockConn`select pg_advisory_unlock(${ADVISORY_LOCK_KEY})`
        } catch (err) {
            logger.warn({ err }, 'releaseLocalInstance: advisory unlock failed (ignored)')
        }
        try { lockConn.release() } catch { /* best-effort */ }
        lockConn = null
    }
}
