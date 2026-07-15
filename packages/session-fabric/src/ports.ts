// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Session Fabric ports (Phase 1b) — framework-free boundary for the use-cases.
 *
 * Clean Architecture: this ring imports the contract (pure DTOs + Zod) only —
 * never Express, never Drizzle. The Drizzle persistence adapter
 * (`apps/api/src/repositories/session-fabric.repository.ts`) implements
 * `SessionRepo`; the Express adapter (`apps/api/src/routes/sessions.ts`) wires
 * a real `Clock`/`IdGen`. Tests supply an in-memory `SessionRepo`.
 */

import type {
    ActorType,
    Lease,
    OutcomeKind,
    ParticipantKind,
    ParticipantRole,
    ParticipantSurface,
    PolicyTier,
    Runner,
    RunnerBackend,
    RunnerStatus,
    Session,
    SessionEvent,
    SessionEventKind,
    SessionParticipant,
} from './contract'

// ── Cross-cutting ports ─────────────────────────────────────────

export interface Clock {
    now(): Date
}

export interface IdGen {
    next(): string
}

// ── Typed errors + Result ───────────────────────────────────────

export type FabricErrorCode =
    | 'SESSION_NOT_FOUND'
    | 'LEASE_HELD'
    | 'NO_LEASE'
    | 'LEASE_MISMATCH'
    | 'SEQ_CONFLICT'

export interface FabricError {
    code: FabricErrorCode
    message: string
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: FabricError }

export function ok<T>(value: T): Result<T> {
    return { ok: true, value }
}

export function err<T = never>(code: FabricErrorCode, message: string): Result<T> {
    return { ok: false, error: { code, message } }
}

/**
 * Thrown by `SessionRepo.appendEvent` when the UNIQUE(session_id, seq) index
 * rejects a racing insert. Caught by `appendEvent` use-case to retry with a
 * freshly recomputed seq. Adapters MUST translate their native unique-violation
 * (pg 23505 / in-memory duplicate) into this type.
 */
export class SeqConflictError extends Error {
    readonly _tag = 'SeqConflictError'
    constructor(readonly sessionId: string, readonly seq: number) {
        super(`seq ${seq} already exists for session ${sessionId}`)
        this.name = 'SeqConflictError'
    }
}

// ── Use-case input shapes ───────────────────────────────────────

export interface CreateSessionInput {
    workspaceId: string
    createdBy: string
    title?: string | null
    policyTier?: PolicyTier
}

/** Slim append input; the use-case fills nullable slots + computes `seq`. */
export interface AppendInput {
    sessionId: string
    runnerId: string
    kind: SessionEventKind
    actorType: ActorType
    actorId?: string | null
    payload?: unknown
    schemaVersion?: number
    model?: string | null
    provider?: string | null
    tokensIn?: number | null
    tokensOut?: number | null
    costUsd?: number | null
    outcomeKind?: OutcomeKind | null
    reward?: number | null
    reward_source?: string | null
    provenance?: unknown
    outcomeOfSeq?: number | null
    resolvedAt?: Date | null
}

export interface JoinInput {
    sessionId: string
    participantId: string
    kind: ParticipantKind
    surface?: ParticipantSurface | null
    capabilities?: unknown
    role?: ParticipantRole
}

export interface RegisterRunnerInput {
    id: string
    workspaceId?: string | null
    backend: RunnerBackend
    capabilities?: unknown
    status?: RunnerStatus
}

// ── Master-session-list view ────────────────────────────────────

/** Raw per-session assembly the repo returns; use-cases derive presence/active. */
export interface SessionListRow {
    session: Session
    lease: Lease | null
    runnerStatus: RunnerStatus | null
    participants: Array<{ role: ParticipantRole; lastHeartbeat: Date }>
}

export interface MasterSessionEntry {
    session: Session
    driverId: string | null
    lease: { runnerId: string; claimedUntil: Date; active: boolean } | null
    runnerStatus: RunnerStatus | null
    participants: {
        total: number
        present: number
        byRole: Record<ParticipantRole, number>
    }
}

// ── The persistence port ────────────────────────────────────────

export type NewSessionEvent = Omit<SessionEvent, 'id' | 'createdAt'>

export interface SessionRepo {
    createSession(row: Session): Promise<Session>
    getSession(id: string): Promise<Session | null>
    listSessions(workspaceId: string): Promise<SessionListRow[]>

    /** Highest seq for a session, or 0 when it has no events. */
    maxSeq(sessionId: string): Promise<number>
    /** Append an event; throws {@link SeqConflictError} on UNIQUE(session,seq). */
    appendEvent(event: NewSessionEvent): Promise<SessionEvent>
    listEvents(sessionId: string, sinceSeq: number): Promise<SessionEvent[]>

    upsertParticipant(row: SessionParticipant): Promise<SessionParticipant>
    upsertRunner(row: Runner): Promise<Runner>

    getLease(sessionId: string): Promise<Lease | null>
    /**
     * Compare-and-set claim: wins iff no row, the current lease is expired
     * (`claimedUntil < now`), or the caller already holds it. Mirrors an
     * `INSERT … ON CONFLICT DO UPDATE … WHERE claimed_until < now`.
     */
    tryClaimLease(input: {
        sessionId: string
        runnerId: string
        claimedAt: Date
        claimedUntil: Date
        now: Date
    }): Promise<{ won: boolean; current: Lease }>
    /** Extend the lease iff the caller holds it and it has not expired. */
    renewLease(input: {
        sessionId: string
        runnerId: string
        claimedUntil: Date
        now: Date
    }): Promise<Lease | null>
    /** Release iff the caller holds it; returns true when a row was removed. */
    releaseLease(sessionId: string, runnerId: string): Promise<boolean>
}
