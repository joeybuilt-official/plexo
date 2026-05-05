// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * L5b (ADR 0006 §D5) — Executor-side mid-stream approval guard for outbound
 * connection tools.
 *
 * Why this exists: the planner-time elevation pass (`elevateOutboundOneWayDoors`
 * in `../one-way-door.ts`) operates on `plan.steps[].toolsRequired[]`, but the
 * executor passes the FULL connection-tool surface to the LLM via
 * `generateText({ tools })`. A planner that emits `toolsRequired: []` (or an
 * inaccurate set) but a step description like "Send Bob the launch email"
 * still lets the executor LLM call `gmail__send_email` without elevation
 * having synthesized a covering OWD. Plexo processes untrusted inbound
 * (email/SMS) — a prompt-injected planner is the load-bearing threat model.
 *
 * What this does: at executor's tool-assembly time (BEFORE the cached
 * connection-tool surface is merged into the per-step `tools` map), wrap each
 * outbound tool's `execute` handler with a check that:
 *   1. Inspects `plan.oneWayDoors[]` for a covering entry (description
 *      includes the tool name — matches both planner-emitted OWDs that
 *      named the tool and the L5 elevation pass output).
 *   2. If covered, passes through to the original execute (mustGate already
 *      fired and the operator approved at plan-time).
 *   3. If absent, fires `onOutboundUncovered` for telemetry, synthesizes an
 *      ad-hoc OWD, awaits `requestApproval` at `riskLevel: 'high'` (matches
 *      L5 D2 — bypasses standing approvals per SEC-016), then if pending
 *      polls `waitForDecision`. On `'approved'` invokes the original; on
 *      `'rejected' | 'timeout'` throws to abort the tool call.
 *
 * Layering: this module lives in the agent package. The metrics counter
 * `plexo_outbound_tool_call_uncovered_total` is registered in
 * `apps/api/src/lib/metrics.ts`; the wrap reports up via the
 * `onOutboundUncovered` callback that the API layer wires into
 * `ExecutionContext` so the agent layer never imports from `apps/api`.
 *
 * Risk-level invariant: synthesized OWDs MUST be `'high'`. If they were
 * `'medium'`, a workspace-wide standing approval keyed on the tool name could
 * silently bypass the wrap (per Phase K Item 15b's policy-only-gate footgun
 * counter). `'high'` activates SEC-016's standing-approval lockout.
 */

import type { ToolSet } from 'ai'
import { isOutboundChannelTool, requestApproval, waitForDecision } from '../one-way-door.js'

interface PlanOWDLike {
    description?: string
    type?: string
    requiresApproval?: boolean
}

export interface ApprovalGuardContext {
    /**
     * The task's plan. `oneWayDoors[]` is the source of truth for what the
     * operator already approved at plan-time. Read at execute-time so a
     * mid-task replan that adds covering OWDs gets respected on subsequent
     * tool calls.
     */
    plan: { oneWayDoors?: ReadonlyArray<PlanOWDLike> }
    taskId: string
    workspaceId: string
    /**
     * Reports up to the API layer for `plexo_outbound_tool_call_uncovered_total`.
     * Optional so unit tests can omit it; production always wires it.
     */
    onUncovered?: (params: { tool: string; provider: string }) => void
}

/**
 * Coverage rule (Stage 3 tightened): a plan OWD covers a tool call IFF
 *   - it is an `external_call` type, AND
 *   - it requires approval, AND
 *   - its description contains the tool name.
 * The triple-AND closes a substring-confusion exploit a hostile planner
 * could ride: an OWD with description "do NOT send via gmail__send_email"
 * (or any prose mentioning the tool name without intending to authorize it)
 * no longer auto-covers the call. The L5 elevation pass output sets both
 * `type: 'external_call'` and `requiresApproval: true` so its synthesized
 * OWDs still count as covering — no break.
 */
function isCoveredByPlan(toolName: string, owds: ReadonlyArray<PlanOWDLike>): boolean {
    for (const owd of owds) {
        if (owd.type !== 'external_call') continue
        if (owd.requiresApproval !== true) continue
        if (typeof owd.description !== 'string') continue
        if (owd.description.includes(toolName)) return true
    }
    return false
}

function providerOf(toolName: string): string {
    // Default to 'unknown' so the metric series never carries an empty label.
    return toolName.split('__')[0] || 'unknown'
}

/**
 * Wrap every outbound connection tool in `tools` with an approval-required
 * guard. Non-outbound tools (per `isOutboundChannelTool`) pass through
 * unchanged. The returned `ToolSet` shares object identity for non-outbound
 * tools and replaces outbound tools with new objects whose `execute` is the
 * wrapped version (the original tool's `description` / `inputSchema` are
 * preserved by reference via spread).
 *
 * Idempotent on repeated invocation (re-wrapping a wrapped tool is harmless
 * because the inner check sees the same plan and returns the same verdict).
 */
export function wrapOutboundToolsWithApprovalGuard(
    tools: ToolSet,
    ctx: ApprovalGuardContext,
): ToolSet {
    const wrapped: ToolSet = {}
    for (const [name, tool] of Object.entries(tools)) {
        if (!isOutboundChannelTool(name)) {
            wrapped[name] = tool
            continue
        }
        const original = tool as { execute?: (...args: unknown[]) => unknown } & Record<string, unknown>
        const originalExecute = original.execute
        if (typeof originalExecute !== 'function') {
            // Tool has no execute (provider-side tool, etc.) — leave it alone.
            wrapped[name] = tool
            continue
        }
        wrapped[name] = {
            ...original,
            execute: async (...args: unknown[]) => {
                const owds = ctx.plan.oneWayDoors ?? []
                if (isCoveredByPlan(name, owds)) {
                    return originalExecute.call(original, ...args)
                }

                // Uncovered outbound call: telemetry + fresh approval cycle.
                ctx.onUncovered?.({ tool: name, provider: providerOf(name) })

                const description = `Outbound channel call: ${name} — planner did not pre-approve this tool. Approve to allow this single invocation.`
                const record = await requestApproval({
                    taskId: ctx.taskId,
                    workspaceId: ctx.workspaceId,
                    operation: name,
                    description,
                    // SEC-016 invariant — do not weaken. 'high' bypasses
                    // standing approvals at one-way-door.ts:187 so a workspace
                    // standing rule keyed on the tool name cannot silently
                    // auto-approve outbound calls.
                    riskLevel: 'high',
                })

                // requestApproval returns 'approved' immediately when a
                // standing approval matches; for 'high' risk SEC-016 forbids
                // that, but keep the early-return shape for forward-compat
                // if the policy ever loosens.
                if (record.decision === 'approved') {
                    return originalExecute.call(original, ...args)
                }
                const decision = await waitForDecision(record.id)
                if (decision === 'approved') {
                    return originalExecute.call(original, ...args)
                }
                throw new Error(
                    `Outbound tool call denied by approval guard: ${name} (decision=${decision})`,
                )
            },
        } as ToolSet[string]
    }
    return wrapped
}
