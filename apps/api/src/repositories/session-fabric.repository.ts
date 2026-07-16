// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Session Fabric — Drizzle persistence adapter (Phase 1b).
 *
 * Implements the framework-free `SessionRepo` port from `@plexo/session-fabric`
 * against `@plexo/db`. This is the outer ring: it maps rows ⇆ contract DTOs and
 * translates the pg UNIQUE(session_id, seq) violation (23505) into the port's
 * `SeqConflictError` so the append use-case can retry. No business rules here.
 */

import { and, asc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm'
import { db } from '@plexo/db'
import { sessions, sessionEvents, sessionParticipants, runners, leases } from '@plexo/db'
import type {
    SessionRow,
    SessionEventRow,
    SessionParticipantRow,
    RunnerRow,
    LeaseRow,
} from '@plexo/db'
import type {
    Lease,
    NewSessionEvent,
    PresenceInstanceRow,
    Runner,
    Session,
    SessionEvent,
    SessionListRow,
    SessionParticipant,
    SessionRepo,
} from '@plexo/session-fabric'
import { SeqConflictError } from '@plexo/session-fabric'

// ── Row → DTO mappers ───────────────────────────────────────────

const toSession = (r: SessionRow): Session => r

const toEvent = (r: SessionEventRow): SessionEvent => ({
    id: String(r.id),
    sessionId: r.sessionId,
    seq: r.seq,
    schemaVersion: r.schemaVersion,
    kind: r.kind,
    actorType: r.actorType,
    actorId: r.actorId,
    payload: r.payload,
    model: r.model,
    provider: r.provider,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    costUsd: r.costUsd,
    outcomeKind: r.outcomeKind,
    reward: r.reward,
    reward_source: r.rewardSource,
    provenance: r.provenance,
    outcomeOfSeq: r.outcomeOfSeq,
    resolvedAt: r.resolvedAt,
    createdAt: r.createdAt,
})

const toParticipant = (r: SessionParticipantRow): SessionParticipant => r
const toRunner = (r: RunnerRow): Runner => r
const toLease = (r: LeaseRow): Lease => r

function isUniqueViolation(e: unknown): boolean {
    return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505'
}

export function makeSessionFabricRepo(): SessionRepo {
    return {
        async createSession(row: Session): Promise<Session> {
            const [r] = await db.insert(sessions).values(row).returning()
            return toSession(r!)
        },

        async getSession(id: string): Promise<Session | null> {
            const [r] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1)
            return r ? toSession(r) : null
        },

        async listSessions(workspaceId: string): Promise<SessionListRow[]> {
            const sessionRows = await db
                .select()
                .from(sessions)
                .where(eq(sessions.workspaceId, workspaceId))
                .orderBy(sql`${sessions.createdAt} DESC`)
                .limit(200)
            if (sessionRows.length === 0) return []

            const ids = sessionRows.map((s) => s.id)
            const leaseRows = await db.select().from(leases).where(inArray(leases.sessionId, ids))
            const partRows = await db
                .select()
                .from(sessionParticipants)
                .where(inArray(sessionParticipants.sessionId, ids))

            const runnerIds = [...new Set(leaseRows.map((l) => l.runnerId))]
            const runnerRows = runnerIds.length
                ? await db.select().from(runners).where(inArray(runners.id, runnerIds))
                : []
            const runnerStatus = new Map(runnerRows.map((r) => [r.id, r.status]))
            const leaseBySession = new Map(leaseRows.map((l) => [l.sessionId, l]))

            return sessionRows.map((s) => {
                const lease = leaseBySession.get(s.id) ?? null
                return {
                    session: toSession(s),
                    lease: lease ? toLease(lease) : null,
                    runnerStatus: lease ? (runnerStatus.get(lease.runnerId) ?? null) : null,
                    participants: partRows
                        .filter((p) => p.sessionId === s.id)
                        .map((p) => ({ role: p.role, lastHeartbeat: p.lastHeartbeat })),
                }
            })
        },

        async listWorkspaceInstances(workspaceId: string): Promise<PresenceInstanceRow[]> {
            const runnerRows = await db
                .select({
                    id: runners.id,
                    capabilities: runners.capabilities,
                    status: runners.status,
                    lastHeartbeat: runners.lastHeartbeat,
                })
                .from(runners)
                .where(eq(runners.workspaceId, workspaceId))

            const runnerIds = runnerRows.map((r) => r.id)
            const runnerLeaseRows = runnerIds.length
                ? await db
                      .select({
                          runnerId: leases.runnerId,
                          sessionId: leases.sessionId,
                          claimedUntil: leases.claimedUntil,
                      })
                      .from(leases)
                      .innerJoin(sessions, eq(sessions.id, leases.sessionId))
                      .where(and(inArray(leases.runnerId, runnerIds), eq(sessions.workspaceId, workspaceId)))
                : []
            // A runner may hold leases on multiple sessions; the greatest claimedUntil wins.
            const leaseByRunner = new Map<string, (typeof runnerLeaseRows)[number]>()
            for (const l of runnerLeaseRows) {
                const cur = leaseByRunner.get(l.runnerId)
                if (!cur || l.claimedUntil.getTime() > cur.claimedUntil.getTime()) leaseByRunner.set(l.runnerId, l)
            }

            const runnerInstances: PresenceInstanceRow[] = runnerRows.map((r) => {
                const lease = leaseByRunner.get(r.id) ?? null
                return {
                    id: r.id,
                    kind: 'runner',
                    surface: null,
                    capabilities: r.capabilities,
                    status: r.status,
                    role: null,
                    lastHeartbeat: r.lastHeartbeat,
                    leaseSessionId: lease?.sessionId ?? null,
                    leaseUntil: lease?.claimedUntil ?? null,
                }
            })

            const headRows = await db
                .select({
                    participantId: sessionParticipants.participantId,
                    surface: sessionParticipants.surface,
                    capabilities: sessionParticipants.capabilities,
                    role: sessionParticipants.role,
                    lastHeartbeat: sessionParticipants.lastHeartbeat,
                    sessionId: sessionParticipants.sessionId,
                })
                .from(sessionParticipants)
                .innerJoin(sessions, eq(sessions.id, sessionParticipants.sessionId))
                .where(and(eq(sessions.workspaceId, workspaceId), eq(sessionParticipants.kind, 'head')))

            // A head appears once per joined session; collapse to one instance per participantId:
            // freshest heartbeat wins the row, any driver-role session becomes drivingSessionId.
            const headByParticipant = new Map<string, PresenceInstanceRow>()
            for (const h of headRows) {
                const existing = headByParticipant.get(h.participantId)
                if (!existing) {
                    headByParticipant.set(h.participantId, {
                        id: h.participantId,
                        kind: 'head',
                        surface: h.surface,
                        capabilities: h.capabilities,
                        status: null,
                        role: h.role,
                        lastHeartbeat: h.lastHeartbeat,
                        leaseSessionId: h.role === 'driver' ? h.sessionId : null,
                        leaseUntil: null,
                    })
                    continue
                }
                if (h.lastHeartbeat.getTime() > existing.lastHeartbeat.getTime()) {
                    existing.surface = h.surface
                    existing.capabilities = h.capabilities
                    existing.role = h.role
                    existing.lastHeartbeat = h.lastHeartbeat
                }
                if (existing.leaseSessionId === null && h.role === 'driver') existing.leaseSessionId = h.sessionId
            }
            // role and drivingSessionId must agree: a head adopted as driving is a driver.
            for (const inst of headByParticipant.values()) {
                if (inst.leaseSessionId !== null) inst.role = 'driver'
            }

            return [...runnerInstances, ...headByParticipant.values()]
        },

        async maxSeq(sessionId: string): Promise<number> {
            const [r] = await db
                .select({ m: sql<number>`coalesce(max(${sessionEvents.seq}), 0)` })
                .from(sessionEvents)
                .where(eq(sessionEvents.sessionId, sessionId))
            return r?.m ?? 0
        },

        async appendEvent(event: NewSessionEvent): Promise<SessionEvent> {
            try {
                const [r] = await db
                    .insert(sessionEvents)
                    .values({
                        sessionId: event.sessionId,
                        seq: event.seq,
                        schemaVersion: event.schemaVersion,
                        kind: event.kind,
                        actorType: event.actorType,
                        actorId: event.actorId,
                        payload: event.payload ?? {},
                        model: event.model,
                        provider: event.provider,
                        tokensIn: event.tokensIn,
                        tokensOut: event.tokensOut,
                        costUsd: event.costUsd,
                        outcomeKind: event.outcomeKind,
                        reward: event.reward,
                        rewardSource: event.reward_source,
                        provenance: event.provenance,
                        outcomeOfSeq: event.outcomeOfSeq,
                        resolvedAt: event.resolvedAt,
                    })
                    .returning()
                return toEvent(r!)
            } catch (e) {
                if (isUniqueViolation(e)) throw new SeqConflictError(event.sessionId, event.seq)
                throw e
            }
        },

        async listEvents(sessionId: string, sinceSeq: number): Promise<SessionEvent[]> {
            const rows = await db
                .select()
                .from(sessionEvents)
                .where(and(eq(sessionEvents.sessionId, sessionId), gt(sessionEvents.seq, sinceSeq - 1)))
                .orderBy(asc(sessionEvents.seq))
                .limit(1000)
            return rows.map(toEvent)
        },

        async upsertParticipant(row: SessionParticipant): Promise<SessionParticipant> {
            const [r] = await db
                .insert(sessionParticipants)
                .values({ ...row, capabilities: row.capabilities ?? {} })
                .onConflictDoUpdate({
                    target: [sessionParticipants.sessionId, sessionParticipants.participantId],
                    set: {
                        kind: row.kind,
                        surface: row.surface,
                        capabilities: row.capabilities,
                        role: row.role,
                        lastHeartbeat: row.lastHeartbeat,
                    },
                })
                .returning()
            return toParticipant(r!)
        },

        async upsertRunner(row: Runner): Promise<Runner> {
            const [r] = await db
                .insert(runners)
                .values({ ...row, capabilities: row.capabilities ?? {} })
                .onConflictDoUpdate({
                    target: runners.id,
                    set: {
                        workspaceId: row.workspaceId,
                        backend: row.backend,
                        capabilities: row.capabilities,
                        status: row.status,
                        lastHeartbeat: row.lastHeartbeat,
                    },
                })
                .returning()
            return toRunner(r!)
        },

        async getLease(sessionId: string): Promise<Lease | null> {
            const [r] = await db.select().from(leases).where(eq(leases.sessionId, sessionId)).limit(1)
            return r ? toLease(r) : null
        },

        async tryClaimLease(input): Promise<{ won: boolean; current: Lease }> {
            const rows = await db
                .insert(leases)
                .values({
                    sessionId: input.sessionId,
                    runnerId: input.runnerId,
                    claimedAt: input.claimedAt,
                    claimedUntil: input.claimedUntil,
                })
                .onConflictDoUpdate({
                    target: leases.sessionId,
                    set: {
                        runnerId: input.runnerId,
                        claimedAt: input.claimedAt,
                        claimedUntil: input.claimedUntil,
                    },
                    setWhere: or(lt(leases.claimedUntil, input.now), eq(leases.runnerId, input.runnerId)),
                })
                .returning()
            if (rows.length > 0) return { won: true, current: toLease(rows[0]!) }
            const [held] = await db.select().from(leases).where(eq(leases.sessionId, input.sessionId)).limit(1)
            return { won: false, current: toLease(held!) }
        },

        async renewLease(input): Promise<Lease | null> {
            const rows = await db
                .update(leases)
                .set({ claimedUntil: input.claimedUntil })
                .where(
                    and(
                        eq(leases.sessionId, input.sessionId),
                        eq(leases.runnerId, input.runnerId),
                        gt(leases.claimedUntil, input.now),
                    ),
                )
                .returning()
            return rows[0] ? toLease(rows[0]) : null
        },

        async releaseLease(sessionId: string, runnerId: string): Promise<boolean> {
            const rows = await db
                .delete(leases)
                .where(and(eq(leases.sessionId, sessionId), eq(leases.runnerId, runnerId)))
                .returning()
            return rows.length > 0
        },
    }
}
