// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

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
import pino from 'pino'
import { eq, and, inArray } from 'drizzle-orm'
import { db } from '@plexo/db'

const logger = pino({ name: 'connections:bridge' })
import { installedConnections, workspaces, extensions } from '@plexo/db'
import { decrypt, encrypt } from './crypto-util.js'
import type { ConnectionCredentials, ToolSet, ToolFactory } from './bridge-types.js'
import { isWriteTool } from './write-tool-filter.js'

// Re-export so callers can reach the classifier without a second import.
export { isWriteTool } from './write-tool-filter.js'

// Re-export for backwards compatibility — older imports pulled these from bridge.ts.
export type { ConnectionCredentials, ToolSet } from './bridge-types.js'

// ── Provider tool factories ───────────────────────────────────────────────────

const GITHUB_TOOLS: ToolFactory = (creds) => {
    // Credentials stored by credential-setup use 'api_key'; OAuth uses 'access_token' / 'token'
    const token = creds.access_token ?? creds.token ?? creds.api_key ?? ''
    const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
    // Derive base URL from stored url (for GitHub Enterprise) or default to api.github.com
    const storedUrl = (creds.url as string | undefined) ?? ''
    const apiBase = storedUrl && !storedUrl.includes('github.com')
        ? storedUrl.replace(/\/$/, '') + '/api/v3'
        : 'https://api.github.com'

    return {
        github__get_repo: tool({
            description: 'Get metadata about a GitHub repository (description, stars, topics, default branch, visibility). Use this first when asked about a repo.',
            inputSchema: z.object({
                owner: z.string().describe('Repository owner (user or org)'),
                repo: z.string().describe('Repository name'),
            }),
            execute: async ({ owner, repo }) => {
                const res = await fetch(`${apiBase}/repos/${owner}/${repo}`, { headers, signal: AbortSignal.timeout(10_000) })
                if (!res.ok) return `GitHub error ${res.status}: ${res.statusText}`
                const d = await res.json() as { full_name: string; description: string | null; stargazers_count: number; forks_count: number; default_branch: string; visibility: string; topics: string[] }
                return `${d.full_name} (${d.visibility})\nDefault branch: ${d.default_branch}\nStars: ${d.stargazers_count} | Forks: ${d.forks_count}\nDescription: ${d.description ?? 'none'}\nTopics: ${d.topics?.join(', ') || 'none'}`
            },
        }),
        github__list_repos: tool({
            description: 'List repositories for a GitHub user or organization.',
            inputSchema: z.object({
                owner: z.string().describe('User or org whose repos to list'),
                type: z.enum(['all', 'public', 'private', 'forks', 'sources']).optional().default('all'),
                limit: z.number().optional().default(20),
            }),
            execute: async ({ owner, type, limit }) => {
                const res = await fetch(`${apiBase}/users/${owner}/repos?type=${type}&per_page=${limit}&sort=updated`, { headers, signal: AbortSignal.timeout(10_000) })
                if (!res.ok) {
                    // Try org endpoint
                    const orgRes = await fetch(`${apiBase}/orgs/${owner}/repos?type=${type}&per_page=${limit}&sort=updated`, { headers, signal: AbortSignal.timeout(10_000) })
                    if (!orgRes.ok) return `GitHub error ${res.status}`
                    const repos = await orgRes.json() as Array<{ name: string; visibility: string; stargazers_count: number }>
                    return repos.map((r) => `${r.name} (${r.visibility}, ★${r.stargazers_count})`).join('\n')
                }
                const repos = await res.json() as Array<{ name: string; visibility: string; stargazers_count: number }>
                return repos.map((r) => `${r.name} (${r.visibility}, ★${r.stargazers_count})`).join('\n') || 'No repos found.'
            },
        }),
        github__search_repos: tool({
            description: 'Search GitHub repositories by keywords.',
            inputSchema: z.object({
                query: z.string().describe('Search query, e.g. "plexo org:joeybuilt"'),
                limit: z.number().optional().default(10),
            }),
            execute: async ({ query, limit }) => {
                const res = await fetch(`${apiBase}/search/repositories?q=${encodeURIComponent(query)}&per_page=${limit}`, { headers, signal: AbortSignal.timeout(10_000) })
                if (!res.ok) return `GitHub error ${res.status}`
                const d = await res.json() as { items: Array<{ full_name: string; description: string | null; stargazers_count: number; visibility: string }> }
                return d.items.map((r) => `${r.full_name} (${r.visibility}, ★${r.stargazers_count})\n  ${r.description ?? ''}`).join('\n\n') || 'No results.'
            },
        }),
        github__list_issues: tool({
            description: 'List open issues for a GitHub repository.',
            inputSchema: z.object({
                owner: z.string().describe('Repository owner'),
                repo: z.string().describe('Repository name'),
                state: z.enum(['open', 'closed', 'all']).optional().default('open'),
            }),
            execute: async ({ owner, repo, state }) => {
                const res = await fetch(`${apiBase}/repos/${owner}/${repo}/issues?state=${state}&per_page=20`, { headers, signal: AbortSignal.timeout(10_000) })
                if (!res.ok) return `GitHub error: ${res.status} ${res.statusText}`
                const issues = await res.json() as Array<{ number: number; title: string; state: string; html_url: string }>
                return issues.map((i) => `#${i.number} [${i.state}] ${i.title} — ${i.html_url}`).join('\n') || 'No issues found.'
            },
        }),
        github__create_issue: tool({
            description: 'Create a new GitHub issue.',
            inputSchema: z.object({
                owner: z.string().describe('Repository owner (user or org)'),
                repo: z.string().describe('Repository name'),
                title: z.string().describe('Issue title'),
                body: z.string().optional().describe('Issue body (markdown)'),
                labels: z.array(z.string()).optional().describe('Label names to apply'),
            }),
            execute: async ({ owner, repo, title, body, labels }) => {
                const res = await fetch(`${apiBase}/repos/${owner}/${repo}/issues`, {
                    method: 'POST',
                    headers: { ...headers, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title, body, labels }),
                    signal: AbortSignal.timeout(10_000),
                })
                if (!res.ok) {
                    const errText = await res.text().catch(() => '')
                    return `GitHub error ${res.status}: ${errText.slice(0, 200)}`
                }
                const issue = await res.json() as { number: number; html_url: string }
                return `Created #${issue.number}: ${issue.html_url}`
            },
        }),
        github__open_pr: tool({
            description: 'Open a pull request on GitHub.',
            inputSchema: z.object({
                owner: z.string().describe('Repository owner (user or org)'),
                repo: z.string().describe('Repository name'),
                title: z.string().describe('PR title'),
                body: z.string().optional().describe('PR description (markdown)'),
                head: z.string().describe('Branch containing the changes'),
                base: z.string().default('main').describe('Branch to merge into'),
                draft: z.boolean().optional().default(false).describe('Open as draft PR'),
            }),
            execute: async ({ owner, repo, title, body, head, base, draft }) => {
                const res = await fetch(`${apiBase}/repos/${owner}/${repo}/pulls`, {
                    method: 'POST',
                    headers: { ...headers, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title, body: body ?? '', head, base, draft }),
                    signal: AbortSignal.timeout(10_000),
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
                owner: z.string().describe('Repository owner (user or org)'),
                repo: z.string().describe('Repository name'),
                pull_number: z.number().describe('PR number to merge'),
                commit_message: z.string().optional().describe('Squash commit message'),
            }),
            execute: async ({ owner, repo, pull_number, commit_message }) => {
                const res = await fetch(`${apiBase}/repos/${owner}/${repo}/pulls/${pull_number}/merge`, {
                    method: 'PUT',
                    headers: { ...headers, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ merge_method: 'squash', commit_message: commit_message ?? '' }),
                    signal: AbortSignal.timeout(10_000),
                })
                if (res.status === 204 || res.ok) return `PR #${pull_number} merged.`
                const err = await res.text()
                return `GitHub error ${res.status}: ${err.slice(0, 200)}`
            },
        }),
        github__create_branch: tool({
            description: 'Create a new branch in a GitHub repository from a base branch or SHA.',
            inputSchema: z.object({
                owner: z.string().describe('Repository owner (user or org)'),
                repo: z.string().describe('Repository name'),
                branch: z.string().describe('Name for the new branch'),
                from_branch: z.string().optional().default('main').describe('Branch or SHA to branch from'),
            }),
            execute: async ({ owner, repo, branch, from_branch }) => {
                const refRes = await fetch(
                    `${apiBase}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(from_branch)}`,
                    { headers, signal: AbortSignal.timeout(10_000) },
                )
                if (!refRes.ok) return `GitHub error resolving base branch ${from_branch}: ${refRes.status}`
                const refData = await refRes.json() as { object: { sha: string } }
                const sha = refData.object.sha
                const createRes = await fetch(`${apiBase}/repos/${owner}/${repo}/git/refs`, {
                    method: 'POST',
                    headers: { ...headers, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
                    signal: AbortSignal.timeout(10_000),
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
                owner: z.string().describe('Repository owner (user or org)'),
                repo: z.string().describe('Repository name'),
                branch: z.string().default('main').describe('Branch name or commit SHA'),
            }),
            execute: async ({ owner, repo, branch }) => {
                const res = await fetch(`${apiBase}/repos/${owner}/${repo}/commits/${branch}/check-runs`, { headers, signal: AbortSignal.timeout(10_000) })
                if (!res.ok) return `GitHub error: ${res.status}`
                const d = await res.json() as { check_runs: Array<{ name: string; conclusion: string | null; status: string }> }
                return d.check_runs.map((c) => `${c.name}: ${c.conclusion ?? c.status}`).join('\n') || 'No checks found.'
            },
        }),
        github__read_file: tool({
            description: 'Read a file from a GitHub repository at a given ref (branch or commit).',
            inputSchema: z.object({
                owner: z.string().describe('Repository owner (user or org)'),
                repo: z.string().describe('Repository name'),
                path: z.string().describe('File path in the repo, e.g. src/index.ts'),
                ref: z.string().optional().default('main').describe('Branch, tag, or commit SHA'),
            }),
            execute: async ({ owner, repo, path, ref }) => {
                const res = await fetch(
                    `${apiBase}/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
                    { headers, signal: AbortSignal.timeout(10_000) },
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
                owner: z.string().describe('Repository owner (user or org)'),
                repo: z.string().describe('Repository name'),
                path: z.string().describe('File path in the repo'),
                content: z.string().describe('Full file content (UTF-8)'),
                message: z.string().describe('Commit message'),
                branch: z.string().describe('Branch to commit to'),
            }),
            execute: async ({ owner, repo, path, content, message, branch }) => {
                let sha: string | undefined
                const existingRes = await fetch(
                    `${apiBase}/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`,
                    { headers, signal: AbortSignal.timeout(10_000) },
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
                const res = await fetch(`${apiBase}/repos/${owner}/${repo}/contents/${path}`, {
                    method: 'PUT',
                    headers: { ...headers, 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(10_000),
                })
                if (!res.ok) {
                    const err = await res.text()
                    return `GitHub error ${res.status}: ${err.slice(0, 200)}`
                }
                const d = await res.json() as { commit: { sha: string } }
                return `Committed ${path} -> ${d.commit.sha.slice(0, 7)} on ${branch}`
            },
        }),
        github__get_pr_files: tool({
            description: 'List files changed in a pull request with their diffs (patches). Use before posting a PR review.',
            inputSchema: z.object({
                owner: z.string().describe('Repository owner (user or org)'),
                repo: z.string().describe('Repository name'),
                pull_number: z.number().describe('Pull request number'),
            }),
            execute: async ({ owner, repo, pull_number }) => {
                const res = await fetch(
                    `${apiBase}/repos/${owner}/${repo}/pulls/${pull_number}/files?per_page=50`,
                    { headers, signal: AbortSignal.timeout(15_000) },
                )
                if (!res.ok) return `GitHub error ${res.status}: ${res.statusText}`
                const files = await res.json() as Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string }>
                return files.map(f =>
                    `${f.status.toUpperCase()} ${f.filename} (+${f.additions}/-${f.deletions})\n${f.patch?.slice(0, 1000) ?? '(binary or too large)'}`
                ).join('\n---\n') || 'No files changed.'
            },
        }),
        github__create_pr_review: tool({
            description: 'Post a review on a pull request. Use COMMENT to add feedback without approving or requesting changes.',
            inputSchema: z.object({
                owner: z.string().describe('Repository owner (user or org)'),
                repo: z.string().describe('Repository name'),
                pull_number: z.number().describe('Pull request number'),
                body: z.string().describe('Review body text (markdown). Summarise your findings.'),
                event: z.enum(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']).default('COMMENT').describe('Review action'),
            }),
            execute: async ({ owner, repo, pull_number, body, event }) => {
                const res = await fetch(`${apiBase}/repos/${owner}/${repo}/pulls/${pull_number}/reviews`, {
                    method: 'POST',
                    headers: { ...headers, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ body, event }),
                    signal: AbortSignal.timeout(10_000),
                })
                if (!res.ok) {
                    const err = await res.text()
                    return `GitHub error ${res.status}: ${err.slice(0, 200)}`
                }
                const d = await res.json() as { id: number; state: string }
                return `Review #${d.id} submitted (${d.state}) on PR #${pull_number}`
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
                    signal: AbortSignal.timeout(10_000),
                })
                const d = await res.json() as { ok: boolean; error?: string }
                return d.ok ? 'Message sent.' : `Slack error: ${d.error}`
            },
        }),
        slack__list_channels: tool({
            description: 'List public channels in the Slack workspace.',
            inputSchema: z.object({ limit: z.number().optional().default(20) }),
            execute: async ({ limit }) => {
                const res = await fetch(`https://slack.com/api/conversations.list?limit=${limit}`, { headers, signal: AbortSignal.timeout(10_000) })
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
                const res = await fetch(`https://api.vercel.com/v6/deployments?limit=${limit}`, { headers, signal: AbortSignal.timeout(10_000) })
                if (!res.ok) return `Vercel error: ${res.status}`
                const d = await res.json() as { deployments: Array<{ url: string; state: string; name: string; createdAt: number }> }
                return d.deployments.map((dep) => `${dep.name} [${dep.state}] ${dep.url}`).join('\n')
            },
        }),
        vercel__get_deployment_status: tool({
            description: 'Get status of a specific Vercel deployment.',
            inputSchema: z.object({ deploymentId: z.string().describe('Deployment ID or URL') }),
            execute: async ({ deploymentId }) => {
                const res = await fetch(`https://api.vercel.com/v13/deployments/${deploymentId}`, { headers, signal: AbortSignal.timeout(10_000) })
                if (!res.ok) return `Vercel error: ${res.status}`
                const d = await res.json() as { url: string; readyState: string; meta?: { githubCommitMessage?: string } }
                return `${d.url} — ${d.readyState}${d.meta?.githubCommitMessage ? ` (${d.meta.githubCommitMessage})` : ''}`
            },
        }),
    }
}

const STRIPE_TOOLS: ToolFactory = (creds) => {
    const token = creds.secret_key ?? creds.access_token ?? ''
    // Stripe API keys (sk_*) use HTTP Basic Auth (key as username, empty password).
    // OAuth access_tokens use Bearer. Distinguish by checking which credential was set.
    const authHeader = creds.secret_key
        ? `Basic ${Buffer.from(token + ':').toString('base64')}`
        : `Bearer ${token}`
    const headers = { Authorization: authHeader }

    return {
        stripe__list_recent_payments: tool({
            description: 'List recent Stripe payment intents.',
            inputSchema: z.object({ limit: z.number().optional().default(10) }),
            execute: async ({ limit }) => {
                const res = await fetch(`https://api.stripe.com/v1/payment_intents?limit=${limit}`, { headers, signal: AbortSignal.timeout(10_000) })
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
                const res = await fetch(`https://api.stripe.com/v1/charges?created[gte]=${start}&limit=100`, { headers, signal: AbortSignal.timeout(10_000) })
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
                files: z.string().optional().describe('Comma-separated URLs to purge (ignored if purgeAll is true)'),
            }),
            execute: async ({ zoneId, purgeAll, files }) => {
                const fileList = (files ?? '').split(',').map((f: string) => f.trim()).filter(Boolean)
                const body = purgeAll ? { purge_everything: true } : { files: fileList }
                const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(10_000),
                })
                const d = await res.json() as { success: boolean; errors: Array<{ message: string }> }
                return d.success ? 'Cache purged.' : `Error: ${d.errors.map((e) => e.message).join(', ')}`
            },
        }),
        cloudflare__list_dns: tool({
            description: 'List DNS records for a Cloudflare zone.',
            inputSchema: z.object({ zone: z.string().describe('Zone ID from Cloudflare dashboard') }),
            execute: async ({ zone }) => {
                const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/dns_records?per_page=20`, { headers, signal: AbortSignal.timeout(10_000) })
                const d = await res.json() as { result: Array<{ type: string; name: string; content: string }> }
                return d.result?.map((r) => `${r.type} ${r.name} → ${r.content}`).join('\n') ?? 'No records.'
            },
        }),
    }
}

const SENTRY_TOOLS: ToolFactory = (creds) => {
    const token = creds.auth_token ?? creds.token ?? creds.access_token ?? ''
    const org = (creds.organization as string) ?? ''
    const headers = { Authorization: `Bearer ${token}` }

    return {
        sentry__list_projects: tool({
            description: 'List Sentry projects for the organization.',
            inputSchema: z.object({}),
            execute: async () => {
                const res = await fetch(`https://sentry.io/api/0/organizations/${org}/projects/`, { headers, signal: AbortSignal.timeout(10_000) })
                if (!res.ok) return `Sentry error: ${res.status}`
                const projects = await res.json() as Array<{ slug: string; name: string; platform: string }>
                return projects.map(p => `${p.name} (${p.slug}) — ${p.platform}`).join('\n') || 'No projects.'
            },
        }),
        sentry__list_issues: tool({
            description: 'List unresolved Sentry issues, optionally filtered by project.',
            inputSchema: z.object({
                project: z.string().optional().describe('Project slug to filter by'),
                limit: z.number().optional().default(25),
            }),
            execute: async ({ project, limit }) => {
                const query = project ? `&project=${project}` : ''
                const res = await fetch(`https://sentry.io/api/0/organizations/${org}/issues/?query=is:unresolved${query}&limit=${limit}`, { headers, signal: AbortSignal.timeout(10_000) })
                if (!res.ok) return `Sentry error: ${res.status}`
                const issues = await res.json() as Array<{ id: string; title: string; culprit: string; level: string; count: string }>
                return issues.map(i => `[${i.level}] ${i.title} (${i.count}x) — ${i.culprit}`).join('\n') || 'No unresolved issues.'
            },
        }),
        sentry__resolve_issue: tool({
            description: 'Resolve a Sentry issue by ID.',
            inputSchema: z.object({ issueId: z.string().describe('Sentry issue ID') }),
            execute: async ({ issueId }) => {
                const res = await fetch(`https://sentry.io/api/0/issues/${issueId}/`, {
                    method: 'PUT',
                    headers: { ...headers, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'resolved' }),
                    signal: AbortSignal.timeout(10_000),
                })
                if (!res.ok) return `Sentry error: ${res.status}`
                return `Issue ${issueId} resolved.`
            },
        }),
    }
}

const POSTHOG_TOOLS: ToolFactory = (creds) => {
    const apiKey = creds.api_key ?? creds.token ?? creds.access_token ?? ''
    const projectId = (creds.project_id as string) ?? ''
    const apiHost = (creds.api_host as string) ?? 'https://app.posthog.com'
    const headers = { Authorization: `Bearer ${apiKey}` }

    return {
        posthog__list_feature_flags: tool({
            description: 'List PostHog feature flags for the project.',
            inputSchema: z.object({}),
            execute: async () => {
                const res = await fetch(`${apiHost}/api/projects/${projectId}/feature_flags/`, { headers, signal: AbortSignal.timeout(10_000) })
                if (!res.ok) return `PostHog error: ${res.status}`
                const d = await res.json() as { results: Array<{ id: number; key: string; name: string; active: boolean; rollout_percentage: number | null }> }
                return d.results?.map(f => `${f.key} [${f.active ? 'ON' : 'OFF'}] ${f.rollout_percentage != null ? `${f.rollout_percentage}%` : '100%'} — ${f.name}`).join('\n') || 'No flags.'
            },
        }),
        posthog__toggle_feature_flag: tool({
            description: 'Enable or disable a PostHog feature flag.',
            inputSchema: z.object({
                flagId: z.number().describe('Feature flag ID'),
                active: z.boolean().describe('true to enable, false to disable'),
            }),
            execute: async ({ flagId, active }) => {
                const res = await fetch(`${apiHost}/api/projects/${projectId}/feature_flags/${flagId}/`, {
                    method: 'PATCH',
                    headers: { ...headers, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ active }),
                    signal: AbortSignal.timeout(10_000),
                })
                if (!res.ok) return `PostHog error: ${res.status}`
                return `Feature flag ${flagId} ${active ? 'enabled' : 'disabled'}.`
            },
        }),
    }
}

const OVHCLOUD_TOOLS: ToolFactory = (creds) => {
    const appKey = (creds.application_key as string) ?? ''
    const appSecret = (creds.application_secret as string) ?? ''
    const consumerKey = (creds.consumer_key as string) ?? ''
    const endpoint = (creds.endpoint as string) ?? 'ovh-eu'
    const baseUrls: Record<string, string> = {
        'ovh-eu': 'https://eu.api.ovh.com/1.0',
        'ovh-us': 'https://api.us.ovhcloud.com/1.0',
        'ovh-ca': 'https://ca.api.ovh.com/1.0',
    }
    const baseUrl = baseUrls[endpoint] ?? baseUrls['ovh-eu']!

    async function ovhRequest(method: string, path: string): Promise<Response> {
        const url = `${baseUrl}${path}`
        const timeRes = await fetch(`${baseUrl}/auth/time`, { signal: AbortSignal.timeout(10_000) })
        const timestamp = await timeRes.text()
        const { createHash } = await import('node:crypto')
        const sig = '$1$' + createHash('sha1')
            .update(`${appSecret}+${consumerKey}+${method}+${url}++${timestamp}`)
            .digest('hex')
        return fetch(url, {
            method,
            headers: {
                'X-Ovh-Application': appKey,
                'X-Ovh-Consumer': consumerKey,
                'X-Ovh-Timestamp': timestamp,
                'X-Ovh-Signature': sig,
                'Content-Type': 'application/json',
            },
            signal: AbortSignal.timeout(10_000),
        })
    }

    return {
        ovhcloud__list_servers: tool({
            description: 'List dedicated servers on OVHcloud.',
            inputSchema: z.object({}),
            execute: async () => {
                const res = await ovhRequest('GET', '/dedicated/server')
                if (!res.ok) return `OVH error: ${res.status}`
                const names = await res.json() as string[]
                return names.join('\n') || 'No servers found.'
            },
        }),
        ovhcloud__get_server_status: tool({
            description: 'Get status and hardware details of a specific OVHcloud dedicated server.',
            inputSchema: z.object({ serverName: z.string().describe('Server name (e.g. ns1234567.ip-1-2-3.eu)') }),
            execute: async ({ serverName }) => {
                const res = await ovhRequest('GET', `/dedicated/server/${encodeURIComponent(serverName)}`)
                if (!res.ok) return `OVH error: ${res.status}`
                const server = await res.json() as Record<string, unknown>
                return JSON.stringify(server, null, 2)
            },
        }),
    }
}

const DEEPGRAM_TOOLS: ToolFactory = (creds) => {
    const apiKey = (creds.api_key as string) ?? (creds.token as string) ?? ''
    const baseUrl = 'https://api.deepgram.com/v1'
    const authHeaders = { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' }

    return {
        deepgram__transcribe_audio: tool({
            description: 'Transcribe speech from an audio file URL. Supports mp3, wav, ogg, flac, m4a, webm. Returns the full transcript text.',
            inputSchema: z.object({
                audioUrl: z.string().url().describe('Publicly accessible URL to the audio file'),
                language: z.string().optional().describe('BCP-47 language code (e.g. "en-US", "es", "fr"). Omit to auto-detect.'),
                model: z.enum(['nova-3', 'nova-2', 'enhanced', 'base']).optional().default('nova-3').describe('Model tier. nova-3 is most accurate.'),
                diarize: z.boolean().optional().default(false).describe('Identify individual speakers'),
            }),
            execute: async ({ audioUrl, language, model = 'nova-3', diarize = false }) => {
                try {
                    const params = new URLSearchParams({
                        model,
                        punctuate: 'true',
                        ...(language && { language }),
                        ...(diarize && { diarize: 'true' }),
                    })
                    const res = await fetch(`${baseUrl}/listen?${params}`, {
                        method: 'POST',
                        headers: authHeaders,
                        body: JSON.stringify({ url: audioUrl }),
                        signal: AbortSignal.timeout(60_000),
                    })
                    if (!res.ok) return `Deepgram error ${res.status}: ${await res.text()}`
                    const data = await res.json() as {
                        results?: {
                            channels?: Array<{
                                alternatives?: Array<{ transcript: string; confidence: number }>
                                detected_language?: string
                            }>
                        }
                        metadata?: { duration?: number }
                    }
                    const alt = data.results?.channels?.[0]?.alternatives?.[0]
                    if (!alt?.transcript) return 'No transcript produced.'
                    const detectedLang = data.results?.channels?.[0]?.detected_language
                    const duration = data.metadata?.duration
                    const lines = [`Transcript (confidence ${(alt.confidence * 100).toFixed(1)}%):`]
                    if (detectedLang) lines.push(`Detected language: ${detectedLang}`)
                    if (duration) lines.push(`Audio duration: ${duration.toFixed(1)}s`)
                    lines.push('', alt.transcript)
                    return lines.join('\n')
                } catch (err) {
                    return `Transcription failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        deepgram__text_to_speech: tool({
            description: 'Convert text to spoken audio using Deepgram Aura. Returns a description of the generated audio with download instructions.',
            inputSchema: z.object({
                text: z.string().describe('Text to synthesize into speech'),
                voice: z.enum([
                    'aura-asteria-en', 'aura-luna-en', 'aura-stella-en', 'aura-athena-en',
                    'aura-hera-en', 'aura-orion-en', 'aura-arcas-en', 'aura-perseus-en',
                    'aura-angus-en', 'aura-orpheus-en', 'aura-helios-en', 'aura-zeus-en',
                ]).optional().default('aura-asteria-en').describe('Voice model. aura-asteria-en is a clear female English voice.'),
                encoding: z.enum(['mp3', 'wav', 'ogg']).optional().default('mp3'),
            }),
            execute: async ({ text, voice = 'aura-asteria-en', encoding = 'mp3' }) => {
                try {
                    const params = new URLSearchParams({ model: voice, encoding })
                    const res = await fetch(`${baseUrl}/speak?${params}`, {
                        method: 'POST',
                        headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ text }),
                        signal: AbortSignal.timeout(30_000),
                    })
                    if (!res.ok) return `Deepgram TTS error ${res.status}: ${await res.text()}`
                    const bytes = await res.arrayBuffer()
                    const kb = (bytes.byteLength / 1024).toFixed(1)
                    const b64 = Buffer.from(bytes).toString('base64')
                    return `Speech generated: ${kb} KB of ${encoding.toUpperCase()} audio using voice "${voice}".\nbase64:${b64}`
                } catch (err) {
                    return `TTS failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        deepgram__analyze_audio: tool({
            description: 'Analyze audio for sentiment, detected topics, named entities, and a summary. Useful for meeting recordings, calls, podcasts, and interviews.',
            inputSchema: z.object({
                audioUrl: z.string().url().describe('Publicly accessible URL to the audio file'),
                features: z.array(z.enum(['sentiment', 'topics', 'entities', 'summarize'])).optional()
                    .default(['sentiment', 'topics', 'summarize'])
                    .describe('Which analysis features to enable'),
            }),
            execute: async ({ audioUrl, features = ['sentiment', 'topics', 'summarize'] }) => {
                try {
                    const params = new URLSearchParams({ model: 'nova-3', punctuate: 'true' })
                    if (features.includes('sentiment')) params.set('sentiment', 'true')
                    if (features.includes('topics')) params.set('topics', 'true')
                    if (features.includes('entities')) params.set('ner', 'true')
                    if (features.includes('summarize')) params.set('summarize', 'v2')

                    const res = await fetch(`${baseUrl}/listen?${params}`, {
                        method: 'POST',
                        headers: authHeaders,
                        body: JSON.stringify({ url: audioUrl }),
                        signal: AbortSignal.timeout(90_000),
                    })
                    if (!res.ok) return `Deepgram error ${res.status}: ${await res.text()}`
                    const data = await res.json() as {
                        results?: {
                            channels?: Array<{ alternatives?: Array<{ transcript: string }> }>
                            sentiments?: { average?: { sentiment: string; sentiment_score: number } }
                            topics?: { segments?: Array<{ topics: Array<{ topic: string; confidence_score: number }> }> }
                            entities?: { results?: Array<{ alternatives?: Array<{ entities: Array<{ label: string; value: string }> }> }> }
                            summary?: { result?: string }
                        }
                    }
                    const results = data.results
                    const lines: string[] = []

                    if (results?.summary?.result) {
                        lines.push(`SUMMARY:\n${results.summary.result}`)
                    }
                    if (results?.sentiments?.average) {
                        const s = results.sentiments.average
                        lines.push(`\nSENTIMENT: ${s.sentiment} (score: ${s.sentiment_score.toFixed(2)})`)
                    }
                    if (results?.topics?.segments?.length) {
                        const topTopics = results.topics.segments
                            .flatMap(s => s.topics)
                            .sort((a, b) => b.confidence_score - a.confidence_score)
                            .slice(0, 5)
                            .map(t => `  • ${t.topic} (${(t.confidence_score * 100).toFixed(0)}%)`)
                        lines.push(`\nTOPICS:\n${topTopics.join('\n')}`)
                    }
                    if (results?.entities?.results?.length) {
                        const entities = results.entities.results
                            .flatMap(r => r.alternatives?.flatMap(a => a.entities) ?? [])
                            .slice(0, 10)
                            .map(e => `  • [${e.label}] ${e.value}`)
                        if (entities.length) lines.push(`\nENTITIES:\n${entities.join('\n')}`)
                    }
                    if (!lines.length) return 'Analysis returned no structured results.'
                    return lines.join('\n')
                } catch (err) {
                    return `Audio analysis failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        deepgram__detect_language: tool({
            description: 'Detect the spoken language in an audio file.',
            inputSchema: z.object({
                audioUrl: z.string().url().describe('Publicly accessible URL to the audio file'),
            }),
            execute: async ({ audioUrl }) => {
                try {
                    const res = await fetch(`${baseUrl}/listen?model=nova-3&detect_language=true`, {
                        method: 'POST',
                        headers: authHeaders,
                        body: JSON.stringify({ url: audioUrl }),
                        signal: AbortSignal.timeout(30_000),
                    })
                    if (!res.ok) return `Deepgram error ${res.status}`
                    const data = await res.json() as {
                        results?: { channels?: Array<{ detected_language?: string; language_confidence?: number }> }
                    }
                    const ch = data.results?.channels?.[0]
                    const lang = ch?.detected_language ?? 'unknown'
                    const conf = ch?.language_confidence != null ? ` (${(ch.language_confidence * 100).toFixed(1)}% confidence)` : ''
                    return `Detected language: ${lang}${conf}`
                } catch (err) {
                    return `Language detection failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),
    }
}

// ── Tool factory registry ─────────────────────────────────────────────────────
// The factories defined INSIDE this file (github, slack, vercel, stripe,
// cloudflare, sentry, posthog, ovhcloud, deepgram) are registered
// with registry.ts at module load time. Everything else is imported by
// registry.ts directly from ./factories/*. `TOOL_FACTORIES` is then derived
// from the registry — no hand-maintained map lives in this file anymore.

import {
    registerBridgeFactories,
    buildToolFactoryMap,
    CONNECTION_REGISTRY,
} from './registry.js'

registerBridgeFactories({
    github: GITHUB_TOOLS,
    slack: SLACK_TOOLS,
    vercel: VERCEL_TOOLS,
    stripe: STRIPE_TOOLS,
    cloudflare: CLOUDFLARE_TOOLS,
    sentry: SENTRY_TOOLS,
    posthog: POSTHOG_TOOLS,
    ovhcloud: OVHCLOUD_TOOLS,
    deepgram: DEEPGRAM_TOOLS,
})

// Legacy-shaped map used below by loadConnectionTools. Derived from the
// registry — adding a provider = one edit in registry.ts.
const TOOL_FACTORIES: Record<string, ToolFactory | undefined> = buildToolFactoryMap()

// Re-export the registry itself so consumers that want richer metadata can
// pull it without a second import.
export { CONNECTION_REGISTRY } from './registry.js'

// ── Google OAuth token refresh ────────────────────────────────────────────────

const GOOGLE_REGISTRY_IDS = new Set(['google-workspace'])

async function maybeRefreshGoogleToken(
    creds: ConnectionCredentials,
    connectionId: string,
    workspaceId: string,
): Promise<ConnectionCredentials> {
    if (!creds.expires_at || !creds.refresh_token) return creds
    if (new Date(creds.expires_at as string) > new Date(Date.now() + 60_000)) return creds

    const clientId = process.env.GOOGLE_CLIENT_ID
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET
    if (!clientId || !clientSecret) return creds

    try {
        const res = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: clientId,
                client_secret: clientSecret,
                refresh_token: creds.refresh_token,
                grant_type: 'refresh_token',
            }),
            signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) {
            logger.warn({ connectionId, status: res.status }, 'Google token refresh failed')
            return creds
        }
        const data = await res.json() as { access_token?: string; expires_in?: number }
        if (!data.access_token) return creds

        const refreshed: ConnectionCredentials = {
            ...creds,
            access_token: data.access_token,
            expires_at: new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
        }
        const encrypted = { encrypted: encrypt(JSON.stringify(refreshed), workspaceId) }
        await db.update(installedConnections)
            .set({ credentials: encrypted, lastVerifiedAt: new Date() })
            .where(eq(installedConnections.id, connectionId))
        logger.info({ connectionId }, 'Google access token refreshed and stored')
        return refreshed
    } catch (err) {
        logger.warn({ err, connectionId }, 'Google token refresh threw — using existing token')
        return creds
    }
}

// ── Bridge: load workspace connections → AI SDK tools ────────────────────────

/**
 * Load active connection tools for a workspace.
 *
 * @param allowedIds - When non-empty, restrict to connections whose `id` is in
 *   this list. Connections not in the list are not loaded — their tools are
 *   completely unreachable, not merely hidden. When undefined or empty, all
 *   active workspace connections are loaded (current default behavior).
 * @param appId - Connection & Profile Standard (ADR 0001 §3): when set and
 *   profile enforcement is enabled, connections are further restricted to the
 *   registry IDs in the operator-granted (app×workspace) profile (default-deny).
 *   This is orthogonal to `allowedIds` (per-task scope) — both must permit a
 *   connection for its tools to load.
 */
export async function loadConnectionTools(workspaceId: string, allowedIds?: string[], appId?: string): Promise<ToolSet> {
    // Explicit empty allowlist = deny-all: no connections loaded.
    // Automated sources (cron, github) use this to fail-closed when no connector
    // scope is configured. Interactive tasks pass undefined to allow-all.
    if (allowedIds !== undefined && allowedIds.length === 0) {
        return {}
    }

    try {
        // Connection & Profile Standard (ADR 0001 §3): when an app dispatched this
        // task and enforcement is on, resolve the granted profile once. null →
        // enforcement does not apply (allow-all). A profile (incl. EMPTY) → filter
        // connections to its allowed registry IDs below.
        const { resolveEnforcedProfile, getEnforcementMode } = await import('../profile/grant.js')
        const { isConnectorAllowed } = await import('../profile/resolve.js')
        const enforcedProfile = await resolveEnforcedProfile(workspaceId, appId)
        const enforcementMode = getEnforcementMode()
        const monitorHits: string[] = [] // connector registryIds we'd have excluded (monitor mode)
        // Read workspace settings for read-only mode flag (Phase 9).
        // On any error reading the workspace, default to NOT-read-only so
        // we don't accidentally cripple a workspace that already worked.
        let readOnlyMode = false
        try {
            const [ws] = await db
                .select({ settings: workspaces.settings })
                .from(workspaces)
                .where(eq(workspaces.id, workspaceId))
                .limit(1)
            const s = (ws?.settings ?? {}) as { readOnlyMode?: boolean }
            readOnlyMode = s.readOnlyMode === true
        } catch { /* non-fatal */ }

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
                // Connector allowlist: when non-empty, restrict to listed IDs only.
                // Non-listed connections are excluded from the query — their tools
                // are completely unreachable, not just absent from the prompt.
                allowedIds && allowedIds.length > 0
                    ? inArray(installedConnections.id, allowedIds)
                    : undefined,
            ))

        const merged: ToolSet = {}

        // ── Bridge extension dedup guard ────────────────────────────────────
        // When a PEX bridge extension supersedes a connection factory (e.g.
        // levio-bridge replaces levio factory tools), skip the factory to
        // prevent double-registration of overlapping tools.
        const bridgeSuperseded = new Set<string>()
        try {
            const BRIDGE_MAP: Record<string, string> = {
                '@joeybuilt/levio-bridge': 'levio',
                '@joeybuilt/fonto-bridge': 'fonto',
                '@joeybuilt/nexalog-bridge': 'nexalog',
                '@joeybuilt/koforje-bridge': 'koforje',
                '@joeybuilt/fylo-bridge': 'fylo',
            }
            const bridgeRows = await db
                .select({ name: extensions.name, enabled: extensions.enabled })
                .from(extensions)
                .where(and(eq(extensions.workspaceId, workspaceId), eq(extensions.enabled, true)))
            for (const br of bridgeRows) {
                const supersedes = BRIDGE_MAP[br.name]
                if (supersedes) {
                    bridgeSuperseded.add(supersedes)
                    logger.info({ workspaceId, extension: br.name, supersedes }, 'Bridge extension active — skipping connection factory tools')
                }
            }
        } catch (err) {
            logger.warn({ err, workspaceId }, 'Bridge extension dedup check failed — loading all factory tools')
        }

        for (const row of rows) {
            // Profile enforcement (ADR 0001 §3): drop connections whose registry
            // ID is not in the app's effective profile. enforcedProfile is null
            // when enforcement does not apply.
            if (enforcedProfile && !isConnectorAllowed(enforcedProfile, row.registryId)) {
                if (enforcementMode === 'monitor') {
                    logger.warn({ event: 'profile.monitor.would_exclude', kind: 'connector', workspaceId, appId, registryId: row.registryId }, 'Profile monitor: connector WOULD be excluded (not enforced)')
                    monitorHits.push(row.registryId)
                    // fall through — keep the connection in monitor mode
                } else {
                    logger.info({ workspaceId, appId, registryId: row.registryId }, 'Connection excluded by app profile')
                    continue
                }
            }

            // Skip factory when a bridge extension supersedes it.
            if (bridgeSuperseded.has(row.registryId)) continue

            const factory = TOOL_FACTORIES[row.registryId]
            if (!factory) {
                logger.warn({ workspaceId, registryId: row.registryId, connectionId: row.id }, 'No tool factory for installed connection — connection is active but produces no tools')
                continue
            }

            // Decrypt credentials.
            let creds: ConnectionCredentials = {}
            try {
                const raw = row.credentials as { encrypted?: string } | null
                if (raw?.encrypted) {
                    const decrypted = decrypt(raw.encrypted, workspaceId)
                    creds = JSON.parse(decrypted) as ConnectionCredentials
                }
            } catch (err) {
                logger.warn({ workspaceId, registryId: row.registryId, connectionId: row.id, err }, 'Failed to decrypt credentials — connection skipped')
                continue
            }

            // Refresh expired Google access tokens before passing to the factory.
            if (GOOGLE_REGISTRY_IDS.has(row.registryId)) {
                creds = await maybeRefreshGoogleToken(creds, row.id, workspaceId)
            }

            const tools = await factory(creds, { connectionId: row.id, workspaceId })

            // Apply enabled_tools filter (null = all enabled)
            const enabled = row.enabledTools as string[] | null
            for (const [name, def] of Object.entries(tools)) {
                // mcp__<server>__<tool> → raw tool name is the LAST segment;
                // {prefix}__<tool> → raw tool name is the SECOND segment.
                const segs = name.split('__')
                const shortName = (segs.length > 2 ? segs[segs.length - 1] : segs[1]) ?? name
                if (enabled !== null && !enabled.includes(shortName) && !enabled.includes(name)) {
                    continue
                }
                // Read-only mode filter (Phase 9): drop tools that mutate state.
                if (readOnlyMode && isWriteTool(name)) continue
                merged[name] = def
            }
        }

        // ── Self-extension tool ────────────────────────────────────────────────
        // Always available — lets the agent generate new skills/connections on demand.
        // Exception: hidden in read-only mode (it installs new connections).
        if (!readOnlyMode) merged['synthesize_extension'] = tool({
            description:
                'Research a third-party service API and generate, install, and activate a ' +
                'PEX extension + connection entry for it. Call this when the user needs to ' +
                'integrate with a service that has no installed extension or connector. ' +
                'The tool handles doc scraping, code generation, disk persistence, ' +
                'connection registration, and auto-activation in one call.',
            inputSchema: z.object({
                serviceName: z.string().describe(
                    'Human-readable service name, e.g. "Intercom" or "Airtable"',
                ),
                serviceWebsite: z.string().describe(
                    'Official website or docs URL, e.g. "https://developers.intercom.com"',
                ),
                requestedCapabilities: z.string().describe(
                    'Comma-separated list of operations the user wants, e.g. ' +
                    '"list open conversations, send a reply, poll for new messages"',
                ),
            }),
            execute: async ({ serviceName, serviceWebsite, requestedCapabilities }) => {
                const { synthesizeSkill } = await import('../plugins/synthesizer.js')
                const capabilities = requestedCapabilities
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean)
                const result = await synthesizeSkill({
                    serviceName,
                    serviceWebsite,
                    requestedCapabilities: capabilities,
                    workspaceId,
                })
                if (!result.ok) return `Synthesis failed: ${result.error}`
                return result.message
            },
        })


        // Monitor mode: persist what we would have excluded (best-effort,
        // fire-and-forget) so the App Grants UI can surface real coverage gaps.
        if (enforcementMode === 'monitor' && appId && monitorHits.length > 0) {
            const { recordMonitorObservations } = await import('../profile/monitor.js')
            void recordMonitorObservations(workspaceId, appId, monitorHits.map((t) => ({ kind: 'connector', token: t })))
        }

        return merged
    } catch {
        // Non-fatal — executor continues with built-in tools only
        return {}
    }
}
