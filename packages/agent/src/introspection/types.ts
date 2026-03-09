// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Agent self-awareness — IntrospectionSnapshot type definitions.
 *
 * This is the authoritative shape returned by buildIntrospectionSnapshot()
 * and served by GET /api/v1/workspaces/:id/introspect.
 *
 * Credential values are NEVER included. Status fields only.
 */

export interface ProviderSnapshot {
    /** Registry key, e.g. 'anthropic', 'openai' */
    key: string
    /** Display name */
    name: string
    /** Currently active model ID for this provider */
    model: string
    /** Role this provider plays in the fallback chain */
    status: 'primary' | 'fallback' | 'configured' | 'unconfigured'
    /** Whether the user has enabled this provider for agent dispatch */
    enabled: boolean
    /** Modalities this provider supports */
    modalities: string[]
    /** Modalities this provider does NOT support */
    missing: string[]
}

export interface ConnectionSnapshot {
    /** Registry ID, e.g. 'github', 'slack' */
    registryId: string
    /** Display-friendly name */
    name: string
    /** Live installation status */
    status: 'active' | 'error' | 'expired' | 'pending'
    /** Tool names exposed to the agent (namespaced, e.g. github__list_issues) */
    tools: string[]
    /** Semantic capability strings, e.g. ['read_code', 'create_issue'] */
    capabilities: string[]
}

export interface PluginSnapshot {
    name: string
    version: string
    enabled: boolean
    /** Tool names this plugin registers */
    tools: string[]
}

export interface MemorySnapshot {
    totalEntries: number
    /** Count per memory type */
    byType: Record<string, number>
    /** Percentage of entries that have embeddings (0–100) */
    embeddingCoveragePercent: number
    /** Descriptions of the 3 most recent improvement patterns */
    recentPatterns: string[]
    /** Pending improvement proposals not yet applied */
    pendingImprovements: number
}

export interface CostSnapshot {
    weeklyUsedUsd: number
    weeklyCeilingUsd: number
    percentUsed: number
    taskCount7d: number
    avgQuality7d: number | null
    totalTokens7d: number
}

export interface SafetySnapshot {
    maxConsecutiveToolCalls: number
    maxWallClockMs: number
    maxWallClockHuman: string
    maxRetries: number
    noForcePush: boolean
    noDeletionWithoutConfirmation: boolean
    noCredentialsInLogs: boolean
}

export interface BuildInfo {
    version: string
    buildTime: string | null
    nodeVersion: string
    uptimeSeconds: number
    memoryMb: number
    pid: number
}

export interface IntrospectionSnapshot {
    workspaceId: string
    agentName: string
    agentPersona: string | null
    agentTagline: string | null
    /** Provider key currently active for task execution, or null if none configured */
    activeProvider: string | null
    /** Model ID currently in use, or null if none configured */
    activeModel: string | null
    primaryProvider: string | null
    fallbackChain: string[]
    providers: ProviderSnapshot[]
    connections: ConnectionSnapshot[]
    plugins: PluginSnapshot[]
    /** Built-in tools always available to the executor */
    builtinTools: string[]
    memory: MemorySnapshot
    cost: CostSnapshot
    safety: SafetySnapshot
    build: BuildInfo
    generatedAt: string
}
