// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * PEX Persistent Worker Pool (§5.4) — v2 with host bridge
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
import { existsSync } from 'fs'
import { randomUUID } from 'node:crypto'
import pino from 'pino'
import { storeMemory, searchMemory } from '../memory/store.js'
import { db, eq, and, sql, isNull } from '@plexo/db'
import { installedConnections, connectionsRegistry, tasks, extensionContexts, extensionPrompts } from '@plexo/db'
import { eventBus } from './event-bus.js'

const logger = pino({ name: 'pex-persistent-pool' })

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
    client.on('error', (err: Error) => logger.warn({ err }, 'Tool storage Redis error'))
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
                shorthand: r.shorthand,
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
            logger.warn({ pluginName, id: args.id }, 'Tool requested memory.delete — not implemented (soft-delete only)')
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
            if (!conn) throw new Error(`Integration "${args.service}" not installed or not active in this workspace`)
            // Decrypt credentials before returning to the extension
            let credentials = conn.credentials
            if (typeof credentials === 'object' && credentials !== null && 'encrypted' in credentials) {
                const { decrypt } = await import('../connections/crypto-util.js')
                credentials = JSON.parse(decrypt((credentials as { encrypted: string }).encrypted, workspaceId))
            }
            return { credentials, scopesGranted: conn.scopesGranted }
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
                source: 'extension',
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

        // v0.3.0 — Entity resolution (§16)
        case 'entities.resolve':
        case 'entities.search':
        case 'entities.create':
        case 'entities.link':
            throw new Error('NOT_IMPLEMENTED: Entity resolution is not yet available on this host')

        // v0.3.0 — UserSelf (§20)
        case 'self.read':
        case 'self.propose':
            throw new Error('NOT_IMPLEMENTED: UserSelf is not yet available on this host')

        // v0.3.0 — Audit trail (§18)
        case 'audit.query':
            throw new Error('NOT_IMPLEMENTED: Audit trail query is not yet available on this host')

        // v0.3.0 — Escalation (§23)
        case 'escalate':
            throw new Error('NOT_IMPLEMENTED: Escalation contract is not yet available on this host')

        // ── context layer (§7.7) ────────────────────────────────────────

        case 'context.register': {
            const extName = (args.extensionName as string) ?? pluginName
            const contextId = args.contextId as string
            const content = args.content as string
            if (!content || content.length > 50_000) throw new Error('Content required and must be <= 50,000 chars')

            // Enforce 10-context cap per extension
            const [countRow] = await db.select({ count: sql<number>`count(*)` }).from(extensionContexts)
                .where(and(eq(extensionContexts.workspaceId, workspaceId), eq(extensionContexts.extensionName, extName), isNull(extensionContexts.deletedAt)))
            if (Number(countRow?.count ?? 0) >= 10) throw new Error('CONTEXT_LIMIT: maximum 10 contexts per tool')

            await db.insert(extensionContexts).values({
                workspaceId,
                extensionName: extName,
                contextId,
                name: (args.name as string) ?? contextId,
                description: (args.description as string) ?? '',
                content,
                contentType: (args.contentType as string) ?? 'text/plain',
                priority: (['low', 'normal', 'high', 'critical'].includes(args.priority as string) ? args.priority : 'normal') as any,
                ttl: typeof args.ttl === 'number' ? args.ttl : null,
                tags: Array.isArray(args.tags) ? (args.tags as string[]).slice(0, 10) : [],
                estimatedTokens: typeof args.estimatedTokens === 'number' ? args.estimatedTokens : Math.ceil(content.length / 4),
                enabled: false, // Disabled by default — user opts in
            }).onConflictDoUpdate({
                target: [extensionContexts.workspaceId, extensionContexts.extensionName, extensionContexts.contextId],
                set: { content, lastRefreshedAt: new Date(), updatedAt: new Date() },
            })
            return { ok: true }
        }

        case 'context.update': {
            const extName = (args.extensionName as string) ?? pluginName
            const contextId = args.contextId as string
            const content = args.content as string
            if (!content || content.length > 50_000) throw new Error('Content required and must be <= 50,000 chars')

            await db.update(extensionContexts).set({
                content,
                lastRefreshedAt: new Date(),
                updatedAt: new Date(),
                ...(typeof args.ttl === 'number' ? { ttl: args.ttl } : {}),
                ...(typeof args.estimatedTokens === 'number' ? { estimatedTokens: args.estimatedTokens } : {}),
            }).where(and(
                eq(extensionContexts.workspaceId, workspaceId),
                eq(extensionContexts.extensionName, extName),
                eq(extensionContexts.contextId, contextId),
                isNull(extensionContexts.deletedAt),
            ))
            return { ok: true }
        }

        case 'context.list': {
            const extName = args.extensionName as string | undefined
            const conditions = [eq(extensionContexts.workspaceId, workspaceId), isNull(extensionContexts.deletedAt)]
            if (extName) conditions.push(eq(extensionContexts.extensionName, extName))

            const rows = await db.select().from(extensionContexts).where(and(...conditions))
            return rows.map(r => ({
                id: r.contextId,
                name: r.name,
                description: r.description,
                priority: r.priority,
                ownerExtension: r.extensionName,
                enabled: r.enabled,
                estimatedTokens: r.estimatedTokens ?? Math.ceil(r.content.length / 4),
                expired: r.ttl != null && r.lastRefreshedAt != null
                    ? (Date.now() - new Date(r.lastRefreshedAt).getTime()) / 1000 > r.ttl
                    : false,
            }))
        }

        // ── prompts layer (§7.6) ────────────────────────────────────────

        case 'prompts.register': {
            const extName = (args.extensionName as string) ?? pluginName
            const promptId = args.promptId as string
            const template = args.template as string
            if (!template || template.length > 50_000) throw new Error('Template required and must be <= 50,000 chars')

            // Enforce 10-prompt cap per extension
            const [promptCount] = await db.select({ count: sql<number>`count(*)` }).from(extensionPrompts)
                .where(and(eq(extensionPrompts.workspaceId, workspaceId), eq(extensionPrompts.extensionName, extName), isNull(extensionPrompts.deletedAt)))
            if (Number(promptCount?.count ?? 0) >= 10) throw new Error('PROMPT_LIMIT: maximum 10 prompts per tool')

            await db.insert(extensionPrompts).values({
                workspaceId,
                extensionName: extName,
                promptId,
                name: (args.name as string) ?? promptId,
                description: (args.description as string) ?? '',
                template,
                variables: (args.variables ?? []) as any,
                tags: Array.isArray(args.tags) ? (args.tags as string[]).slice(0, 10) : [],
                version: (args.version as string) ?? '1.0.0',
                priority: (['low', 'normal', 'high', 'critical'].includes(args.priority as string) ? args.priority : 'normal') as any,
                dependencies: Array.isArray(args.dependencies) ? args.dependencies as string[] : [],
                enabled: false, // Disabled by default — user opts in
            }).onConflictDoUpdate({
                target: [extensionPrompts.workspaceId, extensionPrompts.extensionName, extensionPrompts.promptId],
                set: { template, version: (args.version as string) ?? '1.0.0', updatedAt: new Date() },
            })
            return { ok: true }
        }

        case 'prompts.list': {
            const extName = args.extensionName as string | undefined
            const conditions = [eq(extensionPrompts.workspaceId, workspaceId), isNull(extensionPrompts.deletedAt)]
            if (extName) conditions.push(eq(extensionPrompts.extensionName, extName))

            const rows = await db.select().from(extensionPrompts).where(and(...conditions))
            return rows.map(r => ({
                id: r.promptId,
                name: r.name,
                description: r.description,
                tags: r.tags,
                version: r.version,
                priority: r.priority,
                ownerExtension: r.extensionName,
                enabled: r.enabled,
            }))
        }

        case 'prompts.resolve': {
            const promptId = args.promptId as string
            const variables = (args.variables ?? {}) as Record<string, unknown>

            const [row] = await db.select().from(extensionPrompts).where(and(
                eq(extensionPrompts.workspaceId, workspaceId),
                eq(extensionPrompts.promptId, promptId),
                isNull(extensionPrompts.deletedAt),
            )).limit(1)

            if (!row) throw new Error(`Prompt "${promptId}" not found`)

            // Merge: explicit variables > user defaults > schema defaults
            const userDefaults = (row.variableDefaults ?? {}) as Record<string, unknown>
            const schemaVars = (row.variables ?? []) as Array<{ name: string; default?: unknown; required?: boolean }>
            const merged: Record<string, unknown> = {}
            const unresolved: string[] = []

            for (const v of schemaVars) {
                if (variables[v.name] !== undefined) {
                    merged[v.name] = variables[v.name]
                } else if (userDefaults[v.name] !== undefined) {
                    merged[v.name] = userDefaults[v.name]
                } else if (v.default !== undefined) {
                    merged[v.name] = v.default
                } else if (v.required !== false) {
                    unresolved.push(v.name)
                }
            }

            // Interpolate {{variable}} placeholders
            let resolved = row.template
            for (const [key, val] of Object.entries(merged)) {
                resolved = resolved.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(val))
            }

            return { resolved, unresolved, promptId: row.promptId, extensionName: row.extensionName }
        }

        // v0.3.0 — A2A bridge (§22)
        case 'a2a.discover': {
            const endpoint = args.endpoint as string
            if (!endpoint) throw new Error('endpoint required')
            const res = await fetch(`${endpoint.replace(/\/$/, '')}/.well-known/agent.json`)
            if (!res.ok) throw new Error(`Failed to fetch agent card from ${endpoint}: ${res.status}`)
            return res.json()
        }
        case 'a2a.delegate': {
            const { push: queuePush } = await import('@plexo/queue')
            const delegation = (args.delegation ?? {}) as Record<string, unknown>
            const instructions = delegation.instructions as string | undefined
            const parentTaskId = delegation.parentTaskId as string | undefined
            const agentId = delegation.agentId as string | undefined
            if (!instructions?.trim()) throw new Error('delegation.instructions required')

            const childTaskId = await queuePush({
                workspaceId,
                type: 'ops',
                source: 'extension',
                ...(parentTaskId ? { parentId: parentTaskId } : {}),
                context: {
                    description: instructions,
                    delegatedBy: pluginName,
                    a2a: true,
                    ...(agentId ? { agentId } : {}),
                },
            })

            // Poll for completion (max 5 minutes)
            const POLL_INTERVAL_MS = 3_000
            const TIMEOUT_MS = 300_000
            const pollStart = Date.now()
            while (Date.now() - pollStart < TIMEOUT_MS) {
                await new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS))
                const [row] = await db.select({
                    status: tasks.status,
                    outcomeSummary: tasks.outcomeSummary,
                    deliverable: tasks.deliverable,
                }).from(tasks).where(eq(tasks.id, childTaskId)).limit(1)

                if (!row) throw new Error('Child task row not found')
                if (row.status === 'complete' || (row.status as string) === 'completed') {
                    return { taskId: childTaskId, status: 'completed', result: row.outcomeSummary, deliverable: row.deliverable }
                }
                if (row.status === 'blocked' || row.status === 'failed' || (row.status as string) === 'cancelled') {
                    throw new Error(`Child task ${row.status}: ${row.outcomeSummary ?? 'no details'}`)
                }
            }
            throw new Error('A2A delegate: child task timed out after 5 minutes')
        }

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

    // tsx runtime keeps .ts files; compiled builds use .js
    const jsPath = join(__dir, 'sandbox-worker.js')
    const tsPath = join(__dir, 'sandbox-worker.ts')
    const workerPath = existsSync(jsPath) ? jsPath : tsPath
    // When running .ts files, register tsx so the worker can resolve TS imports
    const workerOpts: import('worker_threads').WorkerOptions = {
        env: {
            NODE_ENV: process.env.NODE_ENV ?? 'production',
        },
    }
    if (workerPath.endsWith('.ts')) {
        // tsx may not be resolvable from worker CWD; find it relative to the api package
        const tsxPaths = [
            join(__dir, '../../../../apps/api/node_modules/tsx/dist/esm/index.mjs'),
            join(__dir, '../../../../node_modules/tsx/dist/esm/index.mjs'),
        ]
        const tsxPath = tsxPaths.find(p => existsSync(p))
        if (tsxPath) {
            workerOpts.execArgv = ['--import', tsxPath]
        } else {
            workerOpts.execArgv = ['--import', 'tsx']
        }
    }
    const worker = new Worker(workerPath, workerOpts)

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
