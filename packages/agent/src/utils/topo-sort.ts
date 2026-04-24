// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Topological sort — execution wave builder.
 *
 * Given a list of nodes with dependency edges, returns groups (waves) where
 * every node in a wave has all its dependencies satisfied by prior waves.
 * Nodes in the same wave are independent and can execute in parallel.
 *
 * Cycle handling: if a cycle is detected (no progress in an iteration), all
 * remaining nodes are emitted as a single final wave so the caller is never
 * silently dropped.
 */

export interface TopoNode {
    id: string
    depends_on: string[]
}

/**
 * Build execution waves from a dependency graph.
 * @returns Array of waves; each wave is an array of node IDs.
 */
export function buildExecutionWaves(nodes: TopoNode[]): string[][] {
    const idSet = new Set(nodes.map((n) => n.id))
    const resolved = new Set<string>()
    const waves: string[][] = []
    let remaining = [...nodes]

    while (remaining.length > 0) {
        const wave = remaining.filter((n) =>
            n.depends_on.every((dep) => !idSet.has(dep) || resolved.has(dep)),
        )

        if (wave.length === 0) {
            // Cycle detected — emit the rest as one wave to avoid infinite loop
            console.warn('[topo-sort] Cycle detected — dumping remaining nodes into single wave', {
                remainingNodes: remaining.map((n) => n.id),
            })
            waves.push(remaining.map((n) => n.id))
            break
        }

        waves.push(wave.map((n) => n.id))
        for (const n of wave) resolved.add(n.id)
        remaining = remaining.filter((n) => !resolved.has(n.id))
    }

    return waves
}
