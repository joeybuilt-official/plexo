// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 10 — Memory namespacing helpers.
 *
 * Multiple PEX agents can live in one workspace. Before this phase, every
 * agent wrote into the same workspace-scoped slice of `memory_entries` /
 * `workspace_preferences`, so agent A could see and clobber agent B's
 * principles. Namespacing gives each agent its own slice while keeping
 * two escape hatches:
 *
 *  1. **'default'** — the single slice every pre-Phase-10 row lives in.
 *     Any caller that doesn't pass a namespace reads and writes here, so
 *     the primary workspace agent keeps working without code changes.
 *
 *  2. **'shared'** — read by every agent (via {@link sharedNamespaces})
 *     but only ever written by the explicit `writeShared` helper exported
 *     from `store.ts`. Use it for cross-agent knowledge that all agents
 *     in a workspace should benefit from.
 */

/** The fallback namespace used when no agent identity is available. */
export const DEFAULT_NAMESPACE = 'default' as const

/** The cross-agent namespace — readable by all, writable only via the
 *  explicit `writeShared` helper in store.ts. */
export const SHARED_NAMESPACE = 'shared' as const

/**
 * Resolve the default namespace for a given agent id.
 *
 * - `agentId` present → `agent-${agentId}` (per-agent slice)
 * - `agentId` absent  → `'default'` (backward-compatible slice)
 *
 * Empty string / whitespace-only ids collapse to `'default'` so a buggy
 * caller can never accidentally create a bogus `agent-` namespace.
 */
export function defaultNamespaceForAgent(agentId?: string | null): string {
    if (!agentId) return DEFAULT_NAMESPACE
    const trimmed = agentId.trim()
    if (trimmed.length === 0) return DEFAULT_NAMESPACE
    return `agent-${trimmed}`
}

/**
 * Return the list of namespaces a read call should span so the agent sees
 * both its own memories and the cross-agent 'shared' slice.
 *
 * - With `agentId`: `['agent-<id>', 'shared']`
 * - Without `agentId`: `['default', 'shared']`
 *
 * Callers that want stricter isolation (per-agent only, ignore shared)
 * should pass `namespace: defaultNamespaceForAgent(id)` directly instead
 * of calling this helper.
 */
export function sharedNamespaces(agentId?: string | null): string[] {
    return [defaultNamespaceForAgent(agentId), SHARED_NAMESPACE]
}

/**
 * True iff the given namespace is the special 'shared' slice. Writes to
 * the shared slice MUST go through an explicit `writeShared` code path —
 * never as a side effect of a plain `storeMemory` call — so this guard
 * lives here as the single source of truth.
 */
export function isSharedNamespace(namespace: string | undefined): boolean {
    return namespace === SHARED_NAMESPACE
}
