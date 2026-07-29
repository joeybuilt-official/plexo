// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, beforeEach } from 'vitest'
import type { Lease, Runner, Session, SessionEvent, SessionParticipant } from './contract'
import {
    type Clock,
    type IdGen,
    type NewSessionEvent,
    type PresenceInstanceRow,
    type SessionListRow,
    type SessionRepo,
    SeqConflictError,
} from './ports'
import {
    type Deps,
    appendEvent,
    claimLease,
    createSession,
    joinParticipant,
    listMasterSessions,
    listWorkspacePresence,
    PRESENCE_WINDOW_MS,
    registerRunner,
    releaseLease,
    renewLease,
} from './use-cases'

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

    async listWorkspaceInstances(workspaceId: string): Promise<PresenceInstanceRow[]> {
        const out: PresenceInstanceRow[] = []
        for (const r of this.runners.values()) {
            if (r.workspaceId !== workspaceId) continue
            let leaseSessionId: string | null = null
            let leaseUntil: Date | null = null
            for (const l of this.leases.values()) {
                if (l.runnerId !== r.id) continue
                if (leaseUntil === null || l.claimedUntil.getTime() > leaseUntil.getTime()) {
                    leaseUntil = l.claimedUntil
                    leaseSessionId = l.sessionId
                }
            }
            out.push({
                id: r.id,
                kind: 'runner',
                surface: null,
                capabilities: r.capabilities,
                status: r.status,
                role: null,
                lastHeartbeat: r.lastHeartbeat,
                leaseSessionId,
                leaseUntil,
            })
        }
        const heads = new Map<string, PresenceInstanceRow>()
        for (const p of this.participants) {
            if (p.kind !== 'head') continue
            const s = this.sessions.get(p.sessionId)
            if (!s || s.workspaceId !== workspaceId) continue
            const driverSession = p.role === 'driver' ? p.sessionId : null
            const existing = heads.get(p.participantId)
            if (!existing) {
                heads.set(p.participantId, {
                    id: p.participantId,
                    kind: 'head',
                    surface: p.surface,
                    capabilities: p.capabilities,
                    status: null,
                    role: p.role,
                    lastHeartbeat: p.lastHeartbeat,
                    leaseSessionId: driverSession,
                    leaseUntil: null,
                })
            } else {
                if (p.lastHeartbeat.getTime() > existing.lastHeartbeat.getTime()) {
                    existing.lastHeartbeat = p.lastHeartbeat
                    existing.surface = p.surface
                    existing.role = p.role
                }
                if (driverSession) existing.leaseSessionId = driverSession
            }
        }
        for (const row of heads.values()) out.push(row)
        return out
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

// ── Lease invariant ─────────────────────────────────────────────

describe('lease single-writer + expiry', () => {
    let deps: Deps
    let clock: TestClock
    let session: Session

    beforeEach(async () => {
        clock = new TestClock()
        deps = { repo: new InMemoryRepo(), clock, idGen: seqIdGen() }
        session = await seedSession(deps)
    })

    it('first claim wins, second runner is rejected while active', async () => {
        const a = await claimLease(deps, { sessionId: session.id, runnerId: 'runA', ttlMs: 10_000 })
        expect(a.ok).toBe(true)

        const b = await claimLease(deps, { sessionId: session.id, runnerId: 'runB', ttlMs: 10_000 })
        expect(b.ok).toBe(false)
        if (!b.ok) expect(b.error.code).toBe('LEASE_HELD')
    })

    it('expiry frees the lease for another runner to reclaim', async () => {
        await claimLease(deps, { sessionId: session.id, runnerId: 'runA', ttlMs: 10_000 })
        clock.advance(10_001)
        const b = await claimLease(deps, { sessionId: session.id, runnerId: 'runB', ttlMs: 10_000 })
        expect(b.ok).toBe(true)
        if (b.ok) expect(b.value.runnerId).toBe('runB')
    })

    it('only the holder may renew; a stranger gets LEASE_MISMATCH', async () => {
        await claimLease(deps, { sessionId: session.id, runnerId: 'runA', ttlMs: 10_000 })
        const bad = await renewLease(deps, { sessionId: session.id, runnerId: 'runB', ttlMs: 10_000 })
        expect(bad.ok).toBe(false)
        if (!bad.ok) expect(bad.error.code).toBe('LEASE_MISMATCH')

        const good = await renewLease(deps, { sessionId: session.id, runnerId: 'runA', ttlMs: 20_000 })
        expect(good.ok).toBe(true)
    })

    it('release only succeeds for the holder', async () => {
        await claimLease(deps, { sessionId: session.id, runnerId: 'runA', ttlMs: 10_000 })
        const bad = await releaseLease(deps, { sessionId: session.id, runnerId: 'runB' })
        expect(bad.ok).toBe(false)
        const good = await releaseLease(deps, { sessionId: session.id, runnerId: 'runA' })
        expect(good.ok).toBe(true)
    })
})

// ── Append: lease-gated + gap-free seq ──────────────────────────

describe('appendEvent', () => {
    let deps: Deps
    let session: Session

    beforeEach(async () => {
        deps = makeDeps()
        session = await seedSession(deps)
    })

    it('rejects append when no lease is held', async () => {
        const r = await appendEvent(deps, {
            sessionId: session.id, runnerId: 'runA', kind: 'message', actorType: 'runner', payload: {},
        })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.error.code).toBe('NO_LEASE')
    })

    it('rejects append from a runner that does not hold the lease', async () => {
        await claimLease(deps, { sessionId: session.id, runnerId: 'runA', ttlMs: 10_000 })
        const r = await appendEvent(deps, {
            sessionId: session.id, runnerId: 'runB', kind: 'message', actorType: 'runner', payload: {},
        })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.error.code).toBe('LEASE_MISMATCH')
    })

    it('assigns gap-free seq 1..N for the holder', async () => {
        await claimLease(deps, { sessionId: session.id, runnerId: 'runA', ttlMs: 60_000 })
        const seqs: number[] = []
        for (let i = 0; i < 3; i += 1) {
            const r = await appendEvent(deps, {
                sessionId: session.id, runnerId: 'runA', kind: 'message', actorType: 'runner', payload: { i },
            })
            expect(r.ok).toBe(true)
            if (r.ok) seqs.push(r.value.seq)
        }
        expect(seqs).toEqual([1, 2, 3])
    })

    it('retries on a UNIQUE(session,seq) race and still lands gap-free', async () => {
        const base = new InMemoryRepo()
        // A competing writer grabs seq 1 the first time our use-case tries it.
        let injected = false
        const racing: SessionRepo = {
            ...base,
            createSession: base.createSession.bind(base),
            getSession: base.getSession.bind(base),
            listSessions: base.listSessions.bind(base),
            listWorkspaceInstances: base.listWorkspaceInstances.bind(base),
            maxSeq: base.maxSeq.bind(base),
            listEvents: base.listEvents.bind(base),
            upsertParticipant: base.upsertParticipant.bind(base),
            upsertRunner: base.upsertRunner.bind(base),
            getLease: base.getLease.bind(base),
            tryClaimLease: base.tryClaimLease.bind(base),
            renewLease: base.renewLease.bind(base),
            releaseLease: base.releaseLease.bind(base),
            appendEvent: async (event: NewSessionEvent) => {
                if (!injected && event.seq === 1) {
                    injected = true
                    await base.appendEvent({ ...event, actorId: 'other-writer' })
                    throw new SeqConflictError(event.sessionId, event.seq)
                }
                return base.appendEvent(event)
            },
        }
        const rdeps: Deps = { repo: racing, clock: new TestClock(), idGen: seqIdGen() }
        const s = await seedSession(rdeps)
        await claimLease(rdeps, { sessionId: s.id, runnerId: 'runA', ttlMs: 60_000 })
        const r = await appendEvent(rdeps, {
            sessionId: s.id, runnerId: 'runA', kind: 'message', actorType: 'runner', payload: {},
        })
        expect(r.ok).toBe(true)
        if (r.ok) expect(r.value.seq).toBe(2)
    })
})

// ── Master session list shape ───────────────────────────────────

describe('listMasterSessions', () => {
    it('summarises driver, lease/runner status, and participant presence', async () => {
        const repo = new InMemoryRepo()
        const clock = new TestClock()
        const deps: Deps = { repo, clock, idGen: seqIdGen() }
        const session = await seedSession(deps)

        await registerRunner(deps, { id: 'runA', workspaceId: WS, backend: 'agent-sdk' })
        await claimLease(deps, { sessionId: session.id, runnerId: 'runA', ttlMs: 60_000 })

        // one present observer + one stale (>window) steerer
        await joinParticipant(deps, { sessionId: session.id, participantId: 'p1', kind: 'head', role: 'observer' })
        await joinParticipant(deps, { sessionId: session.id, participantId: 'p2', kind: 'head', role: 'steerer' })
        // backdate p2's heartbeat past the presence window
        const stale = repo.participants.find((p) => p.participantId === 'p2')!
        stale.lastHeartbeat = new Date(clock.now().getTime() - 60_000)

        const list = await listMasterSessions(deps, WS)
        expect(list).toHaveLength(1)
        const entry = list[0]!
        expect(entry.session.id).toBe(session.id)
        expect(entry.runnerStatus).toBe('online')
        expect(entry.lease?.active).toBe(true)
        expect(entry.participants.total).toBe(2)
        expect(entry.participants.present).toBe(1)
        expect(entry.participants.byRole.observer).toBe(1)
        expect(entry.participants.byRole.steerer).toBe(1)
    })
})

// ── Workspace presence view ─────────────────────────────────────

describe('workspace presence: liveness window + who-is-driving', () => {
    let deps: Deps
    let repo: InMemoryRepo
    let clock: TestClock

    beforeEach(() => {
        clock = new TestClock()
        repo = new InMemoryRepo()
        deps = { repo, clock, idGen: seqIdGen() }
    })

    async function seedInWorkspace(): Promise<Session> {
        return createSession(deps, { workspaceId: WS, createdBy: USER, title: 'S' })
    }

    it('online runner w/ active lease is alive + drives its leased session; stale runner is not alive; head driver drives its session', async () => {
        const session = await seedInWorkspace()

        // (1) online runner holding an active lease
        await registerRunner(deps, { id: 'r_live', workspaceId: WS, backend: 'generic', status: 'online' })
        const claim = await claimLease(deps, { sessionId: session.id, runnerId: 'r_live', ttlMs: 60_000 })
        expect(claim.ok).toBe(true)

        // (2) stale runner: registered, then heartbeat backdated past the window
        await registerRunner(deps, { id: 'r_stale', workspaceId: WS, backend: 'generic', status: 'online' })
        repo.runners.get('r_stale')!.lastHeartbeat = new Date(clock.now().getTime() - PRESENCE_WINDOW_MS - 1)

        // (3) a head participant driving the session
        await joinParticipant(deps, { sessionId: session.id, participantId: 'h_driver', kind: 'head', role: 'driver' })

        const items = await listWorkspacePresence(deps, WS)
        const live = items.find((i) => i.id === 'r_live')!
        const stale = items.find((i) => i.id === 'r_stale')!
        const head = items.find((i) => i.id === 'h_driver')!

        expect(live.kind).toBe('runner')
        expect(live.alive).toBe(true)
        expect(live.drivingSessionId).toBe(session.id)

        expect(stale.alive).toBe(false)
        expect(stale.drivingSessionId).toBe(null)

        expect(head.kind).toBe('head')
        expect(head.role).toBe('driver')
        expect(head.alive).toBe(true)
        expect(head.drivingSessionId).toBe(session.id)
    })

    it('a stale head with role=driver is not alive and does not claim to drive', async () => {
        const session = await seedInWorkspace()
        await joinParticipant(deps, { sessionId: session.id, participantId: 'h_dead', kind: 'head', role: 'driver' })
        const p = repo.participants.find((x) => x.participantId === 'h_dead')!
        p.lastHeartbeat = new Date(clock.now().getTime() - PRESENCE_WINDOW_MS - 1)

        const head = (await listWorkspacePresence(deps, WS)).find((i) => i.id === 'h_dead')!
        expect(head.alive).toBe(false)
        expect(head.drivingSessionId).toBe(null)
    })

    it('liveness flips exactly at the 30s window boundary', async () => {
        await registerRunner(deps, { id: 'r_edge', workspaceId: WS, backend: 'generic', status: 'online' })
        const runner = repo.runners.get('r_edge')!

        // exactly at the window edge -> still alive (>=)
        runner.lastHeartbeat = new Date(clock.now().getTime() - PRESENCE_WINDOW_MS)
        expect((await listWorkspacePresence(deps, WS))[0]!.alive).toBe(true)

        // one ms older -> stale
        runner.lastHeartbeat = new Date(clock.now().getTime() - PRESENCE_WINDOW_MS - 1)
        expect((await listWorkspacePresence(deps, WS))[0]!.alive).toBe(false)
    })

    it('runner lease that has expired does not count as driving', async () => {
        const session = await seedInWorkspace()
        await registerRunner(deps, { id: 'r_exp', workspaceId: WS, backend: 'generic', status: 'online' })
        await claimLease(deps, { sessionId: session.id, runnerId: 'r_exp', ttlMs: 10_000 })
        clock.advance(20_000) // lease claimedUntil now in the past

        const item = (await listWorkspacePresence(deps, WS)).find((i) => i.id === 'r_exp')!
        expect(item.drivingSessionId).toBe(null)
    })
})
