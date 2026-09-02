// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Persistence port for the behavior resolution engine (Stage 2).
 *
 * `behavior/resolver.ts` merges platform/workspace/project rule layers and
 * snapshots the result; this port abstracts the two rule reads and the snapshot
 * write. The drizzle adapter (`behavior.repository.ts`) is the only behavior-area
 * module permitted to import the ORM. (Distinct from `BehaviorRuleStore` in
 * `memory.ports.ts`, which is the corrections/reflection CRUD path.)
 */

import type { BehaviorRule } from './behavior/types.js'

export interface BehaviorSnapshotInsert {
    workspaceId: string
    projectId: string | null
    snapshot: Record<string, unknown>[]
    compiledPrompt: string
    triggeredBy: string
    triggerResourceId?: string
}

export interface BehaviorResolutionStore {
    /** Active workspace-level rules (no project, not deleted). */
    listWorkspaceRules(workspaceId: string): Promise<BehaviorRule[]>
    /** Active rules for a specific project (not deleted). */
    listProjectRules(workspaceId: string, projectId: string): Promise<BehaviorRule[]>
    /** Persist a resolved-behavior snapshot (best-effort; caller swallows failure). */
    insertSnapshot(input: BehaviorSnapshotInsert): Promise<void>
}
