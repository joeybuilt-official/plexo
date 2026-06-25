// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * gmessages.stale-session.monitor (ADR-0006).
 *
 * Cron every 5 minutes. Scans plexo_gmessages.paired_sessions for active
 * sessions whose last_inbound_at is older than the stale threshold and:
 *
 * 1. Emits a `gmessages.session.stale-detected` event so downstream
 *    notification + UX surfaces ("Phone offline" banner, ADR-0005 §"Copy
 *    lock") can react.
 * 2. Flips the row to state='errored' with errorDetail describing the
 *    stale window. Operators (or the user) can then trigger a re-pair via
 *    the existing /api/v1/connections/gmessages/pair-start flow.
 *
 * Threshold rationale: 24h matches ADR-0005 §"Failure modes" — "We haven't
 * seen messages from your phone in a while" copy is gated behind 24h of
 * silence. The interval is adjustable via env if Phase 6 ops needs to
 * tighten or loosen for paid tiers.
 */

import { eq, and, lt, inArray, sql } from 'drizzle-orm'
import { db, pairedSessions } from '@plexo/db'
import { inngest } from '../client.js'

const DEFAULT_STALE_HOURS = 24

function staleHours(): number {
    const v = Number(process.env.GMESSAGES_STALE_HOURS)
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_STALE_HOURS
}

export const gmessagesStaleSessionMonitor = inngest.createFunction(
    { id: 'gmessages-stale-session-monitor' },
    { cron: '*/5 * * * *' },
    async ({ step, logger }) => {
        const hours = staleHours()
        const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000)

        const stale = await step.run('scan-stale', async () => {
            return await db
                .select({
                    id: pairedSessions.id,
                    workspaceId: pairedSessions.workspaceId,
                    lastInboundAt: pairedSessions.lastInboundAt,
                })
                .from(pairedSessions)
                .where(and(
                    inArray(pairedSessions.state, ['active', 'refreshing']),
                    lt(pairedSessions.lastInboundAt, cutoff),
                ))
        })

        if (stale.length === 0) {
            return { scanned: 0, flagged: 0 }
        }

        await step.run('flag-stale', async () => {
            await db.update(pairedSessions)
                .set({
                    state: 'errored',
                    stateChangedAt: new Date(),
                    errorDetail: `no inbound traffic for ${hours}h (last_inbound_at < ${cutoff.toISOString()})`,
                })
                .where(inArray(pairedSessions.id, stale.map(s => s.id)))
        })

        await step.sendEvent('emit-stale-events', stale.map(s => {
            const last = s.lastInboundAt ? new Date(s.lastInboundAt) : cutoff
            return {
                name: 'gmessages.session.stale-detected' as const,
                data: {
                    pairedSessionId: s.id,
                    workspaceId: s.workspaceId,
                    staleSinceIso: last.toISOString(),
                },
            }
        }))

        logger.info({ flagged: stale.length, hours }, 'gmessages stale-session monitor flagged sessions')
        return { scanned: stale.length, flagged: stale.length }
    },
)

// Quiet unused-import warnings until we extend the query.
void sql
void eq
