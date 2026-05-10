// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Environment awareness tools — let the agent introspect what it's running on.
 *
 * These are read-only, safe-to-call, lightweight. Every execute() catches
 * all errors and returns a best-effort JSON payload. Never throws.
 *
 * Wired into both conversational (channel-ai) and task (executor) paths
 * so the agent can call them regardless of invocation surface.
 */

import { tool } from 'ai'
import { z } from 'zod'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { hostname, platform as osPlatform, arch as osArch, release as osRelease } from 'node:os'
import type { ToolSet } from '../connections/bridge.js'

// ── Helpers ────────────────────────────────────────────────────────────────

/** Try to find the repo root by walking up for package.json with name "plexo". */
function findRepoRoot(): string {
    try {
        let dir = process.cwd()
        for (let i = 0; i < 8; i++) {
            const pj = join(dir, 'package.json')
            if (existsSync(pj)) {
                try {
                    const parsed = JSON.parse(readFileSync(pj, 'utf8'))
                    if (parsed?.name === 'plexo') return dir
                } catch { /* ignore */ }
            }
            const parent = resolve(dir, '..')
            if (parent === dir) break
            dir = parent
        }
    } catch { /* ignore */ }
    return process.cwd()
}

/** Read the top-level plexo package.json version, best-effort. */
function readPlexoVersion(): string {
    try {
        const root = findRepoRoot()
        const pj = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
        return typeof pj?.version === 'string' ? pj.version : 'unknown'
    } catch {
        return 'unknown'
    }
}

/** Run a short git command safely; returns null on any failure. */
function safeGit(args: string, cwd: string): string | null {
    try {
        const out = execSync(`git ${args}`, {
            cwd,
            stdio: ['ignore', 'pipe', 'ignore'],
            encoding: 'utf8',
            timeout: 500,
        })
        return out.trim() || null
    } catch {
        return null
    }
}

/** Detect whether we're running inside a docker container. */
function detectContainerized(): boolean {
    try {
        if (existsSync('/.dockerenv')) return true
        const cgroup = readFileSync('/proc/1/cgroup', 'utf8')
        if (/docker|containerd|kubepods/i.test(cgroup)) return true
    } catch { /* ignore */ }
    return false
}

/** Best-effort deployment mode detection. */
function detectDeploymentMode(): 'saas' | 'selfhosted' | 'dev' {
    const explicit = process.env.PLEXO_DEPLOYMENT_MODE || process.env.DEPLOYMENT_MODE
    if (explicit === 'saas' || explicit === 'selfhosted' || explicit === 'dev') return explicit
    if (process.env.NODE_ENV !== 'production') return 'dev'
    // Heuristic: getplexo.com / joeybuilt domain → saas; otherwise selfhosted
    const domain = process.env.PLEXO_DOMAIN || process.env.DOMAIN || ''
    if (/getplexo\.com|joeybuilt/i.test(domain)) return 'saas'
    return 'selfhosted'
}

// ── Tools ───────────────────────────────────────────────────────────────────

export function buildEnvironmentTools(): ToolSet {
    return {
        get_runtime_environment: tool({
            description: 'Inspect the runtime this Plexo instance is running on. Returns OS, Node version, Plexo version, commit, deployment mode, container info, uptime, and memory usage. Read-only, safe to call anytime.',
            inputSchema: z.object({}),
            execute: async (): Promise<string> => {
                try {
                    const containerized = detectContainerized()
                    const plexoVersion = readPlexoVersion()
                    const repoRoot = findRepoRoot()
                    const gitCommit = process.env.PLEXO_COMMIT
                        || process.env.GIT_COMMIT
                        || process.env.APP_VERSION
                        || safeGit('rev-parse HEAD', repoRoot)
                        || 'unknown'
                    const mem = process.memoryUsage()
                    const payload = {
                        platform: containerized ? 'docker' : 'node',
                        containerized,
                        os: osPlatform(),
                        osRelease: osRelease(),
                        arch: osArch(),
                        nodeVersion: process.version,
                        plexoVersion,
                        plexoCommit: gitCommit,
                        deploymentMode: detectDeploymentMode(),
                        containerName: hostname(),
                        uptimeSeconds: Math.round(process.uptime()),
                        memoryUsage: {
                            rssMB: Math.round(mem.rss / 1024 / 1024),
                            heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
                            heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
                            externalMB: Math.round(mem.external / 1024 / 1024),
                        },
                        pid: process.pid,
                    }
                    return JSON.stringify(payload, null, 2)
                } catch (err) {
                    return JSON.stringify({
                        error: 'introspection_partial_failure',
                        message: err instanceof Error ? err.message : String(err),
                        platform: 'unknown',
                        nodeVersion: process.version,
                        plexoVersion: readPlexoVersion(),
                    }, null, 2)
                }
            },
        }),

        get_infrastructure: tool({
            description: 'List the services this Plexo instance has access to — database, cache, LLM providers, embeddings, storage, channels, connectors. Read-only, env-var driven. Safe to call anytime.',
            inputSchema: z.object({}),
            execute: async (): Promise<string> => {
                try {
                    // Database: parse DATABASE_URL host without leaking credentials
                    let database: { type: string; host: string | null; configured: boolean } = {
                        type: 'postgres',
                        host: null,
                        configured: false,
                    }
                    try {
                        const dbUrl = process.env.DATABASE_URL
                        if (dbUrl) {
                            const u = new URL(dbUrl)
                            database = {
                                type: u.protocol.replace(':', '') || 'postgres',
                                host: u.hostname + (u.port ? `:${u.port}` : ''),
                                configured: true,
                            }
                        }
                    } catch { /* ignore */ }

                    // Cache: REDIS_URL → host, type guess
                    let cache: { type: string; host: string | null; configured: boolean } = {
                        type: 'redis',
                        host: null,
                        configured: false,
                    }
                    try {
                        const rUrl = process.env.REDIS_URL
                        if (rUrl) {
                            const u = new URL(rUrl)
                            cache = {
                                type: /valkey/i.test(u.hostname) ? 'valkey' : 'redis',
                                host: u.hostname + (u.port ? `:${u.port}` : ''),
                                configured: true,
                            }
                        }
                    } catch { /* ignore */ }

                    // LLM providers — detect env-level keys (workspace-level keys are per-workspace)
                    const llmProviders: string[] = []
                    if (process.env.OPENAI_API_KEY) llmProviders.push('openai')
                    if (process.env.ANTHROPIC_API_KEY) llmProviders.push('anthropic')
                    if (process.env.GROQ_API_KEY) llmProviders.push('groq')
                    if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) llmProviders.push('google')
                    if (process.env.MISTRAL_API_KEY) llmProviders.push('mistral')
                    if (process.env.DEEPSEEK_API_KEY) llmProviders.push('deepseek')
                    if (process.env.XAI_API_KEY) llmProviders.push('xai')
                    if (process.env.OPENROUTER_API_KEY) llmProviders.push('openrouter')
                    if (process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL) llmProviders.push('ollama')

                    // Embeddings server (EMBEDDINGS_URL is the new name;
                    // INFERENCE_GATEWAY_URL kept as a deprecation fallback)
                    const embeddingsUrl = process.env.EMBEDDINGS_URL || process.env.INFERENCE_GATEWAY_URL || null
                    const embeddings = {
                        configured: !!embeddingsUrl,
                        url: embeddingsUrl,
                        model: process.env.EMBEDDING_MODEL || 'default',
                    }

                    // Storage (MinIO/S3)
                    const storage = {
                        configured: !!(process.env.STORAGE_ENDPOINT && process.env.STORAGE_ACCESS_KEY && process.env.STORAGE_SECRET_KEY),
                        endpoint: process.env.STORAGE_ENDPOINT || null,
                        bucket: process.env.STORAGE_BUCKET || null,
                    }

                    // Channels — surfaces Plexo can be invoked from. Workspace-level
                    // config lives in DB; at env level this is informational only.
                    const channels = ['web', 'api']
                    if (process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_WEBHOOK_SECRET) channels.push('telegram')
                    if (process.env.SLACK_BOT_TOKEN || process.env.SLACK_SIGNING_SECRET) channels.push('slack')
                    if (process.env.DISCORD_BOT_TOKEN) channels.push('discord')

                    // MCP servers — best-effort, a full list lives in DB per-workspace
                    const mcpServers: string[] = []
                    if (process.env.MCP_SERVERS) {
                        try { mcpServers.push(...process.env.MCP_SERVERS.split(',').map(s => s.trim()).filter(Boolean)) } catch { /* ignore */ }
                    }

                    const payload = {
                        database,
                        cache,
                        llmProviders,
                        embeddings,
                        storage,
                        channels,
                        mcpServers,
                        note: 'Workspace-level provider/MCP config lives in DB and is per-workspace. This shows env-level infrastructure only.',
                    }
                    return JSON.stringify(payload, null, 2)
                } catch (err) {
                    return JSON.stringify({
                        error: 'introspection_partial_failure',
                        message: err instanceof Error ? err.message : String(err),
                    }, null, 2)
                }
            },
        }),

        get_repository_info: tool({
            description: 'Return info about the Plexo source repository this instance was built from — path, current commit, branch, remote. Read-only. Safe when git is unavailable (returns best-effort).',
            inputSchema: z.object({}),
            execute: async (): Promise<string> => {
                try {
                    const repoRoot = findRepoRoot()
                    const gitDir = join(repoRoot, '.git')
                    const hasGit = existsSync(gitDir)
                    const currentCommit = hasGit ? safeGit('rev-parse HEAD', repoRoot) : null
                    const currentBranch = hasGit ? safeGit('rev-parse --abbrev-ref HEAD', repoRoot) : null
                    const remote = hasGit ? safeGit('config --get remote.origin.url', repoRoot) : null
                    const payload = {
                        name: 'plexo',
                        path: repoRoot,
                        hasGit,
                        currentCommit: currentCommit
                            || process.env.PLEXO_COMMIT
                            || process.env.GIT_COMMIT
                            || process.env.APP_VERSION
                            || null,
                        currentBranch: currentBranch || null,
                        remote: remote || 'https://github.com/joeybuilt-official/plexo',
                    }
                    return JSON.stringify(payload, null, 2)
                } catch (err) {
                    return JSON.stringify({
                        error: 'introspection_partial_failure',
                        message: err instanceof Error ? err.message : String(err),
                        name: 'plexo',
                        path: process.cwd(),
                        hasGit: false,
                    }, null, 2)
                }
            },
        }),

        get_deployment_context: tool({
            description: 'Return high-level deployment context — whether this is production, the serving domain, tenancy model, and owner. Read-only.',
            inputSchema: z.object({}),
            execute: async (): Promise<string> => {
                try {
                    const mode = detectDeploymentMode()
                    const payload = {
                        isProduction: process.env.NODE_ENV === 'production',
                        deploymentMode: mode,
                        domain: process.env.PLEXO_DOMAIN
                            || process.env.DOMAIN
                            || process.env.NEXT_PUBLIC_APP_URL
                            || null,
                        isMultitenant: mode === 'saas',
                        companyName: 'Joeybuilt',
                        owner: process.env.PLEXO_OWNER || null,
                        nodeEnv: process.env.NODE_ENV || 'development',
                    }
                    return JSON.stringify(payload, null, 2)
                } catch (err) {
                    return JSON.stringify({
                        error: 'introspection_partial_failure',
                        message: err instanceof Error ? err.message : String(err),
                        isProduction: process.env.NODE_ENV === 'production',
                        companyName: 'Joeybuilt',
                    }, null, 2)
                }
            },
        }),

        get_self_modification_scope: tool({
            description: 'Describe what this Plexo agent CAN and CANNOT modify about itself, plus what requires operator approval. Read-only, static capability manifest.',
            inputSchema: z.object({}),
            execute: async (): Promise<string> => {
                const payload = {
                    canModify: [
                        'workspace settings (name, persona, limits)',
                        'memory entries',
                        'connections (add/remove)',
                        'extensions (install/uninstall/toggle)',
                        'channels (configure)',
                        'behavior rules',
                        'schedules',
                    ],
                    cannotModify: [
                        'own source code (without Command Center integration)',
                        'docker compose',
                        'server infrastructure',
                        'database schema',
                        'other workspaces',
                    ],
                    requiresApproval: [
                        'destructive operations (delete)',
                        'external API calls with cost',
                        'schema changes',
                    ],
                    notes: 'When given repo access via Command Center, I can propose code changes via pull requests. I cannot execute them on production without operator approval.',
                }
                return JSON.stringify(payload, null, 2)
            },
        }),
    }
}
