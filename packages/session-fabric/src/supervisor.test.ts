// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import type { Lease, Runner, Session, SessionEvent, SessionParticipant } from './contract'
import {
    type Clock,
    type IdGen,
    type NewSessionEvent,
    type SessionListRow,
    type SessionRepo,
    SeqConflictError,
} from './ports'
import { type Deps, appendEvent, claimLease, createSession } from './use-cases'
import { overBudget, superviseSession, type SessionBudget } from './supervisor'
import type { UsageSummary } from './usage'

// ── In-memory adapter (no DB) ───────────────────────────────────

class InMemoryRepo implements SessionRepo {
    sessions = new Map<string, Session>()
    events: SessionEvent[] = []
    participants: SessionParticipant[] = []
    runners = new Map<string, Runner>()
    leases = new Map<string, Lease>()
    private eventId = 0

    async createSession(row: Session): Promise<Session> {
        this.sessions.set(row.id, row)
        return row
    }
    async getSession(id: string): Promise<Session | null> {
        return this.sessions.get(id) ?? null
    }
    async listSessions(workspaceId: string): Promise<SessionListRow[]> {
        const out: SessionListRow[] = []
        for (const session of this.sessions.values()) {
            if (session.workspaceId !== workspaceId) continue
            const lease = this.leases.get(session.id) ?? null
            const runnerStatus = lease ? (this.runners.get(lease.runnerId)?.status ?? null) : null
            const participants = this.participants
                .filter((p) => p.sessionId === session.id)
                .map((p) => ({ role: p.role, lastHeartbeat: p.lastHeartbeat }))
            out.push({ session, lease, runnerStatus, participants })
        }
        return out
    }
    async listWorkspaceInstances(): Promise<import('./ports').PresenceInstanceRow[]> {
        return []
    }

    async maxSeq(sessionId: string): Promise<number> {
        let max = 0
        for (const e of this.events) if (e.sessionId === sessionId && e.seq > max) max = e.seq
        return max
    }
    async appendEvent(event: NewSessionEvent): Promise<SessionEvent> {
        if (this.events.some((e) => e.sessionId === event.sessionId && e.seq === event.seq)) {
            throw new SeqConflictError(event.sessionId, event.seq)
        }
        const saved: SessionEvent = { ...event, id: String(++this.eventId), createdAt: new Date() }
        this.events.push(saved)
        return saved
    }
    async listEvents(sessionId: string, sinceSeq: number): Promise<SessionEvent[]> {
        return this.events
            .filter((e) => e.sessionId === sessionId && e.seq >= sinceSeq)
            .sort((a, b) => a.seq - b.seq)
    }

    async upsertParticipant(row: SessionParticipant): Promise<SessionParticipant> {
        const i = this.participants.findIndex(
            (p) => p.sessionId === row.sessionId && p.participantId === row.participantId,
        )
        if (i >= 0) this.participants[i] = row
        else this.participants.push(row)
        return row
    }
    async upsertRunner(row: Runner): Promise<Runner> {
        this.runners.set(row.id, row)
        return row
    }

    async getLease(sessionId: string): Promise<Lease | null> {
        return this.leases.get(sessionId) ?? null
    }
    async tryClaimLease(input: {
        sessionId: string
        runnerId: string
        claimedAt: Date
        claimedUntil: Date
        now: Date
    }): Promise<{ won: boolean; current: Lease }> {
        const cur = this.leases.get(input.sessionId)
        const free = !cur || cur.claimedUntil.getTime() <= input.now.getTime() || cur.runnerId === input.runnerId
        if (free) {
            const lease: Lease = {
                sessionId: input.sessionId,
                runnerId: input.runnerId,
                claimedAt: input.claimedAt,
                claimedUntil: input.claimedUntil,
            }
            this.leases.set(input.sessionId, lease)
            return { won: true, current: lease }
        }
        return { won: false, current: cur as Lease }
    }
    async renewLease(input: {
        sessionId: string
        runnerId: string
        claimedUntil: Date
        now: Date
    }): Promise<Lease | null> {
        const cur = this.leases.get(input.sessionId)
        if (cur && cur.runnerId === input.runnerId && cur.claimedUntil.getTime() > input.now.getTime()) {
            const next: Lease = { ...cur, claimedUntil: input.claimedUntil }
            this.leases.set(input.sessionId, next)
            return next
        }
        return null
    }
    async releaseLease(sessionId: string, runnerId: string): Promise<boolean> {
        const cur = this.leases.get(sessionId)
        if (cur && cur.runnerId === runnerId) {
            this.leases.delete(sessionId)
            return true
        }
        return false
    }
}

// ── Test rig ────────────────────────────────────────────────────

class TestClock implements Clock {
    constructor(public t = Date.parse('2026-07-14T00:00:00Z')) {}
    now(): Date {
        return new Date(this.t)
    }
    advance(ms: number): void {
        this.t += ms
    }
}

function seqIdGen(): IdGen {
    let n = 0
    return { next: () => `id_${++n}` }
}

const WS = '00000000-0000-4000-8000-000000000001'
const USER = '00000000-0000-4000-8000-0000000000aa'

function makeDeps(repo: SessionRepo = new InMemoryRepo()): Deps & { repo: SessionRepo } {
    return { repo, clock: new TestClock(), idGen: seqIdGen() }
}

async function seedSession(deps: Deps): Promise<Session> {
    return createSession(deps, { workspaceId: WS, createdBy: USER, title: 'S' })
}

function usage(over: Partial<UsageSummary>): UsageSummary {
    return { tokensIn: 0, tokensOut: 0, costUsd: 0, eventCount: 0, byModel: [], ...over }
}

// ── overBudget (pure) ───────────────────────────────────────────

describe('overBudget', () => {
    it('over on cost', () => {
        expect(overBudget(usage({ costUsd: 1.5 }), { maxCostUsd: 1 }).over).toBe(true)
    })
    it('over on tokens', () => {
        expect(overBudget(usage({ tokensIn: 700, tokensOut: 500 }), { maxTokens: 1000 }).over).toBe(true)
    })
    it('under both limits', () => {
        expect(overBudget(usage({ costUsd: 0.5, tokensIn: 100, tokensOut: 100 }), { maxCostUsd: 1, maxTokens: 1000 }).over).toBe(false)
    })
    it('neither limit set', () => {
        expect(overBudget(usage({ costUsd: 999, tokensIn: 999999, tokensOut: 999999 }), {})).toEqual({ over: false })
    })
})

// ── superviseSession ────────────────────────────────────────────

describe('superviseSession', () => {
    it('halts an over-budget runaway and reclaims its lease', async () => {
        const deps = makeDeps()
        const session = await seedSession(deps)
        await claimLease(deps, { sessionId: session.id, runnerId: 'runA', ttlMs: 300_000 })
        await appendEvent(deps, {
            sessionId: session.id, runnerId: 'runA', kind: 'usage', actorType: 'runner', payload: {},
            model: 'm', provider: 'p', tokensIn: 500, tokensOut: 500, costUsd: 2,
        })

        const result = await superviseSession(deps, { sessionId: session.id, budget: { maxCostUsd: 1 } })
        expect(result.action).toBe('halted')
        expect(result.reason).toBeTruthy()
        expect(await deps.repo.getLease(session.id)).toBeNull()
    })

    it('leaves an under-budget session running with its lease intact', async () => {
        const deps = makeDeps()
        const session = await seedSession(deps)
        await claimLease(deps, { sessionId: session.id, runnerId: 'runA', ttlMs: 300_000 })
        await appendEvent(deps, {
            sessionId: session.id, runnerId: 'runA', kind: 'usage', actorType: 'runner', payload: {},
            model: 'm', provider: 'p', tokensIn: 10, tokensOut: 10, costUsd: 0.1,
        })

        const result = await superviseSession(deps, { sessionId: session.id, budget: { maxCostUsd: 5 } })
        expect(result.action).toBe('ok')
        const lease = await deps.repo.getLease(session.id)
        expect(lease?.runnerId).toBe('runA')
    })

    it('returns none when the session has no active lease', async () => {
        const deps = makeDeps()
        const session = await seedSession(deps)
        const result = await superviseSession(deps, { sessionId: session.id, budget: { maxCostUsd: 1 } })
        expect(result.action).toBe('none')
        expect(await deps.repo.getLease(session.id)).toBeNull()
    })
})
