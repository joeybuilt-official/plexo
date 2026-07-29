// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// @joeybuilt/koforje-bridge — Pex tool extension that proxies tool calls to
// Koforje's HTTP API. Mirrors @joeybuilt/levio-bridge / @joeybuilt/nexalog-bridge.

import type { PlexoSDK, ToolRegistration, InvokeContext } from '@joeybuilt/plexo-sdk'

// ── Config ──────────────────────────────────────────────────────────────────

function koforjeBase(): string {
    return (process.env.KOFORJE_INTERNAL_URL ?? 'http://koforje:3000').replace(/\/$/, '')
}

function serviceHeaders(): Record<string, string> {
    return {
        Authorization: `Bearer ${process.env.PLEXO_SERVICE_KEY ?? ''}`,
        'Content-Type': 'application/json',
    }
}

const TIMEOUT_MS = 15_000

// Cached at activation time so tools auto-authenticate.
let _cachedUserId: string | null = null

function resolveUserId(params: { userId?: string }): string {
    const uid = params.userId || _cachedUserId || ''
    if (!uid) throw new Error('No Koforje user ID available. Connect Koforje in Settings > Integrations.')
    return uid
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

async function koforjeFetch(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
    const init: RequestInit = {
        method,
        headers: serviceHeaders(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    }
    if (body !== undefined) init.body = JSON.stringify(body)
    const res = await fetch(`${koforjeBase()}${path}`, init)
    if (!res.ok) {
        const txt = await res.text().catch(() => '')
        throw new Error(`Koforje API error ${res.status}: ${txt.slice(0, 200)}`)
    }
    if (res.status === 204) return null
    return res.json()
}

// ── Tools ───────────────────────────────────────────────────────────────────

function workspaceListTool(): ToolRegistration {
    return {
        name: 'koforje.workspace.list',
        description: "List the user's Koforje workspaces. Returns ID, name, mode, and updated time.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Koforje user ID (auto-resolved).' },
            },
            required: [],
        },
        hints: { estimatedMs: 1500, timeoutMs: TIMEOUT_MS, hasSideEffects: false, idempotent: true },
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const p = params as { userId?: string }
            resolveUserId(p)
            const data = await koforjeFetch('GET', '/api/workspaces') as { workspaces: Array<{ id: string; name: string; mode: string; updatedAt: string }> }
            if (!data.workspaces?.length) return 'No workspaces.'
            return [`${data.workspaces.length} workspaces:`, ...data.workspaces.map((w) => `- ${w.id} | ${w.name} [${w.mode}]`)].join('\n')
        },
    }
}

function workspaceGetTool(): ToolRegistration {
    return {
        name: 'koforje.workspace.get',
        description: 'Fetch details of a single Koforje workspace by ID.',
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Koforje user ID (auto-resolved).' },
                id: { type: 'string', description: 'Workspace UUID.' },
            },
            required: ['id'],
        },
        hints: { estimatedMs: 1000, timeoutMs: TIMEOUT_MS, hasSideEffects: false, idempotent: true },
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const p = params as { userId?: string; id: string }
            resolveUserId(p)
            const data = await koforjeFetch('GET', `/api/workspaces/${encodeURIComponent(p.id)}`) as { workspace: { id: string; name: string; description?: string; repoUrl?: string; mode: string } }
            const w = data.workspace
            return [`# ${w.name}`, `ID: ${w.id} | Mode: ${w.mode}`, w.repoUrl ? `Repo: ${w.repoUrl}` : '', '', w.description || '(no description)'].filter(Boolean).join('\n')
        },
    }
}

function workspaceCreateTool(): ToolRegistration {
    return {
        name: 'koforje.workspace.create',
        description: 'Create a new Koforje workspace. If repoUrl is provided, the repository is cloned into the workspace.',
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Koforje user ID (auto-resolved).' },
                name: { type: 'string', description: 'Workspace name.' },
                description: { type: 'string', description: 'Optional description.' },
                repoUrl: { type: 'string', description: 'Optional Git repository URL to clone.' },
                mode: { type: 'string', description: "Editor mode: 'developer' or 'vibe'.", enum: ['developer', 'vibe'] },
            },
            required: ['name'],
        },
        hints: { estimatedMs: 5000, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: false },
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const p = params as { userId?: string; name: string; description?: string; repoUrl?: string; mode?: string }
            resolveUserId(p)
            const data = await koforjeFetch('POST', '/api/workspaces', {
                name: p.name,
                description: p.description,
                repoUrl: p.repoUrl,
                mode: p.mode ?? 'developer',
            }) as { workspace: { id: string; name: string } }
            return `Workspace created: ${data.workspace.name} (ID: ${data.workspace.id})`
        },
    }
}

function workspaceDeleteTool(): ToolRegistration {
    return {
        name: 'koforje.workspace.delete',
        description: 'Delete a Koforje workspace by ID. Irreversible.',
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Koforje user ID (auto-resolved).' },
                id: { type: 'string', description: 'Workspace UUID.' },
            },
            required: ['id'],
        },
        hints: { estimatedMs: 2000, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: false },
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const p = params as { userId?: string; id: string }
            resolveUserId(p)
            await koforjeFetch('DELETE', `/api/workspaces/${encodeURIComponent(p.id)}`)
            return `Workspace deleted: ${p.id}`
        },
    }
}

function fileSearchTool(): ToolRegistration {
    return {
        name: 'koforje.file.search',
        description: "Text or semantic search across files in a Koforje workspace. Provide either q (text) or embedding (JSON-encoded number[]).",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Koforje user ID (auto-resolved).' },
                workspaceId: { type: 'string', description: 'Workspace UUID.' },
                q: { type: 'string', description: 'Text query (path ILIKE).' },
                limit: { type: 'number', description: 'Max results (default 10).' },
            },
            required: ['workspaceId'],
        },
        hints: { estimatedMs: 2500, timeoutMs: TIMEOUT_MS, hasSideEffects: false, idempotent: true },
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const p = params as { userId?: string; workspaceId: string; q?: string; limit?: number }
            resolveUserId(p)
            const qp = new URLSearchParams()
            if (p.q) qp.set('q', p.q)
            if (p.limit) qp.set('limit', String(p.limit))
            const data = await koforjeFetch('GET', `/api/workspaces/${encodeURIComponent(p.workspaceId)}/search?${qp}`) as { results: Array<{ id: string; path: string; language?: string }> }
            if (!data.results?.length) return p.q ? `No matches for "${p.q}".` : 'No results.'
            return [`${data.results.length} results:`, ...data.results.map((r) => `- ${r.path}${r.language ? ` [${r.language}]` : ''}`)].join('\n')
        },
    }
}

function agentRunTool(): ToolRegistration {
    return {
        name: 'koforje.agent.run',
        description: 'Trigger an agent run inside a Koforje workspace.',
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Koforje user ID (auto-resolved).' },
                workspaceId: { type: 'string', description: 'Workspace UUID.' },
                prompt: { type: 'string', description: 'Agent prompt / task description.' },
                type: { type: 'string', description: "Run type. Defaults to 'code-sprint'." },
                files: { type: 'array', items: { type: 'string' }, description: 'Optional file paths to include in context.' },
            },
            required: ['workspaceId', 'prompt'],
        },
        hints: { estimatedMs: 5000, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: false },
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const p = params as { userId?: string; workspaceId: string; prompt: string; type?: string; files?: string[] }
            resolveUserId(p)
            const data = await koforjeFetch('POST', `/api/workspaces/${encodeURIComponent(p.workspaceId)}/agent/run`, {
                prompt: p.prompt,
                type: p.type,
                files: p.files,
            }) as { run: { id: string; status: string; plexoTaskId?: string } }
            return `Agent run started: ${data.run.id} (status=${data.run.status}${data.run.plexoTaskId ? `, plexoTaskId=${data.run.plexoTaskId}` : ''})`
        },
    }
}

function agentRunsListTool(): ToolRegistration {
    return {
        name: 'koforje.agent.runs.list',
        description: 'List recent agent runs for a Koforje workspace (most recent 20).',
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Koforje user ID (auto-resolved).' },
                workspaceId: { type: 'string', description: 'Workspace UUID.' },
            },
            required: ['workspaceId'],
        },
        hints: { estimatedMs: 1500, timeoutMs: TIMEOUT_MS, hasSideEffects: false, idempotent: true },
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const p = params as { userId?: string; workspaceId: string }
            resolveUserId(p)
            const data = await koforjeFetch('GET', `/api/workspaces/${encodeURIComponent(p.workspaceId)}/agent/runs`) as { runs: Array<{ id: string; status: string; prompt: string; createdAt: string }> }
            if (!data.runs?.length) return 'No agent runs.'
            return [`${data.runs.length} runs:`, ...data.runs.map((r) => `- ${r.id} | ${r.status} | ${r.prompt.slice(0, 60)}`)].join('\n')
        },
    }
}

function deployCreateTool(): ToolRegistration {
    return {
        name: 'koforje.deploy.create',
        description: 'Trigger a deploy of a Koforje workspace.',
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Koforje user ID (auto-resolved).' },
                workspaceId: { type: 'string', description: 'Workspace UUID.' },
                provider: { type: 'string', description: "Deploy provider: 'vercel', 'netlify', 'cloudflare', 'fly', etc." },
                branch: { type: 'string', description: "Git branch (default 'main')." },
                commitSha: { type: 'string', description: 'Optional commit SHA to deploy.' },
            },
            required: ['workspaceId', 'provider'],
        },
        hints: { estimatedMs: 5000, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: false },
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const p = params as { userId?: string; workspaceId: string; provider: string; branch?: string; commitSha?: string }
            resolveUserId(p)
            const data = await koforjeFetch('POST', `/api/workspaces/${encodeURIComponent(p.workspaceId)}/deploy`, {
                provider: p.provider,
                branch: p.branch,
                commitSha: p.commitSha,
            }) as { deploy: { id: string; status: string; deployUrl?: string } }
            return `Deploy started: ${data.deploy.id} (status=${data.deploy.status}${data.deploy.deployUrl ? `, url=${data.deploy.deployUrl}` : ''})`
        },
    }
}

function deployListTool(): ToolRegistration {
    return {
        name: 'koforje.deploy.list',
        description: 'List recent deploys for a Koforje workspace (most recent 20).',
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Koforje user ID (auto-resolved).' },
                workspaceId: { type: 'string', description: 'Workspace UUID.' },
            },
            required: ['workspaceId'],
        },
        hints: { estimatedMs: 1500, timeoutMs: TIMEOUT_MS, hasSideEffects: false, idempotent: true },
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const p = params as { userId?: string; workspaceId: string }
            resolveUserId(p)
            const data = await koforjeFetch('GET', `/api/workspaces/${encodeURIComponent(p.workspaceId)}/deploy`) as { deploys: Array<{ id: string; status: string; provider: string; createdAt: string }> }
            if (!data.deploys?.length) return 'No deploys.'
            return [`${data.deploys.length} deploys:`, ...data.deploys.map((d) => `- ${d.id} | ${d.provider} | ${d.status}`)].join('\n')
        },
    }
}

// ── Activation ──────────────────────────────────────────────────────────────

export async function activate(sdk: PlexoSDK): Promise<void> {
    try {
        _cachedUserId = await sdk.storage.get('koforje_user_id')
    } catch {
        // storage:read may fail in test/bootstrap — tools fall back to explicit userId.
    }

    sdk.registerTool(workspaceListTool())
    sdk.registerTool(workspaceGetTool())
    sdk.registerTool(workspaceCreateTool())
    sdk.registerTool(workspaceDeleteTool())
    sdk.registerTool(fileSearchTool())
    sdk.registerTool(agentRunTool())
    sdk.registerTool(agentRunsListTool())
    sdk.registerTool(deployCreateTool())
    sdk.registerTool(deployListTool())
}
