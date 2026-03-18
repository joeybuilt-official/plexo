// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * System routes — version check + in-place update
 *
 * GET  /system/version
 *   Returns: { current, latest, behind, changelog }
 *   Cached in Redis for 1 hour. Falls back gracefully if GitHub is unreachable.
 *
 * POST /system/update
 *   Triggers a Docker "pull + restart" via the Docker Engine Unix socket.
 *   Requires DOCKER_SOCKET_ENABLED=true and access to /var/run/docker.sock.
 *   Returns a streaming status (SSE-like chunked response) so the UI can
 *   show progress without long-polling.
 *
 * Security note: both routes should sit behind admin middleware in production.
 * For now they require a valid session/workspace — the update endpoint is
 * guarded by DOCKER_SOCKET_ENABLED so it is opt-in and non-destructive by default.
 */

import { Router, type Router as RouterType } from 'express'
import http from 'node:http'
import { createClient } from 'redis'
import { logger } from '../logger.js'

const GITHUB_OWNER = 'joeybuilt-official'
const GITHUB_REPO = 'plexo'
const VERSION_CACHE_KEY = 'plexo:system:latest_version'
const VERSION_CACHE_TTL = 60 * 60 // 1 hour for release info
const COMMIT_CACHE_KEY = 'plexo:system:latest_commit'
const COMMIT_CACHE_TTL = 2 * 60  // 2 min — detect pushes quickly during beta

export const systemRouter: RouterType = Router()

// ── Helpers ──────────────────────────────────────────────────────────────────

let _redis: ReturnType<typeof createClient> | null = null
async function getRedis() {
    if (!_redis) {
        _redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' })
        _redis.on('error', (err: Error) => logger.warn({ err }, 'system redis error'))
        await _redis.connect()
    }
    return _redis
}

interface RemoteRelease {
    type: 'release' | 'commit'
    version: string
    url: string
    date: string
    message: string | null
}

interface LatestCommit {
    sha: string
    shortSha: string
    date: string
    url: string
    message: string
}

async function fetchLatestRelease(): Promise<RemoteRelease | null> {
    try {
        const redis = await getRedis()
        const cached = await redis.get(VERSION_CACHE_KEY)
        if (cached) return JSON.parse(cached) as RemoteRelease

        // Use list endpoint — includes pre-releases; /releases/latest skips them
        const releaseRes = await fetch(
            `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=1`,
            {
                headers: { 'User-Agent': 'plexo-self-host/1.0', Accept: 'application/vnd.github+json' },
                signal: AbortSignal.timeout(4000),
            },
        )
        if (releaseRes.ok) {
            const releases = await releaseRes.json() as { tag_name: string; html_url: string; published_at: string; body: string }[]
            if (releases.length > 0) {
                const data = releases[0]!
                const result: RemoteRelease = { type: 'release', version: data.tag_name, url: data.html_url, date: data.published_at, message: data.body }
                await redis.set(VERSION_CACHE_KEY, JSON.stringify(result), { EX: VERSION_CACHE_TTL })
                return result
            }
        }

        // No releases yet — commit check runs in parallel in the route handler
        return null
    } catch (err) {
        logger.warn({ err }, 'Failed to fetch latest release')
        return null
    }
}

async function fetchLatestMainCommit(): Promise<LatestCommit | null> {
    try {
        const redis = await getRedis()
        const cached = await redis.get(COMMIT_CACHE_KEY)
        if (cached) return JSON.parse(cached) as LatestCommit

        const res = await fetch(
            `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits/main`,
            {
                headers: { 'User-Agent': 'plexo-self-host/1.0', Accept: 'application/vnd.github+json' },
                signal: AbortSignal.timeout(4000),
            },
        )
        if (!res.ok) return null

        const data = await res.json() as { sha: string; html_url: string; commit: { committer: { date: string }; message: string } }
        const result: LatestCommit = {
            sha: data.sha,
            shortSha: data.sha.slice(0, 7),
            date: data.commit.committer.date,
            url: data.html_url,
            message: data.commit.message.split('\n')[0] ?? '',
        }
        await redis.set(COMMIT_CACHE_KEY, JSON.stringify(result), { EX: COMMIT_CACHE_TTL })
        return result
    } catch (err) {
        logger.warn({ err }, 'Failed to fetch latest main commit')
        return null
    }
}

import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

async function getLocalVersion(): Promise<{ type: 'release' | 'commit'; version: string; buildTime: string | null; sourceCommit: string | null }> {
    const { readFile } = await import('node:fs/promises')

    let buildTime: string | null = null
    let sourceCommit: string | null = null
    try {
        buildTime = (await readFile('/app/.build-time', 'utf8')).trim() || null
        sourceCommit = (await readFile('/app/.source-commit', 'utf8')).trim() || null
    } catch { /* dev environment or missing files */ }

    // Primary: version baked into image at build time from package.json
    try {
        const baked = (await readFile('/app/.version', 'utf8')).trim()
        if (baked && baked !== 'auto' && baked !== 'dev') {
            return { type: 'release', version: baked, buildTime, sourceCommit }
        }
    } catch { /* not in a Docker container — continue */ }

    // Secondary: APP_VERSION env var
    if (process.env.APP_VERSION && process.env.APP_VERSION !== 'dev' && process.env.APP_VERSION !== 'auto') {
        return { type: 'release', version: process.env.APP_VERSION, buildTime, sourceCommit }
    }
    // Tertiary: git commit hash (source checkout)
    try {
        const { stdout } = await execAsync('git rev-parse HEAD', { cwd: process.cwd() })
        return { type: 'commit', version: stdout.trim(), buildTime, sourceCommit: stdout.trim() }
    } catch {
        return { type: 'release', version: process.env.npm_package_version ?? '0.0.0', buildTime, sourceCommit }
    }
}

function semverGt(a: string, b: string): boolean {
    // Strip v prefix and pre-release suffixes (e.g. -beta.1) before comparing
    const clean = (v: string) => v.replace(/^v/, '').replace(/-.*$/, '')
    const parse = (v: string) => clean(v).split('.').map(Number)
    const [aMaj = 0, aMin = 0, aPat = 0] = parse(a)
    const [bMaj = 0, bMin = 0, bPat = 0] = parse(b)
    if (aMaj !== bMaj) return aMaj > bMaj
    if (aMin !== bMin) return aMin > bMin
    return aPat > bPat
}

// ── Docker Engine API helpers (unix socket) ───────────────────────────────────

const DOCKER_SOCKET = '/var/run/docker.sock'
const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT_NAME ?? 'plexo'

function dockerRequest(opts: { method: string; path: string; body?: unknown }): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const payload = opts.body ? JSON.stringify(opts.body) : undefined
        const req = http.request(
            {
                socketPath: DOCKER_SOCKET,
                method: opts.method,
                path: opts.path,
                headers: {
                    'Content-Type': 'application/json',
                    ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
                },
            },
            (res) => {
                let body = ''
                res.on('data', (chunk: Buffer) => { body += chunk.toString() })
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
            },
        )
        req.on('error', reject)
        if (payload) req.write(payload)
        req.end()
    })
}

interface ContainerInfo {
    Id: string
    Names: string[]
    Image: string
    State: string
    Labels: Record<string, string>
}

async function getContainers(): Promise<ContainerInfo[]> {
    const res = await dockerRequest({
        method: 'GET',
        path: `/v1.41/containers/json?filters=${encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${COMPOSE_PROJECT}`] }))}`,
    })
    return JSON.parse(res.body) as ContainerInfo[]
}

/** Fallback: find the API container across all compose projects (handles Coolify-generated project names). */
async function findApiContainerAnyProject(): Promise<ContainerInfo | undefined> {
    // Try by compose service label first (most reliable across project names)
    const byService = await dockerRequest({
        method: 'GET',
        path: `/v1.41/containers/json?filters=${encodeURIComponent(JSON.stringify({ label: ['com.docker.compose.service=api'] }))}`,
    })
    const serviceMatches = JSON.parse(byService.body) as ContainerInfo[]
    // Prefer containers whose image or name references plexo
    const plexoApi = serviceMatches.find(c =>
        c.Image.toLowerCase().includes('plexo') ||
        c.Names.some(n => n.toLowerCase().includes('plexo'))
    ) ?? serviceMatches[0]
    if (plexoApi) return plexoApi

    // Last resort: scan all running containers for one named *plexo*api* or *api*plexo*
    const all = await dockerRequest({ method: 'GET', path: '/v1.41/containers/json' })
    const allContainers = JSON.parse(all.body) as ContainerInfo[]
    return allContainers.find(c =>
        c.Names.some(n => {
            const lower = n.toLowerCase()
            return (lower.includes('plexo') && lower.includes('api')) || lower.includes('plexo-api')
        })
    )
}

async function pullImage(image: string, onChunk: (line: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                socketPath: DOCKER_SOCKET,
                method: 'POST',
                path: `/v1.41/images/create?fromImage=${encodeURIComponent(image)}`,
                headers: { 'Content-Type': 'application/json' },
            },
            (res) => {
                res.on('data', (chunk: Buffer) => {
                    // Docker streams JSON lines during pull
                    chunk.toString().split('\n').filter(Boolean).forEach(line => onChunk(line))
                })
                res.on('end', resolve)
                res.on('error', reject)
            },
        )
        req.on('error', reject)
        req.end()
    })
}


// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/system/version
 * Returns current vs latest version info.
 */
systemRouter.get('/version', async (_req, res) => {
    const [local, release, latestCommit] = await Promise.all([
        getLocalVersion(),
        fetchLatestRelease(),
        fetchLatestMainCommit(),
    ])

    if (!release && !latestCommit) {
        res.json({ current: local.version, latest: null, behind: false, error: 'github_unreachable' })
        return
    }

    let behind = false
    let latest = local.version
    let releaseUrl: string | null = null
    let publishedAt: string | null = null
    let changelog: string | null = null
    let updateType: 'release' | 'commit' = 'commit'

    // ── Release-based check ──────────────────────────────────────────────────
    if (release && local.type === 'release') {
        latest = release.version.replace(/^v/, '')
        behind = semverGt(latest, local.version.replace(/^v/, ''))
        releaseUrl = release.url
        publishedAt = release.date
        changelog = release.message?.slice(0, 2000) ?? null
        updateType = 'release'
    }

    // ── Commit-based check ───────────────────────────────────────────────────
    // Three cases that should detect a new commit on main:
    //  1. No releases at all — source deployment; compare SHA directly.
    //  2. On latest release but running from Docker — compare build timestamp.
    //  3. Running from git source regardless of releases.
    if (!behind && latestCommit) {
        if (local.type === 'commit') {
            // Source checkout: SHA comparison is authoritative
            behind = local.version !== latestCommit.sha
            latest = latestCommit.shortSha
            releaseUrl = latestCommit.url
            publishedAt = latestCommit.date
            changelog = latestCommit.message
            updateType = 'commit'
        } else if (local.sourceCommit && local.sourceCommit !== 'unknown') {
            // Docker image with baked commit hash (most reliable, avoids clock skew issues)
            if (local.sourceCommit !== latestCommit.sha && !local.sourceCommit.startsWith(latestCommit.shortSha)) {
                behind = true
                latest = latestCommit.shortSha
                releaseUrl = latestCommit.url
                publishedAt = latestCommit.date
                changelog = latestCommit.message
                updateType = 'commit'
            }
        } else if (local.buildTime) {
            // Legacy Docker image: fallback to comparing build timestamp to latest commit date
            const commitDate = new Date(latestCommit.date).getTime()
            const buildDate = new Date(local.buildTime).getTime()
            if (commitDate > buildDate) {
                behind = true
                latest = latestCommit.shortSha
                releaseUrl = latestCommit.url
                publishedAt = latestCommit.date
                changelog = latestCommit.message
                updateType = 'commit'
            }
        }
    }

    res.json({
        current: local.type === 'commit' ? local.version.slice(0, 7) : local.version,
        latest,
        behind,
        updateType,
        releaseUrl,
        publishedAt,
        changelog,
        dockerEnabled: process.env.DOCKER_SOCKET_ENABLED === 'true',
        isGitSource: local.type === 'commit',
    })
})

/**
 * POST /api/v1/system/update
 * Pulls latest Docker images and restarts affected containers,
 * OR runs `git pull` and restarts if running via source.
 */
systemRouter.post('/update', async (_req, res) => {
    const isDocker = process.env.DOCKER_SOCKET_ENABLED === 'true'
    const isGit = (await getLocalVersion()).type === 'commit'

    if (!isDocker && !isGit) {
        res.status(403).json({
            error: 'UPDATE_UNSUPPORTED',
            message: 'One-click update requires either DOCKER_SOCKET_ENABLED=true or running from a git clone.',
        })
        return
    }

    // Stream progress back to the client
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    const send = (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    try {
        if (isDocker) {
            send('status', { step: 'containers', message: 'Discovering host context…' })

            // Allow explicit override for managed hosts (Coolify, Render, etc.)
            // where container labels may not reflect the actual host repo path.
            let hostRepoRoot: string
            const repoOverride = process.env.PLEXO_REPO_DIR
            if (repoOverride) {
                hostRepoRoot = repoOverride
            } else {
                // 1. Try project-scoped lookup first (standard self-hosted docker compose)
                let apiContainer: ContainerInfo | undefined
                const projectContainers = await getContainers()
                apiContainer = projectContainers.find(c => c.Names.some(n => n.includes('api')))

                // 2. If project filter returned nothing (Coolify generates its own project name),
                //    scan all containers for the plexo API service.
                if (!apiContainer) {
                    apiContainer = await findApiContainerAnyProject()
                }

                const workingDir = apiContainer?.Labels?.['com.docker.compose.project.working_dir']
                if (!workingDir) {
                    throw new Error(
                        'Could not determine host working directory. ' +
                        'Set the PLEXO_REPO_DIR environment variable to the absolute path of your Plexo repo on the host (e.g. /home/user/plexo) and restart the API container.'
                    )
                }

                // Handle transition: if current containers are running from docker/ subdirectory,
                // the root is one level up. If running from root, it is workingDir.
                hostRepoRoot = workingDir
                if (workingDir.endsWith('/docker')) {
                    const { dirname } = await import('node:path')
                    hostRepoRoot = dirname(workingDir)
                }
            }
            
            send('status', { step: 'pull', message: 'Preparing updater framework (this may take a few seconds)…' })
            await pullImage('alpine:latest', () => { /* quiet pull logs */ })

            send('status', { step: 'restart', message: 'Triggering background host rebuild…' })
            const createRes = await dockerRequest({
                method: 'POST',
                path: `/v1.41/containers/create?name=plexo-updater-${Date.now()}`,
                body: {
                    Image: 'alpine:latest',
                    Cmd: [
                        'sh', '-c',
                        `apk add --no-cache git docker-cli docker-cli-compose && cd ${hostRepoRoot} && git fetch origin main && git reset --hard origin/main && export SOURCE_COMMIT=$(git rev-parse HEAD) && docker compose build api web migrate && docker compose up -d --remove-orphans`
                    ],
                    HostConfig: {
                        AutoRemove: true,
                        Binds: [
                            '/var/run/docker.sock:/var/run/docker.sock',
                            `${hostRepoRoot}:${hostRepoRoot}`
                        ]
                    }
                }
            })
            
            if (createRes.status >= 400) {
               throw new Error(`Failed to create updater: ${createRes.body}`)
            }
            const { Id: updaterId } = JSON.parse(createRes.body)
            
            const startRes = await dockerRequest({ method: 'POST', path: `/v1.41/containers/${updaterId}/start` })
            if (startRes.status >= 400) {
               throw new Error(`Failed to start updater: ${startRes.body}`)
            }

            // Invalidate version caches
            const redisPre = await getRedis()
            await redisPre.del(VERSION_CACHE_KEY)
            await redisPre.del(COMMIT_CACHE_KEY)

            send('done', { success: true, message: 'Update started in background! The system is downloading updates and rebuilding. It will automatically restart in about 1-2 minutes. Please wait and reload the page.' })
            res.end()

            return // done
        } else if (isGit) {
            send('status', { step: 'git', message: 'Pulling latest changes from git…' })
            const { stdout: pullOut } = await execAsync('git pull', { cwd: process.cwd() })
            send('status', { step: 'git', message: pullOut.trim() })

            send('status', { step: 'npm', message: 'Installing dependencies…' })
            await execAsync('pnpm install', { cwd: process.cwd() })
            send('status', { step: 'npm', message: 'Dependencies installed' })
            
            send('status', { step: 'restart', message: 'Note: You may need to restart the server manually if it does not auto-restart.' })
        }

        // Invalidate version cache so next check reflects the new version
        const redis = await getRedis()
        await redis.del(VERSION_CACHE_KEY)
        await redis.del(COMMIT_CACHE_KEY)

        send('done', { success: true, message: isDocker ? 'Update complete. Reload the page in a few seconds.' : 'Update pulled. Server may restart automatically.' })
    } catch (err) {
        logger.error({ err }, 'In-app update failed')
        send('error', { isError: true, message: err instanceof Error ? err.message : 'Unknown error during update' })
    }

    res.end()
})
