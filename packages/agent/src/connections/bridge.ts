/**
 * Connection → Tool Bridge
 *
 * Loads active installed_connections for a workspace, decrypts credentials,
 * and returns Vercel AI SDK tool definitions for every enabled tool.
 *
 * Each registered provider implements a ToolFactory that receives decrypted
 * credentials and returns named tool definitions. Tool names are namespaced:
 *   {registryId}__{toolName}  e.g.  github__create_branch
 *
 * The executor merges these into its static tool set before each task.
 */
import { tool } from 'ai'
import { z } from 'zod'
import { db, eq, and } from '@plexo/db'
import { installedConnections } from '@plexo/db'
import { decrypt } from './crypto-util.js'

export interface ConnectionCredentials {
    access_token?: string
    refresh_token?: string
    bot_token?: string
    secret_key?: string
    token?: string
    api_token?: string
    [key: string]: unknown
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolSet = Record<string, any>

type ToolFactory = (creds: ConnectionCredentials, opts: { connectionId: string; workspaceId: string }) => ToolSet

// ── Provider tool factories ───────────────────────────────────────────────────

const GITHUB_TOOLS: ToolFactory = (creds) => {
    const token = creds.access_token ?? creds.token ?? ''
    const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }

    return {
        github__list_issues: tool({
            description: 'List open issues for a GitHub repository.',
            inputSchema: z.object({
                owner: z.string().describe('Repository owner'),
                repo: z.string().describe('Repository name'),
                state: z.enum(['open', 'closed', 'all']).optional().default('open'),
            }),
            execute: async ({ owner, repo, state }) => {
                const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues?state=${state}&per_page=20`, { headers })
                if (!res.ok) return `GitHub error: ${res.status} ${res.statusText}`
                const issues = await res.json() as Array<{ number: number; title: string; state: string; html_url: string }>
                return issues.map((i) => `#${i.number} [${i.state}] ${i.title} — ${i.html_url}`).join('\n') || 'No issues found.'
            },
        }),
        github__create_issue: tool({
            description: 'Create a new GitHub issue.',
            inputSchema: z.object({
                owner: z.string(),
                repo: z.string(),
                title: z.string().describe('Issue title'),
                body: z.string().optional().describe('Issue body (markdown)'),
                labels: z.array(z.string()).optional(),
            }),
            execute: async ({ owner, repo, title, body, labels }) => {
                const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
                    method: 'POST',
                    headers: { ...headers, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title, body, labels }),
                })
                const issue = await res.json() as { number: number; html_url: string }
                return `Created #${issue.number}: ${issue.html_url}`
            },
        }),
        github__list_prs: tool({
            description: 'List pull requests for a GitHub repository.',
            inputSchema: z.object({
                owner: z.string(),
                repo: z.string(),
                state: z.enum(['open', 'closed', 'all']).optional().default('open'),
            }),
            execute: async ({ owner, repo, state }) => {
                const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls?state=${state}&per_page=10`, { headers })
                if (!res.ok) return `GitHub error: ${res.status}`
                const prs = await res.json() as Array<{ number: number; title: string; html_url: string; draft: boolean }>
                return prs.map((p) => `#${p.number}${p.draft ? ' [draft]' : ''} ${p.title} — ${p.html_url}`).join('\n') || 'No PRs found.'
            },
        }),
        github__get_ci_status: tool({
            description: 'Get latest CI/check status for a branch.',
            inputSchema: z.object({
                owner: z.string(),
                repo: z.string(),
                branch: z.string().default('main'),
            }),
            execute: async ({ owner, repo, branch }) => {
                const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${branch}/check-runs`, { headers })
                if (!res.ok) return `GitHub error: ${res.status}`
                const d = await res.json() as { check_runs: Array<{ name: string; conclusion: string | null; status: string }> }
                return d.check_runs.map((c) => `${c.name}: ${c.conclusion ?? c.status}`).join('\n') || 'No checks found.'
            },
        }),
    }
}

const SLACK_TOOLS: ToolFactory = (creds) => {
    const token = creds.bot_token ?? creds.access_token ?? ''
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

    return {
        slack__send_message: tool({
            description: 'Send a message to a Slack channel or user.',
            inputSchema: z.object({
                channel: z.string().describe('Channel ID or name (e.g. #general)'),
                text: z.string().describe('Message text (markdown supported)'),
            }),
            execute: async ({ channel, text }) => {
                const res = await fetch('https://slack.com/api/chat.postMessage', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ channel, text }),
                })
                const d = await res.json() as { ok: boolean; error?: string }
                return d.ok ? 'Message sent.' : `Slack error: ${d.error}`
            },
        }),
        slack__list_channels: tool({
            description: 'List public channels in the Slack workspace.',
            inputSchema: z.object({ limit: z.number().optional().default(20) }),
            execute: async ({ limit }) => {
                const res = await fetch(`https://slack.com/api/conversations.list?limit=${limit}`, { headers })
                const d = await res.json() as { ok: boolean; channels?: Array<{ id: string; name: string; num_members: number }> }
                if (!d.ok) return `Slack error`
                return d.channels?.map((c) => `#${c.name} (${c.num_members} members)`).join('\n') ?? 'No channels.'
            },
        }),
    }
}

const VERCEL_TOOLS: ToolFactory = (creds) => {
    const token = creds.token ?? creds.access_token ?? ''
    const headers = { Authorization: `Bearer ${token}` }

    return {
        vercel__list_deployments: tool({
            description: 'List recent Vercel deployments.',
            inputSchema: z.object({ limit: z.number().optional().default(10) }),
            execute: async ({ limit }) => {
                const res = await fetch(`https://api.vercel.com/v6/deployments?limit=${limit}`, { headers })
                if (!res.ok) return `Vercel error: ${res.status}`
                const d = await res.json() as { deployments: Array<{ url: string; state: string; name: string; createdAt: number }> }
                return d.deployments.map((dep) => `${dep.name} [${dep.state}] ${dep.url}`).join('\n')
            },
        }),
        vercel__get_deployment_status: tool({
            description: 'Get status of a specific Vercel deployment.',
            inputSchema: z.object({ deploymentId: z.string().describe('Deployment ID or URL') }),
            execute: async ({ deploymentId }) => {
                const res = await fetch(`https://api.vercel.com/v13/deployments/${deploymentId}`, { headers })
                if (!res.ok) return `Vercel error: ${res.status}`
                const d = await res.json() as { url: string; readyState: string; meta?: { githubCommitMessage?: string } }
                return `${d.url} — ${d.readyState}${d.meta?.githubCommitMessage ? ` (${d.meta.githubCommitMessage})` : ''}`
            },
        }),
    }
}

const STRIPE_TOOLS: ToolFactory = (creds) => {
    const token = creds.secret_key ?? creds.access_token ?? ''
    const headers = { Authorization: `Bearer ${token}` }

    return {
        stripe__list_recent_payments: tool({
            description: 'List recent Stripe payment intents.',
            inputSchema: z.object({ limit: z.number().optional().default(10) }),
            execute: async ({ limit }) => {
                const res = await fetch(`https://api.stripe.com/v1/payment_intents?limit=${limit}`, { headers })
                if (!res.ok) return `Stripe error: ${res.status}`
                const d = await res.json() as { data: Array<{ id: string; amount: number; currency: string; status: string }> }
                return d.data.map((p) => `${p.id} ${p.amount / 100} ${p.currency.toUpperCase()} [${p.status}]`).join('\n')
            },
        }),
        stripe__get_revenue_summary: tool({
            description: 'Get a summary of recent Stripe revenue.',
            inputSchema: z.object({}),
            execute: async () => {
                const now = Math.floor(Date.now() / 1000)
                const start = now - 86400 * 30 // 30 days
                const res = await fetch(`https://api.stripe.com/v1/charges?created[gte]=${start}&limit=100`, { headers })
                if (!res.ok) return `Stripe error: ${res.status}`
                const d = await res.json() as { data: Array<{ amount: number; currency: string; paid: boolean }> }
                const total = d.data.filter((c) => c.paid).reduce((sum, c) => sum + c.amount, 0) / 100
                return `Last 30 days: $${total.toFixed(2)} across ${d.data.length} charges`
            },
        }),
    }
}

const CLOUDFLARE_TOOLS: ToolFactory = (creds) => {
    const token = creds.api_token ?? creds.access_token ?? ''
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

    return {
        cloudflare__purge_cache: tool({
            description: 'Purge Cloudflare cache for a zone by URL patterns or everything. Set purgeAll=true to purge everything.',
            inputSchema: z.object({
                zoneId: z.string().describe('Zone ID from Cloudflare dashboard'),
                purgeAll: z.boolean().describe('Purge everything in the cache'),
                files: z.string().describe('Comma-separated URLs to purge (ignored if purgeAll is true)'),
            }),
            execute: async ({ zoneId, purgeAll, files }) => {
                const fileList = (files as string).split(',').map((f: string) => f.trim()).filter(Boolean)
                const body = purgeAll ? { purge_everything: true } : { files: fileList }
                const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body),
                })
                const d = await res.json() as { success: boolean; errors: Array<{ message: string }> }
                return d.success ? 'Cache purged.' : `Error: ${d.errors.map((e) => e.message).join(', ')}`
            },
        }),
        cloudflare__list_dns: tool({
            description: 'List DNS records for a Cloudflare zone.',
            inputSchema: z.object({ zone: z.string().describe('Zone ID from Cloudflare dashboard') }),
            execute: async ({ zone }) => {
                const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/dns_records?per_page=20`, { headers })
                const d = await res.json() as { result: Array<{ type: string; name: string; content: string }> }
                return d.result?.map((r) => `${r.type} ${r.name} → ${r.content}`).join('\n') ?? 'No records.'
            },
        }),
    }
}

// ── Tool factory registry ─────────────────────────────────────────────────────

const TOOL_FACTORIES: Record<string, ToolFactory | undefined> = {
    github: GITHUB_TOOLS,
    slack: SLACK_TOOLS,
    vercel: VERCEL_TOOLS,
    stripe: STRIPE_TOOLS,
    cloudflare: CLOUDFLARE_TOOLS,
}

// ── Bridge: load workspace connections → AI SDK tools ────────────────────────

export async function loadConnectionTools(workspaceId: string): Promise<ToolSet> {
    try {
        const rows = await db
            .select({
                id: installedConnections.id,
                registryId: installedConnections.registryId,
                credentials: installedConnections.credentials,
                enabledTools: installedConnections.enabledTools,
                status: installedConnections.status,
            })
            .from(installedConnections)
            .where(and(
                eq(installedConnections.workspaceId, workspaceId),
                eq(installedConnections.status, 'active'),
            ))

        const merged: ToolSet = {}

        for (const row of rows) {
            const factory = TOOL_FACTORIES[row.registryId]
            if (!factory) continue

            // Decrypt credentials
            let creds: ConnectionCredentials = {}
            try {
                const raw = row.credentials as { encrypted?: string } | null
                if (raw?.encrypted) {
                    const decrypted = decrypt(raw.encrypted, workspaceId)
                    creds = JSON.parse(decrypted) as ConnectionCredentials
                }
            } catch {
                // Invalid/missing credentials — skip this connection
                continue
            }

            const tools = factory(creds, { connectionId: row.id, workspaceId })

            // Apply enabled_tools filter (null = all enabled)
            const enabled = row.enabledTools as string[] | null
            for (const [name, def] of Object.entries(tools)) {
                const shortName = name.split('__')[1] ?? name  // e.g. "create_branch"
                if (enabled === null || enabled.includes(shortName) || enabled.includes(name)) {
                    merged[name] = def
                }
            }
        }

        return merged
    } catch {
        // Non-fatal — executor continues with built-in tools only
        return {}
    }
}
