// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Session Fabric use-cases (Phase 1b) — pure orchestration over the ports.
 *
 * Framework-free: no Express, no Drizzle, no clock/id of its own. All time
 * comes from `Clock`, all ids from `IdGen`, all persistence from `SessionRepo`.
 * The single-writer lease invariant and gap-free seq assignment live HERE.
 */

import type {
    Lease,
    ParticipantRole,
    Runner,
    Session,
    SessionEvent,
    SessionParticipant,
} from './contract'
import {
    type AppendInput,
    type Clock,
    type CreateSessionInput,
    type IdGen,
    type JoinInput,
    type MasterSessionEntry,
    type NewSessionEvent,
    type RegisterRunnerInput,
    type Result,
    type SessionListRow,
    type SessionRepo,
    err,
    ok,
    SeqConflictError,
} from './ports'

/** A participant is "present" if it beat within this window of `now`. */
export const PRESENCE_WINDOW_MS = 30_000

/** Bounded retries for the gap-free seq race (UNIQUE(session,seq) conflicts). */
const MAX_SEQ_RETRIES = 5

export interface Deps {
    repo: SessionRepo
    clock: Clock
    idGen: IdGen
}

// ── Sessions ────────────────────────────────────────────────────

export async function createSession(deps: Deps, input: CreateSessionInput): Promise<Session> {
    const now = deps.clock.now()
    return deps.repo.createSession({
        id: deps.idGen.next(),
        workspaceId: input.workspaceId,
        title: input.title ?? null,
        status: 'active',
        driverId: null,
        policyTier: input.policyTier ?? 'steer',
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
    })
}

export async function getSession(deps: Deps, id: string): Promise<Session | null> {
    return deps.repo.getSession(id)
}

// ── Master session list ─────────────────────────────────────────

function toEntry(row: SessionListRow, now: Date): MasterSessionEntry {
    const cutoff = now.getTime() - PRESENCE_WINDOW_MS
    const byRole: Record<ParticipantRole, number> = { observer: 0, steerer: 0, driver: 0 }
    let present = 0
    for (const p of row.participants) {
        byRole[p.role] += 1
        if (p.lastHeartbeat.getTime() >= cutoff) present += 1
    }
    const leaseActive = row.lease !== null && row.lease.claimedUntil.getTime() > now.getTime()
    return {
        session: row.session,
        driverId: row.session.driverId,
        lease: row.lease
            ? { runnerId: row.lease.runnerId, claimedUntil: row.lease.claimedUntil, active: leaseActive }
            : null,
        runnerStatus: row.runnerStatus,
        participants: { total: row.participants.length, present, byRole },
    }
}

export async function listMasterSessions(deps: Deps, workspaceId: string): Promise<MasterSessionEntry[]> {
    const rows = await deps.repo.listSessions(workspaceId)
    const now = deps.clock.now()
    return rows.map((r) => toEntry(r, now))
}

// ── Participants + runners ──────────────────────────────────────

export async function joinParticipant(deps: Deps, input: JoinInput): Promise<SessionParticipant> {
    const now = deps.clock.now()
    return deps.repo.upsertParticipant({
        sessionId: input.sessionId,
        participantId: input.participantId,
        kind: input.kind,
        surface: input.surface ?? null,
        capabilities: input.capabilities ?? {},
        role: input.role ?? 'observer',
        lastHeartbeat: now,
        joinedAt: now,
    })
}

export async function registerRunner(deps: Deps, input: RegisterRunnerInput): Promise<Runner> {
    const now = deps.clock.now()
    return deps.repo.upsertRunner({
        id: input.id,
        workspaceId: input.workspaceId ?? null,
        backend: input.backend,
        capabilities: input.capabilities ?? {},
        status: input.status ?? 'online',
        lastHeartbeat: now,
        registeredAt: now,
    })
}

// ── Leases (single-writer invariant) ────────────────────────────

function leaseActive(lease: Lease, now: Date): boolean {
    return lease.claimedUntil.getTime() > now.getTime()
}

export async function claimLease(
    deps: Deps,
    input: { sessionId: string; runnerId: string; ttlMs: number },
): Promise<Result<Lease>> {
    const now = deps.clock.now()
    const { won, current } = await deps.repo.tryClaimLease({
        sessionId: input.sessionId,
        runnerId: input.runnerId,
        claimedAt: now,
        claimedUntil: new Date(now.getTime() + input.ttlMs),
        now,
    })
    if (won) return ok(current)
    return err('LEASE_HELD', `session ${input.sessionId} is leased by runner ${current.runnerId}`)
}

export async function renewLease(
    deps: Deps,
    input: { sessionId: string; runnerId: string; ttlMs: number },
): Promise<Result<Lease>> {
    const now = deps.clock.now()
    const renewed = await deps.repo.renewLease({
        sessionId: input.sessionId,
        runnerId: input.runnerId,
        claimedUntil: new Date(now.getTime() + input.ttlMs),
        now,
    })
    if (renewed) return ok(renewed)
    const current = await deps.repo.getLease(input.sessionId)
    if (!current || !leaseActive(current, now)) {
        return err('NO_LEASE', `session ${input.sessionId} has no active lease to renew`)
    }
    return err('LEASE_MISMATCH', `session ${input.sessionId} is leased by another runner`)
}

export async function releaseLease(
    deps: Deps,
    input: { sessionId: string; runnerId: string },
): Promise<Result<null>> {
    const removed = await deps.repo.releaseLease(input.sessionId, input.runnerId)
    if (removed) return ok(null)
    return err('LEASE_MISMATCH', `session ${input.sessionId} not held by runner ${input.runnerId}`)
}

// ── Append (requires the active lease; gap-free seq) ────────────

/** Enforces the single-writer invariant: only the active lease-holder appends. */
async function assertHoldsLease(deps: Deps, sessionId: string, runnerId: string): Promise<FabricGate> {
    const now = deps.clock.now()
    const lease = await deps.repo.getLease(sessionId)
    if (!lease || !leaseActive(lease, now)) return { ok: false, code: 'NO_LEASE' }
    if (lease.runnerId !== runnerId) return { ok: false, code: 'LEASE_MISMATCH' }
    return { ok: true }
}

type FabricGate = { ok: true } | { ok: false; code: 'NO_LEASE' | 'LEASE_MISMATCH' }

export async function appendEvent(deps: Deps, input: AppendInput): Promise<Result<SessionEvent>> {
    const gate = await assertHoldsLease(deps, input.sessionId, input.runnerId)
    if (!gate.ok) {
        return gate.code === 'NO_LEASE'
            ? err('NO_LEASE', `session ${input.sessionId} has no active lease; append rejected`)
            : err('LEASE_MISMATCH', `runner ${input.runnerId} does not hold the lease for ${input.sessionId}`)
    }

    const now = deps.clock.now()
    const base: Omit<NewSessionEvent, 'seq'> = {
        sessionId: input.sessionId,
        schemaVersion: input.schemaVersion ?? 1,
        kind: input.kind,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        payload: input.payload ?? {},
        model: input.model ?? null,
        provider: input.provider ?? null,
        tokensIn: input.tokensIn ?? null,
        tokensOut: input.tokensOut ?? null,
        costUsd: input.costUsd ?? null,
        outcomeKind: input.outcomeKind ?? null,
        reward: input.reward ?? null,
        reward_source: input.reward_source ?? null,
        provenance: input.provenance ?? null,
        outcomeOfSeq: input.outcomeOfSeq ?? null,
        resolvedAt: input.resolvedAt ?? null,
    }

    for (let attempt = 0; attempt < MAX_SEQ_RETRIES; attempt += 1) {
        const seq = (await deps.repo.maxSeq(input.sessionId)) + 1
        try {
            const saved = await deps.repo.appendEvent({ ...base, seq })
            return ok(saved)
        } catch (e) {
            if (e instanceof SeqConflictError) continue
            throw e
        }
    }
    return err('SEQ_CONFLICT', `could not assign a gap-free seq for ${input.sessionId} after ${MAX_SEQ_RETRIES} tries`)
}

export async function replayEvents(deps: Deps, sessionId: string, sinceSeq: number): Promise<SessionEvent[]> {
    return deps.repo.listEvents(sessionId, sinceSeq)
}
