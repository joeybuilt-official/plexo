// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Capability manifest — computed at request time for a workspace.
 *
 * Describes exactly what the agent can do right now:
 *  - Built-in executor tools (always present)
 *  - Active installed_connections and their capabilities
 *  - Configured AI providers and their known modalities
 *  - Active skill extensions (PEX workers)
 *
 * Injected into both the planner and executor system prompts so the agent
 * can self-limit to achievable work and surface capability gaps to the user.
 */
import { db, eq, and } from '@plexo/db'
import { installedConnections, workspaces, extensions } from '@plexo/db'
import { buildManifestCapabilityMap } from '../connections/registry.js'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ConnectionCapability {
    /** Registry ID, e.g. 'github', 'slack', 'google_drive' */
    name: string
    /** What this connection enables the agent to do */
    capabilities: string[]
}

export interface ModelCapability {
    provider: string
    model: string
    /** Modalities this model supports */
    supports: string[]
    /** Capabilities this model does NOT have (used for gap detection) */
    missing: string[]
}

export interface SSHHostInfo {
    nickname: string
    host: string
    username: string
    mode: string
}

export interface CapabilityManifest {
    /** Built-in executor tools — always available */
    tools: string[]
    /** Active installed connections */
    connections: ConnectionCapability[]
    /** Configured AI models and their known modalities */
    models: ModelCapability[]
    /** Active skill extension names */
    skills: string[]
    /** SSH connections with host details (safe metadata, no credentials) */
    sshHosts: SSHHostInfo[]
    /** Flat list of all capability strings for quick gap checks */
    allCapabilities: Set<string>
}

// ── Connection capability registry ────────────────────────────────────────────
//
// DERIVED — do not hand-maintain this map. The canonical list lives in
// `packages/agent/src/connections/registry.ts`. `buildManifestCapabilityMap()`
// walks the registry, suffixes stub capabilities with ` (stub)`, and returns
// the legacy shape that `buildCapabilityManifest` consumes.
//
// Adding a new provider: append one entry to CONNECTION_REGISTRY. This file
// picks it up automatically.
const CONNECTION_CAPABILITIES: Record<string, string[]> = buildManifestCapabilityMap()

// ── Model modality registry ────────────────────────────────────────────────────
// What each model family can and cannot do.

const MODEL_MODALITIES: Record<string, { supports: string[]; missing: string[] }> = {
    anthropic: {
        supports: ['text', 'code', 'vision', 'analysis', 'reasoning', 'writing'],
        missing: ['image_generation', 'video_generation', 'audio_generation', 'voice_synthesis'],
    },
    openai: {
        supports: ['text', 'code', 'vision', 'analysis', 'reasoning', 'writing'],
        missing: ['video_generation', 'audio_generation', 'voice_synthesis'],
    },
    gemini: {
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
    xai: {
        supports: ['text', 'code', 'analysis', 'reasoning', 'writing', 'vision'],
        missing: ['image_generation', 'video_generation', 'voice_synthesis'],
    },
}

// ── Built-in executor tools ────────────────────────────────────────────────────

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
]


// ── Builder ────────────────────────────────────────────────────────────────────

export async function buildCapabilityManifest(workspaceId: string): Promise<CapabilityManifest> {
    const connections: ConnectionCapability[] = []
    const models: ModelCapability[] = []
    const skills: string[] = []

    // 1. Active installed connections
    const sshHosts: Array<{ nickname: string; host: string; username: string; mode: string }> = []
    try {
        const rows = await db
            .select({
                registryId: installedConnections.registryId,
                name: installedConnections.name,
                credentials: installedConnections.credentials,
            })
            .from(installedConnections)
            .where(and(
                eq(installedConnections.workspaceId, workspaceId),
                eq(installedConnections.status, 'active'),
            ))

        for (const row of rows) {
            const caps = CONNECTION_CAPABILITIES[row.registryId] ?? []
            connections.push({ name: row.registryId, capabilities: caps })

            // Extract SSH host details for the manifest (no credential decryption needed —
            // host/username/mode are safe metadata, not secrets)
            if (row.registryId === 'ssh') {
                try {
                    const { decrypt } = await import('../connections/crypto-util.js')
                    const raw = row.credentials as { encrypted?: string } | null
                    if (raw?.encrypted) {
                        const parsed = JSON.parse(decrypt(raw.encrypted, workspaceId)) as Record<string, string>
                        sshHosts.push({
                            nickname: row.name ?? `${parsed.username ?? 'user'}@${parsed.host ?? 'unknown'}`,
                            host: parsed.host ?? 'unknown',
                            username: parsed.username ?? 'unknown',
                            mode: parsed.mode ?? 'Full Access',
                        })
                    }
                } catch { /* non-fatal — skip this SSH connection's details */ }
            }
        }
    } catch { /* non-fatal */ }

    // 2. Configured AI providers from workspace settings
    try {
        const [wsRow] = await db
            .select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .limit(1)

        // Try provider_instances table first (canonical source after Intelligence page)
        try {
            const { providerInstances } = await import('@plexo/db')
            const { asc } = await import('@plexo/db')
            const instances = await db.select({
                providerType: providerInstances.providerType,
                selectedModel: providerInstances.selectedModel,
                enabled: providerInstances.enabled,
            }).from(providerInstances)
                .where(eq(providerInstances.workspaceId, workspaceId))
                .orderBy(asc(providerInstances.preferenceOrder))

            for (const inst of instances) {
                if (!inst.enabled) continue
                const modality = MODEL_MODALITIES[inst.providerType] ?? MODEL_MODALITIES.anthropic!
                models.push({
                    provider: inst.providerType,
                    model: inst.selectedModel ?? inst.providerType,
                    supports: modality.supports,
                    missing: modality.missing,
                })
            }
        } catch { /* provider_instances not available — fall back to legacy */ }

        // Legacy fallback: settings.aiProviders (pre-migration workspaces)
        if (models.length === 0 && wsRow?.settings) {
            const s = wsRow.settings as Record<string, unknown>
            const ap = s.aiProviders as Record<string, unknown> | undefined
            if (ap?.providers) {
                const providers = ap.providers as Record<string, Record<string, unknown>>
                for (const [providerKey, cfg] of Object.entries(providers)) {
                    if (cfg.status === 'configured' || cfg.apiKey || cfg.oauthToken || cfg.baseUrl) {
                        const modality = MODEL_MODALITIES[providerKey] ?? MODEL_MODALITIES.anthropic!
                        models.push({
                            provider: providerKey,
                            model: (cfg.selectedModel as string) ?? (cfg.defaultModel as string) ?? providerKey,
                            supports: modality.supports,
                            missing: modality.missing,
                        })
                    }
                }
            }
        }
    } catch { /* non-fatal */ }

    // Fallback: if no models loaded from DB, assume anthropic from env
    if (models.length === 0) {
        const modality = MODEL_MODALITIES.anthropic!
        models.push({
            provider: 'anthropic',
            model: 'claude-3-5-sonnet',
            supports: modality.supports,
            missing: modality.missing,
        })
    }

    // 3. Active skill extensions
    try {
        const extRows = await db
            .select({
                name: extensions.name,
                manifest: extensions.manifest,
            })
            .from(extensions)
            .where(and(
                eq(extensions.workspaceId, workspaceId),
                eq(extensions.enabled, true),
            ))

        for (const row of extRows) {
            const m = (row.manifest ?? {}) as { description?: string }
            const label = m.description ? `${row.name} — ${m.description}` : row.name
            skills.push(label)
        }
    } catch { /* non-fatal */ }

    // 4. Build flat capability set
    const allCapabilities = new Set<string>([
        ...BUILTIN_TOOLS,
        ...connections.flatMap((c) => c.capabilities),
        ...models.flatMap((m) => m.supports),
        ...skills.map((s) => s.split(' — ')[0]!),
    ])

    return {
        tools: BUILTIN_TOOLS,
        connections,
        models,
        skills,
        sshHosts,
        allCapabilities,
    }
}

// ── Prompt serialiser ──────────────────────────────────────────────────────────

export function manifestToPromptBlock(manifest: CapabilityManifest): string {
    const lines: string[] = [
        'CAPABILITY MANIFEST (current workspace, at task intake time):',
        `  Built-in tools: ${manifest.tools.join(', ')}`,
    ]

    if (manifest.connections.length > 0) {
        lines.push('  Active integrations (you have authenticated tools for these services — use them FIRST before web_fetch or browser automation):')
        for (const c of manifest.connections) {
            lines.push(`    - ${c.name}: authenticated tools available as ${c.name}__* (e.g. ${c.name}__${c.capabilities[0] ?? 'call'})`)
        }
        lines.push('  RULE: When the user mentions a service listed above, call its namespaced tool (e.g. github__get_repo, github__list_issues) before attempting unauthenticated web_fetch. These tools use stored credentials automatically.')
    } else {
        lines.push('  Active integrations: none')
    }

    if (manifest.models.length > 0) {
        lines.push('  AI models:')
        for (const m of manifest.models) {
            lines.push(`    - ${m.provider}/${m.model}: supports ${m.supports.join(', ')}`)
            if (m.missing.length > 0) {
                lines.push(`      NOT capable of: ${m.missing.join(', ')}`)
            }
        }
    }

    if (manifest.skills.length > 0) {
        lines.push(`  Active skills: ${manifest.skills.join(', ')}`)
    } else {
        lines.push('  Active skills: none')
    }

    // Explicitly call out Web Automation/Browser as a meta-capability
    lines.push('  Web Automation: ENABLED (You can interact with ANY website using browser_* tools to perform signups, posts, or configuration, even if no direct integration is listed above.)')

    // SSH integrations
    if (manifest.sshHosts.length > 0) {
        lines.push('  SSH Integrations (you can run commands, transfer files, and manage these servers):')
        for (const h of manifest.sshHosts) {
            const modeLabel = h.mode === 'Read Only' || h.mode === 'readonly' ? 'read only' : 'full access'
            lines.push(`    - "${h.nickname}" (${h.username}@${h.host}) — ${modeLabel}`)
        }
        lines.push('  RULE: Use ssh__exec, ssh__upload, ssh__download, ssh__list_dir tools for server management. Each tool call specifies the host automatically via the connection.')
    } else {
        lines.push('  SSH Integrations: none configured. If a task requires remote server access, you can offer to help the user set one up using the setup_ssh_connection tool.')
    }

    // Highlight common gaps
    const gapChecks = ['image_generation', 'video_generation', 'audio_generation', 'voice_synthesis']
    const gaps = gapChecks.filter((g) => !manifest.allCapabilities.has(g))
    if (gaps.length > 0) {
        lines.push(`  NOT capable of (no specialized generator tool/connection installed): ${gaps.join(', ')}`)
    }

    return lines.join('\n')
}
