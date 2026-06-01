// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Orchestrator fan-out — parent task spawns N independent child tasks,
 * waits for all to reach a terminal state, then aggregates to one outcome.
 *
 * Migration 0124 applied — fanout_depth + fanout_total are proper columns.
 * All dispatch logic is behind FANOUT_ENABLED=false.
 *
 * Design decisions:
 *   MAX_FANOUT_DEPTH = 1   — children cannot themselves fan-out (no grandchildren).
 *                            Enforced synchronously before any DB write.
 *   MAX_FANOUT_CHILDREN = 20 — hard cap per dispatch call.
 *   Partial-failure policy = proceed_with_successes — join fires when ALL
 *                            children are terminal (any status); failed children
 *                            contribute to an error digest rather than aborting
 *                            the successful majority. See pre-mortem in progress.md.
 *   Connector inheritance  — children get parent connectorIds or a NARROWER subset.
 *                            Broader scope is rejected at dispatch time.
 *                            parent [] → children []: deny-all preserved.
 *
 * Join detection: poll via checkFanoutJoin(). The caller (agent-loop) polls
 * until all children terminal, then calls resolveParent() to complete the parent.
 */

import { logger } from '../logger.js'

// true by default — emergency kill-switch: set FANOUT_ENABLED=false in container env.
// Reads env at module load; vi.resetModules() + process.env allows test override.
export const FANOUT_ENABLED = process.env.FANOUT_ENABLED !== 'false'

export const MAX_FANOUT_CHILDREN = 20
export const MAX_FANOUT_DEPTH = 1

/** Terminal statuses — join fires when every child is in one of these. */
const TERMINAL = new Set(['complete', 'failed', 'cancelled'] as const)

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ChildSpec {
    /** User message / prompt for this child task. */
    userMessage: string
    /** Connector IDs this child may use. Must be ⊆ parent's connectorIds. */
    connectorIds?: string[]
    /** Per-child context overrides (merged onto parent context). */
    contextOverrides?: Record<string, unknown>
}

export interface FanoutOpts {
    parentTaskId: string
    children: ChildSpec[]
    /** Partial-failure policy. Default: 'proceed_with_successes'. */
    policy?: 'proceed_with_successes'
}

export interface FanoutResult {
    skipped: boolean
    skipReason?: string
    parentTaskId: string
    childTaskIds?: string[]
    childCount?: number
}

export interface ChildOutcome {
    taskId: string
    status: 'complete' | 'failed' | 'cancelled'
    outcomeSummary: string | null
    failureReason: string | null
    tokensIn: number
    tokensOut: number
    costUsd: number
}

export interface FanoutJoinResult {
    ready: boolean        // false = children still running
    nTotal: number
    nComplete: number
    nFailed: number
    nCancelled: number
    children: ChildOutcome[]
    /** Aggregated summary for the parent task's outcomeSummary field. */
    aggregateSummary: string
    /** Aggregate token + cost totals for completeTask call. */
    totalTokensIn: number
    totalTokensOut: number
    totalCostUsd: number
}

// ── spawnFanout ───────────────────────────────────────────────────────────────

/**
 * Spawn N child tasks for a parent task. Validates depth, connector scope,
 * and child count before any DB write.
 *
 * Stores each child's _fanoutDepth in its context. Sets parent's context
 * field _fanoutTotal = N via DB update.
 *
 * Non-fatal on individual push failure: failed pushes are logged and excluded
 * from childTaskIds. The caller should abort if childTaskIds.length < expected.
 */
export async function spawnFanout(opts: FanoutOpts): Promise<FanoutResult> {
    if (!FANOUT_ENABLED) {
        logger.debug({ parentTaskId: opts.parentTaskId }, 'fanout: disabled (FANOUT_ENABLED=false)')
        return { skipped: true, skipReason: 'FANOUT_ENABLED=false', parentTaskId: opts.parentTaskId }
    }

    const { db, eq, tasks } = await import('@plexo/db')
    const { push } = await import('@plexo/queue')

    // 1. Fetch parent
    const [parent] = await db.select({
        id:            tasks.id,
        workspaceId:   tasks.workspaceId,
        source:        tasks.source,
        context:       tasks.context,
        costCeilingUsd: tasks.costCeilingUsd,
        fanoutDepth:   tasks.fanoutDepth,
    }).from(tasks).where(eq(tasks.id, opts.parentTaskId)).limit(1)

    if (!parent) {
        return { skipped: true, skipReason: 'parent_not_found', parentTaskId: opts.parentTaskId }
    }

    const ctx = parent.context as Record<string, unknown>

    // 2. Depth check — blocks grandchildren (reads column, not context)
    const parentDepth = parent.fanoutDepth
    if (parentDepth >= MAX_FANOUT_DEPTH) {
        return {
            skipped: true,
            skipReason: `depth_cap_exceeded (parent depth=${parentDepth}, max=${MAX_FANOUT_DEPTH})`,
            parentTaskId: opts.parentTaskId,
        }
    }

    // 3. Children count cap
    const children = opts.children.slice(0, MAX_FANOUT_CHILDREN)
    if (opts.children.length > MAX_FANOUT_CHILDREN) {
        logger.warn({ parentTaskId: opts.parentTaskId, requested: opts.children.length, cap: MAX_FANOUT_CHILDREN }, 'fanout: children count capped')
    }

    // 4. Parent connector scope (from context — set by agent-loop from task.context.connectorIds)
    const parentConnectorIds: string[] | undefined =
        Array.isArray(ctx.connectorIds) ? (ctx.connectorIds as string[]) : undefined

    // 5. Per-child cost ceiling (parent ceiling ÷ N, floor $0.10)
    const MIN_CHILD_CEILING = 0.10
    const perChildCeiling = parent.costCeilingUsd != null
        ? Math.max(MIN_CHILD_CEILING, parent.costCeilingUsd / children.length)
        : undefined

    const childDepth = parentDepth + 1

    // 6. Validate and push children
    const childTaskIds: string[] = []
    for (const spec of children) {
        // Connector scope enforcement: child must be ⊆ parent
        const childConnectors = resolveChildConnectors(parentConnectorIds, spec.connectorIds)
        if (childConnectors === 'scope_violation') {
            logger.error({ parentTaskId: opts.parentTaskId, childConnectors: spec.connectorIds, parentConnectors: parentConnectorIds }, 'fanout: child connector scope violation — skipping child')
            continue
        }

        try {
            const childId = await push({
                workspaceId: parent.workspaceId,
                type: 'general',
                source: parent.source,
                parentId: opts.parentTaskId,
                costCeilingUsd: perChildCeiling,
                context: {
                    ...ctx,
                    ...(spec.contextOverrides ?? {}),
                    userMessage: spec.userMessage,
                    connectorIds: childConnectors,
                    _fanoutDepth: childDepth,
                    _fanoutParentId: opts.parentTaskId,
                },
            })
            childTaskIds.push(childId)
        } catch (err) {
            logger.warn({ err, parentTaskId: opts.parentTaskId }, 'fanout: child push failed — continuing')
        }
    }

    // 7. Record fanoutTotal column + set fanoutDepth on each child (column, not context)
    if (childTaskIds.length > 0) {
        await db.update(tasks)
            .set({ fanoutTotal: childTaskIds.length })
            .where(eq(tasks.id, opts.parentTaskId))
        for (const childId of childTaskIds) {
            await db.update(tasks)
                .set({ fanoutDepth: childDepth })
                .where(eq(tasks.id, childId))
        }
    }

    logger.info({ parentTaskId: opts.parentTaskId, childCount: childTaskIds.length, depth: childDepth }, 'fanout: children spawned')

    return {
        skipped: false,
        parentTaskId: opts.parentTaskId,
        childTaskIds,
        childCount: childTaskIds.length,
    }
}

// ── checkFanoutJoin ───────────────────────────────────────────────────────────

/**
 * Poll join readiness for a fan-out parent. Returns ready=false if any child
 * is still running. When all terminal, returns aggregated outcome.
 *
 * Policy: proceed_with_successes — failed children contribute to error digest,
 * do not block the join.
 */
export async function checkFanoutJoin(parentTaskId: string): Promise<FanoutJoinResult> {
    if (!FANOUT_ENABLED) {
        return _emptyJoin(false)
    }

    const { db, eq, tasks } = await import('@plexo/db')

    const rows = await db.select({
        id:             tasks.id,
        status:         tasks.status,
        outcomeSummary: tasks.outcomeSummary,
        failureReason:  tasks.failureReason,
        tokensIn:       tasks.tokensIn,
        tokensOut:      tasks.tokensOut,
        costUsd:        tasks.costUsd,
    }).from(tasks).where(eq(tasks.parentId, parentTaskId))

    if (rows.length === 0) return _emptyJoin(false)

    const nonTerminal = rows.filter(r => !TERMINAL.has(r.status as 'complete' | 'failed' | 'cancelled'))
    if (nonTerminal.length > 0) return _emptyJoin(false, rows.length)

    // All terminal — aggregate
    const children: ChildOutcome[] = rows.map(r => ({
        taskId:         r.id,
        status:         r.status as 'complete' | 'failed' | 'cancelled',
        outcomeSummary: r.outcomeSummary ?? null,
        failureReason:  r.failureReason ?? null,
        tokensIn:       r.tokensIn ?? 0,
        tokensOut:      r.tokensOut ?? 0,
        costUsd:        r.costUsd ?? 0,
    }))

    const nComplete  = children.filter(c => c.status === 'complete').length
    const nFailed    = children.filter(c => c.status === 'failed').length
    const nCancelled = children.filter(c => c.status === 'cancelled').length

    const successLines = children
        .filter(c => c.status === 'complete' && c.outcomeSummary)
        .map((c, i) => `[${i + 1}] ${c.outcomeSummary}`)
        .join('\n')

    const failureLines = children
        .filter(c => c.status !== 'complete')
        .map(c => `[${c.taskId.slice(-6)}] ${c.status}: ${c.failureReason ?? c.outcomeSummary ?? 'no detail'}`)
        .join('\n')

    const aggregateSummary = [
        `Fan-out complete: ${nComplete}/${rows.length} subtasks succeeded.`,
        successLines && `\nSuccesses:\n${successLines}`,
        failureLines && `\nFailures (${nFailed + nCancelled}):\n${failureLines}`,
    ].filter(Boolean).join('')

    return {
        ready:        true,
        nTotal:       rows.length,
        nComplete,
        nFailed,
        nCancelled,
        children,
        aggregateSummary,
        totalTokensIn:  children.reduce((s, c) => s + c.tokensIn, 0),
        totalTokensOut: children.reduce((s, c) => s + c.tokensOut, 0),
        totalCostUsd:   children.reduce((s, c) => s + c.costUsd, 0),
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve the effective connectorIds for a child task.
 *
 * Security boundary: child scope must be ⊆ parent scope. Returns
 * 'scope_violation' if child requests connectors not held by parent.
 *
 *   parent undefined   = allow-all (interactive parent)
 *   parent []          = deny-all → child must also be [] or undefined
 *   child undefined    = inherit parent scope exactly
 *   child []           = deny-all (always valid — narrower)
 *   child ['x','y']    = must be subset of parent; returns intersection if so
 */
export function resolveChildConnectors(
    parentIds: string[] | undefined,
    childIds: string[] | undefined,
): string[] | undefined | 'scope_violation' {
    // Parent deny-all: child must also be deny-all or omitted
    if (parentIds !== undefined && parentIds.length === 0) {
        if (childIds === undefined || childIds.length === 0) return []
        return 'scope_violation'
    }

    // Child inherits parent scope if not specified
    if (childIds === undefined) return parentIds

    // Child deny-all is always valid (narrower than anything)
    if (childIds.length === 0) return []

    // Parent allow-all: child can request any connectors
    if (parentIds === undefined) return childIds

    // Verify every requested child connector is in the parent set
    const parentSet = new Set(parentIds)
    for (const id of childIds) {
        if (!parentSet.has(id)) return 'scope_violation'
    }
    return childIds
}

function _emptyJoin(ready: boolean, nTotal = 0): FanoutJoinResult {
    return {
        ready, nTotal, nComplete: 0, nFailed: 0, nCancelled: 0,
        children: [], aggregateSummary: '', totalTokensIn: 0, totalTokensOut: 0, totalCostUsd: 0,
    }
}
