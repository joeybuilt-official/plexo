// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Orchestrator fan-out — unit + integration tests
 *
 * Tests:
 *   1. Gate: FANOUT_ENABLED=false (env not set) → spawnFanout skipped
 *   2. resolveChildConnectors: full scope rule coverage (pure)
 *   3. Depth cap constants
 *   4. Depth cap — live dispatch (FANOUT_ENABLED=true via env):
 *      a. fanoutDepth=1 → skipped:true, ZERO pushes, ZERO DB updates (grandchild blocked)
 *      b. fanoutDepth=0 → children spawned normally
 *   5. Integration run: spawn (depth=0, 2 children) → grandchild blocked → join aggregates
 *   6. Join all-success / one-failed (pure math)
 *   7. Connector scope security boundary (pure)
 *
 * DB and queue are fully stubbed. No network calls.
 * FANOUT_ENABLED reads from process.env.FANOUT_ENABLED at module load, so
 * vi.resetModules() + setting the env var before dynamic import controls the flag.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_FANOUT_CHILDREN, MAX_FANOUT_DEPTH, resolveChildConnectors, type ChildOutcome } from '../fanout.js'

// ── Test constants ────────────────────────────────────────────────────────────

const PARENT_ID   = 'task_parent_0001'
const CHILD_ID_1  = 'task_child_0001'
const CHILD_ID_2  = 'task_child_0002'
const WORKSPACE   = '11111111-0000-0000-0000-000000000001'
const CONNECTOR_A = 'conn-aaaa-0001'
const CONNECTOR_B = 'conn-bbbb-0002'

// ── DB stub ───────────────────────────────────────────────────────────────────

type DBState = {
    parent: {
        id: string
        workspaceId: string
        source: string
        context: Record<string, unknown>
        costCeilingUsd: number | null
        fanoutDepth: number
    } | null
    children: Array<{
        id: string
        status: string
        outcomeSummary: string | null
        failureReason: string | null
        tokensIn: number
        tokensOut: number
        costUsd: number
        parentId: string
    }>
    updatedContext: Record<string, unknown> | null
    updates: Array<Record<string, unknown>>   // all db.update().set() calls
    pushedChildren: Array<Record<string, unknown>>
}

let _state: DBState

function resetState(overrides: Partial<DBState> = {}) {
    _state = {
        parent: {
            id: PARENT_ID,
            workspaceId: WORKSPACE,
            source: 'cron',
            context: { connectorIds: [CONNECTOR_A] },
            costCeilingUsd: 2.00,
            fanoutDepth: 0,
        },
        children: [],
        updatedContext: null,
        updates: [],
        pushedChildren: [],
        ...overrides,
    }
}

vi.mock('@plexo/db', () => {
    const mockEq = vi.fn((col: unknown, val: unknown) => ({ col, val }))
    const makeTasks = () => ({
        id: 'id', workspaceId: 'workspaceId', source: 'source',
        context: 'context', costCeilingUsd: 'costCeilingUsd',
        outcomeSummary: 'outcomeSummary', failureReason: 'failureReason',
        tokensIn: 'tokensIn', tokensOut: 'tokensOut', costUsd: 'costUsd',
        status: 'status', parentId: 'parentId',
        fanoutDepth: 'fanoutDepth', fanoutTotal: 'fanoutTotal',
    })

    return {
        db: {
            select: vi.fn(() => ({
                from: vi.fn(() => ({
                    where: vi.fn((condition: { col: unknown }) => {
                        // Distinguish children query (parentId col) from parent lookup (id col)
                        const isChildrenQuery = condition && (condition as { col: unknown }).col === 'parentId'
                        const rows = isChildrenQuery
                            ? _state.children
                            : (_state.parent ? [_state.parent] : [])
                        return {
                            limit: vi.fn(async (n: number) => rows.slice(0, n)),
                            // Thenable: supports direct await (checkFanoutJoin children query)
                            then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
                                Promise.resolve(rows).then(resolve, reject),
                            catch: (handler: (e: unknown) => unknown) =>
                                Promise.resolve(rows).catch(handler),
                        }
                    }),
                })),
            })),
            update: vi.fn(() => ({
                set: vi.fn((ctx: Record<string, unknown>) => {
                    _state.updates.push(ctx)
                    _state.updatedContext = ctx
                    return { where: vi.fn(async () => {}) }
                }),
            })),
        },
        eq: mockEq,
        tasks: makeTasks(),
    }
})

vi.mock('@plexo/queue', () => ({
    push: vi.fn(async (params: Record<string, unknown>) => {
        _state.pushedChildren.push(params)
        return _state.pushedChildren.length === 1 ? CHILD_ID_1 : CHILD_ID_2
    }),
}))

// ── Tests: FANOUT_ENABLED kill-switch (env=false) ────────────────────────────
// FANOUT_ENABLED is true by default; these tests simulate the emergency kill-switch.

describe('fanout — FANOUT_ENABLED kill-switch (FANOUT_ENABLED=false env)', () => {
    beforeEach(() => {
        process.env.FANOUT_ENABLED = 'false'
        vi.resetModules()
        resetState()
    })
    afterEach(() => { delete process.env.FANOUT_ENABLED })

    it('spawnFanout returns skipped when FANOUT_ENABLED=false', async () => {
        const { spawnFanout } = await import('../fanout.js')
        const result = await spawnFanout({
            parentTaskId: PARENT_ID,
            children: [{ userMessage: 'do thing A' }],
        })
        expect(result.skipped).toBe(true)
        expect(result.skipReason).toBe('FANOUT_ENABLED=false')
        expect(result.childTaskIds).toBeUndefined()
    })

    it('checkFanoutJoin returns ready=false when FANOUT_ENABLED=false', async () => {
        const { checkFanoutJoin } = await import('../fanout.js')
        const result = await checkFanoutJoin(PARENT_ID)
        expect(result.ready).toBe(false)
        expect(result.nTotal).toBe(0)
    })
})

// ── Tests: resolveChildConnectors (pure — no mocks needed) ───────────────────

describe('resolveChildConnectors', () => {
    it('child inherits parent scope when child is undefined', () => {
        expect(resolveChildConnectors([CONNECTOR_A], undefined)).toEqual([CONNECTOR_A])
    })

    it('child deny-all ([]) is always valid regardless of parent scope', () => {
        expect(resolveChildConnectors([CONNECTOR_A, CONNECTOR_B], [])).toEqual([])
        expect(resolveChildConnectors(undefined, [])).toEqual([])
    })

    it('parent allow-all (undefined): child can request any connectors', () => {
        expect(resolveChildConnectors(undefined, [CONNECTOR_A])).toEqual([CONNECTOR_A])
    })

    it('parent allow-all (undefined): child inherits allow-all when also undefined', () => {
        expect(resolveChildConnectors(undefined, undefined)).toBeUndefined()
    })

    it('parent deny-all ([]): child must be deny-all or undefined — passes', () => {
        expect(resolveChildConnectors([], [])).toEqual([])
        expect(resolveChildConnectors([], undefined)).toEqual([])
    })

    it('parent deny-all ([]): child requesting connectors = scope_violation', () => {
        expect(resolveChildConnectors([], [CONNECTOR_A])).toBe('scope_violation')
    })

    it('child subset of parent → allowed, returns child list', () => {
        expect(resolveChildConnectors([CONNECTOR_A, CONNECTOR_B], [CONNECTOR_A])).toEqual([CONNECTOR_A])
    })

    it('child requests connector not in parent → scope_violation', () => {
        const ROGUE = 'conn-rogue-9999'
        expect(resolveChildConnectors([CONNECTOR_A], [ROGUE])).toBe('scope_violation')
        expect(resolveChildConnectors([CONNECTOR_A], [CONNECTOR_A, ROGUE])).toBe('scope_violation')
    })
})

// ── Tests: depth cap constants ────────────────────────────────────────────────

describe('fanout — depth cap constants', () => {
    it('MAX_FANOUT_DEPTH is 1 (no grandchildren by design)', () => {
        expect(MAX_FANOUT_DEPTH).toBe(1)
    })

    it('MAX_FANOUT_CHILDREN is bounded (≤ 20)', () => {
        expect(MAX_FANOUT_CHILDREN).toBeLessThanOrEqual(20)
        expect(MAX_FANOUT_CHILDREN).toBeGreaterThan(0)
    })
})

// ── Tests: depth cap — live dispatch (FANOUT_ENABLED=true) ───────────────────
//
// These tests exercise the actual spawnFanout dispatch path by setting
// process.env.FANOUT_ENABLED='true' before vi.resetModules() forces a fresh
// module evaluation. Both assertions are required for the fork-bomb guard proof.

describe('fanout — depth cap (FANOUT_ENABLED=true, live dispatch)', () => {
    beforeEach(() => {
        vi.resetModules()
        resetState()
    })

    it('task at fanoutDepth=1 → skipped:true, ZERO rows written (grandchild blocked)', async () => {
        resetState({
            parent: {
                id: PARENT_ID,
                workspaceId: WORKSPACE,
                source: 'cron',
                context: { connectorIds: [CONNECTOR_A] },
                costCeilingUsd: null,
                fanoutDepth: MAX_FANOUT_DEPTH,  // 1 — at cap, must be blocked
            },
        })
        const { spawnFanout } = await import('../fanout.js')

        const result = await spawnFanout({
            parentTaskId: PARENT_ID,
            children: [{ userMessage: 'grandchild — must not spawn' }],
        })

        // ASSERTION 1: returns skipped with depth reason
        expect(result.skipped).toBe(true)
        expect(result.skipReason).toContain('depth_cap_exceeded')
        expect(result.skipReason).toContain('parent depth=1')

        // ASSERTION 2: absolutely zero rows written — no queue push, no DB update
        expect(_state.pushedChildren).toHaveLength(0)
        expect(_state.updates).toHaveLength(0)
    })

    it('task at fanoutDepth=0 → children spawned normally', async () => {
        // Default state has fanoutDepth=0
        const { spawnFanout } = await import('../fanout.js')

        const result = await spawnFanout({
            parentTaskId: PARENT_ID,
            children: [{ userMessage: 'child A' }],
        })

        expect(result.skipped).toBe(false)
        expect(result.childTaskIds).toHaveLength(1)
        expect(result.childCount).toBe(1)
        expect(_state.pushedChildren).toHaveLength(1)
        expect(_state.pushedChildren[0]?.parentId).toBe(PARENT_ID)
    })
})

// ── Tests: integration run ────────────────────────────────────────────────────
//
// Phase 3 observed run: parent (depth=0) spawns 2 children, grandchild is blocked,
// children complete, join aggregates. Covers the full path end-to-end with stubs.

describe('fanout — integration run (FANOUT_ENABLED=true, 2 children, depth=0)', () => {
    beforeEach(() => {
        vi.resetModules()
        resetState({
            parent: {
                id: PARENT_ID,
                workspaceId: WORKSPACE,
                source: 'cron',
                context: { connectorIds: [CONNECTOR_A] },
                costCeilingUsd: 1.00,
                fanoutDepth: 0,
            },
        })
    })

    it('spawn 2 children; connector scope ⊆ parent; cost ceiling ÷ N; grandchild blocked; join aggregates', async () => {
        const { spawnFanout, checkFanoutJoin } = await import('../fanout.js')

        // ── Step 1: parent (depth=0) spawns 2 children ─────────────────────────
        const spawnResult = await spawnFanout({
            parentTaskId: PARENT_ID,
            children: [
                { userMessage: 'child A — check repo A', connectorIds: [CONNECTOR_A] },
                { userMessage: 'child B — check repo B', connectorIds: [CONNECTOR_A] },
            ],
        })

        expect(spawnResult.skipped).toBe(false)
        expect(spawnResult.childTaskIds).toHaveLength(2)
        expect(spawnResult.childCount).toBe(2)

        // Connector scope ⊆ parent [CONNECTOR_A]
        for (const child of _state.pushedChildren) {
            expect((child.context as Record<string, unknown>).connectorIds).toEqual([CONNECTOR_A])
            expect(child.parentId).toBe(PARENT_ID)
        }

        // Per-child cost ceiling: 1.00 / 2 = 0.50 ≥ MIN_CHILD_CEILING ($0.10)
        expect(_state.pushedChildren[0]?.costCeilingUsd as number).toBeCloseTo(0.50)
        expect(_state.pushedChildren[1]?.costCeilingUsd as number).toBeCloseTo(0.50)

        // fanoutTotal column written to parent
        const parentUpdate = _state.updates.find((u) => 'fanoutTotal' in u)
        expect(parentUpdate).toMatchObject({ fanoutTotal: 2 })

        // fanoutDepth column set to 1 for each child (2 updates)
        const depthUpdates = _state.updates.filter((u) => 'fanoutDepth' in u)
        expect(depthUpdates).toHaveLength(2)
        expect(depthUpdates.every((u) => u.fanoutDepth === 1)).toBe(true)

        // ── Step 2: child (fanoutDepth=1) tries to fan-out → blocked ───────────
        resetState({
            parent: {
                id: CHILD_ID_1,
                workspaceId: WORKSPACE,
                source: 'cron',
                context: { connectorIds: [CONNECTOR_A] },
                costCeilingUsd: null,
                fanoutDepth: 1,  // child is at MAX_FANOUT_DEPTH — no grandchildren
            },
        })

        const grandchildResult = await spawnFanout({
            parentTaskId: CHILD_ID_1,
            children: [{ userMessage: 'grandchild — must not spawn' }],
        })

        expect(grandchildResult.skipped).toBe(true)
        expect(grandchildResult.skipReason).toContain('depth_cap_exceeded')
        expect(_state.pushedChildren).toHaveLength(0)  // zero new pushes after state reset

        // ── Step 3: set both children terminal → join aggregates ────────────────
        _state.children = [
            {
                id: CHILD_ID_1, status: 'complete',
                outcomeSummary: 'Checked 3 PRs', failureReason: null,
                tokensIn: 100, tokensOut: 200, costUsd: 0.01, parentId: PARENT_ID,
            },
            {
                id: CHILD_ID_2, status: 'complete',
                outcomeSummary: 'No issues found', failureReason: null,
                tokensIn: 80, tokensOut: 150, costUsd: 0.008, parentId: PARENT_ID,
            },
        ]

        const joinResult = await checkFanoutJoin(PARENT_ID)

        expect(joinResult.ready).toBe(true)
        expect(joinResult.nTotal).toBe(2)
        expect(joinResult.nComplete).toBe(2)
        expect(joinResult.nFailed).toBe(0)
        expect(joinResult.nCancelled).toBe(0)
        expect(joinResult.totalCostUsd).toBeCloseTo(0.018)
        expect(joinResult.aggregateSummary).toContain('2/2 subtasks succeeded')
        expect(joinResult.aggregateSummary).toContain('Checked 3 PRs')
    })
})

// ── Tests: join all-success ────────────────────────────────────────────────────

describe('fanout join — all-success', () => {
    it('aggregates correctly when all children complete', () => {
        const children: ChildOutcome[] = [
            { taskId: CHILD_ID_1, status: 'complete', outcomeSummary: 'Checked 3 PRs', failureReason: null, tokensIn: 100, tokensOut: 200, costUsd: 0.01 },
            { taskId: CHILD_ID_2, status: 'complete', outcomeSummary: 'No issues found', failureReason: null, tokensIn: 80,  tokensOut: 150, costUsd: 0.008 },
        ]
        const nComplete  = children.filter(c => c.status === 'complete').length
        const nFailed    = children.filter(c => c.status === 'failed').length
        const nCancelled = children.filter(c => c.status === 'cancelled').length
        const totalCost  = children.reduce((s, c) => s + c.costUsd, 0)

        expect(nComplete).toBe(2)
        expect(nFailed).toBe(0)
        expect(nCancelled).toBe(0)
        expect(totalCost).toBeCloseTo(0.018)

        const summary = `Fan-out complete: ${nComplete}/${children.length} subtasks succeeded.`
        expect(summary).toContain('2/2')
    })
})

// ── Tests: join one-failed (proceed_with_successes) ───────────────────────────

describe('fanout join — one-failed (proceed_with_successes)', () => {
    it('join is still ready when one child failed — failure appears in digest', () => {
        const children: ChildOutcome[] = [
            { taskId: CHILD_ID_1, status: 'complete', outcomeSummary: 'Checked PRs', failureReason: null, tokensIn: 100, tokensOut: 200, costUsd: 0.01 },
            { taskId: CHILD_ID_2, status: 'failed',   outcomeSummary: null, failureReason: 'no_credential', tokensIn: 0,   tokensOut: 0,   costUsd: 0 },
        ]
        const TERMINAL = new Set(['complete', 'failed', 'cancelled'])
        const allTerminal = children.every(c => TERMINAL.has(c.status))
        expect(allTerminal).toBe(true)

        const nComplete = children.filter(c => c.status === 'complete').length
        const nFailed   = children.filter(c => c.status === 'failed').length
        expect(nComplete).toBe(1)
        expect(nFailed).toBe(1)

        const failureLines = children
            .filter(c => c.status !== 'complete')
            .map(c => `[${c.taskId.slice(-6)}] ${c.status}: ${c.failureReason ?? c.outcomeSummary ?? 'no detail'}`)
            .join('\n')
        expect(failureLines).toContain('no_credential')
        expect(failureLines).toContain('failed')
    })
})

// ── Tests: connector scope security boundary ─────────────────────────────────

describe('fanout — connector scope security boundary', () => {
    it('child cannot reference a connector the parent does not hold', () => {
        const ROGUE = 'conn-attacker-9999'
        const result = resolveChildConnectors([CONNECTOR_A], [ROGUE])
        expect(result).toBe('scope_violation')
    })

    it('child with parent [] (deny-all) requesting any connector = scope_violation', () => {
        expect(resolveChildConnectors([], [CONNECTOR_A])).toBe('scope_violation')
    })

    it('child inheriting deny-all parent produces deny-all child', () => {
        const result = resolveChildConnectors([], undefined)
        expect(result).toEqual([])
    })

    it('child requesting exact parent set is allowed', () => {
        const result = resolveChildConnectors([CONNECTOR_A, CONNECTOR_B], [CONNECTOR_A, CONNECTOR_B])
        expect(result).toEqual([CONNECTOR_A, CONNECTOR_B])
    })

    it('child requesting strict subset of parent is allowed', () => {
        const result = resolveChildConnectors([CONNECTOR_A, CONNECTOR_B], [CONNECTOR_A])
        expect(result).toEqual([CONNECTOR_A])
    })

    it('mixing one valid + one rogue connector = scope_violation', () => {
        const result = resolveChildConnectors([CONNECTOR_A], [CONNECTOR_A, 'conn-rogue'])
        expect(result).toBe('scope_violation')
    })
})
