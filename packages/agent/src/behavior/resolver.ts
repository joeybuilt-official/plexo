// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Behavior Resolution Engine (Phase 5).
 *
 * Merges platform defaults → workspace rules → project rules → task context
 * into a single ResolvedBehavior with a compiled system prompt fragment.
 *
 * Called by agent-loop before every task execution.
 */

import type { BehaviorRule, ResolvedRule, ResolvedBehavior, RuleSource, RuleValue } from './types.js'
import { PLATFORM_DEFAULT_RULES } from './types.js'
import { compileBehavior } from './compiler.js'

// ── Layer fetchers ────────────────────────────────────────────────────────────

async function getPlatformDefaults(workspaceId: string): Promise<BehaviorRule[]> {
    return PLATFORM_DEFAULT_RULES.map((r, i) => ({
        ...r,
        id: `platform-${i}`,
        workspaceId,
        projectId: null,
        overridesRuleId: null,
        deletedAt: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
    }))
}

async function getWorkspaceRules(workspaceId: string): Promise<BehaviorRule[]> {
    const { db, eq, isNull, and } = await import('@plexo/db')
    const { behaviorRules } = await import('@plexo/db')
    const rows = await db.select().from(behaviorRules)
        .where(and(
            eq(behaviorRules.workspaceId, workspaceId),
            isNull(behaviorRules.projectId),
            isNull(behaviorRules.deletedAt),
        ))
    return rows.map(r => ({
        ...r,
        value: r.value as RuleValue,
    }))
}

async function getProjectRules(workspaceId: string, projectId: string): Promise<BehaviorRule[]> {
    const { db, eq, and, isNull } = await import('@plexo/db')
    const { behaviorRules } = await import('@plexo/db')
    const rows = await db.select().from(behaviorRules)
        .where(and(
            eq(behaviorRules.workspaceId, workspaceId),
            eq(behaviorRules.projectId, projectId),
            isNull(behaviorRules.deletedAt),
        ))
    return rows.map(r => ({
        ...r,
        value: r.value as RuleValue,
    }))
}

// ── Merge logic ───────────────────────────────────────────────────────────────

function mergeRuleLayers(...layers: BehaviorRule[][]): ResolvedRule[] {
    const map = new Map<string, ResolvedRule>()

    for (const layer of layers) {
        for (const rule of layer) {
            const existing = map.get(rule.key)
            map.set(rule.key, {
                key: rule.key,
                label: rule.label,
                description: rule.description,
                type: rule.type,
                value: rule.value,
                locked: rule.locked,
                effectiveSource: rule.source as RuleSource,
                ruleId: rule.id,
                // Track what this overrides (the previous value in map)
                overriddenBy: existing
                    ? { ruleId: existing.ruleId, source: existing.effectiveSource }
                    : null,
            })
        }
    }

    return Array.from(map.values())
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

async function snapshotBehavior(
    workspaceId: string,
    projectId: string | null,
    resolved: ResolvedRule[],
    compiledPrompt: string,
    triggeredBy: string,
    triggerResourceId?: string,
): Promise<void> {
    try {
        const { db } = await import('@plexo/db')
        const { behaviorSnapshots } = await import('@plexo/db')
        await db.insert(behaviorSnapshots).values({
            workspaceId,
            projectId,
            snapshot: resolved as unknown as Record<string, unknown>[],
            compiledPrompt,
            triggeredBy,
            triggerResourceId,
        })
    } catch {
        // Non-fatal — snapshot failure should not block task execution
    }
}

// ── Main resolver ─────────────────────────────────────────────────────────────

export async function resolveBehavior(
    workspaceId: string,
    projectId: string | null = null,
    taskContext: BehaviorRule[] = [],
    opts: { snapshot?: boolean; triggeredBy?: string; triggerResourceId?: string } = {},
): Promise<ResolvedBehavior> {
    const [platform, workspace, project] = await Promise.all([
        getPlatformDefaults(workspaceId),
        getWorkspaceRules(workspaceId).catch(() => [] as BehaviorRule[]),
        projectId ? getProjectRules(workspaceId, projectId).catch(() => [] as BehaviorRule[]) : Promise.resolve([] as BehaviorRule[]),
    ])

    const resolved = mergeRuleLayers(platform, workspace, project, taskContext)
    const compiledPrompt = compileBehavior(resolved)

    if (opts.snapshot !== false) {
        void snapshotBehavior(
            workspaceId,
            projectId,
            resolved,
            compiledPrompt,
            opts.triggeredBy ?? 'manual',
            opts.triggerResourceId,
        )
    }

    return {
        workspaceId,
        projectId,
        resolvedAt: new Date(),
        rules: resolved,
        compiledPrompt,
    }
}
