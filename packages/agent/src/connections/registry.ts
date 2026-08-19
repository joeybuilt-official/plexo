// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Connection Registry — the SINGLE SOURCE OF TRUTH for provider metadata.
 *
 * Historically Plexo had three hand-maintained tables that drifted out of sync:
 *   1. `TOOL_FACTORIES` in connections/bridge.ts         — actual runtime tools
 *   2. `CONNECTION_CAPABILITIES` in capabilities/manifest — system-prompt claims
 *   3. `CONNECTION_TOOLS` / `CONNECTION_CAPABILITIES`    — introspection snapshot
 *      in introspection/index.ts
 *
 * When they disagreed the agent would advertise tools it could not actually
 * call (or vice versa). This module collapses all three into one descriptor
 * per provider. `bridge.ts`, `manifest.ts`, and `introspection/index.ts` each
 * derive their own legacy-shaped maps from `CONNECTION_REGISTRY` at module
 * load time so existing callers keep working unchanged.
 *
 * Adding a new provider is now a single-file edit: create the factory, append
 * one descriptor here. Everything downstream picks it up automatically.
 */

import type { ConnectionCredentials, ToolSet, ToolFactory } from './bridge-types.js'

// ── Provider factory imports ─────────────────────────────────────────────────
// Factories that ship with real implementations live in their own file under
// ./factories/. Stub factories (honest "not yet implemented" tools) live in
// ./factories/stubs.ts. The stub builder below is used to synthesize factories
// directly from a capability list for the "not implemented" case.

import { tool } from 'ai'
import { z } from 'zod'

import { SSH_TOOLS } from './factories/ssh.js'
import { LEVIO_TOOLS } from './factories/levio.js'
import { GOOGLE_WORKSPACE_TOOLS } from './factories/google-workspace.js'
import { MCP_TOOLS } from './factories/mcp.js'
import {
    GITLAB_TOOLS,
    NETLIFY_TOOLS,
    SENDGRID_TOOLS,
    MAILCHIMP_TOOLS,
    PAGERDUTY_TOOLS,
    DATADOG_TOOLS,
    REPLICATE_TOOLS,
    FAL_AI_TOOLS,
    STABILITY_TOOLS,
    ELEVENLABS_TOOLS,
    OPENAI_MEDIA_TOOLS,
} from './factories/stubs.js'

// ── Public types ─────────────────────────────────────────────────────────────

export type ConnectionCategory =
    | 'code'
    | 'comms'
    | 'pm'
    | 'docs'
    | 'ops'
    | 'payments'
    | 'observability'
    | 'media'
    | 'ai'
    | 'infra'
    | 'mcp'

export interface CapabilitySpec {
    /** Short capability name matching the suffix after `{prefix}__`.
     *  e.g. 'create_page' maps to the actual tool name 'notion__create_page'. */
    name: string
    /** Human description for manifests and introspection snapshots. */
    description?: string
}

export interface ConnectionDescriptor {
    /** Registry ID — matches installed_connections.registryId, e.g. 'notion'. */
    id: string
    /** Pretty name for UI and prompts, e.g. 'Notion'. */
    displayName: string
    /** Used for grouping in UI and docs. */
    category: ConnectionCategory
    /** Tool-name prefix. Usually equals id but google-drive uses 'gdrive'. */
    toolPrefix: string
    /** Declared capabilities. MUST match tool suffixes produced by the factory. */
    capabilities: CapabilitySpec[]
    /** Runtime tool factory. For stubs, this returns "not implemented" tools. */
    factory: ToolFactory
    /** True when this factory only returns honest "not yet implemented" tools. */
    stub?: boolean
}

// ── Stub builder (shared with legacy stubs.ts) ───────────────────────────────

function inlineStub(prefix: string, caps: CapabilitySpec[]): ToolFactory {
    return () => {
        const out: ToolSet = {}
        for (const cap of caps) {
            out[`${prefix}__${cap.name}`] = tool({
                description: `[NOT YET IMPLEMENTED] ${cap.description ?? cap.name} — the connection is installed but the runtime factory is pending.`,
                inputSchema: z.object({}).passthrough(),
                execute: async () => {
                    return `${prefix}__${cap.name} is not yet implemented. The ${prefix} connection is installed and credentials are stored, but the runtime tool factory has not been built. Tell the user explicitly that this tool is a known gap.`
                },
            })
        }
        return out
    }
}
void inlineStub // Reserved for future registry-only stubs; legacy stubs.ts remains authoritative.

// ── The registry ─────────────────────────────────────────────────────────────
// Lazy-import the implemented factories defined in bridge.ts to avoid a
// circular module load. bridge.ts calls `registerBridgeFactories()` at module
// load time before it exports `TOOL_FACTORIES`.

type BridgeFactoryKey =
    | 'github'
    | 'slack'
    | 'vercel'
    | 'stripe'
    | 'cloudflare'
    | 'sentry'
    | 'posthog'
    | 'ovhcloud'
    | 'deepgram'

const bridgeFactoryRefs: Partial<Record<BridgeFactoryKey, ToolFactory>> = {}

/** Called by bridge.ts at load time to inject factories defined in that file. */
export function registerBridgeFactories(
    refs: Record<BridgeFactoryKey, ToolFactory>,
): void {
    for (const [k, v] of Object.entries(refs) as Array<[BridgeFactoryKey, ToolFactory]>) {
        bridgeFactoryRefs[k] = v
    }
}

/** Thin indirection so each descriptor can reference a bridge-defined factory
 *  even though bridge.ts imports from this file. */
function bridgeRef(key: BridgeFactoryKey): ToolFactory {
    return (creds: ConnectionCredentials, opts: { connectionId: string; workspaceId: string }) => {
        const fn = bridgeFactoryRefs[key]
        if (!fn) {
            // Should never happen in production — bridge.ts registers at module load.
            return {}
        }
        return fn(creds, opts)
    }
}

export const CONNECTION_REGISTRY: Record<string, ConnectionDescriptor> = {
    // ── Code / DevOps ────────────────────────────────────────────────────────
    github: {
        id: 'github',
        displayName: 'GitHub',
        category: 'code',
        toolPrefix: 'github',
        capabilities: [
            { name: 'get_repo', description: 'Get repository metadata' },
            { name: 'list_repos', description: 'List repositories for a user or org' },
            { name: 'search_repos', description: 'Search GitHub repositories' },
            { name: 'list_issues', description: 'List open issues' },
            { name: 'create_issue', description: 'Create an issue' },
            { name: 'open_pr', description: 'Open a pull request' },
            { name: 'merge_pr', description: 'Merge a pull request' },
            { name: 'create_branch', description: 'Create a branch' },
            { name: 'get_ci_status', description: 'Read CI/workflow status' },
            { name: 'read_file', description: 'Read a file from a repository' },
            { name: 'push_file', description: 'Commit a file to a repository' },
        ],
        factory: bridgeRef('github'),
    },

    // ── Comms ────────────────────────────────────────────────────────────────
    slack: {
        id: 'slack',
        displayName: 'Slack',
        category: 'comms',
        toolPrefix: 'slack',
        capabilities: [
            { name: 'send_message', description: 'Send a message to a channel' },
            { name: 'list_channels', description: 'List Slack channels' },
        ],
        factory: bridgeRef('slack'),
    },
    // ── MCP (user-configured external tool servers) ──────────────────────────
    // Capabilities are discovered dynamically at runtime from each configured
    // MCP server, so the static capability list is empty — the factory returns
    // one agent tool per discovered MCP tool, namespaced mcp__<server>__<tool>.
    mcp_custom: {
        id: 'mcp_custom',
        displayName: 'MCP Server',
        category: 'mcp',
        toolPrefix: 'mcp',
        capabilities: [],
        factory: MCP_TOOLS,
    },

    // ── Infra / Ops ──────────────────────────────────────────────────────────
    vercel: {
        id: 'vercel',
        displayName: 'Vercel',
        category: 'infra',
        toolPrefix: 'vercel',
        capabilities: [
            { name: 'list_deployments', description: 'List recent deployments' },
            { name: 'get_deployment_status', description: 'Get deployment status' },
        ],
        factory: bridgeRef('vercel'),
    },
    cloudflare: {
        id: 'cloudflare',
        displayName: 'Cloudflare',
        category: 'infra',
        toolPrefix: 'cloudflare',
        capabilities: [
            { name: 'purge_cache', description: 'Purge Cloudflare cache' },
            { name: 'list_dns', description: 'List DNS records' },
        ],
        factory: bridgeRef('cloudflare'),
    },
    ovhcloud: {
        id: 'ovhcloud',
        displayName: 'OVHcloud',
        category: 'infra',
        toolPrefix: 'ovhcloud',
        capabilities: [
            { name: 'list_servers', description: 'List OVH servers' },
            { name: 'get_server_status', description: 'Get OVH server status' },
        ],
        factory: bridgeRef('ovhcloud'),
    },
    ssh: {
        id: 'ssh',
        displayName: 'SSH',
        category: 'infra',
        toolPrefix: 'ssh',
        capabilities: [
            { name: 'exec', description: 'Execute a command on a remote host' },
            { name: 'list_dir', description: 'List a remote directory' },
            { name: 'download', description: 'Download a file from a remote host' },
            { name: 'upload', description: 'Upload a file to a remote host' },
        ],
        factory: SSH_TOOLS,
    },

    // ── Joeybuilt Apps ───────────────────────────────────────────────────────
    levio: {
        id: 'levio',
        displayName: 'Levio',
        category: 'pm',
        toolPrefix: 'levio',
        capabilities: [
            { name: 'list_emails', description: 'List emails from Levio (AI-categorized inbox)' },
            { name: 'send_email', description: 'Send an email via Levio' },
            { name: 'summarize_today_emails', description: "Summarize today's emails" },
            { name: 'list_events', description: 'List calendar events from Levio' },
            { name: 'list_calendar_sources', description: 'List available calendar sources' },
            { name: 'create_event', description: 'Create a calendar event in Levio' },
            { name: 'update_event', description: 'Update a calendar event in Levio' },
            { name: 'list_tasks', description: 'List tasks from Levio' },
            { name: 'create_task', description: 'Create a task in Levio' },
            { name: 'update_task', description: 'Update a task in Levio' },
        ],
        factory: LEVIO_TOOLS,
    },

    // ── Observability ────────────────────────────────────────────────────────
    sentry: {
        id: 'sentry',
        displayName: 'Sentry',
        category: 'observability',
        toolPrefix: 'sentry',
        capabilities: [
            { name: 'list_projects', description: 'List Sentry projects' },
            { name: 'list_issues', description: 'List Sentry issues' },
            { name: 'resolve_issue', description: 'Resolve a Sentry issue' },
        ],
        factory: bridgeRef('sentry'),
    },
    posthog: {
        id: 'posthog',
        displayName: 'PostHog',
        category: 'observability',
        toolPrefix: 'posthog',
        capabilities: [
            { name: 'list_feature_flags', description: 'List PostHog feature flags' },
            { name: 'toggle_feature_flag', description: 'Toggle a feature flag' },
        ],
        factory: bridgeRef('posthog'),
    },

    // ── Payments ─────────────────────────────────────────────────────────────
    stripe: {
        id: 'stripe',
        displayName: 'Stripe',
        category: 'payments',
        toolPrefix: 'stripe',
        capabilities: [
            { name: 'list_recent_payments', description: 'List recent Stripe payments' },
            { name: 'get_revenue_summary', description: 'Get Stripe revenue summary' },
        ],
        factory: bridgeRef('stripe'),
    },

    // ── Media / Audio ────────────────────────────────────────────────────────
    deepgram: {
        id: 'deepgram',
        displayName: 'Deepgram',
        category: 'media',
        toolPrefix: 'deepgram',
        capabilities: [
            { name: 'transcribe_audio', description: 'Transcribe audio from a URL' },
            { name: 'text_to_speech', description: 'Generate speech from text' },
            { name: 'analyze_audio', description: 'Analyze audio sentiment, topics, entities' },
            { name: 'detect_language', description: 'Detect spoken language in audio' },
        ],
        factory: bridgeRef('deepgram'),
    },

    // ── Docs / Knowledge ─────────────────────────────────────────────────────
    'google-workspace': {
        id: 'google-workspace',
        displayName: 'Google (Gmail + Calendar + Drive)',
        category: 'docs',
        toolPrefix: 'gws',
        capabilities: [
            { name: 'list_emails', description: 'List Gmail messages' },
            { name: 'read_email', description: 'Read a Gmail message' },
            { name: 'send_email', description: 'Send an email via Gmail' },
            { name: 'list_calendars', description: 'List available Google Calendars with IDs' },
            { name: 'list_events', description: 'List Google Calendar events' },
            { name: 'create_event', description: 'Create a calendar event' },
            { name: 'update_event', description: 'Update a calendar event' },
            { name: 'delete_event', description: 'Delete a calendar event' },
            { name: 'search_drive', description: 'Search Google Drive' },
            { name: 'get_file', description: 'Get a Google Drive file' },
            { name: 'create_file', description: 'Create a Google Drive file' },
        ],
        factory: GOOGLE_WORKSPACE_TOOLS,
    },

    // ── Stubs (honest "not yet implemented") ─────────────────────────────────
    gitlab: {
        id: 'gitlab',
        displayName: 'GitLab',
        category: 'code',
        toolPrefix: 'gitlab',
        capabilities: [
            { name: 'list_projects', description: 'List GitLab projects' },
            { name: 'create_issue', description: 'Create a GitLab issue' },
        ],
        factory: GITLAB_TOOLS,
        stub: true,
    },
    netlify: {
        id: 'netlify',
        displayName: 'Netlify',
        category: 'infra',
        toolPrefix: 'netlify',
        capabilities: [
            { name: 'list_sites', description: 'List Netlify sites' },
            { name: 'trigger_deploy', description: 'Trigger a Netlify deploy' },
        ],
        factory: NETLIFY_TOOLS,
        stub: true,
    },
    sendgrid: {
        id: 'sendgrid',
        displayName: 'SendGrid',
        category: 'comms',
        toolPrefix: 'sendgrid',
        capabilities: [
            { name: 'send_email', description: 'Send a transactional email' },
        ],
        factory: SENDGRID_TOOLS,
        stub: true,
    },
    mailchimp: {
        id: 'mailchimp',
        displayName: 'Mailchimp',
        category: 'comms',
        toolPrefix: 'mailchimp',
        capabilities: [
            { name: 'send_campaign', description: 'Send a Mailchimp campaign' },
            { name: 'list_subscribers', description: 'List Mailchimp subscribers' },
        ],
        factory: MAILCHIMP_TOOLS,
        stub: true,
    },
    pagerduty: {
        id: 'pagerduty',
        displayName: 'PagerDuty',
        category: 'observability',
        toolPrefix: 'pagerduty',
        capabilities: [
            { name: 'trigger_incident', description: 'Trigger a PagerDuty incident' },
            { name: 'resolve_incident', description: 'Resolve a PagerDuty incident' },
        ],
        factory: PAGERDUTY_TOOLS,
        stub: true,
    },
    datadog: {
        id: 'datadog',
        displayName: 'Datadog',
        category: 'observability',
        toolPrefix: 'datadog',
        capabilities: [
            { name: 'query_metrics', description: 'Query Datadog metrics' },
            { name: 'query_logs', description: 'Query Datadog logs' },
        ],
        factory: DATADOG_TOOLS,
        stub: true,
    },
    replicate: {
        id: 'replicate',
        displayName: 'Replicate',
        category: 'ai',
        toolPrefix: 'replicate',
        capabilities: [
            { name: 'run_model', description: 'Run a Replicate model' },
        ],
        factory: REPLICATE_TOOLS,
        stub: true,
    },
    'fal-ai': {
        id: 'fal-ai',
        displayName: 'fal.ai',
        category: 'ai',
        toolPrefix: 'fal-ai',
        capabilities: [
            { name: 'run_model', description: 'Run a fal.ai model' },
        ],
        factory: FAL_AI_TOOLS,
        stub: true,
    },
    stability: {
        id: 'stability',
        displayName: 'Stability AI',
        category: 'ai',
        toolPrefix: 'stability',
        capabilities: [
            { name: 'generate_image', description: 'Generate an image with Stability AI' },
        ],
        factory: STABILITY_TOOLS,
        stub: true,
    },
    elevenlabs: {
        id: 'elevenlabs',
        displayName: 'ElevenLabs',
        category: 'media',
        toolPrefix: 'elevenlabs',
        capabilities: [
            { name: 'text_to_speech', description: 'Synthesize speech with ElevenLabs' },
        ],
        factory: ELEVENLABS_TOOLS,
        stub: true,
    },
    openai: {
        id: 'openai',
        displayName: 'OpenAI (media)',
        category: 'media',
        toolPrefix: 'openai',
        capabilities: [
            { name: 'generate_image', description: 'Generate an image with DALL-E' },
            { name: 'transcribe_audio', description: 'Transcribe audio with Whisper' },
        ],
        factory: OPENAI_MEDIA_TOOLS,
        stub: true,
    },
}

// ── Derivation helpers (used by legacy consumers) ───────────────────────────

/** Map of registryId → ToolFactory (legacy shape for bridge.ts). */
export function buildToolFactoryMap(): Record<string, ToolFactory | undefined> {
    const out: Record<string, ToolFactory | undefined> = {}
    for (const [id, desc] of Object.entries(CONNECTION_REGISTRY)) {
        out[id] = desc.factory
    }
    return out
}

/** Map of registryId → capability short-names (legacy shape for manifest.ts).
 *  Stub capabilities get a ` (stub)` suffix so manifest prompt wording is
 *  backwards compatible. */
export function buildManifestCapabilityMap(): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const [id, desc] of Object.entries(CONNECTION_REGISTRY)) {
        out[id] = desc.capabilities.map((c) =>
            desc.stub ? `${c.name} (stub)` : c.name,
        )
    }
    return out
}

/** Map of registryId → fully-qualified tool names (legacy shape for
 *  introspection/index.ts CONNECTION_TOOLS). */
export function buildIntrospectionToolMap(): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const [id, desc] of Object.entries(CONNECTION_REGISTRY)) {
        out[id] = desc.capabilities.map((c) => `${desc.toolPrefix}__${c.name}`)
    }
    return out
}

/** Map of registryId → capability short-names (legacy shape for introspection
 *  CONNECTION_CAPABILITIES, which was a separate hand-rolled list). */
export function buildIntrospectionCapabilityMap(): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const [id, desc] of Object.entries(CONNECTION_REGISTRY)) {
        out[id] = desc.capabilities.map((c) => c.name)
    }
    return out
}

/** Count of registered providers (for debug / logs). */
export function connectionRegistryCount(): { total: number; real: number; stub: number } {
    let real = 0
    let stub = 0
    for (const desc of Object.values(CONNECTION_REGISTRY)) {
        if (desc.stub) stub++
        else real++
    }
    return { total: real + stub, real, stub }
}
