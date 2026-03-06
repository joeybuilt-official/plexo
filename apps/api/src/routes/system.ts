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

async function fetchLatestRelease(): Promise<GithubRelease | null> {
    try {
        const redis = await getRedis()
        const cached = await redis.get(VERSION_CACHE_KEY)
        if (cached) return JSON.parse(cached) as GithubRelease

        const res = await fetch(
            `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
            {
                headers: { 'User-Agent': 'plexo-self-host/1.0', Accept: 'application/vnd.github+json' },
                signal: AbortSignal.timeout(8000),
            },
        )
        if (!res.ok) return null

        const data = (await res.json()) as GithubRelease
        await redis.set(VERSION_CACHE_KEY, JSON.stringify(data), { EX: VERSION_CACHE_TTL })
        return data
    } catch (err) {
        logger.warn({ err }, 'Failed to fetch latest GitHub release')
        return null
    }
}

function semverGt(a: string, b: string): boolean {
    const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number)
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
    const current = process.env.APP_VERSION ?? process.env.npm_package_version ?? '0.0.0'
    const release = await fetchLatestRelease()

    if (!release) {
        res.json({ current, latest: null, behind: false, error: 'github_unreachable' })
        return
    }

    const latest = release.tag_name.replace(/^v/, '')
    const behind = semverGt(latest, current)

    res.json({
        current,
        latest,
        behind,
        releaseUrl: release.html_url,
        publishedAt: release.published_at,
        changelog: release.body?.slice(0, 2000) ?? null,
        dockerEnabled: process.env.DOCKER_SOCKET_ENABLED === 'true',
    })
})

/**
 * POST /api/v1/system/update
 * Pulls latest Docker images and restarts affected containers.
 * Requires DOCKER_SOCKET_ENABLED=true in env.
 * Streams progress as newline-delimited JSON.
 */
systemRouter.post('/update', async (_req, res) => {
    if (process.env.DOCKER_SOCKET_ENABLED !== 'true') {
        res.status(403).json({
            error: 'DOCKER_DISABLED',
            message: 'One-click update requires DOCKER_SOCKET_ENABLED=true and the Docker socket mounted.',
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
        // Restart in reverse dependency order: web first (depends on api), then api
        const sorted = [...containers].sort((a) =>
            a.Names.some(n => n.includes('web')) ? -1 : 1,
        )
        for (const container of sorted) {
            send('status', { step: 'restart', message: `Restarting ${container.Names[0]}…` })
            await restartContainer(container.Id)
            send('status', { step: 'restart', message: `Restarted ${container.Names[0]}` })
        }

        // Invalidate version cache so next check reflects the new version
        const redis = await getRedis()
        await redis.del(VERSION_CACHE_KEY)

        send('done', { success: true, message: 'Update complete. Reload the page in a few seconds.' })
    } catch (err) {
        logger.error({ err }, 'In-app update failed')
        send('error', { message: err instanceof Error ? err.message : 'Unknown error during update' })
    }

    res.end()
})
