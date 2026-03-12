// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Capability manifest — computed at request time for a workspace.
 *
 * Describes exactly what the agent can do right now:
 *  - Built-in executor tools (always present)
 *  - Active installed_connections and their capabilities
 *  - Configured AI providers and their known modalities
 *  - Active skill plugins (kapsel workers)
 *
 * Injected into both the planner and executor system prompts so the agent
 * can self-limit to achievable work and surface capability gaps to the user.
 */
import { db, eq, and } from '@plexo/db'
import { installedConnections, workspaces } from '@plexo/db'

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

export interface CapabilityManifest {
    /** Built-in executor tools — always available */
    tools: string[]
    /** Active installed connections */
    connections: ConnectionCapability[]
    /** Configured AI models and their known modalities */
    models: ModelCapability[]
    /** Active skill plugin names */
    skills: string[]
    /** Flat list of all capability strings for quick gap checks */
    allCapabilities: Set<string>
}

// ── Connection capability registry ────────────────────────────────────────────
// Maps registry IDs → what the agent can do with them.

const CONNECTION_CAPABILITIES: Record<string, string[]> = {
    // ── Code & DevOps ────────────────────────────────────────────────────────
    github: ['read_code', 'write_code', 'create_file', 'push_commits', 'create_branch', 'delete_branch', 'create_pr', 'merge_pr', 'review_pr', 'list_issues', 'create_issue', 'update_issue', 'search_code', 'list_prs', 'get_ci_status', 'manage_releases', 'fork_repo'],
    gitlab: ['read_code', 'write_code', 'create_file', 'push_commits', 'create_branch', 'delete_branch', 'create_mr', 'merge_mr', 'list_issues', 'create_issue', 'update_issue', 'search_code'],
    vercel: ['list_deployments', 'get_deployment_status', 'trigger_deploy'],
    netlify: ['list_deployments', 'get_deployment_status', 'trigger_deploy'],

    // ── Communication ────────────────────────────────────────────────────────
    slack: ['send_message', 'post_to_channel', 'list_channels', 'read_messages'],
    discord: ['send_message', 'read_messages', 'queue_task'],
    telegram: ['send_message', 'receive_task'],

    // ── Project Management ───────────────────────────────────────────────────
    linear: ['create_issue', 'update_issue', 'add_comment', 'list_issues', 'search_issues'],
    jira: ['create_issue', 'update_issue', 'add_comment', 'list_issues', 'search_issues'],

    // ── Knowledge & Docs ─────────────────────────────────────────────────────
    notion: ['create_page', 'update_page', 'search_pages', 'read_page', 'append_blocks'],
    'google-drive': ['file_upload', 'create_doc', 'read_doc', 'search_files'],
    airtable: ['read_records', 'create_record', 'update_record'],

    // ── Payments & Infra ─────────────────────────────────────────────────────
    stripe: ['read_payments', 'read_revenue', 'list_customers', 'list_subscriptions'],
    cloudflare: ['purge_cache', 'list_dns', 'update_dns'],

    // ── Messaging & Email ────────────────────────────────────────────────────
    sendgrid: ['send_email'],
    mailchimp: ['send_campaign', 'list_subscribers'],
    twilio: ['send_sms', 'make_call'],

    // ── Ops & Observability ──────────────────────────────────────────────────
    pagerduty: ['trigger_incident', 'resolve_incident', 'add_note'],
    datadog: ['query_metrics', 'query_logs', 'create_event'],

    // ── AI & Media ───────────────────────────────────────────────────────────
    replicate: ['image_generation', 'video_generation', 'audio_generation', 'image_upscaling'],
    'fal-ai': ['image_generation', 'video_generation', 'image_upscaling'],
    stability: ['image_generation', 'image_editing'],
    elevenlabs: ['voice_synthesis', 'audio_generation'],
    openai: ['image_generation', 'vision', 'transcription', 'embed_text'],
    deepgram: ['transcription', 'voice_synthesis'],
}

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
    'synthesize_kapsel_skill',
    'web_search',
    'web_fetch',
    'web_screenshot',
    'image_search',
    // Interactive browser automation (Playwright)
    'browser_navigate',
    'browser_click',
    'browser_type',
    'browser_select',
    'browser_extract',
    'browser_screenshot',
    'browser_eval',
    'browser_wait',
]


// ── Builder ────────────────────────────────────────────────────────────────────

export async function buildCapabilityManifest(workspaceId: string): Promise<CapabilityManifest> {
    const connections: ConnectionCapability[] = []
    const models: ModelCapability[] = []
    const skills: string[] = []

    // 1. Active installed connections
    try {
        const rows = await db
            .select({ registryId: installedConnections.registryId })
            .from(installedConnections)
            .where(and(
                eq(installedConnections.workspaceId, workspaceId),
                eq(installedConnections.status, 'active'),
            ))

        for (const row of rows) {
            const caps = CONNECTION_CAPABILITIES[row.registryId] ?? []
            connections.push({ name: row.registryId, capabilities: caps })
        }
    } catch { /* non-fatal */ }

    // 2. Configured AI providers from workspace settings
    try {
        const [wsRow] = await db
            .select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .limit(1)

        if (wsRow?.settings) {
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

    // 3. Build flat capability set
    const allCapabilities = new Set<string>([
        ...BUILTIN_TOOLS,
        ...connections.flatMap((c) => c.capabilities),
        ...models.flatMap((m) => m.supports),
    ])

    return {
        tools: BUILTIN_TOOLS,
        connections,
        models,
        skills,
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
        lines.push('  Active connections:')
        for (const c of manifest.connections) {
            lines.push(`    - ${c.name}: ${c.capabilities.join(', ')}`)
        }
    } else {
        lines.push('  Active connections: none')
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
    lines.push('  Web Automation: ENABLED (You can interact with ANY website using browser_* tools to perform signups, posts, or configuration, even if no direct connection is listed above.)')

    // Highlight common gaps
    const gapChecks = ['image_generation', 'video_generation', 'audio_generation', 'voice_synthesis']
    const gaps = gapChecks.filter((g) => !manifest.allCapabilities.has(g))
    if (gaps.length > 0) {
        lines.push(`  NOT capable of (no specialized generator tool/connection installed): ${gaps.join(', ')}`)
    }

    return lines.join('\n')
}
