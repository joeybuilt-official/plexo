// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * buildIntrospectionSnapshot — the single source of truth for agent self-awareness.
 *
 * Assembles a complete IntrospectionSnapshot by querying:
 *  - workspaces table (name, persona, AI provider config)
 *  - installed_connections (active connections + tool names)
 *  - extensions table (enabled PEX extensions)
 *  - memory_entries (counts by type, embedding coverage)
 *  - agent_improvement_log (pending proposals, recent patterns)
 *  - api_cost_tracking + work_ledger (weekly cost, quality stats)
 *  - SAFETY_LIMITS constants
 *  - process.* (uptime, memory, PID)
 *
 * Every subsection is individually non-fatal — partial snapshots are returned
 * if a subsystem fails. Credential values are NEVER included.
 *
 * @param workspaceId   Target workspace
 * @param activeProvider  The provider actually running the current task (optional)
 * @param activeModel     The model ID actually in use (optional)
 */
import { eq, sql } from 'drizzle-orm'
import { db } from '@plexo/db'
import { workspaces, installedConnections, extensions } from '@plexo/db'
import { SAFETY_LIMITS } from '../constants.js'
import {
    buildIntrospectionToolMap,
    buildIntrospectionCapabilityMap,
} from '../connections/registry.js'
import type {
    IntrospectionSnapshot,
    ProviderSnapshot,
    ConnectionSnapshot,
    PluginSnapshot,
    MemorySnapshot,
    CostSnapshot,
    SafetySnapshot,
    BuildInfo,
    EmbeddingProviderSnapshot,
    InstructionPersistenceSnapshot,
    LearningLoopSnapshot,
} from './types.js'

// Re-exported so consumers don't need a separate import
export type { IntrospectionSnapshot } from './types.js'

/**
 * Strip internal diagnostic fields from a snapshot before injecting into
 * the system prompt. The model should know its identity (name, provider,
 * model, capabilities, tools, connections) but NOT internal health metrics
 * it would parrot to users as problems.
 */
export function toConversationSnapshot(snap: IntrospectionSnapshot): Record<string, unknown> {
    // Memory: keep totalEntries + byType (useful context), drop diagnostics
    const memoryFiltered = {
        totalEntries: snap.memory.totalEntries,
        byType: snap.memory.byType,
    }

    return {
        workspaceId: snap.workspaceId,
        agentName: snap.agentName,
        agentPersona: snap.agentPersona,
        agentTagline: snap.agentTagline,
        primaryRepo: snap.primaryRepo,
        activeProvider: snap.activeProvider,
        activeModel: snap.activeModel,
        primaryProvider: snap.primaryProvider,
        fallbackChain: snap.fallbackChain,
        providers: snap.providers,
        connections: snap.connections,
        plugins: snap.plugins,
        builtinTools: snap.builtinTools,
        memory: memoryFiltered,
        generatedAt: snap.generatedAt,
        // Deliberately omitted (diagnostic-only, causes model to parrot internal state):
        // embeddingProvider, instructionPersistence, learningLoop, cost, safety, build
    }
}

// ── Connection tool name registry ─────────────────────────────────────────────
//
// DERIVED — do not hand-maintain these maps. The canonical list lives in
// `packages/agent/src/connections/registry.ts`. The introspection snapshot
// returns fully-qualified tool names (e.g. `notion__create_page`) under
// `tools` and short capability names under `capabilities`, matching the
// legacy shape this file used to export by hand.

const CONNECTION_TOOLS: Record<string, string[]> = buildIntrospectionToolMap()
const CONNECTION_CAPABILITIES: Record<string, string[]> = buildIntrospectionCapabilityMap()

const MODEL_MODALITIES: Record<string, { supports: string[]; missing: string[] }> = {
    anthropic: {
        supports: ['text', 'code', 'vision', 'analysis', 'reasoning', 'writing'],
        missing: ['image_generation', 'video_generation', 'audio_generation', 'voice_synthesis'],
    },
    openai: {
        supports: ['text', 'code', 'vision', 'analysis', 'reasoning', 'writing'],
        missing: ['video_generation', 'audio_generation', 'voice_synthesis'],
    },
    google: {
        supports: ['text', 'code', 'vision', 'analysis', 'reasoning', 'writing', 'audio_understanding'],
        missing: ['image_generation', 'video_generation', 'voice_synthesis'],
    },
    groq: {
        supports: ['text', 'code', 'analysis', 'reasoning', 'writing'],
        missing: ['vision', 'image_generation', 'video_generation', 'voice_synthesis'],
    },
    mistral: {
        supports: ['text', 'code', 'analysis', 'writing'],
        missing: ['vision', 'image_generation', 'video_generation', 'voice_synthesis'],
    },
    ollama: {
        supports: ['text', 'code', 'analysis', 'writing', 'vision'],
        missing: ['image_generation', 'video_generation', 'voice_synthesis'],
    },
    ollama_cloud: {
        supports: ['text', 'code', 'analysis', 'writing'],
        missing: ['vision', 'image_generation', 'video_generation', 'voice_synthesis'],
    },
    xai: {
        supports: ['text', 'code', 'analysis', 'reasoning', 'writing', 'vision'],
        missing: ['image_generation', 'video_generation', 'voice_synthesis'],
    },
    deepseek: {
        supports: ['text', 'code', 'analysis', 'reasoning', 'writing'],
        missing: ['vision', 'image_generation', 'video_generation', 'voice_synthesis'],
    },
    openrouter: {
        supports: ['text', 'code', 'vision', 'analysis', 'reasoning', 'writing'],
        missing: ['image_generation', 'video_generation', 'voice_synthesis'],
    },
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    google: 'Google Gemini',
    groq: 'Groq',
    mistral: 'Mistral',
    ollama: 'Ollama (Local)',
    ollama_cloud: 'Ollama Cloud',
    xai: 'xAI (Grok)',
    deepseek: 'DeepSeek',
    openrouter: 'OpenRouter',
}

const BUILTIN_TOOLS = [
    'read_file',
    'write_file',
    'shell',
    'task_complete',
    'write_asset',
    'self_reflect',
    'synthesize_extension',
    // Consolidated web tools — see packages/agent/src/tools/web-tools.ts
    'web_search',
    'web_fetch',
    'web_read_page',
] as const

// ── Local version reader ──────────────────────────────────────────────────────

async function readLocalVersion(): Promise<{ version: string; buildTime: string | null }> {
    const { readFile } = await import('node:fs/promises')
    let buildTime: string | null = null
    let version = process.env.npm_package_version ?? 'dev'
    try { buildTime = (await readFile('/app/.build-time', 'utf8')).trim() || null } catch { /* dev */ }
    try {
        const baked = (await readFile('/app/.version', 'utf8')).trim()
        if (baked && baked !== 'auto' && baked !== 'dev') version = baked
    } catch { /* dev */ }
    if (process.env.APP_VERSION && process.env.APP_VERSION !== 'dev') version = process.env.APP_VERSION
    return { version, buildTime }
}

// ── Main builder ──────────────────────────────────────────────────────────────

export async function buildIntrospectionSnapshot(
    workspaceId: string,
    activeProvider?: string,
    activeModel?: string,
): Promise<IntrospectionSnapshot> {
    const generatedAt = new Date().toISOString()

    // ── Workspace + AI provider config ────────────────────────────────────────
    let agentName = 'Plexo'
    let agentPersona: string | null = null
    let agentTagline: string | null = null
    let primaryRepo: string | null = null
    // primaryProvider: set from DB settings, or from active task context, or null (no config)
    // Never hardcode 'anthropic' — that creates false signals when the provider isn't configured.
    let primaryProvider: string | null = activeProvider ?? null
    let fallbackChain: string[] = []
    const providerSnapshots: ProviderSnapshot[] = []

    try {
        const [wsRow] = await db
            .select({ name: workspaces.name, settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .limit(1)

        if (wsRow) {
            const s = (wsRow.settings ?? {}) as Record<string, unknown>
            agentName = (typeof s.agentName === 'string' && s.agentName) ? s.agentName : (wsRow.name ?? 'Plexo')
            agentPersona = typeof s.agentPersona === 'string' ? s.agentPersona : null
            agentTagline = typeof s.agentTagline === 'string' ? s.agentTagline : null
            primaryRepo = typeof s.primaryRepo === 'string' ? s.primaryRepo : null

            // Try provider_instances table first (canonical source after Intelligence page)
            try {
                const { providerInstances } = await import('@plexo/db')
                const { asc } = await import('drizzle-orm')
                const instances = await db.select({
                    providerType: providerInstances.providerType,
                    selectedModel: providerInstances.selectedModel,
                    enabled: providerInstances.enabled,
                    preferenceOrder: providerInstances.preferenceOrder,
                    encryptedKey: providerInstances.encryptedKey,
                    endpointUrl: providerInstances.endpointUrl,
                }).from(providerInstances)
                    .where(eq(providerInstances.workspaceId, workspaceId))
                    .orderBy(asc(providerInstances.preferenceOrder))

                if (instances.length > 0) {
                    const enabledInstances = instances.filter(i => i.enabled)
                    if (enabledInstances.length > 0) {
                        const savedPrimary = enabledInstances[0]!.providerType
                        primaryProvider = activeProvider ?? savedPrimary
                        // Build fallback chain from remaining enabled instances
                        fallbackChain = enabledInstances.slice(1).map(i => i.providerType)
                    }

                    for (const inst of instances) {
                        const key = inst.providerType
                        const isConfigured = !!inst.encryptedKey || !!inst.endpointUrl
                        const modality = MODEL_MODALITIES[key] ?? MODEL_MODALITIES.anthropic!
                        const isPrimary = key === primaryProvider
                        const isFallback = fallbackChain.includes(key)

                        let status: ProviderSnapshot['status'] = 'unconfigured'
                        if (isPrimary && isConfigured) status = 'primary'
                        else if (isFallback && isConfigured) status = 'fallback'
                        else if (isConfigured) status = 'configured'

                        providerSnapshots.push({
                            key,
                            name: PROVIDER_DISPLAY_NAMES[key] ?? key,
                            model: ((activeProvider === key ? activeModel : undefined) ?? inst.selectedModel ?? key) as string,
                            status,
                            enabled: inst.enabled ?? false,
                            modalities: modality.supports,
                            missing: modality.missing,
                        })
                    }
                }
            } catch { /* provider_instances not available — fall back to legacy */ }

            // Legacy fallback: settings.aiProviders (pre-migration workspaces)
            if (providerSnapshots.length === 0) {
                const ap = s.aiProviders as Record<string, unknown> | undefined
                if (ap) {
                    // Use activeProvider if a task is running, else the saved primary
                    const savedPrimary = (ap.primary ?? ap.primaryProvider ?? null) as string | null
                    primaryProvider = activeProvider ?? savedPrimary
                    fallbackChain = (ap.fallbackOrder ?? ap.fallbackChain ?? []) as string[]

                    const providers = (ap.providers ?? {}) as Record<string, Record<string, unknown>>
                    for (const [key, cfg] of Object.entries(providers)) {
                        const SENTINEL = '__configured__'
                        const hasRealApiKey = !!cfg.apiKey && cfg.apiKey !== SENTINEL
                        const hasBaseUrl = !!cfg.baseUrl
                        const isKeylessConfigured = cfg.status === 'configured' && !cfg.apiKey
                        const isConfigured = hasRealApiKey || hasBaseUrl || isKeylessConfigured
                        const modality = MODEL_MODALITIES[key] ?? MODEL_MODALITIES.anthropic!
                        const isPrimary = key === primaryProvider
                        const isFallback = fallbackChain.includes(key)

                        let status: ProviderSnapshot['status'] = 'unconfigured'
                        if (isPrimary && isConfigured) status = 'primary'
                        else if (isFallback && isConfigured) status = 'fallback'
                        else if (isConfigured) status = 'configured'

                        providerSnapshots.push({
                            key,
                            name: PROVIDER_DISPLAY_NAMES[key] ?? key,
                            model: ((activeProvider === key ? activeModel : undefined) ?? cfg.selectedModel ?? cfg.defaultModel ?? key) as string,
                            status,
                            enabled: cfg.enabled !== false,
                            modalities: modality.supports,
                            missing: modality.missing,
                        })
                    }
                }
            }
        }
    } catch { /* non-fatal */ }

    // Only add a stub when no providers are saved at all.
    // If there's an active task we know exactly which provider is running.
    // If not, suppress the stub entirely rather than hallucinating 'anthropic'.
    if (providerSnapshots.length === 0 && activeProvider) {
        const key = activeProvider
        const modality = MODEL_MODALITIES[key] ?? MODEL_MODALITIES.anthropic!
        providerSnapshots.push({
            key,
            name: PROVIDER_DISPLAY_NAMES[key] ?? key,
            model: activeModel ?? 'unknown',
            status: 'primary',
            enabled: true,
            modalities: modality.supports,
            missing: modality.missing,
        })
    }

    // ── Installed connections ─────────────────────────────────────────────────
    const connectionSnapshots: ConnectionSnapshot[] = []
    try {
        const rows = await db
            .select({
                id: installedConnections.id,
                registryId: installedConnections.registryId,
                status: installedConnections.status,
            })
            .from(installedConnections)
            .where(eq(installedConnections.workspaceId, workspaceId))

        for (const row of rows) {
            const tools = CONNECTION_TOOLS[row.registryId] ?? []
            const capabilities = CONNECTION_CAPABILITIES[row.registryId] ?? []
            const name = row.registryId.charAt(0).toUpperCase() + row.registryId.slice(1).replace(/_/g, ' ')
            connectionSnapshots.push({
                registryId: row.registryId,
                name,
                status: (row.status ?? 'active') as ConnectionSnapshot['status'],
                tools,
                capabilities,
            })
        }
    } catch { /* non-fatal */ }

    // ── Plugins ───────────────────────────────────────────────────────────────
    const pluginSnapshots: PluginSnapshot[] = []
    try {
        const rows = await db
            .select({
                name: extensions.name,
                version: extensions.version,
                enabled: extensions.enabled,
                manifest: extensions.manifest,
            })
            .from(extensions)
            .where(eq(extensions.workspaceId, workspaceId))

        for (const row of rows) {
            const manifest = (row.manifest ?? {}) as { tools?: Array<{ name: string }> }
            const pluginTools = (manifest.tools ?? []).map((t) => t.name)
            pluginSnapshots.push({
                name: row.name,
                version: row.version ?? '0.0.0',
                enabled: row.enabled ?? false,
                tools: pluginTools,
            })
        }
    } catch { /* non-fatal */ }

    // ── Memory stats ──────────────────────────────────────────────────────────
    let memory: MemorySnapshot = {
        totalEntries: 0,
        byType: {},
        byTier: {},
        embeddingCoveragePercent: 0,
        avgConfidence: 0,
        anchoredCount: 0,
        recentPatterns: [],
        pendingImprovements: 0,
    }
    try {
        const [memStats] = await db.execute<{
            total: string
            with_embedding: string
            avg_confidence: string | null
            anchored_count: string
        }>(sql`
            SELECT
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS with_embedding,
                AVG(confidence) AS avg_confidence,
                COUNT(*) FILTER (WHERE is_anchored = true) AS anchored_count
            FROM memory_entries
            WHERE workspace_id = ${workspaceId}::uuid
              AND (invalid_at IS NULL OR invalid_at > NOW())
              AND superseded_by IS NULL
        `)

        const byTypeRows = await db.execute<{ type: string; count: string }>(sql`
            SELECT type, COUNT(*) AS count
            FROM memory_entries
            WHERE workspace_id = ${workspaceId}::uuid
              AND (invalid_at IS NULL OR invalid_at > NOW())
              AND superseded_by IS NULL
            GROUP BY type
        `)

        const byTierRows = await db.execute<{ tier: string; count: string }>(sql`
            SELECT tier, COUNT(*) AS count
            FROM memory_entries
            WHERE workspace_id = ${workspaceId}::uuid
              AND (invalid_at IS NULL OR invalid_at > NOW())
              AND superseded_by IS NULL
            GROUP BY tier
        `)

        const [pendingRow] = await db.execute<{ pending: string }>(sql`
            SELECT COUNT(*) AS pending
            FROM agent_improvement_log
            WHERE workspace_id = ${workspaceId}::uuid
              AND applied = false
        `)

        const patternRows = await db.execute<{ description: string }>(sql`
            SELECT description
            FROM agent_improvement_log
            WHERE workspace_id = ${workspaceId}::uuid
            ORDER BY created_at DESC
            LIMIT 3
        `)

        const total = Number(memStats?.total ?? 0)
        const withEmbedding = Number(memStats?.with_embedding ?? 0)
        const byType: Record<string, number> = {}
        for (const r of byTypeRows) byType[r.type] = Number(r.count)
        const byTier: Record<string, number> = {}
        for (const r of byTierRows) byTier[r.tier] = Number(r.count)

        memory = {
            totalEntries: total,
            byType,
            byTier,
            embeddingCoveragePercent: total > 0 ? Math.round((withEmbedding / total) * 100) : 0,
            avgConfidence: memStats?.avg_confidence != null ? Math.round(Number(memStats.avg_confidence) * 100) / 100 : 0,
            anchoredCount: Number(memStats?.anchored_count ?? 0),
            recentPatterns: patternRows.map((r) => r.description),
            pendingImprovements: Number(pendingRow?.pending ?? 0),
        }
    } catch { /* non-fatal */ }

    // ── Cost stats ────────────────────────────────────────────────────────────
    let cost: CostSnapshot = {
        weeklyUsedUsd: 0,
        weeklyCeilingUsd: parseFloat(process.env.API_COST_CEILING_USD ?? '10'),
        percentUsed: 0,
        taskCount7d: 0,
        avgQuality7d: null,
        totalTokens7d: 0,
    }
    try {
        const defaultCeiling = parseFloat(process.env.API_COST_CEILING_USD ?? '10')
        const [costRow] = await db.execute<{
            cost_usd: string | null
            ceiling_usd: string | null
        }>(sql`
            SELECT cost_usd, COALESCE(ceiling_usd, ${defaultCeiling}) AS ceiling_usd
            FROM api_cost_tracking
            WHERE workspace_id = ${workspaceId}::uuid
              AND week_start = date_trunc('week', NOW())::date
            LIMIT 1
        `)

        const [ledgerRow] = await db.execute<{
            task_count: string
            avg_quality: string | null
            total_tokens: string
        }>(sql`
            SELECT
                COUNT(*) AS task_count,
                AVG(quality_score) AS avg_quality,
                SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)) AS total_tokens
            FROM work_ledger
            WHERE workspace_id = ${workspaceId}::uuid
              AND completed_at > NOW() - INTERVAL '7 days'
        `)

        const used = Number(costRow?.cost_usd ?? 0)
        const ceiling = Number(costRow?.ceiling_usd ?? cost.weeklyCeilingUsd)
        cost = {
            weeklyUsedUsd: used,
            weeklyCeilingUsd: ceiling,
            percentUsed: ceiling > 0 ? Math.round((used / ceiling) * 100) : 0,
            taskCount7d: Number(ledgerRow?.task_count ?? 0),
            avgQuality7d: ledgerRow?.avg_quality != null ? Number(ledgerRow.avg_quality) : null,
            totalTokens7d: Number(ledgerRow?.total_tokens ?? 0),
        }
    } catch { /* non-fatal */ }

    // ── Safety limits ─────────────────────────────────────────────────────────
    const wallClockMs = SAFETY_LIMITS.maxWallClockMs
    const hours = Math.floor(wallClockMs / 3_600_000)
    const mins = Math.floor((wallClockMs % 3_600_000) / 60_000)
    const safety: SafetySnapshot = {
        maxConsecutiveToolCalls: SAFETY_LIMITS.maxConsecutiveToolCalls,
        maxWallClockMs: wallClockMs,
        maxWallClockHuman: hours > 0 ? `${hours}h${mins > 0 ? ` ${mins}m` : ''}` : `${mins}m`,
        maxRetries: SAFETY_LIMITS.maxRetries,
        noForcePush: SAFETY_LIMITS.noForcePush,
        noDeletionWithoutConfirmation: SAFETY_LIMITS.noDeletionWithoutConfirmation,
        noCredentialsInLogs: SAFETY_LIMITS.noCredentialsInLogs,
    }

    // ── Build info ────────────────────────────────────────────────────────────
    let build: BuildInfo = {
        version: 'dev',
        buildTime: null,
        nodeVersion: process.version,
        uptimeSeconds: Math.floor(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        pid: process.pid,
    }
    try {
        const { version, buildTime } = await readLocalVersion()
        build = { ...build, version, buildTime }
    } catch { /* non-fatal */ }

    // ── Embedding provider status ────────────────────────────────────────────
    let embeddingProvider: EmbeddingProviderSnapshot = {
        configured: false,
        providerId: null,
        model: null,
        dimensions: null,
        status: 'not-configured',
        message: null,
    }
    try {
        const { resolveEmbeddingAdapterFromEnv } = await import('../embeddings/router.js')
        const resolution = resolveEmbeddingAdapterFromEnv(workspaceId)
        embeddingProvider = {
            configured: resolution.status === 'active',
            providerId: resolution.providerId,
            model: resolution.model,
            dimensions: resolution.dimensions,
            status: resolution.status,
            message: resolution.message,
        }
    } catch { /* non-fatal */ }

    // ── Instruction persistence health ───────────────────────────────────────
    const instructionPersistence: InstructionPersistenceSnapshot = {
        healthy: true,
        lastError: null,
    }
    try {
        // Check if 'conversation' value exists in rule_source enum
        const [enumRow] = await db.execute<{ has_conversation: string }>(sql`
            SELECT EXISTS(
                SELECT 1 FROM pg_enum
                WHERE enumtypid = 'rule_source'::regtype
                  AND enumlabel = 'conversation'
            )::text AS has_conversation
        `)
        if (enumRow?.has_conversation !== 'true') {
            instructionPersistence.healthy = false
            instructionPersistence.lastError = "rule_source enum missing 'conversation' value — migration 0056 not applied"
        }
    } catch { /* non-fatal — assume healthy if we can't check */ }

    // ── Learning loop metrics ────────────────────────────────────────────────
    const learningLoop: LearningLoopSnapshot = {
        conversationMutationsLast24h: 0,
        taskReflectionsLast24h: 0,
        lastSuccessfulMutationAt: null,
    }
    try {
        // Task reflections: count work_ledger entries with quality_score in last 24h
        const [reflRow] = await db.execute<{ count: string }>(sql`
            SELECT COUNT(*) AS count
            FROM work_ledger
            WHERE workspace_id = ${workspaceId}::uuid
              AND completed_at > NOW() - INTERVAL '24 hours'
        `)
        learningLoop.taskReflectionsLast24h = Number(reflRow?.count ?? 0)
    } catch { /* non-fatal */ }

    // ── Domain mastery snapshot ────────────────────────────────────────────────
    let domainMastery: import('./types.js').DomainMasterySnapshot | null = null
    try {
        const { isDomainMasteryEnabled } = await import('../domain-mastery/index.js')
        if (await isDomainMasteryEnabled(workspaceId)) {
            // Check kill switch
            const killRows = await db.execute<{ value: unknown }>(sql`
                SELECT value FROM workspace_preferences
                WHERE workspace_id = ${workspaceId}::uuid AND key = 'learning_kill_switch_triggered'
            `)
            const killSwitchTriggered = killRows[0]?.value === true

            // Top domains from metrics
            const domainRows = await db.execute<{
                domain_tag: string; task_count: number; avg_quality: number | null; quality_delta: number | null; le_count: number
            }>(sql`
                SELECT domain_tag, task_count, avg_quality, quality_delta,
                       COALESCE(learning_event_count, 0) as le_count
                FROM plexo_ops_domain_metrics
                WHERE workspace_id = ${workspaceId}::uuid
                ORDER BY period_start DESC, task_count DESC
                LIMIT 20
            `)

            // Rule counts
            const ruleRows = await db.execute<{ tags: string[] }>(sql`
                SELECT tags FROM behavior_rules
                WHERE workspace_id = ${workspaceId}::uuid
                  AND source = 'reflection' AND deleted_at IS NULL
            `)
            let activeCount = 0, staleCount = 0, quarantinedCount = 0
            for (const r of ruleRows) {
                const tags = r.tags ?? []
                if (tags.includes('quarantined')) quarantinedCount++
                else if (tags.includes('stale')) staleCount++
                else activeCount++
            }

            domainMastery = {
                enabled: true,
                killSwitchTriggered,
                domains: domainRows.map(r => ({
                    domainTag: r.domain_tag,
                    taskCount: r.task_count,
                    avgQuality: r.avg_quality,
                    qualityDelta: r.quality_delta,
                    learningEventCount: r.le_count,
                })),
                activeRuleCount: activeCount,
                staleRuleCount: staleCount,
                quarantinedRuleCount: quarantinedCount,
            }
        }
    } catch { /* non-fatal */ }

    // ── Assemble ──────────────────────────────────────────────────────────────
    return {
        workspaceId,
        agentName,
        agentPersona,
        agentTagline,
        primaryRepo,
        activeProvider: activeProvider ?? primaryProvider,
        activeModel: activeModel ?? (primaryProvider ? (providerSnapshots.find(p => p.key === primaryProvider)?.model ?? null) : null),
        primaryProvider,
        fallbackChain,
        providers: providerSnapshots,
        connections: connectionSnapshots,
        plugins: pluginSnapshots,
        builtinTools: [...BUILTIN_TOOLS],
        memory,
        embeddingProvider,
        instructionPersistence,
        learningLoop,
        domainMastery,
        cost,
        safety,
        build,
        generatedAt,
    }
}
