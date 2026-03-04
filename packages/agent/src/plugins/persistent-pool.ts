/**
 * Kapsel Persistent Worker Pool (§5.4) — v2 with host bridge
 *
 * Maintains ONE persistent Worker per enabled extension, reused across all
 * tool invocations. Handles sdk_call messages from workers to provide real
 * implementations of storage, memory, connections, events, and tasks APIs.
 *
 * Message protocol:
 *   Host → Worker { type: 'activate', callId, input }
 *   Host → Worker { type: 'invoke', callId, toolName, args, workspaceId }
 *   Host → Worker { type: 'bridge_reply', callId, result?, error? }
 *   Host → Worker { type: 'terminate' }
 *
 *   Worker → Host { type: 'activated', callId, tools }
 *   Worker → Host { type: 'result', callId, result }
 *   Worker → Host { type: 'error', callId, error }
 *   Worker → Host { type: 'sdk_call', callId, method, args }
 */
import { Worker } from 'worker_threads'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { randomUUID } from 'node:crypto'
import pino from 'pino'
import { storeMemory, searchMemory } from '../memory/store.js'
import { db, eq, and } from '@plexo/db'
import { installedConnections, connectionsRegistry, tasks } from '@plexo/db'
import { eventBus } from './event-bus.js'

const logger = pino({ name: 'kapsel-persistent-pool' })

const __filename = fileURLToPath(import.meta.url)
const __dir = dirname(__filename)

const DEFAULT_INVOKE_TIMEOUT_MS = 10_000
const DEFAULT_ACTIVATE_TIMEOUT_MS = 30_000
const STORAGE_TTL_DEFAULT = 60 * 60 * 24 * 30 // 30 days

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ActivationInput {
    pluginName: string
    entry: string
    permissions: string[]
    settings: Record<string, unknown>
    workspaceId: string
    activateTimeoutMs?: number
}

export interface WorkerHandle {
    worker: Worker
    pluginName: string
    workspaceId: string
    activatedAt: number
    registeredTools: RegisteredTool[]
}

export interface RegisteredTool {
    name: string
    description: string
    parameters?: unknown
    hints?: { timeoutMs?: number }
}

export interface InvokeResult {
    ok: boolean
    result?: unknown
    error?: string
    timedOut?: boolean
    durationMs: number
}

// ── State ─────────────────────────────────────────────────────────────────────

const _workers = new Map<string, WorkerHandle>()

type PendingCall = { resolve: (r: InvokeResult) => void; timer: ReturnType<typeof setTimeout>; start: number }
const _pending = new Map<string, PendingCall>()

// Lazy Redis client for extension storage
let _redis: { get(k: string): Promise<string | null>; set(k: string, v: string, opts?: { EX?: number }): Promise<unknown>; del(k: string): Promise<unknown> } | null = null

async function getRedis() {
    if (_redis) return _redis
    const { createClient } = await import('redis')
    const client = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' })
    client.on('error', (err: Error) => logger.warn({ err }, 'Extension storage Redis error'))
    await client.connect()
    _redis = client as unknown as typeof _redis
    return _redis!
}

// ── Host bridge — handles sdk_call messages from workers ──────────────────────

async function handleSdkCall(worker: Worker, pluginName: string, callId: string, method: string, args: Record<string, unknown>) {
    try {
        const result = await dispatchSdkCall(pluginName, method, args)
        worker.postMessage({ type: 'bridge_reply', callId, result })
    } catch (err) {
        worker.postMessage({ type: 'bridge_reply', callId, error: err instanceof Error ? err.message : String(err) })
    }
}

async function dispatchSdkCall(pluginName: string, method: string, args: Record<string, unknown>): Promise<unknown> {
    const workspaceId = args.workspaceId as string

    switch (method) {
        // ── storage ──────────────────────────────────────────────────────
        case 'storage.get': {
            const redis = await getRedis()
            const key = `ext:${pluginName}:${args.key as string}`
            const raw = await redis.get(key)
            if (raw === null) return null
            try { return JSON.parse(raw) } catch { return raw }
        }
        case 'storage.set': {
            const redis = await getRedis()
            const key = `ext:${pluginName}:${args.key as string}`
            const value = JSON.stringify(args.value)
            const ttl = (args.ttl as number | undefined) ?? STORAGE_TTL_DEFAULT
            await redis.set(key, value, { EX: ttl })
            return null
        }
        case 'storage.delete': {
            const redis = await getRedis()
            await redis.del(`ext:${pluginName}:${args.key as string}`)
            return null
        }

        // ── memory ───────────────────────────────────────────────────────
        case 'memory.read': {
            const results = await searchMemory({
                workspaceId,
                query: args.query as string,
                type: args.type as Parameters<typeof searchMemory>[0]['type'],
                limit: args.limit as number | undefined,
            })
            return results.map((r) => ({
                id: r.id,
                content: r.content,
                tags: (r.metadata as Record<string, unknown>)?.tags ?? [],
                metadata: r.metadata,
                similarity: r.similarity,
                createdAt: r.createdAt.getTime(),
                authorExtension: (r.metadata as Record<string, unknown>)?.authorExtension as string | undefined,
            }))
        }
        case 'memory.write': {
            const id = await storeMemory({
                workspaceId,
                type: 'session',
                content: args.content as string,
                metadata: {
                    ...(args.metadata as Record<string, unknown> ?? {}),
                    authorExtension: pluginName,
                    tags: args.tags,
                    ttl: args.ttl,
                },
            })
            return {
                id,
                content: args.content,
                tags: args.tags ?? [],
                metadata: args.metadata ?? {},
                authorExtension: pluginName,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                ttl: args.ttl,
            }
        }
        case 'memory.delete': {
            // Soft-delete: mark metadata.deleted — full delete not exposed to extensions
            // (prevents extensions from corrupting workspace memory)
            logger.warn({ pluginName, id: args.id }, 'Extension requested memory.delete — not implemented (soft-delete only)')
            return null
        }

        // ── connections ──────────────────────────────────────────────────
        case 'connections.isConnected': {
            const [conn] = await db
                .select({ id: installedConnections.id })
                .from(installedConnections)
                .innerJoin(connectionsRegistry, eq(installedConnections.registryId, connectionsRegistry.id))
                .where(and(
                    eq(installedConnections.workspaceId, workspaceId),
                    eq(connectionsRegistry.id, args.service as string),
                    eq(installedConnections.status, 'active'),
                ))
                .limit(1)
            return Boolean(conn)
        }
        case 'connections.getCredentials': {
            const [conn] = await db
                .select({ credentials: installedConnections.credentials, scopesGranted: installedConnections.scopesGranted })
                .from(installedConnections)
                .innerJoin(connectionsRegistry, eq(installedConnections.registryId, connectionsRegistry.id))
                .where(and(
                    eq(installedConnections.workspaceId, workspaceId),
                    eq(connectionsRegistry.id, args.service as string),
                    eq(installedConnections.status, 'active'),
                ))
                .limit(1)
            if (!conn) throw new Error(`Connection "${args.service}" not installed or not active in this workspace`)
            // credentials is encrypted at rest; returned as-is to the extension
            return { credentials: conn.credentials, scopesGranted: conn.scopesGranted }
        }

        // ── events ───────────────────────────────────────────────────────
        case 'events.publish': {
            eventBus.publish(args.topic as string, args.payload, pluginName)
            return null
        }

        // ── tasks ────────────────────────────────────────────────────────
        case 'tasks.create': {
            const opts = args.opts as Record<string, unknown>
            const { push: queuePush } = await import('@plexo/queue')
            const taskId = await queuePush({
                workspaceId,
                type: 'ops',
                source: 'api', // 'extension' pending enum migration
                priority: 1,
                context: { description: opts.description, source: pluginName, ...(opts.metadata ?? {}) },
                project: opts.project as string | undefined,
            })
            return { taskId }
        }
        case 'tasks.get': {
            const [task] = await db.select().from(tasks)
                .where(and(eq(tasks.id, args.id as string), eq(tasks.workspaceId, workspaceId)))
                .limit(1)
            return task ?? null
        }
        case 'tasks.list': {
            const filter = args.filter as Record<string, unknown> | undefined
            const rows = await db.select().from(tasks)
                .where(eq(tasks.workspaceId, workspaceId))
                .limit(filter?.limit as number | undefined ?? 20)
            return rows
        }

        // ── channel / ui ─────────────────────────────────────────────────
        case 'channel.send':
        case 'channel.sendDirect':
        case 'ui.notify':
            // Forward as event bus message — channel adapters subscribe
            eventBus.publish(`plexo.${method}`, args)
            return null

        default:
            throw new Error(`Unknown bridge method: ${method}`)
    }
}

// ── Message router ────────────────────────────────────────────────────────────

function makeWorkerMessageHandler(worker: Worker, pluginName: string) {
    return (msg: Record<string, unknown>) => {
        if (msg.type === 'sdk_call') {
            // Extension is requesting a host-side service
            void handleSdkCall(
                worker,
                pluginName,
                msg.callId as string,
                msg.method as string,
                msg.args as Record<string, unknown>,
            )
            return
        }

        // Normal result/error routing to pending call
        if (!msg.callId) return
        const pending = _pending.get(msg.callId as string)
        if (!pending) return

        clearTimeout(pending.timer)
        _pending.delete(msg.callId as string)

        if (msg.type === 'result') {
            pending.resolve({ ok: true, result: msg.result, durationMs: Date.now() - pending.start })
        } else {
            pending.resolve({ ok: false, error: String(msg.error ?? 'Unknown worker error'), durationMs: Date.now() - pending.start })
        }
    }
}

// ── Spawn + activate ─────────────────────────────────────────────────────────

export async function getWorker(input: ActivationInput): Promise<WorkerHandle> {
    const existing = _workers.get(input.pluginName)
    if (existing) return existing

    const workerPath = join(__dir, 'sandbox-worker.js')
    const worker = new Worker(workerPath)

    const messageHandler = makeWorkerMessageHandler(worker, input.pluginName)
    worker.on('message', messageHandler)

    worker.on('error', (err) => {
        logger.error({ ext: input.pluginName, err }, 'Persistent worker crashed')
        cleanupWorker(input.pluginName)
        for (const [callId, pending] of _pending) {
            if (callId.startsWith(input.pluginName + ':')) {
                clearTimeout(pending.timer)
                pending.resolve({ ok: false, error: `Worker crashed: ${err.message}`, durationMs: Date.now() - pending.start })
                _pending.delete(callId)
            }
        }
    })

    worker.on('exit', (code) => {
        if (code !== 0) logger.warn({ ext: input.pluginName, code }, 'Worker exited unexpectedly')
        cleanupWorker(input.pluginName)
    })

    const callId = `${input.pluginName}:__activate__`
    const activateTimeout = input.activateTimeoutMs ?? DEFAULT_ACTIVATE_TIMEOUT_MS

    const activationResult = await new Promise<{ ok: boolean; tools: RegisteredTool[]; error?: string }>((resolve) => {
        const timer = setTimeout(() => {
            void worker.terminate()
            resolve({ ok: false, tools: [], error: `Activation timed out after ${activateTimeout}ms` })
        }, activateTimeout)

        const onMsg = (msg: Record<string, unknown>) => {
            if (msg.callId !== callId) return
            clearTimeout(timer)
            worker.off('message', onMsg)
            if (msg.type === 'activated') {
                resolve({ ok: true, tools: (msg.tools as RegisteredTool[]) ?? [] })
            } else {
                resolve({ ok: false, tools: [], error: String(msg.error ?? 'Activation failed') })
            }
        }
        worker.on('message', onMsg)

        worker.postMessage({
            type: 'activate',
            callId,
            input: {
                pluginName: input.pluginName,
                entry: input.entry,
                permissions: input.permissions,
                settings: input.settings,
                workspaceId: input.workspaceId,
                toolName: '__activate__',
                args: {},
            },
        })
    })

    if (!activationResult.ok) {
        void worker.terminate()
        throw new Error(activationResult.error ?? 'Activation failed')
    }

    const handle: WorkerHandle = {
        worker,
        pluginName: input.pluginName,
        workspaceId: input.workspaceId,
        activatedAt: Date.now(),
        registeredTools: activationResult.tools,
    }
    _workers.set(input.pluginName, handle)
    logger.info({ ext: input.pluginName, toolCount: activationResult.tools.length }, 'Persistent worker activated')
    return handle
}

// ── Invoke a tool ─────────────────────────────────────────────────────────────

export async function invokeTool(
    handle: WorkerHandle,
    toolName: string,
    args: Record<string, unknown>,
    workspaceId: string,
    timeoutMs: number = DEFAULT_INVOKE_TIMEOUT_MS,
): Promise<InvokeResult> {
    const callId = `${handle.pluginName}:${randomUUID()}`
    const start = Date.now()

    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            _pending.delete(callId)
            logger.warn({ ext: handle.pluginName, tool: toolName, timeoutMs }, 'Tool invocation timed out — terminating worker')
            void handle.worker.terminate()
            cleanupWorker(handle.pluginName)
            resolve({ ok: false, error: `Tool timed out after ${timeoutMs}ms`, timedOut: true, durationMs: Date.now() - start })
        }, timeoutMs)

        _pending.set(callId, { resolve, timer, start })
        handle.worker.postMessage({ type: 'invoke', callId, toolName, args, workspaceId })
    })
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

function cleanupWorker(pluginName: string) {
    _workers.delete(pluginName)
}

export function terminateWorker(pluginName: string): void {
    const handle = _workers.get(pluginName)
    if (handle) {
        handle.worker.postMessage({ type: 'terminate' })
        _workers.delete(pluginName)
        logger.info({ ext: pluginName }, 'Persistent worker terminated')
    }
}

export function terminateAll(): void {
    for (const [name, handle] of _workers) {
        handle.worker.postMessage({ type: 'terminate' })
        logger.info({ ext: name }, 'Persistent worker terminated (shutdown)')
    }
    _workers.clear()
}

export function workerStats(): Array<{ pluginName: string; activatedAt: number; toolCount: number }> {
    return Array.from(_workers.values()).map((h) => ({
        pluginName: h.pluginName,
        activatedAt: h.activatedAt,
        toolCount: h.registeredTools.length,
    }))
}
