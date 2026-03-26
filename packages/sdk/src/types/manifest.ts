// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Plexo Extension Manifest Types
 * Corresponds to §3 of the Plexo Fabric Specification v0.4.0
 *
 * Core Architecture — Three Distinct Pillars:
 *
 *   Connection  — Authenticated pipe to an external service. Inert on its own.
 *   Extension   — A capability package (functions + schedules + widgets + memory).
 *                 Requires one or more Connections. Does work when invoked.
 *   Agent       — An autonomous actor with a goal, planning loop, and identity.
 *                 Orchestrates any number of Extensions to accomplish work.
 *
 * Agent is NOT a subtype of Extension. An Extension does not think. An Agent does.
 *
 * Extension subtypes:
 *   skill       — Composite capability package (registers tools, schedules, widgets)
 *   channel     — Messaging bridge (inbound/outbound)
 *   tool        — Stateless, single-purpose, called on demand
 *   connector   — Bridges an external MCP server (formerly 'mcp-server')
 */

import type { TrustTier } from './trust.js'
import type { DataResidencyDeclaration } from './data-residency.js'
import type { EscalationDeclaration } from './escalation.js'
import type { ModelRequirements } from './model-context.js'

// ---------------------------------------------------------------------------
// §2 — Extension Types (Filter badges within the Extension pillar)
// ---------------------------------------------------------------------------

/**
 * Extension subtypes — filter badges in host UI.
 * 'skill'       — composite capability package (registers tools, schedules, widgets)
 * 'channel'     — messaging bridge (inbound/outbound)
 * 'tool'        — stateless, single-purpose, called on demand
 * 'connector'   — bridges an external MCP server (formerly 'mcp-server')
 */
export type ExtensionSubtype = 'skill' | 'channel' | 'tool' | 'connector'

/**
 * The manifest type field — covers both Extensions and Agents.
 * Agent is a separate pillar but shares the manifest format.
 */
export type ManifestType = ExtensionSubtype | 'agent'

/**
 * @deprecated Use ManifestType instead. Kept for backwards compatibility with pre-0.4.0 manifests.
 */
export type ExtensionType = ManifestType | 'function' | 'mcp-server'

// ---------------------------------------------------------------------------
// §4 — Capability Tokens (Entity-Scoped Memory)
// ---------------------------------------------------------------------------

/** Personal entity types defined in §16 */
export type EntityTypeName =
    | 'person'
    | 'task'
    | 'thread'
    | 'note'
    | 'transaction'
    | 'calendar_event'
    | 'file'

/**
 * Capability tokens an extension or agent declares in its manifest.
 *
 * Memory capabilities are now entity-scoped (§4 edit):
 *   memory:read:<entity_type>    — read access to a specific entity type
 *   memory:write:<entity_type>   — write access to a specific entity type
 *
 * Unscoped memory:read / memory:write are DEPRECATED at Standard + Full compliance.
 * memory:read:* wildcard is allowed only at trust tier: owner.
 */
export type CapabilityToken =
    // Entity-scoped memory (§4 — required at Standard + Full compliance)
    | `memory:read:${EntityTypeName}`
    | `memory:write:${EntityTypeName}`
    | 'memory:read:*'      // owner tier only
    | 'memory:write:*'     // owner tier only
    // Legacy unscoped memory (§4 — deprecated, invalid at Standard + Full)
    | 'memory:read'
    | 'memory:write'
    | 'memory:delete'
    // Channel
    | 'channel:send'
    | 'channel:send-direct'
    | 'channel:receive'
    // Scheduling
    | 'schedule:register'
    | 'schedule:manage'
    // UI
    | 'ui:register-widget'
    | 'ui:notify'
    // Tasks
    | 'tasks:create'
    | 'tasks:read'
    | 'tasks:read-all'
    // Events
    | 'events:subscribe'
    | 'events:publish'
    // Storage
    | 'storage:read'
    | 'storage:write'
    // Prompts (§7.6)
    | 'prompts:register'
    | 'prompts:read'
    // Context (§7.7)
    | 'context:register'
    | 'context:write'
    | 'context:read'
    // Connections (dynamic — one per external service)
    | `connections:${string}`
    // Host-scoped (host-specific capabilities)
    | `host:${string}:${string}`
    // UserSelf (§20)
    | 'self:read'
    | 'self:write'
    // Audit (§18)
    | 'audit:read'
    // Identity (§21)
    | 'identity:present'
    // A2A delegation (§22)
    | 'a2a:delegate'
    // Model override (§24)
    | 'model:override'
    // Entity creation (§16)
    | `entity:create:${EntityTypeName}`
    | `entity:modify:${EntityTypeName}`
    | `entity:delete:${EntityTypeName}`

export type HostComplianceLevel = 'core' | 'standard' | 'full'

// ---------------------------------------------------------------------------
// §3 — Manifest Schema
// ---------------------------------------------------------------------------

export interface MCPServerConfig {
    transport: 'stdio' | 'sse'
    /** Required when transport is 'stdio' */
    command?: string
    /** Required when transport is 'sse' */
    url?: string
}

export interface AgentHints {
    taskTypes?: string[]
    minConfidence?: number
}

export interface ResourceHints {
    maxMemoryMB?: number
    maxCpuShares?: number
    maxInvocationMs?: number
}

export interface JSONSchema {
    type: string
    properties?: Record<string, JSONSchema>
    required?: string[]
    description?: string
    default?: unknown
    enum?: unknown[]
    items?: JSONSchema
    [key: string]: unknown
}

export interface BehaviorRuleDefinition {
    key: string
    label: string
    description: string
    type: 'safety_constraint' | 'operational_rule' | 'communication_style' | 'domain_knowledge' | 'persona_trait' | 'tool_preference' | 'quality_gate'
    defaultValue: {
        type: 'boolean' | 'string' | 'number' | 'enum' | 'text_block' | 'json'
        value: unknown
        options?: string[]
        min?: number
        max?: number
    }
    locked: boolean
}

/**
 * The Plexo extension manifest — shared by both Extensions and Agents.
 *
 * v0.4.0 additions:
 *   - prompts / contexts (§7.6, §7.7)
 *   - 'connector' type (replaces 'mcp-server')
 *   - 5-type model (agent, skill, channel, tool, connector)
 *
 * v0.3.0 additions:
 *   - trust          (§17)
 *   - dataResidency  (§19)
 *   - escalation     (§23)
 *   - modelRequirements (§24)
 *   - did            (§21)
 */
export interface ExtensionManifest {
    /** Fabric spec version this manifest targets. Must be valid semver. */
    plexo: string
    /** Scoped package name. Must match @scope/name format. */
    name: string
    /** Extension or Agent version. Must be valid semver. */
    version: string
    /** Manifest type — 'function' | 'channel' | 'mcp-server' for Extensions, 'agent' for Agents. */
    type: ManifestType
    /** Relative path to entry point from package root. */
    entry: string
    /** Capability tokens this extension or agent requires. */
    capabilities: CapabilityToken[]
    /** Human-readable name shown in host UI and registry. Max 50 chars. */
    displayName: string
    /** Short description. Max 280 characters. */
    description: string
    /** Publisher name or organization. */
    author: string
    /** SPDX license identifier. */
    license: string

    // Optional fields (§3.2)
    minHostLevel?: HostComplianceLevel
    minFabricVersion?: string
    homepage?: string
    repository?: string
    keywords?: string[]
    icon?: string
    screenshots?: string[]
    /** For connector type extensions (bridges an MCP server). */
    mcpServer?: MCPServerConfig
    /** For agent type only. */
    agentHints?: AgentHints
    /** For channel type only. Rendered as setup form. */
    channelConfig?: JSONSchema
    /** For skill type only. Rendered as settings form. */
    skillConfig?: JSONSchema
    /** For tool type only. Rendered as settings form. */
    toolConfig?: JSONSchema
    resourceHints?: ResourceHints
    peerExtensions?: string[]
    behaviorRules?: BehaviorRuleDefinition[]
    /** §7.6 — Prompt templates contributed by this extension. */
    prompts?: import('./prompts.js').PromptArtifact[]
    /** §7.7 — Context dependencies required by this extension. */
    contextDependencies?: string[]

    // v0.3.0 additions

    /** §17 — Trust tier declaration. Host validates against signing key. */
    trust?: TrustTier
    /** §19 — Data residency declaration. External data destinations. */
    dataResidency?: DataResidencyDeclaration
    /** §21 — W3C Decentralized Identifier for cross-host identity. */
    did?: string
    /** §23 — Escalation contract for human oversight. */
    escalation?: EscalationDeclaration
    /** §24 — LLM model requirements for agent-type manifests. */
    modelRequirements?: ModelRequirements

    /**
     * @deprecated Use skillConfig instead. Kept for backwards compatibility with pre-0.4.0 manifests.
     */
    functionConfig?: JSONSchema
}

// ---------------------------------------------------------------------------
// Agent Stack Manifest (§ Core Architecture — Agent Stack)
// ---------------------------------------------------------------------------

/**
 * An Agent Stack is a pre-configured Agent + Extension bundle.
 * Hosts SHOULD surface these as saveable, nameable presets.
 */
export interface AgentStackManifest {
    /** Fabric spec version. */
    plexo: string
    /** Scoped package name for the stack. */
    name: string
    version: string
    displayName: string
    description: string
    author: string
    license: string
    /** The Agent manifest name this stack configures. */
    agent: string
    /** Extension manifest names this Agent should load. */
    extensions: string[]
    /** Connection service identifiers required by this stack. */
    connections: string[]
    /** Optional pre-configured behavior rules for the Agent. */
    behaviorOverrides?: Record<string, unknown>
}

/**
 * @deprecated Use ExtensionManifest instead. Alias for backward compatibility.
 */
export type KapselManifest = ExtensionManifest
