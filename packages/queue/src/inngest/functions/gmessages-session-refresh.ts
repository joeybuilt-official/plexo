// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * gmessages.session.refresh (ADR-0006).
 *
 * Cron every 15 minutes. Fans out one step per active paired session so
 * Inngest can retry + dedup individual refreshes independently. Phase 4b
 * scope: emit `gmessages.session.refresh-requested` events; the sidecar
 * handler that consumes them (POST /sessions/:id/refresh on the sidecar)
 * is left as a Phase 5 deliverable because the actual refresh requires
 * libgm.Client.RefreshPhoneRelay() against an already-Connected session,
 * and Phase 4b's session.Handler does not yet expose a per-session
 * refresh hook. The cron + fan-out + event emission is in place; the
 * receiver wires in 5.
 */

import { db, pairedSessions, eq, and, inArray, lt } from '@plexo/db'
import { inngest } from '../client.js'

const DEFAULT_REFRESH_AGE_MIN = 60

function refreshAgeMs(): number {
    const v = Number(process.env.GMESSAGES_REFRESH_AGE_MIN)
    const min = Number.isFinite(v) && v > 0 ? v : DEFAULT_REFRESH_AGE_MIN
    return min * 60 * 1000
}

export const gmessagesSessionRefresh = inngest.createFunction(
    { id: 'gmessages-session-refresh' },
    { cron: '*/15 * * * *' },
    async ({ step, logger }) => {
        const cutoff = new Date(Date.now() - refreshAgeMs())

        const due = await step.run('scan-due', async () => {
            return await db
                .select({
                    id: pairedSessions.id,
                    workspaceId: pairedSessions.workspaceId,
                })
                .from(pairedSessions)
                .where(and(
                    eq(pairedSessions.state, 'active'),
                    lt(pairedSessions.lastInboundAt, cutoff),
                ))
        })

        if (due.length === 0) {
            return { scanned: 0, refreshed: 0 }
        }

        await step.sendEvent('emit-refresh-events', due.map(s => ({
            name: 'gmessages.session.refresh-requested' as const,
            data: { pairedSessionId: s.id, workspaceId: s.workspaceId },
        })))

        logger.info({ count: due.length }, 'gmessages session-refresh dispatched')
        return { scanned: due.length, refreshed: due.length }
    },
)

void inArray
