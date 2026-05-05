// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase L5 unit tests — `elevateOutboundOneWayDoors` (07-DEFERRED.md #8).
 *
 * Pins fix-B for Tom's blocker: any plan step whose `toolsRequired[]` contains
 * a tool name matching the outbound predicate (`__send_` / `__reply_` /
 * `__post_`) MUST be elevated to a one-way door before agent-loop computes
 * `mustGate`. This protects existing workspaces — those with
 * `requireApprovalForGeneralTasks: false` — from a planner LLM that fails to
 * tag outbound channel calls as one-way doors (because drafting/queuing is
 * technically reversible, even though the moment the message leaves the
 * system it isn't).
 *
 * Contract (per ADR 0006 + landed implementation in one-way-door.ts):
 *   - `isOutboundChannelTool(toolName)` returns true for names containing
 *     `__send_`, `__reply_`, or `__post_`.
 *   - `elevateOutboundOneWayDoors(plan)` is pure — it does NOT mutate the
 *     input plan. It returns
 *       { addedTools: string[], oneWayDoors: OWD[] }
 *     where `oneWayDoors` is the merged list (existing + synthesized).
 *     Synthesized OWD shape:
 *       { description: string (contains the offending tool name),
 *         type: 'external_call',
 *         reversibility: string,
 *         requiresApproval: true }
 *   - Dedupe (two layers):
 *       (a) tool-level: each outbound tool name produces at most one OWD even
 *           if it appears in multiple steps;
 *       (b) classifier-level: if `oneWayDoors[]` already contains an entry
 *           whose `description` references the tool name, no new OWD is
 *           synthesized for that tool.
 *   - Non-outbound tools (`read_file`, `gmail__list_messages`) are NOT
 *     elevated.
 */

import { describe, it, expect } from 'vitest'
import {
    elevateOutboundOneWayDoors,
    isOutboundChannelTool,
} from '../one-way-door.js'
import type { ExecutionPlan } from '../types.js'

function basePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
    return {
        taskId: 'task-l5-001',
        goal: 'send something to a user',
        steps: [],
        oneWayDoors: [],
        estimatedDurationMs: 30_000,
        confidenceScore: 0.9,
        risks: [],
        ...overrides,
    }
}

// ── isOutboundChannelTool ──────────────────────────────────────────────────

describe('isOutboundChannelTool', () => {
    it('matches __send_ tools', () => {
        expect(isOutboundChannelTool('gmail__send_email')).toBe(true)
        expect(isOutboundChannelTool('twilio__send_sms')).toBe(true)
        expect(isOutboundChannelTool('levio__send_email')).toBe(true)
    })

    it('matches __reply_ tools', () => {
        expect(isOutboundChannelTool('gmail__reply_thread')).toBe(true)
    })

    it('matches __post_ tools', () => {
        expect(isOutboundChannelTool('slack__post_message')).toBe(true)
        expect(isOutboundChannelTool('discord__post_message')).toBe(true)
    })

    it('does NOT match non-outbound tools', () => {
        expect(isOutboundChannelTool('read_file')).toBe(false)
        expect(isOutboundChannelTool('gmail__list_messages')).toBe(false)
        expect(isOutboundChannelTool('search_web')).toBe(false)
    })
})

// ── elevateOutboundOneWayDoors ─────────────────────────────────────────────

describe('elevateOutboundOneWayDoors — Test 2: outbound elevation when policy is OFF', () => {
    it('elevates a single gmail__send_email step into a synthesized OWD', () => {
        const plan = basePlan({
            steps: [{
                stepNumber: 1,
                description: 'Send the welcome email',
                toolsRequired: ['gmail__send_email'],
                verificationMethod: 'Confirm send',
                isOneWayDoor: false,
            }],
            oneWayDoors: [],
        })

        const result = elevateOutboundOneWayDoors(plan)

        expect(result.addedTools.length).toBe(1)
        expect(result.addedTools).toEqual(['gmail__send_email'])
        expect(result.oneWayDoors).toHaveLength(1)
        const elevated = result.oneWayDoors[0]!
        expect(elevated.type).toBe('external_call')
        expect(elevated.requiresApproval).toBe(true)
        // Synthesized description must reference the offending tool name so
        // operators reading the CONFIRM card can see what's about to fire.
        expect(elevated.description).toContain('gmail__send_email')
    })

    it('elevates each distinct outbound tool when a step requires multiple', () => {
        const plan = basePlan({
            steps: [{
                stepNumber: 1,
                description: 'Notify user across channels',
                toolsRequired: ['gmail__send_email', 'slack__post_message'],
                verificationMethod: 'Confirm both',
                isOneWayDoor: false,
            }],
            oneWayDoors: [],
        })

        const result = elevateOutboundOneWayDoors(plan)

        // Two distinct outbound tools → two synthesized OWDs.
        expect(result.addedTools.length).toBe(2)
        expect(result.addedTools).toEqual(
            expect.arrayContaining(['gmail__send_email', 'slack__post_message']),
        )
        expect(result.oneWayDoors).toHaveLength(2)
        expect(result.oneWayDoors.every((d) => d.type === 'external_call')).toBe(true)
        expect(result.oneWayDoors.every((d) => d.requiresApproval === true)).toBe(true)
    })

    it('does NOT mutate the input plan (pure function)', () => {
        const plan = basePlan({
            steps: [{
                stepNumber: 1,
                description: 'Send notification',
                toolsRequired: ['gmail__send_email'],
                verificationMethod: 'Confirm send',
                isOneWayDoor: false,
            }],
            oneWayDoors: [],
        })

        elevateOutboundOneWayDoors(plan)
        expect(plan.oneWayDoors).toHaveLength(0)
    })
})

describe('elevateOutboundOneWayDoors — Test 3: non-outbound tools do NOT elevate', () => {
    it('returns addedTools=[] for read_file', () => {
        const plan = basePlan({
            steps: [{
                stepNumber: 1,
                description: 'Read the spec file',
                toolsRequired: ['read_file'],
                verificationMethod: 'inspect output',
                isOneWayDoor: false,
            }],
            oneWayDoors: [],
        })

        const result = elevateOutboundOneWayDoors(plan)
        expect(result.addedTools.length).toBe(0)
        expect(result.addedTools).toHaveLength(0)
        expect(result.oneWayDoors).toHaveLength(0)
    })

    it('does not elevate gmail__list_messages (read-only, despite the gmail prefix)', () => {
        const plan = basePlan({
            steps: [{
                stepNumber: 1,
                description: 'List inbox',
                toolsRequired: ['gmail__list_messages'],
                verificationMethod: 'count > 0',
                isOneWayDoor: false,
            }],
            oneWayDoors: [],
        })

        const result = elevateOutboundOneWayDoors(plan)
        expect(result.addedTools.length).toBe(0)
        expect(result.oneWayDoors).toHaveLength(0)
    })
})

describe('elevateOutboundOneWayDoors — Test 4: dedupe', () => {
    it('does NOT synthesize a duplicate OWD when one already references the same tool name', () => {
        const plan = basePlan({
            steps: [{
                stepNumber: 1,
                description: 'Send the welcome email',
                toolsRequired: ['gmail__send_email'],
                verificationMethod: 'Confirm send',
                isOneWayDoor: true,
            }],
            // Planner already correctly classified this step. The elevation
            // pass must not double-count.
            oneWayDoors: [{
                description: 'Sending email via gmail__send_email to user',
                // Cast: backend-B's elevation accepts the wider OWD shape
                // (`type: string`); the canonical OneWayDoor.type union is
                // narrower until extended.
                type: 'external_call' as never,
                reversibility: 'cannot retract',
                requiresApproval: true,
            }],
        })

        const result = elevateOutboundOneWayDoors(plan)
        // No new OWD was synthesized — the existing one already covers the tool.
        expect(result.addedTools.length).toBe(0)
        expect(result.addedTools).toHaveLength(0)
        // The merged list is just the existing entry, length 1.
        expect(result.oneWayDoors).toHaveLength(1)
    })

    it('dedupes within a single plan when the same outbound tool appears in multiple steps', () => {
        const plan = basePlan({
            steps: [
                {
                    stepNumber: 1,
                    description: 'Send first email',
                    toolsRequired: ['gmail__send_email'],
                    verificationMethod: 'ack',
                    isOneWayDoor: false,
                },
                {
                    stepNumber: 2,
                    description: 'Send follow-up email',
                    toolsRequired: ['gmail__send_email'],
                    verificationMethod: 'ack',
                    isOneWayDoor: false,
                },
            ],
            oneWayDoors: [],
        })

        const result = elevateOutboundOneWayDoors(plan)
        // Two steps reference the same tool → only one OWD synthesized.
        expect(result.addedTools.length).toBe(1)
        expect(result.addedTools).toEqual(['gmail__send_email'])
    })
})
