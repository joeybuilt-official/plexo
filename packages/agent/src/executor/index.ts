// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { generateText, tool, stepCountIs } from 'ai'
import { z } from 'zod'
import { db, sql, eq, and } from '@plexo/db'
import { taskSteps, artifacts, artifactVersions } from '@plexo/db'
import { ulid } from 'ulid'
import { withFallback, resolveModel } from '../providers/registry.js'
import { SAFETY_LIMITS } from '../constants.js'
import { PlexoError, LogicError } from '../errors.js'
import { loadConnectionTools } from '../connections/bridge.js'
import { loadPluginTools } from '../plugins/bridge.js'
import { assignVariant, recordVariantOutcome } from '../memory/ab-variants.js'
import { getPromptOverrides } from '../memory/prompt-improvement.js'
import { requestApproval, waitForDecision } from '../one-way-door.js'
import { searchMemory } from '../memory/store.js'
import { buildCapabilityManifest, manifestToPromptBlock } from '../capabilities/manifest.js'
import { join } from 'node:path'

import type { ExecutionContext, ExecutionPlan, ExecutionResult, StepResult } from '../types.js'
import type { WorkspaceAISettings } from '../providers/registry.js'
import { judgeQuality } from './quality-judge.js'
import type { JudgeMeta } from './quality-judge.js'
import { buildBrowserTools, closeBrowser } from './browser.js'

// ── Test output parser ────────────────────────────────────────

interface ParsedTestResult {
    pass: boolean
    name: string
    detail: string
}

/**
 * Extracts structured pass/fail info from common test runner output.
 * Handles: vitest, jest, mocha, TAP.
 * Returns an empty array if no test result lines are found.
 */
function parseTestOutput(output: string): ParsedTestResult[] {
    const results: ParsedTestResult[] = []
    const lines = output.split('\n')

    // Collect 2-line context for detail
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i]
        if (raw === undefined) continue
        const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim() // strip ANSI

        // vitest / jest individual test lines: ✓ or × or ✕
        // e.g. "  ✓ should return 200 (15ms)"
        //      "  × should parse JSON"
        const vitestMatch = line.match(/^[✓✔]\s+(.+?)(?:\s+\(\d+ms\))?$/)
        if (vitestMatch?.[1]) {
            results.push({ pass: true, name: vitestMatch[1].trim(), detail: '' })
            continue
        }
        const vitestFail = line.match(/^[×✕✗]\s+(.+?)(?:\s+\(\d+ms\))?$/)
        if (vitestFail?.[1]) {
            const detail = lines.slice(i + 1, i + 4).map(l => (l ?? '').replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(Boolean).join('\n')
            results.push({ pass: false, name: vitestFail[1].trim(), detail })
            continue
        }

        // TAP: ok 1 - test name / not ok 1 - test name
        const tapOk = line.match(/^ok\s+\d+\s+-?\s*(.+)$/)
        if (tapOk?.[1]) {
            results.push({ pass: true, name: tapOk[1].trim(), detail: '' })
            continue
        }
        const tapFail = line.match(/^not ok\s+\d+\s+-?\s*(.+)$/)
        if (tapFail?.[1]) {
            results.push({ pass: false, name: tapFail[1].trim(), detail: '' })
            continue
        }

        // Jest file-level PASS/FAIL (used as synthetic result when no individual lines follow)
        // "PASS src/foo.test.ts" or "FAIL src/foo.test.ts"
        const jestFile = line.match(/^(PASS|FAIL)\s+(.+\.(?:test|spec)\.[jt]sx?)$/)
        if (jestFile?.[1] && jestFile[2] && results.length === 0) {
            // Only add file-level result when no fine-grained results were found
            results.push({
                pass: jestFile[1] === 'PASS',
                name: jestFile[2].trim(),
                detail: jestFile[1] === 'FAIL' ? 'See terminal output for details' : '',
            })
        }
    }

    return results
}

// ── Tool dispatcher ───────────────────────────────────────────

async function dispatchTool(
    name: string,
    input: Record<string, unknown>,
    ctx: ExecutionContext,
): Promise<string> {
    const { readFileSync, writeFileSync, mkdirSync, existsSync } = await import('node:fs')
    const { dirname, resolve, isAbsolute, relative } = await import('node:path')

    // defaultCwd: for sprint coding tasks this is the cloned repo working dir
    const defaultCwd = (ctx.sprintWorkDir as string | undefined) ?? process.cwd()
    const emit = ctx.emitStepEvent

    switch (name) {
        case 'read_file': {
            try {
                const rawPath = input.path as string
                const p = isAbsolute(rawPath) ? rawPath : resolve(defaultCwd, rawPath)
                return readFileSync(p, 'utf8')
            } catch (e) {
                return `ERROR: ${(e as Error).message}`
            }
        }

        case 'write_file': {
            try {
                const rawPath = input.path as string
                const p = isAbsolute(rawPath) ? rawPath : resolve(defaultCwd, rawPath)
                mkdirSync(dirname(p), { recursive: true })

                // Capture old content for diff (Code Mode)
                let oldContent = ''
                try { oldContent = readFileSync(p, 'utf8') } catch { /* new file */ }

                const newContent = input.content as string
                writeFileSync(p, newContent, 'utf8')

                // Emit file write event with unified diff
                if (emit) {
                    let patch = ''
                    try {
                        const { createPatch } = await import('diff')
                        const relPath = defaultCwd ? relative(defaultCwd, p) : p
                        patch = createPatch(relPath, oldContent, newContent, '', '')
                    } catch { /* diff not available — emit empty patch */ }
                    const relPath = defaultCwd ? relative(defaultCwd, p) : p
                    emit({
                        type: 'step.file_write',
                        taskId: ctx.taskId,
                        workspaceId: ctx.workspaceId,
                        path: relPath,
                        patch,
                        ts: Date.now(),
                    })
                }

                return `OK: wrote ${newContent.length} bytes to ${p}`
            } catch (e) {
                return `ERROR: ${(e as Error).message}`
            }
        }

        case 'shell': {
            try {
                const { spawnSync } = await import('node:child_process')
                const cwd = (input.cwd as string | undefined) ?? defaultCwd
                const command = input.command as string

                // Detect label from command content for better UI grouping
                const label = /ssh\s/.test(command)
                    ? 'ssh'
                    : /playwright|vitest|jest|mocha/.test(command)
                        ? 'test'
                        : 'shell'

                // Allowlist — never spread process.env into the subshell.
                // That would expose ENCRYPTION_SECRET, API keys, DATABASE_URL, etc.
                const SAFE_ENV_KEYS = new Set([
                    'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
                    'NODE_ENV', 'NODE_PATH', 'TMPDIR', 'TMP', 'TEMP',
                    'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL',
                    'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
                    'PNPM_HOME', 'npm_config_cache',
                    // Connection tokens needed for git push, MCP servers, etc.
                    'GITHUB_TOKEN', 'GITHUB_PERSONAL_ACCESS_TOKEN',
                    'GITLAB_PERSONAL_ACCESS_TOKEN', 'GITLAB_TOKEN',
                    'NPM_TOKEN', 'VERCEL_TOKEN', 'NETLIFY_AUTH_TOKEN',
                    // Allow workspace-scoped custom env (set by connection bridge)
                    'PLEXO_WORKSPACE_ID',
                ])
                const safeEnv: Record<string, string> = {}
                for (const [k, v] of Object.entries(process.env)) {
                    if (v !== undefined && SAFE_ENV_KEYS.has(k)) safeEnv[k] = v
                }
                safeEnv.PATH = process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

                const result = spawnSync('sh', ['-c', command], {
                    cwd,
                    timeout: 60_000,
                    maxBuffer: 2 * 1024 * 1024,
                    encoding: 'utf8',
                    env: safeEnv,
                })

                const combined = [
                    result.stdout?.trim() ?? '',
                    result.stderr?.trim() ?? '',
                ]
                    .filter(Boolean)
                    .join('\n')

                // Emit each line as a streaming SSE event (Code Mode)
                if (emit && combined) {
                    for (const line of combined.split('\n')) {
                        if (line) {
                            emit({
                                type: 'step.shell_line',
                                taskId: ctx.taskId,
                                workspaceId: ctx.workspaceId,
                                label,
                                line,
                                ts: Date.now(),
                            })
                        }
                    }

                    if (label === 'test') {
                        for (const { pass, name, detail } of parseTestOutput(combined)) {
                            emit({
                                type: 'step.test_result',
                                taskId: ctx.taskId,
                                workspaceId: ctx.workspaceId,
                                pass,
                                name,
                                detail,
                                ts: Date.now(),
                            })
                        }
                    }
                }

                if (result.status !== 0) {
                    const detail = combined || (result.error?.message ?? ('exit code ' + String(result.status)))
                    return `ERROR: ${detail.slice(0, 2000)}`
                }
                return (result.stdout ?? '').trim()
            } catch (e) {
                const err = e as { stdout?: string; stderr?: string; message: string }
                const stderr = err.stderr?.trim() ?? ''
                const stdout = err.stdout?.trim() ?? ''
                const detail = stderr || stdout || err.message
                return `ERROR: ${detail.slice(0, 2000)}`
            }
        }


        case 'task_complete': {
            return JSON.stringify({ done: true, summary: input.summary, qualityScore: input.qualityScore })
        }

        default:
            return `ERROR: Unknown tool "${name}"`
    }
}

// ── Vercel AI SDK tool definitions (AI SDK v6 format) ────────────────────────
// Tool.inputSchema replaces "parameters" from earlier SDK versions.

function buildTools(ctx: ExecutionContext) {
    return {
        read_file: tool({
            description: 'Read the contents of a file at the given path.',
            inputSchema: z.object({
                path: z.string().describe('Absolute or repo-relative path to read'),
            }),
            execute: async (input) => dispatchTool('read_file', input as Record<string, unknown>, ctx),
        }),
        write_file: tool({
            description: 'Write content to a file. Creates the file if it does not exist.',
            inputSchema: z.object({
                path: z.string().describe('Path to write to'),
                content: z.string().describe('Full file content to write'),
            }),
            execute: async (input) => dispatchTool('write_file', input as Record<string, unknown>, ctx),
        }),
        shell: tool({
            description: 'Run a shell command. Avoid destructive operations; prefer reads first.',
            inputSchema: z.object({
                command: z.string().describe('Shell command to execute'),
                cwd: z.string().optional().describe('Working directory (optional)'),
            }),
            execute: async (input) => dispatchTool('shell', input as Record<string, unknown>, ctx),
        }),
        task_complete: tool({
            description: 'Signal that all steps are done and provide a summary of the outcome.',
            inputSchema: z.object({
                summary: z.string().describe('What was accomplished'),
                qualityScore: z.number().min(0).max(1).describe('0.0–1.0 self-assessment score'),
            }),
            execute: async (input) =>
                dispatchTool('task_complete', input as Record<string, unknown>, ctx),
        }),
        // write_asset — writes to /tmp (always) and uploads to S3/MinIO when STORAGE_* is configured.
        // The tasks/:id/assets API reads from /tmp; S3 URL is returned so the agent can surface it.
        write_asset: tool({
            description: 'Save a completed deliverable (document, script, HTML, email copy, etc.) as a named asset file. Use this for any output the user should receive.',
            inputSchema: z.object({
                filename: z.string().describe('Filename with extension, e.g. email-sequence.md'),
                content: z.string().describe('Full file content'),
                mimeType: z.string().optional().default('text/plain').describe('MIME type'),
            }),
            execute: async (input) => {
                const { mkdirSync, writeFileSync } = await import('node:fs')
                const { join } = await import('node:path')
                // Always write to /tmp (tasks/:id/assets API reads from here)
                const dir = `/tmp/plexo-assets/${ctx.taskId}`
                mkdirSync(dir, { recursive: true })
                const filePath = join(dir, input.filename as string)
                writeFileSync(filePath, input.content as string, 'utf8')
                // Upload to S3/MinIO when configured (opportunistic — never blocks on failure)
                let storageUrl: string | null = null
                const storageEndpoint = process.env.STORAGE_ENDPOINT
                const storageKey = process.env.STORAGE_ACCESS_KEY
                const storageSecret = process.env.STORAGE_SECRET_KEY
                if (storageEndpoint && storageKey && storageSecret) {
                    try {
                        const { uploadContent } = await import('@plexo/storage')
                        const result = await uploadContent({
                            taskId: ctx.taskId,
                            filename: input.filename as string,
                            content: input.content as string,
                            contentType: input.mimeType as string,
                        })
                        storageUrl = result.url
                    } catch { /* non-fatal — /tmp path still served by assets API */ }
                }
                // Persist to DB (Phase 4)
                try {
                    const ext = (input.filename as string).split('.').pop()?.toLowerCase() || ''
                    const type = 
                        ['md', 'markdown', 'mdx'].includes(ext) ? 'markdown' :
                        ['js', 'ts', 'tsx', 'py', 'go', 'rs', 'c', 'cpp', 'java'].includes(ext) ? 'code' :
                        ['mermaid', 'mmd'].includes(ext) ? 'diagram' :
                        ext === 'html' ? 'html' :
                        ['png', 'jpg', 'jpeg', 'svg', 'gif'].includes(ext) ? 'image' : 'file'

                    const [existing] = await db.select()
                        .from(artifacts)
                        .where(
                            and(
                                eq(artifacts.workspaceId, ctx.workspaceId),
                                ctx.sprintId ? eq(artifacts.projectId, ctx.sprintId) : eq(artifacts.taskId, ctx.taskId),
                                eq(artifacts.filename, input.filename as string)
                            )
                        )
                        .limit(1)

                    if (existing) {
                        const newVersion = existing.currentVersion + 1
                        await db.transaction(async (tx) => {
                            await tx.update(artifacts)
                                .set({ currentVersion: newVersion, updatedAt: new Date() })
                                .where(eq(artifacts.id, existing.id))
                            
                            await tx.insert(artifactVersions).values({
                                artifactId: existing.id,
                                version: newVersion,
                                content: input.content as string,
                                changeDescription: 'Updated by agent',
                            })
                        })
                    } else {
                        const artifactId = ulid()
                        await db.transaction(async (tx) => {
                            await tx.insert(artifacts).values({
                                id: artifactId,
                                workspaceId: ctx.workspaceId,
                                taskId: ctx.taskId,
                                projectId: ctx.sprintId ?? null,
                                filename: input.filename as string,
                                type,
                                currentVersion: 1,
                            })

                            await tx.insert(artifactVersions).values({
                                artifactId,
                                version: 1,
                                content: input.content as string,
                                changeDescription: 'Initial creation',
                            })
                        })
                    }
                } catch (dbErr) {
                    console.error('Failed to persist artifact to DB:', dbErr)
                }

                const note = storageUrl ? ` | S3: ${storageUrl}` : ''
                return `Asset saved: ${filePath} (${(input.content as string).length} bytes)${note}`
            },
        }),
        web_fetch: tool({
            description: 'Fetch the text content of a URL. Returns the response body as a string. Use for reading documentation, APIs, web pages, JSON endpoints, or any public URL.',
            inputSchema: z.object({
                url: z.string().url().describe('The URL to fetch'),
                method: z.enum(['GET', 'POST']).optional().default('GET').describe('HTTP method'),
                body: z.string().optional().describe('Request body for POST requests (JSON string)'),
                headers: z.record(z.string()).optional().describe('Additional request headers'),
            }),
            execute: async ({ url, method = 'GET', body, headers = {} }) => {
                try {
                    const opts: RequestInit = {
                        method,
                        headers: { 'User-Agent': 'Plexo-Agent/1.0', ...headers },
                        signal: AbortSignal.timeout(30_000),
                    }
                    if (body && method === 'POST') {
                        opts.body = body
                        ;(opts.headers as Record<string, string>)['Content-Type'] = 'application/json'
                    }
                    const res = await fetch(url, opts)
                    const text = await res.text()
                    // Truncate very large responses to avoid context overflow
                    const truncated = text.length > 50_000 ? text.slice(0, 50_000) + '\n\n[Response truncated at 50k chars]' : text
                    return `HTTP ${res.status} ${res.statusText}\n\n${truncated}`
                } catch (err) {
                    return `ERROR: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),
        web_search: tool({
            description: 'Search the web using DuckDuckGo Instant Answer API. Returns a summary, abstract URL, and related topics. Not a full web crawler — best for factual lookups, definitions, and quick research.',
            inputSchema: z.object({
                query: z.string().describe('Search query'),
                region: z.string().optional().default('wt-wt').describe('Region code, e.g. us-en, gb-en'),
            }),
            execute: async ({ query, region = 'wt-wt' }) => {
                try {
                    const params = new URLSearchParams({
                        q: query,
                        format: 'json',
                        no_redirect: '1',
                        no_html: '1',
                        skip_disambig: '1',
                        kl: region,
                    })
                    const res = await fetch(`https://api.duckduckgo.com/?${params}`, {
                        headers: { 'User-Agent': 'Plexo-Agent/1.0' },
                        signal: AbortSignal.timeout(15_000),
                    })
                    const data = await res.json() as {
                        Heading?: string
                        AbstractText?: string
                        AbstractURL?: string
                        Answer?: string
                        RelatedTopics?: Array<{ Text?: string; FirstURL?: string } | { Topics?: Array<{ Text?: string; FirstURL?: string }> }>
                    }
                    const lines: string[] = []
                    if (data.Answer) lines.push(`Answer: ${data.Answer}`)
                    if (data.Heading) lines.push(`Topic: ${data.Heading}`)
                    if (data.AbstractText) lines.push(`Summary: ${data.AbstractText}`)
                    if (data.AbstractURL) lines.push(`Source: ${data.AbstractURL}`)
                    type DDGTopic = { Text?: string; FirstURL?: string }
                    const related = (data.RelatedTopics ?? [])
                        .flatMap((t): DDGTopic[] => 'Topics' in t ? (t.Topics ?? []) : [t as DDGTopic])
                        .slice(0, 5)
                        .map((t) => `- ${t.Text ?? ''} (${t.FirstURL ?? ''})`)
                    if (related.length > 0) lines.push('\nRelated:\n' + related.join('\n'))
                    return lines.length > 0 ? lines.join('\n') : 'No results found for this query.'
                } catch (err) {
                    return `ERROR: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),
        self_reflect: tool({
            description: 'Query your own runtime state. Returns your active model, installed connections, available tools, memory statistics, cost position, and safety limits. Call this when asked about your capabilities, identity, architecture, or configuration, or when you need to verify what tools/connections are available before attempting a task.',
            inputSchema: z.object({
                focus: z.enum(['all', 'identity', 'tools', 'connections', 'memory', 'cost', 'safety'])
                    .optional()
                    .default('all')
                    .describe('Which section to return. Use "identity" for model/provider info, "tools" for available tools, "connections" for installed integrations, "memory" for memory stats, "cost" for usage/budget, "safety" for safety limits, "all" for everything.'),
            }),
            execute: async ({ focus }) => {
                const { buildIntrospectionSnapshot } = await import('../introspection/index.js')
                const snapshot = await buildIntrospectionSnapshot(
                    ctx.workspaceId,
                    ctx.activeProvider,
                    ctx.activeModel,
                )
                const sections = {
                    identity: {
                        agentName: snapshot.agentName,
                        agentPersona: snapshot.agentPersona,
                        agentTagline: snapshot.agentTagline,
                        activeProvider: snapshot.activeProvider,
                        activeModel: snapshot.activeModel,
                        primaryProvider: snapshot.primaryProvider,
                        fallbackChain: snapshot.fallbackChain,
                        build: snapshot.build,
                    },
                    tools: {
                        builtinTools: snapshot.builtinTools,
                        connectionTools: snapshot.connections.flatMap((c) => c.tools),
                        pluginTools: snapshot.plugins.flatMap((p) => p.tools),
                        all: [
                            ...snapshot.builtinTools,
                            ...snapshot.connections.flatMap((c) => c.tools),
                            ...snapshot.plugins.flatMap((p) => p.tools),
                        ],
                    },
                    connections: snapshot.connections,
                    memory: snapshot.memory,
                    cost: snapshot.cost,
                    safety: snapshot.safety,
                }
                if (focus === 'all') return JSON.stringify(snapshot, null, 2)
                const section = sections[focus as keyof typeof sections]
                return section ? JSON.stringify(section, null, 2) : JSON.stringify(snapshot, null, 2)
            },
        }),
        web_screenshot: tool({
            description: 'Capture a screenshot of a URL using headless Chrome. Use this to "see" what a website looks like, verify UI changes, or capture visual content. The image is saved as an asset and its path is returned. Best for verifying that a web page rendered correctly or capturing a snapshot of a dashboard/report.',
            inputSchema: z.object({
                url: z.string().url().describe('The URL to screenshot'),
                fullPage: z.boolean().optional().default(false).describe('Whether to capture the full page or just the initial viewport (default: false). Full page captures might be very large.'),
                width: z.number().optional().default(1280).describe('Browser window width (default: 1280)'),
                height: z.number().optional().default(720).describe('Browser window height (default: 720)'),
            }),
            execute: async ({ url, fullPage, width = 1280, height = 720 }) => {
                const filename = `screenshot_${ulid()}.png`
                const assetDir = `/tmp/plexo-assets/${ctx.taskId}`
                const filePath = join(assetDir, filename)
                
                try {
                    const { spawnSync } = await import('node:child_process')
                    const { mkdirSync, existsSync } = await import('node:fs')
                    
                    mkdirSync(assetDir, { recursive: true })
                    const args = [
                        '--headless',
                        '--no-sandbox',
                        '--disable-gpu',
                        `--window-size=${width},${height}`,
                        `--screenshot=${filePath}`,
                        url
                    ]
                    
                    const res = spawnSync('google-chrome', args, { timeout: 30000 })
                    
                    if (res.error) throw res.error
                    if (res.status !== 0) {
                        return `Screenshot failed (exit code ${res.status}): ${res.stderr?.toString() || 'unknown error'}`
                    }

                    if (!existsSync(filePath)) {
                        return `Screenshot failed: Output file ${filePath} was not created.`
                    }

                    return `Screenshot saved as asset: ${filename}\nView it at: /api/v1/tasks/${ctx.taskId}/assets/${filename}`
                } catch (err) {
                    return `ERROR: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),
        image_search: tool({
            description: 'Search for images on the web. Returns a list of image URLs and their sources. Use this to find visual examples, icons, or specific images requested by the user.',
            inputSchema: z.object({
                query: z.string().describe('The image search query'),
            }),
            execute: async ({ query }) => {
                try {
                    // We use DuckDuckGo's "i.js" API or similar scraping approach.
                    // For maximum reliability in this environment, we'll try to fetch the HTML and extract image links.
                    const res = await fetch(`https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=isch`, {
                        headers: { 
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' 
                        },
                        signal: AbortSignal.timeout(15000)
                    })
                    const html = await res.text()
                    
                    // Basic regex to find image URLs in the result. 
                    // This is a simplified extraction of high-res image patterns.
                    const matches = html.matchAll(/https:\/\/[^"']+\.(png|jpg|jpeg|gif|webp)/gi)
                    const urls = Array.from(new Set(Array.from(matches).map(m => m[0])))
                        .filter(u => !u.includes('gstatic.com')) // skip icons
                        .slice(0, 8)
                    
                    if (urls.length === 0) {
                        return 'No images found for this query.'
                    }

                    return `Found ${urls.length} images for "${query}":\n\n` + 
                        urls.map((u, i) => `${i+1}. ![Image ${i+1}](${u})\nSource: ${u}`).join('\n\n')
                } catch (err) {
                    return `ERROR: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),
        // ── Interactive browser automation (Playwright) ─────────────
        ...buildBrowserTools({
            taskId: ctx.taskId,
            workspaceId: ctx.workspaceId,
            emitStepEvent: ctx.emitStepEvent,
        }),
    }
}

// ── Default workspace AI settings (legacy / no-config mode) ─────────────────

function defaultSettings(): WorkspaceAISettings {
    return {
        primaryProvider: 'anthropic',
        fallbackChain: [],
        providers: {
            anthropic: { provider: 'anthropic' },
        },
    }
}

// ── Executor ──────────────────────────────────────────────────────────────────

export async function executeTask(
    ctx: ExecutionContext,
    plan: ExecutionPlan,
    aiSettings?: WorkspaceAISettings,
): Promise<ExecutionResult> {
    const settings = aiSettings ?? defaultSettings()
    const startTime = Date.now()
    const stepResults: StepResult[] = []

    let totalTokensIn = 0
    let totalTokensOut = 0
    let totalCost = 0
    let finalSummary = ''
    let finalQuality = 0.5

    // ── One-Way Door gate (§8.4 approval protocol) ───────────────────────────
    // If the plan flags irreversible operations, request approval before running.
    const owdList = plan.oneWayDoors ?? []
    if (owdList.length > 0) {
        try {
            const owdDescriptions = owdList.map((d) => `• [${d.type}] ${d.description}`).join('\n')
            const approval = await requestApproval({
                taskId: ctx.taskId,
                workspaceId: ctx.workspaceId,
                operation: owdList[0]?.type ?? 'unknown',
                description: `This task requires approval for ${owdList.length} irreversible operation(s):\n${owdDescriptions}`,
                riskLevel: owdList.some((d) => d.type === 'data_write' || d.type === 'schema_migration') ? 'high' : 'medium',
            })

            // Pause — notify via SSE will come from the SSE route watching Redis
            const decision = await waitForDecision(approval.id, 30 * 60 * 1000) // 30 min

            if (decision === 'rejected') {
                return {
                    taskId: ctx.taskId,
                    ok: false,
                    error: 'Task rejected by operator (one-way door gate)',
                    errorCode: 'OWD_REJECTED',
                    steps: [],
                    outcomeSummary: '',
                    qualityScore: 0,
                    totalDurationMs: Date.now() - startTime,
                    totalTokensIn: 0,
                    totalTokensOut: 0,
                    totalCostUsd: 0,
                }
            }

            if (decision === 'timeout') {
                return {
                    taskId: ctx.taskId,
                    ok: false,
                    error: 'Task approval timed out (one-way door gate) — resubmit to retry',
                    errorCode: 'OWD_TIMEOUT',
                    steps: [],
                    outcomeSummary: '',
                    qualityScore: 0,
                    totalDurationMs: Date.now() - startTime,
                    totalTokensIn: 0,
                    totalTokensOut: 0,
                    totalCostUsd: 0,
                }
            }
            // approved — fall through to execution
        } catch (owdErr) {
            // OWD service unavailable — log and continue (non-blocking in dev)
            import('pino').then(({ default: pino }) =>
                pino({ name: 'executor' }).warn({ err: owdErr }, 'OWD gate failed non-fatally — proceeding'),
            ).catch(() => { })
        }
    }

    // ── Phase A: Use context already loaded by agent-loop ────────────────────────
    // agent-loop.ts loads these from DB before building ExecutionContext.
    // We only fall back to DB here if fields are missing (direct executor calls in tests).
    let agentName = ctx.agentName ?? 'Plexo'
    let personaPrefix = ctx.agentPersona ? ctx.agentPersona + '\n\n' : ''
    let systemPromptExtra = ''
    if (!ctx.agentName) {
        // Direct call path (tests/sprint runner) — load from DB as before
        try {
            const { workspaces } = await import('@plexo/db')
            const { db: dbInst, eq: eqFn } = await import('@plexo/db')
            const [ws] = await dbInst.select({ settings: workspaces.settings }).from(workspaces)
                .where(eqFn(workspaces.id, ctx.workspaceId)).limit(1)
            if (ws?.settings) {
                const s = ws.settings as Record<string, unknown>
                if (typeof s.agentName === 'string' && s.agentName) agentName = s.agentName
                if (typeof s.agentPersona === 'string' && s.agentPersona) personaPrefix = s.agentPersona + '\n\n'
                if (typeof s.systemPromptExtra === 'string' && s.systemPromptExtra) systemPromptExtra = '\n\n' + s.systemPromptExtra
            }
        } catch { /* non-fatal */ }
    }

    // ── Phase B: Read prior memory + apply user preferences ──────────────────
    let memoryBlock = ''
    let preferencesBlock = ''
    try {
        const priorMemory = await searchMemory({
            workspaceId: ctx.workspaceId,
            query: plan.goal,
            limit: 3,
        })
        if (priorMemory.length > 0) {
            const entries = priorMemory
                .map((m) => `- ${m.shorthand || m.content.split('\n').slice(0, 3).join(' | ')}`)
                .join('\n')
            memoryBlock = `\n\nPRIOR WORK CONTEXT (from memory):\n${entries}`
        }
    } catch { /* non-fatal */ }

    try {
        const { resolveBehavior } = await import('../behavior/resolver.js')
        const { compileBehavior } = await import('../behavior/compiler.js')
        
        // resolveBehavior handles workspace + optional project inheritance
        const resolvedRules = await resolveBehavior(ctx.workspaceId)
        const compiledRules = compileBehavior(resolvedRules.rules)
        
        if (compiledRules) {
            preferencesBlock = `\n\nWORKSPACE RULES (always follow these):\n${compiledRules}`
        }
    } catch { /* non-fatal */ }

    // ── Phase D: Capability manifest in executor prompt ──────────────────
    let capabilityBlock = ''
    try {
        const manifest = await buildCapabilityManifest(ctx.workspaceId)
        capabilityBlock = '\n\n' + manifestToPromptBlock(manifest)
    } catch { /* non-fatal */ }

    // ── Phase E: Extension prompts + context (Kapsel §7.6/§7.7) ─────────
    let extensionPromptsBlock = ''
    let extensionContextBlock = ''
    try {
        const { extensionPrompts: epTable, extensionContexts: ecTable } = await import('@plexo/db')
        const { db: dbInst, eq: eqFn, and: andFn, isNull: isNullFn } = await import('@plexo/db')

        // §7.6: Load enabled extension prompts and resolve variables
        const enabledPrompts = await dbInst
            .select()
            .from(epTable)
            .where(andFn(
                eqFn(epTable.workspaceId, ctx.workspaceId),
                eqFn(epTable.enabled, true),
                isNullFn(epTable.deletedAt),
            ))
            .orderBy(epTable.priority, epTable.extensionName)

        if (enabledPrompts.length > 0) {
            const resolved = enabledPrompts.map((p) => {
                const defaults = (p.variableDefaults ?? {}) as Record<string, unknown>
                const schema = (p.variables ?? []) as Array<{ name: string; default?: unknown }>
                let text = p.template
                for (const v of schema) {
                    const val = String(defaults[v.name] ?? v.default ?? '')
                    text = text.replaceAll(`{{${v.name}}}`, val)
                }
                return `[Prompt from ${p.extensionName}: ${p.name}]\n${text}`
            })
            extensionPromptsBlock = `\n\nEXTENSION PROMPTS:\n${resolved.join('\n\n')}`
        }

        // §7.7: Load active context blocks (not expired, enabled, sorted by priority)
        const contextRows = await dbInst
            .select()
            .from(ecTable)
            .where(andFn(
                eqFn(ecTable.workspaceId, ctx.workspaceId),
                eqFn(ecTable.enabled, true),
                isNullFn(ecTable.deletedAt),
            ))
            .orderBy(ecTable.priority, ecTable.extensionName)

        if (contextRows.length > 0) {
            const now = Date.now()
            // Filter expired, apply token budget (40% of 128k = ~51,200 tokens for extensions)
            const TOKEN_BUDGET = 51200
            const PER_EXT_CAP = TOKEN_BUDGET * 0.25
            let totalTokens = 0
            const extTokens: Record<string, number> = {}
            const blocks: string[] = []

            for (const c of contextRows) {
                // TTL check
                if (c.ttl != null && c.lastRefreshedAt != null) {
                    const age = (now - new Date(c.lastRefreshedAt).getTime()) / 1000
                    if (age > c.ttl) continue // expired
                }
                const tokens = c.estimatedTokens ?? Math.ceil(c.content.length / 4)
                const extKey = c.extensionName
                extTokens[extKey] = (extTokens[extKey] ?? 0) + tokens
                // Per-extension cap
                if (extTokens[extKey]! > PER_EXT_CAP) {
                    blocks.push(`[Context evicted: ${c.name} — per-extension token cap exceeded]`)
                    continue
                }
                // Total budget check
                if (totalTokens + tokens > TOKEN_BUDGET) {
                    blocks.push(`[Context evicted: ${c.name} — token budget exceeded]`)
                    continue
                }
                totalTokens += tokens
                blocks.push(`[Context from ${c.extensionName}: ${c.name}]\n${c.content}`)
            }

            if (blocks.length > 0) {
                extensionContextBlock = `\n\nEXTENSION CONTEXT:\n${blocks.join('\n\n')}`
            }
        }
    } catch { /* non-fatal — extension prompts/context are additive only */ }

    // A/B variant assignment — assigns control (A) or challenger (B) prompt
    // so the self-improvement loop can measure the effect of prompt patches.
    let variantAssignment: Awaited<ReturnType<typeof assignVariant>> = {
        variant: 'A',
        challengerId: null,
        overrides: {},
    }
    try {
        variantAssignment = await assignVariant(ctx.workspaceId)
    } catch { /* non-fatal */ }

    const variantExtra = Object.entries(variantAssignment.overrides)
        .map(([k, v]) => `\n\n[${k.replace(/_/g, ' ')}]\n${v}`)
        .join('')

    const sprintCodingBlock = ctx.sprintWorkDir
        ? `

SPRINT CODING CONTEXT:
- Repository: ${ctx.sprintRepo ?? 'unknown'}
- Branch: ${ctx.sprintBranch ?? 'unknown'}
- Working directory (pre-cloned): ${ctx.sprintWorkDir}

MANDATORY WORKFLOW — follow this exactly:
1. Read relevant files with read_file or shell("cat <path>") to understand the codebase.
2. Make changes with write_file. Follow all WORKSPACE RULES exactly.
3. Run \`pnpm typecheck\` (or the repo's lint/test command) with shell() to verify correctness.
4. Configure git identity:
   shell("git config user.email 'agent@plexo.ai' && git config user.name 'Plexo Agent'")
5. Stage, commit, and push your changes:
   shell("git add -A && git commit -m '<concise description>' && git push origin ${ctx.sprintBranch ?? 'HEAD'}")
6. ONLY THEN call task_complete.

CRITICAL: You MUST push at least one commit before calling task_complete.
If you call task_complete without pushing, no PR can be opened and your work is lost.
If typecheck fails, fix the errors before pushing — do not push broken code.
Do NOT push to main. Your branch is: ${ctx.sprintBranch ?? 'your assigned branch'}.`
        : ''

    // identityLine is built after router resolution (below) so it reflects the actual model used.

    const planSummary = plan.steps
        .map((s) => `Step ${s.stepNumber}: ${s.description}`)
        .join('\n')

    const userMessage = `Execute this plan:\n\n${planSummary}\n\nBegin with step 1.`

    if (ctx.signal.aborted) {
        throw new PlexoError('Task cancelled', 'TASK_CANCELLED', 'user', 499)
    }

    const stepStart = Date.now()

    const connectionTools = await loadConnectionTools(ctx.workspaceId)
    const pluginTools = await loadPluginTools(ctx.workspaceId)
    const allTools = { ...buildTools(ctx), ...connectionTools, ...pluginTools }

    // Per-task pre-flight: block if already at task ceiling from prior retries
    if (ctx.taskCostCeilingUsd != null && totalCost >= ctx.taskCostCeilingUsd) {
        throw new PlexoError(
            `Task cost ceiling reached: $${totalCost.toFixed(4)} >= $${ctx.taskCostCeilingUsd.toFixed(4)}`,
            'TASK_COST_CEILING',
            'system',
            429,
        )
    }

    // ── Model resolution via IntelligentRouter ──────────────────────────────────
    // Inject per-task model override if specified in execution context
    const effectiveSettings: WorkspaceAISettings = ctx.modelOverrideId
        ? {
            ...settings,
            inferenceMode: 'override',
            modelOverrides: {
                ...(settings.modelOverrides ?? {}),
                // Apply to the actual task type being executed
                codeGeneration: ctx.modelOverrideId,
                planning: ctx.modelOverrideId,
                verification: ctx.modelOverrideId,
                summarization: ctx.modelOverrideId,
                classification: ctx.modelOverrideId,
                logAnalysis: ctx.modelOverrideId,
            }
        }
        : settings

    const { model: resolvedModel, meta: resolvedMeta } = await resolveModel(
        'codeGeneration',
        effectiveSettings,
        ctx.workspaceId,
    ).catch(async () => {
        // Router failure (e.g. empty models_knowledge table) — fall back to BYOK
        const fallbackModel = await withFallback(settings, 'codeGeneration', async (m) => m)
        return { model: fallbackModel, meta: { id: 'unknown', provider: settings.primaryProvider as import('../providers/registry.js').ProviderKey, mode: 'byok' as import('../providers/router.js').InferenceMode, costPerMIn: 3, costPerMOut: 15 } }
    })

    if (ctx.sprintId) {
        import('../sprint/logger.js').then(({ logSprintEvent }) => {
            logSprintEvent({
                sprintId: ctx.sprintId!,
                level: 'info',
                event: 'routing_trace',
                message: `Task routed to ${resolvedMeta.provider}/${resolvedMeta.id} (mode: ${resolvedMeta.mode})`,
                metadata: {
                    taskType: 'codeGeneration',
                    mode: resolvedMeta.mode,
                    provider: resolvedMeta.provider,
                    modelId: resolvedMeta.id,
                    costPerMIn: resolvedMeta.costPerMIn,
                    costPerMOut: resolvedMeta.costPerMOut,
                }
            }).catch(() => {})
        })
    }

    const identityLine = `Identity: running on ${resolvedMeta.provider} / ${resolvedMeta.id}. If asked what model, provider, or system you are, call self_reflect({focus:"identity"}) to get the accurate, live answer rather than guessing.`

    const browsingBlock = `
WEB BROWSING & BROWSER AUTOMATION:
You can search, read, and INTERACT with the public web.
- Call web_search for factual lookups, identifying current events, or finding documentation URLs.
- Call web_fetch to read the content of a specific URL (documentation, blog posts, news, APIs).
- Use browser_navigate, browser_click, browser_type, browser_select, browser_extract, browser_screenshot, browser_eval, browser_wait to INTERACT with websites — fill forms, click buttons, navigate multi-step flows, create accounts, post content, etc.
- The browser tools use a full headless Chromium instance. You can perform any web workflow a human could.
- Use browser_screenshot to verify page state visually when needed.
- For simple content reading, prefer web_fetch. For interactive workflows (forms, multi-page flows), use browser_* tools.`

    const selfExtensionBlock = `

SELF-EXTENSION CAPABILITY:
You can generate new skills and connections for any external service on demand.
Call synthesize_kapsel_skill when:
- The user asks you to connect to a service with no installed skill or connector
- The user asks you to "add support for X", "build a tool for X", or "integrate with X"
The tool handles everything: API research, code generation, disk storage, connection
registration, and auto-activation. After a successful synthesis, tell the user:
"[Service] skill is now active. Go to Connections → [Service] to enter your API key."
Never attempt to synthesize for already-installed services — check self_reflect first.`

    const systemPrompt = `${personaPrefix}You are ${agentName}, an autonomous AI agent executing a task.
${identityLine}
${ctx.workspaceName ? `\nWorkspace: ${ctx.workspaceName}` : ''}${ctx.workspaceSummary ? `\nWorkspace purpose: ${ctx.workspaceSummary}` : ''}${ctx.sprintGoal ? `\nActive project goal: ${ctx.sprintGoal}` : ''}${sprintCodingBlock}

Task goal: ${plan.goal}

You have ${plan.steps.length} planned steps. Work through them carefully.
- Use tools to make progress. Read before writing.
- Use write_asset to save any deliverable the user should receive (documents, scripts, email copy, HTML, etc.).
- When you have completed all steps, call task_complete.
- Be conservative. If something seems wrong, stop and report it.
- NEVER output credentials, secrets, or tokens in logs or public-facing messages. However, when a task explicitly asks you to create accounts and report back credentials, you MUST include them in the write_asset deliverable or task_complete summary so the operator receives them. The operator handles secure storage.${
    // For non-coding sprint tasks: write_asset is MANDATORY, not optional.
    // Without it, output only exists in outcomeSummary (1-3 sentences) and is invisible to the user.
    !ctx.sprintWorkDir && ['research', 'writing', 'ops', 'data', 'marketing', 'general', 'automation', 'report'].includes(ctx.taskType)
        ? `

MANDATORY OUTPUT REQUIREMENT: You MUST call write_asset at least once before calling task_complete.
- Every significant output (report, plan, analysis, document, script, email copy, etc.) must be saved as a file using write_asset.
- Do NOT put your primary deliverable only in the task_complete summary — the summary is a 1-3 sentence description, not the actual output.
- If you research and synthesize information, write the full findings to a .md file via write_asset.
- If you write copy, scripts, or plans, save them as appropriately-named files via write_asset.
- Only call task_complete AFTER you have called write_asset at least once with the actual deliverable.`
        : ''
}${capabilityBlock}${browsingBlock}${selfExtensionBlock}${preferencesBlock}${extensionPromptsBlock}${memoryBlock}${extensionContextBlock}${systemPromptExtra}${variantExtra}`

    const genResult = await (async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK message types vary between versions
        let messages: any[] = [{ role: 'user', content: userMessage }]
        let retries = 0
        let accumulatedUsage = { inputTokens: 0, outputTokens: 0 }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let accumulatedSteps: any[] = []
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let lastResult: any

        // Stall detection state
        let lastProgressToolCount = 0
        let lastProgressTime = Date.now()

        while (retries < SAFETY_LIMITS.maxRetries) {
            const result = await generateText({
                model: resolvedModel,
                system: systemPrompt,
                messages,
                tools: allTools,
                // tokenBudget > 0: cap output tokens. 0 or null = no per-task cap.
                ...(ctx.tokenBudget && ctx.tokenBudget > 0 ? { maxTokens: ctx.tokenBudget } : {}),
                stopWhen: stepCountIs(SAFETY_LIMITS.maxConsecutiveToolCalls),
                abortSignal: ctx.signal,
            })

            const inToks = result.usage.inputTokens ?? 0
            const outToks = result.usage.outputTokens ?? 0
            accumulatedUsage.inputTokens += inToks
            accumulatedUsage.outputTokens += outToks
            accumulatedSteps = accumulatedSteps.concat(result.steps)

            // Progress tracking: count total meaningful tool calls (exclude no-ops)
            const totalToolCalls = accumulatedSteps.reduce(
                (n, s) => n + (s.toolCalls?.length ?? 0), 0
            )

            if (totalToolCalls > lastProgressToolCount) {
                lastProgressToolCount = totalToolCalls
                lastProgressTime = Date.now()
            }

            // Stall detection: no new tool calls produced in stallWindowMs → likely stuck
            const stallDuration = Date.now() - lastProgressTime
            if (stallDuration > SAFETY_LIMITS.stallWindowMs) {
                throw new PlexoError(
                    `Task stalled: no progress for ${Math.round(stallDuration / 60_000)} minutes (${totalToolCalls} total tool calls). Goal: ${plan.goal}`,
                    'TASK_STALLED',
                    'system',
                    500,
                )
            }

            // Absolute ceiling — catch-all for runaway tasks
            if (Date.now() - startTime > SAFETY_LIMITS.maxWallClockMs) {
                throw new PlexoError(
                    `Absolute time ceiling reached (${Math.round(SAFETY_LIMITS.maxWallClockMs / 3_600_000)}h). Task was making progress but exceeded maximum allowed duration.`,
                    'WALL_CLOCK_EXCEEDED',
                    'system',
                    500,
                )
            }

            const hasComplete = result.steps.some(s => s.toolCalls.some(tc => tc.toolName === 'task_complete'))
            if (hasComplete) {
                lastResult = result
                break
            }

            retries++
            if (retries >= SAFETY_LIMITS.maxRetries) {
                throw new LogicError(`Model failed to complete the task: ${SAFETY_LIMITS.maxRetries} continuations without calling task_complete.`)
            }

            messages = messages.concat(result.response.messages)
            messages.push({
                role: 'user',
                content: 'Evaluator Error: You stopped without finalizing the task. Please reflect on your previous steps and errors, then continue to complete the objective.'
            })
        }

        return {
            ...lastResult,
            usage: accumulatedUsage,
            steps: accumulatedSteps,
            text: lastResult?.text ?? '',
        }
    })()

    // AI SDK v6: usage.inputTokens / usage.outputTokens
    const tokensIn = genResult.usage.inputTokens ?? 0
    const tokensOut = genResult.usage.outputTokens ?? 0

    // Cost calculation: use real pricing from router meta when available, else fall back to claude-sonnet-4-5 rates
    const costPerMIn = resolvedMeta.costPerMIn > 0 ? resolvedMeta.costPerMIn : 3
    const costPerMOut = resolvedMeta.costPerMOut > 0 ? resolvedMeta.costPerMOut : 15
    const costUsd = (tokensIn / 1_000_000) * costPerMIn + (tokensOut / 1_000_000) * costPerMOut
    totalTokensIn += tokensIn
    totalTokensOut += tokensOut
    totalCost += costUsd

    // Per-task cost ceiling check (mid-run, after accumulation)
    if (ctx.taskCostCeilingUsd != null && totalCost >= ctx.taskCostCeilingUsd) {
        throw new PlexoError(
            `Task cost ceiling reached: $${totalCost.toFixed(4)} >= $${ctx.taskCostCeilingUsd.toFixed(4)}`,
            'TASK_COST_CEILING',
            'system',
            429,
        )
    }

    // Workspace weekly ceiling check
    if (totalCost > (Number(process.env.API_COST_CEILING_USD) || 10)) {
        throw new PlexoError(
            `Workspace weekly cost ceiling reached: $${totalCost.toFixed(4)}`,
            'COST_CEILING_REACHED',
            'system',
            429,
        )
    }

    // AI SDK v6: toolCalls[].input (not .args), toolResults[].output (not .result)
    const toolCallRecords: StepResult['toolCalls'] = []
    for (const step of genResult.steps) {
        for (const tc of step.toolCalls) {
            // TypedToolCall has .input in v6; DynamicToolCall also has .input
            const input = (tc as { input: unknown }).input as Record<string, unknown>
            const toolResult = step.toolResults.find((r: { toolCallId: string }) => r.toolCallId === tc.toolCallId)
            // TypedToolResult / DynamicToolResult have .output in v6
            const output = toolResult
                ? String((toolResult as { output: unknown }).output ?? '')
                : ''

            toolCallRecords.push({
                tool: tc.toolName,
                input,
                output,
            })

            if (tc.toolName === 'task_complete') {
                try {
                    const parsed = JSON.parse(output) as { summary: string; qualityScore: number }
                    finalSummary = parsed.summary
                    finalQuality = Math.min(1, Math.max(0, parsed.qualityScore))
                } catch {
                    finalSummary = output
                }
            }
        }
    }

    if (!finalSummary) {
        finalSummary = genResult.text || 'Agent stopped without calling task_complete'
    }

    const stepDurationMs = Date.now() - stepStart

    // Persist step record to DB — use real model ID from router meta
    await db.insert(taskSteps).values({
        taskId: ctx.taskId,
        stepNumber: 1,
        model: `${resolvedMeta.provider}/${resolvedMeta.id}`,
        tokensIn,
        tokensOut,
        toolCalls: toolCallRecords,
        outcome: finalSummary ? 'complete' : 'running',
    })

    stepResults.push({
        stepNumber: 1,
        ok: true,
        output: finalSummary,
        toolCalls: toolCallRecords,
        tokensIn,
        tokensOut,
        costUsd,
        durationMs: stepDurationMs,
    })

    // Independent quality judge — decoupled from self-assessment to prevent reward hacking.
    // Runs non-blocking post-execution; replaces finalQuality if successful.
    // Falls back to self-reported score on any failure.
    const judgeResult = await judgeQuality({
        taskType: ctx.taskType ?? 'coding',
        goal: plan.goal,
        deliverableSummary: finalSummary,
        toolsUsed: toolCallRecords.map((t) => t.tool),
        selfScore: finalQuality,
        aiSettings,
    }).catch(() => ({ score: finalQuality, meta: { mode: 'fallback' as const, selfScore: finalQuality, judgeCount: 0, dissenters: [], models: [] } }))

    const verifiedQuality = judgeResult.score
    const judgeMeta: JudgeMeta = judgeResult.meta

    const executionResult: ExecutionResult & { judgeMeta?: JudgeMeta } = {
        taskId: ctx.taskId,
        ok: true,
        steps: stepResults,
        outcomeSummary: finalSummary,
        qualityScore: verifiedQuality,
        totalTokensIn,
        totalTokensOut,
        totalCostUsd: totalCost,
        totalDurationMs: Date.now() - startTime,
        judgeMeta,
    }


    // NOTE: api_cost_tracking is written ONLY by agent-loop.ts after completeTask().
    // Do NOT write it here — doing so would double-count every task's spend.

    // Record task outcome to semantic memory + infer preferences (non-blocking)
    const toolsUsed = stepResults.flatMap((s) => s.toolCalls.map((t) => t.tool))
    const filesWritten = stepResults.flatMap((s) =>
        s.toolCalls
            .filter((t) => t.tool === 'write_file' || t.tool === 'create_file')
            .map((t) => String((t.input as Record<string, unknown>)?.path ?? ''))
            .filter(Boolean),
    )
    const memOutcome: 'success' | 'partial' | 'failure' = executionResult.ok
        ? verifiedQuality >= 0.7
            ? 'success'
            : 'partial'
        : 'failure'

    // Memory writes are non-blocking but we log failures so they're diagnosable.
    // Each concern is independent — one failure doesn't abort the others.
    const pinoMod = await import('pino')
    const memLogger = pinoMod.default({ name: 'executor.memory' })

    void import('../memory/store.js').then(({ recordTaskMemory }) =>
        recordTaskMemory({
            workspaceId: ctx.workspaceId,
            taskId: ctx.taskId,
            description: plan.goal,
            outcome: memOutcome,
            toolsUsed,
            qualityScore: verifiedQuality,
            durationMs: executionResult.totalDurationMs,
            aiSettings: settings,
        })
    ).catch((err) => memLogger.warn({ err, taskId: ctx.taskId }, 'recordTaskMemory failed'))

    void import('../memory/preferences.js').then(({ inferFromTaskOutcome }) =>
        inferFromTaskOutcome({
            workspaceId: ctx.workspaceId,
            toolsUsed,
            filesWritten,
            qualityScore: verifiedQuality,
            outcome: memOutcome,
        })
    ).catch((err) => memLogger.warn({ err, taskId: ctx.taskId }, 'inferFromTaskOutcome failed'))

    void db.execute(sql`
        INSERT INTO work_ledger
            (id, workspace_id, task_id, type, source, tokens_in, tokens_out, cost_usd,
             quality_score, deliverables, wall_clock_ms, completed_at)
        VALUES
            (gen_random_uuid(), ${ctx.workspaceId}::uuid, ${ctx.taskId},
             ${ctx.taskType ?? 'automation'}, ${'agent'},
             ${executionResult.totalTokensIn}, ${executionResult.totalTokensOut},
             ${executionResult.totalCostUsd}, ${verifiedQuality},
             ${JSON.stringify(filesWritten)}::jsonb, ${executionResult.totalDurationMs},
             now())
    `).catch((err) => memLogger.warn({ err, taskId: ctx.taskId }, 'work_ledger insert failed — check schema or migration'))

    // Phase 15 — record which prompt variant was used and evaluate auto-promotion
    void recordVariantOutcome({
        workspaceId: ctx.workspaceId,
        taskId: ctx.taskId,
        variant: variantAssignment.variant,
        challengerId: variantAssignment.challengerId,
        qualityScore: verifiedQuality,
    }).catch((err) => memLogger.warn({ err, taskId: ctx.taskId }, 'recordVariantOutcome failed'))

    // Clean up browser if it was used during this task
    await closeBrowser().catch(() => {})

    return executionResult
}
