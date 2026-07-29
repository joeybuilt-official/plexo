// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Self-configuration: detect credentials in any channel message and auto-install
 * the corresponding connection.
 *
 * When a user pastes a URL + API token in any channel (Telegram, Slack, Discord,
 * internal chat), the system installs the connection immediately without going
 * through task classification, confirmation prompts, or task queuing.
 */

import { eq, and } from 'drizzle-orm'
import { db } from '@plexo/db'
import { connectionsRegistry, installedConnections } from '@plexo/db'
import { encrypt } from './crypto.js'
import { logger } from './logger.js'
import { trackEvent } from './event-tracker.js'

/**
 * Maps known URL hostname substrings → registry metadata.
 */
export const SERVICE_MAP: Array<{ match: RegExp; id: string; name: string; category: string }> = [
{ match: /github/i,        id: 'github',         name: 'GitHub',        category: 'development' },
    { match: /linear/i,        id: 'linear',         name: 'Linear',        category: 'project-management' },
    { match: /notion/i,        id: 'notion',         name: 'Notion',        category: 'productivity' },
    { match: /stripe/i,        id: 'stripe',         name: 'Stripe',        category: 'payments' },
    { match: /slack/i,         id: 'slack',          name: 'Slack',         category: 'communication' },
    { match: /gitlab/i,        id: 'gitlab',         name: 'GitLab',        category: 'development' },
    { match: /jira/i,          id: 'jira',           name: 'Jira',          category: 'project-management' },
    { match: /vercel/i,        id: 'vercel',         name: 'Vercel',        category: 'devops' },
    { match: /planetscale/i,   id: 'planetscale',    name: 'PlanetScale',   category: 'database' },
    { match: /render/i,        id: 'render',         name: 'Render',        category: 'devops' },
    { match: /fly\.io/i,       id: 'flyio',          name: 'Fly.io',        category: 'devops' },
    { match: /railway/i,       id: 'railway',        name: 'Railway',       category: 'devops' },
    { match: /hetzner/i,       id: 'hetzner',        name: 'Hetzner',       category: 'infrastructure' },
    { match: /digitalocean/i,  id: 'digitalocean',   name: 'DigitalOcean',  category: 'infrastructure' },
    { match: /cloudflare/i,    id: 'cloudflare',     name: 'Cloudflare',    category: 'infrastructure' },
    { match: /datadog/i,       id: 'datadog',        name: 'Datadog',       category: 'monitoring' },
    { match: /sentry/i,        id: 'sentry',         name: 'Sentry',        category: 'monitoring' },
    { match: /posthog/i,       id: 'posthog',        name: 'PostHog',       category: 'analytics' },
    { match: /mixpanel/i,      id: 'mixpanel',       name: 'Mixpanel',      category: 'analytics' },
    { match: /airtable/i,      id: 'airtable',       name: 'Airtable',      category: 'database' },
    { match: /hubspot/i,       id: 'hubspot',        name: 'HubSpot',       category: 'crm' },
    { match: /salesforce/i,    id: 'salesforce',     name: 'Salesforce',    category: 'crm' },
    { match: /twilio/i,        id: 'twilio',         name: 'Twilio',        category: 'communication' },
    { match: /sendgrid/i,      id: 'sendgrid',       name: 'SendGrid',      category: 'communication' },
    { match: /resend/i,        id: 'resend',         name: 'Resend',        category: 'communication' },
    { match: /openai/i,        id: 'openai',         name: 'OpenAI',        category: 'ai' },
    { match: /anthropic/i,     id: 'anthropic',      name: 'Anthropic',     category: 'ai' },
    { match: /aws\.|amazonaws/i, id: 'aws',          name: 'AWS',           category: 'infrastructure' },
    { match: /gcp\.|googleapis/i, id: 'gcp',         name: 'Google Cloud',  category: 'infrastructure' },
    { match: /azure/i,         id: 'azure',          name: 'Azure',         category: 'infrastructure' },
]

export interface CredentialMatch {
    url: string
    token: string
    registryId: string
    serviceName: string
    category: string
    /** True when the service was recognized from SERVICE_MAP; false = unknown service */
    knownService: boolean
}

/**
 * Maps service names as they appear in plain text → registry metadata and
 * canonical API base URL. Used by the named-service detection path that
 * handles messages like "Here's my Deepgram key: xxx" where no URL is present.
 *
 * Order matters — more specific entries should come first.
 */
const SERVICE_NAME_MAP: Array<{ match: RegExp; id: string; name: string; category: string; apiUrl: string }> = [
    { match: /deepgram/i,     id: 'deepgram',    name: 'Deepgram',    category: 'ai',              apiUrl: 'https://api.deepgram.com' },
    { match: /openai/i,       id: 'openai',      name: 'OpenAI',      category: 'ai',              apiUrl: 'https://api.openai.com' },
    { match: /anthropic/i,    id: 'anthropic',   name: 'Anthropic',   category: 'ai',              apiUrl: 'https://api.anthropic.com' },
    { match: /groq/i,         id: 'groq',        name: 'Groq',        category: 'ai',              apiUrl: 'https://api.groq.com' },
    { match: /mistral/i,      id: 'mistral',     name: 'Mistral',     category: 'ai',              apiUrl: 'https://api.mistral.ai' },
    { match: /cohere/i,       id: 'cohere',      name: 'Cohere',      category: 'ai',              apiUrl: 'https://api.cohere.ai' },
    { match: /perplexity/i,   id: 'perplexity',  name: 'Perplexity',  category: 'ai',              apiUrl: 'https://api.perplexity.ai' },
    { match: /brave\s+search|brave\s+api/i, id: 'brave', name: 'Brave Search', category: 'search', apiUrl: 'https://api.search.brave.com' },
    { match: /tavily/i,       id: 'tavily',      name: 'Tavily',      category: 'search',          apiUrl: 'https://api.tavily.com' },
    { match: /github/i,       id: 'github',      name: 'GitHub',      category: 'development',     apiUrl: 'https://api.github.com' },
    { match: /gitlab/i,       id: 'gitlab',      name: 'GitLab',      category: 'development',     apiUrl: 'https://gitlab.com' },
    { match: /linear/i,       id: 'linear',      name: 'Linear',      category: 'project-management', apiUrl: 'https://api.linear.app' },
    { match: /notion/i,       id: 'notion',      name: 'Notion',      category: 'productivity',    apiUrl: 'https://api.notion.com' },
    { match: /stripe/i,       id: 'stripe',      name: 'Stripe',      category: 'payments',        apiUrl: 'https://api.stripe.com' },
    { match: /sendgrid/i,     id: 'sendgrid',    name: 'SendGrid',    category: 'communication',   apiUrl: 'https://api.sendgrid.com' },
    { match: /resend/i,       id: 'resend',      name: 'Resend',      category: 'communication',   apiUrl: 'https://api.resend.com' },
    { match: /twilio/i,       id: 'twilio',      name: 'Twilio',      category: 'communication',   apiUrl: 'https://api.twilio.com' },
    { match: /slack/i,        id: 'slack',       name: 'Slack',       category: 'communication',   apiUrl: 'https://slack.com/api' },
    { match: /datadog/i,      id: 'datadog',     name: 'Datadog',     category: 'monitoring',      apiUrl: 'https://api.datadoghq.com' },
    { match: /sentry/i,       id: 'sentry',      name: 'Sentry',      category: 'monitoring',      apiUrl: 'https://sentry.io' },
    { match: /posthog/i,      id: 'posthog',     name: 'PostHog',     category: 'analytics',       apiUrl: 'https://app.posthog.com' },
    { match: /airtable/i,     id: 'airtable',    name: 'Airtable',    category: 'database',        apiUrl: 'https://api.airtable.com' },
    { match: /hubspot/i,      id: 'hubspot',     name: 'HubSpot',     category: 'crm',             apiUrl: 'https://api.hubapi.com' },
    { match: /vercel/i,       id: 'vercel',      name: 'Vercel',      category: 'devops',          apiUrl: 'https://api.vercel.com' },
]

/** Token pattern: pipe-prefixed, or a long alphanumeric string (32+ chars, no spaces). */
const TOKEN_RE = /\b(\d+\|[A-Za-z0-9+/=_\-]{10,}|[A-Za-z0-9_\-\.]{32,})\b/

/**
 * Detect if a message is providing credentials for a service connection.
 *
 * Two detection paths:
 *
 * Path 1 — URL + token (original): matches messages with a hostname and a
 * long token on separate lines or clearly separated sections.
 *
 * Path 2 — Named service + token (new): matches messages that name a known
 * service (e.g. "Deepgram", "OpenAI") and contain a long API key anywhere in
 * the message. No URL required. Handles:
 *   "Here's my Deepgram API key: dg_xxx..."
 *   "Install this OpenAI key: sk-xxx..."
 *   "deepgram\nsk-xxx..."
 */
export function detectCredentialMessage(text: string): CredentialMatch | null {
    const trimmed = text.trim()

    // ── Path 2: Named service + token (checked first — no URL required) ───────
    // Only fires when an explicit credential-install intent is present alongside
    // a recognized service name. Require at least one of: the word "key",
    // "token", "api", "install", or "setup" so plain mentions of a service name
    // don't trigger false positives (e.g. "I love OpenAI").
    const hasCredentialIntent = /\b(api[- ]?key|token|secret|install|setup|configure|here(?:'s|'s| is)|my key|add key|update.*key|change.*key|new.*key|replace.*key)\b/i.test(trimmed)
    if (hasCredentialIntent) {
        const tokenMatch2 = trimmed.match(TOKEN_RE)
        if (tokenMatch2) {
            const token = tokenMatch2[1]!
            const svcByName = SERVICE_NAME_MAP.find(s => s.match.test(trimmed))
            if (svcByName) {
                return {
                    url: svcByName.apiUrl,
                    token,
                    registryId: svcByName.id,
                    serviceName: svcByName.name,
                    category: svcByName.category,
                    knownService: true,
                }
            }
        }
    }

    // ── Path 1: URL + token (original logic) ──────────────────────────────────
    // Extract URL (with or without scheme)
    const urlMatch = trimmed.match(/(?:https?:\/\/)?([\w][\w\-]*(?:\.[\w\-]+)+)/)
    if (!urlMatch) return null
    const hostname = urlMatch[1]!

    // Extract token: pipe-prefixed (e.g. "32|abc..."), bearer token, or long alphanumeric key (20+ chars)
    const tokenMatch = trimmed.match(TOKEN_RE)
    if (!tokenMatch) return null
    const token = tokenMatch[1]!

    // Require the URL and token to be on separate lines or clearly distinct sections —
    // prevents false positives on single-line messages that happen to have both patterns.
    const lines = trimmed.split(/\s*\n\s*/)
    const hasMultiPart = lines.length >= 2 || /\s{3,}/.test(trimmed)
    if (!hasMultiPart) return null

    const url = `https://${hostname}`

    // Identify service from hostname
    const svc = SERVICE_MAP.find(s => s.match.test(hostname))
    if (svc) {
        return { url, token, registryId: svc.id, serviceName: svc.name, category: svc.category, knownService: true }
    }

    // Unknown service — derive ID from hostname root segment
    const id = hostname.split('.')[0]!.toLowerCase().replace(/[^a-z0-9]/g, '-')
    return { url, token, registryId: id, serviceName: hostname, category: 'api', knownService: false }
}

/**
 * Auto-install a connection from detected credentials.
 *
 * Known services (in SERVICE_MAP): credentials saved immediately, connection active.
 *
 * Unknown services: credentials saved first so they're available, then a task is
 * queued to use synthesize_extension — which researches the API docs, generates a
 * PEX extension with proper tool definitions, and activates it. The user gets
 * a reply immediately while synthesis runs in the background.
 *
 * Returns a human-readable confirmation to send back to the user.
 */
export async function autoInstallConnection(workspaceId: string, cred: CredentialMatch): Promise<string> {
    const { url, token, registryId, serviceName, category, knownService } = cred

    // Check if already installed for this workspace
    const [existing] = await db
        .select({ id: installedConnections.id })
        .from(installedConnections)
        .where(and(
            eq(installedConnections.workspaceId, workspaceId),
            eq(installedConnections.registryId, registryId),
        ))
        .limit(1)

    const encryptedCreds = { encrypted: encrypt(JSON.stringify({ api_key: token, url }), workspaceId) }

    if (existing) {
        await db.update(installedConnections)
            .set({ credentials: encryptedCreds, status: 'active' })
            .where(eq(installedConnections.id, existing.id))
        logger.info({ workspaceId, registryId, serviceName }, 'Auto-updated integration credentials from channel')
        return `Updated ${serviceName} credentials.`
    }

    // Ensure registry entry exists (upsert — safe to call multiple times)
    await db.insert(connectionsRegistry).values({
        id: registryId,
        name: serviceName,
        description: `${serviceName} API integration`,
        category,
        authType: 'api_key',
        setupFields: JSON.stringify([
            { key: 'api_key', label: 'API Key', type: 'password', required: true },
            { key: 'url',     label: 'Instance URL', type: 'text', required: true },
        ]),
        toolsProvided: JSON.stringify([]),
        cardsProvided: JSON.stringify([]),
        isCore: false,
        isGenerated: true,
    }).onConflictDoNothing()

    await db.insert(installedConnections).values({
        workspaceId,
        registryId,
        name: serviceName,
        credentials: encryptedCreds,
        status: 'active',
    })

    logger.info({ workspaceId, registryId, serviceName, knownService }, 'Auto-installed integration from channel credentials')
    trackEvent('connection.installed', 'info', { workspaceId, registryId, name: serviceName })

    if (!knownService) {
        // Unknown service: queue a synthesis task to research the API and generate
        // proper tool definitions via synthesize_extension.
        try {
            const { pushTask } = await import('@plexo/queue')
            void pushTask({
                workspaceId,
                type: 'automation',
                source: 'api',
                context: {
                    description: `Use synthesize_extension to build a full PEX tool for "${serviceName}" (${url}). The workspace already has API credentials stored for registryId "${registryId}". Research the API documentation at ${url}, generate tool definitions, and activate the tool so the user can work with ${serviceName} via natural language.`,
                    priority: 'normal',
                },
            }).catch((err: unknown) => logger.warn({ err, registryId }, 'Failed to queue synthesis task for unknown service'))
        } catch { /* pushTask import failure — non-fatal, credentials are already saved */ }

        return `Connected to ${serviceName}. Credentials saved. I don't have built-in tools for ${serviceName} yet, so I'm researching its API now and will build the integration automatically — this takes a minute or two.`
    }

    return `Connected to ${serviceName}. Credentials saved and encrypted — I can now use your ${serviceName} instance for tasks.`
}
