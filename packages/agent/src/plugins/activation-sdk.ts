// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Fabric Activation SDK — v3 (Fabric v0.3.0)
 *
 * A host-side implementation of PlexoSDK passed to extension activate() calls.
 * For capabilities that require host-side services (storage, memory, connections),
 * the SDK delegates to a `HostBridge` — a function that sends a message to the
 * host and awaits its response.
 *
 * When running in a persistent worker (§5.4):
 *   bridge = (method, args) => postMessage + await reply
 *
 * When running in the host process directly:
 *   bridge = (method, args) => call service functions directly
 *
 * Capability enforcement: every sdk.* call checks the declared capabilities[]
 * from the manifest before proceeding (§4).
 */
import type { PlexoSDK, ToolRegistration, ScheduleRegistration, WidgetRegistration } from '@plexo/sdk'

export interface ActivationResult {
    tools: ToolRegistration[]
    schedules: ScheduleRegistration[]
    widgets: WidgetRegistration[]
}

/**
 * Bridge function — the SDK calls this to invoke host-side services.
 * In worker context: implemented via postMessage + reply listener.
 * In direct context: implemented via direct function call.
 */
export type HostBridge = (method: string, args: Record<string, unknown>) => Promise<unknown>

/** No-op bridge — used when capabilities aren't wired (testing, etc.) */
export const nullBridge: HostBridge = async (method) => {
    throw new Error(`Host bridge not configured — ${method} unavailable in this context`)
}

/**
 * Create a host-side SDK instance for use during extension activation.
 * Pass a `bridge` to enable storage/memory/connections capabilities.
 */
export function createActivationSDK(
    extensionName: string,
    capabilities: string[],
    settings: Record<string, unknown>,
    workspaceId: string,
    bridge: HostBridge = nullBridge,
): { sdk: PlexoSDK; getResult: () => ActivationResult } {
    const capSet = new Set(capabilities)
    const registered: ActivationResult = { tools: [], schedules: [], widgets: [] }

    function requireCap(token: string): void {
        if (!capSet.has(token)) {
            throw new Error(`CAPABILITY_DENIED: extension "${extensionName}" requires "${token}" capability`)
        }
    }

    /** Check if extension has memory capability — accepts both legacy unscoped and entity-scoped tokens */
    function hasMemoryCap(action: 'read' | 'write' | 'delete'): void {
        const unscoped = `memory:${action}`
        if (capSet.has(unscoped)) return
        // Accept any entity-scoped variant: memory:read:person, memory:write:task, etc.
        const entityScoped = [...capSet].some(c => c.startsWith(`memory:${action}:`))
        if (entityScoped) return
        throw new Error(`CAPABILITY_DENIED: extension "${extensionName}" requires a "memory:${action}" capability (unscoped or entity-scoped)`)
    }

    const sdk: PlexoSDK = {
        host: {
            fabricVersion: '0.3.0',
            complianceLevel: 'full',
            name: 'plexo',
            version: process.env.npm_package_version ?? '0.0.0',
        },

        registerTool(tool: ToolRegistration): void {
            registered.tools.push(tool)
        },

        registerSchedule(job: ScheduleRegistration): void {
            requireCap('schedule:register')
            registered.schedules.push(job)
        },

        registerWidget(widget: WidgetRegistration): void {
            requireCap('ui:register-widget')
            registered.widgets.push(widget)
        },

        registerPrompt(): void {
            requireCap('prompts:register')
            // TODO: prompt registration storage
        },

        registerContext(): void {
            requireCap('context:register')
            // TODO: context registration storage
        },

        prompts: {
            async list() {
                requireCap('prompts:read')
                return []
            },
            async resolve(_promptId, _variables) {
                requireCap('prompts:read')
                return ''
            },
        },

        context: {
            async update(_contextId, _content, _opts) {
                requireCap('context:write')
            },
            async list() {
                requireCap('context:read')
                return []
            },
        },

        memory: {
            async read(query, opts) {
                hasMemoryCap('read')
                return bridge('memory.read', {
                    workspaceId,
                    query,
                    tags: opts?.tags,
                    limit: opts?.limit,
                }) as Promise<Awaited<ReturnType<PlexoSDK['memory']['read']>>>
            },
            async write(entry) {
                hasMemoryCap('write')
                return bridge('memory.write', {
                    workspaceId,
                    content: entry.content,
                    tags: entry.tags,
                    metadata: { ...entry.metadata, authorExtension: extensionName },
                    ttl: entry.ttl,
                }) as Promise<Awaited<ReturnType<PlexoSDK['memory']['write']>>>
            },
            async delete(id) {
                hasMemoryCap('delete')
                await bridge('memory.delete', { workspaceId, id })
            },
        },

        connections: {
            async getCredentials(service: string) {
                requireCap(`connections:${service}`)
                return bridge('connections.getCredentials', { workspaceId, service }) as
                    Promise<Awaited<ReturnType<PlexoSDK['connections']['getCredentials']>>>
            },
            async isConnected(service: string) {
                requireCap(`connections:${service}`)
                const result = await bridge('connections.isConnected', { workspaceId, service })
                return Boolean(result)
            },
        },

        channel: {
            async send(_msg) {
                requireCap('channel:send')
                await bridge('channel.send', { workspaceId, msg: _msg })
            },
            async sendDirect(_channelId, _msg) {
                requireCap('channel:send-direct')
                await bridge('channel.sendDirect', { workspaceId, channelId: _channelId, msg: _msg })
            },
        },

        tasks: {
            async create(opts) {
                requireCap('tasks:create')
                return bridge('tasks.create', { workspaceId, opts }) as
                    Promise<Awaited<ReturnType<PlexoSDK['tasks']['create']>>>
            },
            async get(id) {
                requireCap('tasks:read')
                return bridge('tasks.get', { workspaceId, id }) as
                    Promise<Awaited<ReturnType<PlexoSDK['tasks']['get']>>>
            },
            async list(filter) {
                requireCap('tasks:read')
                return bridge('tasks.list', { workspaceId, filter }) as
                    Promise<Awaited<ReturnType<PlexoSDK['tasks']['list']>>>
            },
        },

        events: {
            subscribe(_topic, _handler) {
                requireCap('events:subscribe')
                // Subscription in persistent worker is handled via event-bus directly by the host
                // Extensions that need event subscriptions declare them in their manifest
            },
            async publish(topic, payload) {
                requireCap('events:publish')
                const scope = extensionName.replace(/^@/, '').replace('/', '_')
                if (!topic.startsWith(`ext.${scope}.`)) {
                    throw new Error(`CAPABILITY_DENIED: extension may only publish to ext.${scope}.* namespace`)
                }
                await bridge('events.publish', { topic, payload, extensionName })
            },
        },

        storage: {
            async get(key) {
                requireCap('storage:read')
                if (Object.prototype.hasOwnProperty.call(settings, key)) {
                    return settings[key] as string | null
                }
                const result = await bridge('storage.get', { extensionName, key }) as string | null
                return result
            },
            async set(key, value, opts) {
                requireCap('storage:write')
                await bridge('storage.set', { extensionName, key, value, ttl: opts?.ttlSeconds })
            },
            async delete(key) {
                requireCap('storage:write')
                await bridge('storage.delete', { extensionName, key })
            },
        },

        ui: {
            async notify(msg, level) {
                requireCap('ui:notify')
                await bridge('ui.notify', { workspaceId, msg, level })
            },
        },

        // §16 — Personal Entity Resolution
        entities: {
            async resolve(type, id) {
                hasMemoryCap('read')
                return bridge('entities.resolve', { workspaceId, type, id }) as Promise<any>
            },
            async search(type, query) {
                hasMemoryCap('read')
                return bridge('entities.search', { workspaceId, type, query }) as Promise<any>
            },
            async create(type, data) {
                requireCap(`entity:create:${type}`)
                return bridge('entities.create', { workspaceId, type, data }) as Promise<any>
            },
            async link(source, target) {
                requireCap(`entity:modify:${source.type}`)
                await bridge('entities.link', { workspaceId, source, target })
            },
        },

        // §20 — Persistent UserSelf
        self: {
            async read(fields) {
                requireCap('self:read')
                return bridge('self.read', { fields }) as Promise<any>
            },
            async propose(proposal) {
                requireCap('self:write')
                await bridge('self.propose', { proposal })
            },
        },

        // §18 — Audit Trail (owner tier only)
        audit: {
            async query(query) {
                requireCap('audit:read')
                return bridge('audit.query', { workspaceId, query }) as Promise<any>
            },
        },

        // §23 — Escalation Contract
        async escalate(request) {
            return bridge('escalate', { workspaceId, extensionName, request }) as Promise<any>
        },

        // §22 — A2A Bridge Layer
        a2a: {
            async discover(endpoint) {
                requireCap('a2a:delegate')
                return bridge('a2a.discover', { endpoint }) as Promise<any>
            },
            async delegate(delegation) {
                requireCap('a2a:delegate')
                return bridge('a2a.delegate', { workspaceId, extensionName, delegation }) as Promise<any>
            },
        },
    }

    return { sdk, getResult: () => ({ ...registered }) }
}
