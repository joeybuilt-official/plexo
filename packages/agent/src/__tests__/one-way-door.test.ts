// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * One-way-door core approval gate tests.
 *
 * Pins:
 *   1. requestApproval — critical/high risk bypasses standing approvals and
 *      creates a Redis key; low risk with matching standing approval auto-approves
 *      without writing to Redis
 *   2. getDecision — returns parsed PendingDecision or null
 *   3. resolveDecision — pending → resolved, non-pending → null
 *   4. listPending — filters by workspaceId and decision='pending'
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Test state ─────────────────────────────────────────────────────────────

const ctl = {
    redisStore: new Map<string, string>(),
    standingApprovals: [] as Array<{
        id: string; workspaceId: string; actionPattern: string; expiresAt: Date | null
    }>,
}

// ── Redis mock ─────────────────────────────────────────────────────────────

const mockRedis = {
    connect: vi.fn(async () => {}),
    on: vi.fn(),
    setEx: vi.fn(async (key: string, _ttl: number, value: string) => {
        ctl.redisStore.set(key, value)
        return 'OK'
    }),
    get: vi.fn(async (key: string) => ctl.redisStore.get(key) ?? null),
    scanIterator: vi.fn(function* ({ MATCH }: { MATCH?: string } = {}) {
        const prefix = MATCH ? MATCH.replace('*', '') : ''
        for (const key of ctl.redisStore.keys()) {
            if (!prefix || key.startsWith(prefix)) yield key
        }
    }),
}

vi.mock('redis', () => ({
    createClient: vi.fn(() => mockRedis),
}))

// ── Event bus mock ─────────────────────────────────────────────────────────

vi.mock('../plugins/event-bus.js', () => ({
    eventBus: { emitSystem: vi.fn() },
    TOPICS: { OWD_PENDING: 'owd:pending' },
}))

// ── DB mock (for standing approvals check) ─────────────────────────────────

vi.mock('@plexo/db', () => {
    const standingApprovalsSentinel = {
        __table: 'standing_approvals',
        id: 'id', workspaceId: 'workspace_id', actionPattern: 'action_pattern', expiresAt: 'expires_at',
    }
    const workspacesSentinel = { __table: 'workspaces', id: 'id', settings: 'settings' }
    return {
        db: {
            select(_fields?: unknown) {
                return {
                    from(_t: unknown) { return this },
                    where(_c: unknown) { return this },
                    async limit(_n: number) {
                        return ctl.standingApprovals
                    },
                }
            },
        },
        standingApprovals: standingApprovalsSentinel,
        workspaces: workspacesSentinel,
        eq: vi.fn(),
        and: vi.fn(),
    }
})

// ── Imports (after mocks) ──────────────────────────────────────────────────

import {
    requestApproval,
    getDecision,
    resolveDecision,
    listPending,
    type PendingDecision,
} from '../one-way-door.js'

// ── Helpers ────────────────────────────────────────────────────────────────

function baseParams(overrides: Partial<Parameters<typeof requestApproval>[0]> = {}) {
    return {
        taskId: 'task-001',
        workspaceId: 'ws-001',
        operation: 'github__create_pull_request',
        description: 'Open PR on foo/bar',
        riskLevel: 'medium' as const,
        ...overrides,
    }
}

beforeEach(() => {
    ctl.redisStore.clear()
    ctl.standingApprovals = []
    vi.clearAllMocks()
})

// ── requestApproval ────────────────────────────────────────────────────────

describe('requestApproval', () => {
    it('creates a pending Redis key for medium risk', async () => {
        const decision = await requestApproval(baseParams({ riskLevel: 'medium' }))
        expect(decision.decision).toBe('pending')
        expect(decision.id).toMatch(/^[0-9a-f]{24}$/)
        expect(ctl.redisStore.size).toBe(1)
        const stored = JSON.parse([...ctl.redisStore.values()][0]!) as PendingDecision
        expect(stored.workspaceId).toBe('ws-001')
        expect(stored.operation).toBe('github__create_pull_request')
    })

    it('bypasses standing approvals and writes to Redis for high risk', async () => {
        ctl.standingApprovals = [{ id: 'sa-1', workspaceId: 'ws-001', actionPattern: 'github__create_pull_request', expiresAt: null }]
        const decision = await requestApproval(baseParams({ riskLevel: 'high' }))
        // Should NOT auto-approve even though a standing approval exists
        expect(decision.decision).toBe('pending')
        expect(ctl.redisStore.size).toBe(1)
    })

    it('bypasses standing approvals and writes to Redis for critical risk', async () => {
        ctl.standingApprovals = [{ id: 'sa-1', workspaceId: 'ws-001', actionPattern: 'github__create_pull_request', expiresAt: null }]
        const decision = await requestApproval(baseParams({ riskLevel: 'critical' }))
        expect(decision.decision).toBe('pending')
        expect(ctl.redisStore.size).toBe(1)
    })

    it('auto-approves low risk when valid standing approval exists', async () => {
        ctl.standingApprovals = [{
            id: 'sa-2',
            workspaceId: 'ws-001',
            actionPattern: 'github__create_pull_request',
            expiresAt: null, // never expires
        }]
        const decision = await requestApproval(baseParams({ riskLevel: 'low' }))
        expect(decision.decision).toBe('approved')
        expect(decision.decidedBy).toContain('standing-approval:sa-2')
        // No Redis key should be created for auto-approved decisions
        expect(ctl.redisStore.size).toBe(0)
    })

    it('does NOT auto-approve when standing approval is expired', async () => {
        ctl.standingApprovals = [{
            id: 'sa-3',
            workspaceId: 'ws-001',
            actionPattern: 'github__create_pull_request',
            expiresAt: new Date(Date.now() - 1000), // expired 1 second ago
        }]
        const decision = await requestApproval(baseParams({ riskLevel: 'low' }))
        // Expired standing approval should not be used
        expect(decision.decision).toBe('pending')
        expect(ctl.redisStore.size).toBe(1)
    })

    it('emits OWD_PENDING event on the event bus', async () => {
        const { eventBus } = await import('../plugins/event-bus.js')
        await requestApproval(baseParams())
        expect(eventBus.emitSystem).toHaveBeenCalledOnce()
        const [topic, payload] = (eventBus.emitSystem as ReturnType<typeof vi.fn>).mock.calls[0]!
        expect(topic).toBe('owd:pending')
        expect((payload as PendingDecision).decision).toBe('pending')
    })
})

// ── getDecision ────────────────────────────────────────────────────────────

describe('getDecision', () => {
    it('returns null when key does not exist', async () => {
        const result = await getDecision('nonexistent-id')
        expect(result).toBeNull()
    })

    it('returns the parsed PendingDecision when key exists', async () => {
        const decision = await requestApproval(baseParams())
        const fetched = await getDecision(decision.id)
        expect(fetched).not.toBeNull()
        expect(fetched!.id).toBe(decision.id)
        expect(fetched!.decision).toBe('pending')
        expect(fetched!.workspaceId).toBe('ws-001')
    })
})

// ── resolveDecision ────────────────────────────────────────────────────────

describe('resolveDecision', () => {
    it('resolves a pending decision to approved', async () => {
        const decision = await requestApproval(baseParams())
        const resolved = await resolveDecision(decision.id, 'approved', 'dashboard')
        expect(resolved).not.toBeNull()
        expect(resolved!.decision).toBe('approved')
        expect(resolved!.decidedBy).toBe('dashboard')
        expect(resolved!.decidedAt).toBeDefined()
    })

    it('resolves a pending decision to rejected', async () => {
        const decision = await requestApproval(baseParams())
        const resolved = await resolveDecision(decision.id, 'rejected', 'operator')
        expect(resolved!.decision).toBe('rejected')
        expect(resolved!.decidedBy).toBe('operator')
    })

    it('returns null when decision is already resolved', async () => {
        const decision = await requestApproval(baseParams())
        await resolveDecision(decision.id, 'approved', 'first')
        // Second resolve attempt on already-approved decision
        const second = await resolveDecision(decision.id, 'rejected', 'second')
        expect(second).toBeNull()
    })

    it('returns null for a non-existent id', async () => {
        const result = await resolveDecision('nonexistent-id', 'approved', 'test')
        expect(result).toBeNull()
    })

    it('resolved decision is readable back via getDecision', async () => {
        const decision = await requestApproval(baseParams())
        await resolveDecision(decision.id, 'approved', 'dashboard')
        const fetched = await getDecision(decision.id)
        expect(fetched!.decision).toBe('approved')
        expect(fetched!.decidedBy).toBe('dashboard')
    })
})

// ── listPending ────────────────────────────────────────────────────────────

describe('listPending', () => {
    it('returns empty array when no decisions exist', async () => {
        const list = await listPending('ws-001')
        expect(list).toHaveLength(0)
    })

    it('returns pending decisions for the correct workspace', async () => {
        await requestApproval(baseParams({ workspaceId: 'ws-001', taskId: 'task-a' }))
        await requestApproval(baseParams({ workspaceId: 'ws-001', taskId: 'task-b' }))
        const list = await listPending('ws-001')
        expect(list).toHaveLength(2)
        expect(list.every((d) => d.workspaceId === 'ws-001')).toBe(true)
        expect(list.every((d) => d.decision === 'pending')).toBe(true)
    })

    it('excludes decisions from other workspaces', async () => {
        await requestApproval(baseParams({ workspaceId: 'ws-001', taskId: 'task-a' }))
        await requestApproval(baseParams({ workspaceId: 'ws-002', taskId: 'task-b' }))
        const list = await listPending('ws-001')
        expect(list).toHaveLength(1)
        expect(list[0]!.workspaceId).toBe('ws-001')
    })

    it('excludes already-resolved decisions', async () => {
        const d1 = await requestApproval(baseParams({ workspaceId: 'ws-001', taskId: 'task-a' }))
        await requestApproval(baseParams({ workspaceId: 'ws-001', taskId: 'task-b' }))
        await resolveDecision(d1.id, 'approved', 'test')
        const list = await listPending('ws-001')
        // Only the unresolved one should appear
        expect(list).toHaveLength(1)
        expect(list[0]!.taskId).toBe('task-b')
    })
})
