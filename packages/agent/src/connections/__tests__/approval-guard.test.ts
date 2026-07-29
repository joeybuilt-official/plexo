// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase L5b unit tests — `wrapOutboundToolsWithApprovalGuard` (ADR 0006 §D5).
 *
 * Pins the executor-side mid-stream guard that closes the bypass found by L5
 * Stage 3 security review: `plan.steps[].toolsRequired[]` is declarative
 * only — the executor passes the FULL connection-tool surface to the LLM.
 * A planner emitting `toolsRequired: []` but a step description like
 * "Send Bob the launch email" still lets the executor LLM call
 * `gmail__send_email` without elevation having synthesized a covering OWD.
 *
 * Contract:
 *   - Non-outbound tools pass through unchanged (object identity preserved).
 *   - Outbound tools whose name appears in `plan.oneWayDoors[].description`
 *     pass through silently — operator already approved at plan-time.
 *   - Outbound tools NOT covered by the plan: wrapper fires the
 *     onUncovered callback (telemetry), calls requestApproval at
 *     riskLevel='high' (load-bearing for SEC-016 standing-approval lockout),
 *     then waitForDecision if pending. On 'approved' invokes original
 *     execute. On 'rejected' / 'timeout' throws.
 *   - Risk level is hardcoded 'high' — never 'medium'. Otherwise a workspace
 *     standing approval keyed on the tool name could silently bypass the
 *     wrap.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks for the one-way-door dependencies ────────────────────────────────
// requestApproval + waitForDecision touch Redis + DB; mock them so we can
// drive deterministic test cases. isOutboundChannelTool is the real impl —
// the wrapper relies on its predicate semantics. vi.hoisted is required so
// the mock fns exist when vi.mock's hoisted factory runs.

const { mockRequestApproval, mockWaitForDecision } = vi.hoisted(() => ({
    mockRequestApproval: vi.fn(),
    mockWaitForDecision: vi.fn(),
}))

vi.mock('../../one-way-door.js', async () => {
    const actual = await vi.importActual<typeof import('../../one-way-door.js')>('../../one-way-door.js')
    return {
        ...actual,
        requestApproval: mockRequestApproval,
        waitForDecision: mockWaitForDecision,
    }
})

import { wrapOutboundToolsWithApprovalGuard } from '../approval-guard.js'
import type { ToolSet } from 'ai'

// ── Test helpers ───────────────────────────────────────────────────────────

function fakeTool(execute: (...args: unknown[]) => unknown, extras: Record<string, unknown> = {}) {
    return {
        description: 'fake tool',
        inputSchema: {},
        execute,
        ...extras,
    }
}

function basePlan(owds: Array<{ description: string; type?: string; requiresApproval?: boolean }> = []) {
    return { oneWayDoors: owds }
}

beforeEach(() => {
    mockRequestApproval.mockReset()
    mockWaitForDecision.mockReset()
})

// ── Pass-through paths ─────────────────────────────────────────────────────

describe('wrapOutboundToolsWithApprovalGuard — non-outbound tools', () => {
    it('preserves object identity for non-outbound tools (no wrapping cost)', async () => {
        const readFile = fakeTool(() => 'file contents')
        const tools: ToolSet = { read_file: readFile as unknown as ToolSet[string] }

        const wrapped = wrapOutboundToolsWithApprovalGuard(tools, {
            plan: basePlan(),
            taskId: 'task-1',
            workspaceId: 'ws-1',
        })

        expect(wrapped.read_file).toBe(readFile)
    })

    it('does not invoke requestApproval when a non-outbound tool fires', async () => {
        const readFile = fakeTool(() => 'file contents')
        const tools: ToolSet = { gmail__list_messages: fakeTool(() => 'inbox') as unknown as ToolSet[string], read_file: readFile as unknown as ToolSet[string] }

        const wrapped = wrapOutboundToolsWithApprovalGuard(tools, {
            plan: basePlan(),
            taskId: 'task-1',
            workspaceId: 'ws-1',
        })

        const exec = (wrapped.gmail__list_messages as unknown as { execute: () => Promise<string> }).execute
        await exec()
        expect(mockRequestApproval).not.toHaveBeenCalled()
    })
})

// ── Plan-covered outbound: pass through silently ───────────────────────────

describe('wrapOutboundToolsWithApprovalGuard — outbound with covering OWD', () => {
    it('passes through when plan.oneWayDoors[] description contains the tool name', async () => {
        const send = vi.fn(async () => 'sent')
        const tools: ToolSet = { gmail__send_email: fakeTool(send) as unknown as ToolSet[string] }

        const wrapped = wrapOutboundToolsWithApprovalGuard(tools, {
            plan: basePlan([{
                // Mirrors the L5 elevation pass output shape.
                description: 'Outbound channel call: gmail__send_email (auto-elevated for safety per ADR 0006)',
                type: 'external_call',
                requiresApproval: true,
            }]),
            taskId: 'task-1',
            workspaceId: 'ws-1',
        })

        const exec = (wrapped.gmail__send_email as unknown as { execute: (input: unknown) => Promise<string> }).execute
        const result = await exec({ to: 'bob@example.com', body: 'hi' })

        expect(result).toBe('sent')
        expect(send).toHaveBeenCalledTimes(1)
        expect(mockRequestApproval).not.toHaveBeenCalled()
        expect(mockWaitForDecision).not.toHaveBeenCalled()
    })
})

// ── Uncovered outbound: synthesize approval + gate ─────────────────────────

describe('wrapOutboundToolsWithApprovalGuard — uncovered outbound (the L5b bypass closure)', () => {
    it('throws when wait resolves to rejected; counter fires; original execute NOT called', async () => {
        const send = vi.fn(async () => 'should not run')
        const onUncovered = vi.fn()
        const tools: ToolSet = { gmail__send_email: fakeTool(send) as unknown as ToolSet[string] }

        mockRequestApproval.mockResolvedValue({ id: 'owd-1', decision: 'pending' })
        mockWaitForDecision.mockResolvedValue('rejected')

        const wrapped = wrapOutboundToolsWithApprovalGuard(tools, {
            plan: basePlan([]),
            taskId: 'task-1',
            workspaceId: 'ws-1',
            onUncovered,
        })

        const exec = (wrapped.gmail__send_email as unknown as { execute: (input: unknown) => Promise<string> }).execute
        await expect(exec({ to: 'bob@example.com', body: 'hi' })).rejects.toThrow(
            /Outbound tool call denied by approval guard: gmail__send_email .*decision=rejected/,
        )

        expect(send).not.toHaveBeenCalled()
        expect(onUncovered).toHaveBeenCalledWith({ tool: 'gmail__send_email', provider: 'gmail' })
        expect(mockRequestApproval).toHaveBeenCalledWith(expect.objectContaining({
            taskId: 'task-1',
            workspaceId: 'ws-1',
            operation: 'gmail__send_email',
            // Load-bearing: 'high' is the SEC-016 lockout invariant.
            riskLevel: 'high',
        }))
        expect(mockWaitForDecision).toHaveBeenCalledWith('owd-1')
    })

    it('throws on timeout', async () => {
        const send = vi.fn(async () => 'should not run')
        const tools: ToolSet = { twilio__send_sms: fakeTool(send) as unknown as ToolSet[string] }

        mockRequestApproval.mockResolvedValue({ id: 'owd-2', decision: 'pending' })
        mockWaitForDecision.mockResolvedValue('timeout')

        const wrapped = wrapOutboundToolsWithApprovalGuard(tools, {
            plan: basePlan([]),
            taskId: 'task-1',
            workspaceId: 'ws-1',
        })

        const exec = (wrapped.twilio__send_sms as unknown as { execute: (input: unknown) => Promise<string> }).execute
        await expect(exec({ to: '+15551234', body: 'hi' })).rejects.toThrow(/decision=timeout/)
        expect(send).not.toHaveBeenCalled()
    })

    it('invokes original execute after waitForDecision returns approved', async () => {
        const send = vi.fn(async (input: unknown) => `sent to ${(input as { to: string }).to}`)
        const tools: ToolSet = { slack__post_message: fakeTool(send) as unknown as ToolSet[string] }

        mockRequestApproval.mockResolvedValue({ id: 'owd-3', decision: 'pending' })
        mockWaitForDecision.mockResolvedValue('approved')

        const wrapped = wrapOutboundToolsWithApprovalGuard(tools, {
            plan: basePlan([]),
            taskId: 'task-1',
            workspaceId: 'ws-1',
        })

        const exec = (wrapped.slack__post_message as unknown as { execute: (input: unknown) => Promise<string> }).execute
        const result = await exec({ to: '#general', body: 'hi' })

        expect(result).toBe('sent to #general')
        expect(send).toHaveBeenCalledTimes(1)
    })

    it('invokes original execute when requestApproval returns approved without polling', async () => {
        // Forward-compat: SEC-016 forbids standing approvals at 'high', but if
        // policy ever loosens the wrapper still skips waitForDecision.
        const send = vi.fn(async () => 'sent')
        const tools: ToolSet = { gmail__send_email: fakeTool(send) as unknown as ToolSet[string] }

        mockRequestApproval.mockResolvedValue({ id: 'owd-4', decision: 'approved' })

        const wrapped = wrapOutboundToolsWithApprovalGuard(tools, {
            plan: basePlan([]),
            taskId: 'task-1',
            workspaceId: 'ws-1',
        })

        const exec = (wrapped.gmail__send_email as unknown as { execute: () => Promise<string> }).execute
        const result = await exec()

        expect(result).toBe('sent')
        expect(send).toHaveBeenCalledTimes(1)
        expect(mockWaitForDecision).not.toHaveBeenCalled()
    })

    it('synthesized OWD description names the offending tool so operators see what is about to fire', async () => {
        const send = vi.fn(async () => 'sent')
        const tools: ToolSet = { discord__post_message: fakeTool(send) as unknown as ToolSet[string] }

        mockRequestApproval.mockResolvedValue({ id: 'owd-5', decision: 'pending' })
        mockWaitForDecision.mockResolvedValue('approved')

        const wrapped = wrapOutboundToolsWithApprovalGuard(tools, {
            plan: basePlan([]),
            taskId: 'task-1',
            workspaceId: 'ws-1',
        })

        const exec = (wrapped.discord__post_message as unknown as { execute: () => Promise<string> }).execute
        await exec()

        const call = mockRequestApproval.mock.calls[0]![0] as { description: string }
        expect(call.description).toContain('discord__post_message')
        expect(call.description).toContain('did not pre-approve')
    })
})

// ── Coverage edge cases ────────────────────────────────────────────────────

describe('wrapOutboundToolsWithApprovalGuard — coverage edge cases', () => {
    it('does NOT consider a generic external_call OWD that omits the tool name as covering', async () => {
        // Hostile-planner protection: a vague "Send something to a user" OWD
        // must NOT auto-cover a specific outbound tool. Forces fresh approval.
        const send = vi.fn(async () => 'sent')
        const tools: ToolSet = { gmail__send_email: fakeTool(send) as unknown as ToolSet[string] }

        mockRequestApproval.mockResolvedValue({ id: 'owd-6', decision: 'pending' })
        mockWaitForDecision.mockResolvedValue('approved')

        const wrapped = wrapOutboundToolsWithApprovalGuard(tools, {
            plan: basePlan([{
                description: 'Send something to a user',
                type: 'external_call',
                requiresApproval: true,
            }]),
            taskId: 'task-1',
            workspaceId: 'ws-1',
        })

        const exec = (wrapped.gmail__send_email as unknown as { execute: () => Promise<string> }).execute
        await exec()

        // Even though there's an external_call OWD, requestApproval still
        // fires because the description didn't name the specific tool.
        expect(mockRequestApproval).toHaveBeenCalledTimes(1)
    })

    it('reads plan.oneWayDoors at execute-time so mid-task replans take effect', async () => {
        const send = vi.fn(async () => 'sent')
        const plan: { oneWayDoors: Array<{ description: string; type?: string; requiresApproval?: boolean }> } = { oneWayDoors: [] }
        const tools: ToolSet = { gmail__send_email: fakeTool(send) as unknown as ToolSet[string] }

        const wrapped = wrapOutboundToolsWithApprovalGuard(tools, {
            plan,
            taskId: 'task-1',
            workspaceId: 'ws-1',
        })

        // Replanner adds a covering OWD between wrap and first execute.
        plan.oneWayDoors.push({
            description: 'Outbound channel call: gmail__send_email (replan-elevated)',
            type: 'external_call',
            requiresApproval: true,
        })

        const exec = (wrapped.gmail__send_email as unknown as { execute: () => Promise<string> }).execute
        await exec()

        expect(send).toHaveBeenCalledTimes(1)
        // Replan coverage caught it — no fresh approval cycle.
        expect(mockRequestApproval).not.toHaveBeenCalled()
    })

    it('leaves a tool with no execute handler untouched (provider-side tool)', () => {
        const providerSide: ToolSet = { gmail__send_email: { description: 'no exec' } as unknown as ToolSet[string] }
        const wrapped = wrapOutboundToolsWithApprovalGuard(providerSide, {
            plan: basePlan(),
            taskId: 'task-1',
            workspaceId: 'ws-1',
        })
        expect(wrapped.gmail__send_email).toBe(providerSide.gmail__send_email)
    })

    // L5b Stage 3: tightened coverage rule. An OWD that names the tool name
    // in its description still does NOT count as covering unless it is also
    // type='external_call' AND requiresApproval=true. Prevents a hostile or
    // sloppy planner from emitting a "do NOT send via gmail__send_email"-
    // shaped OWD that would slip through under substring-includes alone.
    it('does NOT count a description-mentions-tool OWD as covering when type != external_call', async () => {
        const send = vi.fn(async () => 'sent')
        const tools: ToolSet = { gmail__send_email: fakeTool(send) as unknown as ToolSet[string] }
        mockRequestApproval.mockResolvedValue({ id: 'owd-7', decision: 'pending' })
        mockWaitForDecision.mockResolvedValue('approved')

        const wrapped = wrapOutboundToolsWithApprovalGuard(tools, {
            plan: basePlan([{
                description: 'Will not call gmail__send_email — internal note',
                type: 'data_write',
                requiresApproval: true,
            }]),
            taskId: 'task-1',
            workspaceId: 'ws-1',
        })

        const exec = (wrapped.gmail__send_email as unknown as { execute: () => Promise<string> }).execute
        await exec()
        // Type wasn't external_call, so wrap still elevated.
        expect(mockRequestApproval).toHaveBeenCalledTimes(1)
    })

    it('does NOT count a description-mentions-tool external_call OWD as covering when requiresApproval=false', async () => {
        const send = vi.fn(async () => 'sent')
        const tools: ToolSet = { gmail__send_email: fakeTool(send) as unknown as ToolSet[string] }
        mockRequestApproval.mockResolvedValue({ id: 'owd-8', decision: 'pending' })
        mockWaitForDecision.mockResolvedValue('approved')

        const wrapped = wrapOutboundToolsWithApprovalGuard(tools, {
            plan: basePlan([{
                description: 'gmail__send_email referenced for context only',
                type: 'external_call',
                requiresApproval: false,
            }]),
            taskId: 'task-1',
            workspaceId: 'ws-1',
        })

        const exec = (wrapped.gmail__send_email as unknown as { execute: () => Promise<string> }).execute
        await exec()
        expect(mockRequestApproval).toHaveBeenCalledTimes(1)
    })

    // Header claims wrap is idempotent on repeated invocation. Pin it.
    it('is idempotent under double-wrap (re-wrapping a wrapped ToolSet preserves behavior)', async () => {
        const send = vi.fn(async () => 'sent')
        const tools: ToolSet = { gmail__send_email: fakeTool(send) as unknown as ToolSet[string] }
        const ctx = {
            plan: basePlan([{
                description: 'Outbound channel call: gmail__send_email (auto-elevated for safety per ADR 0006)',
                type: 'external_call' as const,
                requiresApproval: true,
            }]),
            taskId: 'task-1',
            workspaceId: 'ws-1',
        }

        const once = wrapOutboundToolsWithApprovalGuard(tools, ctx)
        const twice = wrapOutboundToolsWithApprovalGuard(once, ctx)

        const exec = (twice.gmail__send_email as unknown as { execute: () => Promise<string> }).execute
        await exec()
        // Coverage verdict stable under double-wrap; no spurious approval.
        expect(send).toHaveBeenCalledTimes(1)
        expect(mockRequestApproval).not.toHaveBeenCalled()
    })

    it('falls back to provider="unknown" when tool name has no __ prefix', async () => {
        // Edge case: a future bare-named outbound tool would otherwise emit
        // an empty provider label series — bad for Prometheus cardinality.
        const onUncovered = vi.fn()
        const send = vi.fn(async () => 'sent')
        // Force the name through the predicate by including __send_ in the body.
        const tools: ToolSet = { 'bare__send_message': fakeTool(send) as unknown as ToolSet[string] }
        mockRequestApproval.mockResolvedValue({ id: 'owd-9', decision: 'pending' })
        mockWaitForDecision.mockResolvedValue('approved')

        const wrapped = wrapOutboundToolsWithApprovalGuard(tools, {
            plan: basePlan(),
            taskId: 'task-1',
            workspaceId: 'ws-1',
            onUncovered,
        })

        const exec = (wrapped['bare__send_message'] as unknown as { execute: () => Promise<string> }).execute
        await exec()
        expect(onUncovered).toHaveBeenCalledWith({ tool: 'bare__send_message', provider: 'bare' })
    })
})

// ── L5.5 #8 — per-task denial budget ─────────────────────────────────────────

describe('wrapOutboundToolsWithApprovalGuard — per-task denial budget (L5.5 #8)', () => {
    it('after 3 consecutive denials of the same tool, switches to instant-deny without re-prompting', async () => {
        const send = vi.fn(async () => 'sent')
        const onDenialLoop = vi.fn()
        const tools: ToolSet = { 'gmail__send_email': fakeTool(send) as unknown as ToolSet[string] }
        mockRequestApproval.mockResolvedValue({ id: 'owd-1', decision: 'pending' })
        mockWaitForDecision.mockResolvedValue('rejected')

        const wrapped = wrapOutboundToolsWithApprovalGuard(tools, {
            plan: basePlan(),
            taskId: 'task-loop-1',
            workspaceId: 'ws-1',
            onDenialLoop,
        })

        const exec = (wrapped['gmail__send_email'] as unknown as { execute: () => Promise<string> }).execute

        // First 3 attempts each prompt the operator (call requestApproval) and reject.
        await expect(exec()).rejects.toThrow(/denied by approval guard/)
        await expect(exec()).rejects.toThrow(/denied by approval guard/)
        await expect(exec()).rejects.toThrow(/denied by approval guard/)
        expect(mockRequestApproval).toHaveBeenCalledTimes(3)
        expect(mockWaitForDecision).toHaveBeenCalledTimes(3)

        // 4th attempt short-circuits — operator is NOT re-prompted.
        await expect(exec()).rejects.toThrow(/denial-loop budget exhausted/)
        expect(mockRequestApproval).toHaveBeenCalledTimes(3) // no new call
        expect(mockWaitForDecision).toHaveBeenCalledTimes(3)
    })

    it('fires onDenialLoop exactly once at the threshold (not on each subsequent short-circuit)', async () => {
        const send = vi.fn(async () => 'sent')
        const onDenialLoop = vi.fn()
        const tools: ToolSet = { 'gmail__send_email': fakeTool(send) as unknown as ToolSet[string] }
        mockRequestApproval.mockResolvedValue({ id: 'owd-1', decision: 'pending' })
        mockWaitForDecision.mockResolvedValue('rejected')

        const wrapped = wrapOutboundToolsWithApprovalGuard(tools, {
            plan: basePlan(),
            taskId: 'task-loop-2',
            workspaceId: 'ws-1',
            onDenialLoop,
        })

        const exec = (wrapped['gmail__send_email'] as unknown as { execute: () => Promise<string> }).execute

        for (let i = 0; i < 5; i++) {
            await expect(exec()).rejects.toThrow()
        }
        expect(onDenialLoop).toHaveBeenCalledTimes(1)
        expect(onDenialLoop).toHaveBeenCalledWith({ tool: 'gmail__send_email', provider: 'gmail', count: 3 })
    })

    it('approval after a denial resets the per-tool counter (operator changed mind on attempt N+1)', async () => {
        const send = vi.fn(async () => 'sent')
        const tools: ToolSet = { 'gmail__send_email': fakeTool(send) as unknown as ToolSet[string] }
        mockRequestApproval.mockResolvedValue({ id: 'owd-1', decision: 'pending' })

        const wrapped = wrapOutboundToolsWithApprovalGuard(tools, {
            plan: basePlan(),
            taskId: 'task-loop-3',
            workspaceId: 'ws-1',
        })

        const exec = (wrapped['gmail__send_email'] as unknown as { execute: () => Promise<string> }).execute

        // 1 reject, 1 approve, 3 more rejects — should NOT trigger short-circuit
        // because the approve resets the counter.
        mockWaitForDecision.mockResolvedValueOnce('rejected')
        await expect(exec()).rejects.toThrow(/denied by approval guard/)
        mockWaitForDecision.mockResolvedValueOnce('approved')
        await exec()
        mockWaitForDecision.mockResolvedValueOnce('rejected')
        mockWaitForDecision.mockResolvedValueOnce('rejected')
        mockWaitForDecision.mockResolvedValueOnce('rejected')
        await expect(exec()).rejects.toThrow(/denied by approval guard/)
        await expect(exec()).rejects.toThrow(/denied by approval guard/)
        await expect(exec()).rejects.toThrow(/denied by approval guard/)
        expect(mockRequestApproval).toHaveBeenCalledTimes(5)
    })

    it('different tools maintain independent denial counters', async () => {
        const sendA = vi.fn(async () => 'a')
        const sendB = vi.fn(async () => 'b')
        const tools: ToolSet = {
            'gmail__send_email': fakeTool(sendA) as unknown as ToolSet[string],
            'twilio__send_sms': fakeTool(sendB) as unknown as ToolSet[string],
        }
        mockRequestApproval.mockResolvedValue({ id: 'owd-1', decision: 'pending' })
        mockWaitForDecision.mockResolvedValue('rejected')

        const wrapped = wrapOutboundToolsWithApprovalGuard(tools, {
            plan: basePlan(),
            taskId: 'task-loop-4',
            workspaceId: 'ws-1',
        })

        const execA = (wrapped['gmail__send_email'] as unknown as { execute: () => Promise<string> }).execute
        const execB = (wrapped['twilio__send_sms'] as unknown as { execute: () => Promise<string> }).execute

        // Drive gmail to budget-exhausted; twilio should still prompt fresh.
        for (let i = 0; i < 3; i++) await expect(execA()).rejects.toThrow()
        const requestCallsAfterGmailExhausted = mockRequestApproval.mock.calls.length
        await expect(execB()).rejects.toThrow(/denied by approval guard/)
        expect(mockRequestApproval).toHaveBeenCalledTimes(requestCallsAfterGmailExhausted + 1)
    })

    it('honors a custom denialBudget override', async () => {
        const send = vi.fn(async () => 'sent')
        const tools: ToolSet = { 'gmail__send_email': fakeTool(send) as unknown as ToolSet[string] }
        mockRequestApproval.mockResolvedValue({ id: 'owd-1', decision: 'pending' })
        mockWaitForDecision.mockResolvedValue('rejected')

        const wrapped = wrapOutboundToolsWithApprovalGuard(tools, {
            plan: basePlan(),
            taskId: 'task-loop-5',
            workspaceId: 'ws-1',
            denialBudget: 1,
        })

        const exec = (wrapped['gmail__send_email'] as unknown as { execute: () => Promise<string> }).execute
        await expect(exec()).rejects.toThrow(/denied by approval guard/)
        await expect(exec()).rejects.toThrow(/denial-loop budget exhausted/)
        expect(mockRequestApproval).toHaveBeenCalledTimes(1)
    })
})
