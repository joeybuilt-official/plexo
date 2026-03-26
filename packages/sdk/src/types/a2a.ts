// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * §22 — A2A Bridge Layer
 * Plexo Fabric Specification v0.4.0
 *
 * Full compliance hosts MUST expose an A2A-compatible endpoint for each Agent,
 * enabling external A2A clients to discover and invoke Plexo Agents as remote agents.
 *
 * Protocol stack:
 *   MCP    : agent ↔ tool (already supported via MCP Server Extension type)
 *   A2A    : agent ↔ agent (this section)
 *   Fabric : defines how all of the above is packaged, permissioned, isolated, and managed
 *
 * Rules:
 *   - External agents treated as community trust tier unless presenting a VC elevating trust
 *   - Inbound tasks route through host's Task Router — same isolation and enforcement
 *   - Delegated tasks logged in audit trail with external agent's DID or endpoint
 *   - Requires a2a:delegate capability token for outbound delegation
 */

/**
 * A2A Agent Card generated from a Plexo Agent manifest.
 * Conforms to the A2A (Agentic AI Foundation) Agent Card specification.
 */
export interface A2AAgentCard {
    name: string
    description: string
    version: string
    /** A2A endpoint URL: https://host/a2a/agents/:id */
    endpoint: string
    capabilities: Record<string, unknown>
    authentication: {
        schemes: ('oauth2' | 'did' | 'api_key')[]
    }
    /** Plexo DID for this agent, if assigned */
    plexoDID?: string
}

/**
 * A2A Task — represents work delegated between agents.
 */
export interface A2ATask {
    id: string
    /** Human-readable task description */
    description: string
    /** Structured input data */
    input: unknown
    /** Expected output schema, if known */
    expectedOutput?: Record<string, unknown>
}

export type A2ATaskStatus =
    | 'pending'
    | 'in_progress'
    | 'completed'
    | 'failed'
    | 'cancelled'

export interface A2ATaskResult {
    taskId: string
    status: A2ATaskStatus
    output?: unknown
    error?: string
}

/**
 * Inbound A2A request — external agent invoking a Plexo Agent.
 */
export interface A2AInboundRequest {
    /** A2A Agent Card of the requesting agent */
    sourceAgent: A2AAgentCard
    task: A2ATask
    /** Verifiable credential if presenting elevated trust */
    credential?: unknown
}

/**
 * Outbound A2A delegation — Plexo Agent delegating to an external A2A agent.
 * Requires a2a:delegate capability.
 */
export interface A2ADelegation {
    /** A2A endpoint of the target agent */
    targetEndpoint: string
    task: A2ATask
    /** Timeout in milliseconds for the delegated task */
    timeoutMs?: number
}
