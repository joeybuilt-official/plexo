// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, beforeEach } from 'vitest'
import type { Lease, Runner, Session, SessionEvent, SessionParticipant } from './contract'
import {
    type Clock,
    type IdGen,
    type NewSessionEvent,
    type SessionListRow,
    type SessionRepo,
    SeqConflictError,
} from './ports'
import { type Deps, claimLease, createSession } from './use-cases'
import type { PolicyRule } from './policy'
import {
    runPlanVerify,
    type RunnerBackend,
    type Step,
    type StepResult,
    type VerifyVerdict,
} from './runner'

// ── In-memory adapter (copied minimally from use-cases.test.ts) ──

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

// ── Fake backend + fixtures ─────────────────────────────────────

function fakeBackend(opts: {
    steps: Step[]
    verdict?: VerifyVerdict
}): RunnerBackend & { executed: string[] } {
    const executed: string[] = []
    return {
        executed,
        async plan() {
            return opts.steps
        },
        async executeStep(step: Step): Promise<StepResult> {
            executed.push(step.id)
            return { stepId: step.id, ok: true, output: `ran ${step.id}` }
        },
        async verify() {
            return opts.verdict ?? { outcomeKind: 'test', reward: 1, rewardSource: 'test@v1', note: 'ok' }
        },
    }
}

const STEPS: Step[] = [
    { id: 's0', description: 'read', tool: 'Read', path: '/a' },
    { id: 's1', description: 'shell', tool: 'Bash', cmd: 'rm -rf /' },
]

const ALLOW_ALL: PolicyRule = { id: 'allow-all', match: {}, decision: 'allow' }

async function claim(deps: Deps, sessionId: string, runnerId: string): Promise<void> {
    const r = await claimLease(deps, { sessionId, runnerId, ttlMs: 60_000 })
    expect(r.ok).toBe(true)
}

// ── Tests ───────────────────────────────────────────────────────

describe('runPlanVerify', () => {
    let deps: Deps & { repo: SessionRepo }
    let repo: InMemoryRepo
    let session: Session

    beforeEach(async () => {
        repo = new InMemoryRepo()
        deps = makeDeps(repo)
        session = await seedSession(deps)
    })

    it('(a) happy path: allow all → plan/tool_call/tool_result…/outcome, gap-free, lease released', async () => {
        const backend = fakeBackend({ steps: STEPS })
        const out = await runPlanVerify(deps, backend, {
            sessionId: session.id, runnerId: 'runA', goal: 'g', tier: 'drive', rules: [ALLOW_ALL],
        })
        expect(out.ok).toBe(true)
        if (!out.ok) return
        expect(out.value.status).toBe('completed')
        expect(out.value.executedStepIds).toEqual(['s0', 's1'])
        expect(out.value.verdict?.reward).toBe(1)
        expect(backend.executed).toEqual(['s0', 's1'])

        const evs = await repo.listEvents(session.id, 0)
        expect(evs.map((e) => e.kind)).toEqual([
            'plan', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'outcome',
        ])
        expect(evs.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6])
        expect(await repo.getLease(session.id)).toBeNull()
    })

    it('(b) deny: a rule denies s1 → status denied, no tool_result for s1, backend not run for it', async () => {
        const rules: PolicyRule[] = [
            { id: 'deny-rm', match: { cmd_pattern: 'rm -rf' }, decision: 'deny', teach: 'no rm' },
            ALLOW_ALL,
        ]
        const backend = fakeBackend({ steps: STEPS })
        const out = await runPlanVerify(deps, backend, {
            sessionId: session.id, runnerId: 'runA', goal: 'g', tier: 'drive', rules,
        })
        expect(out.ok).toBe(true)
        if (!out.ok) return
        expect(out.value.status).toBe('denied')
        expect(out.value.deniedStepId).toBe('s1')
        expect(backend.executed).toEqual(['s0'])

        const evs = await repo.listEvents(session.id, 0)
        expect(evs.some((e) => e.kind === 'status')).toBe(true)
        const s1Results = evs.filter(
            (e) => e.kind === 'tool_result' && (e.payload as { stepId: string }).stepId === 's1',
        )
        expect(s1Results).toHaveLength(0)
        expect(await repo.getLease(session.id)).toBeNull()
    })

    it('(c) gate/insufficient tier: allow@drive under steer gates s0 → paused, held lease, not executed', async () => {
        const rules: PolicyRule[] = [
            { id: 'drive-only', match: { tool: 'Read' }, tier: 'drive', decision: 'allow' },
            ALLOW_ALL,
        ]
        const backend = fakeBackend({ steps: STEPS })
        const out = await runPlanVerify(deps, backend, {
            sessionId: session.id, runnerId: 'runA', goal: 'g', tier: 'steer', rules,
        })
        expect(out.ok).toBe(true)
        if (!out.ok) return
        expect(out.value.status).toBe('paused')
        expect(out.value.pausedOnStepId).toBe('s0')
        expect(backend.executed).toEqual([])

        const evs = await repo.listEvents(session.id, 0)
        expect(evs.some((e) => e.kind === 'approval_request')).toBe(true)
        const lease = await repo.getLease(session.id)
        expect(lease).not.toBeNull()
        expect(lease?.runnerId).toBe('runA')
    })

    it('(d) lease lost: session pre-leased by another runner → NO_LEASE, zero events', async () => {
        await claim(deps, session.id, 'runB')
        const backend = fakeBackend({ steps: STEPS })
        const out = await runPlanVerify(deps, backend, {
            sessionId: session.id, runnerId: 'runA', goal: 'g', tier: 'drive', rules: [ALLOW_ALL],
        })
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.error.code).toBe('NO_LEASE')
        expect(backend.executed).toEqual([])
        expect(await repo.listEvents(session.id, 0)).toHaveLength(0)
    })
})
