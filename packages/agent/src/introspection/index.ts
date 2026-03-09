/**
 * buildIntrospectionSnapshot — the single source of truth for agent self-awareness.
 *
 * Assembles a complete IntrospectionSnapshot by querying:
 *  - workspaces table (name, persona, AI provider config)
 *  - installed_connections (active connections + tool names)
 *  - plugins table (enabled kapsel extensions)
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
import { db, eq, and, sql } from '@plexo/db'
import { workspaces, installedConnections, plugins } from '@plexo/db'
import { SAFETY_LIMITS } from '../constants.js'
import type {
    IntrospectionSnapshot,
    ProviderSnapshot,
    ConnectionSnapshot,
    PluginSnapshot,
    MemorySnapshot,
    CostSnapshot,
    SafetySnapshot,
    BuildInfo,
} from './types.js'

// Re-exported so consumers don't need a separate import
export type { IntrospectionSnapshot } from './types.js'

// ── Connection tool name registry ─────────────────────────────────────────────
// Must be kept in sync with connections/bridge.ts TOOL_FACTORIES keys.

const CONNECTION_TOOLS: Record<string, string[]> = {
    github: [
        'github__list_issues',
        'github__create_issue',
        'github__open_pr',
        'github__merge_pr',
        'github__create_branch',
        'github__get_ci_status',
        'github__read_file',
        'github__push_file',
    ],
    slack: ['slack__send_message', 'slack__list_channels'],
    vercel: ['vercel__list_deployments', 'vercel__get_deployment_status'],
    stripe: ['stripe__list_recent_payments', 'stripe__get_revenue_summary'],
    cloudflare: ['cloudflare__purge_cache', 'cloudflare__list_dns'],
}

const CONNECTION_CAPABILITIES: Record<string, string[]> = {
    github: ['read_code', 'list_issues', 'create_issue', 'list_prs', 'check_ci', 'push_commits'],
    slack: ['send_message', 'list_channels', 'read_messages'],
    discord: ['send_message', 'read_messages'],
    stripe: ['read_payments', 'read_revenue'],
    vercel: ['list_deployments', 'get_deployment_status'],
    cloudflare: ['purge_cache', 'list_dns'],
    google_drive: ['file_upload', 'create_doc', 'read_doc'],
    notion: ['create_page', 'read_page', 'append_blocks'],
    airtable: ['read_records', 'create_record', 'update_record'],
    sendgrid: ['send_email'],
    mailchimp: ['send_campaign', 'list_subscribers'],
    twilio: ['send_sms', 'make_call'],
    replicate: ['image_generation', 'video_generation', 'audio_generation', 'image_upscaling'],
    'fal-ai': ['image_generation', 'video_generation', 'image_upscaling'],
    stability: ['image_generation', 'image_editing'],
    elevenlabs: ['voice_synthesis', 'audio_generation'],
    openai: ['image_generation', 'vision', 'transcription'],
    deepgram: ['transcription', 'voice_synthesis'],
}

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
    let primaryProvider = activeProvider ?? 'anthropic'
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

            const ap = s.aiProviders as Record<string, unknown> | undefined
            if (ap) {
                primaryProvider = activeProvider ?? ((ap.primary ?? ap.primaryProvider ?? 'anthropic') as string)
                fallbackChain = (ap.fallbackOrder ?? ap.fallbackChain ?? []) as string[]

                const providers = (ap.providers ?? {}) as Record<string, Record<string, unknown>>
                for (const [key, cfg] of Object.entries(providers)) {
                    // A provider is truly configured when it has a real credential:
                    // - apiKey exists AND is not the sentinel placeholder (__configured__)
                    // - OR a baseUrl is present (keyless/local providers, e.g. Ollama)
                    // - OR status is explicitly 'configured' without an apiKey (Ollama-style)
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
    } catch { /* non-fatal */ }

    // If no providers loaded at all, add a stub — but only mark it primary if
    // we were given an explicit activeProvider (meaning a task is actually running).
    // With no providers and no active task, show 'unconfigured' so the UI is honest.
    if (providerSnapshots.length === 0) {
        const modality = MODEL_MODALITIES[primaryProvider] ?? MODEL_MODALITIES.anthropic!
        providerSnapshots.push({
            key: primaryProvider,
            name: PROVIDER_DISPLAY_NAMES[primaryProvider] ?? primaryProvider,
            model: activeModel ?? 'unknown',
            // Only claim 'primary' status if we were explicitly told a provider is active
            status: activeProvider ? 'primary' : 'unconfigured',
            enabled: !!activeProvider,
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
                name: plugins.name,
                version: plugins.version,
                enabled: plugins.enabled,
                kapselManifest: plugins.kapselManifest,
            })
            .from(plugins)
            .where(eq(plugins.workspaceId, workspaceId))

        for (const row of rows) {
            // Extract registered tool names from kapsel manifest
            const manifest = (row.kapselManifest ?? {}) as { tools?: Array<{ name: string }> }
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
        embeddingCoveragePercent: 0,
        recentPatterns: [],
        pendingImprovements: 0,
    }
    try {
        const [memStats] = await db.execute<{
            total: string
            with_embedding: string
        }>(sql`
            SELECT
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS with_embedding
            FROM memory_entries
            WHERE workspace_id = ${workspaceId}::uuid
        `)

        const byTypeRows = await db.execute<{ type: string; count: string }>(sql`
            SELECT type, COUNT(*) AS count
            FROM memory_entries
            WHERE workspace_id = ${workspaceId}::uuid
            GROUP BY type
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

        memory = {
            totalEntries: total,
            byType,
            embeddingCoveragePercent: total > 0 ? Math.round((withEmbedding / total) * 100) : 0,
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

    // ── Assemble ──────────────────────────────────────────────────────────────
    return {
        workspaceId,
        agentName,
        agentPersona,
        agentTagline,
        activeProvider: activeProvider ?? primaryProvider,
        activeModel: activeModel ?? (providerSnapshots.find(p => p.key === primaryProvider)?.model ?? 'unknown'),
        primaryProvider,
        fallbackChain,
        providers: providerSnapshots,
        connections: connectionSnapshots,
        plugins: pluginSnapshots,
        builtinTools: [...BUILTIN_TOOLS],
        memory,
        cost,
        safety,
        build,
        generatedAt,
    }
}
