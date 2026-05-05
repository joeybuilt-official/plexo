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
    TOPICS: { OWD_PENDING: 'owd:pending', OWD_RESOLVED: 'owd:resolved' },
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
    isOutboundChannelTool,
    elevateOutboundOneWayDoors,
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

    it('emits OWD_RESOLVED on resolve so worker-slot release path can wake', async () => {
        const { eventBus } = await import('../plugins/event-bus.js')
        const decision = await requestApproval(baseParams())
        ;(eventBus.emitSystem as ReturnType<typeof vi.fn>).mockClear()
        await resolveDecision(decision.id, 'approved', 'dashboard')
        const calls = (eventBus.emitSystem as ReturnType<typeof vi.fn>).mock.calls
        const resolved = calls.find((c) => c[0] === 'owd:resolved')
        expect(resolved).toBeDefined()
        const payload = resolved![1] as PendingDecision
        expect(payload.id).toBe(decision.id)
        expect(payload.decision).toBe('approved')
        expect(payload.decidedBy).toBe('dashboard')
    })

    it('does NOT emit OWD_RESOLVED when resolve is a no-op (already resolved)', async () => {
        const { eventBus } = await import('../plugins/event-bus.js')
        const decision = await requestApproval(baseParams())
        await resolveDecision(decision.id, 'approved', 'first')
        ;(eventBus.emitSystem as ReturnType<typeof vi.fn>).mockClear()
        await resolveDecision(decision.id, 'rejected', 'second')
        const resolvedCalls = (eventBus.emitSystem as ReturnType<typeof vi.fn>).mock.calls
            .filter((c) => c[0] === 'owd:resolved')
        expect(resolvedCalls).toHaveLength(0)
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

// ── isOutboundChannelTool (ADR 0006 §D2) ──────────────────────────────────

describe('isOutboundChannelTool', () => {
    it('matches outbound send_* tools across providers', () => {
        expect(isOutboundChannelTool('gmail__send_email')).toBe(true)
        expect(isOutboundChannelTool('twilio__send_sms')).toBe(true)
        expect(isOutboundChannelTool('levio__send_email')).toBe(true)
        expect(isOutboundChannelTool('telegram__send_message')).toBe(true)
        expect(isOutboundChannelTool('discord__send_message')).toBe(true)
        expect(isOutboundChannelTool('slack__send_message')).toBe(true)
    })

    it('matches reply_* and post_* tools', () => {
        expect(isOutboundChannelTool('gmail__reply_to_thread')).toBe(true)
        expect(isOutboundChannelTool('slack__post_message')).toBe(true)
    })

    it('rejects non-outbound tools', () => {
        expect(isOutboundChannelTool('read_file')).toBe(false)
        expect(isOutboundChannelTool('shell')).toBe(false)
        expect(isOutboundChannelTool('gmail__list_emails')).toBe(false)
        // L5b Stage 3: read-only verbs across providers stay false
        expect(isOutboundChannelTool('notion__search')).toBe(false)
        expect(isOutboundChannelTool('jira__list_issues')).toBe(false)
        expect(isOutboundChannelTool('linear__list_issues')).toBe(false)
        expect(isOutboundChannelTool('airtable__list_records')).toBe(false)
        expect(isOutboundChannelTool('gws__read_email')).toBe(false)
        expect(isOutboundChannelTool('gdrive__get_file')).toBe(false)
        expect(isOutboundChannelTool('ssh__list_dir')).toBe(false)
    })

    // L5b Stage 3 security review: predicate extended to cover side-effecting
    // tools the L5 set missed — ssh__exec / ssh__upload, notion / jira / linear /
    // airtable creates and updates, gws/gdrive create_file, gws delete_event,
    // levio create/update_task, github create_pull_request etc.
    it('matches L5b extended outbound verbs (Stage 3)', () => {
        expect(isOutboundChannelTool('ssh__exec')).toBe(true)
        expect(isOutboundChannelTool('ssh__upload')).toBe(true)
        expect(isOutboundChannelTool('notion__create_page')).toBe(true)
        expect(isOutboundChannelTool('notion__update_page')).toBe(true)
        expect(isOutboundChannelTool('jira__create_issue')).toBe(true)
        expect(isOutboundChannelTool('jira__update_issue')).toBe(true)
        expect(isOutboundChannelTool('linear__create_issue')).toBe(true)
        expect(isOutboundChannelTool('linear__update_issue')).toBe(true)
        expect(isOutboundChannelTool('airtable__create_record')).toBe(true)
        expect(isOutboundChannelTool('airtable__update_record')).toBe(true)
        expect(isOutboundChannelTool('gws__delete_event')).toBe(true)
        expect(isOutboundChannelTool('gws__create_file')).toBe(true)
        expect(isOutboundChannelTool('gdrive__create_file')).toBe(true)
        expect(isOutboundChannelTool('levio__create_task')).toBe(true)
        expect(isOutboundChannelTool('levio__update_task')).toBe(true)
        // GitHub PR creation — was a false negative under the original L5 set.
        expect(isOutboundChannelTool('github__create_pull_request')).toBe(true)
    })

    it('matches db__send_query (documented false positive — see ADR 0006 L5.5 #3)', () => {
        // Predicate is naming-pattern-based; if a future internal tool names
        // itself with __send_/__reply_/__post_ it will trip the gate. Acceptable
        // bias: false positives prompt for confirmation; false negatives leak.
        expect(isOutboundChannelTool('db__send_query')).toBe(true)
    })

    it('rejects empty / undefined-ish input', () => {
        expect(isOutboundChannelTool('')).toBe(false)
    })

    // Stage 3 security review (ADR 0006) extended the predicate to cover more
    // verbs after auditing the connection registry — pagerduty trigger, github
    // PR/push/merge, calendar invites, drafts, etc.
    it('matches extended outbound verbs (Stage 3 security review)', () => {
        expect(isOutboundChannelTool('gmail__create_draft')).toBe(true)
        expect(isOutboundChannelTool('google_calendar__create_event')).toBe(true)
        expect(isOutboundChannelTool('outlook__update_event')).toBe(true)
        expect(isOutboundChannelTool('pagerduty__trigger_incident')).toBe(true)
        expect(isOutboundChannelTool('github__open_pr')).toBe(true)
        expect(isOutboundChannelTool('github__merge_pr')).toBe(true)
        expect(isOutboundChannelTool('github__push_file')).toBe(true)
        expect(isOutboundChannelTool('webhook__publish_event')).toBe(true)
        expect(isOutboundChannelTool('alerting__notify_oncall')).toBe(true)
        expect(isOutboundChannelTool('queue__dispatch_job')).toBe(true)
        expect(isOutboundChannelTool('shipping__deliver_package')).toBe(true)
        expect(isOutboundChannelTool('mail__forward_thread')).toBe(true)
    })
})

// ── elevateOutboundOneWayDoors (ADR 0006 §D3) ─────────────────────────────

describe('elevateOutboundOneWayDoors', () => {
    function makePlan(overrides: {
        steps?: Array<{ toolsRequired?: string[] }>
        oneWayDoors?: Array<{ description: string; type: string; reversibility: string; requiresApproval: boolean }>
    } = {}) {
        return {
            steps: overrides.steps ?? [],
            oneWayDoors: overrides.oneWayDoors ?? [],
        }
    }

    it('synthesizes a new OWD for an outbound tool when no covering OWD exists', () => {
        const plan = makePlan({
            steps: [{ toolsRequired: ['gmail__send_email'] }],
            oneWayDoors: [],
        })
        const result = elevateOutboundOneWayDoors(plan)
        expect(result.addedCount).toBe(1)
        expect(result.addedTools).toEqual(['gmail__send_email'])
        expect(result.oneWayDoors).toHaveLength(1)
        const synth = result.oneWayDoors[0]!
        expect(synth.type).toBe('external_call')
        expect(synth.requiresApproval).toBe(true)
        expect(synth.description).toContain('gmail__send_email')
        expect(synth.reversibility).toContain('irreversible')
    })

    it('preserves existing OWDs when planner already classified the tool', () => {
        const plan = makePlan({
            steps: [{ toolsRequired: ['gmail__send_email'] }],
            oneWayDoors: [{
                description: 'Send notification via gmail__send_email to ops',
                type: 'external_call',
                reversibility: 'irreversible',
                requiresApproval: true,
            }],
        })
        const result = elevateOutboundOneWayDoors(plan)
        expect(result.addedCount).toBe(0)
        expect(result.addedTools).toHaveLength(0)
        expect(result.oneWayDoors).toHaveLength(1)
        // Original entry should be preserved
        expect(result.oneWayDoors[0]!.description).toBe('Send notification via gmail__send_email to ops')
    })

    it('dedupes by description-contains-toolName substring match', () => {
        const plan = makePlan({
            steps: [
                { toolsRequired: ['gmail__send_email'] },
                { toolsRequired: ['gmail__send_email', 'twilio__send_sms'] },
            ],
            oneWayDoors: [{
                description: 'Outbound: twilio__send_sms to user',
                type: 'external_call',
                reversibility: 'irreversible',
                requiresApproval: true,
            }],
        })
        const result = elevateOutboundOneWayDoors(plan)
        // gmail tool elevated once (deduped against itself across steps)
        // twilio tool already covered by existing OWD
        expect(result.addedCount).toBe(1)
        expect(result.addedTools).toEqual(['gmail__send_email'])
        expect(result.oneWayDoors).toHaveLength(2)
    })

    it('does nothing when no outbound tools are present', () => {
        // L5b Stage 3: github__create_pull_request now matches the predicate;
        // use genuinely read-only tools across providers instead.
        const plan = makePlan({
            steps: [
                { toolsRequired: ['read_file', 'shell'] },
                { toolsRequired: ['gmail__list_emails', 'gws__read_email'] },
            ],
        })
        const result = elevateOutboundOneWayDoors(plan)
        expect(result.addedCount).toBe(0)
        expect(result.addedTools).toEqual([])
        expect(result.oneWayDoors).toEqual([])
    })

    it('handles empty plans / steps without throwing', () => {
        const result = elevateOutboundOneWayDoors({ steps: [], oneWayDoors: [] })
        expect(result.addedCount).toBe(0)
        expect(result.oneWayDoors).toEqual([])
    })

    it('handles steps with missing toolsRequired arrays', () => {
        const plan = makePlan({ steps: [{}, { toolsRequired: ['gmail__send_email'] }] })
        const result = elevateOutboundOneWayDoors(plan)
        expect(result.addedCount).toBe(1)
        expect(result.addedTools).toEqual(['gmail__send_email'])
    })

    it('elevates multiple distinct outbound tools across steps with correct telemetry', () => {
        const plan = makePlan({
            steps: [
                { toolsRequired: ['gmail__send_email'] },
                { toolsRequired: ['slack__post_message'] },
                { toolsRequired: ['twilio__send_sms'] },
                { toolsRequired: ['read_file'] },
            ],
        })
        const result = elevateOutboundOneWayDoors(plan)
        expect(result.addedCount).toBe(3)
        expect(result.addedTools.sort()).toEqual(['gmail__send_email', 'slack__post_message', 'twilio__send_sms'])
        expect(result.oneWayDoors).toHaveLength(3)
        expect(result.oneWayDoors.every((o) => o.type === 'external_call' && o.requiresApproval === true)).toBe(true)
    })
})
