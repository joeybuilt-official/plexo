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
        github__open_pr: tool({
            description: 'Open a pull request on GitHub.',
            inputSchema: z.object({
                owner: z.string(),
                repo: z.string(),
                title: z.string().describe('PR title'),
                body: z.string().optional().describe('PR description (markdown)'),
                head: z.string().describe('Branch containing the changes'),
                base: z.string().default('main').describe('Branch to merge into'),
                draft: z.boolean().optional().default(false),
            }),
            execute: async ({ owner, repo, title, body, head, base, draft }) => {
                const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
                    method: 'POST',
                    headers: { ...headers, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title, body: body ?? '', head, base, draft }),
                })
                if (!res.ok) {
                    const err = await res.text()
                    return `GitHub error ${res.status}: ${err.slice(0, 200)}`
                }
                const pr = await res.json() as { number: number; html_url: string }
                return `PR #${pr.number} opened: ${pr.html_url}`
            },
        }),
        github__merge_pr: tool({
            description: 'Merge a pull request (squash merge).',
            inputSchema: z.object({
                owner: z.string(),
                repo: z.string(),
                pull_number: z.number().describe('PR number to merge'),
                commit_message: z.string().optional().describe('Squash commit message'),
            }),
            execute: async ({ owner, repo, pull_number, commit_message }) => {
                const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${pull_number}/merge`, {
                    method: 'PUT',
                    headers: { ...headers, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ merge_method: 'squash', commit_message: commit_message ?? '' }),
                })
                if (res.status === 204 || res.ok) return `PR #${pull_number} merged.`
                const err = await res.text()
                return `GitHub error ${res.status}: ${err.slice(0, 200)}`
            },
        }),
        github__create_branch: tool({
            description: 'Create a new branch in a GitHub repository from a base branch or SHA.',
            inputSchema: z.object({
                owner: z.string(),
                repo: z.string(),
                branch: z.string().describe('Name for the new branch'),
                from_branch: z.string().optional().default('main').describe('Branch or SHA to branch from'),
            }),
            execute: async ({ owner, repo, branch, from_branch }) => {
                const refRes = await fetch(
                    `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(from_branch)}`,
                    { headers },
                )
                if (!refRes.ok) return `GitHub error resolving base branch ${from_branch}: ${refRes.status}`
                const refData = await refRes.json() as { object: { sha: string } }
                const sha = refData.object.sha
                const createRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs`, {
                    method: 'POST',
                    headers: { ...headers, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
                })
                if (!createRes.ok) {
                    const err = await createRes.text()
                    return `GitHub error ${createRes.status}: ${err.slice(0, 200)}`
                }
                return `Branch '${branch}' created from '${from_branch}' (${sha.slice(0, 7)})`
            },
        }),
        github__get_ci_status: tool({
            description: 'Get latest CI/check status for a branch or commit SHA.',
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
        github__read_file: tool({
            description: 'Read a file from a GitHub repository at a given ref (branch or commit).',
            inputSchema: z.object({
                owner: z.string(),
                repo: z.string(),
                path: z.string().describe('File path in the repo, e.g. src/index.ts'),
                ref: z.string().optional().default('main').describe('Branch, tag, or commit SHA'),
            }),
            execute: async ({ owner, repo, path, ref }) => {
                const res = await fetch(
                    `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
                    { headers },
                )
                if (!res.ok) return `GitHub error ${res.status} reading ${path}`
                const data = await res.json() as { content?: string; encoding?: string; message?: string }
                if (data.message) return `GitHub: ${data.message}`
                if (data.content && data.encoding === 'base64') {
                    return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8')
                }
                return 'Unable to decode file content.'
            },
        }),
        github__push_file: tool({
            description: 'Create or update a file in a GitHub repository on a specific branch.',
            inputSchema: z.object({
                owner: z.string(),
                repo: z.string(),
                path: z.string().describe('File path in the repo'),
                content: z.string().describe('Full file content (UTF-8)'),
                message: z.string().describe('Commit message'),
                branch: z.string().describe('Branch to commit to'),
            }),
            execute: async ({ owner, repo, path, content, message, branch }) => {
                // Get current file SHA if it exists (needed for updates)
                let sha: string | undefined
                const existingRes = await fetch(
                    `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`,
                    { headers },
                )
                if (existingRes.ok) {
                    const existing = await existingRes.json() as { sha?: string }
                    sha = existing.sha
                }
                const body: Record<string, unknown> = {
                    message,
                    content: Buffer.from(content, 'utf8').toString('base64'),
                    branch,
                }
                if (sha) body.sha = sha
                const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
                    method: 'PUT',
                    headers: { ...headers, 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                })
                if (!res.ok) {
                    const err = await res.text()
                    return `GitHub error ${res.status}: ${err.slice(0, 200)}`
                }
                const d = await res.json() as { commit: { sha: string } }
                return `Committed ${path} -> ${d.commit.sha.slice(0, 7)} on ${branch}`
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

        // ── Self-extension tool ────────────────────────────────────────────────
        // Always available — lets the agent generate new skills/connections on demand.
        merged['synthesize_kapsel_skill'] = tool({
            description:
                'Research a third-party service API and generate, install, and activate a ' +
                'Kapsel skill + connection entry for it. Call this when the user needs to ' +
                'integrate with a service that has no installed skill or connector. ' +
                'The tool handles doc scraping, code generation, disk persistence, ' +
                'connection registration, and auto-activation in one call.',
            inputSchema: z.object({
                serviceName: z.string().describe(
                    'Human-readable service name, e.g. "Intercom" or "Airtable"',
                ),
                serviceWebsite: z.string().describe(
                    'Official website or docs URL, e.g. "https://developers.intercom.com"',
                ),
                requestedCapabilities: z.array(z.string()).describe(
                    'List of operations the user wants, e.g. ' +
                    '["list open conversations", "send a reply", "poll for new messages every hour"]',
                ),
            }),
            execute: async ({ serviceName, serviceWebsite, requestedCapabilities }) => {
                const { synthesizeSkill } = await import('../plugins/synthesizer.js')
                const result = await synthesizeSkill({
                    serviceName,
                    serviceWebsite,
                    requestedCapabilities,
                    workspaceId,
                })
                if (!result.ok) return `Synthesis failed: ${result.error}`
                return result.message
            },
        })

        return merged
    } catch {
        // Non-fatal — executor continues with built-in tools only
        return {}
    }
}
