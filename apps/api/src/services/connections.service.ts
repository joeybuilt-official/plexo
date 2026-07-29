// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Integrations (connections) service layer.
 *
 * Encapsulates access to the in-memory CONNECTION_REGISTRY so HTTP route
 * handlers do not reach into the agent package's registry directly (boundary
 * isolation). Return shapes are identical to the inline logic the routes used
 * previously — pure internal indirection, no behavior change.
 */
import { CONNECTION_REGISTRY } from '@plexo/agent/connections/registry'

/**
 * Patterns that classify a connection tool as a "write" tool. Used by the
 * PUT /tools ?mode=read-only quick action and by the UI read-only button.
 * Matches the SHORT name (after `{prefix}__`).
 */
const WRITE_TOOL_PATTERNS = /(create|update|delete|send|write|push|merge|upload|resolve|toggle|trigger|redeploy|run|purge)/i

/** The `stub` flag for a registry entry (true only when explicitly stubbed). */
export function getRegistryStub(registryId: string): boolean {
    return CONNECTION_REGISTRY[registryId]?.stub === true
}

/**
 * Return the live tool metadata for a connection's registry entry. Reads
 * the in-memory CONNECTION_REGISTRY (single source of truth per Phase 2)
 * rather than the possibly-stale connections_registry table. Includes
 * descriptions used by the Tool Toggle UI and the agent introspection path.
 */
export function liveConnectionTools(registryId: string): Array<{
    name: string            // fully-qualified, e.g. 'notion__create_page'
    shortName: string       // suffix after `{prefix}__`, e.g. 'create_page'
    description: string
    isWrite: boolean
    stub: boolean
}> {
    const desc = CONNECTION_REGISTRY[registryId]
    if (!desc) return []
    return desc.capabilities.map((cap) => {
        const shortName = cap.name
        return {
            name: `${desc.toolPrefix}__${shortName}`,
            shortName,
            description: cap.description ?? shortName,
            isWrite: WRITE_TOOL_PATTERNS.test(shortName),
            stub: desc.stub === true,
        }
    })
}
