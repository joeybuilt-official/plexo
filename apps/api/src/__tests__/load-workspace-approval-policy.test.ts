// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase K (15a) — direct unit coverage for `loadWorkspaceApprovalPolicy`.
 *
 * Phase D shipped this as module-private and the integration test in
 * `tests/integration/confirm-gate.integration.test.ts` covered it
 * indirectly via a workspaces.settings round-trip. The export was
 * surfaced in Phase K so we can pin the boolean-derivation logic
 * without spinning up Postgres.
 *
 * The `db.select(...).from(...).where(...).limit(1)` chain is mocked
 * to feed a single settings row; no real DB or Redis I/O.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const ctl = {
    settingsRow: undefined as { settings: Record<string, unknown> | null } | undefined,
    shouldThrow: false,
}

vi.mock('@plexo/db', () => {
    const limit = vi.fn(async () => {
        if (ctl.shouldThrow) throw new Error('db connection refused')
        return ctl.settingsRow ? [ctl.settingsRow] : []
    })
    const where = vi.fn(() => ({ limit }))
    const from = vi.fn(() => ({ where }))
    const select = vi.fn(() => ({ from }))
    return {
        db: { select },
        eq: vi.fn(),
        and: vi.fn(),
        sql: Object.assign(
            (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
            { join: vi.fn() },
        ),
        inArray: vi.fn(),
        tasks: { id: 'tasks.id', status: 'tasks.status', claimedAt: 'tasks.claimed_at' },
        apiCostTracking: {},
        workspaces: { id: 'workspaces.id', settings: 'workspaces.settings' },
        sprints: {},
        sprintTasks: {},
        plexoOpsTaskEvents: {},
    }
})

// All of agent-loop's other transitive imports are mocked to no-ops so the
// module loads without trying to wire up the real agent / queue / SSE stack.
vi.mock('@plexo/queue', () => ({
    claimTask: vi.fn(), completeTask: vi.fn(), blockTask: vi.fn(), requeueForRetry: vi.fn(),
}))
vi.mock('@plexo/agent/planner', () => ({ planTask: vi.fn() }))
vi.mock('@plexo/agent/executor', () => ({ executeTask: vi.fn() }))
vi.mock('@plexo/agent/tasks/terminal-fail', () => ({ markTaskFailed: vi.fn() }))
vi.mock('@plexo/agent/tasks/types', () => ({ FailureReason: {} }))
vi.mock('@plexo/agent/event-bus', () => ({ eventBus: { on: vi.fn(), emit: vi.fn() }, TOPICS: {} }))
vi.mock('@plexo/agent/behavior/reflect', () => ({ reflectAndPromote: vi.fn() }))
vi.mock('@plexo/agent/one-way-door', () => ({
    requestApproval: vi.fn(), waitForDecision: vi.fn(), getDecision: vi.fn(),
}))
vi.mock('../sse-emitter.js', () => ({ emitToWorkspace: vi.fn() }))
vi.mock('../channel-delivery.js', () => ({ channelSupportsConfirmation: vi.fn() }))
vi.mock('../routes/code.js', () => ({ registerCodeContext: vi.fn(), unregisterCodeContext: vi.fn() }))
vi.mock('../analytics/events.js', () => ({ emitTaskOutcome: vi.fn(), emitReflectionEvent: vi.fn() }))
vi.mock('../event-tracker.js', () => ({ trackError: vi.fn(), trackEvent: vi.fn() }))
vi.mock('../routes/ai-provider-creds.js', () => ({ loadDecryptedAIProviders: vi.fn() }))
vi.mock('../routes/search.js', () => ({ getDecryptedBraveKey: vi.fn() }))
vi.mock('../parallel-executor.js', () => ({
    claimBatch: vi.fn(), releaseSlot: vi.fn(), extendSlot: vi.fn(),
    HEARTBEAT_INTERVAL_MS: 30_000, getParallelStatus: vi.fn(async () => ({ slots: [], maxSlots: 4 })),
}))
vi.mock('../lib/intelligence-cache.js', () => ({ getCachedIntelligenceSettings: vi.fn() }))
vi.mock('../logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

describe('loadWorkspaceApprovalPolicy', () => {
    beforeEach(() => {
        ctl.settingsRow = undefined
        ctl.shouldThrow = false
    })

    it('returns false-default for null/undefined workspaceId', async () => {
        const { loadWorkspaceApprovalPolicy } = await import('../agent-loop.js')
        expect(await loadWorkspaceApprovalPolicy(null)).toEqual({ requireApprovalForGeneralTasks: false })
        expect(await loadWorkspaceApprovalPolicy(undefined)).toEqual({ requireApprovalForGeneralTasks: false })
    })

    it('returns false-default for empty workspaceId', async () => {
        const { loadWorkspaceApprovalPolicy } = await import('../agent-loop.js')
        expect(await loadWorkspaceApprovalPolicy('')).toEqual({ requireApprovalForGeneralTasks: false })
    })

    it('returns true when settings.requireApprovalForGeneralTasks === true', async () => {
        ctl.settingsRow = { settings: { requireApprovalForGeneralTasks: true } }
        const { loadWorkspaceApprovalPolicy } = await import('../agent-loop.js')
        expect(await loadWorkspaceApprovalPolicy('ws-1')).toEqual({ requireApprovalForGeneralTasks: true })
    })

    it('returns false when setting is explicitly false', async () => {
        ctl.settingsRow = { settings: { requireApprovalForGeneralTasks: false } }
        const { loadWorkspaceApprovalPolicy } = await import('../agent-loop.js')
        expect(await loadWorkspaceApprovalPolicy('ws-1')).toEqual({ requireApprovalForGeneralTasks: false })
    })

    it('returns false for truthy-but-not-strict-true values (=== check)', async () => {
        ctl.settingsRow = { settings: { requireApprovalForGeneralTasks: 'true' } }
        const { loadWorkspaceApprovalPolicy } = await import('../agent-loop.js')
        expect(await loadWorkspaceApprovalPolicy('ws-1')).toEqual({ requireApprovalForGeneralTasks: false })

        ctl.settingsRow = { settings: { requireApprovalForGeneralTasks: 1 } }
        expect(await loadWorkspaceApprovalPolicy('ws-1')).toEqual({ requireApprovalForGeneralTasks: false })
    })

    it('returns false when settings is missing the key', async () => {
        ctl.settingsRow = { settings: { other: 'value' } }
        const { loadWorkspaceApprovalPolicy } = await import('../agent-loop.js')
        expect(await loadWorkspaceApprovalPolicy('ws-1')).toEqual({ requireApprovalForGeneralTasks: false })
    })

    it('returns false when workspace row is absent', async () => {
        ctl.settingsRow = undefined
        const { loadWorkspaceApprovalPolicy } = await import('../agent-loop.js')
        expect(await loadWorkspaceApprovalPolicy('ws-missing')).toEqual({ requireApprovalForGeneralTasks: false })
    })

    it('returns false when settings is null', async () => {
        ctl.settingsRow = { settings: null }
        const { loadWorkspaceApprovalPolicy } = await import('../agent-loop.js')
        expect(await loadWorkspaceApprovalPolicy('ws-1')).toEqual({ requireApprovalForGeneralTasks: false })
    })

    it('defaults to off when the DB throws', async () => {
        ctl.shouldThrow = true
        const { loadWorkspaceApprovalPolicy } = await import('../agent-loop.js')
        expect(await loadWorkspaceApprovalPolicy('ws-1')).toEqual({ requireApprovalForGeneralTasks: false })
    })
})
