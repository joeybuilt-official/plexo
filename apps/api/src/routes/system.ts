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
const VERSION_CACHE_TTL = 60 * 60 // 1 hour

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

interface GithubRelease {
    tag_name: string
    html_url: string
    body: string | null
    published_at: string
}

async function fetchLatestRemote(): Promise<{ type: 'release' | 'commit'; version: string; url: string; date: string; message: string | null } | null> {
    try {
        const redis = await getRedis()
        const cached = await redis.get(VERSION_CACHE_KEY)
        if (cached) return JSON.parse(cached)

        // Try releases first — use list endpoint (includes pre-releases; /releases/latest skips them)
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
                const result = { type: 'release' as const, version: data.tag_name, url: data.html_url, date: data.published_at, message: data.body }
                await redis.set(VERSION_CACHE_KEY, JSON.stringify(result), { EX: VERSION_CACHE_TTL })
                return result
            }
        }

        // Fall back to main branch commit
        const commitRes = await fetch(
            `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits/main`,
            {
                headers: { 'User-Agent': 'plexo-self-host/1.0', Accept: 'application/vnd.github+json' },
                signal: AbortSignal.timeout(4000),
            },
        )
        if (commitRes.ok) {
            const data = await commitRes.json() as { sha: string; html_url: string; commit: { author: { date: string }; message: string } }
            const result = { type: 'commit' as const, version: data.sha, url: data.html_url, date: data.commit.author.date, message: data.commit.message }
            await redis.set(VERSION_CACHE_KEY, JSON.stringify(result), { EX: VERSION_CACHE_TTL })
            return result
        }

        return null
    } catch (err) {
        logger.warn({ err }, 'Failed to fetch latest remote version')
        return null
    }
}

import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

async function getLocalVersion(): Promise<{ type: 'release' | 'commit'; version: string }> {
    // Primary: version baked into image at build time from package.json
    try {
        const { readFile } = await import('node:fs/promises')
        const baked = (await readFile('/app/.version', 'utf8')).trim()
        if (baked && baked !== 'auto' && baked !== 'dev') {
            return { type: 'release', version: baked }
        }
    } catch { /* not in a Docker container — continue */ }

    // Secondary: APP_VERSION env var (must not be 'dev' or 'auto' sentinel)
    if (process.env.APP_VERSION && process.env.APP_VERSION !== 'dev' && process.env.APP_VERSION !== 'auto') {
        return { type: 'release', version: process.env.APP_VERSION }
    }
    // Tertiary: git commit hash (source checkout)
    try {
        const { stdout } = await execAsync('git rev-parse HEAD', { cwd: process.cwd() })
        return { type: 'commit', version: stdout.trim() }
    } catch {
        return { type: 'release', version: process.env.npm_package_version ?? '0.0.0' }
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
}

async function getContainers(): Promise<ContainerInfo[]> {
    const res = await dockerRequest({
        method: 'GET',
        path: `/v1.41/containers/json?filters=${encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${COMPOSE_PROJECT}`] }))}`,
    })
    return JSON.parse(res.body) as ContainerInfo[]
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

async function restartContainer(id: string): Promise<void> {
    await dockerRequest({ method: 'POST', path: `/v1.41/containers/${id}/restart` })
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/system/version
 * Returns current vs latest version info.
 */
systemRouter.get('/version', async (_req, res) => {
    const local = await getLocalVersion()
    const remote = await fetchLatestRemote()

    if (!remote) {
        res.json({ current: local.version, latest: null, behind: false, error: 'github_unreachable' })
        return
    }

    let behind = false
    let latest = remote.version

    if (remote.type === 'release' && local.type === 'release') {
        latest = remote.version.replace(/^v/, '')
        const current = local.version.replace(/^v/, '')
        behind = semverGt(latest, current)
    } else if (remote.type === 'commit' && local.type === 'commit') {
        behind = local.version !== remote.version
        latest = remote.version.slice(0, 7)
    } else if (remote.type === 'release' && local.type === 'commit') {
        behind = true // assuming release is newer than source
    }

    res.json({
        current: local.type === 'commit' ? local.version.slice(0, 7) : local.version,
        latest,
        behind,
        releaseUrl: remote.url,
        publishedAt: remote.date,
        changelog: remote.message?.slice(0, 2000) ?? null,
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
            send('status', { step: 'containers', message: 'Discovering running containers…' })
            const containers = await getContainers()
            send('status', { step: 'containers', message: `Found ${containers.length} container(s)` })

            const images = [...new Set(containers.map(c => c.Image))]

            for (const image of images) {
                send('status', { step: 'pull', message: `Pulling ${image}…` })
                await pullImage(image, (line) => {
                    try {
                        const parsed = JSON.parse(line) as { status?: string; progress?: string }
                        if (parsed.status) send('progress', { image, status: parsed.status, progress: parsed.progress })
                    } catch { /* malformed line — skip */ }
                })
                send('status', { step: 'pull', message: `Pulled ${image}` })
            }

            send('status', { step: 'restart', message: 'Restarting containers…' })
            // Sort: web first (can restart while API is still streaming), API last
            // so the SSE stream stays alive long enough to deliver the done event.
            const sorted = [...containers].sort((a) =>
                a.Names.some(n => n.includes('web')) ? -1 : 1,
            )
            const apiContainer = sorted.find(c => c.Names.some(n => n.includes('api')))
            const others = sorted.filter(c => !c.Names.some(n => n.includes('api')))

            for (const container of others) {
                send('status', { step: 'restart', message: `Restarting ${container.Names[0]}…` })
                await restartContainer(container.Id)
                send('status', { step: 'restart', message: `Restarted ${container.Names[0]}` })
            }

            // Invalidate version cache before restarting API
            const redisPre = await getRedis()
            await redisPre.del(VERSION_CACHE_KEY)

            // Send done BEFORE restarting the API container — the connection
            // will drop when the API restarts, but the client will have already
            // received the success event.
            send('done', { success: true, message: 'Update complete. Reload the page in a few seconds.' })
            res.end()

            if (apiContainer) {
                // Small delay so the SSE frame makes it through the TCP buffer before we die
                await new Promise(r => setTimeout(r, 1500))
                await restartContainer(apiContainer.Id).catch(() => { /* container restart will kill us anyway */ })
            }
            return // skip the duplicate send/res.end below
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

        send('done', { success: true, message: isDocker ? 'Update complete. Reload the page in a few seconds.' : 'Update pulled. Server may restart automatically.' })
    } catch (err) {
        logger.error({ err }, 'In-app update failed')
        send('error', { message: err instanceof Error ? err.message : 'Unknown error during update' })
    }

    res.end()
})
