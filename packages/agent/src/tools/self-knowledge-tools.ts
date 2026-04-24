// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Self-knowledge tools — live introspection at call time.
 *
 * These tools let the agent answer "what can you do right now?" accurately
 * at any point in a conversation or task. Unlike the system-prompt capability
 * block (baked at session start), these tools read from:
 *   - CONNECTION_REGISTRY (single source of truth, Phase 2)
 *   - installed_connections (current workspace state)
 *   - extensions (enabled extensions)
 *   - workspace settings (providers, agent persona)
 *
 * Called via workspace-tools.ts (conversational + A2A paths) AND injected
 * directly in executor/index.ts (task path).
 *
 * Design rules:
 *   - Never hardcode tool lists. All data derives from CONNECTION_REGISTRY
 *     and live DB queries.
 *   - Lightweight: each tool is a single small query + format pass.
 *   - Honest: stub connections are labeled as stubs in output.
 *   - Audited: every call writes a fire-and-forget extension_audit_log row.
 */

import { tool } from 'ai'
import { z } from 'zod'
import pino from 'pino'
import { CONNECTION_REGISTRY } from '../connections/registry.js'
import type { ToolSet } from '../connections/bridge-types.js'

const logger = pino({ name: 'self-knowledge-tools' })

// ── Static self-description ──────────────────────────────────────────────────
// This is the "about Plexo" content returned by about_plexo(). Kept as a
// template so the live numbers (providers, connections, extensions) can be
// interpolated at call time.

const PLEXO_SELF_DESCRIPTION_TEMPLATE = `Plexo is a self-hosted AI agent platform. I can:
- Chat conversationally or execute multi-step tasks against real systems.
- Remember conversations and facts in persistent memory (pgvector + SCL-indexed).
- Use tools from connected integrations (GitHub, Slack, Notion, Linear, Jira, SSH, and more).
- Send and receive messages on channels (Telegram, Slack, Discord, web chat).
- Install extensions from the Plexo Hub marketplace or synthesize new ones on demand.
- Modify my own workspace settings, agent persona, and installed connections.
- Run autonomous tasks with step limits, cost ceilings, and safety rails.

Architecture: TypeScript monorepo. Agent logic in packages/agent. API in apps/api (Fastify). Web UI in apps/web (Next.js). Postgres + pgvector for memory, Valkey for queues, Docker Compose for deployment.

Current workspace: {LLM_PROVIDERS} configured providers, {CONNECTIONS} installed integrations ({REAL_CONNECTIONS} real, {STUB_CONNECTIONS} stubs), {EXTENSIONS} enabled extensions.

For the exact live list of tools I can call right now, use list_my_tools(). For detailed capabilities per category, use get_my_capabilities(). To check a specific provider, use check_connection_status({ provider: "..." }).`

// ── Audit helper (fire-and-forget) ────────────────────────────────────────────

function auditCall(workspaceId: string, toolName: string, payload: unknown): void {
    // Fire-and-forget. Self-knowledge calls are always scoped to the workspace
    // and carry no secrets, so audit is informational only.
    void (async () => {
        try {
            const { logAuditEntry } = await import('../audit.js')
            await logAuditEntry({
                workspaceId,
                extensionId: 'self-knowledge',
                sessionId: 'self-knowledge',
                action: 'tool_invoke',
                target: toolName,
                payload,
                outcome: 'success',
            })
        } catch (err) {
            logger.debug({ err, toolName }, 'self-knowledge audit log failed (non-fatal)')
        }
    })()
}

// ── Live state readers ────────────────────────────────────────────────────────

interface InstalledConnectionRow {
    id: string
    registryId: string
    name: string | null
    status: string
    enabledTools: string[] | null
}

async function readInstalledConnections(workspaceId: string): Promise<InstalledConnectionRow[]> {
    try {
        const { db, eq, and } = await import('@plexo/db')
        const { installedConnections } = await import('@plexo/db')
        const rows = await db
            .select({
                id: installedConnections.id,
                registryId: installedConnections.registryId,
                name: installedConnections.name,
                status: installedConnections.status,
                enabledTools: installedConnections.enabledTools,
            })
            .from(installedConnections)
            .where(and(
                eq(installedConnections.workspaceId, workspaceId),
                eq(installedConnections.status, 'active'),
            ))
        return rows.map((r) => ({
            id: r.id,
            registryId: r.registryId,
            name: r.name,
            status: r.status ?? 'active',
            enabledTools: (r.enabledTools as string[] | null) ?? null,
        }))
    } catch (err) {
        logger.warn({ err, workspaceId }, 'readInstalledConnections failed')
        return []
    }
}

interface ExtensionRow {
    name: string
    version: string | null
    enabled: boolean
    toolNames: string[]
}

async function readExtensions(workspaceId: string): Promise<ExtensionRow[]> {
    try {
        const { db, eq } = await import('@plexo/db')
        const { extensions } = await import('@plexo/db')
        const rows = await db
            .select({
                name: extensions.name,
                version: extensions.version,
                enabled: extensions.enabled,
                manifest: extensions.manifest,
            })
            .from(extensions)
            .where(eq(extensions.workspaceId, workspaceId))

        // Build extension → tool-name map from the warm plugin tool cache.
        // PEX extensions register tools dynamically at worker activation time —
        // manifest.tools[] is always empty for them. We peek (no-load) so this
        // never triggers worker spawning from a list_my_tools call.
        const dynamicToolMap = new Map<string, string[]>()
        try {
            const { peekCachedToolSet } = await import('../tool-set-cache.js')
            const cachedTools = peekCachedToolSet<ToolSet>(`plugins:${workspaceId}`)
            if (cachedTools) {
                for (const key of Object.keys(cachedTools)) {
                    // Key format: plugin__{sanitizedExtName}__{toolName}
                    if (!key.startsWith('plugin__')) continue
                    const withoutPrefix = key.slice('plugin__'.length)
                    const sep = withoutPrefix.indexOf('__')
                    if (sep === -1) continue
                    const sanitized = withoutPrefix.slice(0, sep)
                    const toolName = withoutPrefix.slice(sep + 2)
                    const list = dynamicToolMap.get(sanitized) ?? []
                    list.push(toolName)
                    dynamicToolMap.set(sanitized, list)
                }
            }
        } catch { /* non-fatal — cache unavailable */ }

        return rows.map((r) => {
            const m = (r.manifest ?? {}) as { tools?: Array<{ name: string }> }
            const staticTools = (m.tools ?? []).map((t) => t.name).filter(Boolean)
            // plugin__scope__name → sanitized scope matches ext.name sans @, / → _
            const sanitized = r.name.replace(/^@/, '').replace(/\//g, '_')
            const dynamicTools = dynamicToolMap.get(sanitized) ?? []
            return {
                name: r.name,
                version: r.version ?? null,
                enabled: r.enabled ?? false,
                toolNames: staticTools.length > 0 ? staticTools : dynamicTools,
            }
        })
    } catch (err) {
        logger.warn({ err, workspaceId }, 'readExtensions failed')
        return []
    }
}

interface WorkspaceProviders {
    primary: string | null
    activeProviders: Array<{ key: string; model: string }>
    agentName: string
    agentPersona: string | null
    channelCount: number
    memoryTotal: number
    memoryEmbedded: number
}

async function readWorkspaceMeta(workspaceId: string): Promise<WorkspaceProviders> {
    const out: WorkspaceProviders = {
        primary: null,
        activeProviders: [],
        agentName: 'Plexo',
        agentPersona: null,
        channelCount: 0,
        memoryTotal: 0,
        memoryEmbedded: 0,
    }
    try {
        const { db, eq, sql } = await import('@plexo/db')
        const { workspaces, channels } = await import('@plexo/db')
        const [ws] = await db
            .select({ name: workspaces.name, settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .limit(1)
        if (ws) {
            const s = (ws.settings ?? {}) as Record<string, unknown>
            out.agentName = (typeof s.agentName === 'string' && s.agentName) ? s.agentName : (ws.name ?? 'Plexo')
            out.agentPersona = typeof s.agentPersona === 'string' ? s.agentPersona : null
            // Try provider_instances table first (canonical source after Intelligence page)
            try {
                const { providerInstances } = await import('@plexo/db')
                const { asc } = await import('@plexo/db')
                const instances = await db.select({
                    providerType: providerInstances.providerType,
                    selectedModel: providerInstances.selectedModel,
                    enabled: providerInstances.enabled,
                    preferenceOrder: providerInstances.preferenceOrder,
                    hasKey: sql<boolean>`encrypted_key IS NOT NULL`,
                    hasUrl: sql<boolean>`endpoint_url IS NOT NULL`,
                }).from(providerInstances)
                    .where(eq(providerInstances.workspaceId, workspaceId))
                    .orderBy(asc(providerInstances.preferenceOrder))

                if (instances.length > 0) {
                    const enabled = instances.filter(i => i.enabled)
                    if (enabled.length > 0) {
                        out.primary = enabled[0]!.providerType
                        for (const inst of enabled) {
                            if (inst.hasKey || inst.hasUrl) {
                                out.activeProviders.push({
                                    key: inst.providerType,
                                    model: inst.selectedModel ?? inst.providerType,
                                })
                            }
                        }
                    }
                }
            } catch { /* provider_instances not available — fall back to legacy */ }

            // Legacy fallback: settings.aiProviders (pre-migration workspaces)
            if (out.activeProviders.length === 0) {
                const ap = s.aiProviders as Record<string, unknown> | undefined
                if (ap) {
                    out.primary = (ap.primary ?? ap.primaryProvider ?? null) as string | null
                    const providers = (ap.providers ?? {}) as Record<string, Record<string, unknown>>
                    for (const [key, cfg] of Object.entries(providers)) {
                        const SENTINEL = '__configured__'
                        const hasKey = !!cfg.apiKey && cfg.apiKey !== SENTINEL
                        const hasBase = !!cfg.baseUrl
                        const keyless = cfg.status === 'configured' && !cfg.apiKey
                        if (hasKey || hasBase || keyless) {
                            out.activeProviders.push({
                                key,
                                model: ((cfg.selectedModel ?? cfg.defaultModel ?? cfg.model ?? key) as string),
                            })
                        }
                    }
                }
            }
        }

        // Channel count
        try {
            const chans = await db
                .select({ id: channels.id })
                .from(channels)
                .where(eq(channels.workspaceId, workspaceId))
            out.channelCount = chans.length
        } catch { /* non-fatal */ }

        // Memory stats
        try {
            const [mem] = await db.execute<{ total: string; with_embedding: string }>(sql`
                SELECT COUNT(*) AS total,
                       COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS with_embedding
                FROM memory_entries
                WHERE workspace_id = ${workspaceId}::uuid
            `)
            out.memoryTotal = Number(mem?.total ?? 0)
            out.memoryEmbedded = Number(mem?.with_embedding ?? 0)
        } catch { /* non-fatal */ }
    } catch (err) {
        logger.warn({ err, workspaceId }, 'readWorkspaceMeta failed')
    }
    return out
}

// ── Shape helpers ─────────────────────────────────────────────────────────────

/** For a given installed connection row, return the fully-qualified tool names
 *  the factory is expected to produce, filtered by the `enabled_tools` column. */
function connectionToolNames(row: InstalledConnectionRow): string[] {
    const desc = CONNECTION_REGISTRY[row.registryId]
    if (!desc) return []
    const full = desc.capabilities.map((c) => `${desc.toolPrefix}__${c.name}`)
    if (row.enabledTools === null) return full
    const enabled = new Set(row.enabledTools)
    return full.filter((name) => {
        const short = name.split('__')[1] ?? name
        return enabled.has(short) || enabled.has(name)
    })
}

// Core + always-on workspace tool names. These names must match the actual
// tools produced elsewhere (executor buildTools + workspace-tools.ts). We keep
// the list explicit rather than introspecting `ToolSet` keys because
// self-knowledge tools run before the final ToolSet is assembled.
const CORE_EXECUTION_TOOLS = [
    'read_file',
    'write_file',
    'shell',
    'task_complete',
    'write_asset',
    'self_reflect',
] as const

const CORE_WORKSPACE_TOOLS = [
    'web_search',
    'web_fetch',
    'web_read_page',
    'memory_query',
    'setup_ssh_connection',
    'setup_connection',
    'list_available_connections',
    'list_installed_connections',
    'remove_connection',
    'setup_channel',
    'list_channels',
    'remove_channel',
    'browse_hub',
    'install_extension',
    'list_extensions',
    'toggle_extension',
    'uninstall_extension',
    'synthesize_extension',
    'configure_agent',
    'create_agent',
    'manage_behavior',
    // Channel-scoped (only bound when invoked via a channel adapter with a
    // message id — telegram/slack today, discord once gateway msgs land).
    'react_to_message',
] as const

const CORE_SELF_KNOWLEDGE_TOOLS = [
    'list_my_tools',
    'get_my_capabilities',
    'check_connection_status',
    'about_plexo',
    'toggle_connection_tool',
] as const

/** Matches any "write" tool short-name (create/update/delete/send/...).
 *  Shared with apps/api/src/routes/connections.ts for the read-only quick action. */
const WRITE_TOOL_PATTERNS = /(create|update|delete|send|write|push|merge|upload|resolve|toggle|trigger|redeploy|run|purge)/i

// ── Tool factory ──────────────────────────────────────────────────────────────

export interface SelfKnowledgeOptions {
    /** When true, `list_my_tools` includes the execution tier (read_file, shell, etc.).
     *  False when used from the pure conversational path where those tools aren't bound. */
    includeExecutionTools?: boolean
}

export function buildSelfKnowledgeTools(
    workspaceId: string,
    opts: SelfKnowledgeOptions = {},
): ToolSet {
    const includeExecution = opts.includeExecutionTools ?? false

    return {
        list_my_tools: tool({
            description:
                'Return the live list of tools currently available to you in this workspace, grouped by source (core, workspace, connections, extensions, self-knowledge). Call this whenever the user asks "what tools do you have" or you need to verify your capabilities at this exact moment.',
            inputSchema: z.object({
                category: z
                    .enum(['all', 'connections', 'extensions', 'core'])
                    .optional()
                    .default('all')
                    .describe('Filter to a single tier. Default "all".'),
            }),
            execute: async ({ category }): Promise<string> => {
                auditCall(workspaceId, 'list_my_tools', { category })
                const connections = await readInstalledConnections(workspaceId)
                const extensions = await readExtensions(workspaceId)

                const sections: string[] = []

                if (category === 'all' || category === 'core') {
                    const coreTools: string[] = [
                        ...(includeExecution ? CORE_EXECUTION_TOOLS : []),
                        ...CORE_WORKSPACE_TOOLS,
                        ...CORE_SELF_KNOWLEDGE_TOOLS,
                    ]
                    sections.push(
                        `CORE (${coreTools.length}):\n${coreTools.map((t) => `  - ${t}`).join('\n')}`,
                    )
                }

                if (category === 'all' || category === 'connections') {
                    if (connections.length === 0) {
                        sections.push('CONNECTIONS: none installed')
                    } else {
                        const lines: string[] = ['CONNECTIONS:']
                        for (const row of connections) {
                            const desc = CONNECTION_REGISTRY[row.registryId]
                            const stubFlag = desc?.stub ? ' [stub — not yet implemented]' : ''
                            const tools = connectionToolNames(row)
                            if (!desc) {
                                lines.push(`  - ${row.registryId} (unknown provider — no registry entry)`)
                            } else {
                                lines.push(`  - ${desc.displayName} (${row.registryId})${stubFlag}:`)
                                for (const t of tools) lines.push(`      ${t}`)
                            }
                        }
                        sections.push(lines.join('\n'))
                    }
                }

                if (category === 'all' || category === 'extensions') {
                    if (extensions.length === 0) {
                        sections.push('EXTENSIONS: none installed')
                    } else {
                        const lines: string[] = ['EXTENSIONS:']
                        for (const ext of extensions) {
                            const enabledFlag = ext.enabled ? '' : ' (disabled)'
                            lines.push(
                                `  - ${ext.name}${ext.version ? ` v${ext.version}` : ''}${enabledFlag}`,
                            )
                            for (const t of ext.toolNames) lines.push(`      ${t}`)
                        }
                        sections.push(lines.join('\n'))
                    }
                }

                return sections.join('\n\n')
            },
        }),

        get_my_capabilities: tool({
            description:
                'Return a structured summary of this workspace\'s capabilities: connected services, enabled extensions, channel handlers, memory status, and configured LLM providers. Use when the user asks "what can you do" or "describe yourself".',
            inputSchema: z.object({}),
            execute: async (): Promise<string> => {
                auditCall(workspaceId, 'get_my_capabilities', {})
                const [meta, connections, extensions] = await Promise.all([
                    readWorkspaceMeta(workspaceId),
                    readInstalledConnections(workspaceId),
                    readExtensions(workspaceId),
                ])

                const realConns = connections.filter((r) => !CONNECTION_REGISTRY[r.registryId]?.stub)
                const stubConns = connections.filter((r) => CONNECTION_REGISTRY[r.registryId]?.stub)

                const lines: string[] = []
                lines.push(`Agent: ${meta.agentName}${meta.agentPersona ? ` — ${meta.agentPersona.slice(0, 140)}` : ''}`)
                lines.push('')
                lines.push(
                    `LLM providers (${meta.activeProviders.length}): ${meta.activeProviders.length === 0 ? 'none configured' : meta.activeProviders.map((p) => `${p.key}/${p.model}${p.key === meta.primary ? ' (primary)' : ''}`).join(', ')}`,
                )
                lines.push('')
                lines.push(
                    `Connections (${connections.length}): ${realConns.length} real, ${stubConns.length} stub`,
                )
                if (realConns.length > 0) {
                    for (const row of realConns) {
                        const desc = CONNECTION_REGISTRY[row.registryId]
                        const tools = connectionToolNames(row)
                        lines.push(
                            `  - ${desc?.displayName ?? row.registryId} [${desc?.category ?? 'unknown'}] → ${tools.length} tools`,
                        )
                    }
                }
                if (stubConns.length > 0) {
                    lines.push('  Stubs (installed but not yet implemented):')
                    for (const row of stubConns) {
                        const desc = CONNECTION_REGISTRY[row.registryId]
                        lines.push(`  - ${desc?.displayName ?? row.registryId}`)
                    }
                }
                lines.push('')
                const enabledExt = extensions.filter((e) => e.enabled)
                lines.push(`Extensions (${extensions.length}): ${enabledExt.length} enabled`)
                for (const ext of enabledExt) {
                    lines.push(`  - ${ext.name}${ext.version ? ` v${ext.version}` : ''} → ${ext.toolNames.length} tools`)
                }
                lines.push('')
                lines.push(`Channels configured: ${meta.channelCount}`)
                lines.push('')
                const embedPct = meta.memoryTotal > 0
                    ? Math.round((meta.memoryEmbedded / meta.memoryTotal) * 100)
                    : 0
                lines.push(
                    `Memory: ${meta.memoryTotal} entries (${meta.memoryEmbedded} embedded, ${embedPct}% coverage)`,
                )

                return lines.join('\n')
            },
        }),

        check_connection_status: tool({
            description:
                'Check whether a specific integration provider is connected to this workspace and list the tools it would provide. Use when the user asks "can you connect to X" or "do you have X access".',
            inputSchema: z.object({
                provider: z
                    .string()
                    .describe('Provider registry ID (e.g. "notion", "github", "slack", "linear")'),
            }),
            execute: async ({ provider }): Promise<string> => {
                auditCall(workspaceId, 'check_connection_status', { provider })
                const key = provider.toLowerCase().trim()
                const desc = CONNECTION_REGISTRY[key]

                if (!desc) {
                    const known = Object.keys(CONNECTION_REGISTRY).sort().join(', ')
                    return `Provider "${provider}" is not in the connection registry. Known providers: ${known}. To integrate: (1) Use web_search to find its API documentation yourself. (2) Use web_read_page to read the docs. (3) Call synthesize_extension with the docs URL you found and the capabilities the user wants. NEVER ask the user for documentation links — find them yourself. Only ask the user for things they uniquely possess: API keys, credentials, instance URLs.`
                }

                const rows = await readInstalledConnections(workspaceId)
                const installed = rows.find((r) => r.registryId === key)

                const header = `${desc.displayName} (${desc.id})${desc.stub ? ' [stub — not yet implemented]' : ''} — category: ${desc.category}`
                const capList = desc.capabilities
                    .map((c) => `  - ${desc.toolPrefix}__${c.name}${c.description ? ` — ${c.description}` : ''}`)
                    .join('\n')

                if (!installed) {
                    return `${header}\nSTATUS: NOT installed in this workspace.\n\nThe user can install this connection via the setup_connection tool or the Integrations UI. Once installed, these tools become available:\n${capList}`
                }

                const tools = connectionToolNames(installed)
                const enabledNote = installed.enabledTools === null
                    ? ' (all tools enabled)'
                    : ` (${tools.length}/${desc.capabilities.length} tools enabled)`

                return `${header}\nSTATUS: INSTALLED and ACTIVE${enabledNote}\n\nCurrently available tools:\n${tools.map((t) => `  - ${t}`).join('\n')}`
            },
        }),

        about_plexo: tool({
            description:
                'Return a short description of what Plexo is and what this workspace can do. Use when the user asks general questions like "what are you", "who built you", "explain yourself".',
            inputSchema: z.object({}),
            execute: async (): Promise<string> => {
                auditCall(workspaceId, 'about_plexo', {})
                const [meta, connections, extensions] = await Promise.all([
                    readWorkspaceMeta(workspaceId),
                    readInstalledConnections(workspaceId),
                    readExtensions(workspaceId),
                ])
                const realConns = connections.filter((r) => !CONNECTION_REGISTRY[r.registryId]?.stub)
                const stubConns = connections.filter((r) => CONNECTION_REGISTRY[r.registryId]?.stub)
                return PLEXO_SELF_DESCRIPTION_TEMPLATE
                    .replace('{LLM_PROVIDERS}', String(meta.activeProviders.length))
                    .replace('{CONNECTIONS}', String(connections.length))
                    .replace('{REAL_CONNECTIONS}', String(realConns.length))
                    .replace('{STUB_CONNECTIONS}', String(stubConns.length))
                    .replace('{EXTENSIONS}', String(extensions.filter((e) => e.enabled).length))
            },
        }),

        toggle_connection_tool: tool({
            description:
                'Enable or disable a specific tool from an installed integration for this workspace. ' +
                'Use when the user asks in chat to turn a tool off ("disable notion delete_page", "turn off github merge_pr") ' +
                'or to enable a specific tool or switch a provider to read-only mode. ' +
                'Scope is limited to connection-provided tools — core/built-in tools like task_complete cannot be toggled. ' +
                'The change is persisted to installed_connections.enabled_tools and takes effect on the next task/turn.',
            inputSchema: z.object({
                provider: z
                    .string()
                    .describe('Provider registry ID, e.g. "notion", "github", "slack"'),
                toolName: z
                    .string()
                    .optional()
                    .describe('Short name of the tool to toggle (e.g. "create_page"). Omit when mode is set.'),
                enabled: z
                    .boolean()
                    .optional()
                    .describe('true to enable the tool, false to disable. Required when toolName is provided.'),
                mode: z
                    .enum(['read-only', 'all'])
                    .optional()
                    .describe(
                        '"read-only" disables every write tool (create/update/delete/send/...) for the provider; ' +
                        '"all" re-enables every tool. Omit when toggling a single tool.',
                    ),
            }),
            execute: async ({ provider, toolName, enabled, mode }): Promise<string> => {
                auditCall(workspaceId, 'toggle_connection_tool', { provider, toolName, enabled, mode })
                const key = provider.toLowerCase().trim()
                const desc = CONNECTION_REGISTRY[key]
                if (!desc) {
                    return `Unknown provider "${provider}". Use list_my_tools() to see installed providers.`
                }

                const rows = await readInstalledConnections(workspaceId)
                const installed = rows.find((r) => r.registryId === key)
                if (!installed) {
                    return `${desc.displayName} is not installed in this workspace. Install it from the Integrations page or via setup_connection.`
                }

                const allShort = desc.capabilities.map((c) => c.name)
                // Build the current "enabled short-name" set from the stored enabled_tools.
                // null = every tool enabled.
                const currentEnabledShort = new Set<string>(
                    installed.enabledTools === null
                        ? allShort
                        : allShort.filter((s) => installed.enabledTools!.includes(s) || installed.enabledTools!.includes(`${desc.toolPrefix}__${s}`)),
                )

                // Resolve next state based on mode OR toolName+enabled.
                let nextEnabledShort: string[] | null
                if (mode === 'all') {
                    nextEnabledShort = null
                } else if (mode === 'read-only') {
                    nextEnabledShort = allShort.filter((s) => !WRITE_TOOL_PATTERNS.test(s))
                } else if (toolName) {
                    // Accept either short or fully-qualified tool name
                    const short = toolName.startsWith(`${desc.toolPrefix}__`)
                        ? toolName.slice(desc.toolPrefix.length + 2)
                        : toolName
                    if (!allShort.includes(short)) {
                        return `Tool "${toolName}" is not provided by ${desc.displayName}. Known: ${allShort.join(', ')}`
                    }
                    if (enabled === undefined) {
                        return `Specify enabled=true or enabled=false for tool "${short}".`
                    }
                    if (enabled) currentEnabledShort.add(short)
                    else currentEnabledShort.delete(short)
                    nextEnabledShort = Array.from(currentEnabledShort)
                    // If every tool is now enabled, store null for stability
                    if (nextEnabledShort.length === allShort.length) nextEnabledShort = null
                } else {
                    return 'Provide either { toolName, enabled } to toggle one tool, or { mode: "read-only" | "all" } for a bulk action.'
                }

                // Persist the change
                try {
                    const { db, eq, and } = await import('@plexo/db')
                    const { installedConnections } = await import('@plexo/db')
                    await db
                        .update(installedConnections)
                        .set({ enabledTools: nextEnabledShort })
                        .where(
                            and(
                                eq(installedConnections.id, installed.id),
                                eq(installedConnections.workspaceId, workspaceId),
                            ),
                        )
                } catch (err) {
                    logger.error({ err, workspaceId, provider: key }, 'toggle_connection_tool persistence failed')
                    return `Failed to update ${desc.displayName} tool state. The change was not persisted.`
                }

                const count = nextEnabledShort === null ? allShort.length : nextEnabledShort.length
                const modeLabel = mode === 'read-only'
                    ? 'read-only mode'
                    : mode === 'all'
                        ? 'all tools enabled'
                        : `${toolName} ${enabled ? 'enabled' : 'disabled'}`
                return `Updated ${desc.displayName}: ${modeLabel}. Now ${count}/${allShort.length} tools enabled. Takes effect on the next task/turn.`
            },
        }),
    }
}

// ── Compact prompt summary (for system prompt injection) ─────────────────────

/** Build a condensed capability string for the conversational system prompt.
 *  Reads live from CONNECTION_REGISTRY and installed_connections. Designed to
 *  stay well under 500 tokens even for maximally-connected workspaces. */
export async function buildCompactCapabilitySummary(workspaceId: string): Promise<string> {
    try {
        const [connections, extensions, meta] = await Promise.all([
            readInstalledConnections(workspaceId),
            readExtensions(workspaceId),
            readWorkspaceMeta(workspaceId),
        ])

        const realConns = connections.filter((r) => !CONNECTION_REGISTRY[r.registryId]?.stub)
        const stubConns = connections.filter((r) => CONNECTION_REGISTRY[r.registryId]?.stub)
        const enabledExt = extensions.filter((e) => e.enabled)

        const connList = realConns.length === 0
            ? 'none'
            : realConns
                .map((r) => CONNECTION_REGISTRY[r.registryId]?.displayName ?? r.registryId)
                .join(', ')

        const stubList = stubConns.length === 0
            ? ''
            : ` (${stubConns.length} stubs: ${stubConns.map((r) => CONNECTION_REGISTRY[r.registryId]?.displayName ?? r.registryId).join(', ')})`

        const extList = enabledExt.length === 0
            ? 'none'
            : enabledExt.map((e) => e.name).join(', ')

        const providerLabel = meta.activeProviders.length === 0
            ? 'none configured'
            : meta.activeProviders.map((p) => p.key).join(', ')

        return [
            'CURRENT CAPABILITIES (live — read from workspace state):',
            `  LLM providers: ${providerLabel}`,
            `  Integrations: ${connList}${stubList}`,
            `  Extensions: ${extList}`,
            `  Memory: ${meta.memoryTotal} entries`,
            '  Self-knowledge tools: list_my_tools, get_my_capabilities, check_connection_status, about_plexo',
            '  RULE: When the user asks what you can do, what tools you have, or whether you can connect to a service, CALL list_my_tools or check_connection_status FIRST before answering. Never guess from memory.',
            '  RULE: When the user asks to connect to or integrate with an external service: (1) check_connection_status to see if installed. (2) If not, browse_hub to search for an existing Hub extension. (3) If found, offer to install it with install_extension. (4) If nothing in the Hub, web_search for API docs, web_read_page to read them, then synthesize_extension. NEVER ask the user for documentation — that is your job. Only ask for API keys, credentials, or instance URLs.',
        ].join('\n')
    } catch (err) {
        logger.warn({ err, workspaceId }, 'buildCompactCapabilitySummary failed')
        return 'CURRENT CAPABILITIES: call list_my_tools or get_my_capabilities to see live state.'
    }
}
