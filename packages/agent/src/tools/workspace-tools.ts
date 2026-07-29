// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Unified workspace tool registry.
 *
 * Produces the complete tool set for a workspace — available to EVERY
 * invocation path (conversations, tasks, A2A calls). Channels are input
 * surfaces; tools are the agent's hands regardless of how it was invoked.
 *
 * Two tiers:
 * - Workspace tools (this function): web_search, memory_query, connection
 *   tools, plugin tools, self-management tools. Available everywhere.
 * - Execution tools (executor/index.ts buildTools): shell, read_file,
 *   write_file, task_complete, browser_*. Require task/filesystem context.
 */

import { tool } from 'ai'
import { z } from 'zod'
import { eq, and, isNull } from 'drizzle-orm'
import { db } from '@plexo/db'
import { workspaces, behaviorRules, installedConnections, channels, extensions, connectionsRegistry } from '@plexo/db'
import { invalidateWorkspaceToolSets } from '../tool-set-cache.js'
import { loadConnectionTools, type ToolSet } from '../connections/bridge.js'
import { buildSelfKnowledgeTools } from './self-knowledge-tools.js'
import { buildEnvironmentTools } from './environment-tools.js'
import { buildWebTools } from './web-tools.js'
import { buildMigrationTools } from './migration-tools.js'
import { getCachedToolSet } from '../tool-set-cache.js'
import pino from 'pino'

const logger = pino({ name: 'workspace-tools' })

// ── Capability sabotage detection ─────────────────────────────────────────────
// Prevents the agent from injecting text (via persona, behavior rules, etc.)
// that disables core capabilities like image processing, voice I/O, or model
// routing. This has happened in production — the agent "helpfully" added rules
// or persona text that told itself to refuse images/voice, leaving users stuck.

// Note: ['\u2019] matches both straight and curly apostrophes (U+2019)
const DENY_VERBS = `do\\s+not|don['\u2019]?t|doesn['\u2019]?t|never|refuse|ignore|skip|disable|cannot|can['\u2019]?t|unable|won['\u2019]?t`
const DENY_VERBS_RE = `\\b(${DENY_VERBS})\\b`
// Reverse-order deny verbs (noun first, then "can't be X'd")
const DENY_PASSIVES = `can['\u2019]?t|cannot|unable|won['\u2019]?t|doesn['\u2019]?t|isn['\u2019]?t`
const DENY_PASSIVES_RE = `\\b(${DENY_PASSIVES})\\b`

const CAPABILITY_SABOTAGE_PATTERNS: Array<{ pattern: RegExp; capability: string }> = [
    // Image / vision — verb-first: "do not process images"
    { pattern: new RegExp(`${DENY_VERBS_RE}.{0,40}\\b(images?|photos?|pictures?|vision|visual|multimodal|media)\\b`, 'i'), capability: 'image processing' },
    // Image / vision — noun-first: "images can't be processed", "photos are not supported"
    { pattern: new RegExp(`\\b(images?|photos?|pictures?|vision|visual|multimodal)\\b.{0,40}${DENY_PASSIVES_RE}`, 'i'), capability: 'image processing' },
    { pattern: /\b(images?|photos?|pictures?|vision|visual|multimodal)\b.{0,40}\b(disabled?|off|unsupported|not\s+(?:available|supported|enabled|handled|processed))\b/i, capability: 'image processing' },
    // Voice / audio / TTS / STT — verb-first
    { pattern: new RegExp(`${DENY_VERBS_RE}.{0,40}\\b(voice|audio|speech|transcri\\w*|tts|stt|speak\\w*|listen\\w*)\\b`, 'i'), capability: 'voice/audio' },
    // Voice / audio — noun-first: "audio can't be processed"
    { pattern: new RegExp(`\\b(voice|audio|speech|tts|stt)\\b.{0,40}${DENY_PASSIVES_RE}`, 'i'), capability: 'voice/audio' },
    { pattern: /\b(voice|audio|speech|tts|stt)\b.{0,40}\b(disabled?|off|unsupported|not\s+(?:available|supported|enabled|handled|processed))\b/i, capability: 'voice/audio' },
    // Model / provider routing
    { pattern: new RegExp(`${DENY_VERBS_RE}.{0,40}\\b(models?|providers?|routing|fallback|vision\\s+models?)\\b`, 'i'), capability: 'model routing' },
    { pattern: /\b(always|only|must)\s+use\s+(?:models?|providers?)\b/i, capability: 'model routing' },
    { pattern: /\b(switch|change|override|force)\b.{0,20}\b(models?|providers?|routing)\b/i, capability: 'model routing' },
    // Channel disabling
    { pattern: new RegExp(`${DENY_VERBS_RE}.{0,40}\\b(telegram|slack|discord|channels?|webhooks?)\\b`, 'i'), capability: 'channel routing' },
]

/**
 * Check if text contains patterns that would disable core agent capabilities.
 * Returns a description of the blocked capability, or null if clean.
 */
export function checkCapabilitySabotage(text: string): string | null {
    for (const { pattern, capability } of CAPABILITY_SABOTAGE_PATTERNS) {
        if (pattern.test(text)) return capability
    }
    return null
}

/**
 * Build the complete workspace-level tool set.
 *
 * @param workspaceId - workspace context
 * @param opts - optional overrides
 */
export async function buildWorkspaceTools(workspaceId: string, opts?: {
    /** Pre-resolved Brave Search API key (avoids re-fetching) */
    braveKey?: string | null
    /** Pre-resolved Tavily API key (avoids re-fetching) */
    tavilyKey?: string | null
    /** Internal API base URL for self-management calls */
    apiBase?: string
}): Promise<ToolSet> {
    const apiBase = opts?.apiBase ?? process.env.INTERNAL_API_URL ?? 'http://localhost:3001'

    // Load connection tools (GitHub, Slack, SSH, etc.)
    // Cached per-workspace for TOOL_SET_TTL_MS to avoid re-hydration on every
    // chat turn. Invalidated by the connections install/uninstall routes.
    let connectionTools: ToolSet = {}
    try {
        connectionTools = await getCachedToolSet(
            `connections:${workspaceId}`,
            () => loadConnectionTools(workspaceId),
        )
    } catch (err) {
        logger.warn({ err, workspaceId }, 'Failed to load integration tools — proceeding without')
    }

    // Load plugin tools (extensions) — cached the same way. The inner
    // dynamic import preserves the "plugins may not be available" escape.
    let pluginTools: ToolSet = {}
    try {
        pluginTools = await getCachedToolSet(
            `plugins:${workspaceId}`,
            async () => {
                const { loadPluginTools } = await import('../plugins/bridge.js')
                return loadPluginTools(workspaceId)
            },
        )
    } catch { /* non-fatal — plugins may not be available */ }

    // Resolve web-search API keys. The agent package never reads workspace
    // secrets directly — the caller (channel-ai.ts) pre-resolves them. We fall
    // back to env vars here only as a last resort for dev/self-host scenarios.
    const braveKey = opts?.braveKey ?? process.env.BRAVE_SEARCH_API_KEY ?? null
    const tavilyKey = opts?.tavilyKey ?? process.env.TAVILY_API_KEY ?? null

    // ── Self-knowledge tools (live introspection, Phase 3) ─────────────
    // These tools let the agent call list_my_tools / check_connection_status
    // at runtime to answer "what can you do right now" accurately. They read
    // directly from CONNECTION_REGISTRY + workspace DB on each call.
    const selfKnowledgeTools = buildSelfKnowledgeTools(workspaceId, {
        includeExecutionTools: false, // workspace path doesn't expose read_file/shell/etc.
    })

    // ── Environment awareness tools (runtime, infra, repo, deploy, scope) ─
    // Static/env-driven introspection — complements self-knowledge which is
    // workspace/DB-driven. Safe, read-only, lightweight.
    const environmentTools = buildEnvironmentTools()

    return {
        // ── Integration tools (from installed integrations) ────────────────
        ...connectionTools,

        // ── Plugin tools (from tools) ───────────────────────────────
        ...pluginTools,

        // ── Self-knowledge (list_my_tools, get_my_capabilities, etc.) ──────
        ...selfKnowledgeTools,

        // ── Environment awareness (runtime, infra, repo, deploy context) ───
        ...environmentTools,

        // ── Web tools (consolidated: web_search, web_fetch, web_read_page) ─
        // Single source of truth — packages/agent/src/tools/web-tools.ts.
        // Provider priority: Tavily > Brave > DuckDuckGo HTML scrape (no key needed).
        ...buildWebTools({ tavilyApiKey: tavilyKey, braveApiKey: braveKey }),

        // ── Migration introspection (get_corpus_migration_status) ──────────
        // Workspace-scoped: queries corpus_migration_log for this workspace only.
        ...buildMigrationTools(workspaceId),

        // ── Memory query ────────────────────────────────────────────────
        memory_query: tool({
            description: 'Search your conversation history and memory entries. Use to recall prior conversations, find preferences, or check what you remember about a topic.',
            inputSchema: z.object({
                query: z.string().describe('What to search for'),
                source: z.enum(['conversations', 'memory', 'all']).optional().default('all'),
                limit: z.number().optional().default(10),
            }),
            execute: async ({ query, source = 'all', limit = 10 }): Promise<string> => {
                try {
                    const { db } = await import('@plexo/db')
                    const { conversations, memoryEntries } = await import('@plexo/db')
                    const { sql, desc } = await import('drizzle-orm')

                    const keywords = query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2)
                    if (keywords.length === 0) return 'No meaningful search terms. Try more specific keywords.'

                    const sections: string[] = []

                    if (source === 'conversations' || source === 'all') {
                        const conditions = keywords.map(kw => sql`(${conversations.message} ILIKE ${'%' + kw + '%'} OR ${conversations.reply} ILIKE ${'%' + kw + '%'})`)
                        const filter = conditions.length === 1 ? conditions[0]! : sql.join(conditions, sql` OR `)
                        const rows = await db.select({ message: conversations.message, reply: conversations.reply, source: conversations.source, createdAt: conversations.createdAt })
                            .from(conversations).where(sql`${conversations.workspaceId} = ${workspaceId} AND (${filter})`).orderBy(desc(conversations.createdAt)).limit(limit)
                        if (rows.length > 0) {
                            sections.push(`=== CONVERSATIONS (${rows.length} matches) ===\n` + rows.map(r => {
                                const ts = r.createdAt instanceof Date ? r.createdAt.toISOString().slice(0, 19) : String(r.createdAt)
                                return `[${ts}] (${r.source}) User: ${(r.message ?? '').slice(0, 200)}\nAgent: ${(r.reply ?? '').slice(0, 200)}`
                            }).join('\n\n'))
                        }
                    }

                    if (source === 'memory' || source === 'all') {
                        const conditions = keywords.map(kw => sql`(${memoryEntries.content} ILIKE ${'%' + kw + '%'} OR ${memoryEntries.shorthand} ILIKE ${'%' + kw + '%'})`)
                        const filter = conditions.length === 1 ? conditions[0]! : sql.join(conditions, sql` OR `)
                        const rows = await db.select({ content: memoryEntries.content, shorthand: memoryEntries.shorthand, type: memoryEntries.type, tier: memoryEntries.tier, createdAt: memoryEntries.createdAt, confidence: memoryEntries.confidence })
                            .from(memoryEntries).where(sql`${memoryEntries.workspaceId} = ${workspaceId} AND (${filter})`).orderBy(sql`${memoryEntries.confidence} * exp(-EXTRACT(EPOCH FROM (now() - ${memoryEntries.createdAt})) / 604800) DESC`).limit(Math.min(limit * 5, 100))
                        const { rankBySalience } = await import('./salience.js')
                        const ranked = rankBySalience(rows, { budgetChars: 4000, limit })
                        if (ranked.length > 0) {
                            sections.push(`=== MEMORY (${ranked.length} matches) ===\n` + ranked.map(r => {
                                const ts = r.createdAt instanceof Date ? r.createdAt.toISOString().slice(0, 19) : String(r.createdAt)
                                return `[${ts}] (${r.type}/${r.tier}) ${r.shorthand ?? r.content.slice(0, 300)}`
                            }).join('\n'))
                        }
                    }

                    return sections.length > 0 ? sections.join('\n\n') : `No results for "${query}" in ${source === 'all' ? 'conversations or memory' : source}.`
                } catch (err) {
                    return `Memory search error: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        // ── SSH setup (from SSH build, now available everywhere) ─────────
        setup_ssh_connection: tool({
            description: 'Set up an SSH integration to a remote server. Use when the user asks to connect to a server, VPS, or remote machine.',
            inputSchema: z.object({
                host: z.string().describe('Server hostname or IP'),
                port: z.number().optional().default(22),
                username: z.string().describe('SSH username'),
                authMethod: z.enum(['key', 'password']),
                credential: z.string().describe('Private key (PEM) or password'),
                nickname: z.string().optional(),
                mode: z.enum(['full', 'readonly']).optional().default('full'),
            }),
            execute: async ({ host, port = 22, username, authMethod, credential, nickname, mode = 'full' }): Promise<string> => {
                try {
                    const { sshTest } = await import('../ssh/client.js')
                    const test = await sshTest({ host, port, username, privateKey: authMethod === 'key' ? credential : undefined, password: authMethod === 'password' ? credential : undefined })
                    if (!test.ok) return `Connection test failed: ${test.message}`

                    const creds: Record<string, string> = { host, port: String(port), username, auth_method: authMethod === 'key' ? 'Private Key' : 'Password', mode: mode === 'readonly' ? 'Read Only' : 'Full Access' }
                    if (authMethod === 'key') creds.private_key = credential; else creds.password = credential

                    const connName = nickname ?? `${username}@${host}`
                    const [installed] = await db.insert(installedConnections).values({
                        workspaceId,
                        registryId: 'ssh',
                        name: connName,
                        credentials: creds as Record<string, unknown>,
                        status: 'active',
                    }).returning({ id: installedConnections.id })
                    if (!installed) return 'Installation failed: insert returned no data.'

                    invalidateWorkspaceToolSets(workspaceId)
                    return `SSH integration established to ${host} as ${username} (${test.durationMs}ms). Saved as "${connName}".`
                } catch (err) { return `SSH setup failed: ${err instanceof Error ? err.message : String(err)}` }
            },
        }),

        // ── Generic integration management ───────────────────────────────
        setup_connection: tool({
            description: 'Install a new connection (GitHub, Slack, Stripe, connector, or any service in the registry). For SSH, use setup_ssh_connection instead.',
            inputSchema: z.object({
                registryId: z.string().describe('Connection type ID (e.g., "github", "slack", "stripe", "cloudflare")'),
                name: z.string().describe('Friendly name for this connection'),
                credentials: z.record(z.string()).describe('Credentials as key-value pairs (e.g., {"api_key": "ghp_...", "token": "xoxb-..."})'),
            }),
            execute: async ({ registryId, name, credentials }): Promise<string> => {
                try {
                    // Validate registry entry exists
                    const [reg] = await db.select({ id: connectionsRegistry.id, name: connectionsRegistry.name })
                        .from(connectionsRegistry).where(eq(connectionsRegistry.id, registryId)).limit(1)
                    if (!reg) return `Integration "${registryId}" not found in registry.`

                    const [installed] = await db.insert(installedConnections).values({
                        workspaceId,
                        registryId: reg.id,
                        name: name ?? reg.name,
                        credentials: credentials as Record<string, unknown>,
                        status: 'active',
                    }).returning({ id: installedConnections.id })
                    if (!installed) return `Failed to install ${registryId}: insert returned no data.`

                    invalidateWorkspaceToolSets(workspaceId)
                    return `Integration "${name}" (${registryId}) installed successfully. Tools are now available.`
                } catch (err) { return `Integration setup failed: ${err instanceof Error ? err.message : String(err)}` }
            },
        }),

        list_available_connections: tool({
            description: 'List all integration types available in the registry (GitHub, Slack, SSH, etc.) with their descriptions and required credentials.',
            inputSchema: z.object({}),
            execute: async (): Promise<string> => {
                try {
                    const res = await fetch(`${apiBase}/api/v1/connections/registry`, {
                        headers: { 'X-Plexo-Service-Key': process.env.PLEXO_SERVICE_KEY || '' },
                    })
                    if (!res.ok) return 'Failed to fetch integration registry.'
                    const data = await res.json() as { items?: Array<{ id: string; name: string; description?: string; category?: string }> }
                    const items = data.items ?? []
                    if (items.length === 0) return 'No integration types available.'
                    return items.map(c => `• ${c.name} (${c.id}) — ${c.description ?? c.category ?? 'No description'}`).join('\n')
                } catch (err) { return `Failed to list integrations: ${err instanceof Error ? err.message : String(err)}` }
            },
        }),

        list_installed_connections: tool({
            description: 'List integrations currently installed in this workspace with their status and tools.',
            inputSchema: z.object({}),
            execute: async (): Promise<string> => {
                try {
                    const items = await db.select({
                        id: installedConnections.id,
                        registryId: installedConnections.registryId,
                        name: installedConnections.name,
                        status: installedConnections.status,
                        enabledTools: installedConnections.enabledTools,
                    }).from(installedConnections)
                        .where(eq(installedConnections.workspaceId, workspaceId))
                    if (items.length === 0) return 'No integrations installed in this workspace.'
                    return items.map(c => `• ${c.name} (${c.registryId}) — ${c.status}${c.enabledTools?.length ? ` — tools: ${c.enabledTools.join(', ')}` : ''}`).join('\n')
                } catch (err) { return `Failed to list integrations: ${err instanceof Error ? err.message : String(err)}` }
            },
        }),

        remove_connection: tool({
            description: 'Remove an installed integration. WARNING: This removes the integration and its tools. Ask the user to confirm before calling this.',
            inputSchema: z.object({
                connectionId: z.string().describe('The connection installation ID to remove'),
                confirmed: z.boolean().describe('Must be true — confirm with the user first'),
            }),
            execute: async ({ connectionId, confirmed }): Promise<string> => {
                if (!confirmed) return 'Please confirm with the user before removing an integration. Ask them to say "yes" or "confirm".'
                try {
                    // Read before delete for channel bridge cleanup
                    const [conn] = await db.select({ registryId: installedConnections.registryId })
                        .from(installedConnections)
                        .where(and(eq(installedConnections.id, connectionId), eq(installedConnections.workspaceId, workspaceId)))
                        .limit(1)

                    await db.delete(installedConnections)
                        .where(and(eq(installedConnections.id, connectionId), eq(installedConnections.workspaceId, workspaceId)))

                    // Bridge cleanup: remove auto-created channel for communication integrations
                    const CHANNEL_TYPES = ['telegram', 'slack', 'discord', 'whatsapp', 'signal', 'matrix'] as const
                    if (conn && (CHANNEL_TYPES as readonly string[]).includes(conn.registryId)) {
                        await db.delete(channels)
                            .where(and(eq(channels.workspaceId, workspaceId), eq(channels.type, conn.registryId as any)))
                            .catch(() => { /* non-fatal */ })
                    }

                    invalidateWorkspaceToolSets(workspaceId)
                    return 'Integration removed successfully.'
                } catch (err) { return `Failed to remove integration: ${err instanceof Error ? err.message : String(err)}` }
            },
        }),

        // ── Channel management ──────────────────────────────────────────
        setup_channel: tool({
            description: 'Create a communication channel (Telegram, Slack, Discord) for this workspace. For Telegram: provide the bot token from @BotFather. For Slack: provide the bot token. For Discord: provide the bot token.',
            inputSchema: z.object({
                type: z.enum(['telegram', 'slack', 'discord']).describe('Channel type'),
                name: z.string().describe('Display name for this channel'),
                config: z.record(z.string()).describe('Channel config (e.g., {"bot_token": "..."} for Telegram, {"token": "..."} for Slack)'),
            }),
            execute: async ({ type, name, config }): Promise<string> => {
                try {
                    const [created] = await db.insert(channels).values({
                        workspaceId,
                        type: type as 'telegram' | 'slack' | 'discord',
                        name,
                        config,
                        enabled: true,
                    }).returning()
                    if (!created) return `Failed to create ${type} channel: insert returned no data.`
                    return `${type} channel "${name}" created successfully (ID: ${created.id}).`
                } catch (err) { return `Channel setup failed: ${err instanceof Error ? err.message : String(err)}` }
            },
        }),

        list_channels: tool({
            description: 'List communication channels configured for this workspace.',
            inputSchema: z.object({}),
            execute: async (): Promise<string> => {
                try {
                    const items = await db.select({
                        id: channels.id,
                        type: channels.type,
                        name: channels.name,
                        enabled: channels.enabled,
                    }).from(channels)
                        .where(eq(channels.workspaceId, workspaceId))
                    if (items.length === 0) return 'No channels configured.'
                    return items.map(c => `• ${c.name} (${c.type}) — ${c.enabled ? 'enabled' : 'disabled'}`).join('\n')
                } catch (err) { return `Failed to list channels: ${err instanceof Error ? err.message : String(err)}` }
            },
        }),

        remove_channel: tool({
            description: 'Remove a communication channel. WARNING: This disconnects the channel. Ask the user to confirm before calling this.',
            inputSchema: z.object({
                channelId: z.string().describe('Channel ID to remove'),
                confirmed: z.boolean().describe('Must be true — confirm with the user first'),
            }),
            execute: async ({ channelId, confirmed }): Promise<string> => {
                if (!confirmed) return 'Please confirm with the user before removing a channel.'
                try {
                    await db.delete(channels)
                        .where(and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)))
                    return 'Channel removed successfully.'
                } catch (err) { return `Failed to remove channel: ${err instanceof Error ? err.message : String(err)}` }
            },
        }),

        // ── Skill/tool management ──────────────────────────────────
        browse_hub: tool({
            description: 'Browse the Plexo Hub marketplace for skills, agents, and tools. Search by name or list all available.',
            inputSchema: z.object({
                query: z.string().optional().describe('Search query (leave empty to list all)'),
            }),
            execute: async ({ query }): Promise<string> => {
                try {
                    const url = query
                        ? `${apiBase}/api/v1/registry?q=${encodeURIComponent(query)}`
                        : `${apiBase}/api/v1/registry`
                    const res = await fetch(url)
                    if (!res.ok) return 'Failed to browse Hub.'
                    const data = await res.json() as { items?: Array<{ name: string; description?: string; version?: string; type?: string; installCount?: number }> }
                    const items = data.items ?? []
                    if (items.length === 0) return query ? `No results for "${query}" in the Hub.` : 'The Hub is empty.'
                    return items.map(e => `• ${e.name}${e.version ? ` v${e.version}` : ''} (${e.type ?? 'extension'})${e.description ? ' — ' + e.description : ''}${e.installCount ? ` [${e.installCount} installs]` : ''}`).join('\n')
                } catch (err) { return `Hub browse failed: ${err instanceof Error ? err.message : String(err)}` }
            },
        }),

        install_extension: tool({
            description: 'Install a skill or tool from the Hub into this workspace. Use browse_hub first to find available tools.',
            inputSchema: z.object({
                name: z.string().describe('Extension name or slug from the Hub (e.g., "@plexo/seo-skill")'),
            }),
            execute: async ({ name }): Promise<string> => {
                try {
                    // Fetch manifest from registry (public endpoint — no auth needed)
                    const regRes = await fetch(`${apiBase}/api/v1/registry/${encodeURIComponent(name)}`)
                    if (!regRes.ok) return `Tool "${name}" not found in the Hub. Use browse_hub to search.`
                    const manifest = await regRes.json() as Record<string, unknown>

                    // Insert directly into extensions table
                    const m = manifest as { name: string; version?: string; type?: string; plexo?: string; entry?: string }
                    const [inserted] = await db.insert(extensions).values({
                        workspaceId,
                        name: m.name ?? name,
                        version: m.version ?? '1.0.0',
                        type: (m.type ?? 'skill') as any,
                        pexVersion: m.plexo ?? '0.4.0',
                        entry: m.entry ?? 'index.js',
                        manifest: manifest as object,
                        enabled: false,
                        settings: {},
                    }).returning({ id: extensions.id })
                    if (!inserted) return `Failed to install "${name}": insert returned no data.`

                    invalidateWorkspaceToolSets(workspaceId)
                    return `Tool "${name}" installed successfully. Its capabilities are now available.`
                } catch (err) { return `Install failed: ${err instanceof Error ? err.message : String(err)}` }
            },
        }),

        list_extensions: tool({
            description: 'List installed skills and tools in this workspace with their status.',
            inputSchema: z.object({}),
            execute: async (): Promise<string> => {
                try {
                    const items = await db.select({
                        id: extensions.id,
                        name: extensions.name,
                        version: extensions.version,
                        enabled: extensions.enabled,
                        type: extensions.type,
                    }).from(extensions)
                        .where(eq(extensions.workspaceId, workspaceId))
                        .orderBy(extensions.installedAt)
                    if (items.length === 0) return 'No tools installed. Use browse_hub to find skills.'
                    return items.map(e => `• ${e.name}${e.version ? ` v${e.version}` : ''} — ${e.enabled ? 'enabled' : 'disabled'} (${e.type ?? 'extension'})`).join('\n')
                } catch (err) { return `Failed to list tools: ${err instanceof Error ? err.message : String(err)}` }
            },
        }),

        toggle_extension: tool({
            description: 'Enable or disable an installed tool.',
            inputSchema: z.object({
                extensionId: z.string().describe('Extension ID'),
                enabled: z.boolean().describe('true to enable, false to disable'),
            }),
            execute: async ({ extensionId, enabled }): Promise<string> => {
                try {
                    const [existing] = await db.select({ id: extensions.id, workspaceId: extensions.workspaceId })
                        .from(extensions).where(eq(extensions.id, extensionId)).limit(1)
                    if (!existing || existing.workspaceId !== workspaceId) return 'Tool not found in this workspace.'

                    await db.update(extensions).set({ enabled }).where(eq(extensions.id, extensionId))
                    invalidateWorkspaceToolSets(workspaceId)
                    return `Tool ${enabled ? 'enabled' : 'disabled'} successfully.`
                } catch (err) { return `Toggle failed: ${err instanceof Error ? err.message : String(err)}` }
            },
        }),

        uninstall_extension: tool({
            description: 'Uninstall a tool. WARNING: This removes the tool and its capabilities. Ask the user to confirm before calling this.',
            inputSchema: z.object({
                extensionId: z.string().describe('Extension ID to uninstall'),
                confirmed: z.boolean().describe('Must be true — confirm with the user first'),
            }),
            execute: async ({ extensionId, confirmed }): Promise<string> => {
                if (!confirmed) return 'Please confirm with the user before uninstalling a tool.'
                try {
                    const [existing] = await db.select({ id: extensions.id, workspaceId: extensions.workspaceId })
                        .from(extensions).where(eq(extensions.id, extensionId)).limit(1)
                    if (!existing || existing.workspaceId !== workspaceId) return 'Tool not found in this workspace.'

                    await db.delete(extensions).where(eq(extensions.id, extensionId))
                    invalidateWorkspaceToolSets(workspaceId)
                    return 'Tool uninstalled successfully.'
                } catch (err) { return `Uninstall failed: ${err instanceof Error ? err.message : String(err)}` }
            },
        }),

        // ── Tool synthesis ──────────────────────────────────────────
        synthesize_extension: tool({
            description: 'Research a third-party service API and auto-generate a tool for it. Use when the user wants to integrate with a service that has no installed tool (e.g., "Build me an Airtable integration"). Researches API docs, generates code, validates, installs, and activates. Ask the user to confirm before calling.',
            inputSchema: z.object({
                serviceName: z.string().describe('Service name (e.g., "Airtable", "Notion", "Intercom")'),
                serviceWebsite: z.string().describe('Official docs or API URL'),
                requestedCapabilities: z.string().describe('Comma-separated operations (e.g., "list records, create record, update record")'),
                confirmed: z.boolean().describe('Must be true — describe what will be generated and ask user to confirm'),
            }),
            execute: async ({ serviceName, serviceWebsite, requestedCapabilities, confirmed }): Promise<string> => {
                if (!confirmed) return `I can build a ${serviceName} integration with these capabilities: ${requestedCapabilities}. This will auto-generate code, create a connection type, and install it. Shall I proceed?`
                try {
                    const { synthesizeExtension } = await import('../plugins/synthesizer.js')
                    const caps = requestedCapabilities.split(',').map(s => s.trim()).filter(Boolean)
                    const result = await synthesizeExtension({ serviceName, serviceWebsite, requestedCapabilities: caps, workspaceId })
                    if (!result.ok) return `Synthesis failed: ${result.error}`
                    return result.message
                } catch (err) { return `Synthesis failed: ${err instanceof Error ? err.message : String(err)}` }
            },
        }),

        // ── Agent configuration ─────────────────────────────────────────
        // NOTE: systemPromptExtra is intentionally NOT exposed here — it is
        // operator-only (Settings UI). Allowing the agent to inject arbitrary
        // text into its own system prompt is a capability-sabotage vector.
        configure_agent: tool({
            description: 'Update workspace agent settings: name, persona, or tagline. Use when the user says "change your name", "update your persona", etc. You CANNOT change system prompt extras — that is operator-only via the Settings UI.',
            inputSchema: z.object({
                agentName: z.string().optional().describe('New agent display name'),
                agentPersona: z.string().optional().describe('Agent persona description — must not contain instructions that disable capabilities like image/voice/model routing'),
                agentTagline: z.string().optional().describe('Short tagline shown in the UI'),
            }),
            execute: async (updates): Promise<string> => {
                const settings: Record<string, unknown> = {}
                if (updates.agentName) settings.agentName = updates.agentName
                if (updates.agentPersona) {
                    const blocked = checkCapabilitySabotage(updates.agentPersona)
                    if (blocked) return `Rejected: persona text would disable core capabilities — ${blocked}`
                    settings.agentPersona = updates.agentPersona
                }
                if (updates.agentTagline) settings.agentTagline = updates.agentTagline

                if (Object.keys(settings).length === 0) return 'No changes specified.'

                // Agent-source guard: strip protected infrastructure keys
                const PROTECTED_KEYS = new Set(['systemPromptExtra', 'voice', 'aiProviders', 'defaultModel', 'intelligenceSettings', 'readOnlyMode', 'safeMode'])
                for (const key of PROTECTED_KEYS) {
                    if (key in settings) delete settings[key]
                }
                if (Object.keys(settings).length === 0) return 'No changes specified (protected keys were stripped).'

                try {
                    // Read current settings, deep-merge, write back
                    const [ws] = await db.select({ settings: workspaces.settings })
                        .from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
                    if (!ws) return 'Workspace not found.'
                    const current = (ws.settings ?? {}) as Record<string, unknown>
                    const merged = { ...current, ...settings }
                    await db.update(workspaces).set({ settings: merged }).where(eq(workspaces.id, workspaceId))
                    const changes = Object.entries(settings).map(([k, v]) => `${k}: ${v}`).join(', ')
                    return `Agent settings updated: ${changes}`
                } catch (err) { return `Configure failed: ${err instanceof Error ? err.message : String(err)}` }
            },
        }),

        // ── Voice output configuration ───────────────────────────────────────
        // This is the SAFE way for agents to change TTS voice. It only touches
        // voice.ttsModel in settings — cannot affect API keys or routing.
        configure_voice: tool({
            description: 'Change the text-to-speech voice used for voice replies. Lists available voices or sets a new one. Use this when the user asks to change the voice, speech, or TTS settings.',
            inputSchema: z.object({
                action: z.enum(['list', 'set']).describe('"list" to see available voices, "set" to change the voice'),
                voice: z.string().optional().describe('Voice ID to set (e.g., "aura-orion-en"). Required for "set" action.'),
            }),
            execute: async ({ action, voice }): Promise<string> => {
                const VOICES: Record<string, string> = {
                    'aura-asteria-en': 'Female, American, warm (default)',
                    'aura-luna-en': 'Female, American, soft',
                    'aura-stella-en': 'Female, American, confident',
                    'aura-athena-en': 'Female, British',
                    'aura-hera-en': 'Female, American, mature',
                    'aura-orion-en': 'Male, American',
                    'aura-arcas-en': 'Male, American, deep',
                    'aura-perseus-en': 'Male, American, authoritative',
                    'aura-angus-en': 'Male, Irish',
                    'aura-orpheus-en': 'Male, American, clear',
                    'aura-helios-en': 'Male, British',
                    'aura-zeus-en': 'Male, American, powerful',
                }

                if (action === 'list') {
                    return 'Available TTS voices:\n' + Object.entries(VOICES).map(([id, desc]) => `• ${id} — ${desc}`).join('\n')
                }

                if (action === 'set') {
                    if (!voice) return 'voice parameter is required for "set" action.'
                    if (!VOICES[voice]) return `Unknown voice "${voice}". Use configure_voice with action "list" to see available voices.`

                    try {
                        // Write directly to DB — internal API calls lack auth context.
                        const [ws] = await db.select({ settings: workspaces.settings })
                            .from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
                        if (!ws) return 'Workspace not found.'
                        const current = (ws.settings ?? {}) as Record<string, unknown>
                        const currentVoice = (current.voice ?? {}) as Record<string, unknown>
                        const newSettings = { ...current, voice: { ...currentVoice, ttsModel: voice } }
                        await db.update(workspaces).set({ settings: newSettings }).where(eq(workspaces.id, workspaceId))
                        return `Voice changed to ${voice} (${VOICES[voice]}). Voice replies will now use this voice.`
                    } catch (err) { return `Voice config failed: ${err instanceof Error ? err.message : String(err)}` }
                }

                return 'Invalid action. Use "list" or "set".'
            },
        }),

        create_agent: tool({
            description: 'Create a new sub-agent (A2A compatible) in this workspace. The sub-agent will be discoverable and can receive tasks.',
            inputSchema: z.object({
                name: z.string().describe('Agent name'),
                description: z.string().describe('What this agent does'),
                capabilities: z.array(z.string()).optional().describe('List of capabilities (e.g., ["code_review", "deployment"])'),
            }),
            execute: async ({ name, description, capabilities }): Promise<string> => {
                try {
                    const manifest = {
                        name,
                        version: '1.0.0',
                        description,
                        type: 'agent',
                        capabilities: capabilities ?? [],
                        tools: [],
                    }
                    const [inserted] = await db.insert(extensions).values({
                        workspaceId,
                        name,
                        version: '1.0.0',
                        type: 'agent' as any,
                        pexVersion: '0.4.0',
                        entry: 'index.js',
                        manifest: manifest as object,
                        enabled: false,
                        settings: {},
                    }).returning({ id: extensions.id })
                    if (!inserted) return 'Failed to create agent: insert returned no data.'

                    invalidateWorkspaceToolSets(workspaceId)
                    return `Sub-agent "${name}" created (ID: ${inserted.id}). It is now discoverable via A2A and can receive tasks.`
                } catch (err) { return `Agent creation failed: ${err instanceof Error ? err.message : String(err)}` }
            },
        }),

        manage_behavior: tool({
            description: 'List, add, or remove workspace behavior rules that guide how the agent operates. You CANNOT add rules that disable core capabilities (image, voice, model routing, channels). You CANNOT add safety_constraint rules — those are platform-only.',
            inputSchema: z.object({
                action: z.enum(['list', 'add', 'remove']).describe('"list" to see rules, "add" to create, "remove" to delete'),
                ruleText: z.string().optional().describe('Rule text (for add)'),
                ruleType: z.string().optional().describe('Rule type: communication_style, operational_procedure, domain_knowledge (for add). safety_constraint is NOT allowed.'),
                ruleId: z.string().optional().describe('Rule ID (for remove)'),
                confirmed: z.boolean().optional().describe('Must be true for remove — confirm with user first'),
            }),
            execute: async ({ action, ruleText, ruleType, ruleId, confirmed }): Promise<string> => {
                try {
                    if (action === 'list') {
                        const rows = await db.select().from(behaviorRules).where(
                            and(
                                eq(behaviorRules.workspaceId, workspaceId),
                                isNull(behaviorRules.projectId),
                                isNull(behaviorRules.deletedAt),
                            )
                        ).orderBy(behaviorRules.createdAt)
                        if (rows.length === 0) return 'No behavior rules configured.'
                        return rows.map(r => {
                            const val = typeof r.value === 'object' && r.value !== null ? JSON.stringify(r.value) : String(r.value)
                            return `• [${r.type}] ${val.slice(0, 200)}${r.locked ? ' (locked)' : ''} — source: ${r.source}, id: ${r.id}`
                        }).join('\n')
                    }

                    if (action === 'add') {
                        if (!ruleText) return 'ruleText is required for adding a rule.'
                        // Block safety_constraint — platform-only
                        if (ruleType === 'safety_constraint') return 'Rejected: agents cannot create safety_constraint rules. Those are platform-only and locked.'
                        // Block capability-sabotaging rules
                        const blocked = checkCapabilitySabotage(ruleText)
                        if (blocked) return `Rejected: rule would disable core capabilities — ${blocked}. Core capabilities (image, voice, model routing, channels) are protected and cannot be disabled via behavior rules.`

                        const key = `agent_${Date.now().toString(36)}`
                        const validType = ruleType ?? 'operational_procedure'
                        await db.insert(behaviorRules).values({
                            workspaceId,
                            projectId: null,
                            type: validType as any,
                            key,
                            label: ruleText.slice(0, 200),
                            description: '',
                            value: { type: 'text_block', value: ruleText } as any,
                            source: 'workspace',
                            tags: [],
                        })
                        return `Behavior rule added: "${ruleText.slice(0, 100)}"`
                    }

                    if (action === 'remove') {
                        if (!ruleId) return 'ruleId is required for removing a rule.'
                        if (!confirmed) return 'Please confirm with the user before removing a behavior rule.'

                        const [existing] = await db.select({ id: behaviorRules.id, locked: behaviorRules.locked })
                            .from(behaviorRules)
                            .where(and(eq(behaviorRules.id, ruleId), eq(behaviorRules.workspaceId, workspaceId)))
                            .limit(1)
                        if (!existing) return 'Rule not found.'
                        if (existing.locked) return 'Failed to remove rule: locked rules cannot be deleted.'

                        await db.update(behaviorRules)
                            .set({ deletedAt: new Date(), updatedAt: new Date() } as any)
                            .where(eq(behaviorRules.id, ruleId))
                        return 'Behavior rule removed.'
                    }

                    return 'Invalid action. Use "list", "add", or "remove".'
                } catch (err) { return `Behavior management failed: ${err instanceof Error ? err.message : String(err)}` }
            },
        }),
    }
}
