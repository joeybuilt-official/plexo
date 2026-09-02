// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Behavior Resolution Engine (Phase 5).
 *
 * Merges platform defaults → workspace rules → project rules → task context
 * into a single ResolvedBehavior with a compiled system prompt fragment.
 *
 * Called by agent-loop before every task execution.
 */

import type { BehaviorRule, ResolvedRule, ResolvedBehavior, RuleSource } from './types.js'
import { PLATFORM_DEFAULT_RULES } from './types.js'
import { compileBehavior } from './compiler.js'
import { computeContextHash } from '../domain-mastery/index.js'
import { DrizzleBehaviorResolutionStore } from '../behavior.repository.js'
import type { BehaviorResolutionStore } from '../behavior.ports.js'

// ── Composition root + test seam ────────────────────────────────────────────
let store: BehaviorResolutionStore = new DrizzleBehaviorResolutionStore()

/** Swap the behavior resolution store (e.g. an in-memory fake in unit tests). */
export function setBehaviorResolutionStore(next: BehaviorResolutionStore): void {
    store = next
}

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
    return store.listWorkspaceRules(workspaceId)
}

async function getProjectRules(workspaceId: string, projectId: string): Promise<BehaviorRule[]> {
    return store.listProjectRules(workspaceId, projectId)
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
        await store.insertSnapshot({
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

    // Domain mastery: compute context hash for credit assignment (ADR-003).
    // Includes only domain_knowledge rules from reflection — platform/workspace
    // static rules are excluded since they don't participate in the learning loop.
    const learningRuleKeys = resolved
        .filter(r => r.effectiveSource === 'reflection' || r.type === 'domain_knowledge')
        .map(r => r.key)
    const ctxHash = computeContextHash(learningRuleKeys)

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
        contextHash: ctxHash?.hash ?? null,
        contextRuleKeys: ctxHash?.ruleKeys ?? [],
    }
}
