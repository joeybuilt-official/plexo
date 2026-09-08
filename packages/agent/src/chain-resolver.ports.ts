// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Routing-chain persistence port (Stage 3, providers cluster).
 *
 * `providers/chain-resolver.ts` resolves a workspace's per-task-type routing
 * chain; this port abstracts the single read it needs. The drizzle adapter
 * (`chain-resolver.repository.ts`) is the only chain-resolver module permitted
 * to import the ORM. The 60s cache, the `ChainTaskType` keying, and the
 * soft-fail-to-empty behavior stay in the use case — the port returns plain
 * rows, never drizzle result shapes.
 */

/** One `routing_chains` row, joined with its provider's type, camelCased. */
export interface WorkspaceChainRow {
    id: string
    taskType: string
    providerId: string
    /** From `provider_instances.provider_type`; null when the join misses. */
    providerType: string | null
    modelId: string
    position: number
}

export interface ChainResolverStore {
    /**
     * Every routing-chain row for one workspace, ordered by task type then
     * `position`. Rejects on a DB failure; the caller decides what that means.
     */
    loadWorkspaceChains(workspaceId: string): Promise<WorkspaceChainRow[]>
}
