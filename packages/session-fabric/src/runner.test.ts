// SPDX-License-Identifier: MIT
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
    resumeRun,
    type RunnerBackend,
    type Step,
    type StepResult,
    type VerifyVerdict,
} from './runner'
import { REFUSE_MESSAGE } from './agent-backend'

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
    refuse?: boolean
}): RunnerBackend & { executed: string[]; verifiedWith: StepResult[] } {
    const executed: string[] = []
    const state = { verifiedWith: [] as StepResult[] }
    return {
        executed,
        get verifiedWith() {
            return state.verifiedWith
        },
        async plan() {
            return opts.steps
        },
        async executeStep(step: Step): Promise<StepResult> {
            executed.push(step.id)
            return opts.refuse
                ? { stepId: step.id, ok: false, output: REFUSE_MESSAGE }
                : { stepId: step.id, ok: true, output: `ran ${step.id}` }
        },
        async verify(_steps: Step[], results: StepResult[]) {
            state.verifiedWith = results
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

    it('(e) slow model calls that outlast the TTL still complete — lease re-claimed', async () => {
        const clock = deps.clock as TestClock
        const executed: string[] = []
        const slow: RunnerBackend = {
            async plan() { clock.advance(130_000); return STEPS }, // > 120s TTL
            async executeStep(step) { executed.push(step.id); return { stepId: step.id, ok: true } },
            async verify() { clock.advance(130_000); return { outcomeKind: 'test', reward: 1, rewardSource: 't@v1' } },
        }
        const out = await runPlanVerify(deps, slow, {
            sessionId: session.id, runnerId: 'runA', goal: 'g', tier: 'drive', rules: [ALLOW_ALL],
        })
        expect(out.ok).toBe(true)
        if (!out.ok) return
        expect(out.value.status).toBe('completed') // outcome persisted despite ~260s of model latency
        expect(executed).toEqual(['s0', 's1'])
        const evs = await repo.listEvents(session.id, 0)
        expect(evs.map((e) => e.kind)).toContain('outcome')
        expect(await repo.getLease(session.id)).toBeNull() // released on completion
    })

    it('(f) lease stolen by another runner during planning → NO_LEASE', async () => {
        const clock = deps.clock as TestClock
        const backend: RunnerBackend = {
            async plan() { clock.advance(130_000); await claim(deps, session.id, 'runB'); return STEPS },
            async executeStep(step) { return { stepId: step.id, ok: true } },
            async verify() { return { outcomeKind: 'test', reward: 1, rewardSource: 't@v1' } },
        }
        const out = await runPlanVerify(deps, backend, {
            sessionId: session.id, runnerId: 'runA', goal: 'g', tier: 'drive', rules: [ALLOW_ALL],
        })
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.error.code).toBe('NO_LEASE')
        expect(await repo.listEvents(session.id, 0)).toHaveLength(0) // nothing persisted after the steal
    })

    // ── B15: re-dispatch once on a throwing backend ──────────────

    it('(g) executeStep throws once → re-dispatched once, run completes, one tool_call/tool_result pair', async () => {
        let throws = 1
        const executed: string[] = []
        const backend: RunnerBackend = {
            async plan() { return STEPS },
            async executeStep(step) {
                executed.push(step.id)
                if (step.id === 's0' && throws > 0) { throws -= 1; throw new Error('transient dispatch failure') }
                return { stepId: step.id, ok: true, output: `ran ${step.id}` }
            },
            async verify() { return { outcomeKind: 'test', reward: 1, rewardSource: 't@v1' } },
        }

        const out = await runPlanVerify(deps, backend, {
            sessionId: session.id, runnerId: 'runA', goal: 'g', tier: 'drive', rules: [ALLOW_ALL],
        })
        expect(out.ok).toBe(true)
        if (!out.ok) return
        expect(out.value.status).toBe('completed')
        expect(out.value.executedStepIds).toEqual(['s0', 's1'])
        // s0 was dispatched twice; the log still shows it exactly once.
        expect(executed).toEqual(['s0', 's0', 's1'])

        const evs = await repo.listEvents(session.id, 0)
        expect(evs.map((e) => e.kind)).toEqual([
            'plan', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'outcome',
        ])
        expect(evs.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6])

        const s0Result = evs[2]!.payload as { stepId: string; ok: boolean; attempts?: number }
        expect(s0Result).toMatchObject({ stepId: 's0', ok: true, attempts: 2 })
        // The healthy step carries no retry metadata at all.
        expect(evs[4]!.payload).not.toHaveProperty('attempts')
        expect(await repo.getLease(session.id)).toBeNull()
    })

    it('(h) executeStep throws on both attempts → failed step result, run completes, lease released', async () => {
        const executed: string[] = []
        let verifiedWith: StepResult[] = []
        const backend: RunnerBackend = {
            async plan() { return STEPS },
            async executeStep(step) {
                executed.push(step.id)
                if (step.id === 's0') throw new Error('backend is down')
                return { stepId: step.id, ok: true, output: `ran ${step.id}` }
            },
            async verify(_steps, results) {
                verifiedWith = results
                return { outcomeKind: 'test', reward: 0, rewardSource: 't@v1' }
            },
        }

        const out = await runPlanVerify(deps, backend, {
            sessionId: session.id, runnerId: 'runA', goal: 'g', tier: 'drive', rules: [ALLOW_ALL],
        })
        // The throw does NOT escape and does NOT kill the session.
        expect(out.ok).toBe(true)
        if (!out.ok) return
        expect(out.value.status).toBe('completed')
        expect(executed).toEqual(['s0', 's0', 's1']) // exactly two attempts, no more
        expect(out.value.verdict?.reward).toBe(0)

        // verify() sees the failure rather than a silently-missing step.
        expect(verifiedWith[0]).toMatchObject({ stepId: 's0', ok: false })
        expect(verifiedWith[0]?.output).toContain('backend is down')

        const evs = await repo.listEvents(session.id, 0)
        expect(evs.map((e) => e.kind)).toEqual([
            'plan', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'outcome',
        ])
        const s0Result = evs[2]!.payload as { ok: boolean; attempts?: number; error?: string }
        expect(s0Result).toMatchObject({ ok: false, attempts: 2, error: 'backend is down' })
        expect(await repo.getLease(session.id)).toBeNull()
    })

    it('(i) plan() throws → lease released before the error propagates', async () => {
        const backend: RunnerBackend = {
            async plan() { throw new Error('planner exploded') },
            async executeStep(step) { return { stepId: step.id, ok: true } },
            async verify() { return { outcomeKind: 'test', reward: 1, rewardSource: 't@v1' } },
        }
        await expect(runPlanVerify(deps, backend, {
            sessionId: session.id, runnerId: 'runA', goal: 'g', tier: 'drive', rules: [ALLOW_ALL],
        })).rejects.toThrow('planner exploded')
        // Without the guard the session stays leased until the 120s TTL expires.
        expect(await repo.getLease(session.id)).toBeNull()
        expect(await repo.listEvents(session.id, 0)).toHaveLength(0)
    })

    it('(j) verify() throws → lease released before the error propagates', async () => {
        const backend: RunnerBackend = {
            async plan() { return STEPS },
            async executeStep(step) { return { stepId: step.id, ok: true } },
            async verify() { throw new Error('verifier exploded') },
        }
        await expect(runPlanVerify(deps, backend, {
            sessionId: session.id, runnerId: 'runA', goal: 'g', tier: 'drive', rules: [ALLOW_ALL],
        })).rejects.toThrow('verifier exploded')
        expect(await repo.getLease(session.id)).toBeNull()
        // Every step is still recorded — only the outcome is missing.
        const evs = await repo.listEvents(session.id, 0)
        expect(evs.map((e) => e.kind)).toEqual([
            'plan', 'tool_call', 'tool_result', 'tool_call', 'tool_result',
        ])
    })
})

// ── resumeRun (approval resume) ─────────────────────────────────

// Gates the Read step (s0) when the actor is below drive → drive/resume pauses on it.
const GATE_READ: PolicyRule = { id: 'drive-only-read', match: { tool: 'Read' }, tier: 'drive', decision: 'allow' }
const GATE_BASH: PolicyRule = { id: 'drive-only-bash', match: { tool: 'Bash' }, tier: 'drive', decision: 'allow' }

const STEPS3: Step[] = [
    { id: 's0', description: 'read', tool: 'Read', path: '/a' },
    { id: 's1', description: 'shell', tool: 'Bash', cmd: 'echo hi' },
    { id: 's2', description: 'write', tool: 'Write', path: '/b' },
]

function decisionsFor(events: SessionEvent[], stepId: string): SessionEvent[] {
    return events.filter(
        (e) => e.kind === 'approval_decision' && (e.payload as { stepId: string }).stepId === stepId,
    )
}

describe('resumeRun', () => {
    let deps: Deps & { repo: SessionRepo }
    let repo: InMemoryRepo
    let session: Session

    beforeEach(async () => {
        repo = new InMemoryRepo()
        deps = makeDeps(repo)
        session = await seedSession(deps)
    })

    async function driveToPause(runnerId = 'runA'): Promise<ReturnType<typeof fakeBackend>> {
        const backend = fakeBackend({ steps: STEPS, refuse: true })
        const out = await runPlanVerify(deps, backend, {
            sessionId: session.id, runnerId, goal: 'g', tier: 'steer', rules: [GATE_READ, ALLOW_ALL],
        })
        expect(out.ok).toBe(true)
        if (out.ok) expect(out.value.status).toBe('paused')
        return backend
    }

    it('(a) a gate rule pauses the run → paused, lease held, approval_request emitted', async () => {
        await driveToPause('runA')
        const evs = await repo.listEvents(session.id, 0)
        expect(evs.some((e) => e.kind === 'approval_request')).toBe(true)
        const lease = await repo.getLease(session.id)
        expect(lease?.runnerId).toBe('runA')
    })

    it('(b) resume approve → executes the gated step (RefuseToolExecutor semantics) and completes', async () => {
        const backend = await driveToPause('runA')
        const out = await resumeRun(deps, backend, {
            sessionId: session.id, runnerId: 'runA', tier: 'steer', rules: [GATE_READ, ALLOW_ALL],
            stepId: 's0', decision: 'approve',
        })
        expect(out.ok).toBe(true)
        if (!out.ok) return
        expect(out.value.status).toBe('completed')
        expect(backend.executed).toEqual(['s0', 's1'])

        const evs = await repo.listEvents(session.id, 0)
        const s0Result = evs.find(
            (e) => e.kind === 'tool_result' && (e.payload as { stepId: string }).stepId === 's0',
        )
        expect((s0Result?.payload as { ok: boolean; output?: string }).ok).toBe(false)
        expect((s0Result?.payload as { output?: string }).output).toBe(REFUSE_MESSAGE)
        expect(evs.some((e) => e.kind === 'outcome')).toBe(true)
        expect(await repo.getLease(session.id)).toBeNull()
    })

    it('(c) resume deny → status denied, lease released, gated step not executed', async () => {
        const backend = await driveToPause('runA')
        const out = await resumeRun(deps, backend, {
            sessionId: session.id, runnerId: 'runA', tier: 'steer', rules: [GATE_READ, ALLOW_ALL],
            stepId: 's0', decision: 'deny',
        })
        expect(out.ok).toBe(true)
        if (!out.ok) return
        expect(out.value.status).toBe('denied')
        expect(out.value.deniedStepId).toBe('s0')
        expect(backend.executed).toEqual([])
        expect(await repo.getLease(session.id)).toBeNull()
    })

    it('(d) resume reconstructs steps + priorResults from the event log', async () => {
        const backend = fakeBackend({ steps: STEPS3, refuse: true })
        const drove = await runPlanVerify(deps, backend, {
            sessionId: session.id, runnerId: 'runA', goal: 'g', tier: 'steer', rules: [GATE_BASH, ALLOW_ALL],
        })
        expect(drove.ok).toBe(true)
        if (drove.ok) expect(drove.value.pausedOnStepId).toBe('s1')
        expect(backend.executed).toEqual(['s0']) // s0 ran before the s1 gate paused it

        const out = await resumeRun(deps, backend, {
            sessionId: session.id, runnerId: 'runA', tier: 'steer', rules: [GATE_BASH, ALLOW_ALL],
            stepId: 's1', decision: 'approve',
        })
        expect(out.ok).toBe(true)
        if (!out.ok) return
        expect(out.value.status).toBe('completed')
        // verify saw the pre-pause s0 result carried forward, plus s1 + s2
        expect(backend.verifiedWith.map((r) => r.stepId)).toEqual(['s0', 's1', 's2'])
        expect(backend.verifiedWith.find((r) => r.stepId === 's0')?.output).toBe(REFUSE_MESSAGE)
    })

    it('(e) resume by a non-lease-holder runner → NO_LEASE', async () => {
        const backend = await driveToPause('runA')
        const out = await resumeRun(deps, backend, {
            sessionId: session.id, runnerId: 'runB', tier: 'steer', rules: [GATE_READ, ALLOW_ALL],
            stepId: 's0', decision: 'approve',
        })
        expect(out.ok).toBe(false)
        if (out.ok) return
        expect(out.error.code).toBe('NO_LEASE')
    })

    it('(f) idempotency: a second approve for the same step is a no-op', async () => {
        const backend = await driveToPause('runA')
        const first = await resumeRun(deps, backend, {
            sessionId: session.id, runnerId: 'runA', tier: 'steer', rules: [GATE_READ, ALLOW_ALL],
            stepId: 's0', decision: 'approve',
        })
        expect(first.ok).toBe(true)
        const executedAfterFirst = [...backend.executed]

        const second = await resumeRun(deps, backend, {
            sessionId: session.id, runnerId: 'runA', tier: 'steer', rules: [GATE_READ, ALLOW_ALL],
            stepId: 's0', decision: 'approve',
        })
        expect(second.ok).toBe(true)
        if (second.ok) expect(second.value.status).toBe('completed')
        expect(backend.executed).toEqual(executedAfterFirst) // no double execution

        const evs = await repo.listEvents(session.id, 0)
        expect(decisionsFor(evs, 's0')).toHaveLength(1) // no duplicate approval_decision
    })

    it('(g) decision for a step that is not the pending approval → rejected, no decision recorded', async () => {
        const backend = await driveToPause('runA') // paused on s0
        const out = await resumeRun(deps, backend, {
            sessionId: session.id, runnerId: 'runA', tier: 'steer', rules: [GATE_READ, ALLOW_ALL],
            stepId: 's1', decision: 'approve', // s1 is not the gated step
        })
        expect(out.ok).toBe(false)
        expect(backend.executed).toEqual([])
        const evs = await repo.listEvents(session.id, 0)
        expect(evs.some((e) => e.kind === 'approval_decision')).toBe(false)
        expect((await repo.getLease(session.id))?.runnerId).toBe('runA') // lease untouched
    })
})
