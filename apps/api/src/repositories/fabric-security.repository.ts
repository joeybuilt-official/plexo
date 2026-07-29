// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Session Fabric security stores — valkey adapters (Phase 1c).
 *
 * Implements the domain ports (`KillSwitchStore`, `RevocationStore`,
 * `GrantStore`, `AuditSink`) over the shared redis/valkey client. Keeping the
 * kill-switch flag + revocation denylist + drive grants in valkey lets the
 * security bar work WITHOUT the (unapplied) fabric DB migration.
 */

import type {
    AuditRecord,
    AuditSink,
    GrantStore,
    KillSwitchState,
    KillSwitchStore,
    RevocationStore,
} from '@plexo/session-fabric'
import { getRedis } from '../redis-client.js'
import { logger } from '../logger.js'

const KILL_KEY = 'fabric:kill'
const AUDIT_KEY = 'fabric:audit'
const AUDIT_DENIED_KEY = 'fabric:audit:denied'
const AUDIT_CAP = 10_000

// Segments are encoded so an id containing the ':' delimiter can't forge a
// collision (e.g. grant (a:b, c) vs (a, b:c) must resolve to distinct keys).
function revokedKey(jti: string): string {
    return `fabric:revoked:${encodeURIComponent(jti)}`
}
function grantKey(sessionId: string, participantId: string): string {
    return `fabric:grant:${encodeURIComponent(sessionId)}:${encodeURIComponent(participantId)}`
}

export function makeKillSwitchStore(): KillSwitchStore {
    return {
        async state(): Promise<KillSwitchState> {
            const r = await getRedis()
            const reason = await r.get(KILL_KEY)
            return reason === null ? { engaged: false } : { engaged: true, reason }
        },
        async engage(reason: string): Promise<void> {
            const r = await getRedis()
            await r.set(KILL_KEY, reason || 'engaged')
        },
        async release(): Promise<void> {
            const r = await getRedis()
            await r.del(KILL_KEY)
        },
    }
}

export function makeRevocationStore(): RevocationStore {
    return {
        async revoke(jti: string, expiresAtSec: number): Promise<void> {
            const r = await getRedis()
            const now = Math.floor(Date.now() / 1000)
            const ttl = Math.max(1, expiresAtSec - now)
            await r.set(revokedKey(jti), '1', { EX: ttl })
        },
        async isRevoked(jti: string): Promise<boolean> {
            const r = await getRedis()
            return (await r.exists(revokedKey(jti))) === 1
        },
    }
}

export function makeGrantStore(): GrantStore {
    return {
        async grant(sessionId: string, participantId: string, ttlSec: number): Promise<void> {
            const r = await getRedis()
            await r.set(grantKey(sessionId, participantId), '1', { EX: Math.max(1, ttlSec) })
        },
        async hasGrant(sessionId: string, participantId: string): Promise<boolean> {
            const r = await getRedis()
            return (await r.exists(grantKey(sessionId, participantId))) === 1
        },
        async revoke(sessionId: string, participantId: string): Promise<void> {
            const r = await getRedis()
            await r.del(grantKey(sessionId, participantId))
        },
    }
}

export function makeAuditSink(): AuditSink {
    return {
        async append(record: AuditRecord): Promise<void> {
            logger.info({ audit: record }, `fabric-audit ${record.type}`)
            // High-volume denial events go to a SEPARATE capped key so a flood of
            // denied requests can't evict durable security records (token.issue,
            // kill.engage, drive.grant) from the main audit stream.
            const key = record.type === 'action.denied' ? AUDIT_DENIED_KEY : AUDIT_KEY
            try {
                const r = await getRedis()
                await r.lPush(key, JSON.stringify(record))
                await r.lTrim(key, 0, AUDIT_CAP - 1)
            } catch (err) {
                logger.warn({ err: (err as Error).message }, 'fabric-audit valkey append failed (logged only)')
            }
        },
    }
}
