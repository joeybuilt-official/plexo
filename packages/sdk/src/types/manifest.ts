// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Kapsel Manifest Types
 * Corresponds to §3 of the Kapsel Protocol Specification v0.2.0
 */

export type ExtensionType = 'agent' | 'skill' | 'channel' | 'tool' | 'mcp-server'

export type CapabilityToken =
    | 'memory:read'
    | 'memory:write'
    | 'memory:delete'
    | 'channel:send'
    | 'channel:send-direct'
    | 'channel:receive'
    | 'schedule:register'
    | 'schedule:manage'
    | 'ui:register-widget'
    | 'ui:notify'
    | 'tasks:create'
    | 'tasks:read'
    | 'tasks:read-all'
    | 'events:subscribe'
    | 'events:publish'
    | 'storage:read'
    | 'storage:write'
    | `connections:${string}`
    | `host:${string}:${string}`

export type HostComplianceLevel = 'core' | 'standard' | 'full'

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

export interface KapselManifest {
    /** Protocol version this extension targets. Must be valid semver. */
    kapsel: string
    /** Scoped package name. Must match @scope/name format. */
    name: string
    /** Extension version. Must be valid semver. */
    version: string
    /** Extension type. */
    type: ExtensionType
    /** Relative path to entry point from package root. */
    entry: string
    /** Capability tokens this extension requires. */
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
    minKapselVersion?: string
    homepage?: string
    repository?: string
    keywords?: string[]
    icon?: string
    screenshots?: string[]
    /** For mcp-server type only. */
    mcpServer?: MCPServerConfig
    /** For agent type only. */
    agentHints?: AgentHints
    /** For channel type only. Rendered as setup form. */
    channelConfig?: JSONSchema
    /** For skill type only. Rendered as settings form. */
    skillConfig?: JSONSchema
    resourceHints?: ResourceHints
    peerExtensions?: string[]
}
